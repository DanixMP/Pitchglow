// Streaming integer-factor decimator: windowed-sinc low-pass, then keep every Nth sample.
// Used to bring 44.1/48 kHz input down to ~22-24 kHz before pitch analysis (YIN cost is O(N²)).

/** Pick the integer factor that brings `inputRate` closest to (but not below) `targetRate`. */
export function decimationFactor(inputRate: number, targetRate: number): number {
  return Math.max(1, Math.floor(inputRate / targetRate));
}

/** Blackman-windowed sinc low-pass. `cutoff` is in cycles/sample (0.5 = Nyquist). */
export function lowpassTaps(numTaps: number, cutoff: number): Float32Array {
  const taps = new Float32Array(numTaps);
  const mid = (numTaps - 1) / 2;
  let sum = 0;
  for (let i = 0; i < numTaps; i++) {
    const x = i - mid;
    const sinc = x === 0 ? 2 * cutoff : Math.sin(2 * Math.PI * cutoff * x) / (Math.PI * x);
    const w =
      0.42 -
      0.5 * Math.cos((2 * Math.PI * i) / (numTaps - 1)) +
      0.08 * Math.cos((4 * Math.PI * i) / (numTaps - 1));
    taps[i] = sinc * w;
    sum += taps[i];
  }
  for (let i = 0; i < numTaps; i++) taps[i] /= sum; // unity gain at DC
  return taps;
}

export class Decimator {
  readonly factor: number;
  readonly outputRate: number;
  private readonly taps: Float32Array;
  private history: Float32Array;
  /** Index in the next input block where the next output sample falls. */
  private phase = 0;

  constructor(inputRate: number, factor: number, numTaps = 31) {
    this.factor = factor;
    this.outputRate = inputRate / factor;
    this.taps = lowpassTaps(numTaps, 0.4 / factor);
    this.history = new Float32Array(numTaps - 1);
  }

  process(input: Float32Array): Float32Array {
    if (this.factor === 1) return input;
    const n = this.taps.length;
    const work = new Float32Array(n - 1 + input.length);
    work.set(this.history);
    work.set(input, n - 1);

    const out = new Float32Array(Math.ceil((input.length - this.phase) / this.factor));
    let o = 0;
    let i = this.phase;
    for (; i < input.length; i += this.factor) {
      // work[i + n - 1] is input[i]; the filter window ends there.
      let acc = 0;
      for (let k = 0; k < n; k++) acc += this.taps[k] * work[i + k];
      out[o++] = acc;
    }
    this.phase = i - input.length;
    this.history = work.slice(work.length - (n - 1));
    return o === out.length ? out : out.subarray(0, o);
  }
}
