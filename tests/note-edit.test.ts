import { describe, expect, it } from 'vitest';
import { PitchTracker, type PitchFrame } from '../src/audio/pitch-tracker';
import { applyNoteEdits, buildWarp, segmentNotes, warpToOutput, warpToSource, type NoteEdit } from '../src/dsp/note-edit';
import { analyzePsola, renderGrains } from '../src/dsp/psola';
import { planVoices } from '../src/dsp/voice-engine';
import { sawtooth } from './signals';

const SR = 44100;

function track(signal: Float32Array): PitchFrame[] {
  const frames: PitchFrame[] = [];
  const tracker = new PitchTracker(SR, (f) => frames.push(f));
  for (let i = 0; i < signal.length; i += 512) tracker.push(signal.subarray(i, i + 512));
  return frames;
}

/** Silence, note A (203 Hz), a gap, note B (151 Hz), silence. */
function phrase(): Float32Array {
  const lead = Math.round(0.2 * SR);
  const gap = Math.round(0.15 * SR);
  const a = sawtooth(203, SR, 0.5, 0.3);
  const b = sawtooth(151, SR, 0.5, 0.3);
  const x = new Float32Array(lead + a.length + gap + b.length + lead);
  x.set(a, lead);
  x.set(b, lead + a.length + gap);
  return x;
}

/** Synthetic pitch frames (10 ms hop) from a list of [midi | null, frames]. */
function framesOf(parts: [number | null, number][], vibrato = 0): PitchFrame[] {
  const out: PitchFrame[] = [];
  for (const [midi, n] of parts) {
    for (let i = 0; i < n; i++) {
      const t = out.length * 0.01;
      const m = midi === null ? null : midi + vibrato * Math.sin(2 * Math.PI * 5.5 * t);
      out.push({ time: t, freq: m === null ? null : 440 * Math.pow(2, (m - 69) / 12), midi: m, clarity: m === null ? 0 : 0.9, rms: m === null ? 0 : 0.2 });
    }
  }
  return out;
}

function render(x: Float32Array, frames: PitchFrame[], edits: NoteEdit[]): Float32Array {
  const plans = planVoices(analyzePsola(x, SR, frames), frames, null, 0, undefined, edits)!;
  const out = new Float32Array(x.length);
  renderGrains(x, plans.lead, 0, x.length, out, new Float32Array(x.length));
  return out;
}

/** Median pitch (Hz) of the voiced frames between two times. */
function pitchBetween(frames: PitchFrame[], from: number, to: number): number {
  const f = frames.filter((x) => x.time >= from && x.time <= to && x.freq !== null).map((x) => x.freq!).sort((a, b) => a - b);
  return f[f.length >> 1];
}

/** First time the 5 ms RMS goes over a threshold (after `from`). */
function onset(x: Float32Array, from = 0, threshold = 0.05): number {
  const w = Math.round(0.005 * SR);
  for (let i = Math.round(from * SR); i + w < x.length; i += w) {
    let e = 0;
    for (let k = 0; k < w; k++) e += x[i + k] * x[i + k];
    if (Math.sqrt(e / w) > threshold) return i / SR;
  }
  return Infinity;
}

const cents = (a: number, b: number) => 1200 * Math.log2(a / b);

describe('note segmentation', () => {
  it('splits a melody into its notes, keeping vibrato inside one note', () => {
    const frames = framesOf([[null, 5], [57, 30], [60, 40], [64, 25], [null, 10], [62, 30]], 0.4);
    const notes = segmentNotes(frames);
    expect(notes.map((n) => Math.round(n.pitch))).toEqual([57, 60, 64, 62]);
    expect(notes[0].from).toBe(5);
    expect(notes[3].to).toBe(frames.length);
    expect(notes[1].start).toBeCloseTo(0.345, 2);
  });

  it('merges blips shorter than 60 ms into a neighbour', () => {
    const notes = segmentNotes(framesOf([[57, 30], [61, 4], [57, 30]]));
    expect(notes.length).toBe(1);
  });

  it('finds the two sung notes of a real take', () => {
    const notes = segmentNotes(track(phrase()));
    expect(notes.length).toBe(2);
    expect(Math.abs(cents(440 * Math.pow(2, (notes[0].pitch - 69) / 12), 203))).toBeLessThan(15);
    expect(notes[0].start).toBeGreaterThan(0.17);
    expect(notes[1].start).toBeGreaterThan(0.83);
  });
});

