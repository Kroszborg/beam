/**
 * FileSender — orchestrates the sending half of the transfer protocol.
 *
 * Pipeline per chunk:  read → SHA-256 → AES-256-GCM encrypt → frame → send
 * (paced by DataChannel backpressure). Nothing larger than one chunk is ever
 * resident in memory.
 *
 * Protocol shape (sender side):
 *   1. Send the manifest (file list + per-chunk hashes + Merkle root + nonce).
 *   2. Wait for the receiver's `resume-request`, which lists the chunk indices
 *      it actually needs. For a fresh transfer that's everything; after a
 *      reconnect it's only the gaps.
 *   3. Stream exactly those chunks.
 *   4. On `transfer-complete`, we're done. A fresh `resume-request` (e.g. the
 *      receiver reconnected on a new channel) is served by resending its gaps.
 *
 * `run(transport)` is therefore re-entrant across reconnects: each new channel
 * just replays manifest → serve-requests until the receiver reports complete.
 */
import { nanoid } from './ids.js';
import { CHUNK_SIZE, type ManifestMessage, type ControlMessage } from '@beam/shared';
import { encryptChunk, sha256, bytesToBase64Url } from '../crypto/index.js';
import type { Transport } from '../webrtc/transport.js';
import { FileChunker } from './chunker.js';
import { frameChunk } from './framing.js';
import { computeMerkleRoot } from './merkle.js';
import { ProgressTracker } from './progress.js';
import type { SenderState, TransferProgress } from './types.js';

export interface FileSenderCallbacks {
  onState?: (state: SenderState) => void;
  onProgress?: (progress: TransferProgress) => void;
  onError?: (message: string) => void;
}

export class FileSender {
  readonly transferId = nanoid();
  private readonly chunker: FileChunker;
  private manifest: ManifestMessage | null = null;
  private progress: ProgressTracker;
  private completed = false;

  constructor(
    private readonly files: File[],
    private readonly key: CryptoKey,
    private readonly baseNonce: Uint8Array,
    private readonly callbacks: FileSenderCallbacks = {},
  ) {
    this.chunker = new FileChunker(files);
    this.progress = new ProgressTracker(
      this.chunker.totalBytes,
      this.chunker.totalChunks,
    );
  }

  /**
   * Build the manifest: a single hashing pre-pass over the files. This reads
   * each file once (bounded memory) to compute per-chunk hashes and the Merkle
   * root. Streaming the chunks later reads the files a second time — a
   * deliberate trade of disk I/O for a clean manifest-first protocol that makes
   * resume + whole-transfer verification straightforward.
   */
  async prepare(): Promise<ManifestMessage> {
    this.callbacks.onState?.('preparing');
    const { totalChunks, totalBytes } = this.chunker;
    const chunkHashes: string[] = [];
    const leaves: Uint8Array[] = [];

    for (let i = 0; i < totalChunks; i++) {
      const plaintext = await this.chunker.readChunk(i);
      const hash = await sha256(plaintext);
      leaves.push(hash);
      chunkHashes.push(bytesToBase64Url(hash));
    }

    const merkleRoot = await computeMerkleRoot(leaves);

    this.manifest = {
      type: 'manifest',
      transferId: this.transferId,
      files: this.chunker.buildFileDescriptors(),
      chunkSize: CHUNK_SIZE,
      totalChunks,
      totalBytes,
      baseNonce: bytesToBase64Url(this.baseNonce),
      chunkHashes,
      merkleRoot: bytesToBase64Url(merkleRoot),
    };

    this.callbacks.onState?.('waiting');
    return this.manifest;
  }

  /**
   * Drive the transfer over a freshly-opened channel. Safe to call again on a
   * new channel after a reconnect.
   */
  async run(transport: Transport): Promise<void> {
    if (!this.manifest) throw new Error('call prepare() before run()');
    // Fresh cycle for each receiver that connects (incl. re-used links).
    this.completed = false;
    this.callbacks.onState?.('connected');

    transport.onMessage((data) => {
      if (typeof data === 'string') {
        void this.onControl(transport, JSON.parse(data) as ControlMessage);
      }
    });

    // Kick things off by (re)announcing the manifest.
    transport.send(JSON.stringify(this.manifest));
  }

  private async onControl(
    transport: Transport,
    msg: ControlMessage,
  ): Promise<void> {
    switch (msg.type) {
      case 'resume-request':
        await this.sendChunks(transport, msg.missingChunks);
        break;
      case 'transfer-complete':
        if (!this.completed) {
          this.completed = true;
          this.callbacks.onState?.('complete');
        }
        break;
      case 'error':
        this.callbacks.onError?.(msg.message);
        this.callbacks.onState?.('error');
        break;
    }
  }

  private async sendChunks(
    transport: Transport,
    indices: number[],
  ): Promise<void> {
    this.callbacks.onState?.('sending');

    // Seed progress with what the receiver already has, so a resumed transfer's
    // progress bar starts where it left off rather than at zero.
    const alreadyHave = this.chunker.totalChunks - indices.length;
    const haveBytes = alreadyHave > 0 ? this.estimateBytes(indices) : 0;
    this.progress.seed(haveBytes, alreadyHave);
    this.emitProgress();

    for (const index of indices) {
      if (transport.readyState !== 'open') return; // channel dropped → resume later
      const plaintext = await this.chunker.readChunk(index);
      const ciphertext = await encryptChunk(this.key, this.baseNonce, index, plaintext);
      const frames = frameChunk(index, ciphertext);

      for (const frame of frames) {
        await transport.whenWritable(); // backpressure
        if (transport.readyState !== 'open') return;
        transport.send(frame);
      }

      this.progress.recordChunk(plaintext.length);
      this.emitProgress();
    }
  }

  /** Bytes the receiver already holds = sum of the chunks it isn't requesting. */
  private estimateBytes(missing: number[]): number {
    const missingSet = new Set(missing);
    let have = 0;
    for (let i = 0; i < this.chunker.totalChunks; i++) {
      if (!missingSet.has(i)) have += this.chunker.chunkLength(i);
    }
    return have;
  }

  private emitProgress(): void {
    this.callbacks.onProgress?.(this.progress.snapshot());
  }
}
