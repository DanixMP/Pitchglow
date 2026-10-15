// Harmonizer (Goal.mp4, 1:28 "One voice, many notes"): extra voices that follow the tuned melody at
// a fixed number of *scale steps*, so harmonies stay in key (diatonic thirds, fifths, octaves).

import type { PitchFrame } from '../audio/pitch-tracker';
import type { Correction, TuneSettings } from './autotune';
import { limit } from './limiter';
import { analyzePsola, renderGrains } from './psola';
import { planVoices, type VoiceCharacter, type VoicePlans } from './voice-engine';
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

/** Lead (auto-tuned) plus harmony voices, mixed and peak-limited so it never clips (offline reference). */
export function renderWithHarmony(
  samples: Float32Array,
  sampleRate: number,
  frames: readonly PitchFrame[],
  settings: TuneSettings | null,
  semitones = 0,
  character?: VoiceCharacter,
): Float32Array {
  const plans = planVoices(analyzePsola(samples, sampleRate, frames), frames, settings, semitones, character);
  return plans ? renderPlans(samples, plans, sampleRate) : samples.slice();
}

/** Renders a whole take through its voice plans (lead + harmonies), peak-limited when harmonies stack. */
export function renderPlans(src: Float32Array, plans: VoicePlans, sampleRate: number): Float32Array {
  const n = src.length;
  const out = new Float32Array(n);
  const voice = new Float32Array(n);
  const weight = new Float32Array(n);
  renderGrains(src, plans.lead, 0, n, out, weight);
  if (plans.harmonies.length === 0) return out;
  for (const h of plans.harmonies) {
    renderGrains(src, h, 0, n, voice, weight);
    for (let i = 0; i < n; i++) out[i] += plans.harmonyGain * voice[i];
  }
  // Only the loudest moments are turned down; the rest of the take keeps its level.
  return limit(out, sampleRate, { ceiling: 0.98 });
}
