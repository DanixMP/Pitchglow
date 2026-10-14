// YIN fundamental-frequency estimator (de Cheveigné & Kawahara, 2002).
// This is the "slide a copy of the wave until it lines up" idea from Goal.mp4 (0:28-0:42):
// the lag where the copy matches best is one period of the voice.

export interface YinOptions {
  /** Lowest detectable pitch in Hz. */
  minFreq?: number;
  /** Highest detectable pitch in Hz. */
  maxFreq?: number;
  /** Integration window length in seconds. */
  windowSeconds?: number;
  /** Absolute threshold on the normalized difference (lower = stricter). */
  threshold?: number;
}

export interface PitchEstimate {
  freq: number;
  /** 1 - normalized difference at the chosen lag; ~1 for a clean periodic signal, low for noise. */
  clarity: number;
}

export class Yin {
  readonly sampleRate: number;
  readonly windowSize: number;
  readonly tauMin: number;
  readonly tauMax: number;
  /** Samples needed per call to `detect`. */
  readonly frameLength: number;
  private readonly threshold: number;
  private readonly diff: Float32Array;

  constructor(sampleRate: number, opts: YinOptions = {}) {
    const { minFreq = 60, maxFreq = 1100, windowSeconds = 0.025, threshold = 0.15 } = opts;
    this.sampleRate = sampleRate;
    this.threshold = threshold;
    this.tauMin = Math.max(2, Math.floor(sampleRate / maxFreq));
    this.tauMax = Math.ceil(sampleRate / minFreq);
    this.windowSize = Math.max(Math.round(sampleRate * windowSeconds), this.tauMax);
    this.frameLength = this.windowSize + this.tauMax + 1;
    this.diff = new Float32Array(this.tauMax + 2);
  }

  /** Estimate pitch from `frame[0 .. frameLength)`. Returns null if nothing periodic was found. */
  detect(frame: Float32Array): PitchEstimate | null {
    const { windowSize: w, tauMax, tauMin, diff } = this;
    if (frame.length < this.frameLength) throw new Error(`YIN frame too short: ${frame.length} < ${this.frameLength}`);

    // 1-2. Difference function + cumulative mean normalization, computed in one pass.
    diff[0] = 1;
    let runningSum = 0;
    for (let tau = 1; tau <= tauMax + 1; tau++) {
      let d = 0;
      for (let j = 0; j < w; j++) {
        const delta = frame[j] - frame[j + tau];
        d += delta * delta;
      }
      runningSum += d;
      diff[tau] = runningSum > 0 ? (d * tau) / runningSum : 1;
    }

    // 3. First dip below threshold, then walk down to its local minimum.
    let tau = -1;
    for (let t = tauMin; t <= tauMax; t++) {
      if (diff[t] < this.threshold) {
        while (t + 1 <= tauMax && diff[t + 1] < diff[t]) t++;
        tau = t;
        break;
      }
    }
    // No dip below threshold: fall back to the global minimum (caller gates on clarity).
    if (tau < 0) {
      let best = tauMin;
      for (let t = tauMin + 1; t <= tauMax; t++) if (diff[t] < diff[best]) best = t;
      tau = best;
    }

    // 4. Parabolic interpolation for sub-sample accuracy.
    let refined = tau;
    if (tau > 1 && tau <= tauMax) {
      const a = diff[tau - 1];
      const b = diff[tau];
      const c = diff[tau + 1];
      const denom = a - 2 * b + c;
      if (denom > 0) refined = tau + (0.5 * (a - c)) / denom;
    }

    const clarity = 1 - Math.min(1, diff[tau]);
    if (!(refined > 0)) return null;
    return { freq: this.sampleRate / refined, clarity };
  }
}
