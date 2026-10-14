// Effects settings (Phase 11): per-track vocal chain + sends, per-song reverb/echo buses, presets.
// Pure data + helpers; the audio side is in audio/chain.ts (live + export) and dsp/ (offline parts).

import type { ReverbPreset } from '../dsp/reverb';

export interface Eq {
  /** dB, low shelf 200 Hz. */
  low: number;
  /** dB, peak 2.5 kHz. */
  mid: number;
  /** dB, high shelf 8 kHz. */
  high: number;
}

export interface TrackFx {
  /** Preset the values came from (null = custom). */
  preset: FxPresetId | null;
  /** High-pass cutoff, Hz (0 = off). Live. */
  highpassHz: number;
  /** Compressor amount 0..1. Live. */
  compressor: number;
  eq: Eq;
  /** Noise gate amount 0..1. Offline (worker). */
  gate: number;
  /** De-esser amount 0..1. Offline (worker). */
  deess: number;
  /** Send levels to the song's buses, 0..1. Live. */
  reverbSend: number;
  echoSend: number;
}

export type EchoDivision = '1/4' | '1/8' | '1/8d' | '1/16';

export interface SongFx {
  reverb: { preset: ReverbPreset; level: number; tone: number };
  echo: { division: EchoDivision; feedback: number; tone: number; level: number };
}

export const DEFAULT_TRACK_FX: TrackFx = {
  preset: null,
  highpassHz: 0,
  compressor: 0,
  eq: { low: 0, mid: 0, high: 0 },
  gate: 0,
  deess: 0,
  reverbSend: 0,
  echoSend: 0,
};

export const DEFAULT_SONG_FX: SongFx = {
  reverb: { preset: 'hall', level: 0.8, tone: 0.5 },
  echo: { division: '1/8d', feedback: 0.35, tone: 0.5, level: 0.7 },
};

export type FxPresetId = 'cleanPop' | 'radio' | 'dreamy' | 'robot';

export const FX_PRESETS: Record<FxPresetId, { label: string; fx: Omit<TrackFx, 'preset'>; robot?: boolean }> = {
  cleanPop: {
    label: 'Clean pop',
    fx: { highpassHz: 100, compressor: 0.5, eq: { low: -1, mid: 1, high: 3 }, gate: 0.3, deess: 0.5, reverbSend: 0.18, echoSend: 0 },
  },
  radio: {
    label: 'Radio',
    fx: { highpassHz: 400, compressor: 0.8, eq: { low: -10, mid: 6, high: -8 }, gate: 0.4, deess: 0.3, reverbSend: 0, echoSend: 0 },
  },
  dreamy: {
    label: 'Dreamy',
    fx: { highpassHz: 120, compressor: 0.4, eq: { low: -2, mid: 0, high: 4 }, gate: 0.2, deess: 0.6, reverbSend: 0.5, echoSend: 0.3 },
  },
  robot: {
    label: 'Robot',
    // Plus hard auto-tune (0 ms retune), applied to the track's tuning by the session.
    fx: { highpassHz: 100, compressor: 0.6, eq: { low: 0, mid: 2, high: 2 }, gate: 0.5, deess: 0.4, reverbSend: 0.1, echoSend: 0 },
    robot: true,
  },
};

export function trackFxOf(t: { fx?: TrackFx }): TrackFx {
  return t.fx ?? DEFAULT_TRACK_FX;
}

export function songFxOf(p: { fx?: SongFx }): SongFx {
  return p.fx ?? DEFAULT_SONG_FX;
}

/** Applies a preset; any later manual edit turns `preset` back to null ("Custom"). */
export function withPreset(id: FxPresetId): TrackFx {
  return { ...FX_PRESETS[id].fx, eq: { ...FX_PRESETS[id].fx.eq }, preset: id };
}

/** Echo delay time in seconds for a note division at a tempo (default 100 BPM). */
export function echoSeconds(division: EchoDivision, bpm: number | null | undefined): number {
  const beat = 60 / (bpm || 100);
  const factor = { '1/4': 1, '1/8': 0.5, '1/8d': 0.75, '1/16': 0.25 }[division];
  return Math.min(2, beat * factor);
}

/** The parts rendered offline in the worker (a change re-renders the track). */
export function offlineFx(fx: TrackFx): { gate: number; deess: number } {
  return { gate: fx.gate, deess: fx.deess };
}
