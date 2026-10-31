/**
 * FileSender — the sending half of protocol v2.
 *
 * One FileSender holds the selected files, the link key and the sealed
 * manifest. Each receiver connection gets an `Upload` that:
 *
 *   1. sends the encrypted manifest when the receiver says `hello`,
 *   2. waits for the receiver's `request` (the chunks it wants — all of them,
 *      a subset of files, or the gaps left after a reconnect),
 *   3. streams those chunks: read → encrypt → frame → send, with the next
 *      chunks being read and encrypted while the current one is on the wire.
 *
 * Two independent brakes keep memory flat at any file size:
 *   • the DataChannel buffer is filled to SEND_BUFFER_HIGH and refilled at
 *     SEND_BUFFER_LOW (one wakeup per few MB, not per frame), and
 *   • at most RECEIVE_WINDOW_CHUNKS chunks may be un-acked; the receiver acks
 *     only after a chunk is on its disk.
 *
 * There is no hashing pre-pass: AES-GCM authenticates every chunk and its
 * position (see @beam/shared transfer.ts), so the link is ready immediately.
 */
import {
  FRAME_KIND_CHUNK,
  FRAME_KIND_MANIFEST,
  MAX_FRAME_SIZE,
  MIN_FRAME_SIZE,
  PROTOCOL_VERSION,
  RECEIVE_WINDOW_CHUNKS,
  SEND_BUFFER_HIGH,
  type ChunkRange,
  type ControlMessage,
  type Manifest,
} from '@beam/shared';
import { encryptChunk } from '../crypto/index.js';
import type { Transport } from '../webrtc/transport.js';
import { nanoid } from './ids.js';
import { TransferLayout } from './layout.js';
import { buildManifest, sealManifest } from './manifest.js';
import { ProgressTracker } from './progress.js';
import type { TransferProgress, UploadState } from './types.js';
import { frames } from './wire.js';

/** Chunks read + encrypted ahead of the one being sent. */
const LOOKAHEAD = 3;

export interface UploadCallbacks {
  onState?: (state: UploadState) => void;
  onProgress?: (progress: TransferProgress) => void;
  onError?: (message: string) => void;
}

export class FileSender {
  readonly transferId = nanoid();
  readonly manifest: Manifest;
  readonly layout: TransferLayout;
  private sealed: Promise<Uint8Array> | null = null;

  constructor(
    private readonly files: File[],
    private readonly key: CryptoKey,
    private readonly baseNonce: Uint8Array,
  ) {
    this.manifest = buildManifest(files, this.transferId);
    this.layout = new TransferLayout(this.manifest.files, this.manifest.chunkSize);
  }

  /** Sealed once and reused, so every receiver gets identical ciphertext. */
  sealedManifest(): Promise<Uint8Array> {
    this.sealed ??= sealManifest(this.key, this.baseNonce, this.manifest);
    return this.sealed;
  }

  async encryptedChunk(index: number): Promise<Uint8Array> {
    const { fileIndex, byteStart, length } = this.layout.target(index);
    let plaintext: Uint8Array;
    try {
      const file = this.files[fileIndex]!;
      plaintext = new Uint8Array(await file.slice(byteStart, byteStart + length).arrayBuffer());
    } catch {
      throw new ReadError(this.manifest.files[fileIndex]!.path);
    }
    // A file that changed size since it was picked must never be re-encrypted
    // under an IV already used for different bytes.
    if (plaintext.length !== length) throw new ReadError(this.manifest.files[fileIndex]!.path);
    return encryptChunk(this.key, this.baseNonce, index, plaintext);
  }

  /** Serve one receiver over one open channel. */
  serve(transport: Transport, callbacks: UploadCallbacks = {}): Upload {
    return new Upload(this, transport, callbacks);
  }
}

class ReadError extends Error {
  constructor(path: string) {
    super(`Couldn't read "${path}". It may have been moved or changed — pick it again to resend.`);
  }
}

class ChannelClosed extends Error {}

export class Upload {
  private generation = 0;
  private sent = 0;
  private acked = 0;
  /** Plaintext lengths of sent-but-unacked chunks, oldest first. */
  private inflight: number[] = [];
  private wake: (() => void) | null = null;
  private progress: ProgressTracker | null = null;
  private done = false;
  private readonly frameSize: number;

  constructor(
    private readonly sender: FileSender,
    private readonly transport: Transport,
    private readonly cb: UploadCallbacks,
  ) {
    this.frameSize = Math.max(MIN_FRAME_SIZE, Math.min(MAX_FRAME_SIZE, transport.maxMessageSize || 0));
    transport.onMessage((data) => {
      if (typeof data !== 'string') return;
      let msg: ControlMessage;
      try {
        msg = JSON.parse(data) as ControlMessage;
      } catch {
        return;
      }
      this.onControl(msg);
    });
    transport.onClose(() => this.notify());
    cb.onState?.('connected');
  }

