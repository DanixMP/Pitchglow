// Application state shape. Heavy, non-serialisable things (audio buffers, nodes) live in Session.

import type { InputKind } from '../audio/audio-input';
import type { RecordingMeta } from '../storage/recording-store';
import { loadCleanup, loadTuning, type CleanupPrefs, type TuningPrefs } from '../storage/settings';
import { Store } from './store';

/** idle → listening/recording (live input) or playback (a saved recording is open). */
export type Mode = 'idle' | 'listening' | 'recording' | 'playback';

/** Phone layout: which panel the bottom tab bar shows under the roll (null = collapsed). */
export type MobileTab = 'takes' | 'controls' | null;

export interface AppState {
  mode: Mode;
  source: InputKind;
  tuning: TuningPrefs;
  cleanup: CleanupPrefs;
  /** Saved takes, newest first. */
  recordings: RecordingMeta[];
  /** The take open in playback, if any. */
  openId: string | null;
  /** A/B: listen to the processed render (when anything is switched on) or the original. */
  listenProcessed: boolean;
  /** Worker render of the open take. */
  render: { busy: boolean; ready: boolean; notes: string[] };
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
    tuning: loadTuning(),
    cleanup: loadCleanup(),
    recordings: [],
    openId: null,
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
