import { describe, expect, it } from 'vitest';
import { Decimator, decimationFactor } from '../src/dsp/resample';
import { rms, sine } from './signals';

function runInBlocks(d: Decimator, x: Float32Array, blockSize: number): Float32Array {
  const parts: Float32Array[] = [];
  for (let i = 0; i < x.length; i += blockSize) parts.push(d.process(x.subarray(i, i + blockSize)));
  const out = new Float32Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

describe('Decimator', () => {
  it('picks integer factors', () => {
    expect(decimationFactor(48000, 22050)).toBe(2);
    expect(decimationFactor(44100, 22050)).toBe(2);
    expect(decimationFactor(96000, 22050)).toBe(4);
    expect(decimationFactor(16000, 22050)).toBe(1);
  });

  it('produces exactly 1/factor of the samples regardless of block size', () => {
    const x = sine(200, 48000, 1);
    for (const bs of [128, 333, 512]) {
      expect(runInBlocks(new Decimator(48000, 2), x, bs).length).toBe(24000);
    }
  });

  it('keeps voice-range tones and removes content above the new Nyquist', () => {
    const passed = runInBlocks(new Decimator(48000, 2), sine(300, 48000, 0.5), 512);
    expect(rms(passed.subarray(100))).toBeCloseTo(0.5 / Math.SQRT2, 2);

    const blocked = runInBlocks(new Decimator(48000, 2), sine(15000, 48000, 0.5), 512);
    expect(rms(blocked.subarray(100))).toBeLessThan(0.01);
  });

  it('is identical across block sizes (state carries over)', () => {
    const x = sine(440, 48000, 0.2);
    const a = runInBlocks(new Decimator(48000, 2), x, 128);
    const b = runInBlocks(new Decimator(48000, 2), x, 1000);
    for (let i = 0; i < a.length; i++) expect(a[i]).toBeCloseTo(b[i], 6);
  });
});
