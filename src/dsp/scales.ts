// Scales: which notes auto-tune is allowed to land on (Goal.mp4, 1:08 "Pick the notes").

import { pitchClass, pitchClassName } from './notes';

export const SCALE_TYPES = {
  chromatic: { label: 'Chromatic', intervals: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11] },
  major: { label: 'Major', intervals: [0, 2, 4, 5, 7, 9, 11] },
  minor: { label: 'Minor', intervals: [0, 2, 3, 5, 7, 8, 10] },
  harmonicMinor: { label: 'Harmonic minor', intervals: [0, 2, 3, 5, 7, 8, 11] },
  majorPentatonic: { label: 'Major pentatonic', intervals: [0, 2, 4, 7, 9] },
  minorPentatonic: { label: 'Minor pentatonic', intervals: [0, 3, 5, 7, 10] },
  blues: { label: 'Blues', intervals: [0, 3, 5, 6, 7, 10] },
} as const satisfies Record<string, { label: string; intervals: readonly number[] }>;

export type ScaleType = keyof typeof SCALE_TYPES;

export interface Scale {
  /** Pitch class of the root, 0 = C … 11 = B. */
  root: number;
  type: ScaleType;
}

export const CHROMATIC: Scale = { root: 0, type: 'chromatic' };

/** 12 booleans, index = pitch class. */
export function scaleMask(scale: Scale): boolean[] {
  const mask = new Array<boolean>(12).fill(false);
  for (const i of SCALE_TYPES[scale.type].intervals) mask[(scale.root + i) % 12] = true;
  return mask;
}

export function inScale(midi: number, scale: Scale): boolean {
  return scaleMask(scale)[pitchClass(midi)];
}

/** Closest allowed (integer) note to a fractional MIDI pitch. Ties go to the lower note. */
export function nearestInScale(midi: number, scale: Scale, mask = scaleMask(scale)): number {
  const base = Math.round(midi);
  let best = NaN;
  let bestDist = Infinity;
  for (let d = -6; d <= 6; d++) {
    const n = base + d;
    if (!mask[pitchClass(n)]) continue;
    const dist = Math.abs(n - midi);
    if (dist < bestDist - 1e-9 || (Math.abs(dist - bestDist) <= 1e-9 && n < best)) {
      best = n;
      bestDist = dist;
    }
  }
  return best;
}

/** "Chromatic", "C major", "F# minor pentatonic", … */
export function scaleName(scale: Scale): string {
  if (scale.type === 'chromatic') return 'Chromatic';
  return `${pitchClassName(scale.root)} ${SCALE_TYPES[scale.type].label.toLowerCase()}`;
}
