import { describe, expect, it } from 'vitest';
import { Mp3Encoder } from '@breezystack/lamejs';
import { mp3Kbps, mp3Rate } from '../src/audio/encode';
import { decodeWav, encodeWav, encodeWavFloat32 } from '../src/audio/wav';
import { createZip, readZip } from '../src/audio/zip';
import {
  activeLoop,
  createInstrumentalTrack,
  createProject,
  createVocalTrack,
  defaultLoop,
  loopPosition,
  normalizeLoop,
  type Project,
} from '../src/project/model';
import { isSongFile, packSong, prepareImport, unpackSong, type SongPackage } from '../src/project/package';
import { deserializePitch, packFrames, serializePitch } from '../src/storage/pitch-track';
import { DEFAULT_TUNING } from '../src/storage/settings';
import { sine } from './signals';

describe('readZip', () => {
  it('reads back what createZip wrote', () => {
    const a = new Uint8Array([1, 2, 3]);
    const b = new TextEncoder().encode('héllo');
    const files = readZip(createZip([{ name: 'a.bin', data: a }, { name: 'dir/b.txt', data: b }]));
    expect([...files.keys()]).toEqual(['a.bin', 'dir/b.txt']);
    expect([...files.get('a.bin')!]).toEqual([1, 2, 3]);
    expect(new TextDecoder().decode(files.get('dir/b.txt'))).toBe('héllo');
  });

  it('rejects non-zips and damaged data', () => {
    expect(() => readZip(new Uint8Array(100))).toThrow(/Not a zip/);
    const zip = createZip([{ name: 'x', data: new Uint8Array([9, 9, 9, 9]) }]);
    zip[31 + 1] ^= 0xff; // flip a data byte (local header 30 + name 1)
    expect(() => readZip(zip)).toThrow(/damaged/);
  });
});

describe('WAV codecs', () => {
  it('float WAV round-trips exactly', () => {
    const x = sine(220, 44100, 0.1, 0.9);
    x[5] = 1.5; // floats keep overs
    const back = decodeWav(encodeWavFloat32(x, 44100));
    expect(back.sampleRate).toBe(44100);
    expect(back.channels).toHaveLength(1);
    expect(back.channels[0]).toEqual(x);
  });

  it('reads 16-bit PCM within one LSB', () => {
    const x = sine(440, 48000, 0.05, 0.5);
    const back = decodeWav(new Uint8Array(encodeWav(x, 48000)));
    expect(back.sampleRate).toBe(48000);
    let err = 0;
    for (let i = 0; i < x.length; i++) err = Math.max(err, Math.abs(back.channels[0][i] - x[i]));
    expect(err).toBeLessThan(1 / 16384);
  });
});

describe('pitch track bytes', () => {
  it('round-trips, keeping NaN for unvoiced frames', () => {
    const packed = packFrames([
      { time: 0.01, freq: 220, midi: 57, clarity: 0.9, rms: 0.1 },
      { time: 0.02, freq: null, midi: null, clarity: 0.1, rms: 0.01 },
    ]);
    const back = deserializePitch(serializePitch(packed));
    expect([...back.time]).toEqual([0.01, 0.02]);
    expect(back.freq[0]).toBe(220);
    expect(Number.isNaN(back.midi[1])).toBe(true);
    expect(back.clarity[1]).toBeCloseTo(0.1, 6);
    expect(() => deserializePitch(new Uint8Array(7))).toThrow(/damaged/);
  });
});

function sampleSong(): SongPackage {
  const meta = { id: 'take-1', name: 'Recording 1', createdAt: 1, duration: 0.5, sampleRate: 16000 };
  const samples = sine(200, 16000, 0.5, 0.4);
  const pitch = packFrames([{ time: 0, freq: 200, midi: 55.35, clarity: 0.95, rms: 0.28 }]);
  const asset = { id: 'asset-1', name: 'Beat', type: 'audio/mpeg', createdAt: 2, data: new Uint8Array([0xff, 0xfb, 1, 2, 3]).buffer };
  let project: Project = createProject('My song', 3, 'song-1');
  project = {
    ...project,
    keyShift: 2,
    loop: { start: 1, end: 3, on: true },
    tracks: [createInstrumentalTrack(asset), createVocalTrack(meta, DEFAULT_TUNING, { denoise: true, denoiseDb: 12 }, [])],
  };
  return { project, takes: [{ meta, samples, pitch }], assets: [asset] };
}

