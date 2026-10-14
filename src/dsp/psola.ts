// TD-PSOLA pitch shifting: renders the auto-tuned version of a recording.
//
// 1. Analysis marks: in voiced stretches, one mark per glottal cycle, aligned to the waveform peak.
// 2. Synthesis marks: walk through time at the *corrected* period (period / ratio). At each synthesis
//    mark, copy the Hann-windowed grain (about two periods) around the nearest analysis mark.
//    Grains are re-spaced but not resampled, so the spectral envelope (formants) stays put and the
//    voice still sounds like the same person, just on pitch.
// 3. Unvoiced stretches (breaths, "s", silence) use identity grains, so they pass through unchanged.
// Overlap-adds are normalised by the summed window weight, which keeps the level constant whether
// grains overlap more (pitch up) or less (pitch down).

import type { PitchFrame } from '../audio/pitch-tracker';
import type { Correction } from './autotune';
import { midiToFreq } from './notes';

/** Grain spacing for unvoiced audio (identity, so any value works; ~5 ms keeps it light). */
const UNVOICED_PERIOD_SECONDS = 0.005;
/** Where windows barely overlap, blend towards the original instead of dividing by ~0. */
const MIN_WEIGHT = 0.25;
/** Peak search window around the predicted next cycle, as a fraction of the period. */
const MARK_SEARCH = 0.3;

interface VoicedRegion {
  /** Sample range covered by the region. */
  start: number;
  end: number;
  /** Frame times (s), periods (samples) and pitch ratios for the region's frames. */
  times: number[];
  periods: number[];
  ratios: number[];
}

export function renderTuned(
  samples: Float32Array,
  sampleRate: number,
  frames: readonly PitchFrame[],
  corrections: readonly Correction[],
): Float32Array {
  const n = samples.length;
  const out = new Float32Array(n);
  const weight = new Float32Array(n);
  const regions = voicedRegions(frames, corrections, sampleRate, n);
  const smooth = zeroPhaseLowpass(samples, sampleRate, 900);
  const unvoicedPeriod = Math.max(16, Math.round(sampleRate * UNVOICED_PERIOD_SECONDS));

  let cursor = 0;
  for (const region of regions) {
    for (let m = cursor; m < region.start; m += unvoicedPeriod) overlapAdd(samples, out, weight, m, m, unvoicedPeriod);
    renderVoiced(samples, smooth, out, weight, region, sampleRate);
    cursor = region.end;
  }
  for (let m = cursor; m < n + unvoicedPeriod; m += unvoicedPeriod) overlapAdd(samples, out, weight, m, m, unvoicedPeriod);

  for (let i = 0; i < n; i++) {
    const w = weight[i];
    out[i] = w >= MIN_WEIGHT ? out[i] / w : (out[i] + (MIN_WEIGHT - w) * samples[i]) / MIN_WEIGHT;
  }
  return out;
}

function renderVoiced(
  samples: Float32Array,
  smooth: Float32Array,
  out: Float32Array,
  weight: Float32Array,
  region: VoicedRegion,
  sampleRate: number,
): void {
  const at = (sample: number, values: number[]) => interpolate(region.times, values, sample / sampleRate);
  const periodAt = (s: number) => at(s, region.periods);
  const ratioAt = (s: number) => at(s, region.ratios);

  const marks = analysisMarks(smooth, region, periodAt);
  let idx = 0;
  for (let t = marks[0]; t < region.end; ) {
    // Nearest analysis mark to this synthesis time (marks and t both increase, so walk forward).
    while (idx + 1 < marks.length && Math.abs(marks[idx + 1] - t) <= Math.abs(marks[idx] - t)) idx++;
    const a = marks[idx];
    const synthPeriod = periodAt(t) / ratioAt(t);
    const half = Math.round(Math.max(periodAt(a), synthPeriod));
    overlapAdd(samples, out, weight, a, Math.round(t), half);
    t += synthPeriod;
  }
}

/** One mark per cycle, each on the local peak of the low-passed signal. */
function analysisMarks(sig: Float32Array, region: VoicedRegion, periodAt: (s: number) => number): number[] {
  const last = sig.length - 1;
  let m = argmax(sig, region.start, Math.min(region.end, region.start + Math.ceil(periodAt(region.start))));
  const marks = [m];
  for (;;) {
    const T = periodAt(m);
    const predicted = m + T;
    if (predicted >= region.end) break;
    const lo = Math.max(m + 1, Math.round(predicted - MARK_SEARCH * T));
    const hi = Math.min(last, Math.round(predicted + MARK_SEARCH * T));
    if (lo > hi) break;
    m = argmax(sig, lo, hi + 1);
    marks.push(m);
  }
  return marks;
}

