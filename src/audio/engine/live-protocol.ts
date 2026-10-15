// Messages between the live-input worklet and the main thread.

import type { TuneSettings } from '../../dsp/autotune';
import type { Voicing } from '../../dsp/keys';
import type { VoiceCharacter } from '../../dsp/voice-engine';
import type { PitchFrame } from '../pitch-tracker';

export const LIVE_PROCESSOR = 'live-processor';

/** Worklet -> main thread. Positions are context frames. */
export type LiveMessage =
  | { type: 'block'; samples: Float32Array; frame: number }
  /** A pitch frame; `at` = context frame of its analysis-window centre. */
  | { type: 'frame'; frame: PitchFrame; at: number }
  /** CPU load of the live path (0..1), whether harmony voices were dropped, current delay in samples. */
  | { type: 'load'; load: number; degraded: boolean; delay: number };

/** Main thread -> worklet: the held keys for play-the-keys harmony (null = off). */
export interface LiveKeysMessage {
  type: 'keys';
  keys: number[] | null;
  voicing: Voicing;
  mix: number;
}

/** Main thread -> worklet. */
export interface LiveSettingsMessage {
  type?: 'settings';
  monitor: boolean;
  tune: TuneSettings | null;
  semitones: number;
  /** Voice character (formant, whisper, robot); null = natural. */
  voice: VoiceCharacter | null;
}
