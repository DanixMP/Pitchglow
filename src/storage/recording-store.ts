// IndexedDB persistence for recordings. Metadata and the heavy audio/pitch data live in separate
// object stores, so the recordings list loads without reading any audio.

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
const DB_VERSION = 1;
const META = 'meta';
const DATA = 'data';

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

export class RecordingStore {
  private constructor(private readonly db: IDBDatabase) {}

  static async open(name = DB_NAME): Promise<RecordingStore> {
    const req = indexedDB.open(name, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(META)) db.createObjectStore(META, { keyPath: 'id' });
      if (!db.objectStoreNames.contains(DATA)) db.createObjectStore(DATA, { keyPath: 'id' });
    };
    return new RecordingStore(await promisify(req));
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

  close(): void {
    this.db.close();
  }
}
