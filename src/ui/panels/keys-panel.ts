// Play-the-keys harmony (Phase 19): the Harmony section's Intervals | Keys switch and the keys
// controls (voicing, latch, MIDI status, held notes), and the roll's playable keyboard.

import type { Session } from '../../app/session';
import { openProject, selectedTrack, type AppStore } from '../../app/state';
import type { Voicing } from '../../dsp/keys';
import { noteName } from '../../dsp/notes';
import { $, $$ } from '../dom';
import type { PianoRoll } from '../piano-roll';

export function mountKeysPanel(store: AppStore, session: Session, roll: PianoRoll): void {
  const modeButtons = $$<HTMLButtonElement>('.seg[data-harmony-mode]');
  const voicingButtons = $$<HTMLButtonElement>('.seg[data-voicing]');
  const controls = $('keys-controls');
  const latch = $<HTMLInputElement>('keys-latch');
  const status = $('keys-status');
  const release = $<HTMLButtonElement>('keys-release');
  const clear = $<HTMLButtonElement>('keys-clear');

  roll.onKeyPress = (midi, down) => session.keyPress(midi, down, 'screen');
  for (const b of modeButtons) b.addEventListener('click', () => session.setKeysOn(b.dataset.harmonyMode === 'keys'));
  for (const b of voicingButtons) {
    b.addEventListener('click', () => {
      const voicing = b.dataset.voicing as Voicing;
      session.setKeysPrefs({ voicing });
      // The selected track's recorded keys follow the voicing too.
      const track = selectedTrack(store.get());
      if (track?.keys) session.setTrackKeysVoicing(track.id, voicing);
    });
  }
  latch.addEventListener('change', () => session.setKeysPrefs({ latch: latch.checked }));
  release.addEventListener('click', () => session.releaseAllKeys());
  clear.addEventListener('click', () => {
    const track = selectedTrack(store.get());
    if (track) session.clearTrackKeys(track.id);
  });

  store.watch(
    (s) => [s.keys, s.heldKeys, s.midi, openProject(s), s.selectedTrackId] as const,
    ([keys, held, midi]) => {
      for (const b of modeButtons) {
        const on = (b.dataset.harmonyMode === 'keys') === keys.on;
        b.classList.toggle('is-on', on);
        b.setAttribute('aria-checked', String(on));
      }
      controls.hidden = !keys.on;
      for (const b of voicingButtons) {
        const on = b.dataset.voicing === keys.voicing;
        b.classList.toggle('is-on', on);
        b.setAttribute('aria-checked', String(on));
      }
      latch.checked = keys.latch;
      const device =
        midi.status === 'unsupported'
          ? 'No MIDI in this browser (try Chrome or Edge)'
          : midi.status === 'denied'
            ? 'MIDI access was refused'
            : midi.devices.length
              ? `MIDI: ${midi.devices.join(', ')}`
              : 'No MIDI keyboard connected';
      status.innerHTML = '';
      const heldText = document.createElement('b');
      heldText.textContent = held.length ? held.map(noteName).join(' ') : 'no keys held';
      status.append(heldText, document.createTextNode(` · ${device}`));
      release.disabled = !held.length;
      const track = selectedTrack(store.get());
      const recorded = track?.keys?.events.length ?? 0;
      clear.hidden = !recorded;
      clear.textContent = `Remove the track's keys (${recorded} change${recorded === 1 ? '' : 's'})`;
    },
    { shallow: true },
  );
}
