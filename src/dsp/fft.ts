// In-place iterative radix-2 complex FFT with precomputed tables (size must be a power of two).

export class FFT {
  readonly size: number;
  private readonly rev: Uint32Array;
  private readonly cos: Float64Array;
  private readonly sin: Float64Array;
  /** Twiddle sines for the inverse transform (the forward ones negated). */
  private readonly sinInv: Float64Array;

  constructor(size: number) {
    if (size < 2 || (size & (size - 1)) !== 0) throw new Error(`FFT size must be a power of two, got ${size}`);
    this.size = size;
    const bits = Math.log2(size);
    this.rev = new Uint32Array(size);
    for (let i = 0; i < size; i++) {
      let r = 0;
      for (let b = 0; b < bits; b++) r |= ((i >> b) & 1) << (bits - 1 - b);
      this.rev[i] = r;
    }
    this.cos = new Float64Array(size / 2);
    this.sin = new Float64Array(size / 2);
    for (let i = 0; i < size / 2; i++) {
      this.cos[i] = Math.cos((2 * Math.PI * i) / size);
      this.sin[i] = -Math.sin((2 * Math.PI * i) / size);
    }
    this.sinInv = this.sin.map((v) => -v);
  }

  /** Forward transform, in place. */
  forward(re: Float64Array, im: Float64Array): void {
    this.transform(re, im, false);
  }

  /** Inverse transform (scaled by 1/N), in place. */
  inverse(re: Float64Array, im: Float64Array): void {
    this.transform(re, im, true);
    const n = this.size;
    const g = 1 / n;
    for (let i = 0; i < n; i++) {
      re[i] *= g;
      im[i] *= g;
    }
  }

  private transform(re: Float64Array, im: Float64Array, inverse: boolean): void {
    const n = this.size;
    const { rev, cos } = this;
    const sin = inverse ? this.sinInv : this.sin;
    for (let i = 0; i < n; i++) {
      const j = rev[i];
      if (j > i) {
        let t = re[i];
        re[i] = re[j];
        re[j] = t;
        t = im[i];
        im[i] = im[j];
        im[j] = t;
      }
    }
    // Stage 1 (pairs): the twiddle is 1.
    for (let a = 0; a < n; a += 2) {
      const xr = re[a + 1];
      const xi = im[a + 1];
      re[a + 1] = re[a] - xr;
      im[a + 1] = im[a] - xi;
      re[a] += xr;
      im[a] += xi;
    }
    if (n < 4) return;
    // Stage 2 (quads): twiddles 1 and ∓i.
    const wi1 = inverse ? 1 : -1;
    for (let a = 0; a < n; a += 4) {
      let xr = re[a + 2];
      let xi = im[a + 2];
      re[a + 2] = re[a] - xr;
      im[a + 2] = im[a] - xi;
      re[a] += xr;
      im[a] += xi;
      const b = a + 3;
      xr = -im[b] * wi1;
      xi = re[b] * wi1;
      re[b] = re[a + 1] - xr;
      im[b] = im[a + 1] - xi;
      re[a + 1] += xr;
      im[a + 1] += xi;
    }
    // Remaining stages: each twiddle loaded once per stage (outer loop), butterflies inside.
    for (let len = 8; len <= n; len <<= 1) {
      const half = len >> 1;
      const step = n / len;
      for (let k = 0; k < half; k++) {
        const wr = cos[k * step];
        const wi = sin[k * step];
        for (let a = k; a < n; a += len) {
          const b = a + half;
          const br = re[b];
          const bi = im[b];
          const xr = br * wr - bi * wi;
          const xi = br * wi + bi * wr;
          re[b] = re[a] - xr;
          im[b] = im[a] - xi;
          re[a] += xr;
          im[a] += xi;
        }
      }
    }
  }
}
