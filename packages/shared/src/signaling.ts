/**
 * Signaling protocol — messages exchanged over the WebSocket between a
 * browser and the Beam signaling server.
 *
 * The server is a *blind relay*: it creates/joins rooms, tracks presence,
 * and forwards opaque `signal` payloads (SDP + ICE) between members of a
 * room. It never inspects SDP/ICE beyond routing, and never sees keys.
 *
 * A room has one sender (its owner) and up to N receivers. Every peer gets a
 * server-assigned `peerId`; the sender addresses signals to a specific
 * receiver with `to`, receivers' signals always go to the owner.
 *
 * ── Relay fallback ────────────────────────────────────────────
 * When a direct WebRTC connection can't be made (and no TURN server helps),
 * peers can tunnel the transfer through this same WebSocket as binary
 * messages: [peerId (16 ASCII bytes)][kind (1 byte)][payload]. The client
 * puts the destination peer id in front; the server swaps it for the source
 * peer id before delivery. The payload is the same end-to-end encrypted
 * stream that would have gone over WebRTC, so the server still sees only
 * ciphertext (plus chunk indices in the small control messages).
 */

/** Role a client plays in a room. The sender is always the WebRTC offerer. */
export type PeerRole = 'sender' | 'receiver';

export const PEER_ID_LENGTH = 16;
/** Relay frame kinds (byte after the peer id). */
export const RELAY_KIND_TEXT = 0;
export const RELAY_KIND_BINARY = 1;
export const RELAY_HEADER_BYTES = PEER_ID_LENGTH + 1;

// ── Client → Server ───────────────────────────────────────────

/** Sender asks the server to mint a fresh room. */
export interface CreateRoomMessage {
  type: 'create-room';
}

/** Receiver joins an existing room by id. */
export interface JoinRoomMessage {
  type: 'join-room';
  roomId: string;
}

/**
 * Opaque signaling payload to relay. Receivers omit `to` (it goes to the
 * sender); the sender must name the receiver.
 */
export interface SignalMessage {
  type: 'signal';
  roomId: string;
  to?: string;
  data: SignalPayload;
}

/**
 * Re-attach to a room after the WebSocket dropped, keeping the same peer id.
 * `token` is the one issued with room-created / room-joined.
 */
export interface RejoinRoomMessage {
  type: 'rejoin-room';
  roomId: string;
  peerId: string;
  role: PeerRole;
  token: string;
}

export type ClientToServerMessage =
  | CreateRoomMessage
  | JoinRoomMessage
  | RejoinRoomMessage
  | SignalMessage;

// ── Server → Client ───────────────────────────────────────────

/** Confirms room creation and tells the sender its role. */
export interface RoomCreatedMessage {
  type: 'room-created';
  roomId: string;
  role: PeerRole; // 'sender'
  peerId: string;
  /** Proof of identity for `rejoin-room` after a reconnect. */
  token: string;
}

/** Confirms a successful join. */
export interface RoomJoinedMessage {
  type: 'room-joined';
  roomId: string;
  role: PeerRole; // 'receiver'
  peerId: string;
  /** The sender's peer id. */
  ownerId: string;
  token: string;
}

/** Confirms a rejoin; `members` lets the sender reconcile who is still here. */
export interface RoomRejoinedMessage {
  type: 'room-rejoined';
  roomId: string;
  ownerId: string;
  members: string[];
}

/** Presence: a peer joined the room. Triggers the sender's WebRTC offer. */
export interface PeerJoinedMessage {
  type: 'peer-joined';
  roomId: string;
  peerId: string;
}

/** Presence: a peer left / disconnected. */
export interface PeerLeftMessage {
  type: 'peer-left';
  roomId: string;
  peerId: string;
}

/** Relayed signaling payload from another peer. */
export interface RelayedSignalMessage {
  type: 'signal';
  roomId: string;
  from: string;
  data: SignalPayload;
}

/** Error with a stable machine-readable code plus human message. */
export interface ErrorMessage {
  type: 'error';
  code: SignalingErrorCode;
  message: string;
}

export type ServerToClientMessage =
  | RoomCreatedMessage
  | RoomJoinedMessage
  | RoomRejoinedMessage
  | PeerJoinedMessage
  | PeerLeftMessage
  | RelayedSignalMessage
  | ErrorMessage;

// ── Shared payloads ───────────────────────────────────────────

/**
 * SDP description, ICE candidate, or a switch to the WebSocket relay
 * (sent by the sender when the direct connection didn't come up in time).
 */
export type SignalPayload =
  | { kind: 'sdp'; description: RTCSessionDescriptionInitLike }
  | { kind: 'ice'; candidate: RTCIceCandidateInitLike | null }
  | { kind: 'relay' };

/**
 * Minimal structural mirror of the browser DTOs so @beam/shared stays free
 * of DOM lib types (it is consumed by the Node server too).
 */
export interface RTCSessionDescriptionInitLike {
  type: 'offer' | 'answer' | 'pranswer' | 'rollback';
  sdp?: string;
}

export interface RTCIceCandidateInitLike {
  candidate?: string;
  sdpMid?: string | null;
  sdpMLineIndex?: number | null;
  usernameFragment?: string | null;
}

export type SignalingErrorCode =
  | 'room-not-found'
  | 'room-full'
  | 'invalid-message'
  | 'not-in-room'
  | 'rate-limited'
  | 'internal-error';

/** ICE server configuration handed to clients from `GET /ice`. */
export interface IceServerConfig {
  urls: string | string[];
  username?: string;
  credential?: string;
}

export interface IceConfigResponse {
  iceServers: IceServerConfig[];
  /** Whether this server offers the WebSocket relay fallback. */
  relay?: boolean;
}
