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
import { GrainCache, SHAPE_MAX_HALF, type GrainVoice } from './grain-shape';
import { midiToFreq } from './notes';
import { warpToOutput, warpToSource, type TimeWarp } from './note-edit';

/** Half a Hann window, 0.5 + 0.5·cos(πj/HANN_SIZE) for j = 0 … HANN_SIZE (+1 guard for interpolation). */
const HANN_SIZE = 4096;
const HANN = Float64Array.from({ length: HANN_SIZE + 2 }, (_, j) => 0.5 + 0.5 * Math.cos((Math.PI * Math.min(j, HANN_SIZE)) / HANN_SIZE));

/** Grain spacing for unvoiced audio (identity, so any value works; ~5 ms keeps it light). */
const UNVOICED_PERIOD_SECONDS = 0.005;
/**
 * Summed window weight below which the output isn't divided any further: shifting down spreads the
 * grains out, and the envelope that leaves is what carries the lower pitch. (Dividing it away
 * reassembles the original: an octave down then sounded exactly like the input.)
 */
const NORM_FLOOR = 0.5;
/** Below this weight the lead fades towards the source (the edges of voiced stretches). */
const BLEND_WEIGHT = 0.1;

/** One output sample from the overlap-added grains (`acc`), their summed weight and the source. */
export function normalizeGrain(acc: number, w: number, x: number, passthrough: boolean): number {
  if (w >= NORM_FLOOR) return acc / w;
  const y = acc / NORM_FLOOR;
  return passthrough && w < BLEND_WEIGHT ? y + (1 - w / BLEND_WEIGHT) * x : y;
}

/** Hann weight 0.5 + 0.5·cos(πk/half) from the table (no Math.cos per sample). */
export function hann(k: number, half: number): number {
  const x = ((k < 0 ? -k : k) * HANN_SIZE) / half;
  const i = x | 0;
  return HANN[i] + (HANN[i + 1] - HANN[i]) * (x - i);
}
/** Peak search window around the predicted next cycle, as a fraction of the period. */
const MARK_SEARCH = 0.3;

// The work is split so the real-time engine (Phase 13) can share it exactly:
// - analyzePsola: voiced regions + analysis marks. Depends only on the audio and its pitch track,
//   so it is computed once per take (in the worker).
// - planGrains: the list of grains (source centre -> output centre, half-length) for one correction
//   curve. Cheap, so it is redone on every settings change (instant knobs).
// - renderGrains: overlap-adds the grains for any output range. Rendering in blocks gives exactly
//   the same samples as rendering the whole take at once.

/** Voiced stretch: sample range, its frames (index range into the pitch track) and analysis marks. */
export interface PsolaRegion {
  start: number;
  end: number;
  frameFrom: number;
  frameTo: number;
  marks: Int32Array;
}

export interface PsolaAnalysis {
  length: number;
  sampleRate: number;
  /** Frame times (s) and pitch periods (samples; NaN = unvoiced), from the pitch track. */
  times: Float64Array;
  periods: Float64Array;
  /** Sung pitch per frame (MIDI; NaN = unvoiced). */
  midi: Float64Array;
  regions: PsolaRegion[];
}

/** Grains in output order: copy src around `from` to the output around `to`, Hann half-length `half`. */
export interface GrainPlan {
  to: Int32Array;
  from: Int32Array;
  half: Int32Array;
  count: number;
  maxHalf: number;
  /**
   * true: unvoiced audio passes through (identity grains, and the source fills in where grains are
   * sparse), as for the lead. false: voiced parts only, silence elsewhere (harmony voices, so breaths
   * and "s" sounds aren't stacked once per voice).
   */
  passthrough: boolean;
  /** Output length in samples (= the take). */
  length: number;
  /** 1 for grains of sung (voiced) cycles, 0 for identity grains. */
  voiced: Uint8Array;
  /** Voice character applied to the voiced grains (Phase 15). */
  voice: GrainVoice;
  /** Note timing edits (Phase 18): which source position each output position plays; null = same. */
  warp: TimeWarp | null;
}

