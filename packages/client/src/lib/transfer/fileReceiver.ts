/**
 * FileReceiver — the receiving half of protocol v2.
 *
 * Lifecycle:
 *   attach(channel) → encrypted manifest arrives → `onManifest` (the UI shows
 *   the file list) → accept(selection, sink) → request → chunks stream in →
 *   every wanted chunk is on disk → sink.close() → `transfer-complete`.
 *
 * Each chunk goes through one serial queue: decrypt (GCM authenticates bytes
 * and position) → length check against the manifest → sink.write → ack. Acks
 * are sent only after the write, so the sender can never run more than its
 * window ahead of the receiver's disk, and the queue never grows unbounded.
 *
 * Reconnects: a new channel re-delivers the manifest; once the queue has
 * drained, the receiver re-requests exactly the chunks it still lacks.
 */
import {
  FRAME_KIND_CHUNK,
  FRAME_KIND_MANIFEST,
  GCM_TAG_BITS,
  PROTOCOL_VERSION,
  type ChunkRange,
  type ControlMessage,
  type Manifest,
} from '@beam/shared';
import { decryptChunk } from '../crypto/index.js';
import type { Transport } from '../webrtc/transport.js';
import { TransferLayout } from './layout.js';
import { openManifest, ManifestError } from './manifest.js';
import { ProgressTracker } from './progress.js';
import type { FileSink, SinkFile } from './sinks/types.js';
import type { CompletedFile, ReceiverState, TransferProgress } from './types.js';
import { Reassembler, WireError } from './wire.js';

export interface FileReceiverCallbacks {
  onState?: (state: ReceiverState) => void;
  onManifest?: (manifest: Manifest) => void;
  onProgress?: (progress: TransferProgress) => void;
  /** Files still to be saved by hand (idb sink), or null when already on disk. */
  onComplete?: (files: CompletedFile[] | null) => void;
  onError?: (message: string) => void;
}

const TAG_BYTES = GCM_TAG_BITS / 8;
/** Re-send `hello` if the manifest hasn't arrived after this long. */
export const HELLO_RETRY_MS = 8_000;
/** Re-request missing chunks after this long with nothing arriving or pending. */
export const STALL_RETRY_MS = 15_000;
const WATCHDOG_TICK_MS = 2_000;

export interface WatchdogTiming {
  helloRetryMs: number;
  stallRetryMs: number;
  tickMs: number;
}

export class FileReceiver {
  private transport: Transport | null = null;
  private reassembler: Reassembler | null = null;
  private manifest: Manifest | null = null;
  private layout: TransferLayout | null = null;
  private baseNonce: Uint8Array | null = null;
  private sink: FileSink | null = null;
  private wanted: Set<number> | null = null;
  private wantedOrder: number[] = [];
  private received = new Set<number>();
  private progress: ProgressTracker | null = null;
  /** Serialises chunk processing (and requests) in arrival order. */
  private queue: Promise<void> = Promise.resolve();
  private finished = false;
  private failed = false;
  /** Queue tasks not yet settled (chunks being decrypted/written). */
  private pending = 0;
  /** Last time a frame arrived or a write completed. */
  private lastActivity = 0;
  private lastHello = 0;
  private watchdog: ReturnType<typeof setInterval> | null = null;

  private readonly timing: WatchdogTiming;

  constructor(
    private readonly key: CryptoKey,
    private readonly cb: FileReceiverCallbacks = {},
    timing: Partial<WatchdogTiming> = {},
  ) {
    this.timing = { helloRetryMs: HELLO_RETRY_MS, stallRetryMs: STALL_RETRY_MS, tickMs: WATCHDOG_TICK_MS, ...timing };
  }

  get selectedFiles(): SinkFile[] {
    if (!this.manifest || !this.wanted) return [];
    return this.manifest.files
      .map((f, index) => ({ index, ...f }))
      .filter((f) => this.chunksOf(f.index).some((c) => this.wanted!.has(c)));
  }

