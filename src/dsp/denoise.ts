// Spectral noise reduction (offline entry point). The algorithm lives in cleanup.ts as a stream, so
// the playback engine can run it live; this runs it over a whole recording.
//
// 1. STFT: ~43 ms Hann frames at 75% overlap, Hann synthesis + overlap normalisation (perfect
//    reconstruction when nothing is changed). Long frames resolve the gaps between a voice's
//    harmonics, so the noise *between* them can be removed, not just the noise in pauses.
// 2. Noise profile: the average power spectrum of the quietest ~15% of frames (breaths, pauses, room
//    tone). Recordings without enough quiet frames are left alone rather than guessed at.
// 3. Per-bin Wiener gain with decision-directed a-priori SNR (Ephraim & Malah): much less "warbly"
//    (musical noise) than plain spectral subtraction. Smoothed across neighbouring bins and floored at
//    -amountDb, so some room tone stays and the voice never sounds gated.

import { CLEANUP_OFF, cleanupTake, frameSizeFor, noiseProfile } from './cleanup';

export { frameSizeFor };

export interface DenoiseSettings {
  /** Maximum attenuation of noise, in dB (the gain floor). 0 = off, ~12 natural, 25+ aggressive. */
  amountDb: number;
}

export interface DenoiseResult {
  output: Float32Array;
  /** False when there wasn't enough quiet audio to learn the noise from (output = input). */
  applied: boolean;
}

export function denoise(x: Float32Array, sampleRate: number, settings: DenoiseSettings): DenoiseResult {
  if (settings.amountDb <= 0 || x.length === 0) return { output: x.slice(), applied: false };
  const noise = noiseProfile(x, sampleRate);
  if (!noise) return { output: x.slice(), applied: false };
  const analysis = { frameSize: frameSizeFor(sampleRate), noise, gateOpen: new Uint8Array(0), frameTimes: new Float64Array(0) };
  return { output: cleanupTake(x, sampleRate, analysis, { ...CLEANUP_OFF, denoiseDb: settings.amountDb }), applied: true };
}
