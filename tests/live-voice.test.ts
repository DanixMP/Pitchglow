import { describe, expect, it } from 'vitest';
import { freqToMidi } from '../src/dsp/notes';
import { LIVE_DELAY_SECONDS, LiveVoice, type LiveSettings } from '../src/dsp/live-voice';
import { Yin } from '../src/dsp/yin';
import { sawtooth } from './signals';

const SR = 48000;
const BLOCK = 128;

/** Runs a signal through LiveVoice in 128-sample blocks (like an AudioWorklet). */
function run(x: Float32Array, settings: LiveSettings): { out: Float32Array; voice: LiveVoice } {
  const voice = new LiveVoice(SR);
  voice.setSettings(settings);
  const out = new Float32Array(x.length);
  const block = new Float32Array(BLOCK);
  for (let s = 0; s + BLOCK <= x.length; s += BLOCK) {
    voice.process(x.subarray(s, s + BLOCK), block);
    out.set(block, s);
  }
  return { out, voice };
}

/** Median detected pitch (Hz) over [from, to) seconds. */
function pitchOf(y: Float32Array, from: number, to: number): number {
  const yin = new Yin(SR);
  const est: number[] = [];
  for (let s = Math.round(from * SR); s + yin.frameLength < to * SR; s += 480) {
    const e = yin.detect(y.subarray(s, s + yin.frameLength));
    if (e) est.push(e.freq);
  }
  est.sort((a, b) => a - b);
  return est[est.length >> 1];
}

const cents = (a: number, b: number) => 1200 * Math.log2(a / b);

function rms(y: Float32Array, from: number, to: number): number {
  let s = 0;
  const a = Math.round(from * SR);
  const b = Math.round(to * SR);
  for (let i = a; i < b; i++) s += y[i] * y[i];
  return Math.sqrt(s / (b - a));
}

/** Magnitude of one frequency (Goertzel) over a stretch. */
function toneLevel(y: Float32Array, freq: number, from: number, to: number): number {
  const a = Math.round(from * SR);
  const b = Math.round(to * SR);
  const w = (2 * Math.PI * freq) / SR;
  let re = 0;
  let im = 0;
  for (let i = a; i < b; i++) {
    re += y[i] * Math.cos(w * i);
    im -= y[i] * Math.sin(w * i);
  }
  return Math.hypot(re, im) / (b - a);
}

describe('LiveVoice', () => {
  it('passes the input straight through when there is nothing to do', () => {
    const x = sawtooth(150, SR, 0.5, 0.4);
    const { out } = run(x, { tune: null, semitones: 0 });
    expect(out.subarray(0, Math.floor(x.length / BLOCK) * BLOCK)).toEqual(x.subarray(0, Math.floor(x.length / BLOCK) * BLOCK));
  });

  it('transposes a steady voice in real time, within a few cents', () => {
    const x = sawtooth(150, SR, 1.5, 0.4);
    for (const st of [1, 3, -4, 7, 12]) {
      const { out } = run(x, { tune: null, semitones: st });
      const f = pitchOf(out, 0.5, 1.4);
      expect(Math.abs(cents(f, 150 * Math.pow(2, st / 12)))).toBeLessThan(8);
      // Level stays about the same for small shifts. (Shifting a sawtooth an octave up cancels its odd
      // harmonics, three quarters of its energy, in any PSOLA; the offline engine does the same.)
      if (Math.abs(st) <= 4) {
        expect(rms(out, 0.5, 1.4) / rms(x, 0.5, 1.4)).toBeGreaterThan(0.8);
        expect(rms(out, 0.5, 1.4) / rms(x, 0.5, 1.4)).toBeLessThan(1.2);
      }
    }
    // An octave down: a new 75 Hz component appears (YIN would lock onto the repeated 150 Hz cycles).
    const down = run(x, { tune: null, semitones: -12 }).out;
    expect(toneLevel(down, 75, 0.5, 1.4)).toBeGreaterThan(20 * toneLevel(x, 75, 0.5, 1.4));
  });

  it('is delayed by exactly the live delay', () => {
    // Silence, then a tone: the output's onset comes LIVE_DELAY_SECONDS after the input's.
    const x = new Float32Array(SR);
    x.set(sawtooth(150, SR, 0.5, 0.4), SR / 2);
    const { out, voice } = run(x, { tune: null, semitones: 2 });
    expect(voice.delay).toBe(Math.round(SR * LIVE_DELAY_SECONDS));
    let onset = 0;
    while (onset < out.length && Math.abs(out[onset]) < 0.05) onset++;
    let inOnset = 0;
    while (Math.abs(x[inOnset]) < 0.05) inOnset++;
    expect(Math.abs(onset - inOnset - voice.delay)).toBeLessThan(SR * 0.003);
  });

  it('auto-tunes an off-key voice onto the nearest scale note', () => {
    // 150 Hz is between D3 (146.8 Hz) and D#3; in C major it should land on D3.
    const x = sawtooth(150, SR, 1.5, 0.4);
    const { out } = run(x, { tune: { scale: { root: 0, type: 'major' }, retuneMs: 0 }, semitones: 0 });
    const f = pitchOf(out, 0.5, 1.4);
    expect(Math.abs(cents(f, 146.83))).toBeLessThan(10);
    expect(Math.round(freqToMidi(f))).toBe(50);
  });

  it('adds a harmony voice a diatonic third up', () => {
    const x = sawtooth(146.83, SR, 1.5, 0.3); // D3
    const plain = run(x, { tune: { scale: { root: 0, type: 'major' }, retuneMs: 0 }, semitones: 0 }).out;
    const harm = run(x, { tune: { scale: { root: 0, type: 'major' }, retuneMs: 0, harmony: { voices: ['thirdUp'], mix: 0.7 } }, semitones: 0 }).out;
    const f3 = 174.61; // F3: a third up from D in C major
    expect(toneLevel(harm, f3, 0.5, 1.4)).toBeGreaterThan(10 * toneLevel(plain, f3, 0.5, 1.4));
  });

  it('reports pitch frames for the pitch line, with their positions', () => {
    const x = sawtooth(220, SR, 0.5, 0.4);
    const voice = new LiveVoice(SR);
    const frames: number[] = [];
    voice.onFrame = (f, pos) => {
      if (f.freq) frames.push(pos);
    };
    voice.setSettings({ tune: null, semitones: 0 });
    const out = new Float32Array(BLOCK);
    for (let s = 0; s + BLOCK <= x.length; s += BLOCK) voice.process(x.subarray(s, s + BLOCK), out);
    expect(frames.length).toBeGreaterThan(30);
    expect(frames[1] - frames[0]).toBeCloseTo(SR * 0.01, -1);
  });

  it('runs well within real time (lead + 3 harmonies)', () => {
    const x = sawtooth(150, SR, 4, 0.3);
    const t0 = performance.now();
    run(x, { tune: { scale: { root: 0, type: 'major' }, retuneMs: 30, harmony: { voices: ['thirdUp', 'fifthUp', 'octaveDown'], mix: 0.6 } }, semitones: 0 });
    const ms = performance.now() - t0;
    expect(ms / 4).toBeLessThan(250); // < 25% of one core per second of audio, in tests
  });
});
