import { describe, expect, it } from 'vitest';
import { Yin } from '../src/dsp/yin';
import { noise, sawtooth, sine } from './signals';

const SR = 22050;

describe('Yin', () => {
  const yin = new Yin(SR);

  it.each([65, 98, 110, 130.81, 220, 440, 880])('detects a %d Hz sine within 0.3%%', (f) => {
    const est = yin.detect(sine(f, SR, 0.1));
    expect(est).not.toBeNull();
    expect(Math.abs(est!.freq - f) / f).toBeLessThan(0.003);
    expect(est!.clarity).toBeGreaterThan(0.9);
  });

  it.each([82.4, 123.5, 196, 330])('detects the fundamental of a %d Hz sawtooth (no octave error)', (f) => {
    const est = yin.detect(sawtooth(f, SR, 0.1));
    expect(Math.abs(est!.freq - f) / f).toBeLessThan(0.005);
  });

  it('reports low clarity for noise', () => {
    const est = yin.detect(noise(SR, 0.1));
    expect(est === null || est.clarity < 0.6).toBe(true);
  });

  it('rejects frames that are too short', () => {
    expect(() => yin.detect(new Float32Array(10))).toThrow();
  });
});
