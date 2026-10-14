// Note math. MIDI numbers, A4 = 440 Hz = MIDI 69, middle C = C4 = MIDI 60.

export const A4_FREQ = 440;
export const A4_MIDI = 69;

const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'] as const;
const BLACK_PITCH_CLASSES = new Set([1, 3, 6, 8, 10]);

/** Pitch class 0..11 (C = 0), safe for negative numbers. */
export function pitchClass(midi: number): number {
  return ((Math.round(midi) % 12) + 12) % 12;
}

/** Fractional MIDI number for a frequency in Hz. */
export function freqToMidi(freq: number): number {
  return A4_MIDI + 12 * Math.log2(freq / A4_FREQ);
}

export function midiToFreq(midi: number): number {
  return A4_FREQ * Math.pow(2, (midi - A4_MIDI) / 12);
}

/** Octave in scientific pitch notation (C4 = middle C). */
export function octaveOf(midi: number): number {
  return Math.floor(Math.round(midi) / 12) - 1;
}

/** "C3", "F#4", ... for the nearest integer MIDI note. */
export function noteName(midi: number): string {
  return `${NOTE_NAMES[pitchClass(midi)]}${octaveOf(midi)}`;
}

/** Letter without octave: "C", "F#", ... */
export function pitchClassName(midi: number): string {
  return NOTE_NAMES[pitchClass(midi)];
}

export function isBlackKey(midi: number): boolean {
  return BLACK_PITCH_CLASSES.has(pitchClass(midi));
}

/** Nearest semitone and the deviation from it in cents (-50..+50). */
export function nearestNote(midi: number): { note: number; cents: number } {
  const note = Math.round(midi);
  return { note, cents: (midi - note) * 100 };
}
