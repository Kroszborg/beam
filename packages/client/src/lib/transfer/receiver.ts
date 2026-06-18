/**
 * FileReceiver — orchestrates the receiving half of the transfer protocol.
 *
 * Pipeline per chunk:  reassemble frames → AES-GCM decrypt (authenticates) →
 * SHA-256 verify against the manifest → persist to IndexedDB. Decrypted data
 * is written straight to IndexedDB, so the whole file is never held in JS
 * memory during the transfer.
 *
 * Resume is intrinsic: because accepted chunks live in IndexedDB keyed by
 * transferId, a reconnect simply recomputes the missing set and asks for the
 * gaps. The same `resume-request` mechanism bootstraps a fresh transfer (where
 * "missing" is everything).
 */
import type { ManifestMessage, ControlMessage } from '@beam/shared';
import { decryptChunk, sha256, base64UrlToBytes, bytesEqual } from '../crypto/index.js';
import type { Transport } from '../webrtc/transport.js';
import { ChunkReassembler } from './framing.js';
import { TransferLayout } from './layout.js';
import { computeMerkleRoot } from './merkle.js';
import { ResumeStore } from './resumeStore.js';
import { ProgressTracker } from './progress.js';
import { computeMissingChunks, isComplete } from './bitmap.js';
import { buildReceivedFiles } from './fileSink.js';
import type { CompletedFile, ReceiverState, TransferProgress } from './types.js';

export interface FileReceiverCallbacks {
  onState?: (state: ReceiverState) => void;
  onProgress?: (progress: TransferProgress) => void;
  onComplete?: (files: CompletedFile[]) => void;
  onError?: (message: string) => void;
}

export class FileReceiver {
  private readonly reassembler = new ChunkReassembler();
  private readonly store = new ResumeStore();
  private manifest: ManifestMessage | null = null;
  private layout: TransferLayout | null = null;
  private baseNonce: Uint8Array | null = null;
  private received = new Set<number>();
  private progress: ProgressTracker | null = null;
  private transport: Transport | null = null;
  private finished = false;

  constructor(
    private readonly key: CryptoKey,
    private readonly callbacks: FileReceiverCallbacks = {},
  ) {}

  /** Attach to a channel (called again with a new channel on reconnect). */
  attach(transport: Transport): void {
    this.transport = transport;
    this.callbacks.onState?.('connected');
    transport.onMessage((data) => {
      if (typeof data === 'string') {
        void this.onControl(JSON.parse(data) as ControlMessage);
      } else {
        void this.onFrame(data);
      }
    });
    // If we already have the manifest (reconnect), immediately re-request gaps.
    if (this.manifest) this.requestMissing();
  }

  private async onControl(msg: ControlMessage): Promise<void> {
    if (msg.type === 'manifest') {
      await this.onManifest(msg);
    } else if (msg.type === 'error') {
      this.callbacks.onError?.(msg.message);
      this.callbacks.onState?.('error');
    }
  }

  private async onManifest(manifest: ManifestMessage): Promise<void> {
    this.manifest = manifest;
    this.layout = new TransferLayout(manifest.files, manifest.chunkSize);
    this.baseNonce = base64UrlToBytes(manifest.baseNonce);

    // Validate the manifest is internally consistent: its Merkle root must
    // commit to exactly the listed per-chunk hashes. A mismatch means a
    // tampered/corrupt manifest — refuse before transferring anything.
    const leaves = manifest.chunkHashes.map((h) => base64UrlToBytes(h));
    const root = await computeMerkleRoot(leaves);
    if (!bytesEqual(root, base64UrlToBytes(manifest.merkleRoot))) {
      this.fail('Manifest failed Merkle verification.');
      return;
    }

    await this.store.saveManifest(manifest.transferId, manifest);
    // Garbage-collect chunks from any earlier, abandoned transfers.
    await this.store.clearOthers(manifest.transferId);

    // Resume: discover what we already persisted from a prior session.
    this.received = await this.store.getReceivedIndices(manifest.transferId);
    this.progress = new ProgressTracker(manifest.totalBytes, manifest.totalChunks);
    this.progress.seed(this.bytesFor(this.received), this.received.size);

    this.callbacks.onState?.('receiving');
    this.emitProgress();
    this.requestMissing();
  }

  private requestMissing(): void {
    if (!this.manifest || !this.transport) return;
    const missing = computeMissingChunks(this.manifest.totalChunks, this.received);
    if (missing.length === 0) {
      void this.finalize();
      return;
    }
    this.transport.send(
      JSON.stringify({
        type: 'resume-request',
        transferId: this.manifest.transferId,
        missingChunks: missing,
      }),
    );
  }

  private async onFrame(buffer: ArrayBuffer): Promise<void> {
    const assembled = this.reassembler.push(buffer);
    if (!assembled || !this.manifest || !this.layout || !this.baseNonce) return;
    const { chunkIndex, ciphertext } = assembled;
    if (this.received.has(chunkIndex)) return; // duplicate (e.g. after resume)

    let plaintext: Uint8Array;
    try {
      // GCM decrypt authenticates; a bad tag throws here.
      plaintext = await decryptChunk(this.key, this.baseNonce, chunkIndex, ciphertext);
    } catch {
      this.fail(`Chunk ${chunkIndex} failed authentication (decrypt).`);
      return;
    }

    // Defense in depth: verify the plaintext hash matches the manifest leaf.
    const hash = await sha256(plaintext);
    const expected = base64UrlToBytes(this.manifest.chunkHashes[chunkIndex]!);
    if (!bytesEqual(hash, expected)) {
      this.fail(`Chunk ${chunkIndex} failed hash verification.`);
      return;
    }

    const { fileIndex, byteStart } = this.layout.target(chunkIndex);
    await this.store.putChunk({
      transferId: this.manifest.transferId,
      chunkIndex,
      fileIndex,
      byteStart,
      data: plaintext.buffer.slice(
        plaintext.byteOffset,
        plaintext.byteOffset + plaintext.byteLength,
      ) as ArrayBuffer,
    });

    this.received.add(chunkIndex);
    this.progress?.recordChunk(plaintext.length);
    this.emitProgress();

    if (isComplete(this.manifest.totalChunks, this.received)) {
      await this.finalize();
    }
  }

  /** Final whole-transfer verification + file assembly. */
  private async finalize(): Promise<void> {
    if (this.finished || !this.manifest || !this.transport) return;
    this.finished = true;
    this.callbacks.onState?.('verifying');

    // Tell the sender we're done so it can show "complete".
    this.transport.send(
      JSON.stringify({ type: 'transfer-complete', transferId: this.manifest.transferId }),
    );

    // Keep the chunks in IndexedDB so the user can save (stream) them on click;
    // clearOthers() on the next transfer garbage-collects them later.
    const files = buildReceivedFiles(this.store, this.manifest);

    this.callbacks.onState?.('complete');
    this.callbacks.onComplete?.(files);
  }

  private fail(message: string): void {
    this.callbacks.onError?.(message);
    this.callbacks.onState?.('error');
    this.transport?.send(
      JSON.stringify({ type: 'error', code: 'verification-failed', message }),
    );
  }

  private bytesFor(indices: Set<number>): number {
    if (!this.layout) return 0;
    let total = 0;
    for (const i of indices) total += this.layout.target(i).length;
    return total;
  }

  private emitProgress(): void {
    if (this.progress) this.callbacks.onProgress?.(this.progress.snapshot());
  }
}
