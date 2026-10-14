import { describe, expect, it } from 'vitest';
import { limit, limitLinked } from '../src/dsp/limiter';
import { rms, sine } from './signals';

const SR = 48000;

describe('limit', () => {
  it('leaves quiet audio untouched', () => {
    const x = sine(220, SR, 0.5, 0.5);
    expect([...limit(x, SR)]).toEqual([...x]);
  });

  it('keeps every sample under the ceiling', () => {
    const x = sine(220, SR, 0.5, 1.6);
    const y = limit(x, SR, { ceiling: 0.98 });
    expect(Math.max(...y.map(Math.abs))).toBeLessThanOrEqual(0.98 + 1e-6);
  });

  it('only turns down the loud burst, not the whole signal', () => {
    // 0.4 s quiet, 0.1 s very loud, 0.5 s quiet.
    const x = sine(220, SR, 1, 0.3);
    for (let i = Math.round(0.4 * SR); i < Math.round(0.5 * SR); i++) x[i] *= 5;
    const y = limit(x, SR);
    const seg = (a: Float32Array, t0: number, t1: number) => rms(a.subarray(Math.round(t0 * SR), Math.round(t1 * SR)));
    expect(seg(y, 0, 0.35) / seg(x, 0, 0.35)).toBeCloseTo(1, 3); // before: untouched
    expect(seg(y, 0.8, 1) / seg(x, 0.8, 1)).toBeGreaterThan(0.97); // after release: back to normal
    expect(Math.max(...y.map(Math.abs))).toBeLessThanOrEqual(0.98 + 1e-6);
  });

  it('changes gain smoothly (no clicks)', () => {
    const x = new Float32Array(SR / 2).fill(0.5);
    for (let i = 10000; i < 10050; i++) x[i] = 2; // short spike on a DC level
    const y = limit(x, SR);
    let maxStep = 0;
    for (let i = 1; i < y.length; i++) if (x[i] === x[i - 1]) maxStep = Math.max(maxStep, Math.abs(y[i] - y[i - 1]));
    expect(maxStep).toBeLessThan(0.01);
  });

  it('links the gain across channels (stereo image stays put)', () => {
    const left = sine(220, SR, 0.5, 1.5); // loud
    const right = sine(220, SR, 0.5, 0.5); // quiet, same phase
    const [l, r] = limitLinked([left, right], SR, { ceiling: 0.98 });
    expect(Math.max(...l.map(Math.abs))).toBeLessThanOrEqual(0.98 + 1e-6);
    // Same gain on both: the L/R ratio is preserved sample by sample (where the signal isn't ~0).
    for (let i = 1000; i < l.length; i += 997) if (Math.abs(right[i]) > 0.05) expect(l[i] / r[i]).toBeCloseTo(3, 4);
  });
});
