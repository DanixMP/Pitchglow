// IndexedDB persistence: the takes library (metadata and heavy audio/pitch data in separate stores,
// so the list loads without reading any audio) and projects (small JSON documents).

import type { Project } from '../project/model';
import type { PackedPitchTrack } from './pitch-track';

export interface RecordingMeta {
  id: string;
  name: string;
  /** Epoch milliseconds. */
  createdAt: number;
  /** Seconds. */
  duration: number;
  sampleRate: number;
}

export interface RecordingData {
  id: string;
  samples: Float32Array;
  pitch: PackedPitchTrack;
}

const DB_NAME = 'recorder';
/** v1: takes (meta + data). v2: + projects, + assets (imported files, Phase 9). Takes are untouched. */
const DB_VERSION = 2;
const META = 'meta';
const DATA = 'data';
const PROJECTS = 'projects';
const ASSETS = 'assets';
const REQUIRED_STORES = [META, DATA, PROJECTS, ASSETS];

function promisify<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function done(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error ?? new Error('Transaction aborted'));
  });
}

/** Opens at `version` (or the current one), creating any missing stores during an upgrade. */
function openDatabase(name: string, version?: number): Promise<IDBDatabase> {
  const req = version === undefined ? indexedDB.open(name) : indexedDB.open(name, version);
  req.onupgradeneeded = () => {
    const db = req.result;
    for (const store of REQUIRED_STORES) {
      if (!db.objectStoreNames.contains(store)) db.createObjectStore(store, { keyPath: 'id' });
    }
  };
  return promisify(req);
}

export class RecordingStore {
  private constructor(private readonly db: IDBDatabase) {}

  /**
   * Opens (and upgrades) the database. Self-healing: if any required store is missing, e.g. after an
   * interrupted upgrade, the version is bumped so the (idempotent, additive) upgrade runs again.
   * Existing stores, and so the user's takes, are never modified.
   */
  static async open(name = DB_NAME): Promise<RecordingStore> {
    let db = await openDatabase(name);
    const missing = REQUIRED_STORES.some((s) => !db.objectStoreNames.contains(s));
    if (db.version < DB_VERSION || missing) {
      const version = Math.max(db.version + 1, DB_VERSION);
      db.close();
      db = await openDatabase(name, version);
    }
    // Let a newer version (another tab, or a reload) upgrade instead of being blocked by us.
    db.onversionchange = () => db.close();
    return new RecordingStore(db);
  }

  /** All recordings, newest first. */
  async list(): Promise<RecordingMeta[]> {
    const tx = this.db.transaction(META, 'readonly');
    const all = await promisify(tx.objectStore(META).getAll() as IDBRequest<RecordingMeta[]>);
    return all.sort((a, b) => b.createdAt - a.createdAt);
  }

  async save(meta: RecordingMeta, data: RecordingData): Promise<void> {
    const tx = this.db.transaction([META, DATA], 'readwrite');
    tx.objectStore(META).put(meta);
    tx.objectStore(DATA).put(data);
    await done(tx);
  }

  async load(id: string): Promise<RecordingData | undefined> {
    const tx = this.db.transaction(DATA, 'readonly');
    return promisify(tx.objectStore(DATA).get(id) as IDBRequest<RecordingData | undefined>);
  }

  async rename(id: string, name: string): Promise<void> {
    const tx = this.db.transaction(META, 'readwrite');
    const store = tx.objectStore(META);
    const meta = (await promisify(store.get(id))) as RecordingMeta | undefined;
    if (meta) store.put({ ...meta, name });
    await done(tx);
  }

  async delete(id: string): Promise<void> {
    const tx = this.db.transaction([META, DATA], 'readwrite');
    tx.objectStore(META).delete(id);
    tx.objectStore(DATA).delete(id);
    await done(tx);
  }

  // --- projects -----------------------------------------------------------------------------

  /** All projects, most recently edited first. */
  async listProjects(): Promise<Project[]> {
    const tx = this.db.transaction(PROJECTS, 'readonly');
    const all = await promisify(tx.objectStore(PROJECTS).getAll() as IDBRequest<Project[]>);
    return all.sort((a, b) => b.updatedAt - a.updatedAt);
  }

  async putProjects(projects: readonly Project[]): Promise<void> {
    if (projects.length === 0) return;
    const tx = this.db.transaction(PROJECTS, 'readwrite');
    for (const p of projects) tx.objectStore(PROJECTS).put(p);
    await done(tx);
  }

  async deleteProject(id: string): Promise<void> {
    const tx = this.db.transaction(PROJECTS, 'readwrite');
    tx.objectStore(PROJECTS).delete(id);
    await done(tx);
  }

  close(): void {
    this.db.close();
  }
}
