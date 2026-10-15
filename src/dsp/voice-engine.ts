// Real-time voice rendering (Phase 13). The take is known ahead of time, so the engine doesn't stream
// causally: it renders any output range on demand from the source audio and precomputed grain plans
// (psola.ts). A settings change only rebuilds the plans (milliseconds), so every knob is instant, and
// block-by-block output is identical to rendering the whole take offline.
// Phase 15 adds the voice character: formant shift and whisper (grain-shape.ts) and a monotone
// "robot" pitch curve.

import type { PitchFrame } from '../audio/pitch-tracker';
import { correctTrack, type Correction, type TuneSettings } from './autotune';
import { GrainCache, type GrainVoice } from './grain-shape';
import { harmonyCorrections } from './harmony';
import { planGrains, renderGrains, type GrainPlan, type PsolaAnalysis } from './psola';
import { nearestInScale, scaleMask, type Scale } from './scales';

/** Largest block the renderer handles in one call (the Web Audio render quantum). */
export const ENGINE_BLOCK = 128;

/** Grain plans for the lead and each harmony voice, plus the harmony level. */
export interface VoicePlans {
  lead: GrainPlan;
  harmonies: GrainPlan[];
  harmonyGain: number;
}

/** Voice character of a track (Phase 15). */
export interface VoiceCharacter {
  /** Formant shift in semitones (−: deeper/bigger, +: younger/smaller); the pitch stays. */
  formant: number;
  /** 0..1: noise instead of the sung tone, keeping the vowels. */
  whisper: number;
  /** Robot: each phrase is held on its first note (snapped to the scale when auto-tune is on). */
  monotone: boolean;
}

export const NEUTRAL_VOICE: VoiceCharacter = { formant: 0, whisper: 0, monotone: false };

export function isNeutralVoice(v: VoiceCharacter | null | undefined): boolean {
  return !v || (v.formant === 0 && v.whisper === 0 && !v.monotone);
}

/** The grain-level part of a voice character, for voice number `seed` (0 = lead). */
export function grainVoice(v: VoiceCharacter, seed: number): GrainVoice {
  return { formant: Math.pow(2, v.formant / 12), whisper: v.whisper, seed: 0x9e3779b9 * (seed + 1) };
}

/**
 * Robot pitch curve: every sung phrase (run of voiced frames) is held on the note it starts on. Uses
 * only past frames, so the live voice can do exactly the same while you sing.
 */
export function monotoneCorrections(frames: readonly PitchFrame[], scale: Scale | null): Correction[] {
  const mask = scale ? scaleMask(scale) : null;
  let note: number | null = null;
  return frames.map((f) => {
    if (f.midi === null) {
      note = null;
      return { target: null, corrected: null };
    }
    note ??= scale ? nearestInScale(f.midi, scale, mask!) : Math.round(f.midi);
    return { target: note, corrected: note };
  });
}

/**
 * The lead's pitch curve: auto-tuned in the sung key (or the sung pitch when tuning is off; or held
 * on one note per phrase for the robot), then transposed, so harmonies derived from it move along
 * and land in the shifted key.
 */
export function leadCorrections(frames: readonly PitchFrame[], tune: TuneSettings | null, semitones: number, monotone = false): Correction[] {
  let lead: Correction[] = monotone
    ? monotoneCorrections(frames, tune?.scale ?? null)
    : tune
      ? correctTrack(frames, tune)
      : frames.map((f) => ({ target: null, corrected: f.midi }));
  if (semitones) lead = lead.map((c) => (c.corrected === null ? c : { ...c, corrected: c.corrected + semitones }));
  return lead;
}

/** Plans for a take with these settings; null = nothing to do (play the source as it is). */
export function planVoices(
  analysis: PsolaAnalysis,
  frames: readonly PitchFrame[],
  tune: TuneSettings | null,
  semitones: number,
  voice: VoiceCharacter = NEUTRAL_VOICE,
): VoicePlans | null {
  if (!tune && !semitones && isNeutralVoice(voice)) return null;
  const lead = leadCorrections(frames, tune, semitones, voice.monotone);
  const voices = tune?.harmony?.voices ?? [];
  return {
    lead: planGrains(analysis, lead, true, grainVoice(voice, 0)),
    // Harmony voices sing the voiced parts only (no stacked breaths / "s" sounds).
    harmonies: voices.map((v, i) => planGrains(analysis, harmonyCorrections(lead, v, tune!.scale), false, grainVoice(voice, i + 1))),
    // Equal-power-ish: more voices -> each a bit quieter, so the stack doesn't swamp the lead.
    harmonyGain: voices.length ? (tune!.harmony!.mix ?? 0.6) / Math.sqrt(voices.length) : 0,
  };
}

/** Renders a take (lead + harmonies) block by block. Allocates nothing while rendering. */
export class VoiceRenderer {
  private source: Float32Array = new Float32Array(0);
  private plans: VoicePlans | null = null;
  private readonly voice = new Float32Array(ENGINE_BLOCK);
  private readonly weight = new Float32Array(ENGINE_BLOCK);
  /** Shaped-grain caches, one per voice (made when a plan with a voice character arrives). */
  private caches: GrainCache[] = [];

  setSource(samples: Float32Array): void {
    this.source = samples;
    for (const c of this.caches) c.clear();
  }

  /** Null = play the source unchanged. Plans must match the source's length. */
  setPlans(plans: VoicePlans | null): void {
    this.plans = plans && plans.lead.length === this.source.length ? plans : null;
    const voices = this.plans ? 1 + this.plans.harmonies.length : 0;
    while (this.caches.length < voices) this.caches.push(new GrainCache());
  }

  get length(): number {
    return this.source.length;
  }

  /**
   * Writes take samples [start, start + len) into out[offset ..]; positions outside the take are
   * silent. `len` must be at most ENGINE_BLOCK.
   */
  render(start: number, len: number, out: Float32Array, offset: number): void {
    out.fill(0, offset, offset + len);
    const src = this.source;
    const a = Math.max(0, start);
    const b = Math.min(src.length, start + len);
    if (a >= b) return;
    const at = offset + (a - start);
    const plans = this.plans;
    if (!plans) {
      for (let i = a; i < b; i++) out[at + i - a] = src[i];
      return;
    }
    renderGrains(src, plans.lead, a, b, this.voice, this.weight, this.caches[0]);
    for (let i = 0; i < b - a; i++) out[at + i] = this.voice[i];
    for (let v = 0; v < plans.harmonies.length; v++) {
      renderGrains(src, plans.harmonies[v], a, b, this.voice, this.weight, this.caches[v + 1]);
      for (let i = 0; i < b - a; i++) out[at + i] += plans.harmonyGain * this.voice[i];
    }
  }
}
