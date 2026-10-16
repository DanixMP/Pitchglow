// Song files (Phase 12): a whole song (the project, the takes its tracks play with their pitch
// tracks, and its instrumental file) packed into one `.recsong` file, and unpacked on import.
// The file is a plain ZIP: song.json, takes/<id>.wav (32-bit float, lossless), takes/<id>.pitch,
// and assets/<id>.<ext> (the original imported file).

import { createZip, readZip } from '../audio/zip';
import { decodeWav, encodeWavFloat32 } from '../audio/wav';
import { deserializePitch, serializePitch, type PackedPitchTrack } from '../storage/pitch-track';
import type { Asset, RecordingMeta } from '../storage/recording-store';
import { newId, type Project } from './model';

export const SONG_FILE_EXT = 'recsong';
const FORMAT = 'recorder-song';
const VERSION = 1;

export interface PackedTake {
  meta: RecordingMeta;
  samples: Float32Array;
  pitch: PackedPitchTrack;
}

export interface SongPackage {
  project: Project;
  takes: PackedTake[];
  assets: Asset[];
}

interface Manifest {
  format: typeof FORMAT;
  version: number;
  project: Project;
  takes: { meta: RecordingMeta; audio: string; pitch: string }[];
  assets: { id: string; name: string; type: string; createdAt: number; file: string }[];
}

export function isSongFile(name: string): boolean {
  return name.toLowerCase().endsWith(`.${SONG_FILE_EXT}`);
}

export function packSong(pkg: SongPackage, date = new Date()): Uint8Array<ArrayBuffer> {
  const enc = new TextEncoder();
  const manifest: Manifest = {
    format: FORMAT,
    version: VERSION,
    project: pkg.project,
    takes: pkg.takes.map((t) => ({ meta: t.meta, audio: `takes/${t.meta.id}.wav`, pitch: `takes/${t.meta.id}.pitch` })),
    assets: pkg.assets.map((a) => ({ id: a.id, name: a.name, type: a.type, createdAt: a.createdAt, file: `assets/${a.id}${extensionOf(a)}` })),
  };
  return createZip(
    [
      { name: 'song.json', data: enc.encode(JSON.stringify(manifest, null, 1)) },
      ...pkg.takes.flatMap((t, i) => [
        { name: manifest.takes[i].audio, data: encodeWavFloat32(t.samples, t.meta.sampleRate) },
        { name: manifest.takes[i].pitch, data: serializePitch(t.pitch) },
      ]),
      ...pkg.assets.map((a, i) => ({ name: manifest.assets[i].file, data: new Uint8Array(a.data) })),
    ],
    date,
  );
}

/** Reads a song file. Throws an Error with a message fit for the status line. */
export function unpackSong(bytes: Uint8Array): SongPackage {
  let files: Map<string, Uint8Array>;
  try {
    files = readZip(bytes);
  } catch {
    throw new Error('This isn’t a song file saved by PitchGlow (or Recorder, its earlier name).');
  }
  const json = files.get('song.json');
  let manifest: Manifest;
  try {
    manifest = JSON.parse(new TextDecoder().decode(json)) as Manifest;
  } catch {
    throw new Error('This isn’t a song file saved by PitchGlow (or Recorder, its earlier name).');
  }
  if (manifest?.format !== FORMAT || !Array.isArray(manifest.project?.tracks)) throw new Error('This isn’t a song file saved by PitchGlow (or Recorder, its earlier name).');
  if (manifest.version > VERSION) throw new Error('This song file was saved by a newer version of PitchGlow.');
  const need = (name: string) => {
    const data = files.get(name);
    if (!data) throw new Error(`The song file is missing ${name}.`);
    return data;
  };
  const takes = manifest.takes.map((t) => {
    const audio = decodeWav(need(t.audio));
    return { meta: t.meta, samples: audio.channels[0], pitch: deserializePitch(need(t.pitch)) };
  });
  const assets = manifest.assets.map((a) => {
    const data = need(a.file);
    // Copy into its own ArrayBuffer (the entry is a view into the whole file).
    return { id: a.id, name: a.name, type: a.type, createdAt: a.createdAt, data: data.slice().buffer };
  });
  for (const t of manifest.project.tracks) {
    if (t.takeId && !takes.some((x) => x.meta.id === t.takeId)) throw new Error('The song file is missing a take.');
    if (t.assetId && !assets.some((x) => x.id === t.assetId)) throw new Error('The song file is missing its instrumental.');
  }
  return { project: manifest.project, takes, assets };
}

/**
 * What an import adds: the song under a new id (so it never overwrites a song on this device) and a
 * free name; takes and files only when this device doesn't have them yet (ids are UUIDs, so the same
 * id means the same take, e.g. a song exported from and re-imported to the same browser).
 */
export function prepareImport(
  pkg: SongPackage,
  existing: { projectNames: readonly string[]; takeIds: ReadonlySet<string>; assetIds: ReadonlySet<string> },
  now = Date.now(),
): SongPackage {
  let name = pkg.project.name;
  for (let n = 2; existing.projectNames.includes(name); n++) name = `${pkg.project.name} (${n})`;
  return {
    project: { ...pkg.project, id: newId(), name, updatedAt: now },
    takes: pkg.takes.filter((t) => !existing.takeIds.has(t.meta.id)),
    assets: pkg.assets.filter((a) => !existing.assetIds.has(a.id)),
  };
}

function extensionOf(asset: Asset): string {
  const sub = asset.type.split('/')[1]?.replace(/^x-/, '').replace('mpeg', 'mp3').replace('wave', 'wav');
  return sub && /^[a-z0-9]{2,5}$/.test(sub) ? `.${sub}` : '.bin';
}
