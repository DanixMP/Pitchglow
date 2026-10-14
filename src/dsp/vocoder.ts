// Phase-vocoder pitch shift for polyphonic audio (instrumentals): time-stretch by r = 2^(st/12),
// then resample by 1/r, so the length stays the same and every frequency moves by r.
//
// Stretch: STFT (2048 Hann, synthesis hop 512 = 75% overlap), analysis hop 512/r. Each peak's true
// frequency comes from its phase advance; its synthesis phase accumulates at that frequency.
// Identity phase locking (Laroche & Dolson): bins around a peak keep their phase *relative to the
// peak*, which keeps transients and partials coherent (much less "phasiness" than per-bin phases).
// Resample: 4-point Catmull-Rom interpolation.

import { FFT } from './fft';

const N = 2048;
const HOP_OUT = 512;

export function pitchShift(x: Float32Array, semitones: number): Float32Array {
  if (semitones === 0 || x.length === 0) return x.slice();
  const r = Math.pow(2, semitones / 12);
  const stretched = timeStretch(x, r);
  return resample(stretched, r, x.length);
}

/** Phase-vocoder time stretch: output is about `factor` times longer than the input. */
export function timeStretch(x: Float32Array, factor: number): Float32Array {
  const hopIn = HOP_OUT / factor;
  const bins = N / 2 + 1;
  const fft = new FFT(N);
  const win = new Float64Array(N);
  for (let i = 0; i < N; i++) win[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / N);

  // Pad so the first and last samples get full overlap.
  const padded = new Float32Array(x.length + 2 * N);
  padded.set(x, N);
  const frames = Math.floor((padded.length - N) / hopIn) + 1;
  const outLen = Math.ceil((frames - 1) * HOP_OUT + N);
  const out = new Float64Array(outLen);
  const norm = new Float64Array(outLen);

  const re = new Float64Array(N);
  const im = new Float64Array(N);
  const mag = new Float64Array(bins);
  const phase = new Float64Array(bins);
  const prevPhase = new Float64Array(bins);
  const synthPhase = new Float64Array(bins);
  const omega = new Float64Array(bins);
  for (let k = 0; k < bins; k++) omega[k] = (2 * Math.PI * k) / N;
  let prevStart = 0;

  for (let f = 0; f < frames; f++) {
    const start = Math.round(f * hopIn);
    for (let i = 0; i < N; i++) {
      re[i] = (padded[start + i] ?? 0) * win[i];
      im[i] = 0;
    }
    fft.forward(re, im);
    for (let k = 0; k < bins; k++) {
      mag[k] = Math.hypot(re[k], im[k]);
      phase[k] = Math.atan2(im[k], re[k]);
    }

    // Peaks: local maxima of the magnitude spectrum.
    const peaks: number[] = [];
    for (let k = 1; k < bins - 1; k++) if (mag[k] > mag[k - 1] && mag[k] >= mag[k + 1]) peaks.push(k);

    const realHop = f === 0 ? hopIn : start - prevStart;
    if (f === 0) {
      for (let k = 0; k < bins; k++) synthPhase[k] = phase[k];
    } else {
      // Advance each peak at its true (instantaneous) frequency.
      for (const k of peaks) {
        const delta = princarg(phase[k] - prevPhase[k] - omega[k] * realHop);
        const trueFreq = omega[k] + delta / realHop;
        synthPhase[k] += trueFreq * HOP_OUT;
      }
      // Identity phase locking: other bins follow the nearest peak's rotation.
      let p = 0;
      for (let k = 0; k < bins; k++) {
        if (peaks.length === 0) {
          synthPhase[k] = phase[k];
          continue;
        }
        while (p + 1 < peaks.length && Math.abs(peaks[p + 1] - k) < Math.abs(peaks[p] - k)) p++;
        const peak = peaks[p];
        if (k !== peak) synthPhase[k] = synthPhase[peak] + (phase[k] - phase[peak]);
      }
    }
    prevPhase.set(phase);
    prevStart = start;

    // Back to time domain with the new phases, overlap-add.
    for (let k = 0; k < bins; k++) {
      re[k] = mag[k] * Math.cos(synthPhase[k]);
      im[k] = mag[k] * Math.sin(synthPhase[k]);
      if (k > 0 && k < N / 2) {
        re[N - k] = re[k];
        im[N - k] = -im[k];
      }
    }
    fft.inverse(re, im);
    const o = f * HOP_OUT;
    for (let i = 0; i < N; i++) {
      out[o + i] += re[i] * win[i];
      norm[o + i] += win[i] * win[i];
    }
  }

  // Normalise the overlap (Hann² at 75% overlap ≈ 1.5) and drop the padding (stretched by factor).
  const skip = Math.round(N * factor);
  const length = Math.round(x.length * factor);
  const y = new Float32Array(length);
  for (let i = 0; i < length; i++) {
    const j = i + skip;
    y[i] = norm[j] > 1e-6 ? out[j] / norm[j] : 0;
  }
  return y;
}

/** Reads `x` at positions i·step (Catmull-Rom), producing `length` samples. */
export function resample(x: Float32Array, step: number, length: number): Float32Array {
  const y = new Float32Array(length);
  const at = (i: number) => x[Math.min(x.length - 1, Math.max(0, i))];
  for (let i = 0; i < length; i++) {
    const pos = i * step;
    const i1 = Math.floor(pos);
    const t = pos - i1;
    const p0 = at(i1 - 1);
    const p1 = at(i1);
    const p2 = at(i1 + 1);
    const p3 = at(i1 + 2);
    y[i] = p1 + 0.5 * t * (p2 - p0 + t * (2 * p0 - 5 * p1 + 4 * p2 - p3 + t * (3 * (p1 - p2) + p3 - p0)));
  }
  return y;
}

function princarg(phase: number): number {
  return phase - 2 * Math.PI * Math.round(phase / (2 * Math.PI));
}
