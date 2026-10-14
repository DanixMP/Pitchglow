// Processing chain for a recording, in two stages (Phase 13):
// - prepareVoice (worker, redone only when clean-up settings change): noise reduction -> gate ->
//   de-esser, resampled to the playback rate. This is the voice engine's source audio.
// - the voice engine (real time): auto-tune (+ harmony) and pitch shift, see voice-engine.ts.
// processRecording runs both offline; it is the reference the engine is tested against.

import type { PitchFrame } from '../audio/pitch-tracker';
import type { TuneSettings } from './autotune';
import { denoise, type DenoiseSettings } from './denoise';
import { deess, gate } from './dynamics';
import { renderWithHarmony } from './harmony';
import { resample } from './vocoder';

/** The clean-up part of the chain (everything that runs before the voice engine). */
export interface PrepareSettings {
  denoise: DenoiseSettings | null;
  gate?: number;
  deess?: number;
}

export interface ProcessSettings {
  denoise: DenoiseSettings | null;
  tune: TuneSettings | null;
  /** Transpose (track pitch + song key shift), semitones. */
  pitch?: number;
  /** Noise gate amount 0..1. */
  gate?: number;
  /** De-esser amount 0..1. */
  deess?: number;
}

export interface ProcessResult {
  output: Float32Array;
  /** Human-readable notes about what couldn't be done (shown under the transport). */
  notes: string[];
}

/** Caches the (slow-ish, rarely changing) noise-reduction step between renders. */
export interface DenoiseCache {
  key: string;
  output: Float32Array;
  applied: boolean;
}

export function processRecording(
  samples: Float32Array,
  sampleRate: number,
  frames: readonly PitchFrame[],
  settings: ProcessSettings,
  cache?: { get(key: string): DenoiseCache | undefined; set(entry: DenoiseCache): void },
  cacheKey = '',
): ProcessResult {
  const { source, notes } = prepareVoice(samples, sampleRate, sampleRate, frames, settings, cache, cacheKey);
  // The pitch track (from the original) still describes the cleaned audio: same timing, same voice.
  const output = settings.tune || settings.pitch ? renderWithHarmony(source, sampleRate, frames, settings.tune, settings.pitch ?? 0) : source;
  return { output, notes };
}

/**
 * Clean-up stage: noise reduction (cached) -> gate -> de-esser, then resampled to `targetRate` (the
 * playback context's rate) if the take was recorded at another rate. Always returns a new array.
 */
export function prepareVoice(
  samples: Float32Array,
  sampleRate: number,
  targetRate: number,
  frames: readonly PitchFrame[],
  settings: PrepareSettings,
  cache?: { get(key: string): DenoiseCache | undefined; set(entry: DenoiseCache): void },
  cacheKey = '',
): { source: Float32Array; notes: string[] } {
  const notes: string[] = [];
  let audio = samples;
  /** Whether `audio` is ours to hand out (not the caller's samples or the cached denoise output). */
  let owned = false;
  if (settings.denoise) {
    const key = `${cacheKey}|${JSON.stringify(settings.denoise)}`;
    let entry = cache?.get(key);
    if (!entry) {
      const r = denoise(samples, sampleRate, settings.denoise);
      entry = { key, output: r.output, applied: r.applied };
      cache?.set(entry);
    }
    audio = entry.output;
    owned = !cache;
    if (!entry.applied) notes.push('Too short to learn the noise');
  }
  if (settings.gate) {
    audio = gate(audio, sampleRate, frames, settings.gate);
    owned = true;
  }
  // Sibilants are unvoiced, which the pitch shifter passes through unchanged, so de-essing before it
  // sounds the same as after, and keeps the whole clean-up stage ahead of the real-time engine.
  if (settings.deess) {
    audio = deess(audio, sampleRate, settings.deess);
    owned = true;
  }
  if (targetRate !== sampleRate) {
    return { source: resample(audio, sampleRate / targetRate, Math.floor((audio.length * targetRate) / sampleRate)), notes };
  }
  return { source: owned ? audio : audio.slice(), notes };
}
