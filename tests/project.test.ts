import 'fake-indexeddb/auto';
import { describe, expect, it } from 'vitest';
import {
  addTrack,
  createProject,
  createVocalTrack,
  dbToGain,
  defaultTrackSettings,
  duplicateProject,
  effectiveGain,
  nextProjectName,
  projectDuration,
  projectsUsingTake,
  removeTrack,
  scheduleTrack,
  updateTrack,
  withoutTake,
  type Track,
} from '../src/project/model';
import { packFrames } from '../src/storage/pitch-track';
import { RecordingStore } from '../src/storage/recording-store';

const { tuning, cleanup } = defaultTrackSettings();
const take = (id: string) => ({ id, name: `Take ${id}` });

function project3() {
  let p = createProject('Song 1', 1000, 'p1');
  for (const id of ['a', 'b', 'c']) p = addTrack(p, createVocalTrack(take(id), tuning, cleanup, p.tracks, `t-${id}`), 1000);
  return p;
}

describe('project model', () => {
  it('creates projects and names them Song N', () => {
    const p = createProject('Song 1', 5, 'x');
    expect(p).toMatchObject({ id: 'x', name: 'Song 1', tracks: [], keyShift: 0, masterGainDb: 0, createdAt: 5 });
    expect(nextProjectName([])).toBe('Song 1');
    expect(nextProjectName([p, { ...p, name: 'Song 4' }, { ...p, name: 'My jam' }])).toBe('Song 5');
  });

  it('creates vocal tracks from takes with their own copy of the settings', () => {
    const p = project3();
    expect(p.tracks.map((t) => t.name)).toEqual(['Take a', 'Take b', 'Take c']);
    expect(new Set(p.tracks.map((t) => t.hue)).size).toBe(3); // distinct colours
    p.tracks[0].tuning.harmony.push('thirdUp');
    expect(p.tracks[1].tuning.harmony).toEqual([]); // not shared
  });

  it('updates, removes and duplicates immutably', () => {
    const p = project3();
    const muted = updateTrack(p, 't-b', { mute: true }, 2000);
    expect(muted.tracks[1].mute).toBe(true);
    expect(p.tracks[1].mute).toBe(false);
    expect(muted.updatedAt).toBe(2000);
    expect(removeTrack(p, 't-a').tracks.map((t) => t.id)).toEqual(['t-b', 't-c']);
    const copy = duplicateProject(p, 'Song 1 copy', 3000, 'p2');
    expect(copy.id).toBe('p2');
    expect(copy.tracks).toHaveLength(3);
    expect(copy.tracks.every((t, i) => t.id !== p.tracks[i].id && t.takeId === p.tracks[i].takeId)).toBe(true);
  });

  it('finds and strips tracks that use a deleted take', () => {
    const p = project3();
    const other = createProject('Other', 1, 'p9');
    expect(projectsUsingTake([p, other], 'b').map((x) => x.id)).toEqual(['p1']);
    const [changed] = withoutTake([p, other], 'b');
    expect(changed.tracks.map((t) => t.takeId)).toEqual(['a', 'c']);
  });

  it('computes effective gain with mute and solo', () => {
    const p = project3();
    const [a, b, c] = p.tracks;
    expect(effectiveGain(a, p.tracks)).toBe(1);
    expect(effectiveGain({ ...a, mute: true }, p.tracks)).toBe(0);
    const soloB: Track[] = [a, { ...b, solo: true }, c];
    expect(effectiveGain(soloB[0], soloB)).toBe(0);
    expect(effectiveGain(soloB[1], soloB)).toBe(1);
    expect(dbToGain(-6)).toBeCloseTo(0.501, 3);
    expect(dbToGain(-80)).toBe(0);
  });

  it('computes song length and track scheduling', () => {
    const p = project3();
    const tracks = [p.tracks[0], { ...p.tracks[1], offset: 2 }];
    expect(projectDuration(tracks, () => 3)).toBe(5);
    expect(scheduleTrack(0, 2, 3)).toEqual({ delay: 2, from: 0 }); // starts later
    expect(scheduleTrack(3, 2, 3)).toEqual({ delay: 0, from: 1 }); // mid-track
    expect(scheduleTrack(6, 2, 3)).toBeNull(); // already over
  });
});

describe('RecordingStore v2', () => {
  it('migrates a v1 database without losing takes', async () => {
    const name = `migrate-${Math.random()}`;
    // Build a v1 database the way the old app did.
    await new Promise<void>((resolve, reject) => {
      const req = indexedDB.open(name, 1);
      req.onupgradeneeded = () => {
        req.result.createObjectStore('meta', { keyPath: 'id' });
        req.result.createObjectStore('data', { keyPath: 'id' });
      };
      req.onsuccess = () => {
        const db = req.result;
        const tx = db.transaction(['meta', 'data'], 'readwrite');
        tx.objectStore('meta').put({ id: 'old', name: 'Old take', createdAt: 1, duration: 1, sampleRate: 48000 });
        tx.objectStore('data').put({ id: 'old', samples: new Float32Array([0.5]), pitch: packFrames([]) });
        tx.oncomplete = () => {
          db.close();
          resolve();
        };
        tx.onerror = () => reject(tx.error);
      };
      req.onerror = () => reject(req.error);
    });

    const store = await RecordingStore.open(name);
    expect((await store.list()).map((m) => m.name)).toEqual(['Old take']);
    expect([...(await store.load('old'))!.samples]).toEqual([0.5]);
    expect(await store.listProjects()).toEqual([]);

    const p = project3();
    await store.putProjects([p, { ...createProject('Newer', 9, 'p2'), updatedAt: 5000 }]);
    expect((await store.listProjects()).map((x) => x.id)).toEqual(['p2', 'p1']);
    await store.deleteProject('p2');
    expect((await store.listProjects()).map((x) => x.tracks.length)).toEqual([3]);
    store.close();
  });

  it('heals a database that claims v2 but lacks the new stores (interrupted upgrade)', async () => {
    const name = `partial-${Math.random()}`;
    await new Promise<void>((resolve) => {
      const req = indexedDB.open(name, 2);
      req.onupgradeneeded = () => {
        req.result.createObjectStore('meta', { keyPath: 'id' });
        req.result.createObjectStore('data', { keyPath: 'id' });
        req.result.createObjectStore('meta-only-marker', { keyPath: 'id' });
      };
      req.onsuccess = () => {
        const tx = req.result.transaction('meta', 'readwrite');
        tx.objectStore('meta').put({ id: 'keep', name: 'Keep me', createdAt: 1, duration: 1, sampleRate: 48000 });
        tx.oncomplete = () => {
          req.result.close();
          resolve();
        };
      };
    });
    const store = await RecordingStore.open(name);
    expect(await store.listProjects()).toEqual([]); // would throw "store not found" before healing
    expect((await store.list()).map((m) => m.id)).toEqual(['keep']);
    store.close();
    // Opening again (now at v3) works too.
    const again = await RecordingStore.open(name);
    expect((await again.list()).length).toBe(1);
    again.close();
  });

  it('creates every store for a brand-new database', async () => {
    const store = await RecordingStore.open(`fresh-${Math.random()}`);
    expect(await store.list()).toEqual([]);
    expect(await store.listProjects()).toEqual([]);
    store.close();
  });
});
