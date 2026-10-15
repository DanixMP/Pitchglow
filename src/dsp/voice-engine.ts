// Real-time voice rendering (Phase 13). The take is known ahead of time, so the engine doesn't stream
// causally: it renders any output range on demand from the source audio and precomputed grain plans
// (psola.ts). A settings change only rebuilds the plans (milliseconds), so every knob is instant, and
// block-by-block output is identical to rendering the whole take offline.
// Phase 15 adds the voice character: formant shift and whisper (grain-shape.ts) and a monotone
// "robot" pitch curve.

import type { PitchFrame } from '../audio/pitch-tracker';
import { correctTrack, type Correction, type TuneSettings } from './autotune';
import { cleanupActive, CleanupStream, type CleanupAnalysis, type CleanupSettings } from './cleanup';
import { GrainCache, type GrainVoice } from './grain-shape';
import { harmonyCorrections } from './harmony';
import { keyHarmonyCorrections, keyVoiceCount, type KeyEvent, type Voicing } from './keys';
import { applyNoteEdits, buildWarp, isNeutralEdit, segmentNotes, warpToSource, type NoteEdit } from './note-edit';
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
export function leadCorrections(
  frames: readonly PitchFrame[],
  tune: TuneSettings | null,
  semitones: number,
  monotone = false,
  edits: readonly NoteEdit[] = [],
): Correction[] {
  let lead: Correction[] = monotone
    ? monotoneCorrections(frames, tune?.scale ?? null)
    : tune
      ? correctTrack(frames, tune)
      : frames.map((f) => ({ target: null, corrected: f.midi }));
  // Note edits (Phase 18) act on the sung key's curve, before the transpose.
  lead = applyNoteEdits(frames, lead, edits);
  if (semitones) lead = lead.map((c) => (c.corrected === null ? c : { ...c, corrected: c.corrected + semitones }));
  return lead;
}

/** Keys played while the take was sung (Phase 19): they replace the interval harmony voices. */
export interface KeyHarmony {
  events: KeyEvent[];
  voicing: Voicing;
  /** Level of the key voices together (as the harmony mix). */
  mix: number;
}

/** Plans for a take with these settings; null = nothing to do (play the source as it is). */
export function planVoices(
  analysis: PsolaAnalysis,
  frames: readonly PitchFrame[],
  tune: TuneSettings | null,
  semitones: number,
  voice: VoiceCharacter = NEUTRAL_VOICE,
  edits: readonly NoteEdit[] = [],
  keys: KeyHarmony | null = null,
): VoicePlans | null {
  edits = edits.filter((e) => !isNeutralEdit(e));
  const keyVoices = keys ? keyVoiceCount(keys.events) : 0;
  if (!tune && !semitones && isNeutralVoice(voice) && !edits.length && !keyVoices) return null;
  const lead = leadCorrections(frames, tune, semitones, voice.monotone, edits);
  const warp = edits.some((e) => e.start !== undefined) ? buildWarp(segmentNotes(frames), edits, analysis.sampleRate, analysis.length) : null;
  if (keys && keyVoices) {
    // Play-the-keys: one voice per held key (voiced-only; silent where fewer keys are held).
    return {
      lead: planGrains(analysis, lead, true, grainVoice(voice, 0), warp),
      harmonies: Array.from({ length: keyVoices }, (_, k) =>
        planGrains(analysis, keyHarmonyCorrections(frames, lead, keys.events, keys.voicing, k), false, grainVoice(voice, k + 1), warp),
      ),
      harmonyGain: keys.mix / Math.sqrt(keyVoices),
    };
  }
  const voices = tune?.harmony?.voices ?? [];
  return {
    lead: planGrains(analysis, lead, true, grainVoice(voice, 0), warp),
    // Harmony voices sing the voiced parts only (no stacked breaths / "s" sounds).
    harmonies: voices.map((v, i) => planGrains(analysis, harmonyCorrections(lead, v, tune!.scale), false, grainVoice(voice, i + 1), warp)),
    // Equal-power-ish: more voices -> each a bit quieter, so the stack doesn't swamp the lead.
    harmonyGain: voices.length ? (tune!.harmony!.mix ?? 0.6) / Math.sqrt(voices.length) : 0,
  };
}

/**
 * Renders a take block by block: clean-up stream (Phase 15) -> lead + harmonies. Allocates nothing
 * while rendering (buffers are made when the source, plans or clean-up arrive).
 */
