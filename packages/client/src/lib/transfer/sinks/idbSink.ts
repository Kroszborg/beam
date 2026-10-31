/**
 * IndexedDB sink — the last-resort path.
 *
 * Chunks are persisted in IndexedDB as they arrive (which also gives
 * resume-after-reload), and each file is offered as a Blob download once the
 * transfer completes. Size is bounded by the browser's storage quota, so the
 * receiver UI checks `storageHeadroom()` before choosing this path.
 */
import { ResumeStore } from '../resumeStore.js';
import type { CompletedFile } from '../types.js';
import type { FileSink, SinkChunk, SinkFile } from './types.js';

/** Bytes of storage still available to this origin, or null if unknown. */
export async function storageHeadroom(): Promise<number | null> {
  try {
    const est = await navigator.storage?.estimate?.();
    if (!est || est.quota == null) return null;
    return est.quota - (est.usage ?? 0);
  } catch {
    return null;
  }
}

export class IdbSink implements FileSink {
  readonly kind = 'idb' as const;
  readonly sequential = false;
  private readonly store = new ResumeStore();

  constructor(
    private readonly transferId: string,
    private readonly files: SinkFile[],
    /** chunk range [start, start+count) of every selected file, by manifest index */
    private readonly ranges: Map<number, { start: number; count: number }>,
  ) {}

  async open(): Promise<Set<number>> {
    // No navigator.storage.persist(): Firefox turns it into a permission
    // prompt and the promise doesn't settle until the user answers.
    await this.store.clearOthers(this.transferId);
    return this.store.getReceivedIndices(this.transferId);
  }

  async write({ chunkIndex, fileIndex, offset, data }: SinkChunk): Promise<void> {
    const buf =
      data.byteOffset === 0 && data.byteLength === data.buffer.byteLength
        ? (data.buffer as ArrayBuffer)
        : (data.slice().buffer as ArrayBuffer);
    await this.store.putChunk({
      transferId: this.transferId,
      chunkIndex,
      fileIndex,
      byteStart: offset,
      data: buf,
    });
  }

  async close(): Promise<CompletedFile[]> {
    return this.files.map((f) => {
      const range = this.ranges.get(f.index)!;
      const name = f.path.split('/').pop() || 'download';
      return {
        name,
        path: f.path,
        size: f.size,
        type: f.type,
        save: () => this.saveFile(name, f.type, range.start, range.count),
      };
    });
  }

  async abort(): Promise<void> {
    // Keep the chunks: a retry of the same link resumes from them.
  }

  private async saveFile(name: string, type: string, start: number, count: number): Promise<void> {
    const parts: BlobPart[] = [];
    for (let i = start; i < start + count; i++) {
      const data = await this.store.getChunk(this.transferId, i);
      if (data) parts.push(data);
    }
    const blob = new Blob(parts, { type: type || 'application/octet-stream' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = name;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 60_000);
  }
}
