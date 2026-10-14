import { describe, expect, it } from 'vitest';
import { PitchTracker, type PitchFrame } from '../src/audio/pitch-tracker';
import { correctTrack } from '../src/dsp/autotune';
import { harmonyCorrections, harmonyNote, renderWithHarmony, stepInScale } from '../src/dsp/harmony';
import { freqToMidi } from '../src/dsp/notes';
import { renderTuned } from '../src/dsp/psola';
import { CHROMATIC, type Scale } from '../src/dsp/scales';
import { rms, sawtooth } from './signals';

const SR = 48000;
const C_MAJOR: Scale = { root: 0, type: 'major' };
const A_MINOR_PENT: Scale = { root: 9, type: 'minorPentatonic' };

function track(signal: Float32Array): PitchFrame[] {
  const frames: PitchFrame[] = [];
  const t = new PitchTracker(SR, (f) => frames.push(f));
  for (let i = 0; i < signal.length; i += 512) t.push(signal.subarray(i, i + 512));
  return frames;
}

function medianMidi(signal: Float32Array): number {
  const m = track(signal)
    .filter((f) => f.midi !== null && f.time > 0.2 && f.time < signal.length / SR - 0.2)
    .map((f) => f.midi!)
    .sort((a, b) => a - b);
  return m[m.length >> 1];
}

describe('harmony notes', () => {
  it('steps through the scale', () => {
    expect(stepInScale(60, 2, C_MAJOR)).toBe(64); // C -> E
    expect(stepInScale(64, 2, C_MAJOR)).toBe(67); // E -> G
    expect(stepInScale(62, 2, C_MAJOR)).toBe(65); // D -> F (minor third, stays in key)
    expect(stepInScale(60, -2, C_MAJOR)).toBe(57); // C -> A below
    expect(stepInScale(60, 4, C_MAJOR)).toBe(67); // C -> G
    expect(stepInScale(71, 4, C_MAJOR)).toBe(77); // B -> F (diminished fifth, in key)
    expect(stepInScale(57, 2, A_MINOR_PENT)).toBe(62); // A -> D (two pentatonic steps)
  });

  it('maps voices to notes', () => {
    expect(harmonyNote(64, 'thirdUp', C_MAJOR)).toBe(67);
    expect(harmonyNote(64, 'fifthDown', C_MAJOR)).toBe(57);
    expect(harmonyNote(60, 'octaveUp', C_MAJOR)).toBe(72);
    expect(harmonyNote(60, 'octaveDown', A_MINOR_PENT)).toBe(48);
    expect(harmonyNote(60, 'thirdUp', CHROMATIC)).toBe(64);
    expect(harmonyNote(60, 'thirdDown', CHROMATIC)).toBe(57);
  });

  it('builds a harmony curve that follows the lead', () => {
    const lead = [
      { target: 60, corrected: 60.1 },
      { target: null, corrected: null },
      { target: 62, corrected: 61.8 },
    ];
    expect(harmonyCorrections(lead, 'thirdUp', C_MAJOR)).toEqual([
      { target: 64, corrected: expect.closeTo(64.1, 6) },
      { target: null, corrected: null },
      { target: 65, corrected: expect.closeTo(64.8, 6) },
    ]);
  });
});

describe('renderWithHarmony', () => {
  const x = sawtooth(261.63, SR, 1.2); // C4
  const frames = track(x);
  const settings = { scale: C_MAJOR, retuneMs: 0 };

  it('renders a harmony voice a diatonic third up', () => {
    const lead = correctTrack(frames, settings);
    const third = renderTuned(x, SR, frames, harmonyCorrections(lead, 'thirdUp', C_MAJOR));
    expect(medianMidi(third)).toBeCloseTo(freqToMidi(329.63), 1); // E4
  });

  it('equals the plain tuned render with no voices', () => {
    const plain = renderTuned(x, SR, frames, correctTrack(frames, settings));
    const mixed = renderWithHarmony(x, SR, frames, { ...settings, harmony: { voices: [], mix: 0.6 } });
    expect([...mixed.subarray(1000, 1010)]).toEqual([...plain.subarray(1000, 1010)]);
  });

  const stack = { voices: ['thirdUp', 'fifthUp', 'octaveDown'] as const, mix: 1 };

  it('adds energy for each voice at a normal recording level', () => {
    const voice = sawtooth(261.63, SR, 1.2, 0.15); // peaks ~0.25, like a typical vocal take
    const f = track(voice);
    const plain = renderWithHarmony(voice, SR, f, settings);
    const stacked = renderWithHarmony(voice, SR, f, { ...settings, harmony: { ...stack, voices: [...stack.voices] } });
    expect(rms(stacked) / rms(plain)).toBeGreaterThan(1.3);
  });

  it('never clips, even from a hot recording', () => {
    const stacked = renderWithHarmony(x, SR, frames, { ...settings, harmony: { ...stack, voices: [...stack.voices] } });
    expect(Math.max(...stacked.map(Math.abs))).toBeLessThanOrEqual(0.98 + 1e-6);
  });
});
