// Web Worker: renders the auto-tuned audio off the main thread so the UI stays smooth.

import { correctTrack, type TuneSettings } from '../dsp/autotune';
import { renderTuned } from '../dsp/psola';
import { unpackFrames, type PackedPitchTrack } from '../storage/pitch-track';

export interface RenderRequest {
  id: number;
  samples: Float32Array;
  sampleRate: number;
  pitch: PackedPitchTrack;
  settings: TuneSettings;
}

export interface RenderResponse {
  id: number;
  output?: Float32Array;
  error?: string;
}

self.onmessage = (e: MessageEvent<RenderRequest>) => {
  const { id, samples, sampleRate, pitch, settings } = e.data;
  try {
    const frames = unpackFrames(pitch);
    const output = renderTuned(samples, sampleRate, frames, correctTrack(frames, settings));
    (self as unknown as Worker).postMessage({ id, output } satisfies RenderResponse, [output.buffer]);
  } catch (err) {
    (self as unknown as Worker).postMessage({ id, error: err instanceof Error ? err.message : String(err) } satisfies RenderResponse);
  }
};
