// Messages and construction options shared by the voice-engine worklet and its main-thread users.

import type { CleanupAnalysis, CleanupSettings } from '../../dsp/cleanup';
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
