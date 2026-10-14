// One AudioContext for the whole app: the mic capture and song playback share a clock, so recording
// over the beat can be aligned exactly (see sync.ts).

let ctx: AudioContext | null = null;

export function sharedContext(): AudioContext {
  if (!ctx || ctx.state === 'closed') ctx = new AudioContext({ latencyHint: 'interactive' });
  return ctx;
}

/** Seconds from scheduling a sound to hearing it (where the browser reports it). */
export function outputLatency(c: BaseAudioContext): number {
  const ac = c as AudioContext;
  return (ac.outputLatency || 0) + (ac.baseLatency || 0);
}
