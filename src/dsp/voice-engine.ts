// Real-time voice rendering (Phase 13). The take is known ahead of time, so the engine doesn't stream
// causally: it renders any output range on demand from the source audio and precomputed grain plans
// (psola.ts). A settings change only rebuilds the plans (milliseconds), so every knob is instant, and
// block-by-block output is identical to rendering the whole take offline.

import type { PitchFrame } from '../audio/pitch-tracker';
import { correctTrack, type Correction, type TuneSettings } from './autotune';
import { harmonyCorrections } from './harmony';
import { planGrains, renderGrains, type GrainPlan, type PsolaAnalysis } from './psola';

/** Largest block the renderer handles in one call (the Web Audio render quantum). */
export const ENGINE_BLOCK = 128;

/** Grain plans for the lead and each harmony voice, plus the harmony level. */
export interface VoicePlans {
  lead: GrainPlan;
  harmonies: GrainPlan[];
  harmonyGain: number;
}

/**
 * The lead's pitch curve: auto-tuned in the sung key (or the sung pitch when tuning is off), then
 * transposed, so harmonies derived from it move along and land in the shifted key.
 */
export function leadCorrections(frames: readonly PitchFrame[], tune: TuneSettings | null, semitones: number): Correction[] {
  let lead: Correction[] = tune ? correctTrack(frames, tune) : frames.map((f) => ({ target: null, corrected: f.midi }));
  if (semitones) lead = lead.map((c) => (c.corrected === null ? c : { ...c, corrected: c.corrected + semitones }));
  return lead;
}

/** Plans for a take with these settings; null = nothing to do (play the source as it is). */
export function planVoices(analysis: PsolaAnalysis, frames: readonly PitchFrame[], tune: TuneSettings | null, semitones: number): VoicePlans | null {
  if (!tune && !semitones) return null;
  const lead = leadCorrections(frames, tune, semitones);
  const voices = tune?.harmony?.voices ?? [];
  return {
    lead: planGrains(analysis, lead),
    // Harmony voices sing the voiced parts only (no stacked breaths / "s" sounds).
    harmonies: voices.map((v) => planGrains(analysis, harmonyCorrections(lead, v, tune!.scale), false)),
    // Equal-power-ish: more voices -> each a bit quieter, so the stack doesn't swamp the lead.
    harmonyGain: voices.length ? (tune!.harmony!.mix ?? 0.6) / Math.sqrt(voices.length) : 0,
  };
}

/** Renders a take (lead + harmonies) block by block. Allocates only in the constructor. */
export class VoiceRenderer {
  private source: Float32Array = new Float32Array(0);
  private plans: VoicePlans | null = null;
  private readonly voice = new Float32Array(ENGINE_BLOCK);
  private readonly weight = new Float32Array(ENGINE_BLOCK);

  setSource(samples: Float32Array): void {
    this.source = samples;
  }

  /** Null = play the source unchanged. Plans must match the source's length. */
  setPlans(plans: VoicePlans | null): void {
    this.plans = plans && plans.lead.length === this.source.length ? plans : null;
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
    renderGrains(src, plans.lead, a, b, this.voice, this.weight);
    for (let i = 0; i < b - a; i++) out[at + i] = this.voice[i];
    for (let v = 0; v < plans.harmonies.length; v++) {
      renderGrains(src, plans.harmonies[v], a, b, this.voice, this.weight);
      for (let i = 0; i < b - a; i++) out[at + i] += plans.harmonyGain * this.voice[i];
    }
  }
}
