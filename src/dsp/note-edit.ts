// Note editing (Phase 18, pure): the pitch track cut into sung notes, and per-note edits applied to
// the pitch curve (move a note's pitch, set how hard it is pulled onto its note) and to timing (move
// or stretch a note: a piecewise-linear time warp that PSOLA follows, see planGrains).
//
// Edits are stored on the track and point at the take's frames by index, so they never change the
// recording itself: they are applied when the voice plans are made, live and in exports alike.

import type { PitchFrame } from '../audio/pitch-tracker';
import type { Correction } from './autotune';

/** A sung note: frames [from, to) of the pitch track, its time span (s) and typical pitch (MIDI). */
export interface SungNote {
  from: number;
  to: number;
  start: number;
  end: number;
  /** Median sung pitch. */
  pitch: number;
}

export interface NoteEdit {
  /** The note's frames [from, to) in the take's pitch track. */
  from: number;
  to: number;
  /** Pitch move in semitones (whole semitones unless placed freely). */
  shift: number;
  /** How hard the note is pulled onto its note: null = the track's auto-tune; 0..1 = this much. */
  amount: number | null;
  /** New time span in the take, seconds (both set = moved or stretched; unset = as sung). */
  start?: number;
  end?: number;
}

/** A time warp as matching knots (samples): output position `out[i]` plays source position `src[i]`. */
export interface TimeWarp {
  out: Float64Array;
  src: Float64Array;
}

/** Pitch moves further than this from a note's pitch start a new note… */
const SPLIT_SEMITONES = 0.7;
/** …when they last at least this many frames (so vibrato and scoops don't split notes). */
const SPLIT_FRAMES = 4;
/** Shorter notes are merged into their neighbour. */
const MIN_NOTE_SECONDS = 0.06;
/** A note's pitch is settled from its first frames. */
const ANCHOR_FRAMES = 8;

function median(values: number[]): number {
  const s = values.slice().sort((a, b) => a - b);
  return s.length ? s[s.length >> 1] : NaN;
}

/** Typical frame spacing (s). */
export function frameHop(frames: readonly PitchFrame[]): number {
  const diffs: number[] = [];
  for (let i = 1; i < Math.min(frames.length, 50); i++) diffs.push(frames[i].time - frames[i - 1].time);
  return diffs.length ? median(diffs) : 0.01;
}

/**
 * Cuts the voiced runs of a pitch track into notes: a new note starts where the (5-frame median)
 * pitch stays more than 0.7 semitone away from the current note's pitch for 4+ frames. Notes
 * shorter than 60 ms are merged into a neighbour.
 */
export function segmentNotes(frames: readonly PitchFrame[]): SungNote[] {
  const hop = frameHop(frames);
  const notes: SungNote[] = [];
  const midi = (i: number) => frames[i].midi as number;
  let i = 0;
  while (i < frames.length) {
    if (frames[i].midi === null) {
      i++;
      continue;
    }
    let runEnd = i;
    while (runEnd < frames.length && frames[runEnd].midi !== null) runEnd++;
    // Split the run [i, runEnd).
    const cuts = [i];
    let noteStart = i;
    let away = 0;
    for (let k = i; k < runEnd; k++) {
      const win: number[] = [];
      for (let j = Math.max(i, k - 2); j <= Math.min(runEnd - 1, k + 2); j++) win.push(midi(j));
      const smooth = median(win);
      const anchorFrames: number[] = [];
      for (let j = noteStart; j < Math.min(k, noteStart + ANCHOR_FRAMES); j++) anchorFrames.push(midi(j));
      const anchor = anchorFrames.length ? median(anchorFrames) : smooth;
      away = Math.abs(smooth - anchor) > SPLIT_SEMITONES ? away + 1 : 0;
      if (away >= SPLIT_FRAMES) {
        noteStart = k - SPLIT_FRAMES + 1;
        cuts.push(noteStart);
        away = 0;
      }
    }
    cuts.push(runEnd);
    // Merge short pieces into the previous note of the run (or the next one when it's the first).
    const pieces: [number, number][] = [];
    for (let c = 0; c + 1 < cuts.length; c++) pieces.push([cuts[c], cuts[c + 1]]);
    const merged: [number, number][] = [];
    for (const p of pieces) {
      const short = (p[1] - p[0]) * hop < MIN_NOTE_SECONDS;
      if (short && merged.length) merged[merged.length - 1][1] = p[1];
      else merged.push([p[0], p[1]]);
    }
    if (merged.length > 1 && (merged[0][1] - merged[0][0]) * hop < MIN_NOTE_SECONDS) {
      merged[1][0] = merged[0][0];
      merged.shift();
    }
    // Neighbours that ended up on the same pitch (around a merged blip) are one note.
    const pitchOf = (from: number, to: number) => {
      const p: number[] = [];
      for (let j = from; j < to; j++) p.push(midi(j));
      return median(p);
    };
    for (let m = merged.length - 1; m > 0; m--) {
      if (Math.abs(pitchOf(...merged[m]) - pitchOf(...merged[m - 1])) < SPLIT_SEMITONES) {
        merged[m - 1][1] = merged[m][1];
        merged.splice(m, 1);
      }
    }
    for (const [from, to] of merged) {
      const pitches: number[] = [];
      for (let j = from; j < to; j++) pitches.push(midi(j));
      notes.push({ from, to, start: Math.max(0, frames[from].time - hop / 2), end: frames[to - 1].time + hop / 2, pitch: median(pitches) });
    }
    i = runEnd;
  }
  return notes;
}

