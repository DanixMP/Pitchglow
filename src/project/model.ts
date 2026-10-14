// Projects & tracks (Roadmap v2, Phase 8). Pure data + helpers, no DOM or Web Audio.
//
// A project is a song: one optional instrumental (Phase 9) plus any number of vocal tracks. Each
// vocal track points at a take in the library and carries its own mix and processing settings.

import type { Scale } from '../dsp/scales';
import type { SongFx, TrackFx } from './fx';
import { DEFAULT_TUNING, type CleanupPrefs, type TuningPrefs } from '../storage/settings';

export type TrackKind = 'vocal' | 'instrumental';

/** Per-track clean-up (the mic noise filter is an input setting, so it isn't per track). */
export type TrackCleanup = Pick<CleanupPrefs, 'denoise' | 'denoiseDb'>;

export interface Track {
  id: string;
  kind: TrackKind;
  name: string;
  /** Library take this vocal track plays (vocal tracks). */
  takeId: string | null;
  /** Imported audio file (instrumental tracks, Phase 9). */
  assetId: string | null;
  gainDb: number;
  /** -1 (left) .. 1 (right); used from Phase 10. */
  pan: number;
  mute: boolean;
  solo: boolean;
  /** Start position in the song, seconds. */
  offset: number;
  /** Pitch offset in semitones (Phase 11). */
  pitch: number;
  tuning: TuningPrefs;
  cleanup: TrackCleanup;
  /** Hue for the track's colour chip. */
  hue: number;
  /** Vocal chain + sends (Phase 11; missing = defaults). */
  fx?: TrackFx;
}

export interface Project {
  id: string;
  name: string;
  createdAt: number;
  updatedAt: number;
  tracks: Track[];
  /** Master transpose in semitones (Phase 11). */
  keyShift: number;
  masterGainDb: number;
  /** Master limiter (default on). */
  limiter?: boolean;
  /** Musical key (detected from the instrumental, or chosen); applied to new tracks' auto-tune. */
  key?: Scale | null;
  bpm?: number | null;
  /** Reverb/echo buses (Phase 11; missing = defaults). */
  fx?: SongFx;
  /** Loop region (Phase 12): set by dragging along the timeline ruler, toggled with Loop / L. */
  loop?: LoopRegion | null;
}

export interface LoopRegion {
  start: number;
  end: number;
  on: boolean;
}

/** Track colours: spread around the wheel, starting with the app's accent-ish yellow. */
const TRACK_HUES = [45, 200, 330, 150, 270, 15, 180, 100];

export function newId(): string {
  return crypto.randomUUID();
}

export function createProject(name: string, now = Date.now(), id = newId()): Project {
  return { id, name, createdAt: now, updatedAt: now, tracks: [], keyShift: 0, masterGainDb: 0 };
}

/** "Song 1", "Song 2", … skipping numbers already used. */
export function nextProjectName(projects: readonly Project[]): string {
  const used = projects.map((p) => /^Song (\d+)$/.exec(p.name)?.[1]).filter(Boolean).map(Number);
  return `Song ${Math.max(0, ...used) + 1}`;
}

export function createVocalTrack(
  take: { id: string; name: string },
  tuning: TuningPrefs,
  cleanup: TrackCleanup,
  existing: readonly Track[],
  id = newId(),
): Track {
  return {
    id,
    kind: 'vocal',
    name: take.name,
    takeId: take.id,
    assetId: null,
    gainDb: 0,
    pan: 0,
    mute: false,
    solo: false,
    offset: 0,
    pitch: 0,
    tuning: { ...tuning, harmony: [...tuning.harmony] },
    cleanup: { denoise: cleanup.denoise, denoiseDb: cleanup.denoiseDb },
    hue: TRACK_HUES[existing.length % TRACK_HUES.length],
  };
}

/** Neutral colour marker for instrumental tracks. */
export const INSTRUMENTAL_HUE = -1;

