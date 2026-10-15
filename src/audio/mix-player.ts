// Plays several tracks in sync (a project), or a single take (one track). Each track runs through
// the shared mix chain (gain -> pan -> master -> limiter, see chain.ts); gain/pan/master changes are
// live, swapping a track's audio keeps the position and play state. Analysers tap every track and the
// master (L/R) for the meters. A single clock (with output-latency compensation) drives the visuals.
// With a loop region, every pass of the loop is scheduled ahead on the audio clock (sample-accurate,
// with short fades where a clip is cut), so it keeps looping even when timers are throttled.
//
// Two kinds of lanes (Phase 13):
// - buffer lanes (instrumentals): AudioBufferSourceNodes scheduled per pass, as above;
// - engine lanes (vocals): a voice-engine AudioWorkletNode that holds the take and its grain plans and
//   follows transport messages (start frame, position, loop). New plans (a knob turned) apply on the
//   next 128-sample block without interrupting playback.
//
// The metronome (Phase 17) is a click-engine worklet on the same transport, straight to the speakers
// (never in exports or the master meters). It also plays the count-in before a take.

import { CLEANUP_OFF, type CleanupAnalysis, type CleanupSettings } from '../dsp/cleanup';
import type { VoicePlans } from '../dsp/voice-engine';
import { resample } from '../dsp/vocoder';
import { DEFAULT_SONG_FX, type SongFx, type TrackFx } from '../project/fx';
import { clickGridOf, type Grid } from '../project/grid';
import { loopPosition, scheduleTrack } from '../project/model';
import {
  applyTrackFx,
  clampPan,
  createTrackChain,
  disconnectChain,
  FxBuses,
  MasterChain,
  measureChainLatency,
  type MasterSettings,
  type TrackChain,
} from './chain';
import { sharedContext } from './context';
import {
  BEAT_PROCESSOR,
  CLICK_PROCESSOR,
  ENGINE_PROCESSOR,
  type BeatMessage,
  type BeatOptions,
  type ClickMessage,
  type ClickOptions,
  type EngineMessage,
  type EngineOptions,
} from './engine/protocol';
import type { EngineTransport } from './engine/transport';
import engineWorkletUrl from './engine/engine-worklet.ts?worker&url';
import beatWorkletUrl from './engine/beat-worklet.ts?worker&url';
import clickWorkletUrl from './engine/click-worklet.ts?worker&url';

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
  /** Voice-engine grain plans for `samples` (auto-tune, harmony, transpose); null = play as is. */
  plans?: VoicePlans | null;
  /** Key shift of a buffer (beat) lane, semitones; played through the beat engine when non-zero. */
  shift?: number;
  /** Clean-up analysis of `samples` (null = none) and its live settings (noise reduction, gate, de-ess). */
  cleanup?: CleanupAnalysis | null;
  cleanupSettings?: CleanupSettings;
  /** Start position in the song, seconds. */
  offset: number;
}

interface Lane {
  spec: MixTrackSpec;
  /** Buffer lanes (instrumentals). */
  buffer: AudioBuffer | null;
  /** Engine lanes (vocals), or the beat engine (key-shifted instrumentals). */
  engine: AudioWorkletNode | null;
  /** Whether `engine` is the beat engine. */
  beat: boolean;
  /** Length in seconds. */
  duration: number;
  chain: TrackChain;
  meter: AnalyserNode;
}

/** Contexts with the voice-engine module loaded. */
const engineLoaded = new WeakSet<BaseAudioContext>();

/** Loads the voice-engine worklet module into a context (once). */
export async function loadEngine(ctx: BaseAudioContext): Promise<void> {
  if (engineLoaded.has(ctx)) return;
  await Promise.all([
    ctx.audioWorklet.addModule(engineWorkletUrl),
    ctx.audioWorklet.addModule(beatWorkletUrl),
    ctx.audioWorklet.addModule(clickWorkletUrl),
  ]);
  engineLoaded.add(ctx);
}

