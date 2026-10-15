// The mix signal chain, built the same way for live playback (MixPlayer) and export (mixdown), so
// what you hear is what you export:
//   track:  source -> high-pass -> EQ (low shelf, mid peak, high shelf) -> compressor
//           -> Gain (fader/mute/solo) -> StereoPanner -> master
//                                                     \-> reverb send, echo send (post-fader)
//   buses:  reverb send -> Convolver (generated IR) -> return -> master
//           echo send -> Delay <-> (low-pass, feedback) -> return -> master
//   master: Gain (master fader) -> [limiter] -> output

import { generateImpulse, REVERB_PRESETS } from '../dsp/reverb';
import { DEFAULT_TRACK_FX, echoSeconds, type SongFx, type TrackFx } from '../project/fx';

export interface MasterSettings {
  /** Linear master gain. */
  gain: number;
  /** Brick-wall-ish limiter at −1 dBFS so the mix doesn't clip. */
  limiter: boolean;
}

export interface TrackChain {
  /** Where the track's source connects. */
  input: AudioNode;
  highpass: BiquadFilterNode;
  low: BiquadFilterNode;
  mid: BiquadFilterNode;
  high: BiquadFilterNode;
  comp: DynamicsCompressorNode;
  gain: GainNode;
  pan: StereoPannerNode;
  reverbSend: GainNode;
  echoSend: GainNode;
}

/** The song's effect buses a track can send to. */
export interface BusInputs {
  reverbIn: AudioNode;
  echoIn: AudioNode;
}

export function createTrackChain(
  ctx: BaseAudioContext,
  gain: number,
  pan: number,
  destination: AudioNode,
  fx: TrackFx = DEFAULT_TRACK_FX,
  buses?: BusInputs,
): TrackChain {
  const chain: TrackChain = {
    input: null as unknown as AudioNode,
    highpass: new BiquadFilterNode(ctx, { type: 'highpass', Q: 0.707 }),
    low: new BiquadFilterNode(ctx, { type: 'lowshelf', frequency: 200 }),
    mid: new BiquadFilterNode(ctx, { type: 'peaking', frequency: 2500, Q: 1 }),
    high: new BiquadFilterNode(ctx, { type: 'highshelf', frequency: 8000 }),
    comp: new DynamicsCompressorNode(ctx, { knee: 6, attack: 0.005, release: 0.15 }),
    gain: new GainNode(ctx, { gain }),
    pan: new StereoPannerNode(ctx, { pan: clampPan(pan) }),
    reverbSend: new GainNode(ctx, { gain: 0 }),
    echoSend: new GainNode(ctx, { gain: 0 }),
  };
  chain.input = chain.highpass;
  chain.highpass.connect(chain.low).connect(chain.mid).connect(chain.high).connect(chain.comp).connect(chain.gain).connect(chain.pan).connect(destination);
  if (buses) {
    chain.pan.connect(chain.reverbSend).connect(buses.reverbIn);
    chain.pan.connect(chain.echoSend).connect(buses.echoIn);
  }
  applyTrackFx(chain, fx);
  return chain;
}

/** Sets the live parts of a track's FX (smoothly when `ctx` is given, i.e. while playing). */
export function applyTrackFx(chain: TrackChain, fx: TrackFx = DEFAULT_TRACK_FX, ctx?: BaseAudioContext): void {
  const set = (param: AudioParam, value: number) => {
    if (ctx) param.setTargetAtTime(value, ctx.currentTime, 0.02);
    else param.value = value;
  };
  set(chain.highpass.frequency, fx.highpassHz > 0 ? fx.highpassHz : 10); // 10 Hz = effectively off
  set(chain.low.gain, fx.eq.low);
  set(chain.mid.gain, fx.eq.mid);
  set(chain.high.gain, fx.eq.high);
  // Compressor amount 0..1: off (ratio 1) … threshold −30 dB, ratio 8.
  set(chain.comp.threshold, -6 - 24 * fx.compressor);
  set(chain.comp.ratio, 1 + 7 * fx.compressor);
  set(chain.reverbSend.gain, fx.reverbSend);
  set(chain.echoSend.gain, fx.echoSend);
}