describe('pitch edits', () => {
  const frames = framesOf([[57.3, 30], [60, 30]]);
  const raw = frames.map((f) => ({ target: null, corrected: f.midi }));

  it('moves a note by semitones and leaves the others alone', () => {
    const out = applyNoteEdits(frames, raw, [{ from: 30, to: 60, shift: 2, amount: null }]);
    expect(out[10].corrected).toBeCloseTo(57.3);
    expect(out[40].corrected).toBeCloseTo(62);
  });

  it('pulls a note onto its pitch by the amount', () => {
    const half = applyNoteEdits(frames, raw, [{ from: 0, to: 30, shift: 0, amount: 0.5 }]);
    expect(half[10].corrected).toBeCloseTo(57.15);
    const full = applyNoteEdits(frames, raw, [{ from: 0, to: 30, shift: -1, amount: 1 }]);
    expect(full[10].corrected).toBeCloseTo(56);
    expect(full[10].target).toBe(56);
  });

  it('moves a note of a real take to the new pitch (within 10 cents)', () => {
    const x = phrase();
    const frames = track(x);
    const [, b] = segmentNotes(frames);
    const out = render(x, frames, [{ from: b.from, to: b.to, shift: 3, amount: null }]);
    const heard = track(out);
    expect(Math.abs(cents(pitchBetween(heard, 0.3, 0.6), 203))).toBeLessThan(10); // A untouched
    expect(Math.abs(cents(pitchBetween(heard, 0.95, 1.25), 151 * Math.pow(2, 3 / 12)))).toBeLessThan(10);
  });
});

describe('timing edits', () => {
  it('builds a forward-running warp: the edited note moves, the others stay', () => {
    const frames = framesOf([[null, 20], [57, 50], [null, 15], [60, 50], [null, 20]]);
    const notes = segmentNotes(frames);
    const sr = 1000;
    const w = buildWarp(notes, [{ from: notes[0].from, to: notes[0].to, shift: 0, amount: null, start: notes[0].start + 0.06, end: notes[0].end + 0.06 }], sr, 1550)!;
    expect(warpToSource(w, (notes[0].start + 0.06) * sr)).toBeCloseTo(notes[0].start * sr);
    expect(warpToSource(w, (notes[1].start + 0.01) * sr)).toBeCloseTo((notes[1].start + 0.01) * sr); // B in place
    for (let i = 1; i < w.out.length; i++) {
      expect(w.out[i]).toBeGreaterThan(w.out[i - 1]);
      expect(w.src[i]).toBeGreaterThan(w.src[i - 1]);
    }
    expect(warpToOutput(w, warpToSource(w, 700))).toBeCloseTo(700);
    expect(buildWarp(notes, [{ from: notes[0].from, to: notes[0].to, shift: 1, amount: null }], sr, 1550)).toBeNull();
  });

  it('moves a sung note later and stretches another, keeping their pitch', () => {
    const x = phrase();
    const frames = track(x);
    const [a, b] = segmentNotes(frames);
    const out = render(x, frames, [
      { from: a.from, to: a.to, shift: 0, amount: null, start: a.start + 0.06, end: a.end + 0.06 },
      { from: b.from, to: b.to, shift: 0, amount: null, start: b.start, end: b.end + 0.1 },
    ]);
    expect(out.length).toBe(x.length);
    expect(onset(out) - onset(x)).toBeCloseTo(0.06, 1);
    expect(Math.abs(onset(out, 0.8) - onset(x, 0.8))).toBeLessThan(0.012); // B starts where it did (A now ends at 0.76)
    const heard = track(out);
    expect(Math.abs(cents(pitchBetween(heard, 0.35, 0.65), 203))).toBeLessThan(10);
    expect(Math.abs(cents(pitchBetween(heard, 1.0, 1.4), 151))).toBeLessThan(10);
    // B now lasts ~0.1 s longer: still voiced 50 ms after its old end.
    const late = heard.filter((f) => f.time > b.end + 0.03 && f.time < b.end + 0.07);
    expect(late.filter((f) => f.freq !== null).length).toBeGreaterThan(late.length / 2);
  });

  it('renders the same in blocks as in one go with a warp', () => {
    const x = phrase();
    const frames = track(x);
    const [a] = segmentNotes(frames);
    const plans = planVoices(analyzePsola(x, SR, frames), frames, null, 0, undefined, [
      { from: a.from, to: a.to, shift: 1, amount: null, start: a.start + 0.03, end: a.end + 0.08 },
    ])!;
    const whole = new Float32Array(x.length);
    renderGrains(x, plans.lead, 0, x.length, whole, new Float32Array(x.length));
    const out = new Float32Array(x.length);
    const block = new Float32Array(128);
    const scratch = new Float32Array(128);
    for (let s = 0; s < x.length; s += 128) {
      const e = Math.min(x.length, s + 128);
      renderGrains(x, plans.lead, s, e, block, scratch);
      out.set(block.subarray(0, e - s), s);
    }
    expect(out).toEqual(whole);
  });
});
