import { describe, expect, it } from 'vitest';
import { PitchTracker, type PitchFrame } from '../src/audio/pitch-tracker';
import { addKeyEvent, keyNotes, keysAt, keyVoiceCount, voiceKey, type KeyEvent } from '../src/dsp/keys';
import { LiveVoice } from '../src/dsp/live-voice';
import { analyzePsola, renderGrains } from '../src/dsp/psola';
import { planVoices } from '../src/dsp/voice-engine';
import { sawtooth } from './signals';

const SR = 44100;

function track(signal: Float32Array, sr = SR): PitchFrame[] {
  const frames: PitchFrame[] = [];
  const tracker = new PitchTracker(sr, (f) => frames.push(f));
  for (let i = 0; i < signal.length; i += 512) tracker.push(signal.subarray(i, i + 512));
  return frames;
}

function toneLevel(y: Float32Array, freq: number, from: number, to: number, sr = SR): number {
  const a = Math.round(from * sr);
  const b = Math.round(to * sr);
  const w = (2 * Math.PI * freq) / sr;
  let re = 0;
  let im = 0;
  for (let i = a; i < b; i++) {
    re += y[i] * Math.cos(w * i);
    im -= y[i] * Math.sin(w * i);
  }
  return Math.hypot(re, im) / (b - a);
}

function rmsBetween(y: Float32Array, from: number, to: number): number {
  let e = 0;
  const a = Math.round(from * SR);
  const b = Math.round(to * SR);
  for (let i = a; i < b; i++) e += y[i] * y[i];
  return Math.sqrt(e / (b - a));
}

const hz = (m: number) => 440 * Math.pow(2, (m - 69) / 12);

describe('key maths', () => {
  it('voices keys near the sung note, or as played', () => {
    expect(voiceKey(64, 52.2, 'near')).toBe(52);
    expect(voiceKey(64, 52.2, 'played')).toBe(64);
    expect(voiceKey(48, 59, 'near')).toBe(60);
    // C3 and C4 both land on the same note near the voice: one voice; at most 4 voices.
    expect(keyNotes([48, 60, 64], 55, 'near')).toEqual([52, 60]);
    expect(keyNotes([60, 62, 64, 65, 67], 60, 'played')).toEqual([60, 62, 64, 65]);
  });

  it('records held-set changes and looks them up', () => {
    let ev: KeyEvent[] = [];
    ev = addKeyEvent(ev, 0.5, [64, 60]);
    ev = addKeyEvent(ev, 0.7, [60, 64]); // same set: no event
    ev = addKeyEvent(ev, 1.0, [60, 64, 67]);
    ev = addKeyEvent(ev, 1.5, []);
    expect(ev.map((e) => e.t)).toEqual([0.5, 1.0, 1.5]);
    expect(keysAt(ev, 0.2)).toEqual([]);
    expect(keysAt(ev, 0.5)).toEqual([60, 64]);
    expect(keysAt(ev, 1.2)).toEqual([60, 64, 67]);
    expect(keysAt(ev, 2)).toEqual([]);
    expect(keyVoiceCount(ev)).toBe(3);
    expect(addKeyEvent([], 0, [])).toEqual([]); // nothing held from the start: no event
  });
});

describe('key harmony in playback (plans)', () => {
  it('sings the held keys near the voice, keeping its expression, and is silent without keys', () => {
    const x = sawtooth(203, SR, 1.2, 0.3); // ≈ G#3 (55.8)
    const frames = track(x);
    const events: KeyEvent[] = [
      { t: 0, notes: [60, 64] },
      { t: 0.7, notes: [] },
    ];
    const plans = planVoices(analyzePsola(x, SR, frames), frames, null, 0, undefined, [], { events, voicing: 'near', mix: 0.6 })!;
    expect(plans.harmonies.length).toBe(2);
    const render = (k: number) => {
      const out = new Float32Array(x.length);
      renderGrains(x, plans.harmonies[k], 0, x.length, out, new Float32Array(x.length));
      return out;
    };
    const low = render(0);
    const high = render(1);
    // 55.8 sung: E (64) voiced near -> 52, C (60) -> 60; both 0.2 st flat like the voice.
    const sung = 69 + 12 * Math.log2(203 / 440);
    const dev = sung - Math.round(sung);
    for (const [y, note] of [[low, 52], [high, 60]] as const) {
      const at = toneLevel(y, hz(note + dev), 0.2, 0.6);
      expect(at).toBeGreaterThan(5 * toneLevel(y, hz(note + dev + 1), 0.2, 0.6));
      expect(at).toBeGreaterThan(5 * toneLevel(y, 203, 0.2, 0.6));
    }
    // Keys released at 0.7 s: the key voices stop.
    expect(rmsBetween(low, 0.8, 1.1)).toBeLessThan(0.05 * rmsBetween(low, 0.3, 0.6));
  });
});

describe('key harmony live (LiveVoice)', () => {
  it('a held key adds a voice on it; switching keys follows', () => {
    const sr = 48000;
    const x = sawtooth(146.83, sr, 1.6, 0.3); // D3
    const run = (keysOf: (t: number) => number[] | null) => {
      const voice = new LiveVoice(sr);
      voice.setSettings({ tune: null, semitones: 0 });
      const out = new Float32Array(x.length);
      const block = new Float32Array(128);
      let last = '';
      for (let s = 0; s + 128 <= x.length; s += 128) {
        const keys = keysOf(s / sr);
        if (JSON.stringify(keys) !== last) {
          voice.setKeys(keys, 'played', 0.7);
          last = JSON.stringify(keys);
        }
        voice.process(x.subarray(s, s + 128), block);
        out.set(block, s);
      }
      return out;
    };
    const plain = run(() => []);
    const keyed = run((t) => (t < 0.8 ? [57] : [59])); // A3, then B3
    expect(toneLevel(keyed, hz(57), 0.3, 0.75, sr)).toBeGreaterThan(10 * toneLevel(plain, hz(57), 0.3, 0.75, sr));
    expect(toneLevel(keyed, hz(59), 1.05, 1.5, sr)).toBeGreaterThan(10 * toneLevel(plain, hz(59), 1.05, 1.5, sr));
    expect(toneLevel(keyed, hz(59), 0.3, 0.75, sr)).toBeLessThan(0.2 * toneLevel(keyed, hz(57), 0.3, 0.75, sr));
  });
});
