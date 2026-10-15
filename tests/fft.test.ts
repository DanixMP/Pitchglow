import { describe, expect, it } from 'vitest';
import { FFT } from '../src/dsp/fft';

describe('FFT', () => {
  it('matches a direct DFT', () => {
    for (const n of [2, 4, 8, 64]) {
      const re = Float64Array.from({ length: n }, (_, i) => Math.sin(i * 1.3) + 0.2 * i);
      const im = Float64Array.from({ length: n }, (_, i) => Math.cos(i * 0.7) - 0.1);
      const wantRe = new Float64Array(n);
      const wantIm = new Float64Array(n);
      for (let k = 0; k < n; k++) {
        for (let t = 0; t < n; t++) {
          const a = (-2 * Math.PI * k * t) / n;
          wantRe[k] += re[t] * Math.cos(a) - im[t] * Math.sin(a);
          wantIm[k] += re[t] * Math.sin(a) + im[t] * Math.cos(a);
        }
      }
      new FFT(n).forward(re, im);
      for (let k = 0; k < n; k++) {
        expect(re[k]).toBeCloseTo(wantRe[k], 9);
        expect(im[k]).toBeCloseTo(wantIm[k], 9);
      }
    }
  });

  it('inverse undoes forward', () => {
    const n = 2048;
    const re = Float64Array.from({ length: n }, (_, i) => Math.sin(i * 0.01) * Math.cos(i * 0.37));
    const im = Float64Array.from({ length: n }, (_, i) => (i % 7) / 7);
    const r0 = re.slice();
    const i0 = im.slice();
    const fft = new FFT(n);
    fft.forward(re, im);
    fft.inverse(re, im);
    for (let i = 0; i < n; i++) {
      expect(re[i]).toBeCloseTo(r0[i], 10);
      expect(im[i]).toBeCloseTo(i0[i], 10);
    }
  });
});
