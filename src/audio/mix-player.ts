// Plays several tracks in sync (a project), or a single take (one track). Each track runs through
// the shared mix chain (gain -> pan -> master -> limiter, see chain.ts); gain/pan/master changes are
// live, swapping a track's audio keeps the position and play state. Analysers tap every track and the
// master (L/R) for the meters. A single clock (with output-latency compensation) drives the visuals.

import { DEFAULT_SONG_FX, type SongFx, type TrackFx } from '../project/fx';
import { scheduleTrack } from '../project/model';
import { applyTrackFx, clampPan, createTrackChain, disconnectChain, FxBuses, MasterChain, type MasterSettings, type TrackChain } from './chain';
import { sharedContext } from './context';

export interface Level {
  /** Linear peak and RMS over the analyser window (~21 ms). */
  peak: number;
  rms: number;
}

export interface MixTrackSpec {
  id: string;
  /** Mono audio (vocal takes) … */
  samples: Float32Array;
  sampleRate: number;
  /** … or a decoded (often stereo) buffer, used as-is (instrumentals). Takes precedence over samples. */
  buffer?: AudioBuffer;
  /** Linear gain (mute/solo already applied). */
  gain: number;
  /** −1 (left) … 1 (right); default centre. */
  pan?: number;
  /** Vocal chain + sends (live parts). */
  fx?: TrackFx;
  /** Start position in the song, seconds. */
  offset: number;
}

interface Lane {
  spec: MixTrackSpec;
  buffer: AudioBuffer;
  chain: TrackChain;
  meter: AnalyserNode;
  source: AudioBufferSourceNode | null;
}

const METER_FFT = 1024;

/** Scheduling lead so all tracks start on the same audio frame. */
const START_LEAD = 0.02;
const SINGLE = 'take';

export class MixPlayer {
  private ctx: AudioContext | null = null;
  private master: MasterChain | null = null;
  private masterMeters: AnalyserNode[] = [];
  private masterSettings: MasterSettings = { gain: 1, limiter: true };
  private buses: FxBuses | null = null;
  private songFx: { fx: SongFx; bpm: number | null } = { fx: DEFAULT_SONG_FX, bpm: null };
  private lanes = new Map<string, Lane>();
  private scratch = new Float32Array(METER_FFT);
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

  /** The shared context (created on first use). */
  get context(): AudioContext {
    return this.ensureContext();
  }

