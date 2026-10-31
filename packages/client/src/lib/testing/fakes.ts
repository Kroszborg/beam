/**
 * In-memory stand-ins for the network and disk, shared by the protocol and
 * session tests: a paired transport (with optional frame tampering and
 * close-on-demand), a memory sink (with optional slow writes), and fake
 * signaling + peer connections that route by peer id like the real server.
 */
import type { ChannelData, Transport } from '../webrtc/transport.js';
import type { FileSink, SinkChunk, SinkFile } from '../transfer/sinks/types.js';
import { Emitter } from '../events.js';
import type { SignalPayload } from '@beam/shared';

// ── Transport ─────────────────────────────────────────────────

export class PairedTransport implements Transport {
  readyState: RTCDataChannelState = 'open';
  bufferedAmount = 0;
  maxMessageSize = 64 * 1024;
  peer!: PairedTransport;
  /** Mutate outgoing binary frames (tamper tests). */
  tamper: ((frame: Uint8Array) => void) | null = null;
  /** Observe every outgoing message. */
  tap: ((data: ChannelData) => void) | null = null;
  /** Silently lose outgoing messages for which this returns true. */
  drop: ((data: ChannelData) => boolean) | null = null;
  private handler: ((d: ChannelData) => void) | null = null;
  private readonly closeHandlers: (() => void)[] = [];

  onMessage(h: (d: ChannelData) => void): void {
    this.handler = h;
  }
  onClose(h: () => void): void {
    this.closeHandlers.push(h);
  }
  drained(): Promise<void> {
    return Promise.resolve();
  }
  send(data: string | ArrayBufferView | ArrayBuffer): void {
    if (this.readyState !== 'open') throw new Error('closed');
    let payload: ChannelData;
    if (typeof data === 'string') payload = data;
    else {
      const view =
        data instanceof ArrayBuffer ? new Uint8Array(data) : new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
      const copy = view.slice();
      this.tamper?.(copy);
      payload = copy.buffer;
    }
    this.tap?.(payload);
    if (this.drop?.(payload)) return;
    queueMicrotask(() => {
      if (this.peer.readyState === 'open') this.peer.handler?.(payload);
    });
  }
  /** Close both ends, as when the network drops. */
  close(): void {
    for (const t of [this, this.peer]) {
      if (t.readyState === 'closed') continue;
      t.readyState = 'closed';
      t.closeHandlers.forEach((h) => h());
    }
  }
}

export function makePair(): [PairedTransport, PairedTransport] {
  const a = new PairedTransport();
  const b = new PairedTransport();
  a.peer = b;
  b.peer = a;
  return [a, b];
}

// ── Sink ──────────────────────────────────────────────────────

export class MemorySink implements FileSink {
  readonly kind = 'idb' as const;
  readonly sequential = false;
  readonly data = new Map<number, Uint8Array>();
  writes = 0;
  pending = 0;
  maxPending = 0;
  closed = false;
  aborted = false;

  constructor(
    files: SinkFile[],
    private readonly delayMs = 0,
  ) {
    for (const f of files) this.data.set(f.index, new Uint8Array(f.size));
  }
  async open(): Promise<Set<number>> {
    return new Set();
  }
  async write({ fileIndex, offset, data }: SinkChunk): Promise<void> {
    this.pending += 1;
    this.maxPending = Math.max(this.maxPending, this.pending);
    if (this.delayMs) await new Promise((r) => setTimeout(r, this.delayMs));
    this.data.get(fileIndex)!.set(data, offset);
    this.writes += 1;
    this.pending -= 1;
  }
  async close(): Promise<null> {
    this.closed = true;
    return null;
  }
  async abort(): Promise<void> {
    this.aborted = true;
  }
}

/** Deterministic pseudo-random bytes. */
export function bytes(n: number, seed: number): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(n);
  let x = seed || 1;
  for (let i = 0; i < n; i++) {
    x = (x * 1103515245 + 12345) >>> 0;
    out[i] = x >>> 24;
  }
  return out;
}

// ── Signaling + peer connection fakes ─────────────────────────

type SignalingEvents = {
  open: void;
  close: void;
  reconnecting: { attempt: number };
  rejoined: { members: string[] };
  'peer-joined': { peerId: string };
  'peer-left': { peerId: string };
  signal: { from: string; data: SignalPayload };
  relay: { from: string; data: string | ArrayBuffer };
  error: { code: string; message: string };
};

