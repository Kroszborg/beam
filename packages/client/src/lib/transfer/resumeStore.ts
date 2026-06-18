/**
 * IndexedDB-backed resume store.
 *
 * Every verified+decrypted chunk the receiver accepts is persisted here, keyed
 * by (transferId, chunkIndex). Two things fall out of that:
 *
 *   • Resume — if the connection drops, the received chunks survive in
 *     IndexedDB. On reconnect the receiver reads back which indices it already
 *     has and asks the sender only for the missing ones.
 *
 *   • Assembly — when the transfer completes, each output file is rebuilt by
 *     streaming its chunks back out of IndexedDB in order, so the full file is
 *     never held in JS memory during the transfer itself.
 *
 * The store holds plaintext chunks only transiently, on the receiver's own
 * device, and is cleared once the user has saved the files.
 */

const DB_NAME = 'beam';
const DB_VERSION = 1;
const CHUNK_STORE = 'chunks';
const MANIFEST_STORE = 'manifests';

export interface StoredChunk {
  transferId: string;
  chunkIndex: number;
  fileIndex: number;
  byteStart: number;
  data: ArrayBuffer;
}

function promisify<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

export class ResumeStore {
  private dbPromise: Promise<IDBDatabase> | null = null;

  private open(): Promise<IDBDatabase> {
    if (this.dbPromise) return this.dbPromise;
    this.dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(CHUNK_STORE)) {
          const store = db.createObjectStore(CHUNK_STORE, {
            keyPath: ['transferId', 'chunkIndex'],
          });
          store.createIndex('byTransfer', 'transferId', { unique: false });
        }
        if (!db.objectStoreNames.contains(MANIFEST_STORE)) {
          db.createObjectStore(MANIFEST_STORE, { keyPath: 'transferId' });
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    return this.dbPromise;
  }

  async saveManifest(transferId: string, manifest: unknown): Promise<void> {
    const db = await this.open();
    const tx = db.transaction(MANIFEST_STORE, 'readwrite');
    tx.objectStore(MANIFEST_STORE).put({ transferId, manifest });
    await txDone(tx);
  }

  async getManifest<T>(transferId: string): Promise<T | null> {
    const db = await this.open();
    const tx = db.transaction(MANIFEST_STORE, 'readonly');
    const row = await promisify(
      tx.objectStore(MANIFEST_STORE).get(transferId) as IDBRequest<
        { transferId: string; manifest: T } | undefined
      >,
    );
    return row ? row.manifest : null;
  }

  async putChunk(chunk: StoredChunk): Promise<void> {
    const db = await this.open();
    const tx = db.transaction(CHUNK_STORE, 'readwrite');
    tx.objectStore(CHUNK_STORE).put(chunk);
    await txDone(tx);
  }

  /** The set of chunk indices already persisted for a transfer. */
  async getReceivedIndices(transferId: string): Promise<Set<number>> {
    const db = await this.open();
    const tx = db.transaction(CHUNK_STORE, 'readonly');
    const index = tx.objectStore(CHUNK_STORE).index('byTransfer');
    const keys = await promisify(
      index.getAllKeys(IDBKeyRange.only(transferId)) as unknown as IDBRequest<
        [string, number][]
      >,
    );
    return new Set(keys.map((k) => k[1]));
  }

  /** Fetch a single chunk's bytes (used to stream a file out chunk-by-chunk). */
  async getChunk(transferId: string, chunkIndex: number): Promise<ArrayBuffer | null> {
    const db = await this.open();
    const tx = db.transaction(CHUNK_STORE, 'readonly');
    const row = await promisify(
      tx.objectStore(CHUNK_STORE).get([transferId, chunkIndex]) as IDBRequest<
        StoredChunk | undefined
      >,
    );
    return row ? row.data : null;
  }

  /** All chunks for one file, ordered by byte offset (for assembly). */
  async getChunksForFile(
    transferId: string,
    fileIndex: number,
  ): Promise<StoredChunk[]> {
    const db = await this.open();
    const tx = db.transaction(CHUNK_STORE, 'readonly');
    const index = tx.objectStore(CHUNK_STORE).index('byTransfer');
    const all = await promisify(
      index.getAll(IDBKeyRange.only(transferId)) as IDBRequest<StoredChunk[]>,
    );
    return all
      .filter((c) => c.fileIndex === fileIndex)
      .sort((a, b) => a.byteStart - b.byteStart);
  }

  /** Remove all persisted data for a transfer (after the user saves it). */
  async clearTransfer(transferId: string): Promise<void> {
    const db = await this.open();
    const tx = db.transaction(CHUNK_STORE, 'readwrite');
    const index = tx.objectStore(CHUNK_STORE).index('byTransfer');
    const keys = await promisify(
      index.getAllKeys(IDBKeyRange.only(transferId)) as unknown as IDBRequest<
        [string, number][]
      >,
    );
    const store = tx.objectStore(CHUNK_STORE);
    for (const key of keys) store.delete(key);
    await txDone(tx);
  }

  /**
   * Garbage-collect every transfer except the one we're currently receiving.
   * Called when a new transfer's manifest arrives, so chunks from abandoned
   * past transfers don't accumulate forever in the browser.
   */
  async clearOthers(keepTransferId: string): Promise<void> {
    const db = await this.open();
    const tx = db.transaction([CHUNK_STORE, MANIFEST_STORE], 'readwrite');
    const chunks = tx.objectStore(CHUNK_STORE);

    const chunkKeys = await promisify(
      chunks.getAllKeys() as unknown as IDBRequest<[string, number][]>,
    );
    for (const key of chunkKeys) {
      if (key[0] !== keepTransferId) chunks.delete(key);
    }

    const manifests = tx.objectStore(MANIFEST_STORE);
    const manifestKeys = await promisify(
      manifests.getAllKeys() as unknown as IDBRequest<string[]>,
    );
    for (const key of manifestKeys) {
      if (key !== keepTransferId) manifests.delete(key);
    }

    await txDone(tx);
  }
}

function txDone(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
}
