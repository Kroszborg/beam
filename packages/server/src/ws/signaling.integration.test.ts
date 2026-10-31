import { describe, it, expect, afterEach } from 'vitest';
import RedisMock from 'ioredis-mock';
import type { Redis } from 'ioredis';
import type { AddressInfo } from 'node:net';
import { buildApp, type BuiltApp } from '../app.js';
import { PEER_ID_LENGTH, type ServerToClientMessage } from '@beam/shared';

/**
 * Full signaling over real WebSockets against the Fastify app, for both room
 * backends: room creation, multi-receiver presence, addressed signal routing,
 * relay frames, and cleanup. Uses Node's global WebSocket client (Node 22+).
 */

let built: BuiltApp | null = null;
const sockets: WebSocket[] = [];

afterEach(async () => {
  for (const s of sockets.splice(0)) s.close();
  await built?.app.close();
  await built?.close();
  built = null;
});

/** Buffered reader so no message is lost between awaits. */
function client(url: string) {
  const ws = new WebSocket(url);
  ws.binaryType = 'arraybuffer';
  sockets.push(ws);
  const json: ServerToClientMessage[] = [];
  const binary: Uint8Array[] = [];
  const waiters: (() => void)[] = [];
  ws.addEventListener('message', (e) => {
    if (typeof e.data === 'string') json.push(JSON.parse(e.data) as ServerToClientMessage);
    else binary.push(new Uint8Array(e.data as ArrayBuffer));
    waiters.splice(0).forEach((w) => w());
  });
  const until = async <T>(take: () => T | undefined, what: string): Promise<T> => {
    const deadline = Date.now() + 3000;
    for (;;) {
      const v = take();
      if (v !== undefined) return v;
      if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
      await new Promise<void>((r) => {
        waiters.push(r);
        setTimeout(r, 50);
      });
    }
  };
  return {
    ws,
    opened: new Promise<void>((r) => ws.addEventListener('open', () => r(), { once: true })),
    send: (m: unknown) => ws.send(JSON.stringify(m)),
    next: <K extends ServerToClientMessage['type']>(type: K) =>
      until(() => {
        const i = json.findIndex((m) => m.type === type);
        return i >= 0 ? (json.splice(i, 1)[0] as Extract<ServerToClientMessage, { type: K }>) : undefined;
      }, type),
    nextBinary: () => until(() => binary.shift(), 'binary frame'),
  };
}

async function start(backend: 'memory' | 'redis') {
  built = await buildApp(backend === 'redis' ? { redis: new RedisMock() as unknown as Redis } : {});
  await built.app.listen({ port: 0, host: '127.0.0.1' });
  const { port } = built.app.server.address() as AddressInfo;
  return `ws://127.0.0.1:${port}/ws`;
}

