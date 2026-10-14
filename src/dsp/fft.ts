// In-place iterative radix-2 complex FFT with precomputed tables (size must be a power of two).

export class FFT {
  readonly size: number;
  private readonly rev: Uint32Array;
  private readonly cos: Float64Array;
  private readonly sin: Float64Array;

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
  }

  /** Forward transform, in place. */
  forward(re: Float64Array, im: Float64Array): void {
    this.transform(re, im, false);
  }

  /** Inverse transform (scaled by 1/N), in place. */
  inverse(re: Float64Array, im: Float64Array): void {
    this.transform(re, im, true);
    const n = this.size;
    for (let i = 0; i < n; i++) {
      re[i] /= n;
      im[i] /= n;
    }
  }

  private transform(re: Float64Array, im: Float64Array, inverse: boolean): void {
    const n = this.size;
    const { rev, cos, sin } = this;
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
    const sign = inverse ? -1 : 1;
    for (let len = 2; len <= n; len <<= 1) {
      const half = len >> 1;
      const step = n / len;
      for (let start = 0; start < n; start += len) {
        for (let k = 0; k < half; k++) {
          const wr = cos[k * step];
          const wi = sign * sin[k * step];
          const a = start + k;
          const b = a + half;
          const xr = re[b] * wr - im[b] * wi;
          const xi = re[b] * wi + im[b] * wr;
          re[b] = re[a] - xr;
          im[b] = im[a] - xi;
          re[a] += xr;
          im[a] += xi;
        }
      }
    }
  }
}
