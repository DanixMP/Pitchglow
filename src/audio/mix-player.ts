// Plays several tracks in sync (a project), or a single take (one track). Each track is an
// AudioBuffer -> GainNode -> master; gain changes are live, swapping a track's audio keeps the
// position and play state. A single clock (with output-latency compensation) drives the visuals.

import { scheduleTrack } from '../project/model';

export interface MixTrackSpec {
  id: string;
  samples: Float32Array;
  sampleRate: number;
  /** Linear gain (mute/solo already applied). */
  gain: number;
  /** Start position in the song, seconds. */
  offset: number;
}

interface Lane {
  spec: MixTrackSpec;
  buffer: AudioBuffer;
  gainNode: GainNode;
  source: AudioBufferSourceNode | null;
}

/** Scheduling lead so all tracks start on the same audio frame. */
const START_LEAD = 0.02;
const SINGLE = 'take';

export class MixPlayer {
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private lanes = new Map<string, Lane>();
  private startedAt = 0;
  private offset = 0;
  private _playing = false;
  private _duration = 0;
  private endTimer = 0;

  /** Called when playback reaches the end on its own. */
  onEnded: (() => void) | null = null;

  get playing(): boolean {
    return this._playing;
  }

  get duration(): number {
    return this._duration;
  }

  /** Song position in seconds, compensated for output latency so visuals match what you hear. */
  get currentTime(): number {
    if (!this._playing || !this.ctx) return this.offset;
    const latency = (this.ctx.outputLatency || 0) + (this.ctx.baseLatency || 0);
    const t = this.offset + this.ctx.currentTime - this.startedAt - latency;
    return Math.min(this._duration, Math.max(this.offset, t));
  }

  // --- content --------------------------------------------------------------------------------

  /** Single-take preview: one track at offset 0, full gain. Resets the position. */
  load(samples: Float32Array, sampleRate: number): void {
    this.setTracks([{ id: SINGLE, samples, sampleRate, gain: 1, offset: 0 }]);
    this.offset = 0;
  }

  /** Single-take preview: replace the audio (A/B), keeping position and play state. */
  swap(samples: Float32Array, sampleRate: number): void {
    this.swapTrack(SINGLE, samples, sampleRate);
  }

  /** Replaces the set of tracks. Unchanged audio is reused; position and play state are kept. */
  setTracks(specs: readonly MixTrackSpec[]): void {
    const ctx = this.ensureContext();
    const wasPlaying = this._playing;
    const time = this.currentTime;
    this.stopSources();

    const next = new Map<string, Lane>();
    for (const spec of specs) {
      const prev = this.lanes.get(spec.id);
      const sameAudio = prev && prev.spec.samples === spec.samples && prev.spec.sampleRate === spec.sampleRate;
      const buffer = sameAudio ? prev.buffer : makeBuffer(ctx, spec.samples, spec.sampleRate);
      const gainNode = prev?.gainNode ?? new GainNode(ctx);
      if (!prev) gainNode.connect(this.master!);
      gainNode.gain.value = spec.gain;
      next.set(spec.id, { spec, buffer, gainNode, source: null });
    }
    for (const [id, lane] of this.lanes) if (!next.has(id)) lane.gainNode.disconnect();
    this.lanes = next;
    this._duration = [...next.values()].reduce((m, l) => Math.max(m, l.spec.offset + l.buffer.duration), 0);
    this.offset = Math.min(time, this._duration);
    if (wasPlaying) void this.play();
  }

  /** Replaces one track's audio (e.g. its processed render arrived), keeping position and play state. */
  swapTrack(id: string, samples: Float32Array, sampleRate: number): void {
    const specs = [...this.lanes.values()].map((l) => (l.spec.id === id ? { ...l.spec, samples, sampleRate } : l.spec));
    if (!this.lanes.has(id)) return;
    this.setTracks(specs);
  }

  /** Live gain change (fader, mute, solo) without interrupting playback. */
  setGain(id: string, gain: number): void {
    const lane = this.lanes.get(id);
    if (!lane || !this.ctx) return;
    lane.spec = { ...lane.spec, gain };
    lane.gainNode.gain.setTargetAtTime(gain, this.ctx.currentTime, 0.015);
  }

  unload(): void {
    this.stopSources();
    for (const lane of this.lanes.values()) lane.gainNode.disconnect();
    this.lanes.clear();
    this._duration = 0;
    this.offset = 0;
    this._playing = false;
  }

  // --- transport ------------------------------------------------------------------------------

  async play(): Promise<void> {
    if (!this.ctx || this.lanes.size === 0 || this._playing) return;
    if (this.offset >= this._duration - 0.01) this.offset = 0;
    await this.ctx.resume();
    if (this._playing) return;
    const now = this.ctx.currentTime + START_LEAD;
    for (const lane of this.lanes.values()) {
      const s = scheduleTrack(this.offset, lane.spec.offset, lane.buffer.duration);
      if (!s) continue;
      const source = new AudioBufferSourceNode(this.ctx, { buffer: lane.buffer });
      source.connect(lane.gainNode);
      source.start(now + s.delay, s.from);
      lane.source = source;
    }
    this.startedAt = now;
    this._playing = true;
    this.armEndTimer();
  }

  pause(): void {
    if (!this._playing) return;
    this.offset = this.currentTime;
    this.stopSources();
    this._playing = false;
  }

  seek(time: number): void {
    const wasPlaying = this._playing;
    this.pause();
    this.offset = Math.min(this._duration, Math.max(0, time));
    if (wasPlaying) void this.play();
  }

  // --- internals ------------------------------------------------------------------------------

  private ensureContext(): AudioContext {
    if (!this.ctx) {
      this.ctx = new AudioContext();
      this.master = new GainNode(this.ctx);
      this.master.connect(this.ctx.destination);
    }
    return this.ctx;
  }

  private armEndTimer(): void {
    window.clearTimeout(this.endTimer);
    const remaining = this._duration - this.currentTime;
    this.endTimer = window.setTimeout(() => {
      if (!this._playing) return;
      if (this.currentTime >= this._duration - 0.03) {
        this.stopSources();
        this._playing = false;
        this.offset = this._duration;
        this.onEnded?.();
      } else {
        this.armEndTimer(); // clock drift / latency: check again shortly
      }
    }, Math.max(20, remaining * 1000 + 30));
  }

  private stopSources(): void {
    window.clearTimeout(this.endTimer);
    for (const lane of this.lanes.values()) {
      const s = lane.source;
      lane.source = null;
      if (s) {
        s.onended = null;
        try {
          s.stop();
        } catch {
          // never started (scheduled in the future and stopped before) — fine
        }
        s.disconnect();
      }
    }
  }
}

function makeBuffer(ctx: AudioContext, samples: Float32Array, sampleRate: number): AudioBuffer {
  const buffer = ctx.createBuffer(1, Math.max(1, samples.length), sampleRate);
  buffer.copyToChannel(samples as Float32Array<ArrayBuffer>, 0);
  return buffer;
}
