import { describe, expect, it } from 'vitest';
import { analyzeInstrumental, downmix, estimateKey, estimateTempo } from '../src/dsp/analyze';
import { midiToFreq } from '../src/dsp/notes';

const SR = 22050;

/** A few harmonics per note, so it sounds (and analyses) like an instrument rather than pure sines. */
function addNote(out: Float32Array, midi: number, t0: number, dur: number, amp = 0.12): void {
  const f = midiToFreq(midi);
  const s0 = Math.round(t0 * SR);
  const n = Math.round(dur * SR);
  for (let i = 0; i < n && s0 + i < out.length; i++) {
    const env = Math.min(1, i / 200) * Math.min(1, (n - i) / 400);
    let v = 0;
    for (let h = 1; h <= 4; h++) v += Math.sin((2 * Math.PI * f * h * i) / SR) / h;
    out[s0 + i] += amp * env * v;
  }
}

/** Block chords (root position triads + bass), one per `secondsPerChord`. */
function progression(chords: number[][], secondsPerChord: number, repeats = 3): Float32Array {
  const out = new Float32Array(Math.round(chords.length * secondsPerChord * repeats * SR));
  let t = 0;
  for (let r = 0; r < repeats; r++) {
    for (const chord of chords) {
      for (const m of chord) addNote(out, m, t, secondsPerChord);
      addNote(out, chord[0] - 12, t, secondsPerChord, 0.18); // bass
      t += secondsPerChord;
    }
  }
  return out;
}

/** Kick-like clicks (decaying low thump + noise burst) at a tempo. */
function clickTrack(bpm: number, seconds: number): Float32Array {
  const out = new Float32Array(Math.round(seconds * SR));
  let seed = 7;
  const beat = 60 / bpm;
  for (let t = 0; t < seconds; t += beat) {
    const s0 = Math.round(t * SR);
    for (let i = 0; i < 2000 && s0 + i < out.length; i++) {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      const decay = Math.exp(-i / 300);
      out[s0 + i] += decay * (0.6 * Math.sin((2 * Math.PI * 60 * i) / SR) + 0.3 * ((seed / 0x7fffffff) * 2 - 1));
    }
  }
  return out;
}

describe('key detection', () => {
  it('finds C major from I–IV–V–I', () => {
    const x = progression([[60, 64, 67], [65, 69, 72], [67, 71, 74], [60, 64, 67]], 1);
    expect(estimateKey(x, SR)?.scale).toEqual({ root: 0, type: 'major' });
  });

  it('finds A minor from i–iv–V–i', () => {
    const x = progression([[57, 60, 64], [62, 65, 69], [64, 68, 71], [57, 60, 64]], 1);
    expect(estimateKey(x, SR)?.scale).toEqual({ root: 9, type: 'minor' });
  });

  it('finds keys away from C (E♭ major)', () => {
    const x = progression([[63, 67, 70], [68, 72, 75], [70, 74, 77], [63, 67, 70]], 1);
    expect(estimateKey(x, SR)?.scale).toEqual({ root: 3, type: 'major' });
  });

  it('returns null for silence', () => {
    expect(estimateKey(new Float32Array(SR * 2), SR)).toBeNull();
  });
});

describe('tempo detection', () => {
  it.each([90, 100, 120, 128, 140])('finds %d BPM within 2%', (bpm) => {
    const t = estimateTempo(clickTrack(bpm, 12), SR);
    expect(t).not.toBeNull();
    expect(Math.abs(t!.bpm - bpm) / bpm).toBeLessThan(0.02);
    expect(t!.confidence).toBeGreaterThan(1.5);
  });

  it('needs a few bars of audio', () => {
    expect(estimateTempo(clickTrack(120, 1.5), SR)).toBeNull();
  });
});

describe('analyzeInstrumental', () => {
  it('handles a full-rate stereo mix (chords + beat)', () => {
    const rate = 44100;
    const harmony = progression([[57, 60, 64], [62, 65, 69], [64, 68, 71], [57, 60, 64]], 2, 2); // at SR
    const beat = clickTrack(96, 16);
    // Resample both to 44.1 kHz by sample-repeat (fine for a test) and make a stereo pair.
    const n = Math.min(harmony.length, beat.length) * 2;
    const left = new Float32Array(n);
    const right = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      left[i] = harmony[i >> 1] + 0.7 * beat[i >> 1];
      right[i] = harmony[i >> 1] + 0.5 * beat[i >> 1];
    }
    const r = analyzeInstrumental(downmix([left, right]), rate);
    expect(r.key?.scale).toEqual({ root: 9, type: 'minor' });
    expect(Math.abs(r.tempo!.bpm - 96)).toBeLessThan(2);
  });
});
