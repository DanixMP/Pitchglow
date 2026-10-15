import { describe, expect, it } from 'vitest';
import type { PitchFrame } from '../src/audio/pitch-tracker';
import { ClickTrack, type ClickGrid } from '../src/dsp/click';
import {
  alignToBeat,
  barNumberAt,
  clickGridOf,
  countInLead,
  gridLines,
  gridOf,
  normalizeDownbeat,
  snapToGrid,
  takeOnset,
  tapTempo,
  type Grid,
} from '../src/project/grid';
import { defaultLoop, normalizeLoop, snapOffset } from '../src/project/model';

const g120: Grid = { bpm: 120, beatsPerBar: 4, downbeat: 0 };

describe('tempo grid', () => {
  it('builds a grid only with a tempo, and a default one for the click', () => {
    expect(gridOf({ bpm: null })).toBeNull();
    expect(gridOf({ bpm: 90, beatsPerBar: 3, downbeat: 0.2 })).toEqual({ bpm: 90, beatsPerBar: 3, downbeat: 0.2 });
    expect(clickGridOf({})).toEqual({ bpm: 100, beatsPerBar: 4, downbeat: 0 });
  });

  it('snaps to beats and subdivisions anchored at the downbeat', () => {
    const g = { ...g120, downbeat: 0.1 };
    expect(snapToGrid(0.33, g, 1, 0.1)).toBe(0.1);
    expect(snapToGrid(0.4, g, 1, 0.1)).toBe(0.6);
    expect(snapToGrid(0.4, g, 0.25, 0.1)).toBe(0.35); // 1/16 = 0.125 s from 0.1
    expect(snapToGrid(1.234, null, 1, 0.1)).toBe(1.2);
  });

  it('numbers bars from the downbeat and normalises it into one bar', () => {
    const g = { ...g120, downbeat: 0.5 };
    expect(barNumberAt(0.5, g)).toBe(1);
    expect(barNumberAt(2.49, g)).toBe(1);
    expect(barNumberAt(2.5, g)).toBe(2);
    expect(barNumberAt(0.2, g)).toBe(0);
    expect(normalizeDownbeat(4.75, g120)).toBe(0.75); // bars of 2 s
    expect(normalizeDownbeat(-0.5, g120)).toBe(1.5);
    expect(normalizeDownbeat(4, g120)).toBe(0);
  });

  it('lists beat lines with bar numbers, thinning to bars when crowded', () => {
    const lines = gridLines(0, 2, g120);
    expect(lines.map((l) => l.time)).toEqual([0, 0.5, 1, 1.5, 2]);
    expect(lines.map((l) => l.bar)).toEqual([1, null, null, null, 2]);
    const bars = gridLines(0, 16, g120, 1); // beats 0.5 s < 1 s: bars only
    expect(bars.every((l) => l.bar !== null)).toBe(true);
    expect(bars.map((l) => l.time)).toEqual([0, 2, 4, 6, 8, 10, 12, 14, 16]);
    const sparse = gridLines(0, 16, g120, 5); // bars every 8 s
    expect(sparse.map((l) => l.bar)).toEqual([1, 5, 9]);
    expect(gridLines(-1, 0, g120).map((l) => l.bar)).toEqual([null, null, 1]); // beats before bar 1
  });

  it('places the count-in on the beats of the bar before the position', () => {
    expect(countInLead(0, g120)).toBeCloseTo(2);
    expect(countInLead(4, g120)).toBeCloseTo(2);
    expect(countInLead(4.2, g120)).toBeCloseTo(1.7); // first beat at 2.5 → clicks 2.5, 3, 3.5, 4
  });

  it('taps a tempo and starts over after a pause', () => {
    expect(tapTempo([1])).toBeNull();
    expect(tapTempo([1, 1.5, 2, 2.5])).toBe(120);
    expect(tapTempo([0, 0.5, 5, 5.6, 6.2])).toBe(100); // the 4.5 s pause resets
    const many = Array.from({ length: 20 }, (_, i) => i * 0.6);
    expect(tapTempo(many)).toBe(100);
    expect(tapTempo([0, 0.1])).toBe(240); // clamped
  });

  it('finds where the singing starts and aligns it to the nearest beat', () => {
    const frames: PitchFrame[] = Array.from({ length: 100 }, (_, i) => ({
      time: i * 0.01,
      freq: i >= 40 ? 220 : null,
      midi: i >= 40 ? 57 : null,
      clarity: i >= 40 ? 0.9 : 0,
      rms: i >= 38 ? 0.2 : 0.002,
    }));
    expect(takeOnset(frames)).toBeCloseTo(0.38);
    expect(takeOnset([])).toBeNull();
    // Clip at 1.0 s, singing starts 0.38 s in = 1.38 → nearest beat 1.5 → clip moves to 1.12.
    expect(alignToBeat(1, 0.38, g120)).toBe(1.12);
    expect(alignToBeat(-2, 2.1, g120)).toBe(-2.1); // 0.1 → 0
  });

  it('snaps clips and loops to a grid with a downbeat (and still takes a BPM)', () => {
    const g = { ...g120, downbeat: 0.1 };
    expect(snapOffset(0.33, g)).toBe(0.35);
    expect(snapOffset(0.33, 120)).toBe(0.375);
    expect(normalizeLoop(0.4, 2.3, g, 10)).toEqual({ start: 0.6, end: 2.1 });
    expect(defaultLoop(3, g, 20)).toEqual({ start: 2.1, end: 6.1 });
  });
});

