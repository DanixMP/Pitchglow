// Pitch shift for polyphonic audio (instrumentals) and Catmull-Rom resampling. The phase vocoder
// itself (time-stretch by r = 2^(st/12), then read r times faster; identity phase locking) is the
// streaming shift-stream.ts, which plays the beat's key shift live.

import { shiftChannels } from './shift-stream';

export function pitchShift(x: Float32Array, semitones: number): Float32Array {
  if (semitones === 0 || x.length === 0) return x.slice();
  // The streaming shifter (shift-stream.ts) is what plays live; offline uses it too, so the tests
  // below check what you hear.
  return shiftChannels([x], semitones)[0];
}

/** Reads `x` at positions i·step (Catmull-Rom), producing `length` samples. */
export function resample(x: Float32Array, step: number, length: number): Float32Array {
  const y = new Float32Array(length);
  const at = (i: number) => x[Math.min(x.length - 1, Math.max(0, i))];
  for (let i = 0; i < length; i++) {
    const pos = i * step;
    const i1 = Math.floor(pos);
    const t = pos - i1;
    const p0 = at(i1 - 1);
    const p1 = at(i1);
    const p2 = at(i1 + 1);
    const p3 = at(i1 + 2);
    y[i] = p1 + 0.5 * t * (p2 - p0 + t * (2 * p0 - 5 * p1 + 4 * p2 - p3 + t * (3 * (p1 - p2) + p3 - p0)));
  }
  return y;
}
