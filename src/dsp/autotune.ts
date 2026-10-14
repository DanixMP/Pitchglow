// Pitch-correction curve: for each pitch frame, pick the target note and glide towards it.
//
// Like classic auto-tune, the correction is a *shift* added to the sung pitch, and the shift is
// smoothed with the retune speed. Fast retune (0 ms) flattens the voice onto the note (the robotic
// staircase); slow retune pulls the average onto the note but lets fast movement like vibrato through.

import type { PitchFrame } from '../audio/pitch-tracker';
import type { HarmonySettings } from './harmony';
import { nearestInScale, scaleMask, type Scale } from './scales';
import { pitchClass } from './notes';

export interface TuneSettings {
  scale: Scale;
  /** Roughly the time to reach the target note, 0-400 ms (Goal.mp4, 0:50 "Retune speed"). */
  retuneMs: number;
  /** Extra semitones the voice must move past the halfway point before switching notes. */
  hysteresis?: number;
  /** Harmony voices layered on the tuned lead (see harmony.ts). */
  harmony?: HarmonySettings;
}

export interface Correction {
  /** Note being corrected towards (integer MIDI), or null when unvoiced. */
  target: number | null;
  /** Corrected pitch (fractional MIDI), or null when unvoiced. */
  corrected: number | null;
}

const DEFAULT_HOP = 0.01;

export class PitchCorrector {
  private mask: boolean[];
  private target: number | null = null;
  private shift = 0;
  private lastTime: number | null = null;

  constructor(private settings: TuneSettings) {
    this.mask = scaleMask(settings.scale);
  }

  reset(): void {
    this.target = null;
    this.shift = 0;
    this.lastTime = null;
  }

  process(frame: PitchFrame): Correction {
    if (frame.midi === null) {
      this.reset();
      return { target: null, corrected: null };
    }
    const target = this.chooseTarget(frame.midi);
    const dt = this.lastTime === null ? DEFAULT_HOP : Math.max(0, frame.time - this.lastTime);
    this.lastTime = frame.time;

    // Retune time ≈ 3 time constants (~95% of the way there).
    const tau = this.settings.retuneMs / 1000 / 3;
    const alpha = tau <= 0 ? 1 : 1 - Math.exp(-dt / tau);
    this.shift += (target - frame.midi - this.shift) * alpha;
    this.target = target;
    return { target, corrected: frame.midi + this.shift };
  }

  private chooseTarget(midi: number): number {
    const h = this.settings.hysteresis ?? 0.15;
    const prev = this.target;
    if (prev !== null && this.mask[pitchClass(prev)] && Math.abs(midi - prev) < 0.5 + h) return prev;
    return nearestInScale(midi, this.settings.scale, this.mask);
  }
}

/** Corrects a whole track (e.g. a saved recording). */
export function correctTrack(frames: readonly PitchFrame[], settings: TuneSettings): Correction[] {
  const corrector = new PitchCorrector(settings);
  return frames.map((f) => corrector.process(f));
}
