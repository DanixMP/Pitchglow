// 16-bit PCM WAV encoder (mono or multi-channel, interleaved).

export function encodeWav(samples: Float32Array, sampleRate: number): ArrayBuffer {
  return encodeWavChannels([samples], sampleRate);
}

export function encodeWavChannels(channels: readonly Float32Array[], sampleRate: number): ArrayBuffer {
  const numChannels = channels.length;
  const frames = channels[0]?.length ?? 0;
  const bytesPerSample = 2;
  const blockAlign = numChannels * bytesPerSample;
  const dataSize = frames * blockAlign;
  const buffer = new ArrayBuffer(44 + dataSize);
  const view = new DataView(buffer);

  const writeString = (offset: number, s: string) => {
    for (let i = 0; i < s.length; i++) view.setUint8(offset + i, s.charCodeAt(i));
  };

  writeString(0, 'RIFF');
  view.setUint32(4, 36 + dataSize, true);
  writeString(8, 'WAVE');
  writeString(12, 'fmt ');
  view.setUint32(16, 16, true); // fmt chunk size
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, numChannels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * blockAlign, true); // byte rate
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, 16, true); // bits per sample
  writeString(36, 'data');
  view.setUint32(40, dataSize, true);

  let offset = 44;
  for (let i = 0; i < frames; i++) {
    for (let c = 0; c < numChannels; c++, offset += 2) {
      const s = Math.max(-1, Math.min(1, channels[c][i]));
      view.setInt16(offset, s < 0 ? s * 0x8000 : s * 0x7fff, true);
    }
  }
  return buffer;
}

export function wavBlob(samples: Float32Array, sampleRate: number): Blob {
  return new Blob([encodeWav(samples, sampleRate)], { type: 'audio/wav' });
}

export function wavBlobChannels(channels: readonly Float32Array[], sampleRate: number): Blob {
  return new Blob([encodeWavChannels(channels, sampleRate)], { type: 'audio/wav' });
}

/** 32-bit float WAV (lossless): how takes are stored inside song files. */
export function encodeWavFloat32(samples: Float32Array, sampleRate: number): Uint8Array<ArrayBuffer> {
  const dataSize = samples.length * 4;
  const out = new Uint8Array(44 + dataSize);
  const view = new DataView(out.buffer);
  const writeString = (offset: number, s: string) => {
    for (let i = 0; i < s.length; i++) view.setUint8(offset + i, s.charCodeAt(i));
  };
  writeString(0, 'RIFF');
  view.setUint32(4, 36 + dataSize, true);
  writeString(8, 'WAVE');
  writeString(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 3, true); // IEEE float
  view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 4, true);
  view.setUint16(32, 4, true);
  view.setUint16(34, 32, true);
  writeString(36, 'data');
  view.setUint32(40, dataSize, true);
  for (let i = 0; i < samples.length; i++) view.setFloat32(44 + i * 4, samples[i], true);
  return out;
}

/** Reads a mono or multi-channel WAV (16-bit PCM or 32-bit float) without resampling. */
export function decodeWav(bytes: Uint8Array): { channels: Float32Array[]; sampleRate: number } {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const tag = (o: number) => String.fromCharCode(bytes[o], bytes[o + 1], bytes[o + 2], bytes[o + 3]);
  if (bytes.length < 12 || tag(0) !== 'RIFF' || tag(8) !== 'WAVE') throw new Error('Not a WAV file.');
  let format = 0;
  let numChannels = 0;
  let sampleRate = 0;
  let bits = 0;
  let p = 12;
  while (p + 8 <= bytes.length) {
    const id = tag(p);
    const size = view.getUint32(p + 4, true);
    const body = p + 8;
    if (id === 'fmt ') {
      format = view.getUint16(body, true);
      numChannels = view.getUint16(body + 2, true);
      sampleRate = view.getUint32(body + 4, true);
      bits = view.getUint16(body + 14, true);
    } else if (id === 'data') {
      const float = format === 3 && bits === 32;
      if (!float && !(format === 1 && bits === 16)) throw new Error('Unsupported WAV format.');
      const bytesPer = bits / 8;
      const frames = Math.floor(Math.min(size, bytes.length - body) / (bytesPer * numChannels));
      const channels = Array.from({ length: numChannels }, () => new Float32Array(frames));
      for (let i = 0, o = body; i < frames; i++) {
        for (let c = 0; c < numChannels; c++, o += bytesPer) {
          channels[c][i] = float ? view.getFloat32(o, true) : view.getInt16(o, true) / 0x8000;
        }
      }
      return { channels, sampleRate };
    }
    p = body + size + (size & 1);
  }
  throw new Error('The WAV file has no audio.');
}
