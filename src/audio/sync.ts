// Timing for recording over the beat. Everything is in one AudioContext's clock (seconds).
//
// The song starts playing song position `songPosition` at context time `playStart`. You *hear* it
// `outputLatency` later, sing along, and your voice reaches the capture worklet `inputLatency` after
// you sing. So what the worklet processes at context time t belongs at song position
//   songPosition + (t - playStart) - (outputLatency + inputLatency).
// A take whose first sample was processed at `firstSampleTime` therefore starts at that song position.
// `nudge` (seconds, from the user or calibration) moves the take later (+) or earlier (−).

export interface AlignInput {
  /** Context time the song began playing `songPosition`. */
  playStart: number;
  songPosition: number;
  /** Context time of the take's first captured sample. */
  firstSampleTime: number;
  outputLatency: number;
  inputLatency: number;
  nudge?: number;
}

/** Song-time offset for the new track (may be negative: the take started before the song). */
export function alignTake(i: AlignInput): number {
  return i.songPosition + (i.firstSampleTime - i.playStart) - (i.outputLatency + i.inputLatency) + (i.nudge ?? 0);
}

/**
 * Loopback calibration: clicks were scheduled at `clickTimes` (context time) through the speakers and
 * recorded by the mic; `samples[0]` was processed at `startTime`. Returns the median delay from each
 * scheduled click to where it shows up in the recording (= the real round-trip latency), or null if
 * too few clicks were heard.
 */
export function detectClickLatency(
  samples: Float32Array,
  startTime: number,
  sampleRate: number,
  clickTimes: readonly number[],
  maxDelay = 0.5,
): number | null {
  const delays: number[] = [];
  for (const t of clickTimes) {
    const from = Math.max(0, Math.round((t - startTime) * sampleRate));
    const to = Math.min(samples.length, from + Math.round(maxDelay * sampleRate));
    if (to - from < 16) continue;
    // Noise floor from just before the click; onset = first sample well above it and near the peak.
    let peak = 0;
    for (let i = from; i < to; i++) peak = Math.max(peak, Math.abs(samples[i]));
    const pre = samples.subarray(Math.max(0, from - Math.round(0.05 * sampleRate)), from);
    let floor = 0;
    for (const v of pre) floor = Math.max(floor, Math.abs(v));
    if (peak < Math.max(0.02, floor * 4)) continue; // click not audible over the room
    const threshold = Math.max(floor * 2, peak * 0.3);
    for (let i = from; i < to; i++) {
      if (Math.abs(samples[i]) >= threshold) {
        delays.push(startTime + i / sampleRate - t);
        break;
      }
    }
  }
  if (delays.length < Math.ceil(clickTimes.length / 2)) return null;
  delays.sort((a, b) => a - b);
  return delays[delays.length >> 1];
}