/** A beat lane with the key shift applied live (phase vocoder in the beat-engine worklet). */
export function createBeatEngine(ctx: BaseAudioContext, buffer: AudioBuffer, semitones: number, offset: number, transport: EngineTransport | null): AudioWorkletNode {
  const processorOptions: BeatOptions = {
    channels: Array.from({ length: Math.min(2, buffer.numberOfChannels) }, (_, c) => buffer.getChannelData(c)),
    semitones,
    offset: Math.round(offset * ctx.sampleRate),
    transport,
  };
  return new AudioWorkletNode(ctx, BEAT_PROCESSOR, {
    numberOfInputs: 0,
    numberOfOutputs: 1,
    outputChannelCount: [processorOptions.channels.length],
    processorOptions,
  });
}

/** Take audio at the context's rate (resampled copies are cached per array). */
const resampled = new WeakMap<Float32Array, { rate: number; samples: Float32Array }>();
export function atRate(samples: Float32Array, from: number, to: number): Float32Array {
  if (from === to) return samples;
  const hit = resampled.get(samples);
  if (hit?.rate === to) return hit.samples;
  const out = resample(samples, from / to, Math.floor((samples.length * to) / from));
  resampled.set(samples, { rate: to, samples: out });
  return out;
}

/** An engine node for a vocal lane; plans only apply to audio already at the context rate. */
export function createEngine(ctx: BaseAudioContext, spec: MixTrackSpec, transport: EngineTransport | null): AudioWorkletNode {
  const rate = ctx.sampleRate;
  // Plans and clean-up analysis are made at the playback rate: they only apply to audio at that rate.
  const native = spec.sampleRate === rate;
  const processorOptions: EngineOptions = {
    samples: atRate(spec.samples, spec.sampleRate, rate),
    plans: native ? (spec.plans ?? null) : null,
    cleanup: native ? (spec.cleanup ?? null) : null,
    cleanupSettings: spec.cleanupSettings ?? CLEANUP_OFF,
    offset: Math.round(spec.offset * rate),
    transport,
  };
  return new AudioWorkletNode(ctx, ENGINE_PROCESSOR, { numberOfInputs: 0, numberOfOutputs: 1, outputChannelCount: [1], processorOptions });
}

interface Voice {
  source: AudioBufferSourceNode;
  env: GainNode;
}

type Region = { start: number; end: number };

export interface MetronomeSettings {
  on: boolean;
  /** Linear click level. */
  gain: number;
  accent: boolean;
  grid: Grid;
}

export interface PlayOptions {
  /** Seconds of count-in clicks before `at` (on the grid's beats; heard even with the metronome off). */
  countIn?: number;
  /** Recording a take over the song: keep the transport (and the click) running past the song's end. */
  recording?: boolean;
}

const METER_FFT = 1024;

/** Scheduling lead so all tracks start on the same audio frame. */
const START_LEAD = 0.02;
const SINGLE = 'take';
/** How far ahead loop passes are scheduled (covers background-tab timer throttling). */
const LOOP_LOOKAHEAD = 1.5;
/** Fade where a loop boundary cuts through a clip, to avoid clicks. */
const LOOP_FADE = 0.004;

