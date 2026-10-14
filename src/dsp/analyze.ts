// Instrumental analysis: musical key (for the auto-tune scale) and tempo (for count-in / echo sync).
//
// Key: average chroma (energy per pitch class, 55 Hz–2 kHz) correlated against the 24 rotated
// Krumhansl–Kessler major/minor profiles; the best match wins.
// Tempo: spectral-flux onset envelope (~11.6 ms hops), autocorrelation over 60–200 BPM weighted by a
// log-normal prior around 110 BPM (to avoid half/double-tempo answers), parabolic peak refinement.

import { FFT } from './fft';
import { Decimator, decimationFactor } from './resample';
import type { Scale } from './scales';

export interface KeyEstimate {
  scale: Scale & { type: 'major' | 'minor' };
  /** Correlation of the winning profile (−1..1); below ~0.5 is a weak guess. */
  confidence: number;
}

export interface TempoEstimate {
  bpm: number;
  /** Peak-to-mean ratio of the weighted autocorrelation; ~1 = no clear beat. */
  confidence: number;
}

export interface AnalysisResult {
  key: KeyEstimate | null;
  tempo: TempoEstimate | null;
}

const MAJOR = [6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88];
const MINOR = [6.33, 2.68, 3.52, 5.38, 2.6, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17];

const ANALYSIS_RATE = 11025;
const KEY_FFT = 4096; // ~0.37 s at ~11 kHz: fine frequency resolution for low notes
const ONSET_FFT = 512;
const ONSET_HOP = 128; // ~11.6 ms at 11025 Hz

/** Mono-ises (average of channels) — instrumentals are usually stereo. */
export function downmix(channels: readonly Float32Array[]): Float32Array {
  if (channels.length === 1) return channels[0].slice();
  const out = new Float32Array(channels[0].length);
  for (const ch of channels) for (let i = 0; i < out.length; i++) out[i] += ch[i] / channels.length;
  return out;
}

export function analyzeInstrumental(samples: Float32Array, sampleRate: number): AnalysisResult {
  const factor = decimationFactor(sampleRate, ANALYSIS_RATE);
  const dec = new Decimator(sampleRate, factor, 63);
  const x = dec.process(samples);
  const rate = dec.outputRate;
  return { key: estimateKey(x, rate), tempo: estimateTempo(x, rate) };
}

// --- key ---------------------------------------------------------------------------------------

export function chroma(x: Float32Array, rate: number): Float64Array {
  const n = KEY_FFT;
  const fft = new FFT(n);
  const re = new Float64Array(n);
  const im = new Float64Array(n);
  const win = hann(n);
  const out = new Float64Array(12);
  // Map each FFT bin in range to a pitch class once.
  const binPc = new Int8Array(n / 2).fill(-1);
  for (let k = 1; k < n / 2; k++) {
    const f = (k * rate) / n;
    if (f < 55 || f > 2000) continue;
    const midi = 69 + 12 * Math.log2(f / 440);
    binPc[k] = ((Math.round(midi) % 12) + 12) % 12;
  }
  for (let start = 0; start + n <= x.length; start += n / 2) {
    for (let i = 0; i < n; i++) {
      re[i] = x[start + i] * win[i];
      im[i] = 0;
    }
    fft.forward(re, im);
    // Per-frame normalisation so loud passages don't dominate the key.
    const frame = new Float64Array(12);
    for (let k = 1; k < n / 2; k++) {
      const pc = binPc[k];
      if (pc >= 0) frame[pc] += Math.hypot(re[k], im[k]);
    }
    const total = frame.reduce((a, b) => a + b, 0);
    if (total > 1e-9) for (let c = 0; c < 12; c++) out[c] += frame[c] / total;
  }
  return out;
}

export function estimateKey(x: Float32Array, rate: number): KeyEstimate | null {
  const c = chroma(x, rate);
  if (c.every((v) => v === 0)) return null;
  let best: KeyEstimate | null = null;
  for (let root = 0; root < 12; root++) {
    for (const [type, profile] of [['major', MAJOR], ['minor', MINOR]] as const) {
      const rotated = profile.map((_, i) => profile[(i - root + 12) % 12]);
      const r = pearson(c, rotated);
      if (!best || r > best.confidence) best = { scale: { root, type }, confidence: r };
    }
  }
  return best;
}

