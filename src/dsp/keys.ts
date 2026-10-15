// Play-the-keys harmony (Phase 19, pure): the notes held on a keyboard become harmony voices for the
// sung line. Each held key is one voice (lowest key = first voice). "Near" voicing moves each key to
// the octave closest to the sung note (smaller shifts sound more natural); "played" keeps the
// octave as played. The voices keep the singer's expression: the corrected line's deviation from
// its nearest semitone (vibrato, scoops) rides on every key.
//
// Key changes are recorded with a take (KeyEvent: the held set from time t on), so playback and
// export rebuild exactly the harmony that was heard while singing.

import type { PitchFrame } from '../audio/pitch-tracker';
import type { Correction } from './autotune';

export type Voicing = 'near' | 'played';

/** From `t` (seconds into the take) on, these keys (MIDI notes, ascending) are held. */
export interface KeyEvent {
  t: number;
  notes: number[];
}

/** Voices the keys can drive at once (each one is a PSOLA voice). */
export const MAX_KEY_VOICES = 4;

/** Where a held key is sung, given the sung pitch (MIDI). */
export function voiceKey(key: number, sung: number, voicing: Voicing): number {
  return voicing === 'played' ? key : key + 12 * Math.round((sung - key) / 12);
}

/**
 * The harmony notes for the held keys (ascending, at most MAX_KEY_VOICES): voiced near the sung
 * pitch (duplicates dropped) or as played.
 */
export function keyNotes(keys: readonly number[], sung: number, voicing: Voicing): number[] {
  const notes = keys.map((k) => voiceKey(k, sung, voicing));
  const unique = [...new Set(notes)].sort((a, b) => a - b);
  return unique.slice(0, MAX_KEY_VOICES);
}

/** The keys held at time `t` (the last event at or before it). */
export function keysAt(events: readonly KeyEvent[], t: number): number[] {
  let lo = 0;
  let hi = events.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (events[mid].t <= t) lo = mid + 1;
    else hi = mid;
  }
  return lo ? events[lo - 1].notes : [];
}

/** How many voices the events ever need. */
export function keyVoiceCount(events: readonly KeyEvent[]): number {
  return Math.min(MAX_KEY_VOICES, events.reduce((m, e) => Math.max(m, e.notes.length), 0));
}

/** Records a held-set change: drops repeats, keeps time order (replacing a change at the same time). */
export function addKeyEvent(events: KeyEvent[], t: number, notes: readonly number[]): KeyEvent[] {
  const held = [...new Set(notes)].sort((a, b) => a - b);
  const last = events[events.length - 1];
  if (last && last.notes.length === held.length && last.notes.every((n, i) => n === held[i])) return events;
  if (!last && !held.length) return events;
  const kept = events.filter((e) => e.t < t);
  return [...kept, { t: Math.max(0, t), notes: held }];
}

/**
 * The pitch curve of key voice `slot` (0 = lowest held key) for a take: where the lead sings, the
 * slot's key (voiced against the lead) plus the lead's expression; nothing where it doesn't, or
 * where fewer keys are held.
 */
export function keyHarmonyCorrections(
  frames: readonly PitchFrame[],
  lead: readonly Correction[],
  events: readonly KeyEvent[],
  voicing: Voicing,
  slot: number,
): Correction[] {
  return frames.map((f, i) => {
    const c = lead[i]?.corrected;
    if (c === null || c === undefined) return { target: null, corrected: null };
    const notes = keyNotes(keysAt(events, f.time), c, voicing);
    const note = notes[slot];
    if (note === undefined) return { target: null, corrected: null };
    return { target: note, corrected: note + (c - Math.round(c)) };
  });
}
