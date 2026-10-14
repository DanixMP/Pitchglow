import { describe, expect, it } from 'vitest';
import { blockRuns, loopFade, songSample, type EngineTransport } from '../src/audio/engine/transport';
import { PitchTracker, type PitchFrame } from '../src/audio/pitch-tracker';
import type { TuneSettings } from '../src/dsp/autotune';
import { renderWithHarmony } from '../src/dsp/harmony';
import { analyzePsola, planGrains, renderGrains } from '../src/dsp/psola';
import { ENGINE_BLOCK, leadCorrections, planVoices, VoiceRenderer } from '../src/dsp/voice-engine';
import { sawtooth } from './signals';

const SR = 44100;

function track(signal: Float32Array): PitchFrame[] {
  const frames: PitchFrame[] = [];
  const tracker = new PitchTracker(SR, (f) => frames.push(f));
  for (let i = 0; i < signal.length; i += 512) tracker.push(signal.subarray(i, i + 512));
  return frames;
}

/** Two sung notes with a gap (voiced, unvoiced, voiced). */
function phrase(amp = 0.3): Float32Array {
  const a = sawtooth(203, SR, 0.6, amp);
  const b = sawtooth(151, SR, 0.5, amp);
  const x = new Float32Array(a.length + 4410 + b.length);
  x.set(a);
  x.set(b, a.length + 4410);
  return x;
}

/** Renders a whole take through VoiceRenderer in blocks of `size` (≤ ENGINE_BLOCK). */
function renderInBlocks(r: VoiceRenderer, n: number, size: number): Float32Array {
  const out = new Float32Array(n);
  for (let s = 0; s < n; s += size) r.render(s, Math.min(size, n - s), out, s);
  return out;
}

const C_MAJOR: TuneSettings = { scale: { root: 0, type: 'major' }, retuneMs: 30 };

describe('block rendering', () => {
  it('rendering in blocks equals rendering the whole take, bit for bit', () => {
    const x = phrase();
    const frames = track(x);
    const plan = planGrains(analyzePsola(x, SR, frames), leadCorrections(frames, C_MAJOR, 0));
    const whole = new Float32Array(x.length);
    renderGrains(x, plan, 0, x.length, whole, new Float32Array(x.length));
    for (const size of [128, 97, 1]) {
      const out = new Float32Array(x.length);
      const scratch = new Float32Array(size);
      const block = new Float32Array(size);
      for (let s = 0; s < x.length; s += size) {
        const e = Math.min(x.length, s + size);
        renderGrains(x, plan, s, e, block, scratch);
        out.set(block.subarray(0, e - s), s);
      }
      expect(out).toEqual(whole);
    }
  });

  it('the engine (lead + harmonies) matches the offline harmonizer', () => {
    const x = phrase(0.25); // quiet enough that the offline limiter stays out of it
    const frames = track(x);
    const tune: TuneSettings = { ...C_MAJOR, harmony: { voices: ['thirdUp', 'fifthDown'], mix: 0.6 } };
    const offline = renderWithHarmony(x, SR, frames, tune, 2);
    const r = new VoiceRenderer();
    r.setSource(x);
    r.setPlans(planVoices(analyzePsola(x, SR, frames), frames, tune, 2));
    const live = renderInBlocks(r, x.length, ENGINE_BLOCK);
    let peak = 0;
    let diff = 0;
    for (let i = 0; i < x.length; i++) {
      peak = Math.max(peak, Math.abs(offline[i]));
      diff = Math.max(diff, Math.abs(offline[i] - live[i]));
    }
    expect(peak).toBeLessThan(0.98);
    expect(diff).toBeLessThan(1e-6);
  });

  it('plays the source untouched without plans, and silence outside the take', () => {
    const x = phrase();
    const r = new VoiceRenderer();
    r.setSource(x);
    r.setPlans(null);
    expect(renderInBlocks(r, x.length, 128)).toEqual(x);
    const out = new Float32Array(128).fill(9);
    r.render(-64, 128, out, 0); // half before the take
    expect([...out.subarray(0, 64)].every((v) => v === 0)).toBe(true);
    expect(out.subarray(64)).toEqual(x.subarray(0, 64));
    r.render(x.length - 10, 128, out, 0); // runs off the end
    expect(out.subarray(0, 10)).toEqual(x.subarray(x.length - 10));
    expect([...out.subarray(10)].every((v) => v === 0)).toBe(true);
  });

  it('ignores plans made for a different take length', () => {
    const x = phrase();
    const frames = track(x);
    const r = new VoiceRenderer();
    r.setSource(x.subarray(0, 1000));
    r.setPlans(planVoices(analyzePsola(x, SR, frames), frames, C_MAJOR, 0));
    expect(renderInBlocks(r, 1000, 128)).toEqual(x.subarray(0, 1000));
  });

  it('nothing to do -> no plans', () => {
    const x = phrase();
    const frames = track(x);
    expect(planVoices(analyzePsola(x, SR, frames), frames, null, 0)).toBeNull();
    expect(planVoices(analyzePsola(x, SR, frames), frames, null, 3)).not.toBeNull();
  });

  it('re-planning is fast enough for knob drags (a minute of singing)', () => {
    // Tile one tracked phrase (and its frames) to a minute.
    const unit = phrase();
    const unitFrames = track(unit);
    const reps = Math.floor((SR * 60) / unit.length);
    const x = new Float32Array(unit.length * reps);
    const frames: PitchFrame[] = [];
    for (let r = 0; r < reps; r++) {
      x.set(unit, r * unit.length);
      for (const f of unitFrames) frames.push({ ...f, time: f.time + (r * unit.length) / SR });
    }
    const analysis = analyzePsola(x, SR, frames);
    const tune: TuneSettings = { ...C_MAJOR, harmony: { voices: ['thirdUp', 'fifthUp'], mix: 0.6 } };
    const t0 = performance.now();
    const plans = planVoices(analysis, frames, tune, 0)!;
    const ms = performance.now() - t0;
    expect(plans.lead.count).toBeGreaterThan(10000);
    expect(ms).toBeLessThan(150); // ~50 ms measured (cold); runs in the worker anyway
  });
});

