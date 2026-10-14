// Application state shape. Heavy, non-serialisable things (audio buffers, nodes) live in Session.

import type { InputKind } from '../audio/audio-input';
import type { Scale } from '../dsp/scales';
import type { Project, Track } from '../project/model';
import type { RecordingMeta } from '../storage/recording-store';
import { loadCleanup, loadExportFormat, loadInput, loadTuning, type CleanupPrefs, type InputPrefs, type TuningPrefs } from '../storage/settings';
import { Store } from './store';

/** idle → listening/recording (live input) or playback (a take or a song is open). */
export type Mode = 'idle' | 'listening' | 'recording' | 'playback';

/** Phone layout: which panel the bottom tab bar shows under the roll (null = collapsed). */
export type MobileTab = 'takes' | 'controls' | null;

export interface RenderState {
  busy: boolean;
  ready: boolean;
  notes: string[];
}

/** Key/tempo found in a freshly imported instrumental, waiting for the user to accept. */
export interface Detection {
  projectId: string;
  key: Scale | null;
  bpm: number | null;
}

export interface AppState {
  mode: Mode;
  source: InputKind;
  /** Count-in, sync nudge, calibration. */
  input: InputPrefs;
  /** File format for exports (takes, processed takes, mixes); stems are always WAV. */
  exportFormat: 'wav' | 'mp3';
  /** An instrumental is being imported/decoded. */
  importing: boolean;
  detection: Detection | null;
  /** Loopback latency calibration in progress. */
  calibrating: boolean;
  /** Undo/redo availability for the open song. */
  history: { canUndo: boolean; canRedo: boolean };
  /**
   * The settings the inspector edits: the global defaults, or the selected track's settings while a
   * song is open (Session loads them in and writes edits back to the track).
   */
  tuning: TuningPrefs;
  cleanup: CleanupPrefs;
  /** Saved takes, newest first. */
  recordings: RecordingMeta[];
  /** The take open for preview (no song open), if any. */
  openId: string | null;
  /** Songs, most recently edited first. */
  projects: Project[];
  /** The song open in the studio, if any. */
  projectId: string | null;
  selectedTrackId: string | null;
  /** Worker renders per track of the open song. */
  trackRender: Record<string, RenderState>;
  /** Length of whatever is open (take or song), seconds. */
  duration: number;
  /** A/B: listen to the processed render (when anything is switched on) or the original. */
  listenProcessed: boolean;
  /** Worker render of the open take (preview mode). */
  render: RenderState;
  /** Seconds captured so far while recording. */
  recordingSeconds: number;
  /** Error / info line under the controls. */
  status: string;
  mobileTab: MobileTab;
  /** Tablet layout: takes drawer open. */
  takesDrawerOpen: boolean;
}

export type AppStore = Store<AppState>;

export function createAppStore(): AppStore {
  return new Store<AppState>({
    mode: 'idle',
    source: 'mic',
    input: loadInput(),
    exportFormat: loadExportFormat(),
    importing: false,
    detection: null,
    calibrating: false,
    history: { canUndo: false, canRedo: false },
    tuning: loadTuning(),
    cleanup: loadCleanup(),
    recordings: [],
    openId: null,
    projects: [],
    projectId: null,
    selectedTrackId: null,
    trackRender: {},
    duration: 0,
    listenProcessed: true,
    render: { busy: false, ready: false, notes: [] },
    recordingSeconds: 0,
    status: '',
    mobileTab: null,
    takesDrawerOpen: false,
  });
}

export function openMeta(state: AppState): RecordingMeta | null {
  return state.recordings.find((r) => r.id === state.openId) ?? null;
}

export function openProject(state: AppState): Project | null {
  return state.projects.find((p) => p.id === state.projectId) ?? null;
}

export function selectedTrack(state: AppState): Track | null {
  return openProject(state)?.tracks.find((t) => t.id === state.selectedTrackId) ?? null;
}
