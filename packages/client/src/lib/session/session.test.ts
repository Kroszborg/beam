import 'fake-indexeddb/auto';
import { describe, it, expect } from 'vitest';
import { SenderSession, type SenderRoomInfo } from './senderSession.js';
import { ReceiverSession } from './receiverSession.js';
import type { SessionDeps } from './deps.js';
import type { SignalingClient } from '../signaling/signalingClient.js';
import type { PeerConnection } from '../webrtc/index.js';
import type { Transport, ChannelData } from '../webrtc/transport.js';
import type { CompletedFile } from '../transfer/index.js';
import { Emitter } from '../events.js';

/**
 * Exercises the SenderSession / ReceiverSession orchestration end-to-end with
 * in-memory fakes for the signaling client and peer connection. The real
 * FileSender/FileReceiver still run over a paired in-memory transport, so this
 * validates the reconnect + multi-receiver logic (the part that had the bug)
 * against the actual transfer pipeline — no browser or WebRTC needed.
 */

// ── Paired in-memory transport ────────────────────────────────
class PairedTransport implements Transport {
  readyState: RTCDataChannelState = 'open';
  peer!: PairedTransport;
  private handler: ((d: ChannelData) => void) | null = null;
  onMessage(h: (d: ChannelData) => void): void {
    this.handler = h;
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
          : (data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) as ArrayBuffer);
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

// ── Fake signaling bus + client ───────────────────────────────
type Ev = {
  open: void;
  'peer-joined': { roomId: string };
  'peer-left': { roomId: string };
  signal: unknown;
  error: { code: string; message: string };
  close: void;
  reconnecting: { attempt: number };
};

class Bus {
  private rooms = new Map<string, Set<FakeSignaling>>();
  private counter = 0;
  create(client: FakeSignaling): string {
    const roomId = `room${this.counter++}`;
    this.rooms.set(roomId, new Set([client]));
    return roomId;
  }
  join(roomId: string, client: FakeSignaling): boolean {
    const set = this.rooms.get(roomId);
    if (!set) return false;
    set.add(client);
    for (const other of set) if (other !== client) other.emit('peer-joined', { roomId });
    return true;
  }
  leave(roomId: string, client: FakeSignaling): void {
    const set = this.rooms.get(roomId);
    if (!set) return;
    set.delete(client);
    for (const other of set) other.emit('peer-left', { roomId });
  }
}

class FakeSignaling {
  private readonly emitter = new Emitter<Ev>();
  roomId: string | null = null;
  constructor(private readonly bus: Bus) {}
  readonly on = this.emitter.on.bind(this.emitter);
  emit = this.emitter.emit.bind(this.emitter);
  connect(): Promise<void> {
    return Promise.resolve();
  }
  createRoom(): Promise<{ roomId: string; role: 'sender' }> {
    this.roomId = this.bus.create(this);
    return Promise.resolve({ roomId: this.roomId, role: 'sender' });
  }
  joinRoom(roomId: string): Promise<{ roomId: string; role: 'receiver' }> {
    this.roomId = roomId;
    if (!this.bus.join(roomId, this)) return Promise.reject(new Error('room-not-found'));
    return Promise.resolve({ roomId, role: 'receiver' });
  }
  sendSignal(): void {
    /* fake peers pair via the registry, not SDP/ICE relay */
  }
  close(): void {
    if (this.roomId) this.bus.leave(this.roomId, this);
    this.emitter.clear();
  }
}

// ── Fake peer connection with rendezvous pairing ──────────────
interface Pairing {
  senders: Map<string, FakePeer>;
  receivers: Map<string, FakePeer>;
}

class FakePeer {
  private readonly emitter = new Emitter<{
    'channel-open': Transport;
    connected: void;
    failed: void;
    disconnected: void;
    state: RTCPeerConnectionState;
  }>();
  connectionState: RTCPeerConnectionState = 'new';
  paired = false;
  readonly on = this.emitter.on.bind(this.emitter);

