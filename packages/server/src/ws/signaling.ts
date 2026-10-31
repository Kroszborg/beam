/**
 * Signaling hub — the WebSocket layer that brokers WebRTC handshakes.
 *
 * Responsibilities (and nothing more):
 *   • mint rooms and let receivers join them (one sender, up to N receivers)
 *   • track presence (peer-joined / peer-left, with peer ids)
 *   • route opaque SDP/ICE `signal` payloads between a receiver and the sender
 *   • optionally relay the (end-to-end encrypted) transfer stream as binary
 *     frames when two peers can't connect directly
 *
 * It never inspects signal payloads beyond routing and never sees keys; relayed
 * transfer data is ciphertext produced in the browsers.
 *
 * ── Horizontal scaling ────────────────────────────────────────
 * Peers of one room may be connected to different instances. Everything bound
 * for a room is published on the backend bus channel `beam:room:{roomId}`;
 * each instance subscribes to rooms it has local members in and delivers to
 * the addressed local socket(s). With the in-memory backend this is all one
 * process.
 *
 * Bus payloads are binary: byte 0 = 0 → JSON envelope, 1 → relay frame.
 */
import type { WebSocket } from 'ws';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { customAlphabet } from 'nanoid';
import {
  PEER_ID_LENGTH,
  RELAY_HEADER_BYTES,
  type ClientToServerMessage,
  type PeerRole,
  type RejoinRoomMessage,
  type ServerToClientMessage,
  type SignalingErrorCode,
  type SignalPayload,
} from '@beam/shared';
import type { RoomBackend } from '../rooms/backend.js';

/** URL-friendly room codes without visually ambiguous characters. */
const makeRoomId = customAlphabet('23456789abcdefghjkmnpqrstuvwxyz', 10);
const makePeerId = customAlphabet('0123456789abcdefghijklmnopqrstuvwxyz', PEER_ID_LENGTH);

const CHANNEL_PREFIX = 'beam:room:';
const BUS_JSON = 0;
const BUS_RELAY = 1;

/** Envelope published to the bus for delivery to a room's local sockets. */
interface Envelope {
  /** Deliver only to this peer. */
  to?: string;
  /** Deliver to every member except this peer. */
  exclude?: string;
  message: ServerToClientMessage;
}

/** Per-connection state attached to each live WebSocket. */
interface Peer {
  peerId: string;
  socket: WebSocket;
  roomId: string | null;
  role: 'sender' | 'receiver' | null;
  /** The room owner's id (for receivers, where their signals go). */
  ownerId: string | null;
  /** Sliding-window counter for control messages (relay frames are exempt). */
  windowStart: number;
  msgCount: number;
  /** Timestamps of recent short-code lookups (anti-enumeration). */
  lookups: number[];
}

/** Generous cap: legitimate ICE trickle bursts, but spam gets cut off. */
const RATE_WINDOW_MS = 10_000;
const RATE_MAX_MESSAGES = 300;
/** Refresh the room TTL at most this often while relay data flows. */
const TOUCH_INTERVAL_MS = 30_000;
/** Ping every socket this often; one missed pong closes it. */
const HEARTBEAT_MS = 30_000;
/** Short-code lookups allowed per connection per minute. */
const LOOKUPS_PER_MINUTE = 10;
/** A nameplate outlives idle periods; resolve() also checks the room exists. */
const CODE_TTL_SECONDS = 24 * 3600;
/** Try short nameplates first, longer ones only when those are busy. */
const NAMEPLATE_RANGES: [number, number][] = [
  [1, 99],
  [100, 999],
  [1000, 9999],
  [10000, 99999],
];

export interface HubOptions {
  relayEnabled: boolean;
  /** HMAC key for rejoin tokens. */
  secret: string;
  log: { error: (msg: unknown, ...args: unknown[]) => void };
}

