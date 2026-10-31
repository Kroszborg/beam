/**
 * The storage + messaging contract the signaling hub runs on.
 *
 * A "room" is a rendezvous record: who owns it (the sender) and who is in it.
 * It never holds file bytes or keys. Rooms expire after a TTL of inactivity.
 *
 * The bus carries hub-to-hub messages for a room (binary, so relayed transfer
 * data needs no re-encoding), so peers of one room can be
 * connected to different server instances. Two implementations exist:
 * MemoryBackend (single process, no dependencies) and RedisBackend (shared
 * state + pub/sub for horizontal scaling).
 */

export interface RoomRecord {
  createdAt: number;
  /** Peer id of the sender who created the room. */
  owner: string;
  /** Every connected peer, owner included. */
  members: string[];
}

export type JoinResult =
  | { ok: true; room: RoomRecord }
  | { ok: false; reason: 'room-not-found' | 'room-full' };

export interface RoomBackend {
  createRoom(roomId: string, peerId: string): Promise<RoomRecord>;
  getRoom(roomId: string): Promise<RoomRecord | null>;
  /** Idempotent for a peer already in the room. */
  addMember(roomId: string, peerId: string): Promise<JoinResult>;
  /** Returns the room after removal (null if it no longer exists). Empty rooms are deleted. */
  removeMember(roomId: string, peerId: string): Promise<RoomRecord | null>;
  /** Refresh the TTL on activity so live transfers don't expire. */
  touch(roomId: string): Promise<void>;

  /** Point a short-code nameplate at a room. False if the nameplate is taken. */
  claimCode(nameplate: string, roomId: string, ttlSeconds: number): Promise<boolean>;
  /** The room a nameplate points at, or null. */
  resolveCode(nameplate: string): Promise<string | null>;
  releaseCode(nameplate: string): Promise<void>;

  publish(channel: string, payload: Buffer): Promise<void>;
  subscribe(channel: string): Promise<void>;
  unsubscribe(channel: string): Promise<void>;
  onMessage(listener: (channel: string, payload: Buffer) => void): void;

  close(): Promise<void>;
}
