import { describe, it, expect } from 'vitest';
import { SenderSession, type ReceiverStatus, type SenderRoomInfo, type SenderCode } from './senderSession.js';
import { ReceiverSession, type ReceiveTarget } from './receiverSession.js';
import type { SessionDeps } from './deps.js';
import type { SignalingClient } from '../signaling/signalingClient.js';
import type { PeerConnection } from '../webrtc/index.js';
import {
  FakeNetwork,
  FakePeer,
  FakeServer,
  FakeSignaling,
  FakeStore,
  MemorySink,
  bytes,
} from '../testing/fakes.js';
import type { StoreApi } from '../store/storeApi.js';
import type { CopyStatus } from '../store/storeUploader.js';

/**
 * SenderSession / ReceiverSession orchestration with fake signaling and peer
 * connections, running the real transfer pipeline over in-memory channels:
 * several receivers on one link, the relay fallback, and recovery from a
 * connection dropped mid-transfer.
 */

const MB = 1024 * 1024;

function world() {
  const server = new FakeServer();
  const net = new FakeNetwork();
  const sinks: MemorySink[] = [];
  const store = new FakeStore();
  const deps: SessionDeps = {
    store: store as unknown as StoreApi,
    storeFallbackMs: 30,
    createSignaling: () => new FakeSignaling(server) as unknown as SignalingClient,
    createPeer: (role, remoteId, signaling, _ice) =>
      new FakePeer(role, (signaling as unknown as FakeSignaling).peerId, remoteId, net) as unknown as PeerConnection,
    fetchIce: async () => ({ iceServers: [], relay: true }),
    relayAfterMs: 30,
    chooseSink: async (_kind, _id, files) => {
      const sink = new MemorySink(files, 0);
      sinks.push(sink);
      return sink;
    },
  };
  return { net, sinks, deps, store };
}

async function until(cond: () => boolean, ms = 8000): Promise<void> {
  const t = Date.now();
  while (!cond()) {
    if (Date.now() - t > ms) throw new Error('timeout');
    await new Promise((r) => setTimeout(r, 2));
  }
}

async function startSender(deps: SessionDeps, files: File[]) {
  const sender = new SenderSession('http://x', 'https://beam.test', deps);
  let room: SenderRoomInfo | null = null;
  let receivers: ReceiverStatus[] = [];
  sender.on('room', (r) => (room = r));
  let code: SenderCode | null = null;
  let copy: CopyStatus | null = null;
  sender.on('copy', (c) => (copy = c));
  sender.on('receivers', (r) => (receivers = r));
  sender.on('code', (c) => (code = c));
  await sender.start(files);
  await until(() => room !== null);
  return { sender, room: room!, receivers: () => receivers, code: () => code, copy: () => copy };
}

function linkTarget(room: SenderRoomInfo): ReceiveTarget {
  const url = new URL(room.shareUrl);
  return { roomId: url.pathname.split('/').pop()!, keyFragment: url.hash.slice(1) };
}

/** Start a receiver; resolves once the file list arrived (or it failed). */
async function startReceiver(deps: SessionDeps, target: SenderRoomInfo | ReceiveTarget) {
  const rx = new ReceiverSession('http://x', deps);
  let ready = false;
  let complete = false;
  let error: string | null = null;
  let route: string | null = null;
  rx.on('state', (s) => {
    if (s === 'ready') ready = true;
  });
  rx.on('error', (e) => (error = e));
  rx.on('complete', () => (complete = true));
  rx.on('route', (r) => (route = r));
  await rx.start('shareUrl' in target ? linkTarget(target) : target);
  await until(() => ready || error !== null);
  return { rx, complete: () => complete, route: () => route, error: () => error };
}

const same = (a: Uint8Array | undefined, b: Uint8Array) =>
  !!a && Buffer.compare(Buffer.from(a), Buffer.from(b)) === 0;

