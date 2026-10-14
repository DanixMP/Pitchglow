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

/** Pitch track as bytes (for song files): frame count, then the columns (little-endian). */
export function serializePitch(track: PackedPitchTrack): Uint8Array<ArrayBuffer> {
  const n = track.time.length;
  const out = new Uint8Array(8 + n * 8 + n * 4 * 4);
  const view = new DataView(out.buffer);
  view.setUint32(0, n, true);
  let o = 8;
  for (let i = 0; i < n; i++, o += 8) view.setFloat64(o, track.time[i], true);
  for (const col of [track.freq, track.midi, track.clarity, track.rms]) {
    for (let i = 0; i < n; i++, o += 4) view.setFloat32(o, col[i], true);
  }
  return out;
}

export function deserializePitch(bytes: Uint8Array): PackedPitchTrack {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const n = bytes.length >= 8 ? view.getUint32(0, true) : -1;
  if (n < 0 || bytes.length !== 8 + n * 24) throw new Error('The pitch data is damaged.');
  const time = new Float64Array(n);
  let o = 8;
  for (let i = 0; i < n; i++, o += 8) time[i] = view.getFloat64(o, true);
  const cols = [0, 1, 2, 3].map(() => {
    const col = new Float32Array(n);
    for (let i = 0; i < n; i++, o += 4) col[i] = view.getFloat32(o, true);
    return col;
  });
  return { time, freq: cols[0], midi: cols[1], clarity: cols[2], rms: cols[3] };
}
