/**
 * Signaling hub — the WebSocket layer that brokers WebRTC handshakes.
 *
 * Responsibilities (and nothing more):
 *   • mint rooms and let a second peer join
 *   • track presence (peer-joined / peer-left)
 *   • relay opaque SDP/ICE `signal` payloads between the two peers
 *
 * It never inspects signal payloads beyond routing, and it never touches file
 * data or keys — those travel peer-to-peer over the DataChannel the handshake
 * eventually establishes.
 *
 * ── Horizontal scaling ────────────────────────────────────────
 * Two peers in the same room may be connected to *different* server instances.
 * To relay between them we use Redis pub/sub: every message destined for a room
 * is published to `beam:relay:{roomId}`. Every instance subscribes to the rooms
 * it has local members in, and on receipt fans the message out to its local
 * sockets (honouring an `exclude` peer so a sender never gets its own message
 * echoed back). Redis remains the single source of truth for room lifecycle.
 */
import type { WebSocket } from 'ws';
import type { Redis } from 'ioredis';
import { customAlphabet } from 'nanoid';
import type {
  ClientToServerMessage,
  ServerToClientMessage,
  SignalingErrorCode,
} from '@beam/shared';
import { RoomStore } from '../rooms/roomStore.js';

/** URL-friendly room codes without visually ambiguous characters. */
const makeRoomId = customAlphabet('23456789abcdefghjkmnpqrstuvwxyz', 10);
const makePeerId = customAlphabet(
  '0123456789abcdefghijklmnopqrstuvwxyz',
  16,
);

const RELAY_CHANNEL_PREFIX = 'beam:relay:';

/** Envelope published to Redis for fan-out to a room's local sockets. */
interface RelayEnvelope {
  /** Deliver to every local member except this peer id. */
  exclude?: string;
  message: ServerToClientMessage;
}

/** Per-connection state attached to each live WebSocket. */
interface PeerConnection {
  peerId: string;
  socket: WebSocket;
  roomId: string | null;
  /** Sliding-window message counter for rate limiting. */
  windowStart: number;
  msgCount: number;
}

/** Generous cap: legitimate ICE trickle bursts, but spam gets cut off. */
const RATE_WINDOW_MS = 10_000;
const RATE_MAX_MESSAGES = 300;

export class SignalingHub {
  private readonly rooms: RoomStore;
  private readonly subscriber: Redis;

  /** roomId -> (peerId -> socket) for peers connected to THIS instance. */
  private readonly localRooms = new Map<string, Map<string, WebSocket>>();

  constructor(
    private readonly publisher: Redis,
    private readonly ttlSeconds: number,
    private readonly log: { error: (msg: unknown, ...args: unknown[]) => void },
  ) {
    this.rooms = new RoomStore(publisher, ttlSeconds);
    // A subscriber connection cannot issue normal commands, so we duplicate.
    this.subscriber = publisher.duplicate();
    this.subscriber.on('message', (channel: string, payload: string) =>
      this.onRelayMessage(channel, payload),
    );
  }

  /** Register a freshly-opened socket and wire up its lifecycle handlers. */
  handleConnection(socket: WebSocket): void {
    const peer: PeerConnection = {
      peerId: makePeerId(),
      socket,
      roomId: null,
      windowStart: Date.now(),
      msgCount: 0,
    };

    socket.on('message', (raw: Buffer) => {
      void this.onClientMessage(peer, raw);
    });
    socket.on('close', () => {
      void this.onClose(peer);
    });
    socket.on('error', () => {
      void this.onClose(peer);
    });
  }

  /** Sliding-window per-connection rate limit. Returns true if over budget. */
  private isRateLimited(peer: PeerConnection): boolean {
    const now = Date.now();
    if (now - peer.windowStart > RATE_WINDOW_MS) {
      peer.windowStart = now;
      peer.msgCount = 0;
    }
    peer.msgCount += 1;
    return peer.msgCount > RATE_MAX_MESSAGES;
  }

  // ── Client → hub ────────────────────────────────────────────