/** A tiny in-process signaling server. */
export class FakeServer {
  private readonly rooms = new Map<string, { owner: string; members: Map<string, FakeSignaling> }>();
  readonly codes = new Map<string, string>();
  private n = 0;
  id(): string {
    return `peer${String(this.n++).padStart(12, '0')}`;
  }
  create(c: FakeSignaling): string {
    const roomId = `room${this.n++}`;
    this.rooms.set(roomId, { owner: c.peerId, members: new Map([[c.peerId, c]]) });
    return roomId;
  }
  join(roomId: string, c: FakeSignaling): string {
    const room = this.rooms.get(roomId);
    if (!room) throw new Error('This link has expired.');
    room.members.set(c.peerId, c);
    room.members.get(room.owner)?.emit('peer-joined', { peerId: c.peerId });
    return room.owner;
  }
  deliver(roomId: string, to: string, fn: (c: FakeSignaling) => void): void {
    const c = this.rooms.get(roomId)?.members.get(to);
    if (c) queueMicrotask(() => fn(c));
  }
  leave(roomId: string, c: FakeSignaling): void {
    const room = this.rooms.get(roomId);
    if (!room) return;
    room.members.delete(c.peerId);
    const notify = c.peerId === room.owner ? [...room.members.values()] : [room.members.get(room.owner)];
    for (const m of notify) m?.emit('peer-left', { peerId: c.peerId });
  }
}

export class FakeSignaling {
  private readonly emitter = new Emitter<SignalingEvents>();
  readonly peerId: string;
  roomId: string | null = null;
  ownerId: string | null = null;
  connected = true;
  bufferedAmount = 0;
  readonly on = this.emitter.on.bind(this.emitter);
  readonly emit = this.emitter.emit.bind(this.emitter);

  constructor(private readonly server: FakeServer) {
    this.peerId = server.id();
  }
  async connect(): Promise<void> {}
  async createRoom() {
    this.roomId = this.server.create(this);
    this.ownerId = this.peerId;
    return { roomId: this.roomId, peerId: this.peerId, role: 'sender' as const, ownerId: this.peerId };
  }
  async createCode(): Promise<string> {
    const nameplate = String(this.server.codes.size + 7);
    this.server.codes.set(nameplate, this.roomId!);
    return nameplate;
  }
  async resolveCode(nameplate: string): Promise<string> {
    const roomId = this.server.codes.get(nameplate);
    if (!roomId) throw new Error('No transfer with that code. Check the number and try again.');
    return roomId;
  }
  async joinRoom(roomId: string) {
    this.ownerId = this.server.join(roomId, this);
    this.roomId = roomId;
    return { roomId, peerId: this.peerId, role: 'receiver' as const, ownerId: this.ownerId };
  }
  sendSignal(data: SignalPayload, to?: string): void {
    const target = to ?? this.ownerId!;
    this.server.deliver(this.roomId!, target, (c) => c.emit('signal', { from: this.peerId, data }));
  }
  sendRelay(to: string, data: string | ArrayBuffer | ArrayBufferView): boolean {
    const target = this.peerId === this.ownerId ? to : this.ownerId!;
    const copy =
      typeof data === 'string'
        ? data
        : data instanceof ArrayBuffer
          ? data.slice(0)
          : (data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) as ArrayBuffer);
    this.server.deliver(this.roomId!, target, (c) => c.emit('relay', { from: this.peerId, data: copy }));
    return true;
  }
  close(): void {
    if (this.roomId) this.server.leave(this.roomId, this);
    this.emitter.clear();
  }
}

/**
 * Fake RTCPeerConnection wrapper. A sender/receiver pair with matching ids
 * "connects" once the sender calls start(), unless `direct` is false (which
 * simulates peers that can't reach each other, forcing the relay).
 */
export class FakeNetwork {
  direct = true;
  readonly peers = new Map<string, FakePeer>();
  /** Every transport pair ever opened, newest last. */
  readonly pairs: [PairedTransport, PairedTransport][] = [];
}

export class FakePeer {
  private readonly emitter = new Emitter<{
    'channel-open': Transport;
    connected: void;
    failed: void;
    disconnected: void;
    state: RTCPeerConnectionState;
  }>();
  readonly on = this.emitter.on.bind(this.emitter);
  connectionState: RTCPeerConnectionState = 'new';
  private closed = false;
  private offered = false;
  /** A receiver answers one offer; later ones go to a fresh FakePeer. */
  private used = false;

  constructor(
    private readonly role: 'sender' | 'receiver',
    private readonly self: string,
    readonly remoteId: string,
    private readonly net: FakeNetwork,
  ) {
    net.peers.set(`${role}:${self}->${remoteId}`, this);
    // A receiver created after the sender's offer still answers it.
    if (role === 'receiver') net.peers.get(`sender:${remoteId}->${self}`)?.tryPair();
  }
  async start(): Promise<void> {
    this.offered = true;
    this.tryPair();
  }
  private tryPair(): void {
    if (!this.net.direct || !this.offered || this.closed) return;
    const other = this.net.peers.get(`receiver:${this.remoteId}->${this.self}`);
    if (!other || other.closed || other.used) return;
    other.used = true;
    this.offered = false;
    const [a, b] = makePair();
    this.net.pairs.push([a, b]);
    queueMicrotask(() => {
      this.emitter.emit('channel-open', a);
      other.emitter.emit('channel-open', b);
    });
  }
  async handleSignal(): Promise<void> {}
  async route() {
    return 'lan' as const;
  }
  close(): void {
    this.closed = true;
    this.emitter.clear();
  }
}
