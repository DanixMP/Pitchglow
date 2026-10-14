// Waveform overview: the peak level per time bucket, for drawing clips on the timeline.

export const PEAKS_PER_SECOND = 100;

/** Peak |sample| per bucket, `bucketsPerSecond` buckets per second (max over channels). */
export function computePeaks(channels: readonly Float32Array[], sampleRate: number, bucketsPerSecond = PEAKS_PER_SECOND): Float32Array {
  const length = channels[0]?.length ?? 0;
  const size = Math.max(1, Math.round(sampleRate / bucketsPerSecond));
  const out = new Float32Array(Math.ceil(length / size));
  for (const ch of channels) {
    for (let b = 0; b < out.length; b++) {
      let peak = out[b];
      const end = Math.min(length, (b + 1) * size);
      for (let i = b * size; i < end; i++) {
        const v = Math.abs(ch[i]);
        if (v > peak) peak = v;
      }
      out[b] = peak;
    }
  }
  return out;
}

/** Peaks cached per audio array / buffer, so each take or instrumental is scanned once. */
const cache = new WeakMap<object, Float32Array>();

export function peaksOf(audio: { samples: Float32Array; sampleRate: number; buffer?: AudioBuffer }): Float32Array {
  const key = audio.buffer ?? audio.samples;
  let p = cache.get(key);
  if (!p) {
    const b = audio.buffer;
    p = b
      ? computePeaks(Array.from({ length: b.numberOfChannels }, (_, c) => b.getChannelData(c)), b.sampleRate)
      : computePeaks([audio.samples], audio.sampleRate);
    cache.set(key, p);
  }
  return p;
}
