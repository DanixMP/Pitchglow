// Clean-up chain as a stream (Phase 15): noise reduction -> gate -> de-esser, one sample at a time,
// restartable at any position. The playback engine runs it a little ahead of the playhead, so every
// clean-up control is live; offline (export, tests) it simply runs over the whole take, giving the
// same samples.
//
// The parts that need the whole take and don't depend on the settings are computed once
// (analyzeCleanup): the noise profile and the gate's open/closed map. The stream does the rest.
//
// - Noise reduction: STFT (~43 ms Hann frames, 75% overlap, frames on a fixed grid so any restart
//   lands on the same frames), decision-directed Wiener gain against the noise profile, smoothed
//   across bins, floored at -amountDb.
// - Gate: per pitch frame open (voiced or clearly above the noise floor, with 80 ms hold) or closed
//   (-30 dB x amount); 5 ms attack, 50 ms release, opening 20 ms early.
// - De-esser: splits at 5.5 kHz into low = 2nd-order low-pass and high = input - low (so the bands
//   always sum back exactly, with no delay), and turns the high band down where it dominates.

import type { PitchFrame } from '../audio/pitch-tracker';
import { FFT } from './fft';

export interface CleanupSettings {
  /** Noise reduction depth in dB (0 = off). */
  denoiseDb: number;
  /** Gate amount 0..1. */
  gate: number;
  /** De-esser amount 0..1. */
  deess: number;
}

export const CLEANUP_OFF: CleanupSettings = { denoiseDb: 0, gate: 0, deess: 0 };

export interface CleanupAnalysis {
  frameSize: number;
  /** Noise power per bin (over-subtracted), or null when there wasn't enough quiet audio to learn it. */
  noise: Float64Array | null;
  /** Per pitch frame: gate open (1) or closed (0), hold included. */
  gateOpen: Uint8Array;
  /** Pitch frame centres, seconds. */
  frameTimes: Float64Array;
}

const QUIET_FRACTION = 0.15;
const MIN_QUIET_FRAMES = 6;
const DD_ALPHA = 0.96;
const OVERSUBTRACT = 1.5;
const DEESS_HZ = 5500;

/** STFT frame size for a sample rate: ~43 ms (2048 at 48 kHz). */
export function frameSizeFor(sampleRate: number): number {
  return Math.pow(2, Math.round(Math.log2(sampleRate * 0.0427)));
}

function hannWindow(n: number): Float64Array {
  const w = new Float64Array(n);
  for (let i = 0; i < n; i++) w[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / n); // periodic Hann
  return w;
}

/** The settings-independent part of the clean-up, computed once per take. */
export function analyzeCleanup(x: Float32Array, sampleRate: number, frames: readonly PitchFrame[]): CleanupAnalysis {
  return { frameSize: frameSizeFor(sampleRate), noise: noiseProfile(x, sampleRate), ...gateMap(frames) };
}

/** Average power spectrum of the quietest ~15% of frames, over-subtracted; null if too little audio. */
export function noiseProfile(x: Float32Array, sampleRate: number): Float64Array | null {
  const n = frameSizeFor(sampleRate);
  const hop = n / 4;
  const bins = n / 2 + 1;
  const fft = new FFT(n);
  const win = hannWindow(n);
  const re = new Float64Array(n);
  const im = new Float64Array(n);
  // Frames on the same grid as the stream, overlapping the signal.
  const first = -Math.floor(n / hop) * hop + hop;
  const powers: Float32Array[] = [];
  const energy: number[] = [];
  for (let s = first; s < x.length; s += hop) {
    for (let i = 0; i < n; i++) {
      const j = s + i;
      re[i] = (j >= 0 && j < x.length ? x[j] : 0) * win[i];
      im[i] = 0;
    }
    fft.forward(re, im);
    const p = new Float32Array(bins);
    let e = 0;
    for (let k = 0; k < bins; k++) {
      p[k] = re[k] * re[k] + im[k] * im[k];
      e += p[k];
    }
    powers.push(p);
    energy.push(e);
  }
  if (powers.length < MIN_QUIET_FRAMES * 3) return null;
  // Digital silence counts too: a clean recording then learns "no noise" and passes through.
  const order = [...energy.keys()].sort((a, b) => energy[a] - energy[b]);
  const quiet = order.slice(0, Math.max(MIN_QUIET_FRAMES, Math.floor(order.length * QUIET_FRACTION)));
  const noise = new Float64Array(bins);
  for (const f of quiet) for (let k = 0; k < bins; k++) noise[k] += powers[f][k];
  for (let k = 0; k < bins; k++) noise[k] = (noise[k] / quiet.length) * OVERSUBTRACT + 1e-12;
  return noise;
}

