import { describe, expect, it } from 'vitest';
import { freqToMidi, isBlackKey, midiToFreq, nearestNote, noteName, pitchClass } from '../src/dsp/notes';

describe('notes', () => {
  it('maps reference frequencies to MIDI', () => {
    expect(freqToMidi(440)).toBeCloseTo(69, 6);
    expect(freqToMidi(261.6256)).toBeCloseTo(60, 3);
    expect(freqToMidi(130.8128)).toBeCloseTo(48, 3); // C3
    expect(midiToFreq(57)).toBeCloseTo(220, 6);
  });

  it('round-trips', () => {
    for (const m of [24, 36.5, 48, 60.25, 81]) expect(freqToMidi(midiToFreq(m))).toBeCloseTo(m, 9);
  });

  it('names notes with C4 = middle C', () => {
    expect(noteName(60)).toBe('C4');
    expect(noteName(48)).toBe('C3');
    expect(noteName(36)).toBe('C2');
    expect(noteName(61)).toBe('C#4');
    expect(noteName(59)).toBe('B3');
    expect(noteName(69.4)).toBe('A4');
  });

  it('knows black keys', () => {
    expect([60, 62, 64, 65, 67, 69, 71].map(isBlackKey)).toEqual(Array(7).fill(false));
    expect([61, 63, 66, 68, 70].map(isBlackKey)).toEqual(Array(5).fill(true));
    expect(pitchClass(-1)).toBe(11);
  });

  it('finds the nearest note and cents', () => {
    expect(nearestNote(60.3)).toEqual({ note: 60, cents: expect.closeTo(30, 6) });
    expect(nearestNote(59.6)).toEqual({ note: 60, cents: expect.closeTo(-40, 6) });
  });
});
