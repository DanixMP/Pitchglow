// App entry: creates the store, engine and panels, and wires shortcuts and the frame loop.

import { listenModeText } from './app/explain';
import { processSettingsOf, wantsProcessed } from './app/processing';
import { Session } from './app/session';
import { createAppStore } from './app/state';
import { setupPwa } from './pwa';
import { saveCleanup, saveTuning } from './storage/settings';
import { Captions } from './ui/captions';
import { $ } from './ui/dom';
import { mountCleanupPanel } from './ui/panels/cleanup-panel';
import { mountHeader } from './ui/panels/header';
import { mountInputPanel } from './ui/panels/input-panel';
import { mountLayout } from './ui/panels/layout';
import { mountLiveControls } from './ui/panels/live-controls';
import { mountReadout } from './ui/panels/readout';
import { mountSongsPanel } from './ui/panels/songs-panel';
import { mountTakesPanel } from './ui/panels/takes-panel';
import { mountTracksPanel } from './ui/panels/tracks-panel';
import { mountTransport } from './ui/panels/transport';
import { mountTuningPanel } from './ui/panels/tuning-panel';
import { PianoRoll } from './ui/piano-roll';

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
mountTracksPanel(store, session);
mountTuningPanel(store, captions);
mountCleanupPanel(store, captions);
const transport = mountTransport(store, session, roll, captions);
const readout = mountReadout(store, roll, session.player);

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

// Keyboard shortcuts: R record/stop, T auto-tune on/off, Space play/pause, A original/processed.
document.addEventListener('keydown', (e) => {
  if (e.target instanceof HTMLSelectElement) return;
  if (e.target instanceof HTMLInputElement && e.target.type !== 'range' && e.target.type !== 'checkbox') return;
  const s = store.get();
  if (e.code === 'Space' && s.mode === 'playback') {
    e.preventDefault();
    session.togglePlay();
  } else if (e.ctrlKey || e.metaKey || e.altKey || e.repeat) {
    return;
  } else if (e.key === 'r') {
    $('record').click();
  } else if (e.key === 't') {
    $('tune-on').click();
  } else if (e.key === 'a' && s.mode === 'playback' && processSettingsOf(s.tuning, s.cleanup)) {
    session.setListenProcessed(!s.listenProcessed);
    const next = store.get();
    captions.show(listenModeText(wantsProcessed(next), next.tuning, next.cleanup));
  }
});

function frame(t: number): void {
  const { mode, recordingSeconds } = store.get();
  if (mode === 'playback') {
    transport.tick();
  } else if (mode === 'recording') {
    const seconds = Math.floor(session.takeSeconds);
    if (seconds !== recordingSeconds) store.set({ recordingSeconds: seconds });
  }
  roll.render(t);
  readout.tick();
  requestAnimationFrame(frame);
}

setupPwa($<HTMLButtonElement>('install'));
session.run(() => session.init());
requestAnimationFrame(frame);