/** No formant shift, no whisper. */
export const NATURAL_VOICE: GrainVoice = { formant: 1, whisper: 0, seed: 0 };

function shapes(voice: GrainVoice): boolean {
  return voice.formant !== 1 || voice.whisper > 0;
}

export function renderTuned(
  samples: Float32Array,
  sampleRate: number,
  frames: readonly PitchFrame[],
  corrections: readonly Correction[],
): Float32Array {
  const plan = planGrains(analyzePsola(samples, sampleRate, frames), corrections);
  const out = new Float32Array(samples.length);
  renderGrains(samples, plan, 0, samples.length, out, new Float32Array(samples.length));
  return out;
}

/** Voiced regions and their analysis marks (one per cycle, on the peak of the low-passed signal). */
export function analyzePsola(samples: Float32Array, sampleRate: number, frames: readonly PitchFrame[]): PsolaAnalysis {
  const n = samples.length;
  const times = new Float64Array(frames.length);
  const periods = new Float64Array(frames.length);
  const midi = new Float64Array(frames.length);
  frames.forEach((f, i) => {
    times[i] = f.time;
    midi[i] = f.midi ?? NaN;
    periods[i] = f.midi === null ? NaN : sampleRate / midiToFreq(f.midi);
  });
  const hop = estimateHop(frames);
  const regions: PsolaRegion[] = [];
  let open: { start: number; end: number; frameFrom: number; frameTo: number } | null = null;
  const close = () => {
    if (open && open.end > open.start) regions.push({ ...open, marks: new Int32Array(0) });
    open = null;
  };
  frames.forEach((f, i) => {
    if (f.midi === null) return close();
    if (!open) open = { start: Math.max(0, Math.round((f.time - hop / 2) * sampleRate)), end: 0, frameFrom: i, frameTo: i };
    open.frameTo = i + 1;
    open.end = Math.min(n, Math.round((f.time + hop / 2) * sampleRate));
  });
  close();
  const smooth = zeroPhaseLowpass(samples, sampleRate, 900);
  for (const r of regions) {
    const periodAt = (sample: number) => interpolate(times, periods, r.frameFrom, r.frameTo, sample / sampleRate);
    r.marks = analysisMarks(smooth, r, periodAt);
  }
  return { length: n, sampleRate, times, periods, midi, regions };
}

/**
 * The grains that move the voice along `corrections` (unvoiced audio: identity grains). With a time
 * warp (note timing edits), output position t plays source position warp(t): grains are taken from
 * there, still spaced by the corrected pitch period, so notes stretch without changing pitch.
 */
