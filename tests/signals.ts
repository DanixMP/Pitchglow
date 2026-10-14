// Synthetic test signals.

export function sine(freq: number, sampleRate: number, seconds: number, amp = 0.5): Float32Array {
  const out = new Float32Array(Math.round(sampleRate * seconds));
  for (let i = 0; i < out.length; i++) out[i] = amp * Math.sin((2 * Math.PI * freq * i) / sampleRate);
  return out;
}

/** Band-limited-ish sawtooth (sum of harmonics), a rough stand-in for a buzzy voice. */
export function sawtooth(freq: number, sampleRate: number, seconds: number, amp = 0.5): Float32Array {
  const out = new Float32Array(Math.round(sampleRate * seconds));
  const harmonics = Math.floor(sampleRate / 2 / freq);
  for (let h = 1; h <= Math.min(harmonics, 30); h++) {
    const a = amp / h;
    for (let i = 0; i < out.length; i++) out[i] += a * Math.sin((2 * Math.PI * freq * h * i) / sampleRate);
  }
  return out;
}

/** Deterministic white noise. */
export function noise(sampleRate: number, seconds: number, amp = 0.3): Float32Array {
  const out = new Float32Array(Math.round(sampleRate * seconds));
  let seed = 12345;
  for (let i = 0; i < out.length; i++) {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    out[i] = amp * ((seed / 0x7fffffff) * 2 - 1);
  }
  return out;
}

export function rms(x: Float32Array): number {
  let s = 0;
  for (const v of x) s += v * v;
  return Math.sqrt(s / x.length);
}