describe('engine transport', () => {
  const t = (over: Partial<EngineTransport> = {}): EngineTransport => ({ startFrame: 1000, from: 0, loop: null, ...over });

  it('maps context frames to song positions', () => {
    expect(songSample(999, t())).toBe(-1);
    expect(songSample(1000, t({ from: 50 }))).toBe(50);
    expect(songSample(1500, t({ from: 50 }))).toBe(550);
    const loop = { start: 100, end: 300 };
    expect(songSample(1000 + 299, t({ loop }))).toBe(299);
    expect(songSample(1000 + 300, t({ loop }))).toBe(100);
    expect(songSample(1000 + 300 + 450, t({ loop }))).toBe(150); // two passes later
    expect(songSample(1000 + 10, t({ from: 400, loop }))).toBe(410); // started after the loop: straight on
  });

  it('splits blocks at the start and at loop wraps', () => {
    const runs = new Float64Array(16);
    // Starts 28 frames into the block.
    let n = blockRuns(972, 128, t(), runs);
    expect(n).toBe(1);
    expect([...runs.subarray(0, 4)]).toEqual([28, 0, 100, 0]);
    // A wrap in the middle of the block.
    n = blockRuns(1000 + 250, 128, t({ loop: { start: 100, end: 300 } }), runs);
    expect(n).toBe(2);
    expect([...runs.subarray(0, 8)]).toEqual([0, 250, 50, 0, 50, 100, 78, 1]);
  });

  it('fades only where a loop cuts a clip', () => {
    const loop = { start: 1000, end: 2000 };
    expect(loopFade(1500, true, loop, 0, 5000, 100)).toBe(1);
    expect(loopFade(1950, false, loop, 0, 5000, 100)).toBeCloseTo(0.5);
    expect(loopFade(1950, false, loop, 0, 1990, 100)).toBe(1); // the clip ends inside the loop: no cut
    expect(loopFade(1025, true, loop, 0, 5000, 100)).toBeCloseTo(0.25);
    expect(loopFade(1025, false, loop, 0, 5000, 100)).toBe(1); // first pass: no fade-in
    expect(loopFade(1025, true, loop, 1010, 5000, 100)).toBe(1); // clip starts inside the loop
  });
});
