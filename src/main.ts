// App entry: creates the store, engine and panels, and wires shortcuts and the frame loop.

import { listenModeText } from './app/explain';
import { processSettingsOf, wantsProcessed } from './app/processing';
import { Session } from './app/session';
import { createAppStore } from './app/state';
import { setupPwa } from './pwa';
import { saveCleanup, saveExportFormat, saveInput, saveMetronome, saveTuning } from './storage/settings';
import { Captions } from './ui/captions';
import { $ } from './ui/dom';
import { mountCleanupPanel } from './ui/panels/cleanup-panel';
import { mountFxPanel } from './ui/panels/fx-panel';
import { mountTempoPanel } from './ui/panels/tempo-panel';
import { mountHeader } from './ui/panels/header';
import { mountImportPanel } from './ui/panels/import-panel';
import { mountInputPanel } from './ui/panels/input-panel';
import { mountLayout } from './ui/panels/layout';
import { mountLiveControls } from './ui/panels/live-controls';
import { mountOnboarding } from './ui/panels/onboarding';
import { mountReadout } from './ui/panels/readout';
import { mountRollHover } from './ui/panels/roll-hover';
import { watchSliders } from './ui/slider';
import { mountSongsPanel } from './ui/panels/songs-panel';
import { mountTakesPanel } from './ui/panels/takes-panel';
import { mountTracksPanel } from './ui/panels/tracks-panel';
import { mountTransport } from './ui/panels/transport';
import { mountTuningPanel } from './ui/panels/tuning-panel';
import { PianoRoll } from './ui/piano-roll';

// Neon sliders replace every range input, including the ones panels create later.
watchSliders(document.body);

const store = createAppStore();
const roll = new PianoRoll($<HTMLCanvasElement>('roll'));
const captions = new Captions($('caption'));
const session = new Session(store, roll);

mountLayout(store);
mountHeader(store);
mountLiveControls(store, session, captions);
mountInputPanel(store, session, captions);
mountSongsPanel(store, session);
mountTakesPanel(store, session);
const mixer = mountTracksPanel(store, session);
mountImportPanel(store, session, captions);
mountTuningPanel(store, captions);
mountCleanupPanel(store, captions);
mountFxPanel(store, session);
mountTempoPanel(store, session);
const transport = mountTransport(store, session, roll, captions);
const readout = mountReadout(store, roll, session.player);
mountOnboarding(store, captions);
mountRollHover(roll, $<HTMLCanvasElement>('roll'));

// Inspector settings changed: apply them (to the take, or the selected track of the open song),
// then persist the *global* defaults (a track's own settings are saved with its song).
store.watch(
  (s) => [s.tuning, s.cleanup] as const,
  () => {
    session.settingsChanged();
    const global = session.globalSettings();
    saveTuning(global.tuning);
    saveCleanup(global.cleanup);
  },
  { shallow: true },
);

store.watch(
  (s) => s.input,
  (input) => saveInput(input),
);
store.watch(
  (s) => s.input.monitor,
  () => session.syncMonitor(),
);
store.watch(
  (s) => s.exportFormat,
  (format) => saveExportFormat(format),
);
store.watch(
  (s) => s.metronome,
  (metronome) => {
    saveMetronome(metronome);
    session.syncMetronome();
  },
);

// Keyboard shortcuts: R record/stop, T auto-tune on/off, Space play/pause, A original/processed,
// L loop on/off, M click on/off, Q align the selected take to the beat (songs).
document.addEventListener('keydown', (e) => {
  if (e.target instanceof HTMLSelectElement) return;
  if (e.target instanceof HTMLInputElement && e.target.type !== 'range' && e.target.type !== 'checkbox') return;
  const s = store.get();
  if (e.code === 'Space' && s.mode === 'playback') {
    e.preventDefault();
    session.togglePlay();
  } else if ((e.ctrlKey || e.metaKey) && !e.altKey && s.projectId && (e.key === 'z' || e.key === 'Z' || e.key === 'y')) {
    // Undo / redo in the open song (text fields keep their own undo: handled by the early return above).
    e.preventDefault();
    if (e.key === 'y' || e.shiftKey) session.redo();
    else session.undo();
  } else if (e.ctrlKey || e.metaKey || e.altKey || e.repeat) {
    return;
  } else if (e.key === 'r') {
    $('record').click();
  } else if (e.key === 't') {
    $('tune-on').click();
  } else if (e.key === 'l' && s.projectId && s.mode === 'playback') {
    session.toggleLoop();
  } else if (e.key === 'm' && s.projectId) {
    store.set((st) => ({ metronome: { ...st.metronome, on: !st.metronome.on } }));
  } else if (e.key === 'q' && s.projectId && s.mode === 'playback' && s.selectedTrackId) {
    session.alignTrackToBeat(s.selectedTrackId);
  } else if (e.key === 'a' && s.mode === 'playback' && processSettingsOf(s.tuning, s.cleanup)) {
    session.setListenProcessed(!s.listenProcessed);
    const next = store.get();
    captions.show(listenModeText(wantsProcessed(next), next.tuning, next.cleanup));
  }
});

let lastFrame = 0;
function frame(t: number): void {
  const dt = lastFrame ? Math.min(0.1, (t - lastFrame) / 1000) : 0;
  lastFrame = t;
  const { mode, recordingSeconds } = store.get();
  if (mode === 'playback') {
    transport.tick();
  } else if (mode === 'recording') {
    const seconds = Math.floor(session.takeSeconds);
    if (seconds !== recordingSeconds) store.set({ recordingSeconds: seconds });
  }
  roll.render(t);
  readout.tick();
  mixer.tick(dt);
  requestAnimationFrame(frame);
}

// Dev builds only: a handle for poking at the engine from the console / automated checks.
if (import.meta.env.DEV) Object.assign(window, { recorder: { store, session } });

setupPwa($<HTMLButtonElement>('install'));
session.run(() => session.init());
requestAnimationFrame(frame);
