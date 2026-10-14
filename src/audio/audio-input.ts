// Audio sources (microphone or a synthetic demo voice) -> capture worklet -> onBlock callback.
// Uses the app's shared AudioContext, so captured blocks carry times on the same clock as playback.

import captureWorkletUrl from './capture-worklet.ts?worker&url';
import type { CaptureMessage } from './capture-worklet';
import { sharedContext } from './context';
import { midiToFreq } from '../dsp/notes';

export type InputKind = 'mic' | 'demo';

/** Contexts that already have the capture worklet module loaded. */
const workletLoaded = new WeakSet<BaseAudioContext>();
/** Fallback mic latency when the browser doesn't report one. */
const DEFAULT_MIC_LATENCY = 0.01;

export class AudioInput {
  private stream: MediaStream | null = null;
  private nodes: AudioNode[] = [];
  private capture: AudioWorkletNode | null = null;
  private stopDemo: (() => void) | null = null;
  private _kind: InputKind | null = null;
  private _noiseSuppression = false;
  private _inputLatency = 0;

  /**
   * @param onBlock receives each captured block and the context time of its first sample.
   */
  constructor(private readonly onBlock: (block: Float32Array, time: number) => void) {}

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
        await ctx.audioWorklet.addModule(captureWorkletUrl);
        workletLoaded.add(ctx);
      }
      const capture = new AudioWorkletNode(ctx, 'capture-processor', {
        numberOfInputs: 1,
        numberOfOutputs: 1,
        channelCount: 1,
        channelCountMode: 'explicit',
      });
      capture.port.onmessage = (e: MessageEvent<CaptureMessage>) => this.onBlock(e.data.samples, e.data.frame / ctx.sampleRate);
      // Keep the node pulled by the graph without making any sound.
      const mute = new GainNode(ctx, { gain: 0 });
      capture.connect(mute).connect(ctx.destination);
      this.capture = capture;
      this.nodes.push(capture, mute);

      if (kind === 'mic') {
        this.stream = await navigator.mediaDevices.getUserMedia({
          audio: { channelCount: 1, echoCancellation: false, noiseSuppression: !!opts.noiseSuppression, autoGainControl: false },
        });
        const src = ctx.createMediaStreamSource(this.stream);
        src.connect(capture);
        this.nodes.push(src);
        const reported = (this.stream.getAudioTracks()[0]?.getSettings() as { latency?: number } | undefined)?.latency;
        this._inputLatency = typeof reported === 'number' && reported >= 0 ? reported : DEFAULT_MIC_LATENCY;
      } else {
        this.stopDemo = startDemoVoice(ctx, capture);
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
    this.stopDemo?.();
    this.stopDemo = null;
    this.stream?.getTracks().forEach((t) => t.stop());
    this.stream = null;
    if (this.capture) this.capture.port.onmessage = null;
    this.capture = null;
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

function startDemoVoice(ctx: AudioContext, capture: AudioNode): () => void {
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
  amp.connect(new GainNode(ctx, { gain: 0.15 })).connect(ctx.destination);

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

  return () => {
    hiss.stop();
    window.clearInterval(timer);
    osc.stop();
    vibrato.stop();
    amp.disconnect();
  };
}
