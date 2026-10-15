// Messages and construction options shared by the voice-engine worklet and its main-thread users.

import type { CleanupAnalysis, CleanupSettings } from '../../dsp/cleanup';
import type { ClickGrid } from '../../dsp/click';
import type { VoicePlans } from '../../dsp/voice-engine';
import type { EngineTransport } from './transport';

export const ENGINE_PROCESSOR = 'voice-engine';

export type EngineMessage =
  | { type: 'source'; samples: Float32Array; plans: VoicePlans | null; cleanup: CleanupAnalysis | null; cleanupSettings: CleanupSettings }
  /** Clean-up settings (live); a new analysis only when it changed. */
  | { type: 'cleanup'; analysis?: CleanupAnalysis | null; settings: CleanupSettings }
  | { type: 'plans'; plans: VoicePlans | null }
  /** Where the take starts in the song, samples (may be negative). */
  | { type: 'offset'; offset: number }
  | { type: 'play'; transport: EngineTransport }
  | { type: 'stop' };

export interface EngineOptions {
  samples: Float32Array;
  plans: VoicePlans | null;
  cleanup: CleanupAnalysis | null;
  cleanupSettings: CleanupSettings;
  offset: number;
  transport: EngineTransport | null;
}

// --- beat engine (instrumental key shift, Phase 15) ---------------------------------------------

export const BEAT_PROCESSOR = 'beat-engine';

export type BeatMessage =
  | { type: 'shift'; semitones: number }
  | { type: 'offset'; offset: number }
  | { type: 'play'; transport: EngineTransport }
  | { type: 'stop' };

export interface BeatOptions {
  /** The decoded beat (1 or 2 channels) at the context rate. */
  channels: Float32Array[];
  semitones: number;
  /** Where the beat starts in the song, samples. */
  offset: number;
  transport: EngineTransport | null;
}

// --- metronome (Phase 17) ---------------------------------------------------------------------

export const CLICK_PROCESSOR = 'click-engine';

export type ClickMessage =
  | { type: 'grid'; grid: ClickGrid }
  /**
   * Follow the transport. Its positions are song samples + `bias` (so a count-in before the song
   * stays non-negative); beats at or after `before` (song samples) stay silent (count-in only).
   */
  | { type: 'play'; transport: EngineTransport; bias: number; before: number | null }
  | { type: 'stop' };

export interface ClickOptions {
  grid: ClickGrid;
}
