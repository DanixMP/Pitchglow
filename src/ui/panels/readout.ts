// Note readout under the roll: the note under the playhead and how far off it is.

import type { AppStore } from '../../app/state';
import type { Player } from '../../audio/player';
import { nearestNote, noteName } from '../../dsp/notes';
import { $ } from '../dom';
import type { PianoRoll } from '../piano-roll';

export function mountReadout(store: AppStore, roll: PianoRoll, player: Player): { tick(): void } {
  const noteEl = $('note');
  const detailEl = $('detail');

  const set = (el: HTMLElement, text: string) => {
    if (el.textContent !== text) el.textContent = text;
  };

  return {
    tick() {
      const { mode } = store.get();
      const frame = mode === 'idle' ? null : roll.currentFrame();
      if (frame?.midi != null && frame.freq != null) {
        // Tuned: show the note it snaps to and how far off the singing was; otherwise the nearest note.
        const { note, cents } =
          frame.target !== null ? { note: frame.target, cents: (frame.midi - frame.target) * 100 } : nearestNote(frame.midi);
        const c = Math.round(cents);
        set(noteEl, noteName(note));
        set(detailEl, `${frame.freq.toFixed(1)} Hz · ${c >= 0 ? '+' : '−'}${Math.abs(c)}¢${frame.target !== null ? ' off' : ''}`);
      } else {
        set(noteEl, '–');
        set(
          detailEl,
          mode === 'idle'
            ? 'Press Listen or Record and say something'
            : mode === 'playback'
              ? player.playing
                ? '…'
                : 'Press play, or drag the lanes to scrub'
              : 'Listening…',
        );
      }
    },
  };
}
