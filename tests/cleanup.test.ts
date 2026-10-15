import { describe, expect, it } from 'vitest';
import { PitchTracker, type PitchFrame } from '../src/audio/pitch-tracker';
import { analyzeCleanup, cleanupTake, CleanupStream, type CleanupSettings } from '../src/dsp/cleanup';
import { prepareVoice, processRecording } from '../src/dsp/process';
import { ENGINE_BLOCK, planVoices, VoiceRenderer } from '../src/dsp/voice-engine';
import { noise, sawtooth } from './signals';

const SR = 48000;

function track(signal: Float32Array): PitchFrame[] {
  const frames: PitchFrame[] = [];
  const tracker = new PitchTracker(SR, (f) => frames.push(f));
  for (let i = 0; i < signal.length; i += 512) tracker.push(signal.subarray(i, i + 512));
  return frames;
}

/** Hissy take: voice, a pause, voice again, with noise throughout and an "s" burst. */
function take(): Float32Array {
  const x = noise(SR, 2.4, 0.02);
  const a = sawtooth(180, SR, 0.8, 0.3);
  const b = sawtooth(220, SR, 0.7, 0.3);
  for (let i = 0; i < a.length; i++) x[i + SR * 0.1] += a[i];
  for (let i = 0; i < b.length; i++) x[i + SR * 1.4] += b[i];
  const s = noise(SR, 0.12, 0.25);
  for (let i = 0; i < s.length; i++) x[i + SR * 1.2] += s[i] * Math.sin((Math.PI * i) / s.length) * (i % 2 ? 1 : -1);
  return x;
}

const ALL: CleanupSettings = { denoiseDb: 15, gate: 0.6, deess: 0.7 };

describe('clean-up stream', () => {
  const x = take();
  const frames = track(x);
  const analysis = analyzeCleanup(x, SR, frames);

  it('learns a noise profile and a gate map', () => {
    expect(analysis.noise).not.toBeNull();
    expect(analysis.gateOpen.length).toBe(frames.length);
    expect([...analysis.gateOpen].some((v) => v === 0)).toBe(true);
  });

  it('gives the same samples whatever the chunking', () => {
    const whole = cleanupTake(x, SR, analysis, ALL);
    const s = new CleanupStream(SR, analysis);
    s.setSettings(ALL);
    s.startAt(0);
    const chunked = new Float32Array(x.length);
    for (let upTo = 97; upTo < x.length + 97; upTo += 97) s.fill(x, chunked, Math.min(x.length, upTo));
    expect(chunked).toEqual(whole);
  });

  it('a restart (seek) settles onto the continuous output after its warm-up', () => {
    const whole = cleanupTake(x, SR, analysis, ALL);
    const pos = Math.round(SR * 1.5);
    const s = new CleanupStream(SR, analysis);
    s.setSettings(ALL);
    s.startAt(pos);
    const out = new Float32Array(x.length);
    s.fill(x, out, pos + SR / 2);
    let peak = 0;
    let diff = 0;
    for (let i = pos; i < pos + SR / 2; i++) {
      peak = Math.max(peak, Math.abs(whole[i]));
      diff = Math.max(diff, Math.abs(out[i] - whole[i]));
    }
    expect(diff / peak).toBeLessThan(0.02);
  });

  it('turns the noise down, and the pause further with the gate', () => {
    const rms = (y: Float32Array, a: number, b: number) => {
      let e = 0;
      for (let i = Math.round(a * SR); i < Math.round(b * SR); i++) e += y[i] * y[i];
      return Math.sqrt(e / ((b - a) * SR));
    };
    const den = cleanupTake(x, SR, analysis, { denoiseDb: 15, gate: 0, deess: 0 });
    const all = cleanupTake(x, SR, analysis, ALL);
    const pause = [0.98, 1.15] as const; // between the notes, before the "s"
    expect(rms(den, ...pause) / rms(x, ...pause)).toBeLessThan(0.35);
    expect(rms(all, ...pause)).toBeLessThan(rms(den, ...pause) * 0.5);
    // The voice keeps its level.
    expect(rms(all, 0.3, 0.8) / rms(x, 0.3, 0.8)).toBeGreaterThan(0.85);
  });
});