/** Adds the Hann-windowed grain centred on `from` to the output centred on `to`. */
function overlapAdd(src: Float32Array, out: Float32Array, weight: Float32Array, from: number, to: number, half: number): void {
  const n = src.length;
  const kMin = Math.max(-half + 1, -from, -to);
  const kMax = Math.min(half - 1, n - 1 - from, n - 1 - to);
  for (let k = kMin; k <= kMax; k++) {
    const w = 0.5 + 0.5 * Math.cos((Math.PI * k) / half);
    out[to + k] += w * src[from + k];
    weight[to + k] += w;
  }
}

/** Consecutive voiced frames -> sample ranges with their pitch periods and correction ratios. */
function voicedRegions(
  frames: readonly PitchFrame[],
  corrections: readonly Correction[],
  sampleRate: number,
  length: number,
): VoicedRegion[] {
  const hop = estimateHop(frames);
  const regions: VoicedRegion[] = [];
  let current: VoicedRegion | null = null;
  frames.forEach((f, i) => {
    const corrected = corrections[i]?.corrected ?? null;
    if (f.midi === null || corrected === null) {
      current = null;
      return;
    }
    if (!current) {
      current = { start: 0, end: 0, times: [], periods: [], ratios: [] };
      current.start = Math.max(0, Math.round((f.time - hop / 2) * sampleRate));
      regions.push(current);
    }
    current.times.push(f.time);
    current.periods.push(sampleRate / midiToFreq(f.midi));
    current.ratios.push(Math.pow(2, (corrected - f.midi) / 12));
    current.end = Math.min(length, Math.round((f.time + hop / 2) * sampleRate));
  });
  return regions.filter((r) => r.end > r.start);
}

function estimateHop(frames: readonly PitchFrame[]): number {
  const diffs: number[] = [];
  for (let i = 1; i < Math.min(frames.length, 50); i++) diffs.push(frames[i].time - frames[i - 1].time);
  diffs.sort((a, b) => a - b);
  return diffs.length ? diffs[diffs.length >> 1] : 0.01;
}

/** Linear interpolation of `values` sampled at ascending `times`, clamped at both ends. */
function interpolate(times: number[], values: number[], t: number): number {
  if (t <= times[0]) return values[0];
  const last = times.length - 1;
  if (t >= times[last]) return values[last];
  let lo = 0;
  let hi = last;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (times[mid] <= t) lo = mid;
    else hi = mid;
  }
  const u = (t - times[lo]) / (times[hi] - times[lo]);
  return values[lo] + (values[hi] - values[lo]) * u;
}

function argmax(sig: Float32Array, from: number, to: number): number {
  let best = from;
  for (let i = from + 1; i < to; i++) if (sig[i] > sig[best]) best = i;
  return best;
}

/** Second-order low-pass run forwards then backwards (no phase shift, so peaks stay in place). */
export function zeroPhaseLowpass(x: Float32Array, sampleRate: number, cutoff: number): Float32Array {
  const w0 = (2 * Math.PI * cutoff) / sampleRate;
  const alpha = Math.sin(w0) / (2 * Math.SQRT1_2);
  const cos = Math.cos(w0);
  const a0 = 1 + alpha;
  const b0 = (1 - cos) / 2 / a0;
  const b1 = (1 - cos) / a0;
  const b2 = b0;
  const a1 = (-2 * cos) / a0;
  const a2 = (1 - alpha) / a0;

  const pass = (src: Float32Array, reverse: boolean): Float32Array => {
    const out = new Float32Array(src.length);
    let x1 = 0, x2 = 0, y1 = 0, y2 = 0;
    for (let j = 0; j < src.length; j++) {
      const i = reverse ? src.length - 1 - j : j;
      const x0 = src[i];
      const y0 = b0 * x0 + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2;
      out[i] = y0;
      x2 = x1;
      x1 = x0;
      y2 = y1;
      y1 = y0;
    }
    return out;
  };
  return pass(pass(x, false), true);
}
