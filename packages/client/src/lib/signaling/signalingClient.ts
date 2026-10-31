/**
 * Typed WebSocket signaling client.
 *
 * Wraps the browser WebSocket with: the @beam/shared message contracts,
 * promise-based room create/join, an event surface for presence + routed
 * signals, relay frames for the fallback transport, and automatic reconnect
 * with exponential backoff. After a reconnect it rejoins its room under the
 * same peer id (using the server-issued token), so a signaling blip never
 * disturbs a WebRTC transfer that is already running.
 *
 * This client never sees plaintext file data. Relay frames carry the same
 * end-to-end encrypted stream that would otherwise go over WebRTC.
 */
import {
  PEER_ID_LENGTH,
  RELAY_HEADER_BYTES,
  RELAY_KIND_BINARY,
  RELAY_KIND_TEXT,
  type ClientToServerMessage,
  type PeerRole,
  type ServerToClientMessage,
  type SignalPayload,
} from '@beam/shared';
import { Emitter } from '../events.js';

type SignalingEvents = {
  open: void;
  close: void;
  reconnecting: { attempt: number };
  /** Rejoined the room after a reconnect; `members` are the peers still present. */
  rejoined: { members: string[] };
  'peer-joined': { peerId: string };
  'peer-left': { peerId: string };
  signal: { from: string; data: SignalPayload };
  relay: { from: string; data: string | ArrayBuffer };
  error: { code: string; message: string };
};

export interface RoomInfo {
  roomId: string;
  peerId: string;
  role: PeerRole;
  /** The sender's peer id (equals peerId for the sender). */
  ownerId: string;
}

/** A server error, with its machine-readable code. */
export class SignalingError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

const encoder = new TextEncoder();
const decoder = new TextDecoder();

export class SignalingClient {
  private ws: WebSocket | null = null;
  private readonly emitter = new Emitter<SignalingEvents>();
  private shouldReconnect = true;
  private reconnectAttempt = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private session: (RoomInfo & { token: string }) | null = null;

  /** One-shot resolver for the in-flight create/join request. */
  private pending: {
    resolve: (info: RoomInfo & { token: string }) => void;
    reject: (err: Error) => void;
  } | null = null;
  /** One-shot resolver for an in-flight create-code / resolve-code. */
  private codePending: { resolve: (value: string) => void; reject: (err: Error) => void } | null = null;

  constructor(private readonly url: string) {}

  readonly on = this.emitter.on.bind(this.emitter);

  /** Open the socket and resolve once it is connected. */
  connect(): Promise<void> {
    this.shouldReconnect = true;
    return new Promise((resolve, reject) => {
      try {
        this.openSocket(resolve, reject);
      } catch (err) {
        reject(err as Error);
      }
    });
  }

  /** Bytes queued on the socket (relay backpressure). */
  get bufferedAmount(): number {
    return this.ws?.bufferedAmount ?? 0;
  }

  get connected(): boolean {
    return this.ws?.readyState === WebSocket.OPEN;
  }

  get room(): RoomInfo | null {
    return this.session;
  }