describe('voice engine with live clean-up', () => {
  const x = take();
  const frames = track(x);
  const tune = { scale: { root: 0, type: 'major' as const }, retuneMs: 20 };

  it('playing from the start equals the offline reference, bit for bit', () => {
    const ref = processRecording(x, SR, frames, { denoise: { amountDb: 15 }, tune, gate: 0.6, deess: 0.7 }).output;
    const prep = prepareVoice(x, SR, SR, frames);
    const r = new VoiceRenderer(SR);
    r.setSource(prep.source);
    r.setCleanup(prep.cleanup, ALL);
    r.setPlans(planVoices(prep.analysis, frames, tune, 0));
    const out = new Float32Array(x.length);
    for (let s = 0; s < x.length; s += ENGINE_BLOCK) r.render(s, Math.min(ENGINE_BLOCK, x.length - s), out, s);
    expect(out).toEqual(ref);
  });

  it('changing the amounts mid-play applies without restarting the stream', () => {
    const prep = prepareVoice(x, SR, SR, frames);
    const r = new VoiceRenderer(SR);
    r.setSource(prep.source);
    r.setCleanup(prep.cleanup, { denoiseDb: 6, gate: 0, deess: 0 });
    const out = new Float32Array(x.length);
    const half = Math.floor(x.length / 2 / ENGINE_BLOCK) * ENGINE_BLOCK;
    for (let s = 0; s < half; s += ENGINE_BLOCK) r.render(s, ENGINE_BLOCK, out, s);
    r.setCleanup(prep.cleanup, { denoiseDb: 24, gate: 0, deess: 0 }); // deeper: same pipeline
    for (let s = half; s + ENGINE_BLOCK <= x.length; s += ENGINE_BLOCK) r.render(s, ENGINE_BLOCK, out, s);
    // The late part matches a continuous run at 24 dB closely (only the lookahead used the old amount).
    const deep = cleanupTake(x, SR, prep.cleanup, { denoiseDb: 24, gate: 0, deess: 0 });
    let e = 0;
    let d = 0;
    for (let i = half + SR / 4; i < x.length - ENGINE_BLOCK; i++) {
      e += deep[i] * deep[i];
      d += (out[i] - deep[i]) ** 2;
    }
    expect(Math.sqrt(d / e)).toBeLessThan(0.05);
  });

  it('after an amount change, playing a stretch again (loop) uses the new amount', () => {
    const prep = prepareVoice(x, SR, SR, frames);
    const r = new VoiceRenderer(SR);
    r.setSource(prep.source);
    const light = { denoiseDb: 0, gate: 0.1, deess: 0 };
    const hard = { denoiseDb: 0, gate: 1, deess: 0 };
    r.setCleanup(prep.cleanup, light);
    const out = new Float32Array(x.length);
    const end = Math.round(SR * 1.3 / ENGINE_BLOCK) * ENGINE_BLOCK;
    for (let s = 0; s < end; s += ENGINE_BLOCK) r.render(s, ENGINE_BLOCK, out, s);
    r.setCleanup(prep.cleanup, hard); // amounts only: no pipeline change
    const from = Math.round(SR * 0.6 / ENGINE_BLOCK) * ENGINE_BLOCK; // the loop goes back
    for (let s = from; s < end; s += ENGINE_BLOCK) r.render(s, ENGINE_BLOCK, out, s);
    const want = cleanupTake(x, SR, prep.cleanup, hard);
    let e = 0;
    let d = 0;
    for (let i = from; i < end; i++) {
      e += want[i] * want[i];
      d += (out[i] - want[i]) ** 2;
    }
    expect(Math.sqrt(d / e)).toBeLessThan(0.02);
  });
});
