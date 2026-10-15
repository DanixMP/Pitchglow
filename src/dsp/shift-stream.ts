// Streaming phase-vocoder pitch shift for instrumentals (Phase 15): the beat's key shift, live.
//
// Same method as before (time-stretch by r = 2^(st/12), then read the stretched signal r times faster),
// but as a generator: the source is known, so it renders whatever position playback asks for,
// restarting (with a short warm-up) after a seek or loop wrap.
// - STFT 2048 / synthesis hop 512 (75% overlap), analysis hop 512 / r.
// - Stereo: L goes in the real part and R in the imaginary part of one complex FFT (and back through
//   one inverse), half the FFT work of doing the channels separately.
// - Identity phase locking per channel (Laroche & Dolson): peaks advance at their true frequency,
//   the bins around a peak keep their phase relative to it.
// - Read-out: 4-point Catmull-Rom.
// Allocates only in the constructor.

import { FFT } from './fft';

const N = 2048;
const HOP = 512;
const BINS = N / 2 + 1;
/** Stretched-domain ring (OLA accumulators); comfortably more than a restart's warm-up reaches. */
const RING = 1 << 15;
const RMASK = RING - 1;
/** Input before the restart position that's analysed first (phases settle). */
const WARMUP = 2 * N;

export class ShiftStream {
  private readonly src: Float32Array[];
  private readonly stereo: boolean;
  private ratio = 1;
  private hopIn = HOP;
  private readonly fft = new FFT(N);
  private readonly win = new Float64Array(N);
  private readonly re = new Float64Array(N);
  private readonly im = new Float64Array(N);
  private readonly omega = new Float64Array(BINS);
  // Per channel: this frame's spectrum and squared magnitude, the previous frame's spectrum, each
  // bin's rotation (synthesis phase minus analysis phase), peaks and their rotation this frame.
  private readonly xr = [new Float64Array(BINS), new Float64Array(BINS)];
  private readonly xi = [new Float64Array(BINS), new Float64Array(BINS)];
  private readonly m2 = [new Float64Array(BINS), new Float64Array(BINS)];
  private readonly pr = [new Float64Array(BINS), new Float64Array(BINS)];
  private readonly pi = [new Float64Array(BINS), new Float64Array(BINS)];
  private readonly theta = [new Float64Array(BINS), new Float64Array(BINS)];
  private readonly peaks = [new Int32Array(BINS), new Int32Array(BINS)];
  private readonly peakTheta = new Float64Array(BINS);
  private readonly peakCos = new Float64Array(BINS);
  private readonly peakSin = new Float64Array(BINS);
  // Stretched output (overlap-added) per channel and the summed squared window.
  private readonly acc = [new Float64Array(RING), new Float64Array(RING)];
  private readonly norm = new Float64Array(RING);
  /** Finished, normalised stretched samples per channel (what the read-out interpolates). */
  private readonly y = [new Float32Array(RING), new Float32Array(RING)];

  /** Input position that stretched position N/2 corresponds to (set by startAt). */
  private a0 = 0;
  /** Next frame to analyse/synthesise. */
  private frame = 0;
  private prevStart = 0;
  /** Stretched samples below this are complete. */
  private done = 0;
  /** Next output position. */
  private out = 0;

  constructor(channels: readonly Float32Array[]) {
    this.src = [channels[0], channels[1] ?? channels[0]];
    this.stereo = channels.length > 1;
    for (let i = 0; i < N; i++) this.win[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / N);
    for (let k = 0; k < BINS; k++) this.omega[k] = (2 * Math.PI * k) / N;
  }

  get length(): number {
    return this.src[0].length;
  }

  /** The output position the stream will produce next (anything else needs `startAt`). */
  get next(): number {
    return this.out;
  }

  get semitones(): number {
    return 12 * Math.log2(this.ratio);
  }

  /** New shift; takes effect from the next `startAt` (the caller restarts at the current position). */
  setSemitones(st: number): void {
    this.ratio = Math.pow(2, st / 12);
    this.hopIn = HOP / this.ratio;
  }

