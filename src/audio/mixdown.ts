// Offline rendering with the same graph as live playback (chain.ts + the voice-engine worklet), via
// OfflineAudioContext, so an export sounds exactly like what was heard.
// - renderMix: the whole song through the master (fader + limiter), stereo.
// - renderStems: each track alone, post-fader and post-pan, no master processing, all the same
//   length (song start to song end) so they line up in any DAW.

import { limit, limitLinked } from '../dsp/limiter';
import { CLEANUP_OFF, type CleanupAnalysis, type CleanupSettings } from '../dsp/cleanup';
import type { VoicePlans } from '../dsp/voice-engine';
import { DEFAULT_SONG_FX, type SongFx } from '../project/fx';
import { createTrackChain, FxBuses, fxTail, LIMIT_CEILING, MasterChain, type MasterSettings } from './chain';
import { createEngine, loadEngine, type MixTrackSpec } from './mix-player';

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
  if (specs.some((s) => !s.buffer)) await loadEngine(ctx);

  for (const spec of specs) {
    if (spec.gain === 0 || lengthOf(spec) === 0) continue;
    const track = createTrackChain(ctx, spec.gain, spec.pan ?? 0, chain.input, spec.fx, buses);
    if (spec.buffer) {
      const source = new AudioBufferSourceNode(ctx, { buffer: spec.buffer });
      source.connect(track.input);
      // A negative offset (take started before the song, e.g. a count-in) skips the take's head.
      source.start(Math.max(0, spec.offset), Math.max(0, -spec.offset));
    } else {
      // Vocals: the same voice engine as playback, playing the song from 0 (offsets handled inside).
      createEngine(ctx, spec, { startFrame: 0, from: 0, loop: null }).connect(track.input);
    }
  }
  const rendered = await ctx.startRendering();
  const channels = [rendered.getChannelData(0), rendered.getChannelData(1)];
  // Exports get a true look-ahead limiter on top (linked L/R): a guaranteed ceiling, cleanly.
  return { channels: master.limiter ? limitLinked(channels, sampleRate, { ceiling: LIMIT_CEILING }) : channels, sampleRate };
}

/**
 * One take through the voice engine alone (mono), for exporting a processed take. Peak-limited, as
 * harmonies can stack above full scale.
 */
export async function renderVoice(
  samples: Float32Array,
  sampleRate: number,
  plans: VoicePlans | null,
  cleanup: CleanupAnalysis | null = null,
  cleanupSettings: CleanupSettings = CLEANUP_OFF,
): Promise<Float32Array> {
  const ctx = new OfflineAudioContext({ numberOfChannels: 1, length: Math.max(1, samples.length), sampleRate });
  await loadEngine(ctx);
  const spec = { id: 'take', samples, sampleRate, plans, cleanup, cleanupSettings, gain: 1, offset: 0 };
  createEngine(ctx, spec, { startFrame: 0, from: 0, loop: null }).connect(ctx.destination);
  const out = (await ctx.startRendering()).getChannelData(0);
  return limit(out, sampleRate, { ceiling: LIMIT_CEILING });
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
