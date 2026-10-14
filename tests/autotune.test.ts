import { describe, expect, it } from 'vitest';
import type { PitchFrame } from '../src/audio/pitch-tracker';
import { correctTrack, PitchCorrector } from '../src/dsp/autotune';
import { CHROMATIC, inScale, nearestInScale, scaleMask, scaleName, type Scale } from '../src/dsp/scales';

const C_MAJOR: Scale = { root: 0, type: 'major' };
const A_MINOR: Scale = { root: 9, type: 'minor' };

/** Frames every 10 ms with the given pitch curve (null = unvoiced). */
function frames(seconds: number, midiAt: (t: number) => number | null): PitchFrame[] {
  const out: PitchFrame[] = [];
  for (let i = 0; i < Math.round(seconds * 100); i++) {
    const time = i / 100;
    const midi = midiAt(time);
    out.push({ time, midi, freq: midi === null ? null : 440, clarity: 0.9, rms: 0.1 });
  }
  return out;
}

describe('scales', () => {
  it('builds masks from root + intervals', () => {
    expect(scaleMask(C_MAJOR).map(Number).join('')).toBe('101011010101');
    expect(scaleMask({ root: 2, type: 'major' }).map(Number).join('')).toBe('011010110101'); // D major: C# F#
    expect(scaleMask(CHROMATIC).every(Boolean)).toBe(true);
  });

  it('knows membership', () => {
    expect(inScale(60, C_MAJOR)).toBe(true);
    expect(inScale(61, C_MAJOR)).toBe(false);
    expect(inScale(57, A_MINOR)).toBe(true); // A
    expect(inScale(56, A_MINOR)).toBe(false); // G#
  });

  it('finds the nearest allowed note', () => {
    expect(nearestInScale(60.3, CHROMATIC)).toBe(60);
    expect(nearestInScale(60.6, CHROMATIC)).toBe(61);
    expect(nearestInScale(61.2, C_MAJOR)).toBe(62); // C#+20¢ -> D
    expect(nearestInScale(60.8, C_MAJOR)).toBe(60); // C+80¢ -> C (C# not allowed)
    expect(nearestInScale(61, C_MAJOR)).toBe(60); // exact tie -> lower
    expect(nearestInScale(64.4, C_MAJOR)).toBe(64); // E
    expect(nearestInScale(64.6, C_MAJOR)).toBe(65); // F
  });

  it('names scales', () => {
    expect(scaleName(CHROMATIC)).toBe('Chromatic');
    expect(scaleName(C_MAJOR)).toBe('C major');
    expect(scaleName({ root: 6, type: 'minorPentatonic' })).toBe('F# minor pentatonic');
  });
});

describe('PitchCorrector', () => {
  it('snaps exactly onto the note at 0 ms (staircase)', () => {
    const glide = frames(1, (t) => 48 + t * 4); // slides C3 -> E3
    const out = correctTrack(glide, { scale: CHROMATIC, retuneMs: 0 });
    for (const c of out) expect(c.corrected).toBe(c.target);
    const steps = new Set(out.map((c) => c.target));
    expect([...steps]).toEqual([48, 49, 50, 51, 52]);
  });

  it('only lands on scale notes', () => {
    const glide = frames(1, (t) => 60 + t * 12);
    const out = correctTrack(glide, { scale: C_MAJOR, retuneMs: 0 });
    for (const c of out) expect(inScale(c.target!, C_MAJOR)).toBe(true);
  });

  it('reaches the target in about the retune time', () => {
    const flat = frames(0.6, () => 60.4); // 40 cents sharp of C4
    const out = correctTrack(flat, { scale: CHROMATIC, retuneMs: 100 });
    const at = (t: number) => out[Math.round(t * 100)].corrected!;
    expect(at(0)).toBeGreaterThan(60.25); // starts near the sung pitch (one 10 ms step in)
    expect(Math.abs(at(0.1) - 60)).toBeLessThan(0.04); // ~95% corrected after 100 ms
    expect(Math.abs(at(0.5) - 60)).toBeLessThan(0.001);
  });

  it('keeps vibrato at slow retune and flattens it at 0 ms', () => {
    const vibrato = frames(2, (t) => 57 + 0.3 * Math.sin(2 * Math.PI * 5.5 * t));
    const swing = (retuneMs: number) => {
      const c = correctTrack(vibrato, { scale: CHROMATIC, retuneMs })
        .slice(100)
        .map((x) => x.corrected!);
      return Math.max(...c) - Math.min(...c);
    };
    expect(swing(400)).toBeGreaterThan(0.6 * 0.8);
    expect(swing(0)).toBeLessThan(0.01);
  });

  it('uses hysteresis so a voice hovering at the midpoint does not flicker', () => {
    const hover = frames(1, (t) => 60.5 + 0.08 * Math.sin(2 * Math.PI * 7 * t));
    const targets = correctTrack(hover, { scale: CHROMATIC, retuneMs: 0 }).map((c) => c.target);
    expect(new Set(targets).size).toBe(1);
  });

  it('resets on silence', () => {
    const c = new PitchCorrector({ scale: CHROMATIC, retuneMs: 200 });
    c.process({ time: 0, midi: 60.4, freq: 1, clarity: 1, rms: 1 });
    expect(c.process({ time: 0.01, midi: null, freq: null, clarity: 0, rms: 0 })).toEqual({ target: null, corrected: null });
    const next = c.process({ time: 0.5, midi: 64.3, freq: 1, clarity: 1, rms: 1 });
    expect(next.target).toBe(64);
    expect(next.corrected!).toBeGreaterThan(64.2); // fresh glide from the sung pitch
  });
});