// --- tempo -------------------------------------------------------------------------------------

/** Positive spectral flux per hop (log-compressed magnitudes), mean-removed. */
export function onsetEnvelope(x: Float32Array, rate: number): { env: Float64Array; hopSeconds: number } {
  const n = ONSET_FFT;
  const fft = new FFT(n);
  const re = new Float64Array(n);
  const im = new Float64Array(n);
  const win = hann(n);
  const frames = Math.max(0, Math.floor((x.length - n) / ONSET_HOP) + 1);
  const env = new Float64Array(frames);
  let prev = new Float64Array(n / 2);
  let cur = new Float64Array(n / 2);
  for (let f = 0; f < frames; f++) {
    const start = f * ONSET_HOP;
    for (let i = 0; i < n; i++) {
      re[i] = x[start + i] * win[i];
      im[i] = 0;
    }
    fft.forward(re, im);
    let flux = 0;
    for (let k = 1; k < n / 2; k++) {
      cur[k] = Math.log1p(100 * Math.hypot(re[k], im[k]));
      flux += Math.max(0, cur[k] - prev[k]);
    }
    env[f] = f === 0 ? 0 : flux;
    [prev, cur] = [cur, prev];
  }
  const mean = env.reduce((a, b) => a + b, 0) / Math.max(1, frames);
  for (let i = 0; i < frames; i++) env[i] = Math.max(0, env[i] - mean);
  return { env, hopSeconds: ONSET_HOP / rate };
}

export function estimateTempo(x: Float32Array, rate: number): TempoEstimate | null {
  const { env, hopSeconds } = onsetEnvelope(x, rate);
  const minLag = Math.floor(60 / 200 / hopSeconds);
  const maxLag = Math.ceil(60 / 60 / hopSeconds);
  if (env.length < maxLag * 3) return null; // need a few bars

  const scores = new Float64Array(maxLag + 2);
  for (let lag = minLag - 1; lag <= maxLag + 1; lag++) {
    let acc = 0;
    for (let i = lag; i < env.length; i++) acc += env[i] * env[i - lag];
    const bpm = 60 / (lag * hopSeconds);
    const prior = Math.exp(-0.5 * (Math.log2(bpm / 110) / 0.9) ** 2);
    scores[lag] = (acc / (env.length - lag)) * prior;
  }
  let best = minLag;
  for (let lag = minLag; lag <= maxLag; lag++) if (scores[lag] > scores[best]) best = lag;
  const a = scores[best - 1];
  const b = scores[best];
  const c = scores[best + 1];
  const denom = a - 2 * b + c;
  const refined = denom < 0 ? best + (0.5 * (a - c)) / denom : best;
  let mean = 0;
  for (let lag = minLag; lag <= maxLag; lag++) mean += scores[lag];
  mean /= maxLag - minLag + 1;
  if (!(b > 0)) return null;
  return { bpm: 60 / (refined * hopSeconds), confidence: mean > 0 ? b / mean : 0 };
}

// --- helpers -----------------------------------------------------------------------------------

function hann(n: number): Float64Array {
  const w = new Float64Array(n);
  for (let i = 0; i < n; i++) w[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / n);
  return w;
}

function pearson(a: ArrayLike<number>, b: ArrayLike<number>): number {
  const n = a.length;
  let ma = 0;
  let mb = 0;
  for (let i = 0; i < n; i++) {
    ma += a[i];
    mb += b[i];
  }
  ma /= n;
  mb /= n;
  let num = 0;
  let da = 0;
  let db = 0;
  for (let i = 0; i < n; i++) {
    num += (a[i] - ma) * (b[i] - mb);
    da += (a[i] - ma) ** 2;
    db += (b[i] - mb) ** 2;
  }
  return da > 0 && db > 0 ? num / Math.sqrt(da * db) : 0;
}
