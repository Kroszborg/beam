import { describe, it, expect } from 'vitest';
import { CHUNK_SIZE, RECEIVE_WINDOW_CHUNKS, FRAME_KIND_CHUNK, type Manifest } from '@beam/shared';
import { generateSessionKey, generateBaseNonce } from '../crypto/index.js';
import { FileSender } from './fileSender.js';
import { FileReceiver, toRanges } from './fileReceiver.js';
import { TransferLayout } from './layout.js';
import { sealManifest, openManifest, validateManifest, ManifestError } from './manifest.js';
import { MemorySink, makePair, bytes } from '../testing/fakes.js';

/**
 * The whole v2 protocol over an in-memory channel: encrypted manifest, file
 * selection, chunk streaming with flow control, reconnect/resume, and the
 * integrity checks a tampering or confused peer would hit.
 */

const MB = 1024 * 1024;

function makeFiles(): File[] {
  return [
    new File([bytes(3 * MB + 12345, 1)], 'big.bin', { type: 'application/octet-stream' }),
    new File([], 'empty.txt'),
    new File([bytes(70_000, 2)], 'small.dat'),
  ];
}

async function setup(files = makeFiles()) {
  const key = await generateSessionKey();
  const sender = new FileSender(files, key, generateBaseNonce());
  let manifest: Manifest | null = null;
  const states: string[] = [];
  const errors: string[] = [];
  let completed = false;
  const receiver = new FileReceiver(key, {
    onManifest: (m) => (manifest = m),
    onState: (s) => states.push(s),
    onError: (e) => errors.push(e),
    onComplete: () => (completed = true),
  });
  const connect = () => {
    const [a, b] = makePair();
    const upload = sender.serve(a, {});
    receiver.attach(b);
    return { a, b, upload };
  };
  const until = async (cond: () => boolean, ms = 5000) => {
    const t = Date.now();
    while (!cond()) {
      if (Date.now() - t > ms) throw new Error(`timeout; states=${states.join(',')} errors=${errors.join(',')}`);
      await new Promise((r) => setTimeout(r, 2));
    }
  };
  return {
    key, sender, receiver, files, states, errors, connect, until,
    manifest: () => manifest,
    completed: () => completed,
  };
}

/** Byte equality without vitest's (very slow, for MBs) deep diffing. */
function same(a: Uint8Array | undefined, b: Uint8Array): boolean {
  return !!a && Buffer.compare(Buffer.from(a), Buffer.from(b)) === 0;
}

async function contents(files: File[]): Promise<Uint8Array[]> {
  return Promise.all(files.map(async (f) => new Uint8Array(await f.arrayBuffer())));
}

function sinkFor(m: Manifest, indices: number[], delayMs = 0) {
  return new MemorySink(indices.map((index) => ({ index, ...m.files[index]! })), delayMs);
}

