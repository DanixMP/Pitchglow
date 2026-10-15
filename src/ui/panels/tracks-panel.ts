// Center column (song open): the mixer. Track rows (select, rename, mute/solo, pan, volume + meter,
// remove), the master strip (volume, limiter, L/R meter), undo/redo, the timeline of clips, and a
// drop zone for takes dragged from the library. Rows are keyed and updated in place, so a fader being
// dragged is never replaced under the pointer.

import type { Session } from '../../app/session';
import { openProject, type AppStore } from '../../app/state';
import type { Level } from '../../audio/mix-player';
import { panLabel, type Track } from '../../project/model';
import { $ } from '../dom';
import { iconButton, nameInput, TAKE_DRAG_TYPE } from '../icons';
import { Timeline } from '../timeline';

const FADER_MIN = -40;
const FADER_MAX = 6;
/** Meter range: −48 dBFS … 0 dBFS. */
const METER_FLOOR_DB = -48;
/** Peak-hold fall rate, dB per second. */
const PEAK_FALL_DB = 24;

interface Meter {
  fill: HTMLElement;
  /** Displayed (held) peak in dB. */
  held: number;
}

interface Row {
  li: HTMLLIElement;
  name: HTMLInputElement;
  mute: HTMLButtonElement;
  solo: HTMLButtonElement;
  pan: HTMLInputElement;
  fader: HTMLInputElement;
  db: HTMLSpanElement;
  busy: HTMLSpanElement;
  meter: Meter;
  /** Last name rendered (the input keeps its own value while being edited). */
  shownName: string;
}

