/**
 * In-process room backend for single-instance deployments.
 *
 * Implements the same contract as the Redis backend — room records with a TTL,
 * plus a pub/sub bus for fan-out — entirely in memory, so a self-hosted Beam is
 * one process with no Redis to install. Use Redis when running several
 * instances behind a load balancer (peers of one room may land on different
 * instances, and only a shared bus can connect them).
 */
import type { RoomBackend, RoomRecord, JoinResult } from './backend.js';

interface Entry {
  record: RoomRecord;
  expiresAt: number;
}

export class MemoryBackend implements RoomBackend {
  private readonly rooms = new Map<string, Entry>();
  private readonly codes = new Map<string, { roomId: string; expiresAt: number }>();
  private readonly listeners = new Set<(channel: string, payload: Buffer) => void>();
  private readonly subscribed = new Set<string>();
  private readonly sweeper: ReturnType<typeof setInterval>;

  constructor(
    private readonly ttlSeconds: number,
    private readonly maxMembers: number,
  ) {
    this.sweeper = setInterval(() => this.sweep(), 60_000);
    this.sweeper.unref?.();
  }

  private live(roomId: string): Entry | null {
    const e = this.rooms.get(roomId);
    if (!e) return null;
    if (e.expiresAt <= Date.now()) {
      this.rooms.delete(roomId);
      return null;
    }
    return e;
  }

  private sweep(): void {
    const now = Date.now();
    for (const [id, e] of this.rooms) if (e.expiresAt <= now) this.rooms.delete(id);
    for (const [n, c] of this.codes) if (c.expiresAt <= now) this.codes.delete(n);
  }

  private expiry(): number {
    return Date.now() + this.ttlSeconds * 1000;
  }

  async createRoom(roomId: string, peerId: string): Promise<RoomRecord> {
    const record: RoomRecord = { createdAt: Date.now(), owner: peerId, members: [peerId] };
    this.rooms.set(roomId, { record, expiresAt: this.expiry() });
    return record;
  }

  async getRoom(roomId: string): Promise<RoomRecord | null> {
    return this.live(roomId)?.record ?? null;
  }

  async addMember(roomId: string, peerId: string): Promise<JoinResult> {
    const e = this.live(roomId);
    if (!e) return { ok: false, reason: 'room-not-found' };
    if (e.record.members.includes(peerId)) return { ok: true, room: e.record };
    if (e.record.members.length >= this.maxMembers) return { ok: false, reason: 'room-full' };
    e.record.members.push(peerId);
    e.expiresAt = this.expiry();
    return { ok: true, room: e.record };
  }

  async removeMember(roomId: string, peerId: string): Promise<RoomRecord | null> {
    const e = this.live(roomId);
    if (!e) return null;
    e.record.members = e.record.members.filter((id) => id !== peerId);
    if (e.record.members.length === 0) this.rooms.delete(roomId);
    return e.record;
  }

  async touch(roomId: string): Promise<void> {
    const e = this.live(roomId);
    if (e) e.expiresAt = this.expiry();
  }

  async claimCode(nameplate: string, roomId: string, ttlSeconds: number): Promise<boolean> {
    const existing = this.codes.get(nameplate);
    if (existing && existing.expiresAt > Date.now()) return false;
    this.codes.set(nameplate, { roomId, expiresAt: Date.now() + ttlSeconds * 1000 });
    return true;
  }

  async resolveCode(nameplate: string): Promise<string | null> {
    const c = this.codes.get(nameplate);
    if (!c || c.expiresAt <= Date.now()) return null;
    return c.roomId;
  }

  async releaseCode(nameplate: string): Promise<void> {
    this.codes.delete(nameplate);
  }

  async publish(channel: string, payload: Buffer): Promise<void> {
    if (!this.subscribed.has(channel)) return;
    // Deliver asynchronously, like a real bus, so callers never re-enter.
    queueMicrotask(() => {
      for (const l of this.listeners) l(channel, payload);
    });
  }

  async subscribe(channel: string): Promise<void> {
    this.subscribed.add(channel);
  }

  async unsubscribe(channel: string): Promise<void> {
    this.subscribed.delete(channel);
  }

  onMessage(listener: (channel: string, payload: Buffer) => void): void {
    this.listeners.add(listener);
  }

  async close(): Promise<void> {
    clearInterval(this.sweeper);
    this.listeners.clear();
  }
}
