import { describe, expect, it } from 'vitest';
import { PitchTracker, type PitchFrame } from '../src/audio/pitch-tracker';
import { FFT } from '../src/dsp/fft';
import { renderWithHarmony } from '../src/dsp/harmony';
import { LiveVoice } from '../src/dsp/live-voice';
import { analyzePsola, renderGrains } from '../src/dsp/psola';
import { ENGINE_BLOCK, monotoneCorrections, planVoices, VoiceRenderer, type VoiceCharacter } from '../src/dsp/voice-engine';
import { Yin } from '../src/dsp/yin';
import { sawtooth } from './signals';

const SR = 48000;

function track(signal: Float32Array): PitchFrame[] {
  const frames: PitchFrame[] = [];
  const tracker = new PitchTracker(SR, (f) => frames.push(f));
  for (let i = 0; i < signal.length; i += 512) tracker.push(signal.subarray(i, i + 512));
  return frames;
}

/** A vowel-ish tone: a 150 Hz buzz through a resonance (formant) at `formantHz`. */
function vowel(formantHz = 800, seconds = 1.5, f0 = 150): Float32Array {
  const x = sawtooth(f0, SR, seconds, 0.5);
  const w0 = (2 * Math.PI * formantHz) / SR;
  const alpha = Math.sin(w0) / (2 * 4);
  const a0 = 1 + alpha;
  const b0 = alpha / a0;
  const a1 = (-2 * Math.cos(w0)) / a0;
  const a2 = (1 - alpha) / a0;
  const y = new Float32Array(x.length);
  let x1 = 0, x2 = 0, y1 = 0, y2 = 0;
  for (let i = 0; i < x.length; i++) {
    const v = b0 * x[i] - b0 * x2 - a1 * y1 - a2 * y2;
    x2 = x1;
    x1 = x[i];
    y2 = y1;
    y1 = v;
    y[i] = v;
  }
  let peak = 0;
  for (const v of y) peak = Math.max(peak, Math.abs(v));
  for (let i = 0; i < y.length; i++) y[i] *= 0.4 / peak;
  return y;
}

/** Spectral centroid (Hz) of [from, from + 8192) — a stand-in for "where the formants are". */
function centroid(y: Float32Array, from: number): number {
  const n = 8192;
  const fft = new FFT(n);
  const re = new Float64Array(n);
  const im = new Float64Array(n);
  for (let i = 0; i < n; i++) re[i] = y[from + i] * (0.5 - 0.5 * Math.cos((2 * Math.PI * i) / n));
  fft.forward(re, im);
  let num = 0;
  let den = 0;
  for (let k = 1; k < n / 2; k++) {
    const m = Math.hypot(re[k], im[k]);
    num += m * (k * SR) / n;
    den += m;
  }
  return num / den;
}

function pitchAndClarity(y: Float32Array, from: number, to: number): { freq: number; voiced: number } {
  const yin = new Yin(SR);
  const est: number[] = [];
  let tries = 0;
  for (let s = from; s + yin.frameLength < to; s += 960) {
    tries++;
    const e = yin.detect(y.subarray(s, s + yin.frameLength));
    if (e && e.clarity > 0.8) est.push(e.freq);
  }
  est.sort((a, b) => a - b);
  return { freq: est[est.length >> 1] ?? 0, voiced: est.length / tries };
}

function rms(y: Float32Array, a: number, b: number): number {
  let s = 0;
  for (let i = a; i < b; i++) s += y[i] * y[i];
  return Math.sqrt(s / (b - a));
}

const voice = (v: Partial<VoiceCharacter>): VoiceCharacter => ({ formant: 0, whisper: 0, monotone: false, ...v });