export class SignalingHub {
  /** roomId -> (peerId -> socket) for peers connected to THIS instance. */
  private readonly localRooms = new Map<string, Map<string, WebSocket>>();
  private readonly lastTouch = new Map<string, number>();
  /** roomId -> its short-code nameplate, for rooms owned on THIS instance. */
  private readonly roomCodes = new Map<string, string>();
  private readonly alive = new WeakMap<WebSocket, boolean>();
  private readonly sockets = new Set<WebSocket>();
  private readonly heartbeat: ReturnType<typeof setInterval>;

  constructor(
    private readonly backend: RoomBackend,
    private readonly options: HubOptions,
  ) {
    backend.onMessage((channel, payload) => this.onBusMessage(channel, payload));
    // Detect half-open sockets (laptop lid closed, network switched) so the
    // other peers learn about the departure instead of waiting on a ghost.
    this.heartbeat = setInterval(() => {
      for (const socket of this.sockets) {
        if (this.alive.get(socket) === false) {
          socket.terminate();
          continue;
        }
        this.alive.set(socket, false);
        socket.ping();
      }
    }, HEARTBEAT_MS);
    this.heartbeat.unref?.();
  }

  close(): void {
    clearInterval(this.heartbeat);
  }

  /**
   * Run a promise nobody awaits. A backend hiccup (e.g. Redis restarting) must
   * be logged, never surface as an unhandled rejection — that would kill the
   * process and every signaling connection with it.
   */
  private background(p: Promise<unknown>): void {
    p.catch((err) => this.options.log.error(err, 'signaling background task failed'));
  }

  private token(roomId: string, peerId: string, role: PeerRole): string {
    return createHmac('sha256', this.options.secret)
      .update(`${roomId}|${peerId}|${role}`)
      .digest('base64url');
  }

  /** Register a freshly-opened socket and wire up its lifecycle handlers. */
  handleConnection(socket: WebSocket): void {
    const peer: Peer = {
      peerId: makePeerId(),
      socket,
      roomId: null,
      role: null,
      ownerId: null,
      windowStart: Date.now(),
      msgCount: 0,
      lookups: [],
    };

    this.sockets.add(socket);
    this.alive.set(socket, true);
    socket.on('pong', () => this.alive.set(socket, true));
    socket.on('message', (raw: Buffer, isBinary: boolean) => {
      this.alive.set(socket, true);
      if (isBinary) this.onRelayFrame(peer, raw);
      else this.background(this.onClientMessage(peer, raw));
    });
    let closed = false;
    const onClose = () => {
      if (closed) return;
      closed = true;
      this.sockets.delete(socket);
      this.background(this.onClose(peer));
    };
    socket.on('close', onClose);
    socket.on('error', onClose);
  }

  /** Sliding-window per-connection rate limit. Returns true if over budget. */
  private isRateLimited(peer: Peer): boolean {
    const now = Date.now();
    if (now - peer.windowStart > RATE_WINDOW_MS) {
      peer.windowStart = now;
      peer.msgCount = 0;
    }
    peer.msgCount += 1;
    return peer.msgCount > RATE_MAX_MESSAGES;
  }

  // ── Client → hub ────────────────────────────────────────────

  private async onClientMessage(peer: Peer, raw: Buffer): Promise<void> {
    if (this.isRateLimited(peer)) {
      this.sendError(peer, 'rate-limited', 'Rate limit exceeded.');
      peer.socket.close(1008, 'rate limit');
      return;
    }

    let msg: ClientToServerMessage;
    try {
      msg = JSON.parse(raw.toString()) as ClientToServerMessage;
    } catch {
      return this.sendError(peer, 'invalid-message', 'Malformed JSON.');
    }

    try {
      switch (msg.type) {
        case 'create-room':
          return await this.onCreateRoom(peer);
        case 'join-room':
          return await this.onJoinRoom(peer, String(msg.roomId));
        case 'rejoin-room':
          return await this.onRejoinRoom(peer, msg);
        case 'signal':
          return await this.onSignal(peer, msg.roomId, msg.to, msg.data);
        case 'create-code':
          return await this.onCreateCode(peer);
        case 'resolve-code':
          return await this.onResolveCode(peer, String(msg.nameplate));
        default:
          return this.sendError(peer, 'invalid-message', 'Unknown message type.');
      }
    } catch (err) {
      this.options.log.error(err, 'signaling handler failed');
      return this.sendError(peer, 'internal-error', 'Server error.');
    }
  }

