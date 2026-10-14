import 'fake-indexeddb/auto';
import { describe, expect, it } from 'vitest';
import type { PitchFrame } from '../src/audio/pitch-tracker';
import { SampleBuffer } from '../src/audio/sample-buffer';
import { encodeWav } from '../src/audio/wav';
import { packFrames, unpackFrames } from '../src/storage/pitch-track';
import { RecordingStore, type RecordingMeta } from '../src/storage/recording-store';

describe('SampleBuffer', () => {
  it('joins blocks in order', () => {
    const b = new SampleBuffer();
    b.push(new Float32Array([1, 2]));
    b.push(new Float32Array([3]));
    b.push(new Float32Array([4, 5, 6]));
    expect(b.length).toBe(6);
    expect([...b.toFloat32()]).toEqual([1, 2, 3, 4, 5, 6]);
  });
});

describe('encodeWav', () => {
  it('writes a valid 16-bit mono PCM header and clamps samples', () => {
    const buf = encodeWav(new Float32Array([0, 1, -1, 2, -2, 0.5]), 48000);
    const v = new DataView(buf);
    const str = (o: number, n: number) => String.fromCharCode(...new Uint8Array(buf, o, n));
    expect(buf.byteLength).toBe(44 + 6 * 2);
    expect(str(0, 4)).toBe('RIFF');
    expect(v.getUint32(4, true)).toBe(buf.byteLength - 8);
    expect(str(8, 4)).toBe('WAVE');
    expect(v.getUint16(20, true)).toBe(1); // PCM
    expect(v.getUint16(22, true)).toBe(1); // mono
    expect(v.getUint32(24, true)).toBe(48000);
    expect(v.getUint16(34, true)).toBe(16);
    expect(str(36, 4)).toBe('data');
    expect(v.getUint32(40, true)).toBe(12);
    const samples = [0, 1, 2, 3, 4, 5].map((i) => v.getInt16(44 + i * 2, true));
    expect(samples).toEqual([0, 32767, -32768, 32767, -32768, 16383]);
  });
});

const frames: PitchFrame[] = [
  { time: 0.01, freq: 130.8, midi: 48.01, clarity: 0.95, rms: 0.1 },
  { time: 0.02, freq: null, midi: null, clarity: 0.2, rms: 0.001 },
  { time: 0.03, freq: 220, midi: 57, clarity: 0.9, rms: 0.2 },
];

describe('pitch track packing', () => {
  it('round-trips frames, including unvoiced ones', () => {
    const back = unpackFrames(packFrames(frames));
    expect(back).toHaveLength(3);
    expect(back[1]).toMatchObject({ freq: null, midi: null });
    expect(back[0].time).toBe(0.01);
    expect(back[0].midi).toBeCloseTo(48.01, 4);
    expect(back[2].freq).toBeCloseTo(220, 4);
  });
});

describe('RecordingStore', () => {
  const meta = (id: string, createdAt: number): RecordingMeta => ({
    id,
    name: `Recording ${id}`,
    createdAt,
    duration: 1,
    sampleRate: 48000,
  });

  it('saves, lists newest first, loads, renames and deletes', async () => {
    const store = await RecordingStore.open(`test-${Math.random()}`);
    const samples = new Float32Array([0.1, -0.2, 0.3]);
    await store.save(meta('a', 1000), { id: 'a', samples, pitch: packFrames(frames) });
    await store.save(meta('b', 2000), { id: 'b', samples: new Float32Array(4), pitch: packFrames([]) });

    expect((await store.list()).map((m) => m.id)).toEqual(['b', 'a']);

    const loaded = await store.load('a');
    expect(loaded?.samples).toBeInstanceOf(Float32Array);
    expect([...loaded!.samples]).toEqual([...samples]);
    expect(unpackFrames(loaded!.pitch)[2].midi).toBe(57);

    await store.rename('a', 'Sunday take');
    expect((await store.list()).find((m) => m.id === 'a')?.name).toBe('Sunday take');

    await store.delete('b');
    expect((await store.list()).map((m) => m.id)).toEqual(['a']);
    expect(await store.load('b')).toBeUndefined();
    store.close();
  });
});
