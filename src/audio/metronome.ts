// Short click sounds scheduled on the audio clock (count-in, latency calibration).

export function scheduleClicks(ctx: BaseAudioContext, times: readonly number[], opts: { level?: number; accentFirst?: boolean } = {}): void {
  const level = opts.level ?? 0.5;
  times.forEach((t, i) => {
    const accent = opts.accentFirst !== false && i === 0;
    const osc = new OscillatorNode(ctx, { type: 'square', frequency: accent ? 1760 : 1320 });
    const env = new GainNode(ctx, { gain: 0 });
    env.gain.setValueAtTime(0, t);
    env.gain.linearRampToValueAtTime(level, t + 0.001);
    env.gain.exponentialRampToValueAtTime(0.0005, t + 0.05);
    osc.connect(env).connect(ctx.destination);
    osc.start(t);
    osc.stop(t + 0.06);
    osc.onended = () => env.disconnect();
  });
}
