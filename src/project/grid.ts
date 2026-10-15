// The song's tempo grid (Phase 17, pure): tempo, beats per bar and where bar 1 starts. Drives the
// metronome, the beat/bar lines on the roll and the timeline, clip and loop snapping, the count-in,
// tap tempo and "align a take to the beat".

import type { PitchFrame } from '../audio/pitch-tracker';

export interface Grid {
  bpm: number;
  beatsPerBar: number;
  /** Song time of a bar's first beat (normalised into [0, one bar)). */
  downbeat: number;
}

/** The fields of a song that make up its grid. */
export interface GridSource {
  bpm?: number | null;
  beatsPerBar?: number;
  downbeat?: number;
}

export const DEFAULT_BPM = 100;
export const MIN_BPM = 40;
export const MAX_BPM = 240;
export const DEFAULT_BEATS_PER_BAR = 4;
export const BEATS_PER_BAR_OPTIONS = [2, 3, 4, 5, 6, 7] as const;
/** Taps further apart than this start a new tap-tempo count. */
export const TAP_RESET_SECONDS = 2;
const TAP_MEMORY = 8;

/** The song's grid, or null when it has no tempo. */
export function gridOf(p: GridSource): Grid | null {
  if (!p.bpm) return null;
  return { bpm: p.bpm, beatsPerBar: p.beatsPerBar ?? DEFAULT_BEATS_PER_BAR, downbeat: p.downbeat ?? 0 };
}

/** The grid the metronome clicks to: the song's, or DEFAULT_BPM in 4 from 0 without a tempo. */
export function clickGridOf(p: GridSource | null): Grid {
  return (p && gridOf(p)) ?? { bpm: DEFAULT_BPM, beatsPerBar: DEFAULT_BEATS_PER_BAR, downbeat: 0 };
}

/** A grid from a bare tempo (older callers that only know the BPM), or the grid itself. */
export function asGrid(g: Grid | number | null | undefined): Grid | null {
  if (typeof g === 'number') return g > 0 ? { bpm: g, beatsPerBar: DEFAULT_BEATS_PER_BAR, downbeat: 0 } : null;
  return g ?? null;
}

export function beatSeconds(g: Grid): number {
  return 60 / g.bpm;
}

export function barSeconds(g: Grid): number {
  return (60 / g.bpm) * g.beatsPerBar;
}

export function clampBpm(bpm: number): number {
  return Math.round(Math.min(MAX_BPM, Math.max(MIN_BPM, bpm)) * 10) / 10;
}

/** Bar 1 at `t`, expressed as the first downbeat at or after 0 (so bar numbers stay small). */
export function normalizeDownbeat(t: number, g: Grid): number {
  const bar = barSeconds(g);
  const d = ((t % bar) + bar) % bar;
  const r = Math.round(d * 1000) / 1000;
  return r >= Math.round(bar * 1000) / 1000 ? 0 : r;
}

/** Rounds to the millisecond, without -0. */
const ms = (t: number) => Math.round(t * 1000) / 1000 || 0;

/**
 * Snaps `t` to the grid in steps of `beats` beats (1 = beat, 0.25 = 1/16), anchored at the
 * downbeat. Without a grid, to `fallback` seconds.
 */
export function snapToGrid(t: number, g: Grid | null, beats: number, fallback: number): number {
  if (!g) return ms(Math.round(t / fallback) * fallback);
  const step = beatSeconds(g) * beats;
  return ms(g.downbeat + Math.round((t - g.downbeat) / step) * step);
}

/** 1-based bar number at song time `t` (bar 1 starts at the downbeat; earlier bars are 0, -1…). */
export function barNumberAt(t: number, g: Grid): number {
  return Math.floor((t - g.downbeat) / barSeconds(g) + 1e-9) + 1;
}

/** One grid line: a beat's time, and its bar number when it is a bar's first beat. */
export interface GridLine {
  time: number;
  bar: number | null;
}

/**
 * Beat lines in [start, end]. When beats would be closer than `minBeatSeconds` apart only bar lines
 * are kept, and then only every 2nd/4th/… bar so lines stay at least that far apart.
 */
export function gridLines(start: number, end: number, g: Grid, minBeatSeconds = 0): GridLine[] {
  const beat = beatSeconds(g);
  const bar = barSeconds(g);
  const lines: GridLine[] = [];
  if (end <= start) return lines;
  if (beat >= minBeatSeconds) {
    const k0 = Math.ceil((start - g.downbeat) / beat - 1e-9);
    for (let k = k0; g.downbeat + k * beat <= end + 1e-9 && lines.length < 4000; k++) {
      const onBar = ((k % g.beatsPerBar) + g.beatsPerBar) % g.beatsPerBar === 0;
      lines.push({ time: g.downbeat + k * beat, bar: onBar ? Math.round(k / g.beatsPerBar) + 1 : null });
    }
    return lines;
  }
  let every = 1;
  while (bar * every < minBeatSeconds) every *= 2;
  const b0 = Math.ceil((start - g.downbeat) / (bar * every) - 1e-9) * every;
  for (let b = b0; g.downbeat + b * bar <= end + 1e-9 && lines.length < 4000; b += every) {
    lines.push({ time: g.downbeat + b * bar, bar: b + 1 });
  }
  return lines;
}

/**
 * Count-in before playing from `position`: clicks on the grid's beats during the bar before it.
 * Returns how long before `position` the first count-in beat is (between one bar minus one beat
 * and one bar, so the clicks stay on the beat even from a position between beats).
 */
export function countInLead(position: number, g: Grid): number {
  const beat = beatSeconds(g);
  const from = position - barSeconds(g);
  const k = Math.ceil((from - g.downbeat) / beat - 1e-9);
  return position - (g.downbeat + k * beat);
}

/**
 * Tap tempo: the BPM of the taps (seconds, oldest first) since the last pause longer than
 * TAP_RESET_SECONDS, from the last TAP_MEMORY taps. Null until two taps; clamped to the BPM range.
 */
export function tapTempo(taps: readonly number[]): number | null {
  let first = taps.length - 1;
  // Walk back while taps are close together, up to TAP_MEMORY of them.
  while (first > 0 && taps[first] - taps[first - 1] <= TAP_RESET_SECONDS && taps.length - first < TAP_MEMORY) first--;
  const recent = taps.slice(first);
  if (recent.length < 2) return null;
  const interval = (recent[recent.length - 1] - recent[0]) / (recent.length - 1);
  return interval > 0 ? Math.round(clampBpm(60 / interval)) : null;
}

/**
 * When the singing starts in a take: the first pitch frame at least 10% as loud as the take's
 * loud parts (95th percentile RMS), or its first voiced frame if that comes earlier. Null if silent.
 */
export function takeOnset(frames: readonly PitchFrame[]): number | null {
  if (frames.length === 0) return null;
  const levels = frames.map((f) => f.rms).sort((a, b) => a - b);
  const loud = levels[Math.min(levels.length - 1, Math.floor(levels.length * 0.95))];
  if (!(loud > 0)) return null;
  const threshold = loud * 0.1;
  for (const f of frames) if (f.rms >= threshold || f.midi !== null) return Math.max(0, f.time);
  return null;
}

/** A clip offset that puts the take's onset (seconds into the take) on the nearest beat. */
export function alignToBeat(offset: number, onset: number, g: Grid): number {
  const at = offset + onset;
  return ms(offset + (snapToGrid(at, g, 1, 0.01) - at));
}
