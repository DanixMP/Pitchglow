// Offline vocal dynamics: a noise gate driven by the pitch tracker (voiced = open) and a split-band
// de-esser. Both are look-ahead by nature (offline), so they never cut the start of a word.

import type { PitchFrame } from '../audio/pitch-tracker';
import { zeroPhaseLowpass } from './psola';

/**
 * Noise gate. Open while the voice sounds (voiced frames, or frames clearly above the noise floor);
 * closed it turns the audio down by up to 30 dB × amount. Gain changes are smoothed (5 ms open,
 * 50 ms close) and the gate stays open 80 ms after the voice stops (hold), so word ends aren't clipped.
 */
export function gate(x: Float32Array, sampleRate: number, frames: readonly PitchFrame[], amount: number): Float32Array {
  if (amount <= 0 || frames.length === 0) return x.slice();
  const floorDb = -30 * Math.min(1, amount);
  const closed = Math.pow(10, floorDb / 20);

  // Noise floor = 10th percentile of frame RMS; "clearly above" = 10 dB over it.
  const levels = frames.map((f) => f.rms).sort((a, b) => a - b);
  const noise = levels[Math.floor(levels.length * 0.1)] ?? 0;
  const threshold = noise * Math.pow(10, 10 / 20);

  // Per-frame target gain (with hold), then per-sample smoothing.
  const hop = frames.length > 1 ? frames[1].time - frames[0].time : 0.01;
  const holdFrames = Math.ceil(0.08 / hop);
  const target = new Float32Array(frames.length);
  let hold = 0;
  frames.forEach((f, i) => {
    const open = f.midi !== null || f.rms > threshold;
    hold = open ? holdFrames : Math.max(0, hold - 1);
    target[i] = open || hold > 0 ? 1 : closed;
  });

  const out = new Float32Array(x.length);
  const attack = 1 - Math.exp(-1 / (0.005 * sampleRate));
  const release = 1 - Math.exp(-1 / (0.05 * sampleRate));
  // Frames describe a window centred on `time`; open slightly early so onsets get through.
  const lead = Math.round(0.02 * sampleRate);
  let g = target[0] ?? 1;
  let fi = 0;
  for (let i = 0; i < x.length; i++) {
    const t = (i + lead) / sampleRate;
    while (fi + 1 < frames.length && frames[fi + 1].time <= t) fi++;
    const want = target[fi];
    g += (want - g) * (want > g ? attack : release);
    out[i] = x[i] * g;
  }
  return out;
}

/**
 * De-esser: splits at 5.5 kHz (zero-phase, so the bands sum back exactly) and turns the high band
 * down where it dominates the signal (sibilants: "s", "sh", "t"). `amount` 0..1 sets how hard.
 */
export function deess(x: Float32Array, sampleRate: number, amount: number): Float32Array {
  if (amount <= 0) return x.slice();
  const low = zeroPhaseLowpass(x, sampleRate, 5500);
  const n = x.length;
  const high = new Float32Array(n);
  for (let i = 0; i < n; i++) high[i] = x[i] - low[i];

  // Envelopes (5 ms) of each band.
  const a = 1 - Math.exp(-1 / (0.005 * sampleRate));
  let eh = 0;
  let el = 0;
  const out = new Float32Array(n);
  let g = 1;
  const smooth = 1 - Math.exp(-1 / (0.003 * sampleRate));
  for (let i = 0; i < n; i++) {
    eh += a * (Math.abs(high[i]) - eh);
    el += a * (Math.abs(low[i]) - el);
    // Sibilance: high band louder than ~half the low band. Reduce it towards that balance.
    const ratio = eh / (el + 1e-6);
    const excess = Math.max(0, ratio - 0.5);
    const want = eh > 1e-4 ? 1 / (1 + 4 * amount * excess) : 1;
    g += (Math.max(0.1, want) - g) * smooth;
    out[i] = low[i] + high[i] * g;
  }
  return out;
}
