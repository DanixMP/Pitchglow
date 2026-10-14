// Offline rendering with the same chain as live playback (chain.ts), via OfflineAudioContext (so
// tracks recorded at different sample rates are resampled for free).
// - renderMix: the whole song through the master (fader + limiter), stereo.
// - renderStems: each track alone, post-fader and post-pan, no master processing, all the same
//   length (song start to song end) so they line up in any DAW.

import { limitLinked } from '../dsp/limiter';
import { DEFAULT_SONG_FX, type SongFx } from '../project/fx';
import { createTrackChain, FxBuses, fxTail, LIMIT_CEILING, MasterChain, type MasterSettings } from './chain';
import type { MixTrackSpec } from './mix-player';

export interface Rendered {
  channels: Float32Array[];
  sampleRate: number;
}

const lengthOf = (s: MixTrackSpec) => (s.buffer ? s.buffer.duration : s.samples.length / s.sampleRate);

export function songLength(specs: readonly MixTrackSpec[]): number {
  return specs.reduce((m, s) => Math.max(m, s.offset + lengthOf(s)), 0);
}

export interface SongFxContext {
  fx: SongFx;
  bpm: number | null;
}

/** Song length plus room for reverb/echo to ring out, if any track sends to them. */
export function exportLength(specs: readonly MixTrackSpec[], song: SongFxContext = { fx: DEFAULT_SONG_FX, bpm: null }): number {
  const anySend = specs.some((s) => s.gain > 0 && ((s.fx?.reverbSend ?? 0) > 0 || (s.fx?.echoSend ?? 0) > 0));
  return songLength(specs) + fxTail(song.fx, song.bpm, anySend);
}

export async function renderMix(
  specs: readonly MixTrackSpec[],
  sampleRate: number,
  master: MasterSettings = { gain: 1, limiter: true },
  duration = exportLength(specs),
  song: SongFxContext = { fx: DEFAULT_SONG_FX, bpm: null },
): Promise<Rendered> {
  const length = Math.max(1, Math.ceil(duration * sampleRate));
  const ctx = new OfflineAudioContext({ numberOfChannels: 2, length, sampleRate });
  // Master fader only; limiting (when on) is done afterwards by the look-ahead limiter, which is
  // cleaner than the live compressor + soft clipper.
  const chain = new MasterChain(ctx, { gain: master.gain, limiter: false });
  chain.output.connect(ctx.destination);
  const buses = new FxBuses(ctx, chain.input, song.fx, song.bpm);

  for (const spec of specs) {
    if (spec.gain === 0 || lengthOf(spec) === 0) continue;
    let buffer = spec.buffer;
    if (!buffer) {
      buffer = ctx.createBuffer(1, spec.samples.length, spec.sampleRate);
      buffer.copyToChannel(spec.samples as Float32Array<ArrayBuffer>, 0);
    }
    const source = new AudioBufferSourceNode(ctx, { buffer });
    const track = createTrackChain(ctx, spec.gain, spec.pan ?? 0, chain.input, spec.fx, buses);
    source.connect(track.input);
    // A negative offset (take started before the song, e.g. a count-in) skips the take's head.
    source.start(Math.max(0, spec.offset), Math.max(0, -spec.offset));
  }
  const rendered = await ctx.startRendering();
  const channels = [rendered.getChannelData(0), rendered.getChannelData(1)];
  // Exports get a true look-ahead limiter on top (linked L/R): a guaranteed ceiling, cleanly.
  return { channels: master.limiter ? limitLinked(channels, sampleRate, { ceiling: LIMIT_CEILING }) : channels, sampleRate };
}

/** One stereo render per audible track (with its own reverb/echo), each as long as the mix. */
export async function renderStems(
  specs: readonly MixTrackSpec[],
  sampleRate: number,
  song: SongFxContext = { fx: DEFAULT_SONG_FX, bpm: null },
): Promise<{ id: string; rendered: Rendered }[]> {
  const duration = exportLength(specs, song);
  const out: { id: string; rendered: Rendered }[] = [];
  for (const spec of specs) {
    if (spec.gain === 0) continue; // muted / not soloed: not part of the mix
    out.push({ id: spec.id, rendered: await renderMix([spec], sampleRate, { gain: 1, limiter: false }, duration, song) });
  }
  return out;
}
