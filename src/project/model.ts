// Projects & tracks (Roadmap v2, Phase 8). Pure data + helpers, no DOM or Web Audio.
//
// A project is a song: one optional instrumental (Phase 9) plus any number of vocal tracks. Each
// vocal track points at a take in the library and carries its own mix and processing settings.

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
