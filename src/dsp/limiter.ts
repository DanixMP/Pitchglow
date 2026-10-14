// Look-ahead peak limiter: keeps |output| <= ceiling by turning down only the loud moments.
//
// 1. Required gain per sample: min(1, ceiling / |x|).
// 2. Sliding minimum over ±window, then a moving average over the same width. Every averaged value
//    near a peak comes from windows that contain the peak, so the gain is already low enough when the
//    peak arrives (no overshoot) and the gain change is smooth (no clicks).
// 3. Gain recovers slowly after a peak (release), so it doesn't pump.

export interface LimiterOptions {
  ceiling?: number;
  /** Look-ahead / smoothing window in seconds. */
  windowSeconds?: number;
  /** Time to recover most of the way back to unity gain, in seconds. */
  releaseSeconds?: number;
}

export function limit(x: Float32Array, sampleRate: number, opts: LimiterOptions = {}): Float32Array {
  return limitLinked([x], sampleRate, opts)[0];
}

/**
 * Multi-channel version with one gain curve for all channels (driven by the loudest), so a stereo
 * mix is turned down evenly and its image doesn't shift.
 */
export function limitLinked(channels: readonly Float32Array[], sampleRate: number, opts: LimiterOptions = {}): Float32Array[] {
  const { ceiling = 0.98, windowSeconds = 0.005, releaseSeconds = 0.08 } = opts;
  const n = channels[0]?.length ?? 0;
  const half = Math.max(1, Math.round((windowSeconds * sampleRate) / 2));

  const required = new Float32Array(n);
  let needed = false;
  for (let i = 0; i < n; i++) {
    let a = 0;
    for (const ch of channels) a = Math.max(a, Math.abs(ch[i]));
    required[i] = a > ceiling ? ceiling / a : 1;
    if (a > ceiling) needed = true;
  }
  if (!needed) return channels.map((ch) => ch.slice());

  const minimum = slidingMin(required, half);
  const averaged = movingAverage(minimum, half);

  const gain = new Float32Array(n);
  const release = 1 - Math.exp(-1 / (releaseSeconds * sampleRate));
  let g = 1;
  for (let i = 0; i < n; i++) {
    const target = averaged[i];
    g = target < g ? target : g + (target - g) * release;
    gain[i] = g;
  }
  return channels.map((ch) => ch.map((v, i) => v * gain[i]));
}

/** min(x[i-half .. i+half]) for every i, in O(n) with a monotonic deque. */
function slidingMin(x: Float32Array, half: number): Float32Array {
  const n = x.length;
  const out = new Float32Array(n);
  const deque = new Int32Array(n);
  let head = 0;
  let tail = 0;
  let next = 0; // next index to push
  for (let i = 0; i < n; i++) {
    const hi = Math.min(n - 1, i + half);
    while (next <= hi) {
      while (tail > head && x[deque[tail - 1]] >= x[next]) tail--;
      deque[tail++] = next++;
    }
    while (deque[head] < i - half) head++;
    out[i] = x[deque[head]];
  }
  return out;
}

/** Mean of x[i-half .. i+half] (clamped at the edges). */
function movingAverage(x: Float32Array, half: number): Float32Array {
  const n = x.length;
  const prefix = new Float64Array(n + 1);
  for (let i = 0; i < n; i++) prefix[i + 1] = prefix[i] + x[i];
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const lo = Math.max(0, i - half);
    const hi = Math.min(n - 1, i + half);
    out[i] = (prefix[hi + 1] - prefix[lo]) / (hi - lo + 1);
  }
  return out;
}
