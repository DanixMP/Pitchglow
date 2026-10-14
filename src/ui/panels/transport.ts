// Playback transport: play/pause, seek, time, Original/processed A/B switch, processed export.

import { listenModeText } from '../../app/explain';
import { processedLabelOf, processSettingsOf, wantsProcessed } from '../../app/processing';
import type { Session } from '../../app/session';
import { openMeta, type AppStore } from '../../app/state';
import type { Captions } from '../captions';
import { $, $$ } from '../dom';
import { formatTime } from '../format';
import type { PianoRoll } from '../piano-roll';

export interface Transport {
  /** Per-frame update while a take is open. */
  tick(): void;
}

export function mountTransport(store: AppStore, session: Session, roll: PianoRoll, captions: Captions): Transport {
  const root = $('transport');
  const play = $<HTMLButtonElement>('play');
  const seek = $<HTMLInputElement>('seek');
  const timeCurrent = $('time-current');
  const timeTotal = $('time-total');
  const abButtons = $$<HTMLButtonElement>('.segmented .seg');
  const renderStatus = $('render-status');
  const exportBtn = $<HTMLButtonElement>('export-tuned');
  const exportLabel = exportBtn.querySelector('span')!;
  const player = session.player;

  play.addEventListener('click', () => session.togglePlay());
  seek.addEventListener('input', () => session.seek(Number(seek.value)));
  roll.onScrub = (t) => session.seek(t);
  for (const btn of abButtons) {
    btn.addEventListener('click', () => {
      session.setListenProcessed(btn.dataset.ab === 'tuned');
      const s = store.get();
      captions.show(listenModeText(wantsProcessed(s), s.tuning, s.cleanup));
    });
  }
  exportBtn.addEventListener('click', () => session.exportProcessed());

  store.watch(
    (s) => [s.mode, openMeta(s)?.duration ?? 0] as const,
    ([mode, duration]) => {
      root.hidden = mode !== 'playback';
      seek.max = String(duration);
      timeTotal.textContent = formatTime(duration);
    },
    { shallow: true },
  );

  store.watch(
    (s) => [s.tuning, s.cleanup, s.listenProcessed, s.render] as const,
    () => {
      const s = store.get();
      const available = processSettingsOf(s.tuning, s.cleanup) !== null;
      const label = processedLabelOf(s.tuning, s.cleanup);
      const processed = wantsProcessed(s);
      for (const btn of abButtons) {
        const isProcessed = btn.dataset.ab === 'tuned';
        const on = isProcessed === processed;
        btn.classList.toggle('is-on', on);
        btn.setAttribute('aria-checked', String(on));
        if (isProcessed) {
          btn.disabled = !available;
          btn.textContent = label;
        }
      }
      exportBtn.disabled = !(available && s.render.ready);
      exportLabel.textContent = `${label} WAV`;
      renderStatus.textContent = !available
        ? 'Auto-tune and noise reduction are off'
        : s.render.busy
          ? 'Processing…'
          : s.render.notes.join(' · ');
    },
    { shallow: true },
  );

  return {
    tick() {
      const time = player.currentTime;
      roll.setTime(time);
      seek.value = String(time);
      timeCurrent.textContent = formatTime(time);
      play.classList.toggle('is-playing', player.playing);
      play.setAttribute('aria-label', player.playing ? 'Pause' : 'Play');
    },
  };
}