/** Gate open/closed per pitch frame: voiced, or 10 dB over the noise floor; held open 80 ms. */
export function gateMap(frames: readonly PitchFrame[]): { gateOpen: Uint8Array; frameTimes: Float64Array } {
  const levels = frames.map((f) => f.rms).sort((a, b) => a - b);
  const noise = levels[Math.floor(levels.length * 0.1)] ?? 0;
  const threshold = noise * Math.pow(10, 10 / 20);
  const hop = frames.length > 1 ? frames[1].time - frames[0].time : 0.01;
  const holdFrames = Math.ceil(0.08 / hop);
  const gateOpen = new Uint8Array(frames.length);
  const frameTimes = new Float64Array(frames.length);
  let hold = 0;
  frames.forEach((f, i) => {
    const open = f.midi !== null || f.rms > threshold;
    hold = open ? holdFrames : Math.max(0, hold - 1);
    gateOpen[i] = open || hold > 0 ? 1 : 0;
    frameTimes[i] = f.time;
  });
  return { gateOpen, frameTimes };
}

/** Whether the settings change anything for this take. */
export function cleanupActive(s: CleanupSettings, a: CleanupAnalysis): boolean {
  return (s.denoiseDb > 0 && a.noise !== null) || (s.gate > 0 && a.gateOpen.length > 0) || s.deess > 0;
}

export class CleanupStream {
  private settings: CleanupSettings = CLEANUP_OFF;
  private readonly n: number;
  private readonly hop: number;
  private readonly bins: number;
  private readonly fft: FFT;
  private readonly win: Float64Array;
  private readonly re: Float64Array;
  private readonly im: Float64Array;
  private readonly gain: Float64Array;
  private readonly prevClean: Float64Array;
  /** Last 2n inputs (ring, absolute index & (2n-1)) and the overlap-add output (ring of 2n). */
  private readonly dIn2: Float64Array;
  private readonly dOut: Float64Array;
  /** 1 / noise power per bin (multiplying is cheaper than dividing). */
  private readonly invNoise: Float64Array | null;
  /** The two unpacked spectra of a frame pair. */
  private readonly ar: Float64Array;
  private readonly ai: Float64Array;
  private readonly br: Float64Array;
  private readonly bi: Float64Array;
  /** De-esser split: biquad low-pass coefficients and state. */
  private readonly lp: { b0: number; b1: number; b2: number; a1: number; a2: number };
  private lx1 = 0;
  private lx2 = 0;
  private ly1 = 0;
  private ly2 = 0;

  /** Next raw index to read. */
  private inPos = 0;
  /** Next index the denoiser will hand on (it finishes samples a hop at a time). */
  private dReady = 0;
  /** Next index the gate will process. */
  private gPos = 0;
  /** Next output index. */
  private outPos = 0;
  /** Outputs before this index are warm-up (not written). */
  private emitFrom = 0;

  // Gate and de-esser state.
  private gateClosed = 1;
  /** Sample where each pitch frame's gate decision starts (frame centre minus the 20 ms lead). */
  private readonly frameStarts: Float64Array;
  private g = 1;
  private fi = 0;
  private readonly attack: number;
  private readonly release: number;
  private readonly lead: number;
  private eh = 0;
  private el = 0;
  private gd = 1;
  private readonly envA: number;
  private readonly smoothA: number;

