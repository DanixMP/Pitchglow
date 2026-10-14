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

// --- input / sync ---------------------------------------------------------------------------

export interface InputPrefs {
  /** One bar of clicks before recording over a song. */
  countIn: boolean;
  /** Manual timing correction for takes recorded over a song, ms (+ = later). */
  nudgeMs: number;
  /** Measured round-trip latency from loopback calibration, ms (null = use the browser's estimate). */
  calibratedMs: number | null;
  /** "Hear myself": monitor the processed voice live (headphones). */
  monitor: boolean;
}

export const DEFAULT_INPUT: InputPrefs = { countIn: true, nudgeMs: 0, calibratedMs: null, monitor: false };

const INPUT_KEY = 'recorder.input';

export function loadInput(): InputPrefs {
  try {
    const raw = JSON.parse(localStorage.getItem(INPUT_KEY) ?? 'null') as Partial<InputPrefs> | null;
    if (!raw) return { ...DEFAULT_INPUT };
    return {
      countIn: typeof raw.countIn === 'boolean' ? raw.countIn : DEFAULT_INPUT.countIn,
      nudgeMs: typeof raw.nudgeMs === 'number' && Math.abs(raw.nudgeMs) <= 300 ? raw.nudgeMs : 0,
      calibratedMs: typeof raw.calibratedMs === 'number' && raw.calibratedMs >= 0 && raw.calibratedMs < 1000 ? raw.calibratedMs : null,
      monitor: raw.monitor === true,
    };
  } catch {
    return { ...DEFAULT_INPUT };
  }
}

export function saveInput(prefs: InputPrefs): void {
  try {
    localStorage.setItem(INPUT_KEY, JSON.stringify(prefs));
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

// --- export format ----------------------------------------------------------------------------

const EXPORT_KEY = 'recorder.exportFormat';

export function loadExportFormat(): 'wav' | 'mp3' {
  try {
    return localStorage.getItem(EXPORT_KEY) === 'mp3' ? 'mp3' : 'wav';
  } catch {
    return 'wav';
  }
}

export function saveExportFormat(format: 'wav' | 'mp3'): void {
  try {
    localStorage.setItem(EXPORT_KEY, format);
  } catch {
    // Storage unavailable: the choice just won't persist.
  }
}