export class VoiceRenderer {
  private source: Float32Array = new Float32Array(0);
  private plans: VoicePlans | null = null;
  // Clean-up: the stream fills `cleaned` (a take-length copy) from just behind the playhead to a few
  // grains ahead; it restarts (with a short warm-up) when playback jumps (seek, loop wrap).
  private cleanupAnalysis: CleanupAnalysis | null = null;
  private stream: CleanupStream | null = null;
  private cleaned: Float32Array | null = null;
  private cleaning = false;
  private covStart = 0;
  private covValid = false;
  /** How far around a block grains read (plans' longest grain, formant reach included). */
  private margin = 0;
  /** Start of the cleaned range the last block needed. */
  private lastLo = 0;

  constructor(private readonly sampleRate = 48000) {}
  private readonly voice = new Float32Array(ENGINE_BLOCK);
  private readonly weight = new Float32Array(ENGINE_BLOCK);
  /** Shaped-grain caches, one per voice (made when a plan with a voice character arrives). */
  private caches: GrainCache[] = [];

  setSource(samples: Float32Array): void {
    this.source = samples;
    this.covValid = false;
    if (this.cleaned && this.cleaned.length !== samples.length) this.cleaned = this.cleaning ? new Float32Array(samples.length) : null;
    for (const c of this.caches) c.clear();
  }

  /**
   * Clean-up for this take: the analysis (null = none, e.g. not prepared yet) and the settings. Amount
   * changes apply from the next block; switching parts on or off restarts the stream there.
   */
  setCleanup(analysis: CleanupAnalysis | null, settings: CleanupSettings): void {
    if (analysis !== this.cleanupAnalysis) {
      this.cleanupAnalysis = analysis;
      this.stream = analysis ? new CleanupStream(this.sampleRate, analysis) : null;
      this.covValid = false;
    }
    if (this.stream?.setSettings(settings)) this.covValid = false;
    // Amounts changed in place: what's already cleaned behind the playhead is stale (a loop or seek
    // back recomputes it); the stream carries on ahead with the new amounts.
    else this.covStart = Math.max(this.covStart, this.lastLo);
    this.cleaning = !!analysis && cleanupActive(settings, analysis);
    if (this.cleaning && !this.cleaned) this.cleaned = new Float32Array(this.source.length);
    for (const c of this.caches) c.clear(); // shaped grains came from the old audio
  }

  /** Null = play the source unchanged. Plans must match the source's length. */
  setPlans(plans: VoicePlans | null): void {
    this.plans = plans && plans.lead.length === this.source.length ? plans : null;
    const voices = this.plans ? 1 + this.plans.harmonies.length : 0;
    while (this.caches.length < voices) this.caches.push(new GrainCache());
    let maxHalf = 0;
    let formant = 1;
    for (const p of this.plans ? [this.plans.lead, ...this.plans.harmonies] : []) {
      maxHalf = Math.max(maxHalf, p.maxHalf);
      formant = Math.max(formant, p.voice.formant);
    }
    this.margin = this.plans ? Math.ceil(maxHalf * (1 + formant)) + 16 : 0;
  }

  get length(): number {
    return this.source.length;
  }

  /** Makes sure the cleaned copy covers what rendering [a, b) reads; returns it. */
  private clean(a: number, b: number): Float32Array {
    const stream = this.stream!;
    const cleaned = this.cleaned!;
    const lo = Math.max(0, a - this.margin);
    const hi = Math.min(cleaned.length, b + this.margin);
    this.lastLo = lo;
    // A jump back, or far ahead (more than half a second): restart there rather than run through.
    if (!this.covValid || lo < this.covStart || lo > stream.ready + this.sampleRate / 2) {
      stream.startAt(lo);
      this.covStart = lo;
      this.covValid = true;
    }
    if (stream.ready < hi) stream.fill(this.source, cleaned, hi);
    return cleaned;
  }

  /**
   * Writes take samples [start, start + len) into out[offset ..]; positions outside the take are
   * silent. `len` must be at most ENGINE_BLOCK.
   */
  render(start: number, len: number, out: Float32Array, offset: number): void {
    out.fill(0, offset, offset + len);
    const a = Math.max(0, start);
    const b = Math.min(this.source.length, start + len);
    if (a >= b) return;
    // With note timing edits the grains read the source where the warp points.
    const warp = this.plans?.lead.warp;
    const src = !this.cleaning ? this.source : warp ? this.clean(Math.floor(warpToSource(warp, a)), Math.ceil(warpToSource(warp, b))) : this.clean(a, b);
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
