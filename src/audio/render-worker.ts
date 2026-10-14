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

// A few cleaned takes are kept (LRU), so re-tuning any track of a project skips noise reduction.
const CACHE_SIZE = 8;
const entries = new Map<string, DenoiseCache>();
const cache = {
  get(key: string) {
    const hit = entries.get(key);
    if (hit) {
      entries.delete(key); // refresh recency
      entries.set(key, hit);
    }
    return hit;
  },
  set(entry: DenoiseCache) {
    entries.set(entry.key, entry);
    while (entries.size > CACHE_SIZE) entries.delete(entries.keys().next().value!);
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