  attach(transport: Transport): void {
    this.transport = transport;
    // Allow a little over one chunk of ciphertext per message.
    this.reassembler = new Reassembler(64 * 1024 * 1024);
    if (!this.finished) this.cb.onState?.(this.sink ? 'receiving' : 'connected');
    transport.onMessage((data) => {
      if (this.failed || transport !== this.transport) return;
      this.lastActivity = Date.now();
      if (typeof data === 'string') this.onControl(data);
      else this.onFrame(data);
    });
    this.lastActivity = Date.now();
    this.sayHello();
    this.watchdog ??= setInterval(() => this.checkStall(), this.timing.tickMs);
  }

  private sayHello(): void {
    this.lastHello = Date.now();
    this.send({ type: 'hello', v: PROTOCOL_VERSION });
  }

  /**
   * Recover from a lost message on a channel that still looks open: no
   * manifest yet → say hello again; receiving but nothing arriving and nothing
   * waiting on the disk → ask again for what's missing. Both are idempotent
   * on the sender (duplicate chunks are acked without being written).
   */
  private checkStall(): void {
    if (this.finished || this.failed) return this.stopWatchdog();
    if (this.transport?.readyState !== 'open') return;
    const now = Date.now();
    if (!this.manifest) {
      if (now - this.lastHello >= this.timing.helloRetryMs) this.sayHello();
      return;
    }
    if (this.sink && this.pending === 0 && now - this.lastActivity >= this.timing.stallRetryMs) {
      this.lastActivity = now;
      this.enqueue(() => this.request());
    }
  }

  private stopWatchdog(): void {
    if (this.watchdog) clearInterval(this.watchdog);
    this.watchdog = null;
  }

  /**
   * Start receiving `fileIndices` into `sink`. Called from the user's click
   * after they've reviewed the file list.
   */
  async accept(fileIndices: number[], sink: FileSink): Promise<void> {
    if (!this.manifest || this.sink) return;
    this.sink = sink;
    const wanted: number[] = [];
    for (const fi of [...new Set(fileIndices)].sort((a, b) => a - b)) wanted.push(...this.chunksOf(fi));
    this.wantedOrder = wanted;
    this.wanted = new Set(wanted);

    try {
      const persisted = await sink.open();
      for (const i of persisted) if (this.wanted.has(i)) this.received.add(i);
    } catch (err) {
      this.sink = null;
      throw err;
    }

    const wantBytes = wanted.reduce((s, i) => s + this.layout!.target(i).length, 0);
    this.progress = new ProgressTracker(wantBytes, wanted.length);
    this.progress.seed(this.bytesOf(this.received), this.received.size);
    this.cb.onState?.('receiving');
    this.emitProgress();
    this.enqueue(() => this.request());
  }

  /** Stop and discard (user cancelled). */
  async cancel(): Promise<void> {
    this.failed = true;
    this.stopWatchdog();
    this.send({ type: 'request', transferId: this.manifest?.transferId ?? '', ranges: [], wantBytes: 0, haveBytes: 0 });
    await this.sink?.abort();
  }

  private onControl(raw: string): void {
    let msg: ControlMessage;
    try {
      msg = JSON.parse(raw) as ControlMessage;
    } catch {
      return;
    }
    if (msg.type === 'error') {
      void this.fail(msg.message, false);
    }
  }

  private onFrame(frame: ArrayBuffer): void {
    let message;
    try {
      message = this.reassembler!.push(frame);
    } catch (err) {
      void this.fail(err instanceof WireError ? `Protocol error: ${err.message}` : 'Protocol error.');
      return;
    }
    if (!message) return;
    if (message.kind === FRAME_KIND_MANIFEST) {
      const payload = message.payload;
      this.enqueue(() => this.onManifestMessage(payload));
    } else if (message.kind === FRAME_KIND_CHUNK) {
      const { index, payload } = message;
      this.enqueue(() => this.onChunk(index, payload));
    }
  }

  private async onManifestMessage(sealed: Uint8Array): Promise<void> {
    let opened;
    try {
      opened = await openManifest(this.key, sealed);
    } catch (err) {
      return this.fail(err instanceof ManifestError ? err.message : 'Could not read the file list.');
    }
    if (this.manifest) {
      // Reconnect: same transfer → pick up where we left off.
      if (opened.manifest.transferId !== this.manifest.transferId) {
        return this.fail('The sender started a different transfer on this link. Reload to receive it.');
      }
      if (this.sink) await this.request();
      return;
    }
    this.manifest = opened.manifest;
    this.baseNonce = opened.baseNonce;
    this.layout = new TransferLayout(opened.manifest.files, opened.manifest.chunkSize);
    this.cb.onManifest?.(opened.manifest);
    this.cb.onState?.('ready');
  }

