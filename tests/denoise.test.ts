import { describe, expect, it } from 'vitest';
import { denoise, frameSizeFor } from '../src/dsp/denoise';
import { FFT } from '../src/dsp/fft';
import { noise, rms, sawtooth } from './signals';

const SR = 48000;

const db = (x: number) => 20 * Math.log10(x);
const seg = (a: Float32Array, t0: number, t1: number) => a.subarray(Math.round(t0 * SR), Math.round(t1 * SR));

/** A "take": 0.6 s of room noise, 1.4 s of voice-like tone (+ the same noise), 0.5 s of noise. */
function noisyTake(noiseAmp: number) {
  const clean = new Float32Array(Math.round(2.5 * SR));
  clean.set(sawtooth(196, SR, 1.4, 0.25), Math.round(0.6 * SR));
  const hiss = noise(SR, 2.5, noiseAmp);
  const noisy = clean.map((v, i) => v + hiss[i]);
  return { clean, noisy };
}

function snrDb(clean: Float32Array, test: Float32Array): number {
  const err = test.map((v, i) => v - clean[i]);
  return db(rms(clean) / rms(err));
}

describe('FFT', () => {
  it('round-trips and finds a sinusoid in the right bin', () => {
    const n = 256;
    const fft = new FFT(n);
    const re = new Float64Array(n);
    const im = new Float64Array(n);
    for (let i = 0; i < n; i++) re[i] = Math.cos((2 * Math.PI * 10 * i) / n);
    const orig = re.slice();
    fft.forward(re, im);
    expect(Math.hypot(re[10], im[10])).toBeCloseTo(n / 2, 6);
    expect(Math.hypot(re[11], im[11])).toBeLessThan(1e-9);
    fft.inverse(re, im);
    for (let i = 0; i < n; i++) expect(re[i]).toBeCloseTo(orig[i], 9);
  });

  it('rejects non power-of-two sizes', () => {
    expect(() => new FFT(1000)).toThrow();
  });
});

describe('denoise', () => {
  it('uses ~43 ms frames', () => {
    expect(frameSizeFor(48000)).toBe(2048);
    expect(frameSizeFor(44100)).toBe(2048);
    expect(frameSizeFor(16000)).toBe(512);
  });

  it('removes steady hiss and improves SNR substantially', () => {
    const { clean, noisy } = noisyTake(0.05); // ~11 dB SNR in the voiced part
    const { output, applied } = denoise(noisy, SR, { amountDb: 18 });
    expect(applied).toBe(true);
    const before = snrDb(clean, noisy);
    const after = snrDb(clean, output);
    expect(after - before).toBeGreaterThan(6);
    // The noise-only lead-in drops by roughly the requested amount.
    expect(db(rms(seg(output, 0.1, 0.5)) / rms(seg(noisy, 0.1, 0.5)))).toBeLessThan(-14);
  });

  it('keeps the voice level (no big loss of the wanted signal)', () => {
    const { noisy } = noisyTake(0.05);
    const { output } = denoise(noisy, SR, { amountDb: 18 });
    const voiceIn = rms(seg(noisy, 0.9, 1.7));
    const voiceOut = rms(seg(output, 0.9, 1.7));
    expect(voiceOut / voiceIn).toBeGreaterThan(0.85);
  });

  it('passes a clean recording through essentially unchanged', () => {
    const { clean } = noisyTake(0);
    const { output } = denoise(clean, SR, { amountDb: 18 });
    expect(snrDb(clean, output)).toBeGreaterThan(40);
  });

  it('respects amount = 0 and keeps the length', () => {
    const { noisy } = noisyTake(0.05);
    const off = denoise(noisy, SR, { amountDb: 0 });
    expect(off.applied).toBe(false);
    expect([...off.output.subarray(0, 50)]).toEqual([...noisy.subarray(0, 50)]);
    expect(denoise(noisy, SR, { amountDb: 12 }).output.length).toBe(noisy.length);
  });

  it('processes a minute of audio quickly', () => {
    const x = noise(SR, 60, 0.05);
    const t0 = performance.now();
    denoise(x, SR, { amountDb: 12 });
    expect(performance.now() - t0).toBeLessThan(3000);
  });
});
