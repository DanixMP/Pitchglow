// Auto-tune preferences, remembered per browser in localStorage (falls back to defaults).

import { SCALE_TYPES, type ScaleType } from '../dsp/scales';

export interface TuningPrefs {
  enabled: boolean;
  root: number;
  type: ScaleType;
  retuneMs: number;
}

export const DEFAULT_TUNING: TuningPrefs = { enabled: true, root: 0, type: 'chromatic', retuneMs: 50 };

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
    };
  } catch {
    return { ...DEFAULT_TUNING };
  }
}

export function saveTuning(prefs: TuningPrefs): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(prefs));
  } catch {
    // Storage unavailable (private mode etc.): settings just won't persist.
  }
}