describe('song files', () => {
  it('round-trips a song with its takes and instrumental', () => {
    const song = sampleSong();
    const back = unpackSong(packSong(song));
    expect(back.project).toEqual(song.project);
    expect(back.takes[0].meta).toEqual(song.takes[0].meta);
    expect(back.takes[0].samples).toEqual(song.takes[0].samples);
    expect(back.takes[0].pitch.midi[0]).toBeCloseTo(55.35, 4);
    expect(new Uint8Array(back.assets[0].data)).toEqual(new Uint8Array(song.assets[0].data));
    expect(back.assets[0].type).toBe('audio/mpeg');
  });

  it('names files readably inside the zip', () => {
    const names = [...readZip(packSong(sampleSong())).keys()];
    expect(names).toEqual(['song.json', 'takes/take-1.wav', 'takes/take-1.pitch', 'assets/asset-1.mp3']);
  });

  it('rejects other files and incomplete songs', () => {
    expect(() => unpackSong(new Uint8Array([1, 2, 3]))).toThrow(/isn’t a song file/);
    expect(() => unpackSong(createZip([{ name: 'song.json', data: new TextEncoder().encode('{"format":"x"}') }]))).toThrow(/isn’t a song file/);
    const files = readZip(packSong(sampleSong()));
    files.delete('takes/take-1.pitch');
    const partial = createZip([...files].map(([name, data]) => ({ name, data })));
    expect(() => unpackSong(partial)).toThrow(/missing takes\/take-1.pitch/);
  });

  it('imports under a new id and a free name, skipping takes and files already here', () => {
    const song = sampleSong();
    const add = prepareImport(song, { projectNames: ['My song', 'My song (2)'], takeIds: new Set(['take-1']), assetIds: new Set() }, 99);
    expect(add.project.id).not.toBe('song-1');
    expect(add.project.name).toBe('My song (3)');
    expect(add.project.updatedAt).toBe(99);
    expect(add.project.tracks).toEqual(song.project.tracks);
    expect(add.takes).toEqual([]);
    expect(add.assets).toHaveLength(1);
  });

  it('recognises song files by extension', () => {
    expect(isSongFile('Song 1.recsong')).toBe(true);
    expect(isSongFile('beat.MP3')).toBe(false);
  });
});

describe('loop region', () => {
  const loop = { start: 2, end: 4 };

  it('wraps playback inside the loop', () => {
    expect(loopPosition(2.5, 1, loop)).toBeCloseTo(3.5);
    expect(loopPosition(2.5, 1.5, loop)).toBeCloseTo(2); // reached the end: back to the start
    expect(loopPosition(3, 4.25, loop)).toBeCloseTo(3.25); // 2 full passes later
    expect(loopPosition(0, 5, loop)).toBeCloseTo(3); // from before the loop: plays in, then loops
    expect(loopPosition(5, 3, loop)).toBe(8); // starting after the loop plays straight on
    expect(loopPosition(1, 10, null)).toBe(11);
  });

  it('normalises drawn regions: ordered, snapped to beats, clamped, minimum length', () => {
    expect(normalizeLoop(3.1, 1.2, 120, 10)).toEqual({ start: 1, end: 3 }); // 0.5 s beats
    expect(normalizeLoop(1.23, 2.34, null, 10)).toEqual({ start: 1.2, end: 2.3 }); // 0.1 s without tempo
    expect(normalizeLoop(-1, 20, null, 8)).toEqual({ start: 0, end: 8 });
    expect(normalizeLoop(1, 1.1, null, 8)).toBeNull();
    expect(normalizeLoop(1.2345, 2.3456, 120, 10, true)).toEqual({ start: 1.235, end: 2.346 }); // free (Alt)
  });

  it('makes a first loop of two bars around the playhead', () => {
    expect(defaultLoop(5, 120, 60)).toEqual({ start: 4, end: 8 }); // bars are 2 s at 120 BPM
    expect(defaultLoop(10.6, null, 60)).toEqual({ start: 10, end: 14 });
    expect(defaultLoop(58, 120, 60)).toEqual({ start: 56, end: 60 }); // kept inside the song
  });

  it('only follows a loop that is on and inside the song', () => {
    const p = createProject('x');
    expect(activeLoop(p, 10)).toBeNull();
    expect(activeLoop({ ...p, loop: { start: 2, end: 4, on: false } }, 10)).toBeNull();
    expect(activeLoop({ ...p, loop: { start: 2, end: 14, on: true } }, 10)).toEqual({ start: 2, end: 10 });
    expect(activeLoop({ ...p, loop: { start: 9.9, end: 14, on: true } }, 10)).toBeNull();
  });
});

describe('MP3 export', () => {
  it('picks a rate and bitrate MP3 supports', () => {
    expect(mp3Rate(48000)).toBe(48000);
    expect(mp3Rate(44100)).toBe(44100);
    expect(mp3Rate(96000)).toBe(48000);
    expect(mp3Kbps(2)).toBe(192);
    expect(mp3Kbps(1)).toBe(128);
  });

  it('LAME encodes stereo PCM into MP3 frames of the expected size', () => {
    const rate = 44100;
    const enc = new Mp3Encoder(2, rate, 192);
    const x = sine(440, rate, 1, 0.5);
    const pcm = Int16Array.from(x, (v) => v * 0x7fff);
    const parts = [enc.encodeBuffer(pcm, pcm), enc.flush()];
    const bytes = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
    let o = 0;
    for (const p of parts) {
      bytes.set(p, o);
      o += p.length;
    }
    // Starts on an MPEG-1 layer III frame header (sync 0xFFF, layer bits 01).
    expect(bytes[0]).toBe(0xff);
    expect(bytes[1] & 0xfe).toBe(0xfa);
    // ~192 kbps × 1 s ≈ 24 kB (a little extra for padding / the last frames).
    expect(bytes.length).toBeGreaterThan(22000);
    expect(bytes.length).toBeLessThan(28000);
  });
});
