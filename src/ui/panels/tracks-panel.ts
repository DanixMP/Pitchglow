// Center column (song open): the track list — select, rename, mute/solo, volume, remove — and a drop
// zone for takes dragged from the library. Rows are keyed and updated in place, so a fader being
// dragged is never replaced under the pointer.

import type { Session } from '../../app/session';
import { openProject, type AppStore } from '../../app/state';
import type { Track } from '../../project/model';
import { $ } from '../dom';
import { iconButton, nameInput, TAKE_DRAG_TYPE } from '../icons';

const FADER_MIN = -40;
const FADER_MAX = 6;

interface Row {
  li: HTMLLIElement;
  name: HTMLInputElement;
  mute: HTMLButtonElement;
  solo: HTMLButtonElement;
  fader: HTMLInputElement;
  db: HTMLSpanElement;
  busy: HTMLSpanElement;
  /** Last name rendered (the input keeps its own value while being edited). */
  shownName: string;
}

export function mountTracksPanel(store: AppStore, session: Session): void {
  const section = $('tracks');
  const list = $('track-list');
  const empty = $('tracks-empty');
  const rows = new Map<string, Row>();

  $('song-close').addEventListener('click', () => session.closeProject());

  // Drop takes from the library onto the tracks.
  section.addEventListener('dragover', (e) => {
    if (!e.dataTransfer?.types.includes(TAKE_DRAG_TYPE)) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';
    section.classList.add('is-drop-target');
  });
  section.addEventListener('dragleave', (e) => {
    if (!section.contains(e.relatedTarget as Node)) section.classList.remove('is-drop-target');
  });
  section.addEventListener('drop', (e) => {
    section.classList.remove('is-drop-target');
    const id = e.dataTransfer?.getData(TAKE_DRAG_TYPE);
    if (!id) return;
    e.preventDefault();
    session.addTakeToProject(id);
  });

  function createRow(track: Track): Row {
    const li = document.createElement('li');
    const instrumental = track.kind === 'instrumental';
    li.className = 'track' + (instrumental ? ' is-instrumental' : '');
    li.dataset.id = track.id;
    li.tabIndex = instrumental ? -1 : 0;
    if (instrumental) li.title = 'Instrumental';

    const color = document.createElement('span');
    color.className = 'track-color';
    if (instrumental) color.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3v10.55A4 4 0 1 0 14 17V7h4V3z"/></svg>';
    else color.style.background = `hsl(${track.hue} 70% 62%)`;

    const name = nameInput(track.name, 'Track name', (v) => session.updateTrackMix(track.id, { name: v }));
    name.classList.add('track-name');

    const busy = document.createElement('span');
    busy.className = 'track-busy';
    busy.title = 'Processing';

    const toggle = (label: string, title: string, key: 'mute' | 'solo') => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = `track-btn track-${key}`;
      b.textContent = label;
      b.title = title;
      b.setAttribute('aria-label', `${title} ${track.name}`);
      b.addEventListener('click', () => {
        const t = openProject(store.get())?.tracks.find((x) => x.id === track.id);
        if (t) session.updateTrackMix(track.id, { [key]: !t[key] });
      });
      return b;
    };
    const mute = toggle('M', 'Mute', 'mute');
    const solo = toggle('S', 'Solo', 'solo');

    const fader = document.createElement('input');
    fader.type = 'range';
    fader.className = 'track-fader';
    fader.min = String(FADER_MIN);
    fader.max = String(FADER_MAX);
    fader.step = '0.5';
    fader.setAttribute('aria-label', `Volume ${track.name}`);
    fader.addEventListener('input', () => session.updateTrackMix(track.id, { gainDb: Number(fader.value) }));
    fader.addEventListener('dblclick', () => session.updateTrackMix(track.id, { gainDb: 0 }));

    const db = document.createElement('span');
    db.className = 'track-db';

    const remove = iconButton('close', `Remove ${track.name} from the song`);
    remove.addEventListener('click', () => session.removeTrack(track.id));

    li.append(color, name, busy, mute, solo, fader, db, remove);
    const select = () => {
      if (store.get().selectedTrackId !== track.id) session.selectTrack(track.id);
    };
    li.addEventListener('click', (e) => {
      if (!(e.target as HTMLElement).closest('button, input')) select();
    });
    li.addEventListener('keydown', (e) => {
      if (e.target === li && (e.key === 'Enter' || e.key === ' ')) {
        e.preventDefault();
        select();
      }
    });
    // Touching a row's controls also selects it, so the inspector follows what you're adjusting.
    li.addEventListener('focusin', select);
    return { li, name, mute, solo, fader, db, busy, shownName: track.name };
  }

  function updateRow(row: Row, track: Track, selected: boolean, busy: boolean): void {
    row.li.classList.toggle('is-selected', selected);
    row.li.setAttribute('aria-current', selected ? 'true' : 'false');
    row.li.classList.toggle('is-muted', track.mute);
    row.mute.setAttribute('aria-pressed', String(track.mute));
    row.solo.setAttribute('aria-pressed', String(track.solo));
    if (row.shownName !== track.name && document.activeElement !== row.name) {
      row.name.value = track.name;
      row.shownName = track.name;
    }
    if (Number(row.fader.value) !== track.gainDb) row.fader.value = String(track.gainDb);
    row.db.textContent = `${track.gainDb > 0 ? '+' : ''}${track.gainDb.toFixed(1)} dB`;
    // visibility (not display), so the grid columns don't shift when the dot comes and goes
    row.busy.classList.toggle('is-on', busy);
  }

  store.subscribe(render);
  render();

  function render(): void {
    const state = store.get();
    const song = openProject(state);
    section.hidden = !song;
    if (!song) {
      rows.clear();
      list.replaceChildren();
      return;
    }
    // Reconcile rows with the song's tracks (create, drop, reorder), then update values in place.
    const ids = song.tracks.map((t) => t.id);
    for (const id of [...rows.keys()]) if (!ids.includes(id)) rows.delete(id);
    song.tracks.forEach((t, i) => {
      let row = rows.get(t.id);
      if (!row) {
        row = createRow(t);
        rows.set(t.id, row);
      }
      if (list.children[i] !== row.li) list.insertBefore(row.li, list.children[i] ?? null);
      updateRow(row, t, t.id === state.selectedTrackId, !!state.trackRender[t.id]?.busy);
    });
    while (list.children.length > song.tracks.length) list.lastElementChild!.remove();
    empty.hidden = song.tracks.length > 0;
  }
}