export function isNeutralEdit(e: NoteEdit): boolean {
  return e.shift === 0 && e.amount === null && e.start === undefined && e.end === undefined;
}

/**
 * The pitch curve with note edits applied (before any transpose): within an edited note, `amount`
 * pulls the sung pitch that far onto the note (its auto-tune target, or its rounded median pitch),
 * then `shift` moves it. Targets move by the rounded shift, so harmonies follow in key.
 */
export function applyNoteEdits(frames: readonly PitchFrame[], base: readonly Correction[], edits: readonly NoteEdit[]): Correction[] {
  if (!edits.length) return base as Correction[];
  const out = base.slice();
  for (const e of edits) {
    const to = Math.min(e.to, frames.length);
    const pitches: number[] = [];
    for (let i = e.from; i < to; i++) if (frames[i].midi !== null) pitches.push(frames[i].midi!);
    if (!pitches.length || (e.shift === 0 && e.amount === null)) continue;
    const center = Math.round(median(pitches));
    for (let i = Math.max(0, e.from); i < to; i++) {
      const sung = frames[i].midi;
      if (sung === null) continue;
      let corrected = base[i]?.corrected ?? sung;
      let target = base[i]?.target ?? null;
      if (e.amount !== null) {
        const note = target ?? center;
        corrected = sung + e.amount * (note - sung);
        target = note;
      }
      out[i] = { target: target === null ? null : target + Math.round(e.shift), corrected: corrected + e.shift };
    }
  }
  return out;
}

/**
 * The time warp for the timing edits (null when there are none). Edited notes are pinned where
 * they were moved; every other note stays where it was sung when that keeps time running forward
 * (otherwise its edge gives way and it is squeezed or stretched); the gaps in between stretch.
 */
export function buildWarp(notes: readonly SungNote[], edits: readonly NoteEdit[], sampleRate: number, length: number): TimeWarp | null {
  type Knot = { s: number; o: number };
  const pinned: Knot[] = [];
  const editedFrom = new Set<number>();
  for (const e of edits) {
    if (e.start === undefined || e.end === undefined) continue;
    const note = notes.find((n) => n.from === e.from && n.to === e.to);
    if (!note) continue;
    editedFrom.add(note.from);
    pinned.push({ s: note.start * sampleRate, o: e.start * sampleRate }, { s: note.end * sampleRate, o: e.end * sampleRate });
  }
  if (!pinned.length) return null;
  pinned.sort((a, b) => a.s - b.s);
  // Ends fixed; pinned knots kept while time keeps running forward.
  const knots: Knot[] = [{ s: 0, o: 0 }];
  for (const k of pinned) {
    const prev = knots[knots.length - 1];
    if (k.s > prev.s + 1 && k.o > prev.o + 1 && k.s < length - 1 && k.o < length - 1) knots.push(k);
  }
  knots.push({ s: length, o: length });
  // Unedited notes stay put where they fit.
  for (const n of notes) {
    if (editedFrom.has(n.from)) continue;
    for (const x of [n.start * sampleRate, n.end * sampleRate]) {
      let i = 1;
      while (i < knots.length && knots[i].s <= x) i++;
      const prev = knots[i - 1];
      const next = knots[i];
      if (next && x > prev.s + 1 && x > prev.o + 1 && x < next.s - 1 && x < next.o - 1) knots.splice(i, 0, { s: x, o: x });
    }
  }
  return { out: Float64Array.from(knots, (k) => k.o), src: Float64Array.from(knots, (k) => k.s) };
}

/** Piecewise-linear lookup in `xs` -> `ys` (ascending), slope 1 beyond the ends. */
function mapThrough(xs: Float64Array, ys: Float64Array, x: number): number {
  const last = xs.length - 1;
  if (x <= xs[0]) return ys[0] + (x - xs[0]);
  if (x >= xs[last]) return ys[last] + (x - xs[last]);
  let lo = 0;
  let hi = last;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (xs[mid] <= x) lo = mid;
    else hi = mid;
  }
  return ys[lo] + ((x - xs[lo]) * (ys[hi] - ys[lo])) / (xs[hi] - xs[lo]);
}

/** Source position (samples) heard at output position `out`. */
export function warpToSource(w: TimeWarp, out: number): number {
  return mapThrough(w.out, w.src, out);
}

/** Output position (samples) where source position `src` is heard. */
export function warpToOutput(w: TimeWarp, src: number): number {
  return mapThrough(w.src, w.out, src);
}

/** Where a note's edges now are, seconds (its edit's times, or as sung). */
export function noteSpan(note: SungNote, edit: NoteEdit | undefined): { start: number; end: number } {
  return edit?.start !== undefined && edit.end !== undefined ? { start: edit.start, end: edit.end } : { start: note.start, end: note.end };
}
