// Web Worker: heavy work off the main thread.
// - voice: per track channel, the clean-up stage (prepareVoice) when its settings change, the PSOLA
//   analysis of the result, and the voice engine's grain plans for the current tuning (Phase 13).
//   Requests for a channel that arrive while one is queued are merged, so a knob drag only plans
//   the latest position.
// - analyze: key + tempo of an instrumental; shift: phase-vocoder key shift of an instrumental.

import { analyzeInstrumental, type AnalysisResult } from '../dsp/analyze';
import type { TuneSettings } from '../dsp/autotune';
import { prepareVoice, type DenoiseCache, type PrepareSettings } from '../dsp/process';
import { analyzePsola, type PsolaAnalysis } from '../dsp/psola';
import { planVoices, type VoicePlans } from '../dsp/voice-engine';
import { pitchShift } from '../dsp/vocoder';
import { unpackFrames, type PackedPitchTrack } from '../storage/pitch-track';
import type { PitchFrame } from './pitch-tracker';

/** Source audio + plans for one track's voice engine. */
export interface VoiceRequest {
  kind: 'voice';
  id: number;
  channel: string;
  /** New clean-up input (sent when the take or its clean-up settings change). */
  prepare?: {
    key: string;
    recordingId: string;
    samples: Float32Array;
    sampleRate: number;
    targetRate: number;
    pitch: PackedPitchTrack;
    settings: PrepareSettings;
  };
  tune: TuneSettings | null;
  semitones: number;
  /** Source version the main thread has; the response carries the source when it differs. */
  have: number;
}

export interface VoiceResponse {
  id: number;
  version: number;
  source?: Float32Array;
  plans: VoicePlans | null;
  notes: string[];
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

/** Phase-vocoder pitch shift of an instrumental (each channel). */
export interface ShiftRequest {
  kind: 'shift';
  id: number;
  channels: Float32Array[];
  semitones: number;
}

export interface RenderResponse {
  id: number;
  output?: Float32Array;
  channels?: Float32Array[];
  notes?: string[];
  analysis?: AnalysisResult;
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

interface VoiceChannel {
  key: string;
  version: number;
  source: Float32Array;
  analysis: PsolaAnalysis;
  frames: PitchFrame[];
  notes: string[];
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
      const { source, notes } = prepareVoice(p.samples, p.sampleRate, p.targetRate, frames, p.settings, cache, p.recordingId);
      ch = { key: p.key, version: nextVersion++, source, analysis: analyzePsola(source, p.targetRate, frames), frames, notes };
      voices.set(req.channel, ch);
    }
    if (!ch) throw new Error('Voice not prepared');
    const plans = planVoices(ch.analysis, ch.frames, req.tune, req.semitones);
    const transfer = plans ? [plans.lead, ...plans.harmonies].flatMap((g) => [g.to.buffer, g.from.buffer, g.half.buffer]) : [];
    // The source is copied (structured clone), not transferred: the channel keeps it for later replies.
    post({ id: req.id, version: ch.version, source: req.have === ch.version ? undefined : ch.source, plans, notes: ch.notes }, transfer);
  } catch (err) {
    post({ id: req.id, version: 0, plans: null, notes: [], error: err instanceof Error ? err.message : String(err) });
  }
}

self.onmessage = (e: MessageEvent<AnalyzeRequest | ShiftRequest | VoiceRequest | DropVoiceRequest>) => {
  if (e.data.kind === 'voice') return queueVoice(e.data);
  if (e.data.kind === 'drop') {
    voices.delete(e.data.channel);
    queued.delete(e.data.channel);
    return;
  }
  if (e.data.kind === 'shift') {
    const { id, channels, semitones } = e.data;
    try {
      const out = channels.map((ch) => pitchShift(ch, semitones));
      (self as unknown as Worker).postMessage({ id, channels: out } satisfies RenderResponse, out.map((c) => c.buffer));
    } catch (err) {
      (self as unknown as Worker).postMessage({ id, error: err instanceof Error ? err.message : String(err) } satisfies RenderResponse);
    }
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
