// The mix signal chain, built the same way for live playback (MixPlayer) and export (mixdown), so
// what you hear is what you export:
//   track:  source -> Gain (fader/mute/solo) -> StereoPanner -> master
//   master: Gain (master fader) -> [limiter] -> output

export interface MasterSettings {
  /** Linear master gain. */
  gain: number;
  /** Brick-wall-ish limiter at −1 dBFS so the mix doesn't clip. */
  limiter: boolean;
}

export interface TrackChain {
  gain: GainNode;
  pan: StereoPannerNode;
}

export function createTrackChain(ctx: BaseAudioContext, gain: number, pan: number, destination: AudioNode): TrackChain {
  const g = new GainNode(ctx, { gain });
  const p = new StereoPannerNode(ctx, { pan: clampPan(pan) });
  g.connect(p).connect(destination);
  return { gain: g, pan: p };
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

export function clampPan(pan: number): number {
  return Math.max(-1, Math.min(1, pan));
}