export function createInstrumentalTrack(asset: { id: string; name: string }, id = newId()): Track {
  const { tuning, cleanup } = defaultTrackSettings();
  return {
    id,
    kind: 'instrumental',
    name: asset.name,
    takeId: null,
    assetId: asset.id,
    gainDb: -3, // leave room for the vocal
    pan: 0,
    mute: false,
    solo: false,
    offset: 0,
    pitch: 0,
    tuning: { ...tuning, enabled: false },
    cleanup,
    hue: INSTRUMENTAL_HUE,
  };
}

export function instrumentalOf(p: Project): Track | null {
  return p.tracks.find((t) => t.kind === 'instrumental') ?? null;
}

/** Puts the instrumental first (replacing any previous one), keeping the vocals' order. */
export function withInstrumental(p: Project, track: Track, now = Date.now()): Project {
  return { ...p, updatedAt: now, tracks: [track, ...p.tracks.filter((t) => t.kind !== 'instrumental')] };
}

/** Sets the song key and switches every vocal track's auto-tune on, in that key. */
export function applyKey(p: Project, key: Scale, now = Date.now()): Project {
  return {
    ...p,
    key,
    updatedAt: now,
    tracks: p.tracks.map((t) =>
      t.kind === 'vocal' ? { ...t, tuning: { ...t.tuning, enabled: true, root: key.root, type: key.type } } : t,
    ),
  };
}

/** Song title from an imported file name: "my_beat-final (1).mp3" -> "my beat-final (1)". */
export function titleFromFileName(fileName: string): string {
  const base = fileName.replace(/\.[a-z0-9]{2,5}$/i, '').replace(/_+/g, ' ').trim();
  return base || 'Imported beat';
}

/** Defaults for a track created without explicit settings. */
export function defaultTrackSettings(): { tuning: TuningPrefs; cleanup: TrackCleanup } {
  return { tuning: { ...DEFAULT_TUNING, harmony: [] }, cleanup: { denoise: false, denoiseDb: 12 } };
}

export function duplicateProject(p: Project, name: string, now = Date.now(), id = newId()): Project {
  return {
    ...structuredClone(p),
    id,
    name,
    createdAt: now,
    updatedAt: now,
    tracks: p.tracks.map((t) => ({ ...structuredClone(t), id: newId() })),
  };
}

export function updateTrack(p: Project, trackId: string, patch: Partial<Track>, now = Date.now()): Project {
  return { ...p, updatedAt: now, tracks: p.tracks.map((t) => (t.id === trackId ? { ...t, ...patch } : t)) };
}

export function removeTrack(p: Project, trackId: string, now = Date.now()): Project {
  return { ...p, updatedAt: now, tracks: p.tracks.filter((t) => t.id !== trackId) };
}

export function addTrack(p: Project, track: Track, now = Date.now()): Project {
  return { ...p, updatedAt: now, tracks: [...p.tracks, track] };
}

export function projectsUsingTake(projects: readonly Project[], takeId: string): Project[] {
  return projects.filter((p) => p.tracks.some((t) => t.takeId === takeId));
}

/** Projects with every track that used `takeId` removed (only the ones that changed). */
export function withoutTake(projects: readonly Project[], takeId: string, now = Date.now()): Project[] {
  return projectsUsingTake(projects, takeId).map((p) => ({
    ...p,
    updatedAt: now,
    tracks: p.tracks.filter((t) => t.takeId !== takeId),
  }));
}

// --- mixing math ---------------------------------------------------------------------------

/** Semitones a track is heard transposed by: its own pitch offset plus the song's key shift. */
export function trackSemitones(t: Track, p: Project): number {
  return t.kind === 'vocal' ? t.pitch + p.keyShift : p.keyShift;
}

/** A scale moved by a number of semitones (the auto-tune scale follows the key shift). */
export function transposeScale(scale: Scale, semitones: number): Scale {
  return { ...scale, root: (((scale.root + semitones) % 12) + 12) % 12 };
}

export function masterOf(p: Project): { gain: number; limiter: boolean } {
  return { gain: dbToGain(p.masterGainDb), limiter: p.limiter !== false };
}

/**
 * Snaps a clip position: to 1/16 notes when the song has a tempo, otherwise to 10 ms. `free` (e.g.
 * Alt held while dragging) only rounds to the millisecond.
 */
