// Voice character presets (Phase 15): a formant shift, whisper or robot voice, plus a pitch offset.
// Pure data; the sound comes from the voice engine (dsp/voice-engine.ts, dsp/grain-shape.ts).

import { isNeutralVoice, NEUTRAL_VOICE, type VoiceCharacter } from '../dsp/voice-engine';

export type VoicePresetId = 'natural' | 'deeper' | 'younger' | 'chipmunk' | 'monster' | 'robot' | 'whisper';

/** A track's voice character and the preset it came from (null = custom). */
export interface TrackVoice extends VoiceCharacter {
  preset: VoicePresetId | null;
}

/** Each preset sets the voice character and the track's pitch offset (semitones). */
export const VOICE_PRESETS: Record<VoicePresetId, { label: string; pitch: number; voice: VoiceCharacter }> = {
  natural: { label: 'Natural', pitch: 0, voice: NEUTRAL_VOICE },
  deeper: { label: 'Deeper', pitch: -3, voice: { formant: -2.5, whisper: 0, monotone: false } },
  younger: { label: 'Younger', pitch: 3, voice: { formant: 3, whisper: 0, monotone: false } },
  chipmunk: { label: 'Chipmunk', pitch: 7, voice: { formant: 6, whisper: 0, monotone: false } },
  monster: { label: 'Monster', pitch: -8, voice: { formant: -5, whisper: 0, monotone: false } },
  robot: { label: 'Robot', pitch: 0, voice: { formant: 0, whisper: 0, monotone: true } },
  whisper: { label: 'Whisper', pitch: 0, voice: { formant: 0, whisper: 1, monotone: false } },
};

export const NATURAL_TRACK_VOICE: TrackVoice = { ...NEUTRAL_VOICE, preset: 'natural' };

export function trackVoiceOf(t: { voice?: TrackVoice }): TrackVoice {
  return t.voice ?? NATURAL_TRACK_VOICE;
}

export function withVoicePreset(id: VoicePresetId): { voice: TrackVoice; pitch: number } {
  const p = VOICE_PRESETS[id];
  return { voice: { ...p.voice, preset: id }, pitch: p.pitch };
}

/** The part of a preset's pitch a monitored (live) voice should get. */
export function presetPitch(v: TrackVoice): number {
  return v.preset ? VOICE_PRESETS[v.preset].pitch : 0;
}

export { isNeutralVoice };