  private async onCreateRoom(peer: Peer): Promise<void> {
    if (peer.roomId) return this.sendError(peer, 'invalid-message', 'Already in a room.');
    const roomId = makeRoomId();
    await this.backend.createRoom(roomId, peer.peerId);
    peer.role = 'sender';
    peer.ownerId = peer.peerId;
    await this.attachLocal(roomId, peer);
    this.send(peer.socket, {
      type: 'room-created',
      roomId,
      role: 'sender',
      peerId: peer.peerId,
      token: this.token(roomId, peer.peerId, 'sender'),
    });
  }

  private async onJoinRoom(peer: Peer, roomId: string): Promise<void> {
    if (peer.roomId) return this.sendError(peer, 'invalid-message', 'Already in a room.');
    const result = await this.backend.addMember(roomId, peer.peerId);
    if (!result.ok) {
      const code: SignalingErrorCode = result.reason === 'room-full' ? 'room-full' : 'room-not-found';
      const message =
        code === 'room-full'
          ? 'This link already has the maximum number of receivers connected.'
          : 'This link has expired or the sender closed their tab.';
      return this.sendError(peer, code, message);
    }

    peer.role = 'receiver';
    peer.ownerId = result.room.owner;
    await this.attachLocal(roomId, peer);
    this.send(peer.socket, {
      type: 'room-joined',
      roomId,
      role: 'receiver',
      peerId: peer.peerId,
      ownerId: result.room.owner,
      token: this.token(roomId, peer.peerId, 'receiver'),
    });

    // Tell the sender (possibly on another instance) a receiver arrived.
    await this.publish(roomId, {
      to: result.room.owner,
      message: { type: 'peer-joined', roomId, peerId: peer.peerId },
    });
  }

  /**
   * A peer whose WebSocket dropped comes back under its old identity. The
   * WebRTC connection between the peers usually survived the blip, so the
   * others are not told anything changed — except that a returning receiver is
   * announced to the sender, which ignores it if their connection is healthy.
   */
  private async onRejoinRoom(peer: Peer, msg: RejoinRoomMessage): Promise<void> {
    if (peer.roomId) return this.sendError(peer, 'invalid-message', 'Already in a room.');
    const { roomId, peerId, role } = msg;
    const expected = Buffer.from(this.token(String(roomId), String(peerId), role));
    const given = Buffer.from(String(msg.token));
    if (expected.length !== given.length || !timingSafeEqual(expected, given)) {
      return this.sendError(peer, 'invalid-message', 'Invalid rejoin token.');
    }

    let room = await this.backend.getRoom(roomId);
    if (!room && role === 'sender') room = await this.backend.createRoom(roomId, peerId);
    if (!room) return this.sendError(peer, 'room-not-found', 'This link has expired.');
    if (role === 'sender' && room.owner !== peerId) {
      return this.sendError(peer, 'invalid-message', 'Invalid rejoin token.');
    }
    const result = await this.backend.addMember(roomId, peerId);
    if (!result.ok) return this.sendError(peer, result.reason, 'Could not rejoin the room.');

    peer.peerId = peerId;
    peer.role = role;
    peer.ownerId = result.room.owner;
    await this.attachLocal(roomId, peer);
    this.send(peer.socket, {
      type: 'room-rejoined',
      roomId,
      ownerId: result.room.owner,
      members: result.room.members,
    });
    if (role === 'receiver') {
      await this.publish(roomId, {
        to: result.room.owner,
        message: { type: 'peer-joined', roomId, peerId },
      });
    }
  }