describe.each(['memory', 'redis'] as const)('signaling (%s backend)', (backend) => {
  it('routes presence and signals between a sender and several receivers', async () => {
    const url = await start(backend);
    const sender = client(url);
    await sender.opened;
    sender.send({ type: 'create-room' });
    const created = await sender.next('room-created');
    expect(created.peerId).toHaveLength(PEER_ID_LENGTH);
    const { roomId } = created;

    const r1 = client(url);
    const r2 = client(url);
    await Promise.all([r1.opened, r2.opened]);
    r1.send({ type: 'join-room', roomId });
    const j1 = await r1.next('room-joined');
    expect(j1.ownerId).toBe(created.peerId);
    expect((await sender.next('peer-joined')).peerId).toBe(j1.peerId);

    r2.send({ type: 'join-room', roomId });
    const j2 = await r2.next('room-joined');
    expect((await sender.next('peer-joined')).peerId).toBe(j2.peerId);

    // Sender → one specific receiver.
    sender.send({ type: 'signal', roomId, to: j2.peerId, data: { kind: 'sdp', description: { type: 'offer', sdp: 'v=0' } } });
    const got = await r2.next('signal');
    expect(got.from).toBe(created.peerId);
    expect(got.data.kind).toBe('sdp');

    // Receiver → always the sender, tagged with who sent it.
    r1.send({ type: 'signal', roomId, data: { kind: 'ice', candidate: null } });
    expect((await sender.next('signal')).from).toBe(j1.peerId);

    // A receiver leaving is reported to the sender only.
    r1.ws.close();
    expect((await sender.next('peer-left')).peerId).toBe(j1.peerId);

    // The sender leaving is reported to the remaining receivers.
    sender.ws.close();
    expect((await r2.next('peer-left')).peerId).toBe(created.peerId);
  });

  it('maps a short-code nameplate to the room, and frees it with the room', async () => {
    const url = await start(backend);
    const sender = client(url);
    await sender.opened;
    sender.send({ type: 'create-code' });
    expect((await sender.next('error')).code).toBe('invalid-message'); // not in a room yet

    sender.send({ type: 'create-room' });
    const { roomId } = await sender.next('room-created');
    sender.send({ type: 'create-code' });
    const { nameplate } = await sender.next('code-created');
    expect(nameplate).toMatch(/^\d{1,2}$/);
    sender.send({ type: 'create-code' });
    expect((await sender.next('code-created')).nameplate).toBe(nameplate); // idempotent

    const rx = client(url);
    await rx.opened;
    rx.send({ type: 'resolve-code', nameplate });
    expect(await rx.next('code-resolved')).toMatchObject({ nameplate, roomId });
    rx.send({ type: 'resolve-code', nameplate: 'abc' });
    expect((await rx.next('error')).code).toBe('code-not-found');

    sender.ws.close();
    await new Promise((r) => setTimeout(r, 100));
    rx.send({ type: 'resolve-code', nameplate });
    expect((await rx.next('error')).code).toBe('code-not-found');
  });

  it('rate-limits code lookups per connection', async () => {
    const url = await start(backend);
    const rx = client(url);
    await rx.opened;
    for (let i = 0; i < 10; i++) {
      rx.send({ type: 'resolve-code', nameplate: String(i + 1) });
      expect((await rx.next('error')).code).toBe('code-not-found');
    }
    rx.send({ type: 'resolve-code', nameplate: '11' });
    expect((await rx.next('error')).code).toBe('rate-limited');
  });

  it('relays binary frames with the source peer id swapped in', async () => {
    const url = await start(backend);
    const sender = client(url);
    await sender.opened;
    sender.send({ type: 'create-room' });
    const created = await sender.next('room-created');
    const r = client(url);
    await r.opened;
    r.send({ type: 'join-room', roomId: created.roomId });
    const joined = await r.next('room-joined');

    const frame = (to: string, payload: number[]) => {
      const b = new Uint8Array(PEER_ID_LENGTH + 1 + payload.length);
      b.set(new TextEncoder().encode(to), 0);
      b[PEER_ID_LENGTH] = 1;
      b.set(payload, PEER_ID_LENGTH + 1);
      return b;
    };

    sender.ws.send(frame(joined.peerId, [1, 2, 3]));
    const atReceiver = await r.nextBinary();
    expect(new TextDecoder().decode(atReceiver.subarray(0, PEER_ID_LENGTH))).toBe(created.peerId);
    expect([...atReceiver.subarray(PEER_ID_LENGTH)]).toEqual([1, 1, 2, 3]);

    // A receiver's frame always goes to the sender, whatever it addresses.
    r.ws.send(frame('x'.repeat(PEER_ID_LENGTH), [9]));
    const atSender = await sender.nextBinary();
    expect(new TextDecoder().decode(atSender.subarray(0, PEER_ID_LENGTH))).toBe(joined.peerId);
  });

  it('lets a peer rejoin under the same id after its socket drops', async () => {
    const url = await start(backend);
    const sender = client(url);
    await sender.opened;
    sender.send({ type: 'create-room' });
    const created = await sender.next('room-created');
    const r = client(url);
    await r.opened;
    r.send({ type: 'join-room', roomId: created.roomId });
    const joined = await r.next('room-joined');
    await sender.next('peer-joined');

    // Forged token is refused.
    const forged = client(url);
    await forged.opened;
    forged.send({ type: 'rejoin-room', roomId: created.roomId, peerId: created.peerId, role: 'sender', token: 'x'.repeat(43) });
    expect((await forged.next('error')).message).toMatch(/token/);

    // Sender's socket drops; it comes back with its token and is still owner.
    sender.ws.close();
    await r.next('peer-left');
    const back = client(url);
    await back.opened;
    back.send({ type: 'rejoin-room', roomId: created.roomId, peerId: created.peerId, role: 'sender', token: created.token });
    const rejoined = await back.next('room-rejoined');
    expect(rejoined.ownerId).toBe(created.peerId);
    expect(rejoined.members).toContain(joined.peerId);

    // Routing works under the old identity.
    r.send({ type: 'signal', roomId: created.roomId, data: { kind: 'ice', candidate: null } });
    expect((await back.next('signal')).from).toBe(joined.peerId);
  });

  it('rejects unknown rooms and frames from peers outside a room', async () => {
    const url = await start(backend);
    const c = client(url);
    await c.opened;
    c.send({ type: 'join-room', roomId: 'nope' });
    expect((await c.next('error')).code).toBe('room-not-found');
    c.send({ type: 'signal', roomId: 'nope', data: { kind: 'ice', candidate: null } });
    expect((await c.next('error')).code).toBe('not-in-room');
  });
});
