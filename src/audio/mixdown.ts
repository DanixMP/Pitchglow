// Offline rendering with the same chain as live playback (chain.ts), via OfflineAudioContext (so
// tracks recorded at different sample rates are resampled for free).
// - renderMix: the whole song through the master (fader + limiter), stereo.
// - renderStems: each track alone, post-fader and post-pan, no master processing, all the same
//   length (song start to song end) so they line up in any DAW.

import { createTrackChain, MasterChain, type MasterSettings } from './chain';
import type { MixTrackSpec } from './mix-player';

export interface Rendered {
  channels: Float32Array[];
  sampleRate: number;
}

const lengthOf = (s: MixTrackSpec) => (s.buffer ? s.buffer.duration : s.samples.length / s.sampleRate);

export function songLength(specs: readonly MixTrackSpec[]): number {
  return specs.reduce((m, s) => Math.max(m, s.offset + lengthOf(s)), 0);
}

export async function renderMix(
  specs: readonly MixTrackSpec[],
  sampleRate: number,
  master: MasterSettings = { gain: 1, limiter: true },
  duration = songLength(specs),
): Promise<Rendered> {
  const length = Math.max(1, Math.ceil(duration * sampleRate));
  const ctx = new OfflineAudioContext({ numberOfChannels: 2, length, sampleRate });
  const chain = new MasterChain(ctx, master);
  chain.output.connect(ctx.destination);

  for (const spec of specs) {
    if (spec.gain === 0 || lengthOf(spec) === 0) continue;
    let buffer = spec.buffer;
    if (!buffer) {
      buffer = ctx.createBuffer(1, spec.samples.length, spec.sampleRate);
      buffer.copyToChannel(spec.samples as Float32Array<ArrayBuffer>, 0);
    }
    const source = new AudioBufferSourceNode(ctx, { buffer });
    const track = createTrackChain(ctx, spec.gain, spec.pan ?? 0, chain.input);
    source.connect(track.gain);
    // A negative offset (take started before the song, e.g. a count-in) skips the take's head.
    source.start(Math.max(0, spec.offset), Math.max(0, -spec.offset));
  }
  const rendered = await ctx.startRendering();
  return { channels: [rendered.getChannelData(0), rendered.getChannelData(1)], sampleRate };
}

/** One stereo render per audible track, each as long as the song. */
export async function renderStems(
  specs: readonly MixTrackSpec[],
  sampleRate: number,
): Promise<{ id: string; rendered: Rendered }[]> {
  const duration = songLength(specs);
  const out: { id: string; rendered: Rendered }[] = [];
  for (const spec of specs) {
    if (spec.gain === 0) continue; // muted / not soloed: not part of the mix
    out.push({ id: spec.id, rendered: await renderMix([spec], sampleRate, { gain: 1, limiter: false }, duration) });
  }
  return out;
}
