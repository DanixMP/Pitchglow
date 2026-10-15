// Processing chain for a recording (Phases 13-15). Everything that depends on the settings runs in
// real time in the voice engine; only settings-independent analysis happens up front.
// - prepareVoice (worker, once per take): resample to the playback rate, PSOLA analysis (marks),
//   clean-up analysis (noise profile, gate map).
// - the voice engine, live: clean-up stream (noise reduction -> gate -> de-esser, cleanup.ts), then
//   auto-tune / harmony / transpose / voice character (voice-engine.ts) on the cleaned audio.
// processRecording runs the same steps over a whole take; it is the reference the engine is tested
// against.

import type { PitchFrame } from '../audio/pitch-tracker';
import type { TuneSettings } from './autotune';
import { analyzeCleanup, cleanupTake, type CleanupAnalysis, type CleanupSettings } from './cleanup';
import type { DenoiseSettings } from './denoise';
import type { NoteEdit } from './note-edit';
import { renderPlans } from './harmony';
import { analyzePsola, type PsolaAnalysis } from './psola';
import { planVoices, type VoiceCharacter } from './voice-engine';
import { resample } from './vocoder';

export interface ProcessSettings {
  denoise: DenoiseSettings | null;
  tune: TuneSettings | null;
  /** Transpose (track pitch + song key shift), semitones. */
  pitch?: number;
  /** Noise gate amount 0..1. */
  gate?: number;
  /** Voice character: formant, whisper, robot (Phase 15). */
  voice?: VoiceCharacter;
  /** De-esser amount 0..1. */
  deess?: number;
  /** Note edits (Phase 18): pitch, correction amount and timing per sung note. */
  notes?: NoteEdit[];
}

export interface ProcessResult {
  output: Float32Array;
  /** Human-readable notes about what couldn't be done (shown under the transport). */
  notes: string[];
}

/** The clean-up part of the settings, as the clean-up stream takes it. */
export function cleanupSettingsOf(s: Pick<ProcessSettings, 'denoise' | 'gate' | 'deess'>): CleanupSettings {
  return { denoiseDb: s.denoise?.amountDb ?? 0, gate: s.gate ?? 0, deess: s.deess ?? 0 };
}

/** What couldn't be done with these settings (shown under the transport). */
export function cleanupNotes(s: Pick<ProcessSettings, 'denoise'>, analysis: CleanupAnalysis): string[] {
  return s.denoise && s.denoise.amountDb > 0 && !analysis.noise ? ['Too short to learn the noise'] : [];
}

/** A take ready for the voice engine: its audio at the playback rate plus the settings-free analysis. */
export interface PreparedVoice {
  source: Float32Array;
  analysis: PsolaAnalysis;
  cleanup: CleanupAnalysis;
}

/** Once per take: resample to `targetRate` if needed, then analyse (PSOLA marks, noise profile, gate map). */
export function prepareVoice(samples: Float32Array, sampleRate: number, targetRate: number, frames: readonly PitchFrame[]): PreparedVoice {
  const source = targetRate === sampleRate ? samples : resample(samples, sampleRate / targetRate, Math.floor((samples.length * targetRate) / sampleRate));
  return { source, analysis: analyzePsola(source, targetRate, frames), cleanup: analyzeCleanup(source, targetRate, frames) };
}

export function processRecording(samples: Float32Array, sampleRate: number, frames: readonly PitchFrame[], settings: ProcessSettings): ProcessResult {
  const prepared = prepareVoice(samples, sampleRate, sampleRate, frames);
  const clean = cleanupTake(prepared.source, sampleRate, prepared.cleanup, cleanupSettingsOf(settings));
  // The pitch track and marks (from the original) still describe the cleaned audio: same timing.
  const plans = planVoices(prepared.analysis, frames, settings.tune, settings.pitch ?? 0, settings.voice, settings.notes);
  return { output: plans ? renderPlans(clean, plans, sampleRate) : clean, notes: cleanupNotes(settings, prepared.cleanup) };
}