  constructor(
    sampleRate: number,
    private readonly analysis: CleanupAnalysis,
  ) {
    const n = analysis.frameSize;
    this.n = n;
    this.hop = n / 4;
    this.bins = n / 2 + 1;
    this.fft = new FFT(n);
    this.win = hannWindow(n);
    this.re = new Float64Array(n);
    this.im = new Float64Array(n);
    this.gain = new Float64Array(this.bins);
    this.prevClean = new Float64Array(this.bins);
    this.invNoise = analysis.noise ? analysis.noise.map((v) => 1 / v) : null;
    this.dIn2 = new Float64Array(2 * n);
    this.dOut = new Float64Array(2 * n);
    this.ar = new Float64Array(this.bins);
    this.ai = new Float64Array(this.bins);
    this.br = new Float64Array(this.bins);
    this.bi = new Float64Array(this.bins);
    this.lp = lowpassBiquad(DEESS_HZ / sampleRate);
    this.attack = 1 - Math.exp(-1 / (0.005 * sampleRate));
    this.release = 1 - Math.exp(-1 / (0.05 * sampleRate));
    this.lead = 0.02;
    this.frameStarts = analysis.frameTimes.map((sec) => (sec - this.lead) * sampleRate);
    this.envA = 1 - Math.exp(-1 / (0.005 * sampleRate));
    this.smoothA = 1 - Math.exp(-1 / (0.003 * sampleRate));
  }

  /** Samples to run before a restart position so the state has settled (denoiser + filters). */
  get warmup(): number {
    return 2 * this.n + 256;
  }

  /** The next output index (outputs before it have been produced). */
  get ready(): number {
    return this.outPos;
  }

  get denoising(): boolean {
    return this.settings.denoiseDb > 0 && this.analysis.noise !== null;
  }

  get deessing(): boolean {
    return this.settings.deess > 0;
  }

  /**
   * New settings. Amount changes apply from the next sample; switching the denoiser or de-esser on
   * or off changes the pipeline, so the caller restarts (`startAt`) when this returns true.
   */
  setSettings(s: CleanupSettings): boolean {
    const restart = (s.denoiseDb > 0) !== (this.settings.denoiseDb > 0) || (s.deess > 0) !== (this.settings.deess > 0);
    this.settings = s;
    this.gateClosed = Math.pow(10, (-30 * Math.min(1, s.gate)) / 20);
    return restart;
  }

  /** Restarts so that output `pos` onwards is produced (after a warm-up from `pos - warmup`). */
  startAt(pos: number): void {
    const hop = this.hop;
    const from = pos - this.warmup;
    // Frame pairs sit on a fixed grid (multiples of 2 hops), so a restart lands on the same pairs.
    const firstFrame = Math.floor(from / (2 * hop)) * 2 * hop;
    this.inPos = firstFrame;
    this.dReady = firstFrame;
    this.gPos = firstFrame;
    this.outPos = firstFrame;
    this.emitFrom = pos;
    this.dIn2.fill(0);
    this.dOut.fill(0);
    this.prevClean.fill(0);
    this.lx1 = this.lx2 = this.ly1 = this.ly2 = 0;
    this.eh = 0;
    this.el = 0;
    this.gd = 1;
    // The gate starts at its target.
    this.fi = this.frameIndex(firstFrame);
    this.g = this.gateTarget(this.fi);
  }

  /** Produces cleaned samples of `raw` into `dest` (both take-length) until `ready` ≥ `upTo`. */
  fill(raw: Float32Array, dest: Float32Array, upTo: number): void {
    const denoise = this.denoising;
    const n = this.n;
    let guard = 0;
    while (this.outPos < upTo && guard++ < 1 << 22) {
      // 1. Read one raw sample; the denoiser finishes a hop's worth once a whole frame is in.
      const i = this.inPos++;
      const x = i >= 0 && i < raw.length ? raw[i] : 0;
      if (denoise) {
        this.dIn2[i & (2 * n - 1)] = x;
        // A pair (frames at even multiples of hop) is complete once its second frame is in.
        const startB = i + 1 - n;
        const startA = startB - this.hop;
        if (startA % (2 * this.hop) === 0) this.denoisePair(startA);
      } else {
        this.dReady = i + 1;
      }
      // 2-3. Gate, then de-ess, everything the denoiser has finished.
      if (this.gPos < this.dReady) this.drain(raw, dest, denoise);
    }
  }

