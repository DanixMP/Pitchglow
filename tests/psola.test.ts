import { describe, expect, it } from 'vitest';
import { PitchTracker, type PitchFrame } from '../src/audio/pitch-tracker';
import { correctTrack } from '../src/dsp/autotune';
import { freqToMidi } from '../src/dsp/notes';
import { renderTuned } from '../src/dsp/psola';
import { CHROMATIC } from '../src/dsp/scales';
import { noise, rms, sawtooth } from './signals';

const SR = 48000;

function track(signal: Float32Array): PitchFrame[] {
  const frames: PitchFrame[] = [];
  const tracker = new PitchTracker(SR, (f) => frames.push(f));
  for (let i = 0; i < signal.length; i += 512) tracker.push(signal.subarray(i, i + 512));
  return frames;
}

/** Median detected MIDI pitch over the middle of the signal. */
function medianMidi(signal: Float32Array, from = 0.2, to = 0.8): number {
  const f = track(signal).filter((x) => x.midi !== null && x.time > from * (signal.length / SR) && x.time < to * (signal.length / SR));
  const m = f.map((x) => x.midi!).sort((a, b) => a - b);
  return m[m.length >> 1];
}

/** Shift every voiced frame by a fixed number of semitones. */
function shiftBy(frames: PitchFrame[], semitones: number) {
  return frames.map((f) => ({ target: null, corrected: f.midi === null ? null : f.midi + semitones }));
}

/** Sawtooth whose frequency follows `freqAt(t)` (phase-continuous), amplitude 0.5. */
function sweep(seconds: number, freqAt: (t: number) => number): Float32Array {
  const out = new Float32Array(Math.round(SR * seconds));
  let phase = 0;
  for (let i = 0; i < out.length; i++) {
    const f = freqAt(i / SR);
    for (let h = 1; h <= 20; h++) out[i] += (0.5 / h) * Math.sin(2 * Math.PI * h * phase);
    phase += f / SR;
  }
  return out;
}

describe('renderTuned (TD-PSOLA)', () => {
  it('keeps the length and is near-transparent with no correction', () => {
    const x = sawtooth(160, SR, 1);
    const y = renderTuned(x, SR, track(x), shiftBy(track(x), 0));
    expect(y.length).toBe(x.length);
    const err = new Float32Array(x.length);
    for (let i = 0; i < x.length; i++) err[i] = y[i] - x[i];
    // Signal-to-error ratio over the steady middle section.
    const mid = (a: Float32Array) => a.subarray(SR * 0.2, SR * 0.8);
    expect(20 * Math.log10(rms(mid(x)) / rms(mid(err)))).toBeGreaterThan(25);
  });

  it.each([1, -1, 2, -3])('shifts a steady voice by %d semitone(s)', (semis) => {
    const x = sawtooth(165, SR, 1.2);
    const y = renderTuned(x, SR, track(x), shiftBy(track(x), semis));
    expect(medianMidi(y) - freqToMidi(165)).toBeCloseTo(semis, 1); // within 5 cents
  });

  it('keeps the level steady when shifting', () => {
    const x = sawtooth(150, SR, 1);
    const up = renderTuned(x, SR, track(x), shiftBy(track(x), 2));
    const down = renderTuned(x, SR, track(x), shiftBy(track(x), -2));
    const mid = (a: Float32Array) => rms(a.subarray(SR * 0.2, SR * 0.8));
    expect(mid(up) / mid(x)).toBeGreaterThan(0.8);
    expect(mid(up) / mid(x)).toBeLessThan(1.25);
    expect(mid(down) / mid(x)).toBeGreaterThan(0.8);
    expect(mid(down) / mid(x)).toBeLessThan(1.25);
  });

  it('flattens a wobbly voice onto the note at 0 ms retune', () => {
    // 15 cents sharp of A3 with ±25 cent vibrato: wobbly, but always closest to A3.
    const base = freqToMidi(220) + 0.15;
    const vibrato = 0.25;
    const x = sweep(1.5, (t) => 440 * Math.pow(2, (base + vibrato * Math.sin(2 * Math.PI * 5 * t) - 69) / 12));
    const frames = track(x);
    const y = renderTuned(x, SR, frames, correctTrack(frames, { scale: CHROMATIC, retuneMs: 0 }));
    const out = track(y).filter((f) => f.midi !== null && f.time > 0.2 && f.time < 1.3).map((f) => f.midi!);
    const spread = Math.max(...out) - Math.min(...out);
    expect(spread).toBeLessThan(0.15); // input swings 0.5 semitones
    const mean = out.reduce((a, b) => a + b, 0) / out.length;
    expect(Math.abs(mean - 57)).toBeLessThan(0.08); // lands on A3
  });

  it('passes unvoiced audio through unchanged', () => {
    const x = noise(SR, 0.5);
    const frames = track(x);
    const y = renderTuned(x, SR, frames, shiftBy(frames, 3));
    let maxErr = 0;
    for (let i = 0; i < x.length; i++) maxErr = Math.max(maxErr, Math.abs(y[i] - x[i]));
    expect(maxErr).toBeLessThan(1e-5);
  });

  it('shifts down by a whole octave (grains two analysis periods long)', () => {
    // Regression: with grains as long as the synthesis period, -12 reassembled the input unchanged.
    const x = sawtooth(150, SR, 1.5, 0.4);
    const frames = track(x);
    const tone = (y: Float32Array, f: number) => {
      let re = 0;
      let im = 0;
      for (let i = SR / 2; i < SR * 1.3; i++) {
        re += y[i] * Math.cos((2 * Math.PI * f * i) / SR);
        im += y[i] * Math.sin((2 * Math.PI * f * i) / SR);
      }
      return Math.hypot(re, im) / (SR * 0.8);
    };
    for (const st of [-12, -7]) {
      const y = renderTuned(x, SR, frames, shiftBy(frames, st));
      const f = 150 * Math.pow(2, st / 12);
      expect(tone(y, f)).toBeGreaterThan(20 * tone(x, f));
      const level = rms(y.subarray(SR / 2, SR * 1.3)) / rms(x.subarray(SR / 2, SR * 1.3));
      expect(level).toBeGreaterThan(0.5);
      expect(level).toBeLessThan(1.3);
    }
  });

  it('renders a minute of audio quickly', () => {
    // Tile one second of a 140 Hz tone (a whole number of cycles) and describe it with synthetic frames.
    const second = sawtooth(140, SR, 1);
    const x = new Float32Array(SR * 60);
    for (let s = 0; s < 60; s++) x.set(second, s * SR);
    const midi = freqToMidi(140);
    const frames: PitchFrame[] = Array.from({ length: 6000 }, (_, i) => ({ time: i / 100, freq: 140, midi, clarity: 1, rms: 0.3 }));
    const corrections = shiftBy(frames, 1);
    const t0 = performance.now();
    renderTuned(x, SR, frames, corrections);
    expect(performance.now() - t0).toBeLessThan(1500);
  });
});