describe('click track', () => {
  const sr = 1000;
  const grid: ClickGrid = { beatSamples: 250, downbeatSample: 0, beatsPerBar: 4, accent: true };
  const onsets = (out: Float32Array) => {
    const at: number[] = [];
    for (let i = 0; i < out.length; i++) if (out[i] !== 0 && (i === 0 || out[i - 1] === 0)) at.push(i);
    return at;
  };

  it('clicks on every beat, accenting bar downbeats', () => {
    const c = new ClickTrack(sr, grid);
    const out = new Float32Array(1100);
    c.render(out, 0, 0, 1100);
    // A click starts at 0 with a zero sample (sine), so look for the first non-zero sample after it.
    const starts = [0, 250, 500, 750, 1000].map((b) => out.slice(b, b + 5).some((v) => v !== 0));
    expect(starts).toEqual([true, true, true, true, true]);
    const peak = (from: number) => Math.max(...out.slice(from, from + 40).map(Math.abs));
    expect(peak(0)).toBeGreaterThan(peak(250) * 1.2);
    expect(peak(1000)).toBeGreaterThan(peak(750) * 1.2);
  });

  it('renders the same in blocks as in one go, and follows loop wraps', () => {
    const whole = new Float32Array(1000);
    new ClickTrack(sr, grid).render(whole, 0, 100, 1000);
    const blocks = new Float32Array(1000);
    const c = new ClickTrack(sr, grid);
    for (let i = 0; i < 1000; i += 128) c.render(blocks, i, 100 + i, Math.min(128, 1000 - i));
    expect(blocks).toEqual(whole);
    // Loop 600..900: after the wrap the beat at 750 clicks again, no double click at the seam.
    const looped = new Float32Array(600);
    const l = new ClickTrack(sr, grid);
    l.render(looped, 0, 600, 300);
    l.render(looped, 300, 600, 300);
    expect(onsets(looped).filter((i) => i % 300 > 100 && i % 300 < 200).length).toBe(2);
  });

  it('only counts in before `before`, and clicks on beats before bar 1', () => {
    const c = new ClickTrack(sr, { ...grid, downbeatSample: 10 });
    const out = new Float32Array(1000);
    c.render(out, 0, -490, 1000, 0); // song -0.49..0.51 s; clicks only before 0
    expect(c.beatSample(-2)).toBe(-490);
    expect(out.slice(0, 40).some((v) => v !== 0)).toBe(true); // -490
    expect(out.slice(250, 290).some((v) => v !== 0)).toBe(true); // -240
    expect(out.slice(500, 1000).some((v) => v !== 0)).toBe(false); // beats from 10 on are silent
  });
});