  /** Restarts so that output position `p` comes next (analysis warms up from p - WARMUP). */
  startAt(p: number): void {
    this.a0 = p - WARMUP;
    this.frame = 0;
    this.prevStart = 0;
    this.done = 0;
    this.out = p;
    for (let c = 0; c < 2; c++) {
      this.acc[c].fill(0);
      this.y[c].fill(0);
      this.pr[c].fill(0);
      this.pi[c].fill(0);
      this.theta[c].fill(0);
    }
    this.norm.fill(0);
  }

  /** Writes `len` shifted samples (positions next … next+len) into outs[c][offset …]. */
  render(len: number, outs: Float32Array[], offset: number): void {
    const r = this.ratio;
    const o0 = outs[0];
    const o1 = outs[1] ?? null;
    const y0 = this.y[0];
    const y1 = this.y[1];
    const stereo = this.stereo;
    for (let i = 0; i < len; i++) {
      const p = this.out++;
      // Stretched position this output reads: centre-aligned mapping, r stretched samples per output.
      const s = N / 2 + (p - this.a0 - N / 2) * r;
      const k = Math.floor(s);
      while (this.done <= k + 2) this.step();
      const t = s - k;
      // Catmull-Rom over the finished (normalised) stretched samples k-1 … k+2.
      const q0 = (k - 1) & RMASK;
      const q1 = k & RMASK;
      const q2 = (k + 1) & RMASK;
      const q3 = (k + 2) & RMASK;
      let a = y0[q0];
      let b = y0[q1];
      let c = y0[q2];
      let d = y0[q3];
      const v0 = b + 0.5 * t * (c - a + t * (2 * a - 5 * b + 4 * c - d + t * (3 * (b - c) + d - a)));
      o0[offset + i] = v0;
      if (o1) {
        if (stereo) {
          a = y1[q0];
          b = y1[q1];
          c = y1[q2];
          d = y1[q3];
          o1[offset + i] = b + 0.5 * t * (c - a + t * (2 * a - 5 * b + 4 * c - d + t * (3 * (b - c) + d - a)));
        } else {
          o1[offset + i] = v0;
        }
      }
    }
  }

  /** Analyses and synthesises the next frame, overlap-adding it into the stretched rings. */
  private step(): void {
    const f = this.frame++;
    const { re, im, win } = this;
    const start = Math.round(this.a0 + f * this.hopIn);
    const L = this.src[0];
    const R = this.src[1];
    const n = L.length;
    for (let i = 0; i < N; i++) {
      const j = start + i;
      const inside = j >= 0 && j < n;
      re[i] = inside ? L[j] * win[i] : 0;
      im[i] = inside && this.stereo ? R[j] * win[i] : 0;
    }
    this.fft.forward(re, im);
    // Unpack: X0[k] = (Z[k] + conj Z[N-k]) / 2, X1[k] = (Z[k] - conj Z[N-k]) / 2i.
    const channels = this.stereo ? 2 : 1;
    const x0r = this.xr[0];
    const x0i = this.xi[0];
    const x1r = this.xr[1];
    const x1i = this.xi[1];
    for (let k = 0; k < BINS; k++) {
      const j = (N - k) & (N - 1);
      x0r[k] = 0.5 * (re[k] + re[j]);
      x0i[k] = 0.5 * (im[k] - im[j]);
      if (channels === 2) {
        x1r[k] = 0.5 * (im[k] + im[j]);
        x1i[k] = 0.5 * (re[j] - re[k]);
      }
    }
    const realHop = f === 0 ? this.hopIn : start - this.prevStart;
    for (let c = 0; c < channels; c++) this.rotate(c, f === 0, realHop);
    this.prevStart = start;

    // Repack Y = Y0 + i Y1 (both conjugate-symmetric) and go back to the time domain.
    for (let k = 0; k < BINS; k++) {
      const a = x0r[k];
      const b = x0i[k];
      const c1 = channels === 2 ? x1r[k] : 0;
      const d1 = channels === 2 ? x1i[k] : 0;
      re[k] = a - d1;
      im[k] = b + c1;
      if (k > 0 && k < N / 2) {
        re[N - k] = a + d1;
        im[N - k] = c1 - b;
      }
    }
    this.fft.inverse(re, im);
    const sf = f * HOP;
    // The newest hop of the ring was last used RING samples ago: clear it before adding.
    for (let i = N - HOP; i < N; i++) {
      const q = (sf + i) & RMASK;
      this.acc[0][q] = 0;
      this.acc[1][q] = 0;
      this.norm[q] = 0;
    }
    for (let i = 0; i < N; i++) {
      const q = (sf + i) & RMASK;
      const w = win[i];
      this.acc[0][q] += re[i] * w;
      if (channels === 2) this.acc[1][q] += im[i] * w;
      this.norm[q] += w * w;
    }
    // Stretched samples [sf, sf + HOP) are finished: normalise them once, for the read-out.
    for (let i = 0; i < HOP; i++) {
      const q = (sf + i) & RMASK;
      const nn = this.norm[q];
      const g = nn > 1e-6 ? 1 / nn : 0;
      this.y[0][q] = this.acc[0][q] * g;
      if (channels === 2) this.y[1][q] = this.acc[1][q] * g;
    }
    this.done = sf + HOP;
  }