  /** Stop sending on this channel (e.g. the receiver left). */
  stop(): void {
    this.generation += 1;
    this.notify();
  }

  private onControl(msg: ControlMessage): void {
    switch (msg.type) {
      case 'hello':
        if (msg.v !== PROTOCOL_VERSION) {
          this.fail(new Error('The receiver is using a different version of Beam. Ask them to reload the page.'));
          return;
        }
        void this.sender
          .sealedManifest()
          .then((m) => this.sendMessage(FRAME_KIND_MANIFEST, 0, m))
          .catch((e) => this.fail(e));
        break;
      case 'request':
        if (msg.transferId !== this.sender.transferId) return;
        void this.pump(msg.ranges, msg.wantBytes, msg.haveBytes);
        break;
      case 'ack':
        for (let i = 0; i < msg.count && this.inflight.length; i++) {
          this.acked += 1;
          this.progress?.recordChunk(this.inflight.shift()!);
        }
        if (this.progress) this.cb.onProgress?.(this.progress.snapshot());
        this.notify();
        break;
      case 'transfer-complete':
        if (!this.done) {
          this.done = true;
          this.generation += 1;
          this.cb.onState?.('complete');
        }
        break;
      case 'error':
        this.generation += 1;
        this.cb.onError?.(msg.message);
        this.cb.onState?.('error');
        break;
    }
  }

  private async pump(ranges: ChunkRange[], wantBytes: number, haveBytes: number): Promise<void> {
    const gen = ++this.generation;
    this.sent = 0;
    this.acked = 0;
    this.inflight = [];
    const chunkCount = ranges.reduce((s, [a, b]) => s + (b - a), 0);
    this.progress = new ProgressTracker(wantBytes, chunkCount);
    this.progress.seed(haveBytes, 0);
    this.cb.onProgress?.(this.progress.snapshot());
    if (chunkCount === 0) return;
    this.cb.onState?.('sending');

    const indices = expand(ranges, this.sender.manifest.totalChunks);
    const ahead: Promise<Uint8Array>[] = [];
    let next = 0;
    const fill = () => {
      while (ahead.length < LOOKAHEAD && next < indices.length) {
        const p = this.sender.encryptedChunk(indices[next++]!);
        p.catch(() => {}); // surfaced when awaited below
        ahead.push(p);
      }
    };

    try {
      fill();
      for (const index of indices) {
        while (this.sent - this.acked >= RECEIVE_WINDOW_CHUNKS) {
          this.check(gen);
          await new Promise<void>((r) => (this.wake = r));
        }
        this.check(gen);
        const ciphertext = await ahead.shift()!;
        fill();
        this.check(gen);
        await this.sendMessage(FRAME_KIND_CHUNK, index, ciphertext);
        this.sent += 1;
        this.inflight.push(this.sender.layout.target(index).length);
      }
    } catch (err) {
      if (err instanceof ChannelClosed) return; // superseded or reconnecting
      this.fail(err);
    }
  }

  /**
   * Send one message as frames. Never abandoned half-way (only the channel
   * closing stops it): a re-request that restarts at the same chunk would
   * otherwise have its frames appended to the receiver's partial copy.
   */
  private async sendMessage(kind: number, index: number, payload: Uint8Array): Promise<void> {
    const t = this.transport;
    for (const frame of frames(kind, index, payload, this.frameSize)) {
      while (t.bufferedAmount > SEND_BUFFER_HIGH && t.readyState === 'open') {
        await t.drained();
      }
      if (t.readyState !== 'open') throw new ChannelClosed();
      t.send(frame);
    }
  }

  private check(gen: number): void {
    if (gen !== this.generation || this.transport.readyState !== 'open') throw new ChannelClosed();
  }

  private notify(): void {
    this.wake?.();
    this.wake = null;
  }

  private fail(err: unknown): void {
    if (err instanceof ChannelClosed) return;
    const message = (err as Error)?.message ?? 'Transfer failed.';
    this.generation += 1;
    if (this.transport.readyState === 'open') {
      this.transport.send(JSON.stringify({ type: 'error', code: 'read-failed', message }));
    }
    this.cb.onError?.(message);
    this.cb.onState?.('error');
  }
}

/** Flatten ranges into an ascending index list, clamped to the manifest. */
function expand(ranges: ChunkRange[], total: number): number[] {
  const out: number[] = [];
  for (const [a, b] of ranges) {
    for (let i = Math.max(0, a); i < Math.min(b, total); i++) out.push(i);
  }
  return out;
}