  /** Give the sender's room a short numeric nameplate (idempotent per room). */
  private async onCreateCode(peer: Peer): Promise<void> {
    if (peer.role !== 'sender' || !peer.roomId) {
      return this.sendError(peer, 'invalid-message', 'Only a sender can create a code.');
    }
    const roomId = peer.roomId;
    const existing = this.roomCodes.get(roomId);
    if (existing && (await this.backend.resolveCode(existing)) === roomId) {
      return this.send(peer.socket, { type: 'code-created', nameplate: existing });
    }
    for (const [lo, hi] of NAMEPLATE_RANGES) {
      for (let attempt = 0; attempt < 8; attempt++) {
        const nameplate = String(lo + Math.floor(Math.random() * (hi - lo + 1)));
        if (await this.backend.claimCode(nameplate, roomId, CODE_TTL_SECONDS)) {
          this.roomCodes.set(roomId, nameplate);
          return this.send(peer.socket, { type: 'code-created', nameplate });
        }
      }
    }
    return this.sendError(peer, 'internal-error', 'No short codes available right now.');
  }

  /**
   * Nameplate → room id. Rate-limited per connection; the code's secret words
   * are checked by the PAKE between the browsers, never here.
   */
  private async onResolveCode(peer: Peer, nameplate: string): Promise<void> {
    const now = Date.now();
    peer.lookups = peer.lookups.filter((t) => now - t < 60_000);
    if (peer.lookups.length >= LOOKUPS_PER_MINUTE) {
      return this.sendError(peer, 'rate-limited', 'Too many code lookups. Wait a minute and try again.');
    }
    peer.lookups.push(now);
    const notFound = () =>
      this.sendError(peer, 'code-not-found', 'No transfer with that code. Check the number and try again.');
    if (!/^\d{1,5}$/.test(nameplate)) return notFound();
    const roomId = await this.backend.resolveCode(nameplate);
    if (!roomId || !(await this.backend.getRoom(roomId))) return notFound();
    this.send(peer.socket, { type: 'code-resolved', nameplate, roomId });
  }

  private async onSignal(
    peer: Peer,
    roomId: string,
    to: string | undefined,
    data: SignalPayload,
  ): Promise<void> {
    if (!peer.roomId || peer.roomId !== roomId) {
      return this.sendError(peer, 'not-in-room', 'You are not in that room.');
    }
    // Receivers can only talk to the sender; the sender must name a receiver.
    const target = peer.role === 'receiver' ? peer.ownerId : to;
    if (!target || typeof target !== 'string') {
      return this.sendError(peer, 'invalid-message', 'Signal needs a recipient.');
    }
    if (data?.kind === 'relay' && !this.options.relayEnabled) {
      return this.sendError(peer, 'invalid-message', 'Relay is disabled on this server.');
    }
    await this.backend.touch(roomId);
    await this.publish(roomId, {
      to: target,
      message: { type: 'signal', roomId, from: peer.peerId, data },
    });
  }

  /**
   * Binary frame from a client: [to peerId][kind][payload]. Rewritten to
   * [from peerId][kind][payload] and delivered to `to` within the same room.
   * Receivers may only address the sender, so receivers can't reach each other.
   */
  private onRelayFrame(peer: Peer, raw: Buffer): void {
    if (!this.options.relayEnabled || !peer.roomId || raw.length < RELAY_HEADER_BYTES) return;
    let to = raw.toString('latin1', 0, PEER_ID_LENGTH);
    if (peer.role === 'receiver') to = peer.ownerId!;

    const out = Buffer.allocUnsafe(1 + PEER_ID_LENGTH + raw.length);
    out[0] = BUS_RELAY;
    out.write(to, 1, PEER_ID_LENGTH, 'latin1');
    out.write(peer.peerId, 1 + PEER_ID_LENGTH, PEER_ID_LENGTH, 'latin1');
    raw.copy(out, 1 + 2 * PEER_ID_LENGTH, PEER_ID_LENGTH);

    // Same instance: skip the bus entirely.
    const local = this.localRooms.get(peer.roomId)?.get(to);
    if (local) this.deliverRelay(local, out);
    else this.background(this.backend.publish(CHANNEL_PREFIX + peer.roomId, out));

    const now = Date.now();
    if (now - (this.lastTouch.get(peer.roomId) ?? 0) > TOUCH_INTERVAL_MS) {
      this.lastTouch.set(peer.roomId, now);
      this.background(this.backend.touch(peer.roomId));
    }
  }

