import { describe, it, expect } from 'vitest';
import { SenderSession, type ReceiverStatus, type SenderRoomInfo } from './senderSession.js';
import { ReceiverSession } from './receiverSession.js';
import type { SessionDeps } from './deps.js';
import type { SignalingClient } from '../signaling/signalingClient.js';
import type { PeerConnection } from '../webrtc/index.js';
import {
  FakeNetwork,
  FakePeer,
  FakeServer,
  FakeSignaling,
  MemorySink,
  bytes,
} from '../testing/fakes.js';

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
  const deps: SessionDeps = {
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
  return { net, sinks, deps };
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
  sender.on('receivers', (r) => (receivers = r));
  await sender.start(files);
  await until(() => room !== null);
  return { sender, room: room!, receivers: () => receivers };
}

async function startReceiver(deps: SessionDeps, room: SenderRoomInfo) {
  const rx = new ReceiverSession('http://x', deps);
  const url = new URL(room.shareUrl);
  let ready = false;
  let complete = false;
  let route: string | null = null;
  rx.on('state', (s) => {
    if (s === 'ready') ready = true;
  });
  rx.on('complete', () => (complete = true));
  rx.on('route', (r) => (route = r));
  await rx.start(url.pathname.split('/').pop()!, url.hash.slice(1));
  await until(() => ready);
  return { rx, complete: () => complete, route: () => route };
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
