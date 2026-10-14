// Auto-tune preferences, remembered per browser in localStorage (falls back to defaults).

import { HARMONY_VOICES, type HarmonyVoice } from '../dsp/harmony';
import { SCALE_TYPES, type ScaleType } from '../dsp/scales';

export interface TuningPrefs {
  enabled: boolean;
  root: number;
  type: ScaleType;
  retuneMs: number;
  harmony: HarmonyVoice[];
  /** Harmony voice level, 0..1. */
  harmonyMix: number;
}

export const DEFAULT_TUNING: TuningPrefs = {
  enabled: true,
  root: 0,
  type: 'chromatic',
  retuneMs: 50,
  harmony: [],
  harmonyMix: 0.6,
};

const KEY = 'recorder.tuning';

export function loadTuning(): TuningPrefs {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) ?? 'null') as Partial<TuningPrefs> | null;
    if (!raw) return { ...DEFAULT_TUNING };
    return {
      enabled: typeof raw.enabled === 'boolean' ? raw.enabled : DEFAULT_TUNING.enabled,
      root: Number.isInteger(raw.root) && raw.root! >= 0 && raw.root! < 12 ? raw.root! : DEFAULT_TUNING.root,
      type: raw.type && raw.type in SCALE_TYPES ? raw.type : DEFAULT_TUNING.type,
      retuneMs:
        typeof raw.retuneMs === 'number' && raw.retuneMs >= 0 && raw.retuneMs <= 400 ? raw.retuneMs : DEFAULT_TUNING.retuneMs,
      harmony: Array.isArray(raw.harmony) ? raw.harmony.filter((v): v is HarmonyVoice => v in HARMONY_VOICES) : [],
      harmonyMix:
        typeof raw.harmonyMix === 'number' && raw.harmonyMix >= 0 && raw.harmonyMix <= 1 ? raw.harmonyMix : DEFAULT_TUNING.harmonyMix,
    };
  } catch {
    return { ...DEFAULT_TUNING };
  }
}

// --- clean-up -------------------------------------------------------------------------------

export interface CleanupPrefs {
  /** Offline spectral noise reduction on recordings. */
  denoise: boolean;
  /** Maximum noise attenuation in dB. */
  denoiseDb: number;
  /** Browser's live noise suppression on the mic. */
  micFilter: boolean;
}

export const DEFAULT_CLEANUP: CleanupPrefs = { denoise: false, denoiseDb: 12, micFilter: false };

const CLEANUP_KEY = 'recorder.cleanup';

export function loadCleanup(): CleanupPrefs {
  try {
    const raw = JSON.parse(localStorage.getItem(CLEANUP_KEY) ?? 'null') as Partial<CleanupPrefs> | null;
    if (!raw) return { ...DEFAULT_CLEANUP };
    return {
      denoise: typeof raw.denoise === 'boolean' ? raw.denoise : DEFAULT_CLEANUP.denoise,
      denoiseDb: typeof raw.denoiseDb === 'number' && raw.denoiseDb >= 3 && raw.denoiseDb <= 30 ? raw.denoiseDb : DEFAULT_CLEANUP.denoiseDb,
      micFilter: typeof raw.micFilter === 'boolean' ? raw.micFilter : DEFAULT_CLEANUP.micFilter,
    };
  } catch {
    return { ...DEFAULT_CLEANUP };
  }
}

export function saveCleanup(prefs: CleanupPrefs): void {
  try {
    localStorage.setItem(CLEANUP_KEY, JSON.stringify(prefs));
  } catch {
    // Storage unavailable: settings just won't persist.
  }
}

export function saveTuning(prefs: TuningPrefs): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(prefs));
  } catch {
    // Storage unavailable (private mode etc.): settings just won't persist.
  }
}
