// Audio file export: WAV (16-bit) right here, MP3 in a short-lived worker (mp3-worker.ts).

import { resample } from '../dsp/vocoder';
import { wavBlobChannels } from './wav';
import type { Mp3Request, Mp3Response } from './mp3-worker';
import Mp3Worker from './mp3-worker.ts?worker';

export type ExportFormat = 'wav' | 'mp3';

/** Sample rates MPEG-1/2 layer III can carry. */
const MP3_RATES = [8000, 11025, 12000, 16000, 22050, 24000, 32000, 44100, 48000];

/** Bitrate: 192 kbps stereo, 128 kbps mono. */
export function mp3Kbps(channels: number): number {
  return channels > 1 ? 192 : 128;
}

/** The rate an MP3 is written at: the source rate if MP3 supports it, else 48 kHz. */
export function mp3Rate(sampleRate: number): number {
  return MP3_RATES.includes(sampleRate) ? sampleRate : 48000;
}

export async function encodeAudio(channels: readonly Float32Array[], sampleRate: number, format: ExportFormat): Promise<Blob> {
  if (format === 'wav') return wavBlobChannels(channels, sampleRate);
  const rate = mp3Rate(sampleRate);
  const input =
    rate === sampleRate
      ? channels.map((c) => c.slice())
      : channels.map((c) => resample(c, sampleRate / rate, Math.floor((c.length * rate) / sampleRate)));
  const worker = new Mp3Worker();
  try {
    const res = await new Promise<Mp3Response>((resolve, reject) => {
      worker.onmessage = (e: MessageEvent<Mp3Response>) => resolve(e.data);
      worker.onerror = (e) => reject(new Error(e.message || 'MP3 encoder failed'));
      const req: Mp3Request = { channels: input, sampleRate: rate, kbps: mp3Kbps(input.length) };
      worker.postMessage(req, input.map((c) => c.buffer));
    });
    if (!res.ok) throw new Error(res.error);
    return new Blob(res.chunks as Uint8Array<ArrayBuffer>[], { type: 'audio/mpeg' });
  } finally {
    worker.terminate();
  }
}
