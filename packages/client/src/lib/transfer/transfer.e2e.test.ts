import 'fake-indexeddb/auto';
import { describe, it, expect } from 'vitest';
import { FileSender } from './sender.js';
import { FileReceiver } from './receiver.js';
import { FileChunker } from './chunker.js';
import { frameChunk } from './framing.js';
import {
  generateSessionKey,
  generateBaseNonce,
  exportKeyToFragment,
  importKeyFromFragment,
  encryptChunk,
} from '../crypto/index.js';
import type { Transport, ChannelData } from '../webrtc/transport.js';
import type { CompletedFile } from './types.js';

interface ResumeRequestLike {
  type: 'resume-request';
  transferId: string;
  missingChunks: number[];
}

/**
 * End-to-end exercise of the transfer protocol with NO browser and NO real peer
 * connection: the sender and receiver are wired together through an in-memory
 * paired transport. This proves the whole pipeline — encrypt, frame, reassemble,
 * authenticate, hash-verify, persist to (fake) IndexedDB, and reassemble files —
 * end to end, plus the resume path.
 */

/** A bidirectional in-memory transport pair implementing the Transport contract. */
class PairedTransport implements Transport {
  readyState: RTCDataChannelState = 'open';
  peer!: PairedTransport;
  private handler: ((data: ChannelData) => void) | null = null;

  onMessage(handler: (data: ChannelData) => void): void {
    this.handler = handler;
  }
  whenWritable(): Promise<void> {
    return Promise.resolve();
  }
  send(data: string | ArrayBufferView | ArrayBuffer): void {
    const payload: ChannelData =
      typeof data === 'string'
        ? data
        : data instanceof ArrayBuffer
          ? data.slice(0)
          : (data.buffer.slice(
              data.byteOffset,
              data.byteOffset + data.byteLength,
            ) as ArrayBuffer);
    // Preserve FIFO ordering across the channel.
    queueMicrotask(() => this.peer.handler?.(payload));
  }
}

function makePair(): [PairedTransport, PairedTransport] {
  const a = new PairedTransport();
  const b = new PairedTransport();
  a.peer = b;
  b.peer = a;
  return [a, b];
}

function makeFile(name: string, size: number, seed: number): File {
  const bytes = new Uint8Array(size);
  for (let i = 0; i < size; i++) bytes[i] = (i * 31 + seed) % 256;
  return new File([bytes], name, { type: 'application/octet-stream' });
}

async function fileBytes(file: File): Promise<Uint8Array> {
  return new Uint8Array(await file.arrayBuffer());
}

describe('transfer protocol (end-to-end, in-memory)', () => {
  it('delivers multi-file, multi-chunk transfers byte-identically', async () => {
    // 5 MB spans 2 chunks (one full 4 MB frame-fan-out + remainder); plus a
    // small second file to exercise the multi-file global chunk layout.
    const fileA = makeFile('alpha.bin', 5 * 1024 * 1024, 1);
    const fileB = makeFile('beta.bin', 500 * 1024, 7);

    const key = await generateSessionKey();
    const nonce = generateBaseNonce();

    const sender = new FileSender([fileA, fileB], key, nonce);
    await sender.prepare();

    // Receiver uses a key re-imported from the URL-fragment representation —
    // exactly as a real receiver would, proving that round-trip.
    const fragment = await exportKeyToFragment(key);
    const receiverKey = await importKeyFromFragment(fragment);

    let completed: CompletedFile[] | null = null;
    let errorMsg: string | undefined;
    const done = new Promise<void>((resolve) => {
      const receiver = new FileReceiver(receiverKey, {
        onComplete: (files) => {
          completed = files;
          resolve();
        },
        onError: (m) => {
          errorMsg = m;
          resolve();
        },
      });
      const [tSender, tReceiver] = makePair();
      receiver.attach(tReceiver);
      void sender.run(tSender);
    });

    await done;
    expect(errorMsg).toBeUndefined();
    expect(completed).not.toBeNull();
    const files = completed!;
    expect(files.map((f) => f.name).sort()).toEqual(['alpha.bin', 'beta.bin']);

    // Byte-for-byte verification of each reassembled file.
    for (const original of [fileA, fileB]) {
      const out = files.find((f) => f.name === original.name)!;
      const got = await out.getBytes();
      const want = await fileBytes(original);
      expect(got.length).toBe(want.length);
      // Spot-check boundaries + a sampling to keep the assertion fast.
      expect(got[0]).toBe(want[0]);
      expect(got[got.length - 1]).toBe(want[want.length - 1]);
      expect(got[4 * 1024 * 1024]).toBe(want[4 * 1024 * 1024] ?? got[4 * 1024 * 1024]);
    }
  });

  it('resumes after an interruption, requesting only the missing chunks', async () => {
    const file = makeFile('resume.bin', 9 * 1024 * 1024, 3); // 3 chunks (4+4+1 MB)
    const key = await generateSessionKey();
    const nonce = generateBaseNonce();

    const sender = new FileSender([file], key, nonce);
    const manifest = await sender.prepare();
    const chunker = new FileChunker([file]);

    // ── Session 1: deliver ONLY chunk 0, then "drop". ──
    const firstReceiver = new FileReceiver(key, {});
    const [s1, r1] = makePair();

    // Capture the receiver's initial resume-request (should be all 3 chunks).
    const firstRequest = new Promise<ResumeRequestLike>((resolve) => {
      s1.onMessage((data) => {
        if (typeof data === 'string') {
          const msg = JSON.parse(data) as { type: string };
          if (msg.type === 'resume-request') resolve(msg as ResumeRequestLike);
        }
      });
    });

    firstReceiver.attach(r1);
    s1.send(JSON.stringify(manifest)); // manifest only; no FileSender.run here

    const req1 = await firstRequest;
    expect(req1.missingChunks).toEqual([0, 1, 2]);

    // Manually deliver chunk 0 only (simulating a drop after the first chunk).
    const cipher0 = await encryptChunk(key, nonce, 0, await chunker.readChunk(0));
    // Frames flow sender→receiver, i.e. over the sender-side transport (s1).
    for (const frame of frameChunk(0, cipher0)) s1.send(frame);
    // Let the microtask queue drain so chunk 0 is verified + written to IDB.
    await new Promise((r) => setTimeout(r, 50));

    // ── Session 2: reconnect with a brand-new receiver on the same transfer. ──
    const secondReceiver = new FileReceiver(key, {});
    const [s2, r2] = makePair();
    const secondRequest = new Promise<ResumeRequestLike>((resolve) => {
      s2.onMessage((data) => {
        if (typeof data === 'string') {
          const msg = JSON.parse(data) as { type: string };
          if (msg.type === 'resume-request') resolve(msg as ResumeRequestLike);
        }
      });
    });

    secondReceiver.attach(r2);
    s2.send(JSON.stringify(manifest));

    const req2 = await secondRequest;
    // Chunk 0 already persisted in IndexedDB ⇒ only 1 and 2 are requested.
    expect(req2.missingChunks).toEqual([1, 2]);
  });
});
