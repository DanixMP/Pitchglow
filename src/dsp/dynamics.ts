// Vocal dynamics (offline entry points): a noise gate driven by the pitch tracker (voiced = open) and
// a split-band de-esser. The algorithms live in cleanup.ts as a stream, so the playback engine runs
// them live; these run them over a whole recording.

import type { PitchFrame } from '../audio/pitch-tracker';
import { CLEANUP_OFF, cleanupTake, frameSizeFor, gateMap } from './cleanup';

/**
 * Noise gate. Open while the voice sounds (voiced frames, or frames clearly above the noise floor);
 * closed it turns the audio down by up to 30 dB × amount. Gain changes are smoothed (5 ms open,
 * 50 ms close) and the gate stays open 80 ms after the voice stops (hold), so word ends aren't clipped.
 */
export function gate(x: Float32Array, sampleRate: number, frames: readonly PitchFrame[], amount: number): Float32Array {
  if (amount <= 0 || frames.length === 0) return x.slice();
  const analysis = { frameSize: frameSizeFor(sampleRate), noise: null, ...gateMap(frames) };
  return cleanupTake(x, sampleRate, analysis, { ...CLEANUP_OFF, gate: amount });
}

/**
 * De-esser: splits at 5.5 kHz (linear-phase FIR, so the bands sum back exactly) and turns the high
 * band down where it dominates the signal (sibilants: "s", "sh", "t"). `amount` 0..1 sets how hard.
 */
export function deess(x: Float32Array, sampleRate: number, amount: number): Float32Array {
  if (amount <= 0) return x.slice();
  const analysis = { frameSize: frameSizeFor(sampleRate), noise: null, gateOpen: new Uint8Array(0), frameTimes: new Float64Array(0) };
  return cleanupTake(x, sampleRate, analysis, { ...CLEANUP_OFF, deess: amount });
}
