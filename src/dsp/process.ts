// Full offline processing chain for a recording: noise reduction -> auto-tune (+ harmony).

import type { PitchFrame } from '../audio/pitch-tracker';
import type { TuneSettings } from './autotune';
import { denoise, type DenoiseSettings } from './denoise';
import { renderWithHarmony } from './harmony';

export interface ProcessSettings {
  denoise: DenoiseSettings | null;
  tune: TuneSettings | null;
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
  const notes: string[] = [];
  let audio = samples;
  if (settings.denoise) {
    const key = `${cacheKey}|${JSON.stringify(settings.denoise)}`;
    let entry = cache?.get(key);
    if (!entry) {
      const r = denoise(samples, sampleRate, settings.denoise);
      entry = { key, output: r.output, applied: r.applied };
      cache?.set(entry);
    }
    audio = entry.output;
    if (!entry.applied) notes.push('Too short to learn the noise');
  }
  // The pitch track (from the original) still describes the cleaned audio: same timing, same voice.
  const output = settings.tune ? renderWithHarmony(audio, sampleRate, frames, settings.tune) : audio.slice();
  return { output, notes };
}