export class MixPlayer {
  private ctx: AudioContext | null = null;
  private master: MasterChain | null = null;
  private masterMeters: AnalyserNode[] = [];
  private masterSettings: MasterSettings = { gain: 1, limiter: true };
  private buses: FxBuses | null = null;
  private songFx: { fx: SongFx; bpm: number | null } = { fx: DEFAULT_SONG_FX, bpm: null };
  private lanes = new Map<string, Lane>();
  private voices = new Set<Voice>();
  /** "Hear myself": the live voice through its own track chain (effects + sends) into the master. */
  private monitor: { node: AudioNode; chain: TrackChain } | null = null;
  /** Loop region requested by the song (null = none). */
  private loop: Region | null = null;
  /** Loop in effect for the current run of playback (null = playing straight through). */
  private playLoop: Region | null = null;
  /** Context time of the next scheduled loop pass. */
  private nextPass = 0;
  private loopTimer = 0;
  private scratch = new Float32Array(METER_FFT);
  private startedAt = 0;
  private offset = 0;
  private _playing = false;
  private _duration = 0;
  private endTimer = 0;
  private metronome: MetronomeSettings = { on: false, gain: 0.5, accent: true, grid: clickGridOf(null) };
  private click: { node: AudioWorkletNode; delay: DelayNode; gain: GainNode } | null = null;
  /** The mix chain's own delay (limiter on / off), measured once; see measureChainLatency. */
  private chainLatency = { limiter: 0, plain: 0 };
  /** The click's current 'play' message (re-sent when the metronome is switched on mid-play). */
  private clickPlay: Extract<ClickMessage, { type: 'play' }> | null = null;
  private recording = false;

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

  /** Loads the voice engine into the shared context; call before any take or song is played. */
  async loadEngine(): Promise<void> {
    const ctx = this.ensureContext();
    await loadEngine(ctx);
    this.chainLatency = await measureChainLatency(ctx.sampleRate);
    this.applyClickDelay();
  }

  /** How much later than the transport the mix is heard, from the chain itself (not the output). */
  get mixLatency(): number {
    return this.masterSettings.limiter ? this.chainLatency.limiter : this.chainLatency.plain;
  }

  /** Decodes an audio file (mp3/wav/m4a/ogg/flac…) at the context's sample rate. */
  decode(data: ArrayBuffer): Promise<AudioBuffer> {
    // decodeAudioData detaches its argument, so give it a copy and keep the caller's bytes intact.
    return this.ensureContext().decodeAudioData(data.slice(0));
  }

  /** Song position in seconds, compensated for output latency so visuals match what you hear. */
  get currentTime(): number {
    if (!this._playing || !this.ctx) return this.offset;
    const latency = (this.ctx.outputLatency || 0) + (this.ctx.baseLatency || 0) + this.mixLatency;
    const elapsed = Math.max(0, this.ctx.currentTime - this.startedAt - latency);
    return Math.min(this._duration, loopPosition(this.offset, elapsed, this.playLoop));
  }

  // --- content --------------------------------------------------------------------------------

  /** Single-take preview: one track at offset 0, full gain. Resets the position. */
  load(samples: Float32Array, sampleRate: number): void {
    this.setTracks([{ id: SINGLE, samples, sampleRate, gain: 1, offset: 0, plans: null }]);
    this.offset = 0;
  }

  /** Single-take preview: replace the audio and plans (A/B, new clean-up), keeping position and play state. */
  swap(
    samples: Float32Array,
    sampleRate: number,
    plans: VoicePlans | null = null,
    cleanup: CleanupAnalysis | null = null,
    cleanupSettings: CleanupSettings = CLEANUP_OFF,
  ): void {
    const lane = this.lanes.get(SINGLE);
    if (lane?.engine && lane.spec.samples === samples && lane.spec.sampleRate === sampleRate && this.ctx) {
      // Same audio: only what changed goes to the engine, without interrupting playback.
      const native = sampleRate === this.ctx.sampleRate;
      if ((lane.spec.cleanup ?? null) !== cleanup) {
        lane.spec = { ...lane.spec, cleanup, cleanupSettings };
        this.post(lane, { type: 'cleanup', analysis: native ? cleanup : null, settings: cleanupSettings });
      } else {
        this.setCleanup(SINGLE, cleanupSettings);
      }
      return this.setPlans(SINGLE, plans);
    }
    const specs = [...this.lanes.values()].map((l) => (l.spec.id === SINGLE ? { ...l.spec, samples, sampleRate, plans, cleanup, cleanupSettings } : l.spec));
    if (this.lanes.has(SINGLE)) this.setTracks(specs);
  }

