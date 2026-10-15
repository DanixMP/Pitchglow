// Pure helpers that turn user prefs into processing settings, labels and title cards.

import type { TuneSettings } from '../dsp/autotune';
import type { ProcessSettings } from '../dsp/process';
import { trackFxOf } from '../project/fx';
import { isNeutralVoice, trackVoiceOf } from '../project/voice';
import { trackSemitones, type Project, type Track } from '../project/model';
import { scaleName } from '../dsp/scales';
import type { CleanupPrefs, TuningPrefs } from '../storage/settings';
import type { AppState } from './state';

export function tuneSettingsOf(tuning: TuningPrefs): TuneSettings | null {
  if (!tuning.enabled) return null;
  const settings: TuneSettings = { scale: { root: tuning.root, type: tuning.type }, retuneMs: tuning.retuneMs };
  if (tuning.harmony.length) settings.harmony = { voices: [...tuning.harmony], mix: tuning.harmonyMix };
  return settings;
}

/** What the worker should do to the open recording, or null when nothing is switched on. */
export function processSettingsOf(tuning: TuningPrefs, cleanup: CleanupPrefs): ProcessSettings | null {
  const tune = tuneSettingsOf(tuning);
  const denoise = cleanup.denoise ? { amountDb: cleanup.denoiseDb } : null;
  return tune || denoise ? { tune, denoise } : null;
}

/**
 * What the worker renders for a song's vocal track: clean-up, auto-tune/harmony, transpose (track
 * pitch + key shift) and the offline vocal-chain parts (gate, de-esser). Null = play the take as is.
 */
export function trackProcessSettings(track: Track, project: Project): ProcessSettings | null {
  if (track.kind !== 'vocal') return null;
  const base = processSettingsOf(track.tuning, { ...track.cleanup, micFilter: false });
  const fx = trackFxOf(track);
  const pitch = trackSemitones(track, project);
  const voice = trackVoiceOf(track);
  const neutral = isNeutralVoice(voice);
  const notes = track.noteEdits ?? [];
  const keys = track.keys?.events.length ? { events: track.keys.events, voicing: track.keys.voicing, mix: track.tuning.harmonyMix } : null;
  if (!base && !pitch && !fx.gate && !fx.deess && neutral && !notes.length && !keys) return null;
  return {
    ...(notes.length ? { notes } : {}),
    ...(keys ? { keys } : {}),
    tune: base?.tune ?? null,
    denoise: base?.denoise ?? null,
    pitch,
    gate: fx.gate,
    deess: fx.deess,
    ...(neutral ? {} : { voice: { formant: voice.formant, whisper: voice.whisper, monotone: voice.monotone } }),
  };
}

/** Name for the processed version, used on the A/B switch, heading and export. */
export function processedLabelOf(tuning: TuningPrefs, cleanup: CleanupPrefs): string {
  if (tuning.enabled && cleanup.denoise) return 'Clean + tuned';
  if (cleanup.denoise) return 'Cleaned';
  return 'Tuned';
}

export function wantsProcessed(state: AppState): boolean {
  return state.listenProcessed && processSettingsOf(state.tuning, state.cleanup) !== null;
}

export type TitleTone = 'tuned' | 'scale' | 'harmony' | null;

/** Title card for the current tuning, in the style of Goal.mp4's headings. */
export function headingCardOf(tuning: TuningPrefs): { eyebrow: string; title: string; tone: TitleTone } {
  if (!tuning.enabled) return { eyebrow: 'Live pitch', title: 'My voice', tone: null };
  if (tuning.harmony.length) return { eyebrow: 'One voice, many notes', title: 'A harmonizer', tone: 'harmony' };
  if (tuning.type !== 'chromatic') return { eyebrow: 'Only', title: scaleName({ root: tuning.root, type: tuning.type }), tone: 'scale' };
  return { eyebrow: 'Nearest note', title: 'On auto-tune', tone: 'tuned' };
}