  private async onChunk(index: number, ciphertext: Uint8Array): Promise<void> {
    if (!this.sink || !this.layout || !this.baseNonce || this.finished) return;
    // Duplicates (after a resume) and unwanted chunks still count toward the
    // sender's window, so they're acked without being written.
    if (!this.wanted!.has(index) || this.received.has(index)) {
      this.send({ type: 'ack', count: 1 });
      return;
    }
    const target = this.layout.target(index);
    if (ciphertext.length !== target.length + TAG_BYTES) {
      return this.fail(`Chunk ${index} has the wrong length.`);
    }
    let plaintext: Uint8Array;
    try {
      plaintext = await decryptChunk(this.key, this.baseNonce, index, ciphertext);
    } catch {
      return this.fail(`Chunk ${index} failed authentication — the data was corrupted or tampered with.`);
    }
    try {
      await this.sink.write({
        chunkIndex: index,
        fileIndex: target.fileIndex,
        offset: target.byteStart,
        data: plaintext,
      });
    } catch (err) {
      return this.fail((err as Error)?.message || 'Could not write to disk.');
    }
    this.received.add(index);
    this.lastActivity = Date.now();
    this.progress?.recordChunk(target.length);
    this.emitProgress();
    this.send({ type: 'ack', count: 1 });
    if (this.received.size === this.wanted!.size) await this.finish();
  }

  /** Ask for every wanted chunk not yet on disk, in order. */
  private async request(): Promise<void> {
    if (!this.manifest || !this.sink || this.finished) return;
    const missing = this.wantedOrder.filter((i) => !this.received.has(i));
    if (missing.length === 0) return this.finish();
    this.send({
      type: 'request',
      transferId: this.manifest.transferId,
      ranges: toRanges(missing),
      wantBytes: this.progress?.snapshot().totalBytes ?? 0,
      haveBytes: this.bytesOf(this.received),
    });
  }

  private async finish(): Promise<void> {
    if (this.finished || !this.sink || !this.manifest) return;
    this.finished = true;
    let files: CompletedFile[] | null;
    try {
      files = await this.sink.close();
    } catch (err) {
      this.finished = false;
      return this.fail((err as Error)?.message || 'Could not finish writing files.');
    }
    this.stopWatchdog();
    this.send({ type: 'transfer-complete', transferId: this.manifest.transferId });
    this.cb.onState?.('complete');
    this.cb.onComplete?.(files);
  }

  private async fail(message: string, tellPeer = true): Promise<void> {
    if (this.failed) return;
    this.failed = true;
    this.stopWatchdog();
    if (tellPeer) this.send({ type: 'error', code: 'verification-failed', message });
    await this.sink?.abort().catch(() => {});
    this.cb.onError?.(message);
    this.cb.onState?.('error');
  }

  private enqueue(task: () => Promise<void>): void {
    this.pending += 1;
    this.queue = this.queue
      .then(() => (this.failed ? undefined : task()))
      .catch((err) => {
        void this.fail((err as Error)?.message || 'Transfer failed.');
      })
      .finally(() => {
        this.pending -= 1;
      });
  }

  private send(msg: ControlMessage): void {
    if (this.transport?.readyState === 'open') this.transport.send(JSON.stringify(msg));
  }

  private chunksOf(fileIndex: number): number[] {
    const { start, count } = this.layout!.range(fileIndex);
    return Array.from({ length: count }, (_, i) => start + i);
  }

  private bytesOf(indices: Iterable<number>): number {
    let total = 0;
    for (const i of indices) total += this.layout!.target(i).length;
    return total;
  }

  private emitProgress(): void {
    if (this.progress) this.cb.onProgress?.(this.progress.snapshot());
  }
}

/** Compress an ascending index list into [start, end) ranges. */
export function toRanges(sorted: number[]): ChunkRange[] {
  const out: ChunkRange[] = [];
  for (const i of sorted) {
    const last = out[out.length - 1];
    if (last && last[1] === i) last[1] = i + 1;
    else out.push([i, i + 1]);
  }
  return out;
}
