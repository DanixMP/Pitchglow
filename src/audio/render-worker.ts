// Web Worker: heavy work off the main thread.
// - voice: per track channel, once per take the settings-free preparation (prepareVoice: resample,
//   PSOLA marks, noise profile, gate map), then on every request the voice engine's grain plans for
//   the current tuning / transpose / voice character. Requests for a channel that arrive while one
//   is queued are merged, so a knob drag only plans the latest position. (Clean-up settings don't
//   come here at all: the engine applies them live.)
// - analyze: key + tempo of an instrumental. (The beat's key shift is live: see beat-worklet.ts.)

import { analyzeInstrumental, type AnalysisResult } from '../dsp/analyze';
import type { TuneSettings } from '../dsp/autotune';
import type { CleanupAnalysis } from '../dsp/cleanup';
import { prepareVoice, type PreparedVoice } from '../dsp/process';
import { planVoices, type VoiceCharacter, type VoicePlans } from '../dsp/voice-engine';
import { unpackFrames, type PackedPitchTrack } from '../storage/pitch-track';
import type { PitchFrame } from './pitch-tracker';

/** Source audio + plans for one track's voice engine. */
export interface VoiceRequest {
  kind: 'voice';
  id: number;
  channel: string;
  /** The take to prepare (sent the first time, or when the take or the playback rate changes). */
  prepare?: {
    key: string;
    samples: Float32Array;
    sampleRate: number;
    targetRate: number;
    pitch: PackedPitchTrack;
  };
  tune: TuneSettings | null;
  semitones: number;
  voice?: VoiceCharacter;
  /** Version the main thread has; the response carries the preparation when it differs. */
  have: number;
}

export interface VoiceResponse {
  id: number;
  version: number;
  /** The take resampled to the playback rate (only when it had to be resampled). */
  source?: Float32Array;
  /** Clean-up analysis (noise profile, gate map), when the version changed. */
  cleanup?: CleanupAnalysis;
  plans: VoicePlans | null;
  error?: string;
}

export interface DropVoiceRequest {
  kind: 'drop';
  channel: string;
}

/** Key + tempo detection for an imported instrumental (mono). */
export interface AnalyzeRequest {
  kind: 'analyze';
  id: number;
  samples: Float32Array;
  sampleRate: number;
}

export interface RenderResponse {
  id: number;
  output?: Float32Array;
  notes?: string[];
  analysis?: AnalysisResult;
  error?: string;
}

interface VoiceChannel {
  key: string;
  version: number;
  prepared: PreparedVoice;
  /** Whether the source differs from the take (resampled). */
  resampled: boolean;
  frames: PitchFrame[];
}

const voices = new Map<string, VoiceChannel>();
const queued = new Map<string, VoiceRequest>();
let nextVersion = 1;
let flushing = false;

function queueVoice(req: VoiceRequest): void {
  const prev = queued.get(req.channel);
  // A superseded request may carry new clean-up input the latest one doesn't: keep it.
  if (prev?.prepare && !req.prepare) req = { ...req, prepare: prev.prepare };
  queued.set(req.channel, req);
  if (!flushing) {
    flushing = true;
    setTimeout(flushVoices, 0);
  }
}

function flushVoices(): void {
  flushing = false;
  const batch = [...queued.values()];
  queued.clear();
  for (const req of batch) runVoice(req);
}

function runVoice(req: VoiceRequest): void {
  const post = (res: VoiceResponse, transfer: Transferable[] = []) => (self as unknown as Worker).postMessage(res, transfer);
  try {
    const p = req.prepare;
    let ch = voices.get(req.channel);
    if (p && ch?.key !== p.key) {
      const frames = unpackFrames(p.pitch);
      ch = { key: p.key, version: nextVersion++, prepared: prepareVoice(p.samples, p.sampleRate, p.targetRate, frames), resampled: p.targetRate !== p.sampleRate, frames };
      voices.set(req.channel, ch);
    }
    if (!ch) throw new Error('Voice not prepared');
    const plans = planVoices(ch.prepared.analysis, ch.frames, req.tune, req.semitones, req.voice);
    const transfer = plans ? [plans.lead, ...plans.harmonies].flatMap((g) => [g.to.buffer, g.from.buffer, g.half.buffer, g.voiced.buffer]) : [];
    const fresh = req.have !== ch.version;
    // Copied (structured clone), not transferred: the channel keeps them for later replies.
    post(
      {
        id: req.id,
        version: ch.version,
        source: fresh && ch.resampled ? ch.prepared.source : undefined,
        cleanup: fresh ? ch.prepared.cleanup : undefined,
        plans,
      },
      transfer,
    );
  } catch (err) {
    post({ id: req.id, version: 0, plans: null, error: err instanceof Error ? err.message : String(err) });
  }
}

self.onmessage = (e: MessageEvent<AnalyzeRequest | VoiceRequest | DropVoiceRequest>) => {
  if (e.data.kind === 'voice') return queueVoice(e.data);
  if (e.data.kind === 'drop') {
    voices.delete(e.data.channel);
    queued.delete(e.data.channel);
    return;
  }
  if (e.data.kind === 'analyze') {
    const { id, samples, sampleRate } = e.data;
    try {
      (self as unknown as Worker).postMessage({ id, analysis: analyzeInstrumental(samples, sampleRate) } satisfies RenderResponse);
    } catch (err) {
      (self as unknown as Worker).postMessage({ id, error: err instanceof Error ? err.message : String(err) } satisfies RenderResponse);
    }
  }
};