  /** Gate + de-esser over [gPos, dReady), in one tight loop over locals (this runs per sample). */
  private drain(raw: Float32Array, dest: Float32Array, denoise: boolean): void {
    const dOut = this.dOut;
    const omask = 2 * this.n - 1;
    const end = this.dReady;
    const rawLen = raw.length;
    // Gate.
    const open = this.analysis.gateOpen;
    const starts = this.frameStarts;
    const gateOn = this.settings.gate > 0 && open.length > 0;
    const closed = this.gateClosed;
    const att = this.attack;
    const rel = this.release;
    let fi = this.fi;
    let g = this.g;
    let next = fi + 1 < starts.length ? starts[fi + 1] : Infinity;
    let want = open[fi] ? 1 : closed;
    // De-esser.
    const de = this.settings.deess > 0;
    const amount4 = 4 * this.settings.deess;
    const { b0, b1, b2, a1, a2 } = this.lp;
    let lx1 = this.lx1;
    let lx2 = this.lx2;
    let ly1 = this.ly1;
    let ly2 = this.ly2;
    const envA = this.envA;
    const smoothA = this.smoothA;
    let eh = this.eh;
    let el = this.el;
    let gd = this.gd;
    // Output.
    const emitFrom = this.emitFrom;
    const destLen = dest.length;
    let outPos = this.outPos;
    for (let t = this.gPos; t < end; t++) {
      let v: number;
      if (denoise) {
        v = dOut[t & omask] / 1.5;
        dOut[t & omask] = 0;
      } else {
        v = t >= 0 && t < rawLen ? raw[t] : 0;
      }
      if (gateOn) {
        while (t >= next) {
          fi++;
          next = fi + 1 < starts.length ? starts[fi + 1] : Infinity;
          want = open[fi] ? 1 : closed;
        }
        g += (want - g) * (want > g ? att : rel);
        v *= g;
      }
      if (de) {
        const low = b0 * v + b1 * lx1 + b2 * lx2 - a1 * ly1 - a2 * ly2;
        lx2 = lx1;
        lx1 = v;
        ly2 = ly1;
        ly1 = low;
        const high = v - low;
        eh += envA * (Math.abs(high) - eh);
        el += envA * (Math.abs(low) - el);
        const excess = Math.max(0, eh / (el + 1e-6) - 0.5);
        const target = eh > 1e-4 ? 1 / (1 + amount4 * excess) : 1;
        gd += (Math.max(0.1, target) - gd) * smoothA;
        v = low + high * gd;
      }
      if (t >= emitFrom && t >= 0 && t < destLen) dest[t] = v;
      outPos = t + 1;
    }
    this.gPos = end;
    this.fi = fi;
    this.g = g;
    this.eh = eh;
    this.el = el;
    this.gd = gd;
    this.lx1 = lx1;
    this.lx2 = lx2;
    this.ly1 = ly1;
    this.ly2 = ly2;
    this.outPos = outPos;
  }

  // --- stages ---------------------------------------------------------------------------------

