// Web Worker: runs the processing chain (noise reduction -> auto-tune -> harmony) off the main thread.

import { processRecording, type DenoiseCache, type ProcessSettings } from '../dsp/process';
import { unpackFrames, type PackedPitchTrack } from '../storage/pitch-track';

export interface RenderRequest {
  id: number;
  /** Identifies the recording, so the cleaned audio can be reused across re-tunes. */
  recordingId: string;
  samples: Float32Array;
  sampleRate: number;
  pitch: PackedPitchTrack;
  settings: ProcessSettings;
}

export interface RenderResponse {
  id: number;
  output?: Float32Array;
  notes?: string[];
  error?: string;
}

// One cached denoise result is enough: it's reused while the user tweaks tuning on the same take.
let cached: DenoiseCache | undefined;
const cache = {
  get: (key: string) => (cached?.key === key ? cached : undefined),
  set: (entry: DenoiseCache) => {
    cached = entry;
  },
};

self.onmessage = (e: MessageEvent<RenderRequest>) => {
  const { id, recordingId, samples, sampleRate, pitch, settings } = e.data;
  try {
    const { output, notes } = processRecording(samples, sampleRate, unpackFrames(pitch), settings, cache, recordingId);
    (self as unknown as Worker).postMessage({ id, output, notes } satisfies RenderResponse, [output.buffer]);
  } catch (err) {
    (self as unknown as Worker).postMessage({ id, error: err instanceof Error ? err.message : String(err) } satisfies RenderResponse);
  }
};
