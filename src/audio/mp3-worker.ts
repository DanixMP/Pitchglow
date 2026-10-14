// MP3 encoding off the main thread. LAME (via @breezystack/lamejs, LGPL-3.0) is used unmodified and
// only loaded into this worker's own chunk; see THIRD_PARTY_NOTICES.md.

import { Mp3Encoder } from '@breezystack/lamejs';

export interface Mp3Request {
  channels: Float32Array[];
  sampleRate: number;
  kbps: number;
}

export type Mp3Response = { ok: true; chunks: Uint8Array[] } | { ok: false; error: string };

/** Samples per encodeBuffer call (a multiple of the 1152-sample MP3 frame). */
const BLOCK = 1152 * 10;

self.onmessage = (e: MessageEvent<Mp3Request>) => {
  try {
    const { channels, sampleRate, kbps } = e.data;
    const encoder = new Mp3Encoder(channels.length, sampleRate, kbps);
    const chunks: Uint8Array[] = [];
    const length = channels[0]?.length ?? 0;
    const pcm = channels.map(() => new Int16Array(BLOCK));
    for (let start = 0; start < length; start += BLOCK) {
      const n = Math.min(BLOCK, length - start);
      channels.forEach((ch, c) => {
        for (let i = 0; i < n; i++) {
          const s = Math.max(-1, Math.min(1, ch[start + i]));
          pcm[c][i] = s < 0 ? s * 0x8000 : s * 0x7fff;
        }
      });
      const out = encoder.encodeBuffer(...(pcm.map((p) => p.subarray(0, n)) as [Int16Array, Int16Array?]));
      if (out.length) chunks.push(out.slice());
    }
    const tail = encoder.flush();
    if (tail.length) chunks.push(tail.slice());
    const res: Mp3Response = { ok: true, chunks };
    (self as unknown as Worker).postMessage(res, chunks.map((c) => c.buffer));
  } catch (err) {
    const res: Mp3Response = { ok: false, error: err instanceof Error ? err.message : String(err) };
    (self as unknown as Worker).postMessage(res);
  }
};
