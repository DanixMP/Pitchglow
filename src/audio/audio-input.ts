// Audio sources (microphone or a synthetic demo voice) -> the live worklet, which forwards raw blocks
// (for recording), pitch frames (for the line) and, when monitoring, the voice processed live.
// Uses the app's shared AudioContext, so blocks and frames carry times on the same clock as playback.

import type { TuneSettings } from '../dsp/autotune';
import type { Voicing } from '../dsp/keys';
import type { VoiceCharacter } from '../dsp/voice-engine';
import { midiToFreq } from '../dsp/notes';
import { sharedContext } from './context';
import { LIVE_PROCESSOR, type LiveKeysMessage, type LiveMessage, type LiveSettingsMessage } from './engine/live-protocol';
import liveWorkletUrl from './engine/live-worklet.ts?worker&url';
import type { PitchFrame } from './pitch-tracker';

export type InputKind = 'mic' | 'demo';

/** Contexts that already have the live worklet module loaded. */
const workletLoaded = new WeakSet<BaseAudioContext>();
/** Fallback mic latency when the browser doesn't report one. */
const DEFAULT_MIC_LATENCY = 0.01;

export interface InputHandlers {
  /** Each raw block and the context time of its first sample. */
  onBlock(block: Float32Array, time: number): void;
  /** Each pitch frame and the context time of its analysis-window centre. */
  onFrame(frame: PitchFrame, time: number): void;
  /** Live-path stats, about twice a second. */
  onStats?(stats: { load: number; degraded: boolean; delaySeconds: number }): void;
}

export interface LiveProcessing {
  monitor: boolean;
  tune: TuneSettings | null;
  semitones: number;
  voice: VoiceCharacter | null;
}

export class AudioInput {
  private stream: MediaStream | null = null;
  private nodes: AudioNode[] = [];
  private live: AudioWorkletNode | null = null;
  private demo: { stop(): void; direct: GainNode } | null = null;
  private processing: LiveProcessing = { monitor: false, tune: null, semitones: 0, voice: null };
  private keys: LiveKeysMessage = { type: 'keys', keys: null, voicing: 'near', mix: 0.6 };
  private _kind: InputKind | null = null;
  private _noiseSuppression = false;
  private _inputLatency = 0;

  constructor(private readonly handlers: InputHandlers) {}

  /** The live worklet's output (the monitored voice), while the input runs. */
  get output(): AudioNode | null {
    return this.live;
  }

  /** What the live path does: monitor on/off, auto-tune, transpose. Applies immediately. */
  setProcessing(p: LiveProcessing): void {
    this.processing = p;
    const msg: LiveSettingsMessage = p;
    this.live?.port.postMessage(msg);
    // The demo voice plays itself quietly to the speakers; while monitoring, you hear it processed instead.
    if (this.demo) this.demo.direct.gain.value = p.monitor ? 0 : DEMO_DIRECT;
  }

  /** Play-the-keys (Phase 19): the held keys the harmony voices sing (null = off). Immediate. */
  setKeys(keys: number[] | null, voicing: Voicing, mix: number): void {
    this.keys = { type: 'keys', keys, voicing, mix };
    this.live?.port.postMessage(this.keys);
  }

  /** Whether the running mic uses the browser's built-in noise suppression. */
  get noiseSuppression(): boolean {
    return this._noiseSuppression;
  }

  /** The source currently running, or null. */
  get kind(): InputKind | null {
    return this._kind;
  }

  get running(): boolean {
    return this._kind !== null;
  }

  /** Seconds from sound at the mic to the capture worklet (0 for the synthetic demo voice). */
  get inputLatency(): number {
    return this._inputLatency;
  }

  /**
   * Starts capturing and resolves with the input sample rate. `noiseSuppression` turns on the
   * browser's live noise filter for the mic (it shapes what gets recorded, too).
   */
  async start(kind: InputKind, opts: { noiseSuppression?: boolean } = {}): Promise<number> {
    await this.stop();
    const ctx = sharedContext();
    try {
      if (!workletLoaded.has(ctx)) {
        await ctx.audioWorklet.addModule(liveWorkletUrl);
        workletLoaded.add(ctx);
      }
      const live = new AudioWorkletNode(ctx, LIVE_PROCESSOR, {
        numberOfInputs: 1,
        numberOfOutputs: 1,
        outputChannelCount: [1],
        channelCount: 1,
        channelCountMode: 'explicit',
      });
      const rate = ctx.sampleRate;
      live.port.onmessage = (e: MessageEvent<LiveMessage>) => {
        const m = e.data;
        if (m.type === 'block') this.handlers.onBlock(m.samples, m.frame / rate);
        else if (m.type === 'frame') this.handlers.onFrame(m.frame, m.at / rate);
        else this.handlers.onStats?.({ load: m.load, degraded: m.degraded, delaySeconds: m.delay / rate });
      };
      live.port.postMessage(this.keys);
      live.port.postMessage(this.processing satisfies LiveSettingsMessage);
      // Keep the node pulled by the graph without making any sound (the monitor is routed separately).
      const mute = new GainNode(ctx, { gain: 0 });
      live.connect(mute).connect(ctx.destination);
      this.live = live;
      this.nodes.push(live, mute);

      if (kind === 'mic') {
        this.stream = await navigator.mediaDevices.getUserMedia({
          audio: { channelCount: 1, echoCancellation: false, noiseSuppression: !!opts.noiseSuppression, autoGainControl: false },
        });
        const src = ctx.createMediaStreamSource(this.stream);
        src.connect(live);
        this.nodes.push(src);
        const reported = (this.stream.getAudioTracks()[0]?.getSettings() as { latency?: number } | undefined)?.latency;
        this._inputLatency = typeof reported === 'number' && reported >= 0 ? reported : DEFAULT_MIC_LATENCY;
      } else {
        this.demo = startDemoVoice(ctx, live);
        this.demo.direct.gain.value = this.processing.monitor ? 0 : DEMO_DIRECT;
        this._inputLatency = 0;
      }
      this._kind = kind;
      this._noiseSuppression = kind === 'mic' && !!opts.noiseSuppression;
      await ctx.resume();
      return ctx.sampleRate;
    } catch (err) {
      await this.stop();
      throw err;
    }
  }

