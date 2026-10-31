import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import type { StoreInfo } from '@beam/shared';
import { buildApp, type BuiltApp } from '../app.js';
import type { StoreOptions } from './encryptedStore.js';

/**
 * Store-and-forward over real HTTP: ownership, uploads, reading while the
 * upload is still running (long-poll), limits, completion and deletion, and
 * survival across a restart.
 */

let built: BuiltApp | null = null;
const dirs: string[] = [];

afterEach(async () => {
  await built?.app.close();
  await built?.close();
  built = null;
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function options(over: Partial<StoreOptions> = {}): StoreOptions {
  const dir = mkdtempSync(join(tmpdir(), 'beam-store-'));
  dirs.push(dir);
  return { dir, maxTransferBytes: 8 * 1024 * 1024, maxTotalBytes: 16 * 1024 * 1024, ttlSeconds: 3600, maxActivePerIp: 3, ...over };
}

async function start(store: StoreOptions) {
  built = await buildApp({ store });
  await built.app.listen({ port: 0, host: '127.0.0.1' });
  const { port } = built.app.server.address() as AddressInfo;
  return `127.0.0.1:${port}`;
}

/** A sender room over the real WebSocket, for the ownership proof. */
async function room(host: string) {
  const ws = new WebSocket(`ws://${host}/ws`);
  await new Promise((r) => ws.addEventListener('open', r, { once: true }));
  const msg = new Promise<{ roomId: string; peerId: string; token: string }>((r) =>
    ws.addEventListener('message', (e) => r(JSON.parse(String(e.data))), { once: true }),
  );
  ws.send(JSON.stringify({ type: 'create-room' }));
  return { ws, ...(await msg) };
}

const bin = (n: number, fill: number) => new Uint8Array(n).fill(fill);

describe('store-and-forward', () => {
  it('stores an upload and serves it, even while it is still uploading', async () => {
    const host = await start(options());
    const base = `http://${host}/store`;
    const r = await room(host);

    const forged = await fetch(base, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ roomId: r.roomId, peerId: r.peerId, token: 'nope', totalChunks: 2, cipherBytes: 100 }),
    });
    expect(forged.status).toBe(403);

    const created = await fetch(base, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ roomId: r.roomId, peerId: r.peerId, token: r.token, totalChunks: 2, cipherBytes: 100 }),
    });
    expect(created.status).toBe(201);
    const { uploadToken } = (await created.json()) as { uploadToken: string };
    const auth = { authorization: `Bearer ${uploadToken}`, 'content-type': 'application/octet-stream' };

    expect((await fetch(`${base}/${r.roomId}/manifest`)).status).toBe(404);
    expect((await fetch(`${base}/${r.roomId}/manifest`, { method: 'PUT', headers: { ...auth, authorization: 'Bearer x' }, body: bin(10, 1) })).status).toBe(403);
    expect((await fetch(`${base}/${r.roomId}/manifest`, { method: 'PUT', headers: auth, body: bin(10, 1) })).status).toBe(204);

    // A reader waits for chunk 1 while it's uploaded a moment later.
    const waiting = fetch(`${base}/${r.roomId}/chunks/1?wait=1`);
    await new Promise((res) => setTimeout(res, 150));
    expect((await fetch(`${base}/${r.roomId}/chunks/1`, { method: 'PUT', headers: auth, body: bin(40, 2) })).status).toBe(204);
    const got = await waiting;
    expect(got.status).toBe(200);
    expect(new Uint8Array(await got.arrayBuffer())).toEqual(bin(40, 2));

    expect((await fetch(`${base}/${r.roomId}/chunks/0`)).status).toBe(204); // not there yet, no wait
    expect((await fetch(`${base}/${r.roomId}/chunks/2`, { method: 'PUT', headers: auth, body: bin(40, 3) })).status).toBe(400);
    expect((await fetch(`${base}/${r.roomId}/complete`, { method: 'POST', headers: auth })).status).toBe(409);
    await fetch(`${base}/${r.roomId}/chunks/0`, { method: 'PUT', headers: auth, body: bin(60, 4) });
    expect((await fetch(`${base}/${r.roomId}/complete`, { method: 'POST', headers: auth })).status).toBe(204);

    const info = (await (await fetch(`${base}/${r.roomId}`)).json()) as StoreInfo;
    expect(info).toMatchObject({ totalChunks: 2, have: 2, manifest: true, complete: true, abandoned: false });

    // Survives a restart of the server.
    const dir = dirs[0]!;
    r.ws.close();
    await built!.app.close();
    await built!.close();
    built = null;
    const host2 = await start({ ...options(), dir });
    const again = await fetch(`http://${host2}/store/${r.roomId}/chunks/0`);
    expect(new Uint8Array(await again.arrayBuffer())).toEqual(bin(60, 4));

    expect((await fetch(`http://${host2}/store/${r.roomId}`, { method: 'DELETE', headers: auth })).status).toBe(204);
    expect((await fetch(`http://${host2}/store/${r.roomId}`)).status).toBe(404);
  });

  it('enforces per-transfer, total and per-IP limits', async () => {
    const host = await start(options({ maxTransferBytes: 1000, maxTotalBytes: 2500, maxActivePerIp: 2 }));
    const create = async (cipherBytes: number) => {
      const r = await room(host);
      const res = await fetch(`http://${host}/store`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ roomId: r.roomId, peerId: r.peerId, token: r.token, totalChunks: 1, cipherBytes }),
      });
      r.ws.close();
      return res.status;
    };
    expect(await create(1001)).toBe(413);
    expect(await create(1000)).toBe(201);
    expect(await create(1000)).toBe(201);
    expect(await create(400)).toBe(429); // two unfinished uploads from this IP
  });

  it('is absent unless enabled', async () => {
    built = await buildApp({ store: null });
    await built.app.listen({ port: 0, host: '127.0.0.1' });
    const { port } = built.app.server.address() as AddressInfo;
    const ice = (await (await fetch(`http://127.0.0.1:${port}/ice`)).json()) as { store?: unknown };
    expect(ice.store).toBeUndefined();
    expect((await fetch(`http://127.0.0.1:${port}/store/abcdefgh`)).status).toBe(404);
  });
});