  private openSocket(onOpen?: () => void, onError?: (e: Error) => void): void {
    // Translate http(s):// signaling base URL into a ws(s):// endpoint.
    const wsUrl = this.url.replace(/^http/, 'ws').replace(/\/$/, '') + '/ws';
    const ws = new WebSocket(wsUrl);
    ws.binaryType = 'arraybuffer';
    this.ws = ws;

    ws.onopen = () => {
      const reconnected = this.reconnectAttempt > 0;
      this.reconnectAttempt = 0;
      if (reconnected && this.session) {
        const { roomId, peerId, role, token } = this.session;
        this.send({ type: 'rejoin-room', roomId, peerId, role, token });
      }
      this.emitter.emit('open', undefined);
      onOpen?.();
    };

    ws.onmessage = (event) => {
      if (typeof event.data === 'string') this.handleMessage(event.data);
      else this.handleRelay(event.data as ArrayBuffer);
    };

    ws.onerror = () => {
      onError?.(new Error('Could not reach the Beam server.'));
    };

    ws.onclose = () => {
      if (this.ws !== ws) return;
      this.emitter.emit('close', undefined);
      if (this.shouldReconnect) this.scheduleReconnect();
    };
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer) return;
    this.reconnectAttempt += 1;
    // Exponential backoff capped at 10s, with light jitter.
    const delay = Math.min(10_000, 2 ** this.reconnectAttempt * 250);
    const jitter = Math.random() * 250;
    this.emitter.emit('reconnecting', { attempt: this.reconnectAttempt });
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.openSocket();
    }, delay + jitter);
  }

  private handleMessage(raw: string): void {
    let msg: ServerToClientMessage;
    try {
      msg = JSON.parse(raw) as ServerToClientMessage;
    } catch {
      return;
    }

    switch (msg.type) {
      case 'room-created':
        this.pending?.resolve({
          roomId: msg.roomId,
          peerId: msg.peerId,
          role: 'sender',
          ownerId: msg.peerId,
          token: msg.token,
        });
        this.pending = null;
        break;
      case 'room-joined':
        this.pending?.resolve({
          roomId: msg.roomId,
          peerId: msg.peerId,
          role: 'receiver',
          ownerId: msg.ownerId,
          token: msg.token,
        });
        this.pending = null;
        break;
      case 'room-rejoined':
        this.emitter.emit('rejoined', { members: msg.members });
        break;
      case 'peer-joined':
        this.emitter.emit('peer-joined', { peerId: msg.peerId });
        break;
      case 'peer-left':
        this.emitter.emit('peer-left', { peerId: msg.peerId });
        break;
      case 'signal':
        this.emitter.emit('signal', { from: msg.from, data: msg.data });
        break;
      case 'code-created':
        this.codePending?.resolve(msg.nameplate);
        this.codePending = null;
        break;
      case 'code-resolved':
        this.codePending?.resolve(msg.roomId);
        this.codePending = null;
        break;
      case 'error':
        // Fail in-flight requests so callers don't hang forever.
        this.pending?.reject(new SignalingError(msg.code, msg.message));
        this.pending = null;
        this.codePending?.reject(new SignalingError(msg.code, msg.message));
        this.codePending = null;
        this.emitter.emit('error', { code: msg.code, message: msg.message });
        break;
    }
  }

  /** Relay frame from the server: [from peerId][kind][payload]. */
  private handleRelay(buf: ArrayBuffer): void {
    if (buf.byteLength < RELAY_HEADER_BYTES) return;
    const bytes = new Uint8Array(buf);
    const from = decoder.decode(bytes.subarray(0, PEER_ID_LENGTH));
    const kind = bytes[PEER_ID_LENGTH];
    const data =
      kind === RELAY_KIND_TEXT
        ? decoder.decode(bytes.subarray(RELAY_HEADER_BYTES))
        : buf.slice(RELAY_HEADER_BYTES);
    this.emitter.emit('relay', { from, data });
  }

  private send(message: ClientToServerMessage): void {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(message));
  }

  private request(message: ClientToServerMessage): Promise<RoomInfo> {
    return new Promise((resolve, reject) => {
      this.pending = {
        resolve: (info) => {
          this.session = info;
          const { token: _token, ...room } = info;
          resolve(room);
        },
        reject,
      };
      this.send(message);
    });
  }

  /** Create a new room as its sender. */
  createRoom(): Promise<RoomInfo> {
    return this.request({ type: 'create-room' });
  }

  /** Join an existing room as a receiver; rejects if it's missing or full. */
  joinRoom(roomId: string): Promise<RoomInfo> {
    return this.request({ type: 'join-room', roomId });
  }

  private codeRequest(message: ClientToServerMessage): Promise<string> {
    return new Promise((resolve, reject) => {
      this.codePending = { resolve, reject };
      this.send(message);
    });
  }

  /** Get a short-code nameplate for this sender's room. */
  createCode(): Promise<string> {
    return this.codeRequest({ type: 'create-code' });
  }

  /** Look up the room id behind a nameplate. Rejects with code `code-not-found`. */
  resolveCode(nameplate: string): Promise<string> {
    return this.codeRequest({ type: 'resolve-code', nameplate });
  }

  /** Route an SDP/ICE/relay payload. Receivers omit `to` (it goes to the sender). */
  sendSignal(data: SignalPayload, to?: string): void {
    if (!this.session) return;
    this.send({ type: 'signal', roomId: this.session.roomId, ...(to ? { to } : {}), data });
  }

  /** Send one relay frame to `to` through the server. */
  sendRelay(to: string, data: string | ArrayBuffer | ArrayBufferView): boolean {
    if (this.ws?.readyState !== WebSocket.OPEN) return false;
    const text = typeof data === 'string';
    const body = text
      ? encoder.encode(data)
      : data instanceof ArrayBuffer
        ? new Uint8Array(data)
        : new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
    const frame = new Uint8Array(RELAY_HEADER_BYTES + body.length);
    frame.set(encoder.encode(to.padEnd(PEER_ID_LENGTH).slice(0, PEER_ID_LENGTH)), 0);
    frame[PEER_ID_LENGTH] = text ? RELAY_KIND_TEXT : RELAY_KIND_BINARY;
    frame.set(body, RELAY_HEADER_BYTES);
    this.ws.send(frame);
    return true;
  }

  /** Permanently close the socket and stop reconnecting. */
  close(): void {
    this.shouldReconnect = false;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    this.ws?.close();
    this.ws = null;
    this.emitter.clear();
  }
}