  constructor(
    private readonly role: 'sender' | 'receiver',
    private readonly roomId: string,
    private readonly reg: Pairing,
  ) {
    if (role === 'receiver') {
      reg.receivers.set(roomId, this);
      this.tryPair();
    }
  }
  async start(): Promise<void> {
    if (this.role === 'sender') {
      this.reg.senders.set(this.roomId, this);
      this.tryPair();
    }
  }
  private tryPair(): void {
    const s = this.reg.senders.get(this.roomId);
    const r = this.reg.receivers.get(this.roomId);
    if (s && r && !s.paired && !r.paired) {
      s.paired = r.paired = true;
      const [a, b] = makePair();
      queueMicrotask(() => {
        s.connectionState = r.connectionState = 'connected';
        s.emitter.emit('channel-open', a);
        r.emitter.emit('channel-open', b);
      });
    }
  }
  close(): void {
    if (this.reg.senders.get(this.roomId) === this) this.reg.senders.delete(this.roomId);
    if (this.reg.receivers.get(this.roomId) === this) this.reg.receivers.delete(this.roomId);
    this.connectionState = 'closed';
    this.emitter.clear();
  }
}

function makeEnv(): SessionDeps {
  const bus = new Bus();
  const reg: Pairing = { senders: new Map(), receivers: new Map() };
  return {
    fetchIce: () => Promise.resolve([]),
    createSignaling: () => new FakeSignaling(bus) as unknown as SignalingClient,
    createPeer: (role, roomId) => new FakePeer(role, roomId, reg) as unknown as PeerConnection,
  };
}

function makeFile(name: string, size: number, seed: number): File {
  const bytes = new Uint8Array(size);
  for (let i = 0; i < size; i++) bytes[i] = (i * 31 + seed) % 256;
  return new File([bytes], name, { type: 'application/octet-stream' });
}

function parseShare(info: SenderRoomInfo): { roomId: string; key: string } {
  const [, key] = info.shareUrl.split('#');
  return { roomId: info.roomId, key: key! };
}

describe('session orchestration', () => {
  it('transfers a file end-to-end through the session layer', async () => {
    const deps = makeEnv();
    const file = makeFile('hello.bin', 200 * 1024, 5);
    const sender = new SenderSession('http://test', 'http://test', deps);

    const room = await new Promise<SenderRoomInfo>((resolve) => {
      sender.on('room', resolve);
      void sender.start([file]);
    });
    const { roomId, key } = parseShare(room);

    const files = await new Promise<CompletedFile[]>((resolve, reject) => {
      const receiver = new ReceiverSession('http://test', deps);
      receiver.on('complete', resolve);
      receiver.on('error', (m) => reject(new Error(m)));
      void receiver.start(roomId, key);
    });

    expect(files).toHaveLength(1);
    const got = await files[0]!.getBytes();
    expect(got.length).toBe(file.size);
    expect(got[0]).toBe(5);
  });

  it('lets a SECOND device reuse the same link after the first disconnects', async () => {
    const deps = makeEnv();
    const file = makeFile('shared.bin', 150 * 1024, 9);
    const sender = new SenderSession('http://test', 'http://test', deps);

    const room = await new Promise<SenderRoomInfo>((resolve) => {
      sender.on('room', resolve);
      void sender.start([file]);
    });
    const { roomId, key } = parseShare(room);

    // Receiver 1 connects, completes, then disconnects.
    const receiver1 = new ReceiverSession('http://test', deps);
    const files1 = await new Promise<CompletedFile[]>((resolve, reject) => {
      receiver1.on('complete', resolve);
      receiver1.on('error', (m) => reject(new Error(m)));
      void receiver1.start(roomId, key);
    });
    expect(files1).toHaveLength(1);
    receiver1.close();

    // Give the sender a tick to process peer-left.
    await new Promise((r) => setTimeout(r, 20));

    // Receiver 2 reuses the same room + key — this used to hang.
    const receiver2 = new ReceiverSession('http://test', deps);
    const files2 = await new Promise<CompletedFile[]>((resolve, reject) => {
      receiver2.on('complete', resolve);
      receiver2.on('error', (m) => reject(new Error(m)));
      void receiver2.start(roomId, key);
    });
    expect(files2).toHaveLength(1);
    const got = await files2[0]!.getBytes();
    expect(got.length).toBe(file.size);
  });
});
