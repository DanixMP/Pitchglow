// Algorithmic impulse responses for the reverb bus (ConvolverNode): decaying noise, independently
// generated for L and R (wide stereo), darkening over time (air/wall damping), with pre-delay and a
// few early reflections for the smaller spaces. Deterministic (seeded), so exports are repeatable.

export type ReverbPreset = 'room' | 'plate' | 'hall' | 'cathedral';

export interface ReverbShape {
  /** RT60 in seconds (time to fall 60 dB). */
  decay: number;
  preDelay: number;
  /** Low-pass at the start of the tail, Hz. */
  brightness: number;
  /** How much darker the end of the tail gets (0..1). */
  damping: number;
  earlyReflections: number;
}

export const REVERB_PRESETS: Record<ReverbPreset, { label: string; shape: ReverbShape }> = {
  room: { label: 'Room', shape: { decay: 0.6, preDelay: 0.004, brightness: 9000, damping: 0.5, earlyReflections: 6 } },
  plate: { label: 'Plate', shape: { decay: 1.6, preDelay: 0, brightness: 12000, damping: 0.3, earlyReflections: 0 } },
  hall: { label: 'Hall', shape: { decay: 2.6, preDelay: 0.02, brightness: 7000, damping: 0.6, earlyReflections: 4 } },
  cathedral: { label: 'Cathedral', shape: { decay: 5, preDelay: 0.04, brightness: 5000, damping: 0.75, earlyReflections: 3 } },
};

/** `tone` 0 (dark) … 1 (bright) scales the preset's brightness ×0.5 … ×1.5. */
export function generateImpulse(shape: ReverbShape, sampleRate: number, tone = 0.5): [Float32Array, Float32Array] {
  const tailLength = Math.ceil(shape.decay * 1.1 * sampleRate);
  const pre = Math.round(shape.preDelay * sampleRate);
  const length = pre + tailLength;
  const brightness = shape.brightness * (0.5 + tone);
  const out: [Float32Array, Float32Array] = [new Float32Array(length), new Float32Array(length)];

  out.forEach((ch, c) => {
    let seed = 12345 + c * 7919;
    const rand = () => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return (seed / 0x7fffffff) * 2 - 1;
    };
    let lp = 0;
    for (let i = 0; i < tailLength; i++) {
      const t = i / sampleRate;
      const env = Math.exp((-6.9 * t) / shape.decay); // −60 dB at t = decay
      // One-pole low-pass whose cutoff falls over the tail (damping).
      const progress = Math.min(1, t / shape.decay);
      const cutoff = brightness * (1 - shape.damping * progress) + 300;
      const a = 1 - Math.exp((-2 * Math.PI * cutoff) / sampleRate);
      lp += a * (rand() - lp);
      ch[pre + i] = lp * env;
    }
    // Early reflections: a few distinct taps in the first ~40 ms (different per side).
    for (let k = 0; k < shape.earlyReflections; k++) {
      const delay = pre + Math.round((0.004 + 0.035 * Math.abs(rand())) * sampleRate);
      if (delay < length) ch[delay] += 0.5 * Math.exp(-k * 0.35) * (rand() > 0 ? 1 : -1);
    }
  });

  // Normalise energy so presets sit at a similar loudness for the same send level.
  let energy = 0;
  for (const ch of out) for (const v of ch) energy += v * v;
  const k = energy > 0 ? 1 / Math.sqrt(energy / 2) : 1;
  for (const ch of out) for (let i = 0; i < ch.length; i++) ch[i] *= k * 0.5;
  return out;
}