export function mountTracksPanel(store: AppStore, session: Session): { tick(dt: number): void } {
  const section = $('tracks');
  const list = $('track-list');
  const empty = $('tracks-empty');
  const undo = $<HTMLButtonElement>('undo');
  const redo = $<HTMLButtonElement>('redo');
  const masterFader = $<HTMLInputElement>('master-fader');
  const masterDb = $('master-db');
  const masterLimiter = $<HTMLButtonElement>('master-limiter');
  const masterMeters: Meter[] = [...$('master-strip').querySelectorAll<HTMLElement>('.meter-fill')].map((fill) => ({ fill, held: -Infinity }));
  const rows = new Map<string, Row>();

  $('song-close').addEventListener('click', () => session.closeProject());
  undo.addEventListener('click', () => session.undo());
  redo.addEventListener('click', () => session.redo());
  masterFader.addEventListener('input', () => session.setMaster({ masterGainDb: Number(masterFader.value) }));
  masterFader.addEventListener('dblclick', () => session.setMaster({ masterGainDb: 0 }));
  masterLimiter.addEventListener('click', () => {
    const song = openProject(store.get());
    if (song) session.setMaster({ limiter: song.limiter === false });
  });

  const timeline = new Timeline($<HTMLCanvasElement>('timeline'), {
    onSeek: (t) => session.seek(t),
    onMove: (id, offset) => session.updateTrackMix(id, { offset }),
    onSelect: (id) => session.selectTrack(id),
    onLoop: (start, end) => session.setLoopRegion(start, end),
  });

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

    const pan = document.createElement('input');
    pan.type = 'range';
    pan.className = 'track-pan';
    pan.min = '-100';
    pan.max = '100';
    pan.step = '1';
    pan.setAttribute('aria-label', `Pan ${track.name}`);
    pan.addEventListener('input', () => session.updateTrackMix(track.id, { pan: Number(pan.value) / 100 }));
    pan.addEventListener('dblclick', () => session.updateTrackMix(track.id, { pan: 0 }));

    const fader = document.createElement('input');
    fader.type = 'range';
    fader.className = 'track-fader';
    fader.min = String(FADER_MIN);
    fader.max = String(FADER_MAX);
    fader.step = '0.5';
    fader.setAttribute('aria-label', `Volume ${track.name}`);
    fader.dataset.fill = 'start'; // a volume fills from the left (0 dB is still a detent)
    fader.addEventListener('input', () => session.updateTrackMix(track.id, { gainDb: Number(fader.value) }));
    fader.addEventListener('dblclick', () => session.updateTrackMix(track.id, { gainDb: 0 }));

    const faderCell = document.createElement('div');
    faderCell.className = 'fader-cell';
    const meterEl = document.createElement('div');
    meterEl.className = 'meter';
    meterEl.setAttribute('aria-hidden', 'true');
    const fill = document.createElement('i');
    fill.className = 'meter-fill';
    meterEl.append(fill);
    faderCell.append(fader, meterEl);

    const db = document.createElement('span');
    db.className = 'track-db';

    const remove = iconButton('close', `Remove ${track.name} from the song`);
    remove.addEventListener('click', () => session.removeTrack(track.id));

    li.append(color, name, busy, mute, solo, pan, faderCell, db, remove);
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
    return { li, name, mute, solo, pan, fader, db, busy, meter: { fill, held: -Infinity }, shownName: track.name };
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
    const panValue = Math.round(track.pan * 100);
    if (Number(row.pan.value) !== panValue) row.pan.value = String(panValue);
    row.pan.title = `Pan ${panLabel(track.pan)}`;
    row.pan.setAttribute('aria-valuetext', panLabel(track.pan));
    row.db.textContent = `${track.gainDb > 0 ? '+' : ''}${track.gainDb.toFixed(1)} dB`;
    // visibility (not display), so the grid columns don't shift when the dot comes and goes
    row.busy.classList.toggle('is-on', busy);
  }

  /** Clip positions/colours change with the song; peaks are cached per take. */
  let clipsKey = '';
  function refreshTimeline(): void {
    const state = store.get();
    const song = openProject(state);
    if (!song) return;
    timeline.setLoop(song.loop ?? null);
    const key = JSON.stringify([state.selectedTrackId, state.duration, song.bpm, song.tracks.map((t) => [t.id, t.offset, t.mute, t.solo, t.gainDb])]);
    if (key === clipsKey) return;
    clipsKey = key;
    timeline.setClips(session.timelineClips(), state.duration, song.bpm ?? null);
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
      clipsKey = '';
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

    if (Number(masterFader.value) !== song.masterGainDb) masterFader.value = String(song.masterGainDb);
    masterDb.textContent = `${song.masterGainDb > 0 ? '+' : ''}${song.masterGainDb.toFixed(1)} dB`;
    masterLimiter.setAttribute('aria-pressed', String(song.limiter !== false));
    undo.disabled = !state.history.canUndo;
    redo.disabled = !state.history.canRedo;
    refreshTimeline();
  }

  /** Meter bar: peak with hold-and-fall, scaled −48…0 dBFS; red when it reaches 0 dBFS. */
  function drawMeter(m: Meter, level: Level | undefined, dt: number): void {
    const db = level && level.peak > 0 ? 20 * Math.log10(level.peak) : -Infinity;
    m.held = Math.max(db, m.held - PEAK_FALL_DB * dt);
    const t = Number.isFinite(m.held) ? Math.min(1, Math.max(0, (m.held - METER_FLOOR_DB) / -METER_FLOOR_DB)) : 0;
    m.fill.style.setProperty('--level', t.toFixed(3)); // LED meter (style.css)
    m.fill.classList.toggle('is-hot', m.held > -6);
    m.fill.classList.toggle('is-clip', m.held >= -0.1);
  }

  return {
    tick(dt) {
      if (section.hidden) return;
      const levels = session.player.levels();
      for (const [id, row] of rows) drawMeter(row.meter, levels.tracks.get(id), dt);
      masterMeters.forEach((m, ch) => drawMeter(m, levels.master[ch], dt));
      timeline.setTime(session.player.currentTime);
      timeline.render();
    },
  };
}
