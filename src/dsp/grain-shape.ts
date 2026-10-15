// Voice character for PSOLA grains (Phase 15): what goes *into* a grain, before it is windowed and
// overlap-added.
// - Formant shift: the grain is read faster (formants up: younger, chipmunk) or slower (formants
//   down: deeper, monster) around its centre. The pitch doesn't change, since it comes from the
//   grain spacing.
// - Whisper: the grain's spectral envelope (LPC, order 24) is kept and its excitation replaced by
//   noise, so the voice keeps its vowels but loses its pitch.
// Shared by the offline renderer, the playback engine and the live voice. Allocates only in the
// constructor.

/** Largest grain half-length shaped (longer grains, i.e. voices below ~44 Hz, are left as they are). */
export const SHAPE_MAX_HALF = 1100;
const ORDER = 24;

export interface GrainVoice {
  /** Formant ratio (1 = natural). */
  formant: number;
  /** Whisper amount 0..1. */
  whisper: number;
  /** Seed for the whisper noise (per voice), combined with the grain index. */
  seed: number;
}

export class GrainShaper {
  /** The last shaped grain: out[k + half] for k = -half … half. */
  readonly out = new Float32Array(2 * SHAPE_MAX_HALF + 1);
  private readonly noise = new Float32Array(2 * SHAPE_MAX_HALF + 1);
  private readonly r = new Float64Array(ORDER + 1);
  private readonly a = new Float64Array(ORDER + 1);
  private readonly tmp = new Float64Array(ORDER + 1);

  /**
   * Shapes the grain centred on `center` with half-length `half` (≤ SHAPE_MAX_HALF) into `out`.
   * Source samples outside [lo, hi) count as silence. With `mask` ≥ 0 the source is a ring buffer
   * indexed `i & mask` (the live voice).
   */
  shape(src: Float32Array, center: number, half: number, voice: GrainVoice, grainIndex: number, lo: number, hi: number, mask = -1): Float32Array {
    const out = this.out;
    const len = 2 * half + 1;
    const phi = voice.formant;
    for (let j = 0; j < len; j++) {
      const pos = center + (j - half) * phi;
      const i0 = Math.floor(pos);
      const fr = pos - i0;
      const a = i0 >= lo && i0 < hi ? src[mask >= 0 ? i0 & mask : i0] : 0;
      const b = i0 + 1 >= lo && i0 + 1 < hi ? src[mask >= 0 ? (i0 + 1) & mask : i0 + 1] : 0;
      out[j] = a + (b - a) * fr;
    }
    if (voice.whisper > 0) this.whisper(len, half, voice.whisper, (Math.imul(grainIndex, 2654435761) ^ voice.seed) >>> 0);
    return out;
  }

  /** Replaces (blends) out[0..len) with noise through the grain's LPC envelope, at the same energy. */
  private whisper(len: number, half: number, amount: number, seed: number): void {
    const out = this.out;
    const r = this.r;
    // Autocorrelation of the Hann-windowed grain.
    for (let lag = 0; lag <= ORDER; lag++) {
      let s = 0;
      for (let j = lag; j < len; j++) s += out[j] * win(j, half) * out[j - lag] * win(j - lag, half);
      r[lag] = s;
    }
    if (r[0] <= 1e-12) return;
    r[0] *= 1 + 1e-6; // a touch of white noise keeps the recursion stable
    // Levinson-Durbin.
    const a = this.a;
    const tmp = this.tmp;
    a.fill(0);
    a[0] = 1;
    let err = r[0];
    for (let i = 1; i <= ORDER; i++) {
      let acc = r[i];
      for (let j = 1; j < i; j++) acc += a[j] * r[i - j];
      const k = -acc / err;
      tmp.set(a);
      for (let j = 1; j < i; j++) a[j] = tmp[j] + k * tmp[i - j];
      a[i] = k;
      err *= 1 - k * k;
      if (err <= 0) return;
    }
    // Noise through 1/A(z), deterministic per grain (so any block split gives the same grain).
    const y = this.noise;
    let s = seed || 1;
    for (let j = 0; j < len; j++) {
      s ^= s << 13;
      s ^= s >>> 17;
      s ^= s << 5;
      let v = ((s >>> 0) / 4294967296) * 2 - 1;
      for (let i = 1; i <= ORDER && i <= j; i++) v -= a[i] * y[j - i];
      y[j] = v;
    }
    // Same windowed energy as the voiced grain, then blend.
    let ev = 0;
    let en = 0;
    for (let j = 0; j < len; j++) {
      const w = win(j, half);
      ev += out[j] * out[j] * w * w;
      en += y[j] * y[j] * w * w;
    }
    const g = en > 0 ? Math.sqrt(ev / en) : 0;
    for (let j = 0; j < len; j++) out[j] = (1 - amount) * out[j] + amount * g * y[j];
  }
}

function win(j: number, half: number): number {
  return 0.5 + 0.5 * Math.cos((Math.PI * (j - half)) / (half + 1));
}

/**
 * A few shaped grains of one plan, by grain index, so a grain spanning several 128-sample blocks is
 * shaped once. Cleared when the plan or source changes.
 */
export class GrainCache {
  private readonly shaper = new GrainShaper();
  private readonly slots: Float32Array[];
  private readonly keys: Int32Array;
  private next = 0;
  private owner: unknown = null;

  constructor(size = 8) {
    this.slots = Array.from({ length: size }, () => new Float32Array(2 * SHAPE_MAX_HALF + 1));
    this.keys = new Int32Array(size).fill(-1);
  }

  /** The shaped grain `g` (centre `center`, half `half`) of `owner`'s plan over `src`. */
  get(owner: unknown, g: number, src: Float32Array, center: number, half: number, voice: GrainVoice, n: number): Float32Array {
    if (owner !== this.owner) {
      this.keys.fill(-1);
      this.owner = owner;
    }
    for (let i = 0; i < this.keys.length; i++) if (this.keys[i] === g) return this.slots[i];
    const shaped = this.shaper.shape(src, center, half, voice, g, 0, n);
    const slot = this.next;
    this.next = (this.next + 1) % this.keys.length;
    this.slots[slot].set(shaped.subarray(0, 2 * half + 1));
    this.keys[slot] = g;
    return this.slots[slot];
  }

  clear(): void {
    this.keys.fill(-1);
    this.owner = null;
  }
}