  private deliverRelay(socket: WebSocket, busFrame: Buffer): void {
    if (socket.readyState !== socket.OPEN) return;
    // [from][kind][payload] — drop the bus type byte and the destination.
    socket.send(busFrame.subarray(1 + PEER_ID_LENGTH), { binary: true });
  }

  // ── Disconnect ──────────────────────────────────────────────

  private async onClose(peer: Peer): Promise<void> {
    const roomId = peer.roomId;
    if (!roomId) return;
    // Already replaced by a rejoin on a newer socket: nothing left to clean up.
    if (this.localRooms.get(roomId)?.get(peer.peerId) !== peer.socket) return;

    this.detachLocal(roomId, peer);
    const room = await this.backend.removeMember(roomId, peer.peerId);
    if (!room || room.members.length === 0) {
      // Room is gone: free its nameplate for someone else.
      const nameplate = this.roomCodes.get(roomId);
      if (nameplate) {
        this.roomCodes.delete(roomId);
        if ((await this.backend.resolveCode(nameplate)) === roomId) await this.backend.releaseCode(nameplate);
      }
      return;
    }

    if (peer.role === 'receiver') {
      await this.publish(roomId, {
        to: room.owner,
        message: { type: 'peer-left', roomId, peerId: peer.peerId },
      });
    } else {
      // The sender left: every receiver should know.
      await this.publish(roomId, {
        exclude: peer.peerId,
        message: { type: 'peer-left', roomId, peerId: peer.peerId },
      });
    }
  }

  // ── Local socket registry + bus subscription bookkeeping ────

  private async attachLocal(roomId: string, peer: Peer): Promise<void> {
    peer.roomId = roomId;
    let members = this.localRooms.get(roomId);
    if (!members) {
      members = new Map();
      this.localRooms.set(roomId, members);
      // First local member in this room → start listening for its traffic.
      await this.backend.subscribe(CHANNEL_PREFIX + roomId);
    }
    members.set(peer.peerId, peer.socket);
  }

  private detachLocal(roomId: string, peer: Peer): void {
    const members = this.localRooms.get(roomId);
    if (!members) return;
    members.delete(peer.peerId);
    if (members.size === 0) {
      this.localRooms.delete(roomId);
      this.lastTouch.delete(roomId);
      this.background(this.backend.unsubscribe(CHANNEL_PREFIX + roomId));
    }
  }

  // ── Bus ─────────────────────────────────────────────────────

  private async publish(roomId: string, envelope: Envelope): Promise<void> {
    const json = Buffer.from(JSON.stringify(envelope));
    const out = Buffer.allocUnsafe(json.length + 1);
    out[0] = BUS_JSON;
    json.copy(out, 1);
    await this.backend.publish(CHANNEL_PREFIX + roomId, out);
  }

  /** Deliver a bus message to the addressed local sockets of its room. */
  private onBusMessage(channel: string, payload: Buffer): void {
    if (!channel.startsWith(CHANNEL_PREFIX) || payload.length === 0) return;
    const members = this.localRooms.get(channel.slice(CHANNEL_PREFIX.length));
    if (!members) return;

    if (payload[0] === BUS_RELAY) {
      const to = payload.toString('latin1', 1, 1 + PEER_ID_LENGTH);
      const socket = members.get(to);
      if (socket) this.deliverRelay(socket, payload);
      return;
    }

    let envelope: Envelope;
    try {
      envelope = JSON.parse(payload.subarray(1).toString()) as Envelope;
    } catch {
      return;
    }
    for (const [peerId, socket] of members) {
      if (envelope.to && peerId !== envelope.to) continue;
      if (envelope.exclude && peerId === envelope.exclude) continue;
      this.send(socket, envelope.message);
    }
  }

  // ── Low-level send helpers ──────────────────────────────────

  private send(socket: WebSocket, message: ServerToClientMessage): void {
    if (socket.readyState === socket.OPEN) {
      socket.send(JSON.stringify(message));
    }
  }

  private sendError(peer: Peer, code: SignalingErrorCode, message: string): void {
    this.send(peer.socket, { type: 'error', code, message });
  }
}