export function snapOffset(offset: number, bpm: number | null | undefined, free = false): number {
  if (free) return Math.round(offset * 1000) / 1000 || 0;
  const grid = bpm ? 60 / bpm / 4 : 0.01;
  return Math.round(Math.round(offset / grid) * grid * 1000) / 1000 || 0; // `|| 0`: no -0
}

/** Pan as shown on a strip: "C", "L35", "R100". */
export function panLabel(pan: number): string {
  const v = Math.round(pan * 100);
  return v === 0 ? 'C' : v < 0 ? `L${-v}` : `R${v}`;
}

export function dbToGain(db: number): number {
  return db <= -60 ? 0 : Math.pow(10, db / 20);
}

/** Linear gain a track actually plays at, honouring mute and solo across the project. */
export function effectiveGain(track: Track, tracks: readonly Track[]): number {
  if (track.mute) return 0;
  if (tracks.some((t) => t.solo) && !track.solo) return 0;
  return dbToGain(track.gainDb);
}

/** Song length: the end of the latest track. */
export function projectDuration(tracks: readonly Track[], durationOf: (t: Track) => number): number {
  return tracks.reduce((max, t) => Math.max(max, t.offset + durationOf(t)), 0);
}

/**
 * How to start a track's source so it lines up with song position `songTime`:
 * wait `delay` seconds, then play from `from` seconds into the track. Null if it has already ended.
 */
export function scheduleTrack(songTime: number, offset: number, duration: number): { delay: number; from: number } | null {
  const local = songTime - offset;
  if (local >= duration) return null;
  return local < 0 ? { delay: -local, from: 0 } : { delay: 0, from: local };
}

// --- loop region (Phase 12) ----------------------------------------------------------------

/** Shortest loop the timeline accepts, seconds. */
export const MIN_LOOP_SECONDS = 0.25;

/**
 * Song position after `elapsed` seconds of playback that started at `from`. Inside a loop, playback
 * wraps from its end back to its start. A start at or after the loop's end plays straight on.
 */
export function loopPosition(from: number, elapsed: number, loop: { start: number; end: number } | null): number {
  const t = from + elapsed;
  if (!loop || from >= loop.end || t < loop.end) return t;
  const len = loop.end - loop.start;
  return loop.start + ((t - loop.end) % len);
}

/**
 * A loop from two points in either order: snapped to beats (with a tempo) or 0.1 s (`free`: 1 ms),
 * clamped to the song. Null when it would be shorter than MIN_LOOP_SECONDS.
 */
export function normalizeLoop(
  a: number,
  b: number,
  bpm: number | null | undefined,
  duration: number,
  free = false,
): { start: number; end: number } | null {
  const grid = free ? 0.001 : bpm ? 60 / bpm : 0.1;
  const snap = (t: number) => Math.round(Math.round(t / grid) * grid * 1000) / 1000 || 0;
  const start = Math.max(0, snap(Math.min(a, b)));
  const end = Math.min(duration, snap(Math.max(a, b)));
  return end - start >= MIN_LOOP_SECONDS ? { start, end } : null;
}

/** A first loop around the playhead: the bar it's in plus the next one (with a tempo), else 4 s. */
export function defaultLoop(time: number, bpm: number | null | undefined, duration: number): { start: number; end: number } | null {
  const len = bpm ? (60 / bpm) * 8 : 4;
  let start = bpm ? Math.floor(time / ((60 / bpm) * 4)) * ((60 / bpm) * 4) : Math.floor(time);
  if (start + len > duration) start = Math.max(0, duration - len);
  return normalizeLoop(start, start + len, bpm, duration, true);
}

/** The loop playback should follow (on, and still inside the song), or null. */
export function activeLoop(p: Project, duration: number): { start: number; end: number } | null {
  const loop = p.loop;
  if (!loop?.on) return null;
  const end = Math.min(loop.end, duration);
  return end - loop.start >= MIN_LOOP_SECONDS ? { start: loop.start, end } : null;
}
