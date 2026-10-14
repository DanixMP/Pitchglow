// Lane/key palette. Hue cycles once per octave going up, C = rose/salmon as in Goal.mp4
// (C -> yellow -> green -> teal -> blue -> purple -> pink -> back to C).

import { isBlackKey, pitchClass } from '../dsp/notes';

export const theme = {
  background: '#0f0f10',
  laneSeparator: 'rgba(0, 0, 0, 0.55)',
  playhead: 'rgba(255, 255, 255, 0.18)',
  line: '#ffffff',
  lineGlow: 'rgba(255, 255, 255, 0.85)',
  whiteKey: '#f2f2f0',
  whiteKeyEdge: '#c9c9c6',
  blackKey: '#24252b',
  keyLabel: '#8a8a90',
  /** Faded original pitch under the corrected line. */
  originalLine: 'rgba(255, 255, 255, 0.3)',
  /** Lanes, keys and labels for notes outside the chosen scale. */
  offScaleLane: '#131315',
  offScaleWhiteKey: '#8c8c90',
  offScaleBlackKey: '#c4c4c6',
  offScaleLabel: '#5a5a60',
  chipValue: '#f4f2ee',
  chipAccent: '#f6c453',
} as const;

export function laneHue(midi: number): number {
  return (pitchClass(midi) * 30 + 345) % 360;
}

/** Resting lane fill: dark and muted; black-key lanes a touch darker. */
export function laneFill(midi: number): string {
  const l = isBlackKey(midi) ? 15 : 21;
  return `hsl(${laneHue(midi)} 32% ${l}%)`;
}

/** Saturated colour used for lit lanes/keys and the snapped line. */
export function litColor(midi: number, alpha = 1): string {
  return `hsl(${laneHue(midi)} 78% 62% / ${alpha})`;
}
