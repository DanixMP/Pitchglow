import { describe, expect, it } from 'vitest';
import type { PitchFrame } from '../src/audio/pitch-tracker';
import { deess, gate } from '../src/dsp/dynamics';
import { FFT } from '../src/dsp/fft';
import { generateImpulse, REVERB_PRESETS } from '../src/dsp/reverb';
import { pitchShift } from '../src/dsp/vocoder';
import { noise, rms, sawtooth, sine } from './signals';

const SR = 44100;
const db = (x: number) => 20 * Math.log10(x);

/** Frequencies of the `count` strongest spectral peaks (parabolic interpolation), ascending. */
function peaks(x: Float32Array, count: number): number[] {
  const n = 16384;
  const fft = new FFT(n);
  const re = new Float64Array(n);
  const im = new Float64Array(n);
  const start = Math.floor((x.length - n) / 2);
  for (let i = 0; i < n; i++) re[i] = x[start + i] * (0.5 - 0.5 * Math.cos((2 * Math.PI * i) / n));
  fft.forward(re, im);
  const mag = Array.from({ length: n / 2 }, (_, k) => Math.hypot(re[k], im[k]));
  const found: { f: number; m: number }[] = [];
  for (let k = 2; k < n / 2 - 1; k++) {
    if (mag[k] > mag[k - 1] && mag[k] >= mag[k + 1]) {
      const a = Math.log(mag[k - 1]);
      const b = Math.log(mag[k]);
      const c = Math.log(mag[k + 1]);
      const delta = (0.5 * (a - c)) / (a - 2 * b + c);
      found.push({ f: ((k + delta) * SR) / n, m: mag[k] });
    }
  }
  return found.sort((p, q) => q.m - p.m).slice(0, count).map((p) => p.f).sort((p, q) => p - q);
}

describe('pitchShift (phase vocoder)', () => {
  it.each([2, -3, 4, -4, 1])('moves a 440 Hz tone by %d semitones', (st) => {
    const x = sine(440, SR, 1.5, 0.5);
    const y = pitchShift(x, st);
    expect(y.length).toBe(x.length);
    const [f] = peaks(y, 1);
    expect(Math.abs(f / (440 * Math.pow(2, st / 12)) - 1)).toBeLessThan(0.003); // within ~5 cents
    const mid = (a: Float32Array) => a.subarray(SR * 0.3, SR * 1.2);
    expect(Math.abs(db(rms(mid(y)) / rms(mid(x))))).toBeLessThan(1.5);
  });

  it('shifts every note of a chord (polyphonic)', () => {
    const x = new Float32Array(SR * 1.5);
    for (const f of [220, 277.18, 329.63]) {
      const s = sine(f, SR, 1.5, 0.25);
      for (let i = 0; i < x.length; i++) x[i] += s[i];
    }
    const y = pitchShift(x, 3);
    const want = [220, 277.18, 329.63].map((f) => f * Math.pow(2, 3 / 12));
    peaks(y, 3).forEach((f, i) => expect(Math.abs(f / want[i] - 1)).toBeLessThan(0.004));
  });

  it('is identity at 0 semitones', () => {
    const x = sawtooth(150, SR, 0.3);
    expect([...pitchShift(x, 0).subarray(100, 110)]).toEqual([...x.subarray(100, 110)]);
  });

  it('processes 10 s of audio in reasonable time', () => {
    const x = sawtooth(110, SR, 10, 0.3);
    const t0 = performance.now();
    pitchShift(x, 2);
    expect(performance.now() - t0).toBeLessThan(6000);
  });
});

describe('generateImpulse', () => {
  it.each(Object.keys(REVERB_PRESETS) as (keyof typeof REVERB_PRESETS)[])('%s: decays, has pre-delay and wide stereo', (preset) => {
    const shape = REVERB_PRESETS[preset].shape;
    const [l, r] = generateImpulse(shape, SR);
    expect(l.length).toBe(Math.round(shape.preDelay * SR) + Math.ceil(shape.decay * 1.1 * SR));
    const seg = (a: Float32Array, t0: number, t1: number) => rms(a.subarray(Math.round(t0 * a.length), Math.round(t1 * a.length)));
    expect(db(seg(l, 0.85, 0.95) / seg(l, 0.05, 0.15))).toBeLessThan(-30); // tail far below the start
    let dot = 0;
    for (let i = 0; i < l.length; i++) dot += l[i] * r[i];
    expect(Math.abs(dot / (rms(l) * rms(r) * l.length))).toBeLessThan(0.2); // decorrelated L/R
  });

  it('tone darkens the tail', () => {
    const shape = REVERB_PRESETS.hall.shape;
    const hf = (x: Float32Array) => {
      let d = 0;
      for (let i = 1; i < x.length; i++) d += (x[i] - x[i - 1]) ** 2;
      return d;
    };
    expect(hf(generateImpulse(shape, SR, 0)[0])).toBeLessThan(hf(generateImpulse(shape, SR, 1)[0]));
  });
});

describe('gate', () => {
  // 0.5 s noise, 1 s "voice" (tone + the same noise), 0.5 s noise; frames voiced only in the middle.
  const x = noise(SR, 2, 0.01);
  const tone = sine(220, SR, 1, 0.3);
  for (let i = 0; i < tone.length; i++) x[Math.round(0.5 * SR) + i] += tone[i];
  const frames: PitchFrame[] = Array.from({ length: 200 }, (_, i) => {
    const time = i / 100;
    const voiced = time >= 0.5 && time < 1.5;
    return { time, midi: voiced ? 57 : null, freq: voiced ? 220 : null, clarity: 1, rms: voiced ? 0.21 : 0.006 };
  });

  it('turns the gaps down and leaves the voice alone', () => {
    const y = gate(x, SR, frames, 1);
    const seg = (a: Float32Array, t0: number, t1: number) => rms(a.subarray(Math.round(t0 * SR), Math.round(t1 * SR)));
    expect(db(seg(y, 0.05, 0.4) / seg(x, 0.05, 0.4))).toBeLessThan(-20);
    expect(Math.abs(db(seg(y, 0.6, 1.4) / seg(x, 0.6, 1.4)))).toBeLessThan(0.5);
    expect(db(seg(y, 1.75, 1.95) / seg(x, 1.75, 1.95))).toBeLessThan(-20);
  });

  it('amount 0 is a no-op', () => {
    expect([...gate(x, SR, frames, 0).subarray(0, 50)]).toEqual([...x.subarray(0, 50)]);
  });
});

describe('deess', () => {
  it('tames sibilants without touching vowels', () => {
    // Vowel 0–1 s (dull sawtooth), sibilant 1–1.3 s (bright noise burst).
    const vowel = sawtooth(180, SR, 1, 0.3);
    const x = new Float32Array(Math.round(1.3 * SR));
    x.set(vowel.map((v, i, a) => (i ? 0.5 * (v + a[i - 1]) : v)));
    const hiss = noise(SR, 0.3, 0.3);
    for (let i = 1; i < hiss.length; i++) x[SR + i] += hiss[i] - hiss[i - 1]; // differentiated = bright
    const y = deess(x, SR, 1);
    const seg = (a: Float32Array, t0: number, t1: number) => rms(a.subarray(Math.round(t0 * SR), Math.round(t1 * SR)));
    expect(db(seg(y, 1.05, 1.25) / seg(x, 1.05, 1.25))).toBeLessThan(-6);
    expect(Math.abs(db(seg(y, 0.2, 0.9) / seg(x, 0.2, 0.9)))).toBeLessThan(1);
  });
});