export function planGrains(
  analysis: PsolaAnalysis,
  corrections: readonly Correction[],
  passthrough = true,
  voice: GrainVoice = NATURAL_VOICE,
  warp: TimeWarp | null = null,
): GrainPlan {
  const { length: n, sampleRate, times, periods, midi, regions } = analysis;
  const ratios = new Float64Array(periods.length);
  // Voices without passthrough (harmonies) are silent where their curve has no pitch, even inside a
  // sung stretch (a key voice with no key held there).
  let silentFrames = false;
  const silent = new Uint8Array(periods.length);
  for (let i = 0; i < periods.length; i++) {
    const c = corrections[i]?.corrected;
    ratios[i] = c === null || c === undefined || Number.isNaN(midi[i]) ? 1 : Math.pow(2, (c - midi[i]) / 12);
    if (!passthrough && (c === null || c === undefined) && !Number.isNaN(midi[i])) {
      silent[i] = 1;
      silentFrames = true;
    }
  }
  const unvoicedPeriod = Math.max(16, Math.round(sampleRate * UNVOICED_PERIOD_SECONDS));
  const plan = new PlanBuilder(n, passthrough, voice, warp);
  // Output <-> source positions (the identity without a warp, so plans stay exactly as before).
  const toOut = (s: number) => (warp ? warpToOutput(warp, s) : s);
  const toSrc = (t: number) => (warp ? warpToSource(warp, t) : t);
  const unvoiced = (from: number, to: number) => {
    for (let t = toOut(from); t < to; t += unvoicedPeriod) plan.push(Math.round(toSrc(t)), Math.round(t), unvoicedPeriod, 0);
  };
  let cursor = 0;
  for (const r of regions) {
    if (passthrough) unvoiced(cursor, toOut(r.start));
    const periodAt = (sample: number) => interpolate(times, periods, r.frameFrom, r.frameTo, sample / sampleRate);
    const ratioAt = (sample: number) => interpolate(times, ratios, r.frameFrom, r.frameTo, sample / sampleRate);
    const marks = r.marks;
    let idx = 0;
    const end = toOut(r.end);
    for (let t = toOut(marks[0]); t < end; ) {
      const u = toSrc(t);
      // Nearest analysis mark to the source position (marks and u both increase, so walk forward).
      while (idx + 1 < marks.length && Math.abs(marks[idx + 1] - u) <= Math.abs(marks[idx] - u)) idx++;
      const a = marks[idx];
      const synthPeriod = periodAt(u) / ratioAt(u);
      // Grains are two analysis periods long (classic TD-PSOLA), whatever the shift.
      if (!silentFrames || !silent[nearestFrame(times, r.frameFrom, r.frameTo, u / sampleRate)]) plan.push(a, Math.round(t), Math.round(periodAt(a)), 1);
      t += synthPeriod;
    }
    cursor = r.end;
  }
  if (passthrough) unvoiced(cursor, n + unvoicedPeriod);
  return plan.build();
}

/**
 * Renders output samples [start, end) of a plan into `out[0 .. end-start)`, normalised by the summed
 * window weight (blending towards the source where grains barely overlap). `weight` is scratch of at
 * least the same length. With a voice character, shaped grains come from `cache` (one per plan; a
 * temporary one is made when omitted, which is fine offline). Allocates nothing when given a cache,
 * so it can run on the audio thread.
 */
export function renderGrains(
  src: Float32Array,
  plan: GrainPlan,
  start: number,
  end: number,
  out: Float32Array,
  weight: Float32Array,
  cache: GrainCache | null = null,
): void {
  const len = end - start;
  out.fill(0, 0, len);
  weight.fill(0, 0, len);
  const n = Math.min(src.length, plan.length);
  const { to, from, half: halves, count, maxHalf, voiced, voice } = plan;
  const shaped = shapes(voice);
  if (shaped && !cache) cache = new GrainCache();
  // First grain that can reach `start` (grains are sorted by output centre).
  let lo = 0;
  let hi = count;
  const reach = start - maxHalf;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (to[mid] < reach) lo = mid + 1;
    else hi = mid;
  }
  for (let g = lo; g < count; g++) {
    const t = to[g];
    if (t - maxHalf >= end) break;
    const f = from[g];
    const half = halves[g];
    if (shaped && voiced[g] && half <= SHAPE_MAX_HALF) {
      // Voice character: the grain's content is shaped (and cached), the window is the same.
      const grain = cache!.get(plan, g, src, f, half, voice, n);
      const kMin = Math.max(-half + 1, -t, start - t);
      const kMax = Math.min(half - 1, n - 1 - t, end - 1 - t);
      for (let k = kMin; k <= kMax; k++) {
        const w = hann(k, half);
        out[t + k - start] += w * grain[k + half];
        weight[t + k - start] += w;
      }
      continue;
    }
    const kMin = Math.max(-half + 1, -f, -t, start - t);
    const kMax = Math.min(half - 1, n - 1 - f, n - 1 - t, end - 1 - t);
    // Hann window 0.5 + 0.5·cos(πk/half) from a table (no Math.cos per sample). A pure function of
    // (k, half), so any block split gives the same samples.
    for (let k = kMin; k <= kMax; k++) {
      const w = hann(k, half);
      out[t + k - start] += w * src[f + k];
      weight[t + k - start] += w;
    }
  }
  // Harmony voices (no passthrough) fade to silence where the grains thin out. The lead blends
  // towards the source (where the warp says it is) where grains barely overlap.
  const pass = plan.passthrough;
  const warp = plan.warp;
  for (let i = 0; i < len; i++) {
    const w = weight[i];
    let x = 0;
    if (pass && w < BLEND_WEIGHT) {
      const s = warp ? Math.round(warpToSource(warp, start + i)) : start + i;
      x = s >= 0 && s < src.length ? src[s] : 0;
    }
    out[i] = normalizeGrain(out[i], w, x, pass);
  }
}