  /** Live key shift of a beat lane (no restart once the lane runs through the beat engine). */
  setShift(id: string, semitones: number): void {
    const lane = this.lanes.get(id);
    if (!lane || (lane.spec.shift ?? 0) === semitones) return;
    if (lane.beat && lane.engine) {
      lane.spec = { ...lane.spec, shift: semitones };
      lane.engine.port.postMessage({ type: 'shift', semitones } satisfies BeatMessage);
      return;
    }
    // First shift of a plain beat lane: switch it to the beat engine (keeps position and play state).
    this.setTracks([...this.lanes.values()].map((l) => (l.spec.id === id ? { ...l.spec, shift: semitones } : l.spec)));
  }

  /** Live clean-up settings for a vocal lane (noise reduction, gate, de-ess); heard on the next block. */
  setCleanup(id: string, settings: CleanupSettings): void {
    const lane = this.lanes.get(id);
    if (!lane?.engine || sameCleanup(lane.spec.cleanupSettings, settings)) return;
    lane.spec = { ...lane.spec, cleanupSettings: settings };
    this.post(lane, { type: 'cleanup', settings });
  }

  /** Single-take preview: new plans only (a knob turned), seamlessly. */
  setPreviewPlans(plans: VoicePlans | null): void {
    this.setPlans(SINGLE, plans);
  }

  /** New voice-engine plans for a vocal lane; applied from the next block, without a gap. */
  setPlans(id: string, plans: VoicePlans | null): void {
    const lane = this.lanes.get(id);
    if (!lane?.engine || !this.ctx || lane.spec.plans === plans) return;
    lane.spec = { ...lane.spec, plans };
    this.post(lane, { type: 'plans', plans: lane.spec.sampleRate === this.ctx.sampleRate ? plans : null });
  }

  /** Replaces the set of tracks. Unchanged audio is reused; position and play state are kept. */
  setTracks(specs: readonly MixTrackSpec[]): void {
    const ctx = this.ensureContext();
    const wasPlaying = this._playing;
    const time = this.currentTime;
    this.stopSources();
    // Stopped: so the play() below really restarts (it returns early while "playing").
    this._playing = false;

    const next = new Map<string, Lane>();
    const rate = ctx.sampleRate;
    for (const spec of specs) {
      const prev = this.lanes.get(spec.id);
      const wantsEngine = !spec.buffer;
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

      let buffer: AudioBuffer | null = null;
      let engine: AudioWorkletNode | null = null;
      let beat = false;
      if (wantsEngine) {
        engine = prev?.engine ?? null;
        if (!engine) {
          engine = createEngine(ctx, spec, null);
          engine.connect(chain.input);
        } else {
          const native = spec.sampleRate === rate;
          const plans = native ? (spec.plans ?? null) : null;
          const cleanup = native ? (spec.cleanup ?? null) : null;
          const cleanupSettings = spec.cleanupSettings ?? CLEANUP_OFF;
          if (prev!.spec.samples !== spec.samples || prev!.spec.sampleRate !== spec.sampleRate) {
            engine.port.postMessage({ type: 'source', samples: atRate(spec.samples, spec.sampleRate, rate), plans, cleanup, cleanupSettings } satisfies EngineMessage);
          } else {
            if (prev!.spec.plans !== spec.plans) engine.port.postMessage({ type: 'plans', plans } satisfies EngineMessage);
            const analysisChanged = (prev!.spec.cleanup ?? null) !== cleanup;
            if (analysisChanged || !sameCleanup(prev!.spec.cleanupSettings, cleanupSettings)) {
              engine.port.postMessage({ type: 'cleanup', ...(analysisChanged ? { analysis: cleanup } : {}), settings: cleanupSettings } satisfies EngineMessage);
            }
          }
          if (prev!.spec.offset !== spec.offset) engine.port.postMessage({ type: 'offset', offset: Math.round(spec.offset * rate) } satisfies EngineMessage);
        }
      } else {
        const shift = spec.shift ?? 0;
        // A beat runs through the beat engine once it has been key-shifted (and stays there, so
        // later shifts are just a message); otherwise it is a plain buffer lane.
        const keepBeat = prev?.beat && prev.spec.buffer === spec.buffer;
        if (prev?.engine && !keepBeat) {
          prev.engine.disconnect();
          prev.engine.port.close();
        }
        if (keepBeat || shift !== 0) {
          engine = keepBeat ? prev!.engine : createBeatEngine(ctx, spec.buffer!, shift, spec.offset, null);
          if (!keepBeat) engine!.connect(chain.input);
          else {
            if ((prev!.spec.shift ?? 0) !== shift) engine!.port.postMessage({ type: 'shift', semitones: shift } satisfies BeatMessage);
            if (prev!.spec.offset !== spec.offset) engine!.port.postMessage({ type: 'offset', offset: Math.round(spec.offset * rate) } satisfies BeatMessage);
          }
          beat = true;
        } else {
          buffer = prev?.buffer && prev.spec.buffer === spec.buffer ? prev.buffer : spec.buffer!;
        }
      }
      const duration = spec.buffer ? spec.buffer.duration : spec.samples.length / spec.sampleRate;
      next.set(spec.id, { spec, buffer, engine, beat, duration, chain, meter });
    }
    for (const [id, lane] of this.lanes) if (!next.has(id)) disconnectLane(lane);
    this.lanes = next;
    this._duration = [...next.values()].reduce((m, l) => Math.max(m, l.spec.offset + l.duration), 0);
    this.offset = Math.min(time, this._duration);
    if (wasPlaying) void this.play();
  }

