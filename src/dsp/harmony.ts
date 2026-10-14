// Harmonizer (Goal.mp4, 1:28 "One voice, many notes"): extra voices that follow the tuned melody at
// a fixed number of *scale steps*, so harmonies stay in key (diatonic thirds, fifths, octaves).

import type { PitchFrame } from '../audio/pitch-tracker';
import { correctTrack, type Correction, type TuneSettings } from './autotune';
import { limit } from './limiter';
import { renderTuned } from './psola';
import { nearestInScale, scaleMask, type Scale } from './scales';
import { pitchClass } from './notes';

export const HARMONY_VOICES = {
  octaveUp: { label: 'Oct ↑', semitones: 12 },
  fifthUp: { label: '5th ↑', degrees: 4, chromatic: 7 },
  thirdUp: { label: '3rd ↑', degrees: 2, chromatic: 4 },
  thirdDown: { label: '3rd ↓', degrees: -2, chromatic: -3 },
  fifthDown: { label: '5th ↓', degrees: -4, chromatic: -7 },
  octaveDown: { label: 'Oct ↓', semitones: -12 },
} as const satisfies Record<string, { label: string; semitones?: number; degrees?: number; chromatic?: number }>;

export type HarmonyVoice = keyof typeof HARMONY_VOICES;

export interface HarmonySettings {
  voices: HarmonyVoice[];
  /** Level of each harmony voice relative to the lead, 0..1. */
  mix: number;
}

/** Moves `note` by `degrees` steps of the scale (negative = down). Off-scale notes are snapped first. */
export function stepInScale(note: number, degrees: number, scale: Scale): number {
  const mask = scaleMask(scale);
  let n = mask[pitchClass(note)] ? note : nearestInScale(note, scale, mask);
  const dir = Math.sign(degrees);
  for (let left = Math.abs(degrees); left > 0; ) {
    n += dir;
    if (mask[pitchClass(n)]) left--;
  }
  return n;
}

/** The note a harmony voice sings while the lead is on `target`. */
export function harmonyNote(target: number, voice: HarmonyVoice, scale: Scale): number {
  const v: { semitones?: number; degrees?: number; chromatic?: number } = HARMONY_VOICES[voice];
  if (v.semitones !== undefined) return target + v.semitones;
  if (scale.type === 'chromatic') return target + v.chromatic!;
  return stepInScale(target, v.degrees!, scale);
}

/** Correction curve for one harmony voice: the lead's corrected pitch, moved by the harmony interval. */
export function harmonyCorrections(lead: readonly Correction[], voice: HarmonyVoice, scale: Scale): Correction[] {
  return lead.map((c) => {
    if (c.target === null || c.corrected === null) return { target: null, corrected: null };
    const h = harmonyNote(c.target, voice, scale);
    return { target: h, corrected: c.corrected + (h - c.target) };
  });
}

/** Lead (auto-tuned) plus harmony voices, mixed and peak-limited so it never clips. */
export function renderWithHarmony(
  samples: Float32Array,
  sampleRate: number,
  frames: readonly PitchFrame[],
  settings: TuneSettings,
): Float32Array {
  const lead = correctTrack(frames, settings);
  const out = renderTuned(samples, sampleRate, frames, lead);
  const voices = settings.harmony?.voices ?? [];
  if (voices.length === 0) return out;

  // Equal-power-ish: more voices -> each a bit quieter, so the stack doesn't swamp the lead.
  const gain = (settings.harmony!.mix ?? 0.6) / Math.sqrt(voices.length);
  for (const voice of voices) {
    const v = renderTuned(samples, sampleRate, frames, harmonyCorrections(lead, voice, settings.scale));
    for (let i = 0; i < out.length; i++) out[i] += gain * v[i];
  }
  // Only the loudest moments are turned down; the rest of the take keeps its level.
  return limit(out, sampleRate, { ceiling: 0.98 });
}
