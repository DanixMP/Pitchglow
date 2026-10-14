// Spectral noise reduction for recordings (offline).
//
// 1. STFT: ~43 ms Hann frames at 75% overlap, Hann synthesis + overlap normalisation (perfect
//    reconstruction when nothing is changed). Long frames resolve the gaps between a voice's
//    harmonics, so the noise *between* them can be removed, not just the noise in pauses.
// 2. Noise profile: the average power spectrum of the quietest ~15% of frames (breaths, pauses, room
//    tone). Recordings without enough quiet frames are left alone rather than guessed at.
// 3. Per-bin Wiener gain with decision-directed a-priori SNR (Ephraim & Malah). It's much less
//    "warbly" (musical noise) than plain spectral subtraction. The gain is smoothed across neighbouring
//    bins and floored at -amountDb, so some room tone stays and the voice never sounds gated.

import { FFT } from './fft';

export interface DenoiseSettings {
  /** Maximum attenuation of noise, in dB (the gain floor). 0 = off, ~12 natural, 25+ aggressive. */
  amountDb: number;
}

const QUIET_FRACTION = 0.15;
const MIN_QUIET_FRAMES = 6;
/** Decision-directed smoothing: closer to 1 = smoother, less musical noise, slightly slower attack. */
const DD_ALPHA = 0.96;
/** Noise over-estimation, so steady noise is fully caught at the floor. */
const OVERSUBTRACT = 1.5;

export interface DenoiseResult {
  output: Float32Array;
  /** False when there wasn't enough quiet audio to learn the noise from (output = input). */
  applied: boolean;
}

/** STFT frame size for a sample rate: ~43 ms (2048 at 48 kHz). */
export function frameSizeFor(sampleRate: number): number {
  return Math.pow(2, Math.round(Math.log2(sampleRate * 0.0427)));
}

export function denoise(x: Float32Array, sampleRate: number, settings: DenoiseSettings): DenoiseResult {
  if (settings.amountDb <= 0 || x.length === 0) return { output: x.slice(), applied: false };
  const n = frameSizeFor(sampleRate);
  const hop = n / 4;
  const bins = n / 2 + 1;
  const fft = new FFT(n);
  const window = new Float64Array(n);
  for (let i = 0; i < n; i++) window[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / n); // periodic Hann

  // Pad so every sample is covered by a full set of overlapping frames.
  const padded = new Float32Array(x.length + 2 * n);
  padded.set(x, n);
  const frames = Math.floor((padded.length - n) / hop) + 1;

  // Pass 1: spectra (power) of every frame.
  const re = new Float64Array(n);
  const im = new Float64Array(n);
  const power = new Float32Array(frames * bins);
  const energy = new Float64Array(frames);
  for (let f = 0; f < frames; f++) {
    loadFrame(padded, f * hop, window, re, im);
    fft.forward(re, im);
    let e = 0;
    for (let k = 0; k < bins; k++) {
      const p = re[k] * re[k] + im[k] * im[k];
      power[f * bins + k] = p;
      e += p;
    }
    energy[f] = e;
  }

  // Noise profile from the quietest frames that overlap the real signal (not the padding). Digital
  // silence counts too: a clean recording then learns "no noise" and passes through unchanged.
  const candidates = [...energy.keys()]
    .filter((f) => f * hop + n > n && f * hop < n + x.length)
    .sort((a, b) => energy[a] - energy[b]);
  const quiet = candidates.slice(0, Math.max(MIN_QUIET_FRAMES, Math.floor(candidates.length * QUIET_FRACTION)));
  if (candidates.length < MIN_QUIET_FRAMES * 3) return { output: x.slice(), applied: false };
  const noise = new Float64Array(bins);
  for (const f of quiet) for (let k = 0; k < bins; k++) noise[k] += power[f * bins + k];
  for (let k = 0; k < bins; k++) noise[k] = (noise[k] / quiet.length) * OVERSUBTRACT + 1e-12;

  // Pass 2: Wiener gain per frame, overlap-add.
  const floor = Math.pow(10, -settings.amountDb / 20);
  const out = new Float64Array(padded.length);
  const prevClean = new Float64Array(bins); // |S|^2 estimate from the previous frame
  const gain = new Float64Array(bins);
  const smooth = new Float64Array(bins);
  for (let f = 0; f < frames; f++) {
    const start = f * hop;
    loadFrame(padded, start, window, re, im);
    fft.forward(re, im);
    for (let k = 0; k < bins; k++) {
      const p = power[f * bins + k];
      const post = p / noise[k];
      const prior = DD_ALPHA * (prevClean[k] / noise[k]) + (1 - DD_ALPHA) * Math.max(post - 1, 0);
      gain[k] = prior / (1 + prior);
    }
    // Smooth the gain across neighbouring bins, then apply the floor.
    for (let k = 0; k < bins; k++) {
      const a = gain[Math.max(0, k - 1)];
      const b = gain[k];
      const c = gain[Math.min(bins - 1, k + 1)];
      smooth[k] = Math.max(floor, 0.25 * a + 0.5 * b + 0.25 * c);
      prevClean[k] = smooth[k] * smooth[k] * power[f * bins + k];
    }
    // Apply to both halves of the (conjugate-symmetric) spectrum.
    for (let k = 0; k < bins; k++) {
      re[k] *= smooth[k];
      im[k] *= smooth[k];
      if (k > 0 && k < n / 2) {
        re[n - k] *= smooth[k];
        im[n - k] *= smooth[k];
      }
    }
    fft.inverse(re, im);
    for (let i = 0; i < n; i++) out[start + i] += re[i] * window[i];
  }

  // Hann analysis x Hann synthesis at 75% overlap sums to 1.5 everywhere inside the padding.
  const output = new Float32Array(x.length);
  for (let i = 0; i < x.length; i++) output[i] = out[i + n] / 1.5;
  return { output, applied: true };
}

function loadFrame(src: Float32Array, start: number, window: Float64Array, re: Float64Array, im: Float64Array): void {
  for (let i = 0; i < window.length; i++) {
    re[i] = (src[start + i] ?? 0) * window[i];
    im[i] = 0;
  }
}
