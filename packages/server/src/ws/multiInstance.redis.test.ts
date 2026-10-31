import { describe, it, expect, afterAll } from 'vitest';
import { Redis } from 'ioredis';
import type { AddressInfo } from 'node:net';
import { buildApp, type BuiltApp } from '../app.js';
import { PEER_ID_LENGTH, type ServerToClientMessage } from '@beam/shared';

/**
 * Two server instances sharing a real Redis: a sender on one and a receiver on
 * the other must still find each other, exchange signals and relay frames.
 * Needs a live Redis — run with BEAM_TEST_REDIS=redis://localhost:6379.
 */
const url = process.env.BEAM_TEST_REDIS;
const apps: BuiltApp[] = [];
afterAll(async () => {
  for (const a of apps) {
    await a.app.close();
    await a.close();
  }
});

async function instance(): Promise<string> {
  const built = await buildApp({ redis: new Redis(url!) });
  apps.push(built);
  await built.app.listen({ port: 0, host: '127.0.0.1' });
  return `ws://127.0.0.1:${(built.app.server.address() as AddressInfo).port}/ws`;
}

function client(wsUrl: string) {
  const ws = new WebSocket(wsUrl);
  ws.binaryType = 'arraybuffer';
  const inbox: (ServerToClientMessage | Uint8Array)[] = [];
  ws.addEventListener('message', (e) =>
    inbox.push(typeof e.data === 'string' ? JSON.parse(e.data) : new Uint8Array(e.data as ArrayBuffer)),
  );
  const take = async <T>(pick: (m: ServerToClientMessage | Uint8Array) => boolean): Promise<T> => {
    const end = Date.now() + 5000;
    for (;;) {
      const i = inbox.findIndex(pick);
      if (i >= 0) return inbox.splice(i, 1)[0] as T;
      if (Date.now() > end) throw new Error('timeout');
      await new Promise((r) => setTimeout(r, 20));
    }
  };
  return {
    ws,
    opened: new Promise((r) => ws.addEventListener('open', r, { once: true })),
    send: (m: unknown) => ws.send(JSON.stringify(m)),
    next: <K extends ServerToClientMessage['type']>(type: K) =>
      take<Extract<ServerToClientMessage, { type: K }>>((m) => !(m instanceof Uint8Array) && m.type === type),
    binary: () => take<Uint8Array>((m) => m instanceof Uint8Array),
  };
}

describe.skipIf(!url)('signaling across instances (real Redis)', () => {
  it('routes presence, signals and relay frames between instances', async () => {
    const [a, b] = [await instance(), await instance()];
    const sender = client(a);
    const receiver = client(b);
    await Promise.all([sender.opened, receiver.opened]);

    sender.send({ type: 'create-room' });
    const created = await sender.next('room-created');
    receiver.send({ type: 'join-room', roomId: created.roomId });
    const joined = await receiver.next('room-joined');
    expect((await sender.next('peer-joined')).peerId).toBe(joined.peerId);

    sender.send({ type: 'signal', roomId: created.roomId, to: joined.peerId, data: { kind: 'relay' } });
    expect((await receiver.next('signal')).from).toBe(created.peerId);

    const frame = new Uint8Array(PEER_ID_LENGTH + 1 + 3);
    frame.set(new TextEncoder().encode(joined.peerId));
    frame[PEER_ID_LENGTH] = 1;
    frame.set([7, 8, 9], PEER_ID_LENGTH + 1);
    sender.ws.send(frame);
    const got = await receiver.binary();
    expect([...got.subarray(PEER_ID_LENGTH)]).toEqual([1, 7, 8, 9]);

    receiver.ws.close();
    expect((await sender.next('peer-left')).peerId).toBe(joined.peerId);
    sender.ws.close();
  });
});