  /**
   * Phase vocoder with identity phase locking, for one channel, in place on its spectrum. With
   * locking, every bin turns by the same angle as the peak it belongs to (synthesis phase minus
   * analysis phase), so trigonometry is only needed per peak: the phase advance from X·conj(X_prev),
   * and the rotation's cos/sin. The other bins are one complex multiply each.
   */
  private rotate(c: number, first: boolean, realHop: number): void {
    const xr = this.xr[c];
    const xi = this.xi[c];
    const m2 = this.m2[c];
    const pr = this.pr[c];
    const pi = this.pi[c];
    const theta = this.theta[c];
    const peaks = this.peaks[c];
    for (let k = 0; k < BINS; k++) m2[k] = xr[k] * xr[k] + xi[k] * xi[k];
    let count = 0;
    for (let k = 1; k < BINS - 1; k++) if (m2[k] > m2[k - 1] && m2[k] >= m2[k + 1]) peaks[count++] = k;
    if (first || count === 0) {
      // Synthesis phase = analysis phase: no rotation.
      theta.fill(0);
    } else {
      // Each peak advances at its true frequency.
      const stretch = HOP / realHop - 1;
      for (let i = 0; i < count; i++) {
        const k = peaks[i];
        const w = this.omega[k];
        const d = Math.atan2(xi[k] * pr[k] - xr[k] * pi[k], xr[k] * pr[k] + xi[k] * pi[k]);
        const delta = princarg(d - w * realHop);
        const t = princarg(theta[k] + w * (HOP - realHop) + delta * stretch);
        this.peakTheta[i] = t;
        this.peakCos[i] = Math.cos(t);
        this.peakSin[i] = Math.sin(t);
      }
      // Every bin takes its nearest peak's rotation.
      let p = 0;
      for (let k = 0; k < BINS; k++) {
        while (p + 1 < count && Math.abs(peaks[p + 1] - k) < Math.abs(peaks[p] - k)) p++;
        theta[k] = this.peakTheta[p];
      }
    }
    // Keep this frame's spectrum for the next phase advance, then rotate it.
    pr.set(xr);
    pi.set(xi);
    if (first || count === 0) return;
    let p = 0;
    for (let k = 0; k < BINS; k++) {
      while (p + 1 < count && Math.abs(peaks[p + 1] - k) < Math.abs(peaks[p] - k)) p++;
      const cs = this.peakCos[p];
      const sn = this.peakSin[p];
      const a = xr[k];
      const b = xi[k];
      xr[k] = a * cs - b * sn;
      xi[k] = a * sn + b * cs;
    }
  }
}

function princarg(phase: number): number {
  return phase - 2 * Math.PI * Math.round(phase / (2 * Math.PI));
}

/** Shifts whole channels offline (export, tests): the stream run once from the start. */
export function shiftChannels(channels: readonly Float32Array[], semitones: number): Float32Array[] {
  const out = channels.map((c) => new Float32Array(c.length));
  if (semitones === 0) {
    channels.forEach((c, i) => out[i].set(c));
    return out;
  }
  const s = new ShiftStream(channels);
  s.setSemitones(semitones);
  s.startAt(0);
  s.render(channels[0].length, out, 0);
  return out;
}
