// Note editing (Phase 18): the "Edit notes" switch on the roll, the roll's note callbacks, and the
// inspector's Note section for the selected note (pitch, own correction amount, timing, reset).

import type { Session } from '../../app/session';
import { openProject, selectedTrack, type AppStore } from '../../app/state';
import { noteName } from '../../dsp/notes';
import { trackSemitones } from '../../project/model';
import { $ } from '../dom';
import type { PianoRoll } from '../piano-roll';

export function mountNotePanel(store: AppStore, session: Session, roll: PianoRoll): void {
  const toggle = $<HTMLButtonElement>('note-mode');
  const panel = $<HTMLDetailsElement>('note-panel');
  const hint = $('note-hint');
  const controls = $('note-controls');
  const info = $('note-info');
  const shift = $<HTMLInputElement>('note-shift');
  const shiftValue = $('note-shift-value');
  const own = $<HTMLInputElement>('note-own');
  const amount = $<HTMLInputElement>('note-amount');
  const amountValue = $('note-amount-value');
  const timing = $('note-timing');
  const reset = $<HTMLButtonElement>('note-reset');
  const resetAll = $<HTMLButtonElement>('note-reset-all');

  // Every semitone is a detent: the pitch slider snaps to whole semitones unless Alt is held.
  shift.dataset.detents = Array.from({ length: 25 }, (_, i) => i - 12).join(',');

  roll.onNoteSelect = (i) => session.selectNote(i);
  roll.onNoteDrag = (drag) => session.dragNote(drag);
  toggle.addEventListener('click', () => session.toggleNoteMode());

  const selected = () => store.get().selectedNote;
  shift.addEventListener('input', () => {
    const i = selected();
    if (i !== null) session.editNote(i, { shift: Number(shift.value) }, `notepitch:${i}`);
  });
  own.addEventListener('change', () => {
    const i = selected();
    if (i !== null) session.editNote(i, { amount: own.checked ? Number(amount.value) / 100 : null });
  });
  amount.addEventListener('input', () => {
    const i = selected();
    if (i !== null) session.editNote(i, { amount: Number(amount.value) / 100 }, `noteamount:${i}`);
  });
  reset.addEventListener('click', () => {
    const i = selected();
    if (i !== null) session.resetNote(i);
  });
  resetAll.addEventListener('click', () => session.resetAllNotes());

  const st = (n: number) => (n === 0 ? '0 st' : `${n > 0 ? '+' : '−'}${Math.abs(n).toFixed(Number.isInteger(n) ? 0 : 2)} st`);

  store.watch(
    (s) => [s.noteMode, s.selectedNote, openProject(s), s.selectedTrackId, s.mode] as const,
    ([noteMode, index, song]) => {
      const track = selectedTrack(store.get());
      const canEdit = !!song && track?.kind === 'vocal' && store.get().mode === 'playback';
      toggle.hidden = !canEdit;
      toggle.setAttribute('aria-pressed', String(noteMode));
      toggle.classList.toggle('is-on', noteMode);
      panel.hidden = !noteMode;
      const cur = index !== null ? session.noteEditOf(index) : null;
      hint.hidden = !!cur;
      controls.hidden = !cur;
      resetAll.disabled = !track?.noteEdits?.length;
      if (!cur || !song || !track) return;
      const { note, edit } = cur;
      const transpose = trackSemitones(track, song);
      const heard = Math.round(note.pitch + transpose + edit.shift);
      info.textContent = `Note ${index! + 1}: ${noteName(heard)} · sung ${noteName(Math.round(note.pitch + transpose))}`;
      if (document.activeElement !== shift) shift.value = String(edit.shift);
      shiftValue.textContent = st(edit.shift);
      own.checked = edit.amount !== null;
      amount.disabled = edit.amount === null;
      if (document.activeElement !== amount) amount.value = String(Math.round((edit.amount ?? 1) * 100));
      amountValue.textContent = edit.amount === null ? 'Track' : `${Math.round(edit.amount * 100)}%`;
      const len = (a: number, b: number) => `${(b - a).toFixed(2)} s`;
      timing.textContent =
        edit.start !== undefined && edit.end !== undefined
          ? `Moved ${edit.start - note.start >= 0 ? '+' : '−'}${Math.abs(edit.start - note.start).toFixed(2)} s · ${len(edit.start, edit.end)} long (sung ${len(note.start, note.end)})`
          : `${len(note.start, note.end)} long, as sung`;
      reset.disabled = !track.noteEdits?.some((e) => e.from === note.from && e.to === note.to);
    },
    { shallow: true },
  );
}