describe('voice character (offline / playback engine)', () => {
  const x = vowel();
  const frames = track(x);
  const mid = SR / 2;

  it('formant shift moves the vowel colour but not the pitch', () => {
    const up = renderWithHarmony(x, SR, frames, null, 0, voice({ formant: 5 }));
    const down = renderWithHarmony(x, SR, frames, null, 0, voice({ formant: -5 }));
    const c0 = centroid(x, mid);
    expect(centroid(up, mid) / c0).toBeGreaterThan(1.15);
    expect(centroid(down, mid) / c0).toBeLessThan(0.87);
    for (const y of [up, down]) {
      const p = pitchAndClarity(y, mid, SR * 1.3).freq;
      expect(Math.abs(1200 * Math.log2(p / 150))).toBeLessThan(10);
      expect(rms(y, mid, SR) / rms(x, mid, SR)).toBeGreaterThan(0.6);
    }
  });

  it('whisper keeps the level but loses the pitch', () => {
    const w = renderWithHarmony(x, SR, frames, null, 0, voice({ whisper: 1 }));
    expect(pitchAndClarity(x, mid, SR * 1.3).voiced).toBeGreaterThan(0.9);
    expect(pitchAndClarity(w, mid, SR * 1.3).voiced).toBeLessThan(0.3);
    const level = rms(w, mid, SR) / rms(x, mid, SR);
    expect(level).toBeGreaterThan(0.5);
    expect(level).toBeLessThan(1.6);
  });

  it('robot holds each phrase on its first note', () => {
    // A glide from 150 to 200 Hz; the robot keeps the starting note (D3 = MIDI 50).
    const g = new Float32Array(SR * 1.5);
    let phase = 0;
    for (let i = 0; i < g.length; i++) {
      const f = 150 + (50 * i) / g.length;
      for (let h = 1; h <= 15; h++) g[i] += (0.4 / h) * Math.sin(2 * Math.PI * h * phase);
      phase += f / SR;
    }
    const gf = track(g);
    const c = monotoneCorrections(gf, null);
    const notes = new Set(c.filter((x) => x.corrected !== null).map((x) => x.corrected));
    expect([...notes]).toEqual([50]);
    const y = renderWithHarmony(g, SR, gf, null, 0, voice({ monotone: true }));
    const late = pitchAndClarity(y, SR, SR * 1.4).freq; // the input is near 190 Hz here
    expect(Math.abs(1200 * Math.log2(late / 146.83))).toBeLessThan(15);
  });

  it('shaped grains render the same block by block as all at once', () => {
    const plans = planVoices(analyzePsola(x, SR, frames), frames, null, 2, voice({ formant: 3, whisper: 0.5 }))!;
    const whole = new Float32Array(x.length);
    renderGrains(x, plans.lead, 0, x.length, whole, new Float32Array(x.length));
    const r = new VoiceRenderer();
    r.setSource(x);
    r.setPlans(plans);
    const blocks = new Float32Array(x.length);
    for (let s = 0; s < x.length; s += ENGINE_BLOCK) r.render(s, Math.min(ENGINE_BLOCK, x.length - s), blocks, s);
    expect(blocks).toEqual(whole);
  });
});

describe('voice character (live)', () => {
  function live(x: Float32Array, v: VoiceCharacter, semitones = 0): Float32Array {
    const lv = new LiveVoice(SR);
    lv.setSettings({ tune: null, semitones, voice: v });
    const out = new Float32Array(x.length);
    const block = new Float32Array(128);
    for (let s = 0; s + 128 <= x.length; s += 128) {
      lv.process(x.subarray(s, s + 128), block);
      out.set(block, s);
    }
    return out;
  }

  it('shifts formants while you sing, keeping the pitch', () => {
    const x = vowel();
    const up = live(x, voice({ formant: 5 }));
    expect(centroid(up, SR / 2) / centroid(x, SR / 2)).toBeGreaterThan(1.15);
    const p = pitchAndClarity(up, SR / 2, SR * 1.3).freq;
    expect(Math.abs(1200 * Math.log2(p / 150))).toBeLessThan(10);
  });

  it('whispers live', () => {
    const x = vowel();
    const w = live(x, voice({ whisper: 1 }));
    expect(pitchAndClarity(w, SR / 2, SR * 1.3).voiced).toBeLessThan(0.3);
    expect(rms(w, SR / 2, SR) / rms(x, SR / 2, SR)).toBeGreaterThan(0.5);
  });
});