export function disconnectChain(chain: TrackChain): void {
  for (const node of [chain.highpass, chain.low, chain.mid, chain.high, chain.comp, chain.gain, chain.pan, chain.reverbSend, chain.echoSend]) {
    node.disconnect();
  }
}

/** Impulse responses are deterministic, so they're generated once per preset/tone/rate. */
const irCache = new Map<string, [Float32Array, Float32Array]>();

function impulseBuffer(ctx: BaseAudioContext, fx: SongFx['reverb']): AudioBuffer {
  const key = `${fx.preset}|${fx.tone}|${ctx.sampleRate}`;
  let ir = irCache.get(key);
  if (!ir) {
    ir = generateImpulse(REVERB_PRESETS[fx.preset].shape, ctx.sampleRate, fx.tone);
    irCache.set(key, ir);
  }
  const buffer = ctx.createBuffer(2, ir[0].length, ctx.sampleRate);
  buffer.copyToChannel(ir[0] as Float32Array<ArrayBuffer>, 0);
  buffer.copyToChannel(ir[1] as Float32Array<ArrayBuffer>, 1);
  return buffer;
}

/** The song's shared reverb and echo buses. */
export class FxBuses implements BusInputs {
  readonly reverbIn: GainNode;
  readonly echoIn: GainNode;
  private readonly convolver: ConvolverNode;
  private readonly reverbReturn: GainNode;
  private readonly delay: DelayNode;
  private readonly feedback: GainNode;
  private readonly tone: BiquadFilterNode;
  private readonly echoReturn: GainNode;
  private irKey = '';

  constructor(
    private readonly ctx: BaseAudioContext,
    destination: AudioNode,
    fx: SongFx,
    bpm: number | null | undefined,
  ) {
    this.reverbIn = new GainNode(ctx);
    this.convolver = new ConvolverNode(ctx, { disableNormalization: true });
    this.reverbReturn = new GainNode(ctx);
    this.reverbIn.connect(this.convolver).connect(this.reverbReturn).connect(destination);

    this.echoIn = new GainNode(ctx);
    this.delay = new DelayNode(ctx, { maxDelayTime: 2 });
    this.tone = new BiquadFilterNode(ctx, { type: 'lowpass', Q: 0.5 });
    this.feedback = new GainNode(ctx);
    this.echoReturn = new GainNode(ctx);
    this.echoIn.connect(this.delay).connect(this.tone).connect(this.echoReturn).connect(destination);
    this.tone.connect(this.feedback).connect(this.delay); // feedback loop (allowed: it contains a delay)
    this.apply(fx, bpm);
  }

  apply(fx: SongFx, bpm: number | null | undefined, live = false): void {
    const set = (param: AudioParam, value: number) => {
      if (live) param.setTargetAtTime(value, this.ctx.currentTime, 0.03);
      else param.value = value;
    };
    const key = `${fx.reverb.preset}|${fx.reverb.tone}`;
    if (key !== this.irKey) {
      this.convolver.buffer = impulseBuffer(this.ctx, fx.reverb);
      this.irKey = key;
    }
    set(this.reverbReturn.gain, fx.reverb.level);
    set(this.delay.delayTime, echoSeconds(fx.echo.division, bpm));
    set(this.tone.frequency, 1500 + fx.echo.tone * 8000);
    set(this.feedback.gain, Math.min(0.85, fx.echo.feedback));
    set(this.echoReturn.gain, fx.echo.level);
  }
}

/** How long reverb/echo keep sounding after the music stops (for export tails), seconds. */
export function fxTail(fx: SongFx, bpm: number | null | undefined, anySend: boolean): number {
  if (!anySend) return 0;
  const reverb = REVERB_PRESETS[fx.reverb.preset].shape.decay;
  // Echo falls 60 dB after log(0.001)/log(feedback) repeats.
  const fb = Math.max(0.05, Math.min(0.85, fx.echo.feedback));
  const echo = echoSeconds(fx.echo.division, bpm) * Math.min(20, Math.log(0.001) / Math.log(fb));
  return Math.min(8, Math.max(reverb, echo));
}

