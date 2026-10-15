// Main-thread side of the render worker: voice-engine inputs (cleaned source + grain plans), key/tempo
// analysis and instrumental key shift. Voice requests are grouped into channels (one per track):
// within a channel the latest request wins and older pending ones resolve to null.

import type { PitchFrame } from './pitch-tracker';
import type { AnalysisResult } from '../dsp/analyze';
import { packFrames } from '../storage/pitch-track';
import type { TuneSettings } from '../dsp/autotune';
import type { CleanupAnalysis } from '../dsp/cleanup';
import type { VoiceCharacter, VoicePlans } from '../dsp/voice-engine';
import type { AnalyzeRequest, DropVoiceRequest, RenderResponse, ShiftRequest, VoiceRequest, VoiceResponse } from './render-worker';
import RenderWorker from './render-worker.ts?worker';

export interface VoiceResult {
  /** Version of the preparation the plans belong to. */
  version: number;
  /** The take resampled to the playback rate (new version, and only when it had to be resampled). */
  source?: Float32Array;
  /** Clean-up analysis (new version only). */
  cleanup?: CleanupAnalysis;
  plans: VoicePlans | null;
}

export interface VoicePrepare {
  /** Identifies the take and playback rate; a new key re-prepares. */
  key: string;
  samples: Float32Array;
  sampleRate: number;
  targetRate: number;
  frames: readonly PitchFrame[];
}

export class TunedRenderer {
  private worker: Worker | null = null;
  private voicesPending = new Map<number, { channel: string; resolve: (r: VoiceResult | null) => void; reject: (err: Error) => void }>();

  /**
   * Source + grain plans for a track's voice engine. `prepare` (new clean-up input) is needed the
   * first time and whenever the take or its clean-up settings change. Latest request per channel wins.
   */
  voice(
    channel: string,
    request: { prepare?: VoicePrepare; tune: TuneSettings | null; semitones: number; voice?: VoiceCharacter; have: number },
  ): Promise<VoiceResult | null> {
    const worker = this.ensureWorker();
    const id = this.nextId++;
    for (const [oldId, p] of this.voicesPending) {
      if (p.channel !== channel) continue;
      p.resolve(null);
      this.voicesPending.delete(oldId);
    }
    return new Promise((resolve, reject) => {
      this.voicesPending.set(id, { channel, resolve, reject });
      const p = request.prepare;
      const samples = p ? p.samples.slice() : null;
      const req: VoiceRequest = {
        kind: 'voice',
        id,
        channel,
        tune: request.tune,
        semitones: request.semitones,
        voice: request.voice,
        have: request.have,
        prepare:
          p && samples
            ? { key: p.key, samples, sampleRate: p.sampleRate, targetRate: p.targetRate, pitch: packFrames(p.frames) }
            : undefined,
      };
      worker.postMessage(req, samples ? [samples.buffer] : []);
    });
  }

  /** Forgets a channel's voice state in the worker (track removed, song closed). */
  dropVoice(channel: string): void {
    for (const [id, p] of this.voicesPending) {
      if (p.channel !== channel) continue;
      p.resolve(null);
      this.voicesPending.delete(id);
    }
    const req: DropVoiceRequest = { kind: 'drop', channel };
    this.worker?.postMessage(req);
  }

  private nextId = 1;
  private analyses = new Map<number, { resolve: (r: AnalysisResult) => void; reject: (err: Error) => void }>();
  private shifts = new Map<number, { resolve: (c: Float32Array[]) => void; reject: (err: Error) => void }>();

  /** Pitch-shifts an instrumental's channels (copied; the originals stay usable). */
  shiftInstrumental(channels: readonly Float32Array[], semitones: number): Promise<Float32Array[]> {
    const worker = this.ensureWorker();
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.shifts.set(id, { resolve, reject });
      const copies = channels.map((c) => c.slice());
      const req: ShiftRequest = { kind: 'shift', id, channels: copies, semitones };
      worker.postMessage(req, copies.map((c) => c.buffer));
    });
  }

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

  /** Drops pending renders: one channel, or all of them (e.g. when the recording is closed). */
  cancel(channel?: string): void {
    for (const [id, p] of this.voicesPending) {
      if (channel !== undefined && p.channel !== channel) continue;
      p.resolve(null);
      this.voicesPending.delete(id);
    }
  }

  /** Whether anything (or one channel) is still rendering. */
  busy(channel?: string): boolean {
    for (const p of this.voicesPending.values()) if (channel === undefined || p.channel === channel) return true;
    return false;
  }

  private ensureWorker(): Worker {
    if (this.worker) return this.worker;
    const worker = new RenderWorker();
    worker.onmessage = (e: MessageEvent<RenderResponse | VoiceResponse>) => {
      if ('version' in e.data) {
        const r = e.data;
        const v = this.voicesPending.get(r.id);
        if (!v) return; // superseded
        this.voicesPending.delete(r.id);
        if (r.error) v.reject(new Error(r.error));
        else v.resolve({ version: r.version, source: r.source, cleanup: r.cleanup, plans: r.plans });
        return;
      }
      const s = this.shifts.get(e.data.id);
      if (s) {
        this.shifts.delete(e.data.id);
        if (e.data.channels) s.resolve(e.data.channels);
        else s.reject(new Error(e.data.error ?? 'Key shift failed'));
        return;
      }
      const a = this.analyses.get(e.data.id);
      if (a) {
        this.analyses.delete(e.data.id);
        if (e.data.analysis) a.resolve(e.data.analysis);
        else a.reject(new Error(e.data.error ?? 'Analysis failed'));
        return;
      }
    };
    this.worker = worker;
    return worker;
  }
}