describe('sessions', () => {
  it('serves several receivers from one link, each choosing files', async () => {
    const { deps, sinks } = world();
    const data = [bytes(5 * MB + 3, 1), bytes(200_000, 2)];
    const { room, receivers } = await startSender(deps, [
      new File([data[0]!], 'a.bin'),
      new File([data[1]!], 'b.bin'),
    ]);

    const r1 = await startReceiver(deps, room);
    const r2 = await startReceiver(deps, room);
    await Promise.all([r1.rx.accept([0, 1], 'idb'), r2.rx.accept([1], 'idb')]);
    await until(() => r1.complete() && r2.complete());

    expect(same(sinks[0]!.data.get(0), data[0]!)).toBe(true);
    expect(same(sinks[0]!.data.get(1), data[1]!)).toBe(true);
    expect([...sinks[1]!.data.keys()]).toEqual([1]);
    expect(same(sinks[1]!.data.get(1), data[1]!)).toBe(true);
    await until(() => receivers().every((r) => r.state === 'complete'));
    expect(receivers().map((r) => r.ordinal)).toEqual([1, 2]);
  });

  it('falls back to the encrypted relay when peers cannot connect directly', async () => {
    const { deps, sinks, net } = world();
    net.direct = false;
    const data = bytes(3 * MB, 3);
    const { room, receivers } = await startSender(deps, [new File([data], 'r.bin')]);
    const r = await startReceiver(deps, room);
    expect(r.route()).toBe('relay');
    await r.rx.accept([0], 'idb');
    await until(r.complete);
    expect(same(sinks[0]!.data.get(0), data)).toBe(true);
    expect(receivers()[0]!.route).toBe('relay');
  });

  it('receives with a short code via CPace, without the link key', async () => {
    const { deps, sinks } = world();
    const data = bytes(2 * MB + 5, 5);
    const s = await startSender(deps, [new File([data], 'c.bin')]);
    await s.sender.createCode();
    const code = s.code()!.code;
    expect(code).toMatch(/^\d+-[a-z]+-[a-z]+$/);

    const r = await startReceiver(deps, { code: code.toUpperCase().replace(/-/g, ' ') });
    expect(r.error()).toBeNull();
    await r.rx.accept([0], 'idb');
    await until(r.complete);
    expect(same(sinks[0]!.data.get(0), data)).toBe(true);
    expect(s.code()!.attemptsLeft).toBe(3); // the successful run was refunded
  });

  it('refuses wrong codes and disables the code after three', async () => {
    const { deps } = world();
    const s = await startSender(deps, [new File([bytes(1000, 6)], 'w.bin')]);
    await s.sender.createCode();
    const [nameplate, w1, w2] = s.code()!.code.split('-');
    const wrong = `${nameplate}-${w1}-${w2 === 'tiger' ? 'zebra' : 'tiger'}`;

    for (let i = 0; i < 3; i++) {
      const r = await startReceiver(deps, { code: wrong });
      expect(r.error()).toMatch(i < 2 ? /doesn't match/ : /stopped working/);
    }
    expect(s.code()).toMatchObject({ attemptsLeft: 0, disabled: true });
    const late = await startReceiver(deps, { code: s.code()!.code });
    expect(late.error()).toMatch(/stopped working/);
    expect(s.receivers()).toEqual([]); // nobody was ever connected
  });

  it('refuses a link whose key was tampered with', async () => {
    const { deps } = world();
    const s = await startSender(deps, [new File([bytes(1000, 7)], 't.bin')]);
    const target = linkTarget(s.room) as { roomId: string; keyFragment: string };
    const forged = { roomId: target.roomId, keyFragment: 'A'.repeat(43) };
    const r = await startReceiver(deps, forged);
    expect(r.error()).toMatch(/couldn't verify/);
    expect(s.receivers()).toEqual([]);
  });

  it('downloads the stored copy after the sender has closed the tab', async () => {
    const { deps, sinks } = world();
    const data = bytes(3 * MB + 77, 8);
    const s = await startSender(deps, [new File([data], 'kept.bin')]);
    s.sender.keepCopy();
    await until(() => s.copy()?.state === 'ready');
    expect(s.copy()!.uploadedBytes).toBe(s.copy()!.totalBytes);
    s.sender.close(); // tab closed: the room is gone

    const r = await startReceiver(deps, s.room);
    expect(r.error()).toBeNull();
    expect(r.route()).toBe('stored');
    await r.rx.accept([0], 'idb');
    await until(r.complete);
    expect(same(sinks[0]!.data.get(0), data)).toBe(true);
  });

  it('switches to the stored copy when the sender leaves mid-transfer, resuming from the gap', async () => {
    const { deps, sinks } = world();
    const data = bytes(48 * MB, 9); // more than the 32-chunk window, so the copy must finish it
    const s = await startSender(deps, [new File([data], 'mid.bin')]);
    s.sender.keepCopy();
    await until(() => s.copy()?.state === 'ready');

    const r = await startReceiver(deps, s.room);
    expect(r.route()).toBe('lan');
    await r.rx.accept([0], 'idb');
    await until(() => sinks[0]!.writes >= 3);
    s.sender.close();
    await until(r.complete);
    expect(r.route()).toBe('stored');
    expect(same(sinks[0]!.data.get(0), data)).toBe(true);
    expect(sinks[0]!.writes).toBe(48); // nothing written twice
  });

  it('streams from the copy while it is still uploading', async () => {
    const { deps, sinks, store } = world();
    store.uploadDelayMs = 15;
    const data = bytes(6 * MB, 10);
    const s = await startSender(deps, [new File([data], 'live.bin')]);
    s.sender.keepCopy();
    await until(() => (s.copy()?.uploadedBytes ?? 0) > 0);
    s.sender.close();

    const r = await startReceiver(deps, s.room);
    expect(r.route()).toBe('stored');
    expect(store.copies.values().next().value!.complete).toBe(false);
    await r.rx.accept([0], 'idb');
    await until(r.complete);
    expect(same(sinks[0]!.data.get(0), data)).toBe(true);
  });

  it('renegotiates and resumes when the direct channel drops mid-transfer', async () => {
    const { deps, sinks, net } = world();
    const data = bytes(16 * MB, 4);
    const { room } = await startSender(deps, [new File([data], 'd.bin')]);
    const r = await startReceiver(deps, room);
    await r.rx.accept([0], 'idb');
    await until(() => sinks[0]!.writes >= 3);
    net.pairs.at(-1)![0].close();
    await until(r.complete);
    expect(net.pairs.length).toBe(2);
    expect(same(sinks[0]!.data.get(0), data)).toBe(true);
    expect(sinks[0]!.writes).toBe(16);
  });
});
