// Main-thread side of the render worker (noise reduction + auto-tune + harmony).
// Requests are grouped into channels (one per track): within a channel the latest request wins and
// older pending ones resolve to null; different channels don't affect each other.

import type { PitchFrame } from './pitch-tracker';
import type { AnalysisResult } from '../dsp/analyze';
import type { ProcessSettings } from '../dsp/process';
import { packFrames } from '../storage/pitch-track';
import type { AnalyzeRequest, RenderRequest, RenderResponse } from './render-worker';
import RenderWorker from './render-worker.ts?worker';

export interface RenderOutput {
  output: Float32Array;
  notes: string[];
}

export class TunedRenderer {
  private worker: Worker | null = null;
  private nextId = 1;
  private pending = new Map<
    number,
    { channel: string; resolve: (out: RenderOutput | null) => void; reject: (err: Error) => void }
  >();
  private analyses = new Map<number, { resolve: (r: AnalysisResult) => void; reject: (err: Error) => void }>();

  /** Detects key and tempo of an instrumental (mono samples are transferred, not copied). */
  analyze(samples: Float32Array, sampleRate: number): Promise<AnalysisResult> {
    const worker = this.ensureWorker();
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.analyses.set(id, { resolve, reject });
      const req: AnalyzeRequest = { kind: 'analyze', id, samples, sampleRate };
      worker.postMessage(req, [samples.buffer]);
    });
  }

  /** Renders the processed version. Resolves to null if a newer render was requested on the same channel. */
  render(
    channel: string,
    recordingId: string,
    samples: Float32Array,
    sampleRate: number,
    frames: readonly PitchFrame[],
    settings: ProcessSettings,
  ): Promise<RenderOutput | null> {
    const worker = this.ensureWorker();
    const id = this.nextId++;
    for (const [oldId, p] of this.pending) {
      if (p.channel !== channel) continue;
      p.resolve(null);
      this.pending.delete(oldId);
    }
    return new Promise((resolve, reject) => {
      this.pending.set(id, { channel, resolve, reject });
      // Copy so the caller keeps its samples (the copy is transferred, not cloned again).
      const copy = samples.slice();
      const req: RenderRequest = { id, recordingId, samples: copy, sampleRate, pitch: packFrames(frames), settings };
      worker.postMessage(req, [copy.buffer]);
    });
  }

  /** Drops pending renders: one channel, or all of them (e.g. when the recording is closed). */
  cancel(channel?: string): void {
    for (const [id, p] of this.pending) {
      if (channel !== undefined && p.channel !== channel) continue;
      p.resolve(null);
      this.pending.delete(id);
    }
  }

  /** Whether anything (or one channel) is still rendering. */
  busy(channel?: string): boolean {
    for (const p of this.pending.values()) if (channel === undefined || p.channel === channel) return true;
    return false;
  }

  private ensureWorker(): Worker {
    if (this.worker) return this.worker;
    const worker = new RenderWorker();
    worker.onmessage = (e: MessageEvent<RenderResponse>) => {
      const a = this.analyses.get(e.data.id);
      if (a) {
        this.analyses.delete(e.data.id);
        if (e.data.analysis) a.resolve(e.data.analysis);
        else a.reject(new Error(e.data.error ?? 'Analysis failed'));
        return;
      }
      const p = this.pending.get(e.data.id);
      if (!p) return; // superseded
      this.pending.delete(e.data.id);
      if (e.data.output) p.resolve({ output: e.data.output, notes: e.data.notes ?? [] });
      else p.reject(new Error(e.data.error ?? 'Render failed'));
    };
    this.worker = worker;
    return worker;
  }
}
