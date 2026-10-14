// Center-column heading: title cards in the style of Goal.mp4, take name in playback, recording timer.

import { headingCardOf, processedLabelOf, processSettingsOf, wantsProcessed } from '../../app/processing';
import { openMeta, openProject, selectedTrack, type AppStore } from '../../app/state';
import { $ } from '../dom';
import { formatTime } from '../format';

export function mountHeader(store: AppStore): void {
  const eyebrowEl = $('eyebrow');
  const titleEl = $('title');

  store.subscribe(render);
  render();

  function render(): void {
    const s = store.get();
    let { eyebrow, title, tone } = headingCardOf(s.tuning);
    const meta = openMeta(s);
    const song = openProject(s);
    if (s.mode === 'recording') {
      eyebrow = `● Recording ${formatTime(s.recordingSeconds)}${song ? ` · new track in ${song.name}` : ''}`;
    } else if (song) {
      const track = selectedTrack(s);
      const n = song.tracks.length;
      eyebrow = track ? `Editing · ${track.name}` : `Song · ${n} ${n === 1 ? 'track' : 'tracks'}`;
      title = song.name;
      tone = null;
    } else if (s.mode === 'playback' && meta) {
      eyebrow = processSettingsOf(s.tuning, s.cleanup)
        ? `Playback · ${wantsProcessed(s) ? processedLabelOf(s.tuning, s.cleanup) : 'Original'}`
        : 'Playback';
      title = meta.name;
      tone = null;
    }
    if (eyebrowEl.textContent !== eyebrow) eyebrowEl.textContent = eyebrow;
    if (titleEl.textContent !== title) titleEl.textContent = title;
    eyebrowEl.classList.toggle('is-recording', s.mode === 'recording');
    titleEl.classList.toggle('is-tuned', tone === 'tuned');
    titleEl.classList.toggle('is-scale', tone === 'scale');
    titleEl.classList.toggle('is-harmony', tone === 'harmony');
  }
}
