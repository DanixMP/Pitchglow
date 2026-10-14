// Offline mixdown: renders the same track specs the MixPlayer plays into one stereo buffer, using an
// OfflineAudioContext (so tracks recorded at different sample rates are resampled for free).

import type { MixTrackSpec } from './mix-player';

export async function renderMix(
  specs: readonly MixTrackSpec[],
  sampleRate: number,
): Promise<{ channels: Float32Array[]; sampleRate: number }> {
  const lengthOf = (s: MixTrackSpec) => (s.buffer ? s.buffer.duration : s.samples.length / s.sampleRate);
  const duration = specs.reduce((m, s) => Math.max(m, s.offset + lengthOf(s)), 0);
  const length = Math.max(1, Math.ceil(duration * sampleRate));
  const ctx = new OfflineAudioContext({ numberOfChannels: 2, length, sampleRate });

  // Mild safety limiter on the master so a hot mix doesn't clip (Phase 10 adds the real master strip).
  const limiter = new DynamicsCompressorNode(ctx, { threshold: -1, knee: 0, ratio: 20, attack: 0.002, release: 0.08 });
  limiter.connect(ctx.destination);

  for (const spec of specs) {
    if (spec.gain === 0 || lengthOf(spec) === 0) continue;
    let buffer = spec.buffer;
    if (!buffer) {
      buffer = ctx.createBuffer(1, spec.samples.length, spec.sampleRate);
      buffer.copyToChannel(spec.samples as Float32Array<ArrayBuffer>, 0);
    }
    const source = new AudioBufferSourceNode(ctx, { buffer });
    const gain = new GainNode(ctx, { gain: spec.gain });
    source.connect(gain).connect(limiter);
    // A negative offset (take started before the song, e.g. a count-in) skips the take's head.
    source.start(Math.max(0, spec.offset), Math.max(0, -spec.offset));
  }
  const rendered = await ctx.startRendering();
  return { channels: [rendered.getChannelData(0), rendered.getChannelData(1)], sampleRate };
}