describe('transfer protocol v2', () => {
  it('delivers every file byte-for-byte, including empty files', async () => {
    const t = await setup();
    t.connect();
    await t.until(() => t.manifest() !== null);
    const m = t.manifest()!;
    expect(m.files.map((f) => f.path)).toEqual(['big.bin', 'empty.txt', 'small.dat']);

    const sink = sinkFor(m, [0, 1, 2]);
    await t.receiver.accept([0, 1, 2], sink);
    await t.until(t.completed);

    const expected = await contents(t.files);
    expected.forEach((e, i) => expect(same(sink.data.get(i), e)).toBe(true));
    expect(sink.closed).toBe(true);
    expect(t.errors).toEqual([]);
  });

  it('sends only the files the receiver selected', async () => {
    const t = await setup();
    const { a } = t.connect();
    let chunkFrames = 0;
    a.tap = (d) => {
      if (typeof d !== 'string' && new Uint8Array(d)[0] === FRAME_KIND_CHUNK) chunkFrames++;
    };
    await t.until(() => t.manifest() !== null);
    const sink = sinkFor(t.manifest()!, [2]);
    await t.receiver.accept([2], sink);
    await t.until(t.completed);
    expect(same(sink.data.get(2), (await contents(t.files))[2]!)).toBe(true);
    expect(chunkFrames).toBe(2); // 70 000 bytes + tag in 64 KiB frames
  });

  it('resumes after the channel drops, without rewriting received chunks', async () => {
    const t = await setup([new File([bytes(12 * MB, 3)], 'resume.bin')]);
    const first = t.connect();
    await t.until(() => t.manifest() !== null);
    const sink = sinkFor(t.manifest()!, [0], 1);
    await t.receiver.accept([0], sink);
    await t.until(() => sink.writes >= 4);
    first.a.close();

    t.connect();
    await t.until(t.completed);
    expect(same(sink.data.get(0), (await contents(t.files))[0]!)).toBe(true);
    expect(sink.writes).toBe(12);
  });

  it('never lets the sender run more than the window ahead of the disk', async () => {
    const t = await setup([new File([bytes(48 * MB, 4)], 'slow.bin')]);
    const { a, b } = t.connect();
    let sent = 0;
    let acked = 0;
    let maxAhead = 0;
    a.tap = (d) => {
      if (typeof d === 'string') return;
      const v = new DataView(d);
      // Count each chunk once, on its last frame.
      if (v.getUint8(0) === FRAME_KIND_CHUNK) {
        sent += d.byteLength - 12;
      }
    };
    b.tap = (d) => {
      if (typeof d === 'string' && d.includes('"ack"')) acked += 1;
    };
    await t.until(() => t.manifest() !== null);
    const sink = sinkFor(t.manifest()!, [0], 2);
    const watcher = setInterval(() => {
      const chunksSent = Math.floor(sent / (CHUNK_SIZE + 16));
      maxAhead = Math.max(maxAhead, chunksSent - acked);
    }, 1);
    await t.receiver.accept([0], sink);
    await t.until(t.completed, 20_000);
    clearInterval(watcher);
    expect(maxAhead).toBeLessThanOrEqual(RECEIVE_WINDOW_CHUNKS);
    expect(sink.maxPending).toBe(1); // writes are strictly serial
  });

  it('rejects a tampered chunk', async () => {
    const t = await setup();
    const { a } = t.connect();
    a.tamper = (frame) => {
      if (frame[0] === FRAME_KIND_CHUNK && frame.length > 100) frame[50]! ^= 0xff;
    };
    await t.until(() => t.manifest() !== null);
    const sink = sinkFor(t.manifest()!, [0]);
    await t.receiver.accept([0], sink);
    await t.until(() => t.errors.length > 0);
    expect(t.errors[0]).toMatch(/authentication/);
    expect(sink.aborted).toBe(true);
  });

  it('refuses a manifest sealed with a different key', async () => {
    const t = await setup();
    const otherKey = await generateSessionKey();
    const sealed = await sealManifest(otherKey, generateBaseNonce(), t.sender.manifest);
    await expect(openManifest(t.key, sealed)).rejects.toBeInstanceOf(ManifestError);
    const ok = await openManifest(t.key, await t.sender.sealedManifest());
    expect(ok.manifest).toEqual(t.sender.manifest);
  });

  it('validates manifest totals and versions', () => {
    const m = { ...new FileSender(makeFiles(), {} as CryptoKey, new Uint8Array(8)).manifest };
    expect(() => validateManifest({ ...m, totalBytes: m.totalBytes + 1 })).toThrow(ManifestError);
    expect(() => validateManifest({ ...m, totalChunks: 1 })).toThrow(ManifestError);
    expect(() => validateManifest({ ...m, v: 1 })).toThrow(/different version/);
    expect(() => validateManifest({ ...m, files: [{ path: '', size: 1 }] })).toThrow(ManifestError);
    expect(validateManifest(m)).toEqual(m);
  });
});

describe('layout + ranges', () => {
  it('maps chunks to files, with empty files owning one chunk', () => {
    const l = new TransferLayout([{ size: 2.5 * MB }, { size: 0 }, { size: MB }], MB);
    expect(l.totalChunks).toBe(5);
    expect(l.target(2)).toEqual({ fileIndex: 0, byteStart: 2 * MB, length: 0.5 * MB });
    expect(l.target(3)).toEqual({ fileIndex: 1, byteStart: 0, length: 0 });
    expect(l.target(4)).toEqual({ fileIndex: 2, byteStart: 0, length: MB });
    expect(l.range(2)).toEqual({ start: 4, count: 1 });
    expect(() => l.target(5)).toThrow(RangeError);
  });

  it('compresses index lists into ranges', () => {
    expect(toRanges([0, 1, 2, 5, 6, 9])).toEqual([[0, 3], [5, 7], [9, 10]]);
    expect(toRanges([])).toEqual([]);
  });
});