  private async onClientMessage(
    peer: PeerConnection,
    raw: Buffer,
  ): Promise<void> {
    if (this.isRateLimited(peer)) {
      this.sendError(peer, 'internal-error', 'Rate limit exceeded.');
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
          return await this.onJoinRoom(peer, msg.roomId);
        case 'signal':
          return await this.onSignal(peer, msg.roomId, msg.data);
        default:
          return this.sendError(peer, 'invalid-message', 'Unknown message type.');
      }
    } catch (err) {
      this.log.error(err, 'signaling handler failed');
      return this.sendError(peer, 'internal-error', 'Server error.');
    }
  }

  private async onCreateRoom(peer: PeerConnection): Promise<void> {
    const roomId = makeRoomId();
    await this.rooms.createRoom(roomId, peer.peerId);
    this.attachLocal(roomId, peer);
    this.send(peer.socket, { type: 'room-created', roomId, role: 'sender' });
  }

  private async onJoinRoom(
    peer: PeerConnection,
    roomId: string,
  ): Promise<void> {
    const result = await this.rooms.addMember(roomId, peer.peerId);
    if (!result.ok) {
      const code: SignalingErrorCode =
        result.reason === 'room-full' ? 'room-full' : 'room-not-found';
      return this.sendError(peer, code, `Cannot join room: ${result.reason}.`);
    }

    this.attachLocal(roomId, peer);
    this.send(peer.socket, { type: 'room-joined', roomId, role: 'receiver' });

    // Tell the other peer (possibly on another instance) someone arrived.
    await this.relay(roomId, {
      exclude: peer.peerId,
      message: { type: 'peer-joined', roomId },
    });
  }

  private async onSignal(
    peer: PeerConnection,
    roomId: string,
    data: import('@beam/shared').SignalPayload,
  ): Promise<void> {
    if (peer.roomId !== roomId) {
      return this.sendError(peer, 'not-in-room', 'You are not in that room.');
    }
    await this.rooms.touch(roomId);
    await this.relay(roomId, {
      exclude: peer.peerId,
      message: { type: 'signal', roomId, data },
    });
  }

  // ── Disconnect ──────────────────────────────────────────────

  private async onClose(peer: PeerConnection): Promise<void> {
    const roomId = peer.roomId;
    if (!roomId) return;

    this.detachLocal(roomId, peer);
    const remaining = await this.rooms.removeMember(roomId, peer.peerId);

    // Notify the surviving peer so it can switch into resume/wait state.
    if (remaining.length > 0) {
      await this.relay(roomId, {
        exclude: peer.peerId,
        message: { type: 'peer-left', roomId },
      });
    }
  }

  // ── Local socket registry + Redis subscription bookkeeping ──

  private attachLocal(roomId: string, peer: PeerConnection): void {
    peer.roomId = roomId;
    let members = this.localRooms.get(roomId);
    if (!members) {
      members = new Map();
      this.localRooms.set(roomId, members);
      // First local member in this room → start listening for relays.
      void this.subscriber.subscribe(RELAY_CHANNEL_PREFIX + roomId);
    }
    members.set(peer.peerId, peer.socket);
  }

  private detachLocal(roomId: string, peer: PeerConnection): void {
    const members = this.localRooms.get(roomId);
    if (!members) return;
    members.delete(peer.peerId);
    if (members.size === 0) {
      this.localRooms.delete(roomId);
      void this.subscriber.unsubscribe(RELAY_CHANNEL_PREFIX + roomId);
    }
  }

  // ── Redis relay ─────────────────────────────────────────────

  private async relay(roomId: string, envelope: RelayEnvelope): Promise<void> {
    await this.publisher.publish(
      RELAY_CHANNEL_PREFIX + roomId,
      JSON.stringify(envelope),
    );
  }

  /** Fan a relayed envelope out to local sockets of the target room. */
  private onRelayMessage(channel: string, payload: string): void {
    if (!channel.startsWith(RELAY_CHANNEL_PREFIX)) return;
    const roomId = channel.slice(RELAY_CHANNEL_PREFIX.length);
    const members = this.localRooms.get(roomId);
    if (!members) return;

    let envelope: RelayEnvelope;
    try {
      envelope = JSON.parse(payload) as RelayEnvelope;
    } catch {
      return;
    }

    for (const [peerId, socket] of members) {
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

  private sendError(
    peer: PeerConnection,
    code: SignalingErrorCode,
    message: string,
  ): void {
    this.send(peer.socket, { type: 'error', code, message });
  }

  /** Gracefully tear down Redis connections (used on server shutdown). */
  async close(): Promise<void> {
    await this.subscriber.quit();
  }
}