  /** Decodes an audio file (mp3/wav/m4a/ogg/flac…) at the context's sample rate. */
  decode(data: ArrayBuffer): Promise<AudioBuffer> {
    // decodeAudioData detaches its argument, so give it a copy and keep the caller's bytes intact.
    return this.ensureContext().decodeAudioData(data.slice(0));
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
      const sameAudio =
        prev && prev.spec.buffer === spec.buffer && prev.spec.samples === spec.samples && prev.spec.sampleRate === spec.sampleRate;
      const buffer = sameAudio ? prev.buffer : (spec.buffer ?? makeBuffer(ctx, spec.samples, spec.sampleRate));
      let chain = prev?.chain;
      let meter = prev?.meter;
      if (!chain || !meter) {
        chain = createTrackChain(ctx, spec.gain, spec.pan ?? 0, this.master!.input, spec.fx, this.buses!);
        meter = new AnalyserNode(ctx, { fftSize: METER_FFT });
        chain.pan.connect(meter);
      }
      chain.gain.gain.value = spec.gain;
      chain.pan.pan.value = clampPan(spec.pan ?? 0);
      applyTrackFx(chain, spec.fx);
      next.set(spec.id, { spec, buffer, chain, meter, source: null });
    }
    for (const [id, lane] of this.lanes) if (!next.has(id)) disconnectLane(lane);
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
    lane.chain.gain.gain.setTargetAtTime(gain, this.ctx.currentTime, 0.015);
  }

  /** Live pan change. */
  setPan(id: string, pan: number): void {
    const lane = this.lanes.get(id);
    if (!lane || !this.ctx) return;
    lane.spec = { ...lane.spec, pan };
    lane.chain.pan.pan.setTargetAtTime(clampPan(pan), this.ctx.currentTime, 0.015);
  }

  /** Live change of a track's inserts/sends (EQ, compressor, high-pass, reverb/echo sends). */
  setTrackFx(id: string, fx: TrackFx): void {
    const lane = this.lanes.get(id);
    if (!lane || !this.ctx) return;
    lane.spec = { ...lane.spec, fx };
    applyTrackFx(lane.chain, fx, this.ctx);
  }

  /** Live change of the song's reverb/echo buses. */
  setSongFx(fx: SongFx, bpm: number | null): void {
    this.songFx = { fx, bpm };
    this.buses?.apply(fx, bpm, true);
  }

  /** Live master fader / limiter. */
  setMaster(settings: MasterSettings): void {
    this.masterSettings = settings;
    if (this.master && this.ctx) this.master.apply(settings, this.ctx);
  }

  /** Current levels per track and for the master (L, R). Cheap enough to call every frame. */
  levels(): { tracks: Map<string, Level>; master: Level[] } {
    const tracks = new Map<string, Level>();
    for (const [id, lane] of this.lanes) tracks.set(id, this.measure(lane.meter));
    return { tracks, master: this.masterMeters.map((m) => this.measure(m)) };
  }

  private measure(analyser: AnalyserNode): Level {
    if (!this._playing) return { peak: 0, rms: 0 };
    analyser.getFloatTimeDomainData(this.scratch);
    let peak = 0;
    let sum = 0;
    for (const v of this.scratch) {
      const a = Math.abs(v);
      if (a > peak) peak = a;
      sum += v * v;
    }
    return { peak, rms: Math.sqrt(sum / this.scratch.length) };
  }

  unload(): void {
    this.stopSources();
    for (const lane of this.lanes.values()) disconnectLane(lane);
    this.lanes.clear();
    this._duration = 0;
    this.offset = 0;
    this._playing = false;
  }

  // --- transport ------------------------------------------------------------------------------

  /**
   * Starts playback. `at` = context time to start (default: right away); returns the context time
   * the current position starts playing, so callers can align recordings to it.
   */
  async play(at?: number): Promise<number> {
    if (!this.ctx || this.lanes.size === 0 || this._playing) return this.startedAt;
    if (this.offset >= this._duration - 0.01) this.offset = 0;
    await this.ctx.resume();
    if (this._playing) return this.startedAt;
    const now = Math.max(at ?? 0, this.ctx.currentTime + START_LEAD);
    for (const lane of this.lanes.values()) {
      const s = scheduleTrack(this.offset, lane.spec.offset, lane.buffer.duration);
      if (!s) continue;
      const source = new AudioBufferSourceNode(this.ctx, { buffer: lane.buffer });
      source.connect(lane.chain.input);
      source.start(now + s.delay, s.from);
      lane.source = source;
    }
    this.startedAt = now;
    this._playing = true;
    this.armEndTimer();
    return now;
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
    const ctx = sharedContext();
    if (this.ctx !== ctx) {
      this.ctx = ctx;
      this.master = new MasterChain(ctx, this.masterSettings);
      this.master.output.connect(ctx.destination);
      this.buses = new FxBuses(ctx, this.master.input, this.songFx.fx, this.songFx.bpm);
      const split = new ChannelSplitterNode(ctx, { numberOfOutputs: 2 });
      this.master.output.connect(split);
      this.masterMeters = [0, 1].map((ch) => {
        const a = new AnalyserNode(ctx, { fftSize: METER_FFT });
        split.connect(a, ch);
        return a;
      });
    }
    return ctx;
  }

  private armEndTimer(): void {
    window.clearTimeout(this.endTimer);
    // Until the end, plus any scheduled start delay (count-in) that hasn't happened yet.
    const pending = this.ctx ? Math.max(0, this.startedAt - this.ctx.currentTime) : 0;
    const remaining = this._duration - this.currentTime + pending;
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

function disconnectLane(lane: Lane): void {
  disconnectChain(lane.chain);
  lane.meter.disconnect();
}

function makeBuffer(ctx: AudioContext, samples: Float32Array, sampleRate: number): AudioBuffer {
  const buffer = ctx.createBuffer(1, Math.max(1, samples.length), sampleRate);
  buffer.copyToChannel(samples as Float32Array<ArrayBuffer>, 0);
  return buffer;
}