class PlanBuilder {
  private to = new Int32Array(1024);
  private from = new Int32Array(1024);
  private half = new Int32Array(1024);
  private voiced = new Uint8Array(1024);
  private count = 0;
  private maxHalf = 1;

  constructor(
    private readonly length: number,
    private readonly passthrough: boolean,
    private readonly voice: GrainVoice,
    private readonly warp: TimeWarp | null,
  ) {}

  push(from: number, to: number, half: number, voiced: number): void {
    if (this.count === this.to.length) {
      const grow = (a: Int32Array) => {
        const b = new Int32Array(a.length * 2);
        b.set(a);
        return b;
      };
      this.to = grow(this.to);
      this.from = grow(this.from);
      this.half = grow(this.half);
      const v = new Uint8Array(this.voiced.length * 2);
      v.set(this.voiced);
      this.voiced = v;
    }
    this.to[this.count] = to;
    this.from[this.count] = from;
    this.half[this.count] = half;
    this.voiced[this.count] = voiced;
    this.count++;
    if (half > this.maxHalf) this.maxHalf = half;
  }

  build(): GrainPlan {
    const c = this.count;
    return {
      to: this.to.slice(0, c),
      from: this.from.slice(0, c),
      half: this.half.slice(0, c),
      voiced: this.voiced.slice(0, c),
      count: c,
      maxHalf: this.maxHalf,
      length: this.length,
      passthrough: this.passthrough,
      voice: this.voice,
      warp: this.warp,
    };
  }
}

/** One mark per cycle, each on the local peak of the low-passed signal. */
function analysisMarks(sig: Float32Array, region: { start: number; end: number }, periodAt: (s: number) => number): Int32Array {
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
  return Int32Array.from(marks);
}

function estimateHop(frames: readonly PitchFrame[]): number {
  const diffs: number[] = [];
  for (let i = 1; i < Math.min(frames.length, 50); i++) diffs.push(frames[i].time - frames[i - 1].time);
  diffs.sort((a, b) => a - b);
  return diffs.length ? diffs[diffs.length >> 1] : 0.01;
}

/** Linear interpolation of `values[from..to)` sampled at ascending `times`, clamped at both ends. */
function interpolate(times: Float64Array, values: Float64Array, from: number, to: number, t: number): number {
  if (t <= times[from]) return values[from];
  const last = to - 1;
  if (t >= times[last]) return values[last];
  let lo = from;
  let hi = last;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (times[mid] <= t) lo = mid;
    else hi = mid;
  }
  const u = (t - times[lo]) / (times[hi] - times[lo]);
  return values[lo] + (values[hi] - values[lo]) * u;
}

/** Index of the frame in [from, to) whose time is nearest `t`. */
function nearestFrame(times: Float64Array, from: number, to: number, t: number): number {
  let lo = from;
  let hi = to - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (times[mid] <= t) lo = mid;
    else hi = mid;
  }
  return Math.abs(times[hi] - t) < Math.abs(times[lo] - t) ? hi : lo;
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
