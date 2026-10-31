/**
 * Disk-backed store for opt-in store-and-forward copies (see @beam/shared
 * store.ts for the HTTP contract).
 *
 * Layout: <dir>/<id>/meta.json, <dir>/<id>/manifest, <dir>/<id>/c/<index>.
 * Every file is written to a temp name and renamed, so a reader never sees a
 * half-written chunk. Everything stored is ciphertext produced in the sender's
 * browser; the server has no key.
 *
 * Limits: bytes per transfer, bytes in total (reserved up front at create), a
 * TTL, and active uploads per client IP. An upload that stops for
 * ABANDON_MS is marked abandoned (readers stop waiting) and deleted.
 */
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { mkdir, readFile, readdir, rename, rm, writeFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { CHUNK_SIZE, GCM_TAG_BITS, type StoreInfo } from '@beam/shared';

export interface StoreOptions {
  dir: string;
  maxTransferBytes: number;
  maxTotalBytes: number;
  ttlSeconds: number;
  maxActivePerIp: number;
}

interface Meta {
  id: string;
  totalChunks: number;
  cipherBytes: number;
  createdAt: number;
  expiresAt: number;
  tokenHash: string;
  ip: string;
  complete: boolean;
  manifest: boolean;
}

interface Entry {
  meta: Meta;
  have: Set<number>;
  lastActivity: number;
}

export class StoreError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

const TAG_BYTES = GCM_TAG_BITS / 8;
export const MAX_CHUNK_BYTES = CHUNK_SIZE + TAG_BYTES;
export const MAX_MANIFEST_BYTES = 16 * 1024 * 1024;
/** No upload activity for this long → the copy is given up on. */
export const ABANDON_MS = 10 * 60 * 1000;
const ID_RE = /^[a-z0-9]{6,32}$/;

const hashToken = (t: string) => createHash('sha256').update(t).digest('hex');

export class EncryptedStore {
  private readonly entries = new Map<string, Entry>();
  private readonly events = new EventEmitter();
  private readonly sweeper: ReturnType<typeof setInterval>;

  constructor(private readonly opts: StoreOptions) {
    this.events.setMaxListeners(0);
    this.sweeper = setInterval(() => void this.sweep().catch(() => {}), 60_000);
    this.sweeper.unref?.();
  }

  get limits() {
    return { maxBytes: this.opts.maxTransferBytes, ttlSeconds: this.opts.ttlSeconds };
  }

  /** Load copies that survived a restart. */
  async init(): Promise<void> {
    await mkdir(this.opts.dir, { recursive: true });
    for (const id of await readdir(this.opts.dir)) {
      if (!ID_RE.test(id)) continue;
      try {
        const meta = JSON.parse(await readFile(join(this.opts.dir, id, 'meta.json'), 'utf8')) as Meta;
        const have = new Set<number>();
        for (const name of await readdir(join(this.opts.dir, id, 'c')).catch(() => [] as string[])) {
          if (/^\d+$/.test(name)) have.add(Number(name));
        }
        this.entries.set(id, { meta, have, lastActivity: Date.now() });
      } catch {
        await rm(join(this.opts.dir, id), { recursive: true, force: true });
      }
    }
    await this.sweep();
  }

  close(): void {
    clearInterval(this.sweeper);
  }

  private reservedBytes(): number {
    let total = 0;
    for (const e of this.entries.values()) total += e.meta.cipherBytes;
    return total;
  }

  async create(
    id: string,
    req: { totalChunks: number; cipherBytes: number; ip: string },
  ): Promise<{ uploadToken: string; expiresAt: number }> {
    if (!ID_RE.test(id)) throw new StoreError(400, 'Invalid id.');
    const { totalChunks, cipherBytes } = req;
    if (!Number.isInteger(totalChunks) || totalChunks < 1 || !Number.isInteger(cipherBytes) || cipherBytes < 0) {
      throw new StoreError(400, 'Invalid size.');
    }
    if (cipherBytes > totalChunks * MAX_CHUNK_BYTES || cipherBytes < totalChunks * TAG_BYTES) {
      throw new StoreError(400, 'Size and chunk count disagree.');
    }
    if (cipherBytes > this.opts.maxTransferBytes) {
      throw new StoreError(413, 'Too large to keep a copy of on this server.');
    }
    const existing = this.entries.get(id);
    if (existing) await this.remove(id); // the owner is starting over
    if (this.reservedBytes() + cipherBytes > this.opts.maxTotalBytes) {
      throw new StoreError(507, 'The server is out of space for copies right now.');
    }
    const active = [...this.entries.values()].filter((e) => e.meta.ip === req.ip && !e.meta.complete).length;
    if (active >= this.opts.maxActivePerIp) {
      throw new StoreError(429, 'Too many uploads in progress from your network.');
    }

    const uploadToken = randomBytes(24).toString('base64url');
    const now = Date.now();
    const meta: Meta = {
      id,
      totalChunks,
      cipherBytes,
      createdAt: now,
      expiresAt: now + this.opts.ttlSeconds * 1000,
      tokenHash: hashToken(uploadToken),
      ip: req.ip,
      complete: false,
      manifest: false,
    };
    await mkdir(join(this.opts.dir, id, 'c'), { recursive: true });
    await this.writeMeta(meta);
    this.entries.set(id, { meta, have: new Set(), lastActivity: now });
    return { uploadToken, expiresAt: meta.expiresAt };
  }

  private live(id: string): Entry {
    const e = ID_RE.test(id) ? this.entries.get(id) : undefined;
    if (!e || e.meta.expiresAt <= Date.now()) throw new StoreError(404, 'No stored copy.');
    return e;
  }

  private authorize(id: string, token: string | undefined): Entry {
    const e = this.live(id);
    const given = Buffer.from(hashToken(token ?? ''));
    const expected = Buffer.from(e.meta.tokenHash);
    if (!token || given.length !== expected.length || !timingSafeEqual(given, expected)) {
      throw new StoreError(403, 'Not your upload.');
    }
    return e;
  }

  async putManifest(id: string, token: string | undefined, data: Buffer): Promise<void> {
    const e = this.authorize(id, token);
    if (data.length === 0 || data.length > MAX_MANIFEST_BYTES) throw new StoreError(413, 'Manifest too large.');
    await this.atomicWrite(join(this.opts.dir, id, 'manifest'), data);
    e.meta.manifest = true;
    e.lastActivity = Date.now();
    await this.writeMeta(e.meta);
    this.events.emit(`${id}:manifest`);
  }

  async putChunk(id: string, token: string | undefined, index: number, data: Buffer): Promise<void> {
    const e = this.authorize(id, token);
    if (!Number.isInteger(index) || index < 0 || index >= e.meta.totalChunks) {
      throw new StoreError(400, 'Chunk index out of range.');
    }
    if (data.length < TAG_BYTES || data.length > MAX_CHUNK_BYTES) throw new StoreError(413, 'Bad chunk size.');
    await this.atomicWrite(join(this.opts.dir, id, 'c', String(index)), data);
    e.have.add(index);
    e.lastActivity = Date.now();
    this.events.emit(`${id}:${index}`);
  }

  async complete(id: string, token: string | undefined): Promise<void> {
    const e = this.authorize(id, token);
    if (!e.meta.manifest || e.have.size !== e.meta.totalChunks) {
      throw new StoreError(409, 'Upload is not finished.');
    }
    e.meta.complete = true;
    await this.writeMeta(e.meta);
  }

  async delete(id: string, token: string | undefined): Promise<void> {
    this.authorize(id, token);
    await this.remove(id);
  }

  info(id: string): StoreInfo {
    const e = this.live(id);
    return {
      totalChunks: e.meta.totalChunks,
      have: e.have.size,
      manifest: e.meta.manifest,
      complete: e.meta.complete,
      abandoned: this.abandoned(e),
      expiresAt: e.meta.expiresAt,
    };
  }

  async readManifest(id: string): Promise<Buffer | null> {
    const e = this.live(id);
    if (!e.meta.manifest) return null;
    return readFile(join(this.opts.dir, id, 'manifest'));
  }

  /**
   * A chunk, or null if it isn't uploaded (yet). With `waitMs`, waits for it
   * to arrive — that's what lets a download run while the upload still is.
   */
  async readChunk(id: string, index: number, waitMs = 0): Promise<Buffer | null> {
    const e = this.live(id);
    if (!Number.isInteger(index) || index < 0 || index >= e.meta.totalChunks) {
      throw new StoreError(400, 'Chunk index out of range.');
    }
    if (!e.have.has(index) && waitMs > 0 && !this.abandoned(e)) {
      await new Promise<void>((resolve) => {
        const event = `${id}:${index}`;
        const done = () => {
          clearTimeout(timer);
          this.events.off(event, done);
          this.events.off(`${id}:gone`, done);
          resolve();
        };
        const timer = setTimeout(done, waitMs);
        this.events.once(event, done);
        this.events.once(`${id}:gone`, done);
      });
    }
    if (!e.have.has(index) || !this.entries.has(id)) return null;
    return readFile(join(this.opts.dir, id, 'c', String(index)));
  }

  private abandoned(e: Entry): boolean {
    return !e.meta.complete && Date.now() - e.lastActivity > ABANDON_MS;
  }

  private async remove(id: string): Promise<void> {
    this.entries.delete(id);
    this.events.emit(`${id}:gone`);
    await rm(join(this.opts.dir, id), { recursive: true, force: true });
  }

  /** Drop expired copies and uploads abandoned long enough that nobody waits. */
  async sweep(): Promise<void> {
    const now = Date.now();
    for (const [id, e] of this.entries) {
      if (e.meta.expiresAt <= now || (!e.meta.complete && now - e.lastActivity > 2 * ABANDON_MS)) {
        await this.remove(id);
      }
    }
  }

  /** Bytes actually on disk (for tests / ops). */
  async diskBytes(id: string): Promise<number> {
    let total = 0;
    for (const name of await readdir(join(this.opts.dir, id, 'c')).catch(() => [] as string[])) {
      total += (await stat(join(this.opts.dir, id, 'c', name))).size;
    }
    return total;
  }

  private async writeMeta(meta: Meta): Promise<void> {
    await this.atomicWrite(join(this.opts.dir, meta.id, 'meta.json'), Buffer.from(JSON.stringify(meta)));
  }

  private async atomicWrite(path: string, data: Buffer): Promise<void> {
    const tmp = `${path}.${randomBytes(6).toString('hex')}.tmp`;
    await writeFile(tmp, data);
    await rename(tmp, path);
  }
}