export function clampPan(pan: number): number {
  return Math.max(-1, Math.min(1, pan));
}

/** Ceiling of the live limiter's soft clipper (and the export limiter). */
export const LIMIT_CEILING = 0.98;

/**
 * Soft-clip curve: linear up to 0.9, then bending smoothly into `LIMIT_CEILING`. WaveShaper clamps
 * input beyond ±1 to the curve's ends, so the output can never exceed the ceiling.
 */
function softClipCurve(points = 2048): Float32Array<ArrayBuffer> {
  const curve = new Float32Array(points);
  const knee = 0.9;
  for (let i = 0; i < points; i++) {
    const x = (i / (points - 1)) * 2 - 1;
    const a = Math.abs(x);
    const y = a <= knee ? a : knee + (LIMIT_CEILING - knee) * Math.tanh((a - knee) / (LIMIT_CEILING - knee));
    curve[i] = Math.sign(x) * Math.min(LIMIT_CEILING, y);
  }
  return curve;
}

export class MasterChain {
  readonly input: GainNode;
  readonly output: GainNode;
  private readonly limiter: DynamicsCompressorNode;
  private limiterOn: boolean | null = null;

  constructor(ctx: BaseAudioContext, settings: MasterSettings) {
    this.input = new GainNode(ctx, { gain: settings.gain });
    this.output = new GainNode(ctx);
    // Live limiting: a fast compressor does most of the work; the soft clipper after it catches
    // the transients it lets through (it has no look-ahead), so nothing passes the ceiling.
    // Exports additionally run the look-ahead limiter on the rendered mix (mixdown.ts).
    this.limiter = new DynamicsCompressorNode(ctx, { threshold: -3, knee: 0, ratio: 20, attack: 0.001, release: 0.1 });
    const clip = new WaveShaperNode(ctx, { curve: softClipCurve(), oversample: '2x' });
    this.limiter.connect(clip).connect(this.output);
    this.setLimiter(settings.limiter);
  }

  setLimiter(on: boolean): void {
    if (on === this.limiterOn) return;
    this.input.disconnect();
    this.input.connect(on ? this.limiter : this.output);
    this.limiterOn = on;
  }

  apply(settings: MasterSettings, ctx?: BaseAudioContext): void {
    if (ctx) this.input.gain.setTargetAtTime(settings.gain, ctx.currentTime, 0.015);
    else this.input.gain.value = settings.gain;
    this.setLimiter(settings.limiter);
  }
}


const latencyCache = new Map<number, Promise<{ limiter: number; plain: number }>>();

/**
 * How late the mix chain plays a sound, seconds, with the master limiter on and off: the
 * compressors' look-ahead and the clipper's oversampling filters. Measured once per sample rate by
 * rendering an impulse through a track chain and the master offline, so it is exact for this
 * browser. Sounds that skip the chain (the click) are delayed by it, and takes recorded over the song
 * are placed with it (the singer hears the song this much later than the transport says).
 */
export function measureChainLatency(sampleRate: number): Promise<{ limiter: number; plain: number }> {
  let cached = latencyCache.get(sampleRate);
  if (!cached) {
    const measure = async (limiter: boolean) => {
      const ctx = new OfflineAudioContext(1, Math.round(sampleRate * 0.1), sampleRate);
      const impulse = ctx.createBuffer(1, 1, sampleRate);
      impulse.getChannelData(0)[0] = 0.25;
      const master = new MasterChain(ctx, { gain: 1, limiter });
      master.output.connect(ctx.destination);
      const source = new AudioBufferSourceNode(ctx, { buffer: impulse });
      source.connect(createTrackChain(ctx, 1, 0, master.input).input);
      source.start(0);
      const out = (await ctx.startRendering()).getChannelData(0);
      let peak = 0;
      for (let i = 1; i < out.length; i++) if (Math.abs(out[i]) > Math.abs(out[peak])) peak = i;
      return peak / sampleRate;
    };
    cached = Promise.all([measure(true), measure(false)]).then(([limiter, plain]) => ({ limiter, plain }));
    latencyCache.set(sampleRate, cached);
  }
  return cached;
}
