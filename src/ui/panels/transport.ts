// Playback transport: play/pause, seek, time, Original/processed A/B switch, processed export.

import { listenModeText } from '../../app/explain';
import { processedLabelOf, processSettingsOf, wantsProcessed } from '../../app/processing';
import type { Session } from '../../app/session';
import { openProject, type AppState, type AppStore } from '../../app/state';
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
  const stemsBtn = $<HTMLButtonElement>('export-stems');
  stemsBtn.addEventListener('click', () => session.exportStems());
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
    (s) => [s.mode, s.duration] as const,
    ([mode, duration]) => {
      root.hidden = mode !== 'playback' || duration <= 0;
      seek.max = String(duration);
      timeTotal.textContent = formatTime(duration);
    },
    { shallow: true },
  );

  store.watch(
    (s) => [s.tuning, s.cleanup, s.listenProcessed, s.render, s.projectId, s.trackRender, s.duration] as const,
    () => {
      const v = viewOf(store.get());
      for (const btn of abButtons) {
        const isProcessed = btn.dataset.ab === 'tuned';
        const on = isProcessed === v.processedOn;
        btn.classList.toggle('is-on', on);
        btn.setAttribute('aria-checked', String(on));
        if (isProcessed) {
          btn.disabled = !v.available;
          btn.textContent = v.label;
        }
      }
      exportBtn.disabled = !v.exportEnabled;
      exportLabel.textContent = v.exportLabel;
      const song = openProject(store.get());
      stemsBtn.hidden = !song;
      stemsBtn.disabled = !v.exportEnabled;
      renderStatus.textContent = v.status;
    },
    { shallow: true },
  );

  /** What the A/B switch, export button and status show, for a take or a whole song. */
  function viewOf(s: AppState) {
    const song = openProject(s);
    if (song) {
      const available = song.tracks.some((t) => processSettingsOf(t.tuning, { ...t.cleanup, micFilter: false }) !== null);
      const busy = song.tracks.some((t) => s.trackRender[t.id]?.busy);
      const notes = [...new Set(song.tracks.flatMap((t) => s.trackRender[t.id]?.notes ?? []))];
      return {
        available,
        processedOn: s.listenProcessed && available,
        label: 'Processed',
        exportEnabled: s.duration > 0,
        exportLabel: 'Mix WAV',
        status: busy ? 'Processing…' : notes.join(' · '),
      };
    }
    const available = processSettingsOf(s.tuning, s.cleanup) !== null;
    const label = processedLabelOf(s.tuning, s.cleanup);
    return {
      available,
      processedOn: wantsProcessed(s),
      label,
      exportEnabled: available && s.render.ready,
      exportLabel: `${label} WAV`,
      status: !available ? 'Auto-tune and noise reduction are off' : s.render.busy ? 'Processing…' : s.render.notes.join(' · '),
    };
  }

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
