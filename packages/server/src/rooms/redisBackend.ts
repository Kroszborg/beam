/**
 * Redis room backend, for running several signaling instances.
 *
 * Room records live under `beam:room:{id}` with a TTL; the join path guards
 * the read-modify-write with WATCH/MULTI so concurrent joins can't overfill a
 * room. The bus is Redis pub/sub on a duplicated connection (a subscribed
 * connection can't issue normal commands).
 */
import type { Redis } from 'ioredis';
import type { RoomBackend, RoomRecord, JoinResult } from './backend.js';

const ROOM_PREFIX = 'beam:room:';

export class RedisBackend implements RoomBackend {
  private readonly subscriber: Redis;

  constructor(
    private readonly redis: Redis,
    private readonly ttlSeconds: number,
    private readonly maxMembers: number,
  ) {
    this.subscriber = redis.duplicate();
  }

  private key(roomId: string): string {
    return `${ROOM_PREFIX}${roomId}`;
  }

  async createRoom(roomId: string, peerId: string): Promise<RoomRecord> {
    const record: RoomRecord = { createdAt: Date.now(), owner: peerId, members: [peerId] };
    await this.redis.set(this.key(roomId), JSON.stringify(record), 'EX', this.ttlSeconds);
    return record;
  }

  async getRoom(roomId: string): Promise<RoomRecord | null> {
    const raw = await this.redis.get(this.key(roomId));
    return raw ? (JSON.parse(raw) as RoomRecord) : null;
  }

  async addMember(roomId: string, peerId: string): Promise<JoinResult> {
    const key = this.key(roomId);
    for (let attempt = 0; attempt < 5; attempt++) {
      await this.redis.watch(key);
      const raw = await this.redis.get(key);
      if (!raw) {
        await this.redis.unwatch();
        return { ok: false, reason: 'room-not-found' };
      }
      const record = JSON.parse(raw) as RoomRecord;
      if (record.members.includes(peerId)) {
        await this.redis.unwatch();
        return { ok: true, room: record };
      }
      if (record.members.length >= this.maxMembers) {
        await this.redis.unwatch();
        return { ok: false, reason: 'room-full' };
      }
      record.members.push(peerId);
      const result = await this.redis
        .multi()
        .set(key, JSON.stringify(record), 'EX', this.ttlSeconds)
        .exec();
      // null => the key changed under WATCH; retry.
      if (result) return { ok: true, room: record };
    }
    return { ok: false, reason: 'room-full' };
  }

  async removeMember(roomId: string, peerId: string): Promise<RoomRecord | null> {
    const key = this.key(roomId);
    const raw = await this.redis.get(key);
    if (!raw) return null;
    const record = JSON.parse(raw) as RoomRecord;
    record.members = record.members.filter((id) => id !== peerId);
    if (record.members.length === 0) await this.redis.del(key);
    else await this.redis.set(key, JSON.stringify(record), 'EX', this.ttlSeconds);
    return record;
  }

  async touch(roomId: string): Promise<void> {
    await this.redis.expire(this.key(roomId), this.ttlSeconds);
  }

  async publish(channel: string, payload: Buffer): Promise<void> {
    await this.redis.publish(channel, payload);
  }

  async subscribe(channel: string): Promise<void> {
    await this.subscriber.subscribe(channel);
  }

  async unsubscribe(channel: string): Promise<void> {
    await this.subscriber.unsubscribe(channel);
  }

  onMessage(listener: (channel: string, payload: Buffer) => void): void {
    this.subscriber.on('messageBuffer', (channel: Buffer, payload: Buffer) =>
      listener(channel.toString(), payload),
    );
  }

  async close(): Promise<void> {
    await this.subscriber.quit();
    await this.redis.quit();
  }
}
