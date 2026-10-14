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

export class MasterChain {
  readonly input: GainNode;
  readonly output: GainNode;
  private readonly limiter: DynamicsCompressorNode;
  private limiterOn: boolean | null = null;

  constructor(ctx: BaseAudioContext, settings: MasterSettings) {
    this.input = new GainNode(ctx, { gain: settings.gain });
    this.output = new GainNode(ctx);
    this.limiter = new DynamicsCompressorNode(ctx, { threshold: -1, knee: 0, ratio: 20, attack: 0.002, release: 0.1 });
    this.limiter.connect(this.output);
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
