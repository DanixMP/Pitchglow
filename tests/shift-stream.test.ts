import { describe, expect, it } from 'vitest';
import { ShiftStream, shiftChannels } from '../src/dsp/shift-stream';
import { Yin } from '../src/dsp/yin';
import { sawtooth } from './signals';

const SR = 48000;

function pitch(y: Float32Array, from: number, to: number): number {
  const yin = new Yin(SR, { minFreq: 60 });
  const est: number[] = [];
  for (let s = Math.round(from * SR); s + yin.frameLength < to * SR; s += 960) {
    const e = yin.detect(y.subarray(s, s + yin.frameLength));
    if (e) est.push(e.freq);
  }
  est.sort((a, b) => a - b);
  return est[est.length >> 1];
}

const cents = (a: number, b: number) => 1200 * Math.log2(a / b);

describe('ShiftStream (live beat key shift)', () => {
  it('shifts stereo channels independently, each in tune', () => {
    const L = sawtooth(110, SR, 2, 0.4);
    const R = sawtooth(165, SR, 2, 0.4);
    const [l, r] = shiftChannels([L, R], 3);
    const k = Math.pow(2, 3 / 12);
    expect(Math.abs(cents(pitch(l, 0.5, 1.8), 110 * k))).toBeLessThan(6);
    expect(Math.abs(cents(pitch(r, 0.5, 1.8), 165 * k))).toBeLessThan(6);
  });

  it('a restart (seek / loop) settles to the same pitch and level', () => {
    const x = sawtooth(147, SR, 3, 0.4);
    const [whole] = shiftChannels([x], -2);
    const s = new ShiftStream([x]);
    s.setSemitones(-2);
    const p = Math.round(SR * 1.2);
    s.startAt(p);
    const out = new Float32Array(SR);
    s.render(SR, [out], 0);
    expect(Math.abs(cents(pitch(out, 0.1, 0.9), pitch(whole, 1.3, 2.1)))).toBeLessThan(3);
    const rms = (y: Float32Array, a: number, b: number) => {
      let e = 0;
      for (let i = a; i < b; i++) e += y[i] * y[i];
      return Math.sqrt(e / (b - a));
    };
    const level = rms(out, SR * 0.1, SR * 0.9) / rms(whole, p + SR * 0.1, p + SR * 0.9);
    expect(level).toBeGreaterThan(0.9);
    expect(level).toBeLessThan(1.1);
  });

  it('renders in any chunking with the same samples', () => {
    const x = sawtooth(130, SR, 1, 0.4);
    const [whole] = shiftChannels([x], 4);
    const s = new ShiftStream([x]);
    s.setSemitones(4);
    s.startAt(0);
    const out = new Float32Array(x.length);
    for (let i = 0; i < x.length; i += 128) s.render(Math.min(128, x.length - i), [out], i);
    expect(out).toEqual(whole);
  });

  it('runs well within real time for a stereo beat', () => {
    const L = sawtooth(110, SR, 6, 0.3);
    const R = sawtooth(220, SR, 6, 0.3);
    shiftChannels([L, R], 2); // warm up the JIT
    const t0 = performance.now();
    shiftChannels([L, R], 4);
    const perSecond = (performance.now() - t0) / 6;
    expect(perSecond).toBeLessThan(120); // < 12% of a core in tests
  });
});
