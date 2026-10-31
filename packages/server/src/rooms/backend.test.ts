import { describe, it, expect, vi, afterEach } from 'vitest';
import RedisMock from 'ioredis-mock';
import type { Redis } from 'ioredis';
import type { RoomBackend } from './backend.js';
import { MemoryBackend } from './memoryBackend.js';
import { RedisBackend } from './redisBackend.js';

/** The same lifecycle contract, run against both backends. */
const backends: [string, () => RoomBackend][] = [
  ['memory', () => new MemoryBackend(3600, 3)],
  ['redis', () => new RedisBackend(new RedisMock() as unknown as Redis, 3600, 3)],
];

describe.each(backends)('%s backend', (_name, make) => {
  let b: RoomBackend;
  afterEach(async () => {
    await b.close();
  });

  it('creates a room owned by its first member', async () => {
    b = make();
    await b.createRoom('r', 'owner');
    expect(await b.getRoom('r')).toMatchObject({ owner: 'owner', members: ['owner'] });
  });

  it('admits members up to the cap, idempotently', async () => {
    b = make();
    await b.createRoom('r', 'o');
    expect((await b.addMember('r', 'a')).ok).toBe(true);
    expect((await b.addMember('r', 'a')).ok).toBe(true);
    expect((await b.addMember('r', 'b')).ok).toBe(true);
    expect(await b.addMember('r', 'c')).toEqual({ ok: false, reason: 'room-full' });
    expect(await b.addMember('ghost', 'c')).toEqual({ ok: false, reason: 'room-not-found' });
  });

  it('deletes the room once empty', async () => {
    b = make();
    await b.createRoom('r', 'o');
    await b.addMember('r', 'a');
    expect((await b.removeMember('r', 'o'))?.members).toEqual(['a']);
    await b.removeMember('r', 'a');
    expect(await b.getRoom('r')).toBeNull();
  });
});

describe('memory backend expiry and bus', () => {
  it('expires idle rooms and delivers only subscribed channels', async () => {
    vi.useFakeTimers();
    const b = new MemoryBackend(10, 2);
    await b.createRoom('r', 'o');
    vi.advanceTimersByTime(11_000);
    expect(await b.getRoom('r')).toBeNull();
    vi.useRealTimers();

    const got: string[] = [];
    b.onMessage((ch, p) => got.push(`${ch}:${p.toString()}`));
    await b.subscribe('a');
    await b.publish('a', Buffer.from('1'));
    await b.publish('b', Buffer.from('2'));
    await new Promise((r) => setTimeout(r, 0));
    expect(got).toEqual(['a:1']);
    await b.close();
  });
});
