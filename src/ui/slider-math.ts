// Pure maths for the Neon slider (Phase 16): positions, steps and detents ("magnetic" values such as
// 0 dB or centre pan that the thumb snaps to when it gets close).

export interface SliderRange {
  min: number;
  max: number;
  step: number;
}

/** Fraction of the range a detent pulls from (each side). */
export const DETENT_ZONE = 0.025;

export function clamp(v: number, r: SliderRange): number {
  return Math.min(r.max, Math.max(r.min, v));
}

/** Position 0..1 of a value along the track. */
export function ratioOf(v: number, r: SliderRange): number {
  return r.max > r.min ? (clamp(v, r) - r.min) / (r.max - r.min) : 0;
}

/** Value at position 0..1 along the track. */
export function valueAt(ratio: number, r: SliderRange): number {
  return r.min + Math.min(1, Math.max(0, ratio)) * (r.max - r.min);
}

/** Rounds to the slider's step grid (anchored at min), clamped; no float noise (0.1 + 0.2). */
export function toStep(v: number, r: SliderRange): number {
  const step = r.step > 0 ? r.step : (r.max - r.min) / 100;
  const n = Math.round((clamp(v, r) - r.min) / step);
  const out = clamp(r.min + n * step, r);
  const decimals = Math.max(0, -Math.floor(Math.log10(step)) + 1);
  return Number(out.toFixed(Math.min(10, decimals + 2)));
}

/**
 * Snaps a value onto the nearest detent within DETENT_ZONE of the range (unless `free`). Detents
 * are where a control has a natural "home": 0 dB, centre, 0 st.
 */
export function snapToDetent(v: number, detents: readonly number[], r: SliderRange, free = false): number {
  if (free || detents.length === 0) return v;
  const zone = DETENT_ZONE * (r.max - r.min);
  let best = v;
  let dist = zone;
  for (const d of detents) {
    const k = Math.abs(v - d);
    if (k <= dist) {
      dist = k;
      best = d;
    }
  }
  return best;
}

/** Default detents: the zero of a range that crosses it (pan, EQ, nudge, faders). */
export function defaultDetents(r: SliderRange): number[] {
  return r.min < 0 && r.max > 0 ? [0] : [];
}

/** Parses `data-detents="0, 60"` (empty attribute = no detents); falls back to defaultDetents. */
export function parseDetents(attr: string | undefined, r: SliderRange): number[] {
  if (attr === undefined) return defaultDetents(r);
  if (attr.trim() === '') return [];
  return attr
    .split(',')
    .map((s) => Number(s.trim()))
    .filter((n) => Number.isFinite(n) && n >= r.min && n <= r.max);
}

/**
 * Where the fill starts: at a zero inside the range (so bipolar controls fill from the centre),
 * otherwise at the minimum.
 */
export function fillOrigin(r: SliderRange): number {
  return r.min < 0 && r.max > 0 ? ratioOf(0, r) : 0;
}

/**
 * One pointer move of a drag: the value moves with the pointer, relative to where it was (so
 * grabbing the thumb doesn't make it jump). Shift = fine (a tenth of the speed).
 */
export function dragValue(value: number, dx: number, width: number, r: SliderRange, fine: boolean): number {
  if (width <= 0) return value;
  return value + (dx / width) * (r.max - r.min) * (fine ? 0.1 : 1);
}
