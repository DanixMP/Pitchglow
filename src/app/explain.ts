// Caption texts for the explainer subtitles (pure, so they're easy to test and tweak).

import { scaleName } from '../dsp/scales';
import type { CleanupPrefs, TuningPrefs } from '../storage/settings';

export const INTRO_CAPTIONS = ['Each of these lanes is one key on a piano.', 'As you sing, this line follows the pitch of your voice.'];

export function tuningSwitchText(tuning: TuningPrefs): string {
  return tuning.enabled ? 'Auto-tune snaps your voice to the nearest note.' : 'This is your voice, untouched.';
}

export function retuneText(ms: number): string {
  if (ms === 0) return '0 ms: it jumps the instant you move. That’s the robot sound.';
  if (ms < 100) return `${ms} ms: it snaps quickly onto each note.`;
  return `${ms} ms: set it gently, and it glides into each note.`;
}

export function scaleText(tuning: TuningPrefs): string {
  return tuning.type === 'chromatic'
    ? 'Chromatic: it can land on any key.'
    : `Only ${scaleName({ root: tuning.root, type: tuning.type })}: it can only land on these notes.`;
}

export function harmonyText(tuning: TuningPrefs): string {
  return tuning.harmony.length ? 'One voice, many notes: every lit key is a voice.' : 'Harmony off: just your voice.';
}

export function listenModeText(processed: boolean, tuning: TuningPrefs, cleanup: CleanupPrefs): string {
  if (!processed) return 'Original: exactly what you sang.';
  if (tuning.enabled) return cleanup.denoise ? 'Cleaned and tuned: no hiss, on pitch.' : 'Tuned: your voice, on pitch.';
  return 'Cleaned: your voice, without the background noise.';
}

export function denoiseSwitchText(on: boolean): string {
  return on ? 'Noise reduction: it learns the hiss from your pauses and removes it.' : 'Noise reduction off.';
}

export function denoiseAmountText(db: number): string {
  if (db <= 9) return `${db} dB: a light touch, the room still breathes.`;
  if (db <= 18) return `${db} dB: background noise pushed well back.`;
  return `${db} dB: aggressive. Listen for a watery sound.`;
}

export function monitorText(on: boolean): string[] {
  return on
    ? ['Hear myself: your voice, tuned and with effects, in your headphones as you sing.', 'Wired headphones only: speakers would feed back, and Bluetooth lags.']
    : ['Hear myself off: the voice is processed after you record.'];
}

export function micFilterText(on: boolean): string {
  return on
    ? 'Mic noise filter on: the browser cleans the mic live, and it is baked into new recordings.'
    : 'Mic noise filter off: raw mic.';
}

/** One-time tips for the studio features (Phase 12), shown as captions the first time each comes up. */
export const STUDIO_TIPS = {
  song: ['This is a song: all its tracks play together.', 'Record, and your take becomes a new track.', 'The Controls panel edits the selected track.'],
  beat: ['Your beat is in. Sing over it with headphones on.', 'Your take lands in time with the beat.'],
  mixer: ['Drag a clip along the timeline to move it in time.', 'M mutes a track, S plays it alone.'],
  loop: ['Loop on: drag along the ruler to choose the part that repeats.'],
  keyShift: ['Key shift moves the whole song, beat and voices, and auto-tune follows.'],
} as const;

export type StudioTip = keyof typeof STUDIO_TIPS;