  async stop(): Promise<void> {
    this.demo?.stop();
    this.demo = null;
    this.stream?.getTracks().forEach((t) => t.stop());
    this.stream = null;
    if (this.live) this.live.port.onmessage = null;
    this.live = null;
    for (const n of this.nodes) n.disconnect();
    this.nodes = [];
    this._kind = null;
  }
}

// --- Demo voice -------------------------------------------------------------------------------
// A buzzy, vowel-ish tone that speaks a phrase of glides with vibrato and pauses, over faint room
// hiss, so the whole pipeline (incl. noise reduction) can be tested without a microphone.
// The voice (not the hiss) is also played quietly to the speakers.

/** [MIDI note, seconds]; null = pause. Contour loosely follows speech/singing in the C2-C4 range. */
const DEMO_PHRASE: [number | null, number][] = [
  [50, 0.35], [55, 0.25], [52, 0.4], [null, 0.25],
  [48, 0.3], [53, 0.3], [57, 0.5], [55, 0.3], [null, 0.3],
  [60, 0.6], [59, 0.2], [57, 0.2], [55, 0.6], [null, 0.4],
  [45, 0.3], [47, 0.3], [48, 0.3], [50, 0.8], [null, 0.6],
];
const DEMO_GLIDE = 0.06;
/** Level of the demo voice played straight to the speakers (when not monitoring). */
const DEMO_DIRECT = 0.15;

function startDemoVoice(ctx: AudioContext, capture: AudioNode): { stop(): void; direct: GainNode } {
  const osc = new OscillatorNode(ctx, { type: 'sawtooth', frequency: midiToFreq(50) });
  const formant = new BiquadFilterNode(ctx, { type: 'lowpass', frequency: 1400, Q: 4 });
  const amp = new GainNode(ctx, { gain: 0 });
  const vibrato = new OscillatorNode(ctx, { frequency: 5.5 });
  const vibratoDepth = new GainNode(ctx, { gain: 25 }); // cents
  vibrato.connect(vibratoDepth).connect(osc.detune);

  osc.connect(formant).connect(amp);
  amp.connect(capture);

  // Faint room hiss (~-35 dBFS) into the recording only, so noise reduction has something to remove.
  const hissBuffer = ctx.createBuffer(1, ctx.sampleRate * 2, ctx.sampleRate);
  const hissData = hissBuffer.getChannelData(0);
  for (let i = 0; i < hissData.length; i++) hissData[i] = Math.random() * 2 - 1;
  const hiss = new AudioBufferSourceNode(ctx, { buffer: hissBuffer, loop: true });
  hiss.connect(new BiquadFilterNode(ctx, { type: 'lowpass', frequency: 6000 })).connect(new GainNode(ctx, { gain: 0.03 })).connect(capture);
  hiss.start();
  const direct = new GainNode(ctx, { gain: DEMO_DIRECT });
  amp.connect(direct).connect(ctx.destination);

  const phraseLength = DEMO_PHRASE.reduce((s, [, d]) => s + d, 0);
  let nextPhraseAt = ctx.currentTime + 0.1;

  const schedulePhrase = (t0: number) => {
    let t = t0;
    for (const [note, dur] of DEMO_PHRASE) {
      if (note === null) {
        amp.gain.setTargetAtTime(0, t, 0.02);
      } else {
        osc.frequency.setTargetAtTime(midiToFreq(note), t, DEMO_GLIDE / 3);
        amp.gain.setTargetAtTime(0.5, t, 0.02);
      }
      t += dur;
    }
  };

  // Schedule phrases a little ahead of time so playback never runs dry.
  const tick = () => {
    while (nextPhraseAt < ctx.currentTime + 1) {
      schedulePhrase(nextPhraseAt);
      nextPhraseAt += phraseLength;
    }
  };
  tick();
  const timer = window.setInterval(tick, 250);
  osc.start();
  vibrato.start();

  return {
    direct,
    stop: () => {
      hiss.stop();
      window.clearInterval(timer);
      osc.stop();
      vibrato.stop();
      amp.disconnect();
      direct.disconnect();
    },
  };
}
