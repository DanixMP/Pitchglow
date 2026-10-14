// Main-thread side of the render worker. Latest request wins: older pending renders resolve to null.

import type { PitchFrame } from './pitch-tracker';
import type { TuneSettings } from '../dsp/autotune';
import { packFrames } from '../storage/pitch-track';
import type { RenderRequest, RenderResponse } from './render-worker';
import RenderWorker from './render-worker.ts?worker';

export class TunedRenderer {
  private worker: Worker | null = null;
  private nextId = 1;
  private pending = new Map<number, { resolve: (out: Float32Array | null) => void; reject: (err: Error) => void }>();

  /** Renders the tuned version. Resolves to null if a newer render was requested meanwhile. */
  render(samples: Float32Array, sampleRate: number, frames: readonly PitchFrame[], settings: TuneSettings): Promise<Float32Array | null> {
    const worker = this.ensureWorker();
    const id = this.nextId++;
    for (const [oldId, p] of this.pending) {
      p.resolve(null);
      this.pending.delete(oldId);
    }
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      // Copy so the caller keeps its samples (the copy is transferred, not cloned again).
      const copy = samples.slice();
      const req: RenderRequest = { id, samples: copy, sampleRate, pitch: packFrames(frames), settings };
      worker.postMessage(req, [copy.buffer]);
    });
  }

  /** Drops any pending render (e.g. when the recording is closed). */
  cancel(): void {
    for (const p of this.pending.values()) p.resolve(null);
    this.pending.clear();
  }

  get busy(): boolean {
    return this.pending.size > 0;
  }

  private ensureWorker(): Worker {
    if (this.worker) return this.worker;
    const worker = new RenderWorker();
    worker.onmessage = (e: MessageEvent<RenderResponse>) => {
      const p = this.pending.get(e.data.id);
      if (!p) return; // superseded
      this.pending.delete(e.data.id);
      if (e.data.output) p.resolve(e.data.output);
      else p.reject(new Error(e.data.error ?? 'Render failed'));
    };
    this.worker = worker;
    return worker;
  }
}
