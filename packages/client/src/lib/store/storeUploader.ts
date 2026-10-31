/**
 * Uploads an encrypted copy of a transfer for store-and-forward.
 *
 * Uploads exactly the ciphertext a receiver would get over WebRTC (same key,
 * same IVs, same bytes), so a receiver can switch between the live sender and
 * the stored copy mid-file. Chunks go up in order with a few in flight, and
 * receivers can already download the ones that are there.
 */
import { GCM_TAG_BITS } from '@beam/shared';
import type { FileSender } from '../transfer/fileSender.js';
import { StoreApi, withRetry } from './storeApi.js';

export type CopyState = 'uploading' | 'ready' | 'error' | 'deleted';

export interface CopyStatus {
  state: CopyState;
  uploadedBytes: number;
  totalBytes: number;
  expiresAt: number | null;
  error: string | null;
}

const PARALLEL = 3;
const TAG_BYTES = GCM_TAG_BITS / 8;

export class StoreUploader {
  private token: string | null = null;
  private stopped = false;
  private status: CopyStatus;

  constructor(
    private readonly api: StoreApi,
    private readonly sender: FileSender,
    private readonly room: { roomId: string; peerId: string; token: string },
    private readonly onStatus: (s: CopyStatus) => void,
  ) {
    const { totalChunks, totalBytes } = sender.manifest;
    this.status = {
      state: 'uploading',
      uploadedBytes: 0,
      totalBytes: totalBytes + totalChunks * TAG_BYTES,
      expiresAt: null,
      error: null,
    };
  }

  private emit(patch: Partial<CopyStatus>): void {
    this.status = { ...this.status, ...patch };
    this.onStatus(this.status);
  }

  async run(): Promise<void> {
    const { roomId } = this.room;
    const { totalChunks } = this.sender.manifest;
    try {
      this.emit({});
      const created = await withRetry(() =>
        this.api.create({ ...this.room, totalChunks, cipherBytes: this.status.totalBytes }),
      );
      this.token = created.uploadToken;
      this.emit({ expiresAt: created.expiresAt });
      const token = created.uploadToken;
      const manifest = await this.sender.sealedManifest();
      await withRetry(() => this.api.putManifest(roomId, token, manifest));

      let next = 0;
      const worker = async () => {
        while (!this.stopped && next < totalChunks) {
          const index = next++;
          const data = await this.sender.encryptedChunk(index);
          await withRetry(() => this.api.putChunk(roomId, token, index, data));
          this.emit({ uploadedBytes: this.status.uploadedBytes + data.length });
        }
      };
      await Promise.all(Array.from({ length: Math.min(PARALLEL, totalChunks) }, worker));
      if (this.stopped) return;
      await withRetry(() => this.api.complete(roomId, token));
      this.emit({ state: 'ready' });
    } catch (err) {
      if (this.stopped) return;
      this.emit({ state: 'error', error: (err as Error).message || 'Upload failed.' });
    }
  }

  /** Stop uploading and delete what's on the server. */
  async remove(): Promise<void> {
    this.stopped = true;
    if (this.token) await this.api.remove(this.room.roomId, this.token).catch(() => {});
    this.emit({ state: 'deleted' });
  }
}
