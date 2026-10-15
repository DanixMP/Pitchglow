// Tempo & click section (Phase 17): the open song's tempo (BPM field + tap tempo), beats per bar,
// bar 1 at the playhead, the click (on/off, level, accent) and "align take to beat".

import type { Session } from '../../app/session';
import { openProject, selectedTrack, type AppStore } from '../../app/state';
import { BEATS_PER_BAR_OPTIONS, clampBpm, DEFAULT_BEATS_PER_BAR, MAX_BPM, MIN_BPM } from '../../project/grid';
import { $ } from '../dom';

export function mountTempoPanel(store: AppStore, session: Session): void {
  const hint = $('tempo-hint');
  const controls = $('tempo-controls');
  const bpm = $<HTMLInputElement>('tempo-bpm');
  const tap = $<HTMLButtonElement>('tempo-tap');
  const beats = $<HTMLSelectElement>('tempo-beats');
  const downbeat = $<HTMLButtonElement>('tempo-downbeat');
  const downbeatValue = $('tempo-downbeat-value');
  const on = $<HTMLInputElement>('metronome');
  const level = $<HTMLInputElement>('metronome-level');
  const levelValue = $('metronome-level-value');
  const accent = $<HTMLInputElement>('metronome-accent');
  const align = $<HTMLButtonElement>('align-beat');

  for (const n of BEATS_PER_BAR_OPTIONS) beats.add(new Option(`${n}`, String(n)));
  bpm.min = String(MIN_BPM);
  bpm.max = String(MAX_BPM);

  const commitBpm = () => {
    const v = bpm.value.trim() === '' ? null : Number(bpm.value);
    if (v !== null && !Number.isFinite(v)) return;
    session.setTempo({ bpm: v === null ? null : clampBpm(v) });
  };
  bpm.addEventListener('change', commitBpm);
  bpm.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') bpm.blur();
  });
  tap.addEventListener('click', () => {
    session.tapTempo();
    tap.classList.add('tempo-tap-flash');
    window.setTimeout(() => tap.classList.remove('tempo-tap-flash'), 90);
  });
  beats.addEventListener('change', () => session.setTempo({ beatsPerBar: Number(beats.value) }));
  downbeat.addEventListener('click', () => session.setDownbeatHere());
  const setMetronome = (patch: Partial<ReturnType<AppStore['get']>['metronome']>) => store.set((s) => ({ metronome: { ...s.metronome, ...patch } }));
  on.addEventListener('change', () => setMetronome({ on: on.checked }));
  level.addEventListener('input', () => setMetronome({ levelDb: Number(level.value) }));
  accent.addEventListener('change', () => setMetronome({ accent: accent.checked }));
  align.addEventListener('click', () => {
    const id = store.get().selectedTrackId;
    if (id) session.alignTrackToBeat(id);
  });

  store.watch(
    (s) => [openProject(s), s.metronome, s.selectedTrackId, s.mode] as const,
    ([song, metronome]) => {
      hint.hidden = !!song;
      controls.hidden = !song;
      on.checked = metronome.on;
      level.value = String(metronome.levelDb);
      levelValue.textContent = metronome.levelDb === 0 ? '0 dB' : `−${Math.abs(metronome.levelDb)} dB`;
      accent.checked = metronome.accent;
      if (!song) return;
      if (document.activeElement !== bpm) bpm.value = song.bpm ? String(song.bpm) : '';
      beats.value = String(song.beatsPerBar ?? DEFAULT_BEATS_PER_BAR);
      beats.disabled = !song.bpm;
      downbeatValue.textContent = song.bpm ? `Bar 1 at ${(song.downbeat ?? 0).toFixed(2)} s` : 'Sets 100 BPM if the song has no tempo';
      downbeat.disabled = store.get().mode !== 'playback';
      const track = selectedTrack(store.get());
      align.disabled = !song.bpm || track?.kind !== 'vocal' || store.get().mode !== 'playback';
    },
    { shallow: true },
  );
}