  /** Replaces one track's audio (e.g. its processed render arrived), keeping position and play state. */
  swapTrack(id: string, samples: Float32Array, sampleRate: number, plans: VoicePlans | null = null): void {
    const specs = [...this.lanes.values()].map((l) => (l.spec.id === id ? { ...l.spec, samples, sampleRate, plans } : l.spec));
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

  /** Routes the live (monitored) voice through a track chain with `fx` into the master; null = off. */
  setMonitor(node: AudioNode | null, fx?: TrackFx): void {
    const ctx = this.ensureContext();
    if (this.monitor && this.monitor.node !== node) {
      this.monitor.node.disconnect(this.monitor.chain.input);
      disconnectChain(this.monitor.chain);
      this.monitor = null;
    }
    if (!node) return;
    if (!this.monitor) {
      const chain = createTrackChain(ctx, 1, 0, this.master!.input, fx, this.buses!);
      node.connect(chain.input);
      this.monitor = { node, chain };
    } else {
      applyTrackFx(this.monitor.chain, fx, ctx);
    }
  }

  /** Sets (or clears) the loop region; restarts playback from the current position if playing. */
  setLoop(loop: Region | null): void {
    if (loop?.start === this.loop?.start && loop?.end === this.loop?.end) return;
    const wasPlaying = this._playing;
    this.pause();
    this.loop = loop;
    if (wasPlaying) void this.play();
  }

  /** Live master fader / limiter. */
  setMaster(settings: MasterSettings): void {
    this.masterSettings = settings;
    if (this.master && this.ctx) this.master.apply(settings, this.ctx);
    this.applyClickDelay();
  }

  /** The click skips the mix chain, so it waits as long as the chain delays the music. */
  private applyClickDelay(): void {
    if (this.click) this.click.delay.delayTime.value = this.mixLatency;
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
  async play(at?: number, opts: PlayOptions = {}): Promise<number> {
    if (opts.recording) this.recording = true; // until pause(): survives a mix rebuild mid-take
    if (!this.ctx || (this.lanes.size === 0 && !this.recording) || this._playing) return this.startedAt;
    if (this.offset >= this._duration - 0.01 && !this.recording) this.offset = 0;
    await this.ctx.resume();
    if (this._playing) return this.startedAt;
    const now = Math.max(at ?? 0, this.ctx.currentTime + START_LEAD);
    const loop = this.loop && this.offset < this.loop.end && Math.min(this.loop.end, this._duration) - this.loop.start > 0.05 ? this.loop : null;
    this.playLoop = loop;
    this.startedAt = now;
    this._playing = true;
    // Engine lanes follow the transport themselves (positions in samples at the context rate).
    const rate = this.ctx.sampleRate;
    const transport: EngineTransport = {
      startFrame: Math.round(now * rate),
      from: Math.round(this.offset * rate),
      loop: loop ? { start: Math.round(loop.start * rate), end: Math.round(loop.end * rate) } : null,
    };
    for (const lane of this.lanes.values()) if (lane.engine) this.post(lane, { type: 'play', transport });
    this.startClick(transport, opts.countIn ?? 0);
    if (loop) {
      // First pass from the playhead to the loop end, then whole passes back to back.
      this.scheduleSpan(now, this.offset, loop.end, false);
      this.nextPass = now + (loop.end - this.offset);
      this.fillLoop();
    } else {
      this.scheduleSpan(now, this.offset, Infinity, false);
      if (!this.recording) this.armEndTimer();
    }
    return now;
  }

  // --- metronome ------------------------------------------------------------------------------

  /** Click on/off, level, accent and grid; all live (the click follows the running transport). */
  setMetronome(settings: MetronomeSettings): void {
    const prev = this.metronome;
    this.metronome = settings;
    const click = this.ensureClick();
    if (!click || !this.ctx) return;
    click.gain.gain.setTargetAtTime(settings.gain, this.ctx.currentTime, 0.01);
    const g = settings.grid;
    if (g.bpm !== prev.grid.bpm || g.beatsPerBar !== prev.grid.beatsPerBar || g.downbeat !== prev.grid.downbeat || settings.accent !== prev.accent) {
      click.node.port.postMessage({ type: 'grid', grid: this.clickGrid() } satisfies ClickMessage);
    }
    if (settings.on !== prev.on && this._playing && this.clickPlay) {
      // Switched mid-play: keep any count-in still to come, otherwise click (or stop clicking) now.
      const before = settings.on ? null : this.clickPlay.before;
      if (settings.on || before !== null) click.node.port.postMessage({ ...this.clickPlay, before } satisfies ClickMessage);
      else click.node.port.postMessage({ type: 'stop' } satisfies ClickMessage);
    }
  }

  private clickGrid() {
    const rate = this.ctx!.sampleRate;
    const g = this.metronome.grid;
    return { beatSamples: (60 / g.bpm) * rate, downbeatSample: g.downbeat * rate, beatsPerBar: g.beatsPerBar, accent: this.metronome.accent };
  }

  /** The click lane (created once the worklet modules are loaded). */
  private ensureClick(): { node: AudioWorkletNode; delay: DelayNode; gain: GainNode } | null {
    const ctx = this.ctx;
    if (this.click || !ctx || !engineLoaded.has(ctx)) return this.click;
    const node = new AudioWorkletNode(ctx, CLICK_PROCESSOR, {
      numberOfInputs: 0,
      numberOfOutputs: 1,
      outputChannelCount: [1],
      processorOptions: { grid: this.clickGrid() } satisfies ClickOptions,
    });
    const delay = new DelayNode(ctx, { maxDelayTime: 0.2, delayTime: this.mixLatency });
    const gain = new GainNode(ctx, { gain: this.metronome.gain });
    node.connect(delay).connect(gain).connect(ctx.destination);
    this.click = { node, delay, gain };
    return this.click;
  }

  /** Starts the click on the transport, `countIn` seconds early (count-in clicks only, if it's off). */
  private startClick(transport: EngineTransport, countIn: number): void {
    const click = this.ensureClick();
    this.clickPlay = null;
    if (!click || !this.ctx) return;
    const rate = this.ctx.sampleRate;
    const lead = Math.round(countIn * rate);
    // Count-in positions are before the song position (maybe below 0): bias them to stay positive.
    const bias = lead + rate;
    this.clickPlay = {
      type: 'play',
      transport: {
        startFrame: transport.startFrame - lead,
        from: transport.from - lead + bias,
        loop: transport.loop ? { start: transport.loop.start + bias, end: transport.loop.end + bias } : null,
      },
      bias,
      before: lead > 0 ? transport.from : null,
    };
    if (this.metronome.on) click.node.port.postMessage({ ...this.clickPlay, before: null } satisfies ClickMessage);
    else if (lead > 0) click.node.port.postMessage(this.clickPlay satisfies ClickMessage);
  }

  /** Schedules every track for song time [from, to), starting at context time `at`. */
  private scheduleSpan(at: number, from: number, to: number, fadeIn: boolean): void {
    const ctx = this.ctx!;
    for (const lane of this.lanes.values()) {
      if (!lane.buffer) continue; // engine lanes schedule themselves
      const s = scheduleTrack(from, lane.spec.offset, lane.buffer.duration);
      if (!s || from + s.delay >= to) continue;
      const end = Math.min(lane.buffer.duration, to - lane.spec.offset);
      const length = end - s.from;
      if (length <= 0) continue;
      const source = new AudioBufferSourceNode(ctx, { buffer: lane.buffer });
      const env = new GainNode(ctx);
      source.connect(env).connect(lane.chain.input);
      const start = at + s.delay;
      if (fadeIn && s.from > 0) {
        env.gain.setValueAtTime(0, start);
        env.gain.linearRampToValueAtTime(1, start + LOOP_FADE);
      }
      if (end < lane.buffer.duration) {
        // Cut by the loop end: fade out just before it.
        env.gain.setValueAtTime(1, Math.max(start + LOOP_FADE, start + length - LOOP_FADE));
        env.gain.linearRampToValueAtTime(0, start + length);
        source.start(start, s.from, length);
      } else {
        source.start(start, s.from);
      }
      const voice = { source, env };
      this.voices.add(voice);
      source.onended = () => {
        this.voices.delete(voice);
        env.disconnect();
      };
    }
  }

  /** Keeps loop passes scheduled LOOP_LOOKAHEAD seconds ahead. */
  private fillLoop(): void {
    const loop = this.playLoop;
    if (!loop || !this.ctx || !this._playing) return;
    while (this.nextPass - this.ctx.currentTime < LOOP_LOOKAHEAD) {
      this.scheduleSpan(this.nextPass, loop.start, loop.end, true);
      this.nextPass += loop.end - loop.start;
    }
    this.loopTimer = window.setTimeout(() => this.fillLoop(), 250);
  }

  pause(): void {
    this.recording = false;
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

  private post(lane: Lane, message: EngineMessage): void {
    lane.engine?.port.postMessage(message);
  }

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
    window.clearTimeout(this.loopTimer);
    this.click?.node.port.postMessage({ type: 'stop' } satisfies ClickMessage);
    for (const lane of this.lanes.values()) if (lane.engine) this.post(lane, { type: 'stop' });
    for (const { source, env } of this.voices) {
      source.onended = null;
      try {
        source.stop();
      } catch {
        // never started (scheduled in the future and stopped before) — fine
      }
      source.disconnect();
      env.disconnect();
    }
    this.voices.clear();
  }
}

function sameCleanup(a: CleanupSettings | undefined, b: CleanupSettings | undefined): boolean {
  const x = a ?? CLEANUP_OFF;
  const y = b ?? CLEANUP_OFF;
  return x.denoiseDb === y.denoiseDb && x.gate === y.gate && x.deess === y.deess;
}

function disconnectLane(lane: Lane): void {
  if (lane.engine) {
    lane.engine.port.postMessage({ type: 'stop' } satisfies EngineMessage);
    lane.engine.disconnect();
    lane.engine.port.close();
  }
  disconnectChain(lane.chain);
  lane.meter.disconnect();
}
