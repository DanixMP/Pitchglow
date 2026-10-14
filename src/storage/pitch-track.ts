// Compact column storage for pitch frames (typed arrays instead of thousands of objects).

import type { PitchFrame } from '../audio/pitch-tracker';

export interface PackedPitchTrack {
  time: Float64Array;
  /** NaN = unvoiced. */
  freq: Float32Array;
  /** NaN = unvoiced. */
  midi: Float32Array;
  clarity: Float32Array;
  rms: Float32Array;
}

export function packFrames(frames: readonly PitchFrame[]): PackedPitchTrack {
  const n = frames.length;
  const track: PackedPitchTrack = {
    time: new Float64Array(n),
    freq: new Float32Array(n),
    midi: new Float32Array(n),
    clarity: new Float32Array(n),
    rms: new Float32Array(n),
  };
  frames.forEach((f, i) => {
    track.time[i] = f.time;
    track.freq[i] = f.freq ?? NaN;
    track.midi[i] = f.midi ?? NaN;
    track.clarity[i] = f.clarity;
    track.rms[i] = f.rms;
  });
  return track;
}

export function unpackFrames(track: PackedPitchTrack): PitchFrame[] {
  const frames: PitchFrame[] = new Array(track.time.length);
  for (let i = 0; i < frames.length; i++) {
    frames[i] = {
      time: track.time[i],
      freq: Number.isNaN(track.freq[i]) ? null : track.freq[i],
      midi: Number.isNaN(track.midi[i]) ? null : track.midi[i],
      clarity: track.clarity[i],
      rms: track.rms[i],
    };
  }
  return frames;
}