  /**
   * Denoises the frame pair starting at `start` and `start + hop`: both real frames go through one
   * complex FFT (one in the real part, one in the imaginary part) and come back through one inverse,
   * half the FFT work of doing them one at a time. Frames are paired on a fixed grid (even frame
   * indices), so restarts land on the same pairs.
   */
  private denoisePair(start: number): void {
    const { n, re, im, win, bins, gain, prevClean } = this;
    const noise = this.invNoise!;
    const mask = n - 1;
    const hop = this.hop;
    // dIn holds 2n samples here (see fill): frame A at `start`, frame B one hop later.
    for (let i = 0; i < n; i++) {
      re[i] = this.dIn2[(start + i) & (2 * n - 1)] * win[i];
      im[i] = this.dIn2[(start + hop + i) & (2 * n - 1)] * win[i];
    }
    this.fft.forward(re, im);
    // Unpack the two spectra: A[k] = (Z[k] + conj Z[n-k]) / 2, B[k] = (Z[k] - conj Z[n-k]) / 2i.
    const ar = this.ar;
    const ai = this.ai;
    const br = this.br;
    const bi = this.bi;
    for (let k = 0; k < bins; k++) {
      const j = (n - k) & mask;
      ar[k] = 0.5 * (re[k] + re[j]);
      ai[k] = 0.5 * (im[k] - im[j]);
      br[k] = 0.5 * (im[k] + im[j]);
      bi[k] = 0.5 * (re[j] - re[k]);
    }
    const floor = Math.pow(10, -this.settings.denoiseDb / 20);
    this.wiener(ar, ai, noise, floor, gain, prevClean, bins);
    this.wiener(br, bi, noise, floor, gain, prevClean, bins);
    // Repack: Y = A' + i B' (both conjugate-symmetric), so the inverse gives a in re, b in im.
    for (let k = 0; k < bins; k++) {
      re[k] = ar[k] - bi[k];
      im[k] = ai[k] + br[k];
      if (k > 0 && k < n / 2) {
        re[n - k] = ar[k] + bi[k];
        im[n - k] = br[k] - ai[k];
      }
    }
    this.fft.inverse(re, im);
    const omask = 2 * n - 1;
    for (let i = 0; i < n; i++) {
      this.dOut[(start + i) & omask] += re[i] * win[i];
      this.dOut[(start + hop + i) & omask] += im[i] * win[i];
    }
    // Samples before start + 2 hops now have every frame that covers them.
    this.dReady = start + 2 * hop;
  }

  /** Decision-directed Wiener gain for one spectrum (in place), smoothed across bins, floored. */
  private wiener(sr: Float64Array, si: Float64Array, invNoise: Float64Array, floor: number, gain: Float64Array, prevClean: Float64Array, bins: number): void {
    for (let k = 0; k < bins; k++) {
      const p = sr[k] * sr[k] + si[k] * si[k];
      const post = p * invNoise[k];
      const prior = DD_ALPHA * (prevClean[k] * invNoise[k]) + (1 - DD_ALPHA) * Math.max(post - 1, 0);
      gain[k] = prior / (1 + prior);
    }
    let a = gain[0];
    for (let k = 0; k < bins; k++) {
      const b = gain[k];
      const c = gain[Math.min(bins - 1, k + 1)];
      const g = Math.max(floor, 0.25 * a + 0.5 * b + 0.25 * c);
      a = b;
      prevClean[k] = g * g * (sr[k] * sr[k] + si[k] * si[k]);
      sr[k] *= g;
      si[k] *= g;
    }
  }

  private frameIndex(t: number): number {
    const starts = this.frameStarts;
    let lo = 0;
    let hi = starts.length - 1;
    if (hi < 0 || t < starts[0]) return 0;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (starts[mid] <= t) lo = mid;
      else hi = mid - 1;
    }
    return lo;
  }

  private gateTarget(fi: number): number {
    const open = this.analysis.gateOpen;
    if (this.settings.gate <= 0 || open.length === 0) return 1;
    return open[fi] ? 1 : this.gateClosed;
  }
}

/** 2nd-order Butterworth low-pass (cutoff as a fraction of the sample rate). */
function lowpassBiquad(cutoff: number): { b0: number; b1: number; b2: number; a1: number; a2: number } {
  const w0 = 2 * Math.PI * cutoff;
  const alpha = Math.sin(w0) / (2 * Math.SQRT1_2);
  const cos = Math.cos(w0);
  const a0 = 1 + alpha;
  return { b0: (1 - cos) / 2 / a0, b1: (1 - cos) / a0, b2: (1 - cos) / 2 / a0, a1: (-2 * cos) / a0, a2: (1 - alpha) / a0 };
}

/** Runs the stream over a whole take (offline): the same samples the engine plays from position 0. */
export function cleanupTake(raw: Float32Array, sampleRate: number, analysis: CleanupAnalysis, settings: CleanupSettings): Float32Array {
  const out = new Float32Array(raw.length);
  if (!cleanupActive(settings, analysis)) {
    out.set(raw);
    return out;
  }
  const s = new CleanupStream(sampleRate, analysis);
  s.setSettings(settings);
  s.startAt(0);
  s.fill(raw, out, raw.length);
  return out;
}
