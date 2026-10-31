/**
 * Streaming ZIP64 writer (store / no compression).
 *
 * Lets a multi-file or folder transfer land as a single download without ever
 * holding more than one chunk in memory. Every entry is written as:
 *
 *   local header (sizes deferred, ZIP64 extra) → raw bytes → ZIP64 data descriptor
 *
 * and the archive closes with a central directory, ZIP64 end record + locator,
 * and the classic end record. ZIP64 is used for every entry unconditionally, so
 * the layout — and therefore the exact archive size — is known before the first
 * byte is produced (`zipSize`). That lets the download advertise a real
 * Content-Length and progress bar. Already-compressed media gains nothing from
 * deflate, and store mode keeps the writer cheap enough to run at line speed.
 */
import { Crc32 } from './crc32.js';

export interface ZipEntryInput {
  /** Path inside the archive; `/` separates folders. */
  name: string;
  size: number;
  lastModified?: number;
}

const enc = new TextEncoder();

const LOCAL_FIXED = 30;
const LOCAL_EXTRA = 20; // 0x0001 header (4) + uncompressed (8) + compressed (8)
const DESCRIPTOR = 24; // sig (4) + crc (4) + compressed (8) + uncompressed (8)
const CENTRAL_FIXED = 46;
const CENTRAL_EXTRA = 28; // 0x0001 header (4) + uncompressed + compressed + offset
const ZIP64_EOCD = 56;
const ZIP64_LOCATOR = 20;
const EOCD = 22;

const FLAGS = 0x0808; // bit 3: data descriptor, bit 11: UTF-8 names
const VERSION = 45; // ZIP64

/** Make an archive path safe: forward slashes, no absolute or `..` segments. */
export function sanitizeZipPath(name: string): string {
  const parts = name
    .replace(/\\/g, '/')
    .split('/')
    .filter((p) => p && p !== '.' && p !== '..');
  return parts.join('/') || 'file';
}

/** Exact byte size of the archive `ZipStreamWriter` will produce. */
export function zipSize(entries: ZipEntryInput[]): number {
  let total = ZIP64_EOCD + ZIP64_LOCATOR + EOCD;
  for (const e of entries) {
    const n = enc.encode(sanitizeZipPath(e.name)).length;
    total += LOCAL_FIXED + n + LOCAL_EXTRA + e.size + DESCRIPTOR;
    total += CENTRAL_FIXED + n + CENTRAL_EXTRA;
  }
  return total;
}

function dosDateTime(ms: number | undefined): { time: number; date: number } {
  const d = new Date(ms ?? Date.now());
  const year = Math.max(1980, d.getFullYear());
  return {
    time: (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1),
    date: ((year - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate(),
  };
}

interface EntryState {
  name: Uint8Array;
  size: number;
  time: number;
  date: number;
  offset: number;
  crc: number;
}

export class ZipStreamWriter {
  private readonly entries: EntryState[];
  private offset = 0;
  /** Index of the entry currently open for data, or -1. */
  private current = -1;
  private written = 0;
  private crc = new Crc32();
  private finished = false;

  constructor(
    inputs: ZipEntryInput[],
    private readonly emit: (bytes: Uint8Array) => Promise<void>,
  ) {
    this.entries = inputs.map((e) => ({
      name: enc.encode(sanitizeZipPath(e.name)),
      size: e.size,
      ...dosDateTime(e.lastModified),
      offset: 0,
      crc: 0,
    }));
  }

  /**
   * Append bytes to entry `index`. Entries must be written in order and each
   * entry's bytes sequentially; skipping ahead closes the entries in between,
   * which is only valid if they are empty.
   */
  async write(index: number, data: Uint8Array): Promise<void> {
    await this.advanceTo(index);
    if (this.written + data.length > this.entries[index]!.size) {
      throw new Error('zip: entry overflow');
    }
    this.crc.update(data);
    this.written += data.length;
    await this.out(data);
  }

  async finish(): Promise<void> {
    if (this.finished) return;
    await this.advanceTo(this.entries.length);
    this.finished = true;

    const cdStart = this.offset;
    for (const e of this.entries) await this.out(this.centralHeader(e));
    const cdSize = this.offset - cdStart;
    const zip64Start = this.offset;

    const tail = new Uint8Array(ZIP64_EOCD + ZIP64_LOCATOR + EOCD);
    const v = new DataView(tail.buffer);
    const count = this.entries.length;
    // ZIP64 end of central directory record
    v.setUint32(0, 0x06064b50, true);
    v.setBigUint64(4, BigInt(ZIP64_EOCD - 12), true);
    v.setUint16(12, VERSION, true);
    v.setUint16(14, VERSION, true);
    v.setBigUint64(24, BigInt(count), true);
    v.setBigUint64(32, BigInt(count), true);
    v.setBigUint64(40, BigInt(cdSize), true);
    v.setBigUint64(48, BigInt(cdStart), true);
    // ZIP64 end of central directory locator
    let p = ZIP64_EOCD;
    v.setUint32(p, 0x07064b50, true);
    v.setBigUint64(p + 8, BigInt(zip64Start), true);
    v.setUint32(p + 16, 1, true);
    // Classic end of central directory (sentinels point readers at ZIP64)
    p += ZIP64_LOCATOR;
    v.setUint32(p, 0x06054b50, true);
    v.setUint16(p + 8, Math.min(count, 0xffff), true);
    v.setUint16(p + 10, Math.min(count, 0xffff), true);
    v.setUint32(p + 12, 0xffffffff, true);
    v.setUint32(p + 16, 0xffffffff, true);
    await this.out(tail);
  }

  private async advanceTo(index: number): Promise<void> {
    if (this.finished) throw new Error('zip: already finished');
    if (index < this.current) throw new Error('zip: entries must be written in order');
    while (this.current < index) {
      if (this.current >= 0) await this.closeCurrent();
      this.current += 1;
      if (this.current < this.entries.length) await this.openCurrent();
    }
  }

  private async openCurrent(): Promise<void> {
    const e = this.entries[this.current]!;
    e.offset = this.offset;
    this.written = 0;
    this.crc = new Crc32();

    const h = new Uint8Array(LOCAL_FIXED + e.name.length + LOCAL_EXTRA);
    const v = new DataView(h.buffer);
    v.setUint32(0, 0x04034b50, true);
    v.setUint16(4, VERSION, true);
    v.setUint16(6, FLAGS, true);
    v.setUint16(8, 0, true); // stored
    v.setUint16(10, e.time, true);
    v.setUint16(12, e.date, true);
    v.setUint32(18, 0xffffffff, true);
    v.setUint32(22, 0xffffffff, true);
    v.setUint16(26, e.name.length, true);
    v.setUint16(28, LOCAL_EXTRA, true);
    h.set(e.name, LOCAL_FIXED);
    const x = LOCAL_FIXED + e.name.length;
    v.setUint16(x, 0x0001, true);
    v.setUint16(x + 2, 16, true);
    // Sizes are deferred to the data descriptor; leave zeros here.
    await this.out(h);
  }

  private async closeCurrent(): Promise<void> {
    const e = this.entries[this.current]!;
    if (this.written !== e.size) {
      throw new Error(`zip: entry ${this.current} ended at ${this.written}/${e.size} bytes`);
    }
    e.crc = this.crc.digest();
    const d = new Uint8Array(DESCRIPTOR);
    const v = new DataView(d.buffer);
    v.setUint32(0, 0x08074b50, true);
    v.setUint32(4, e.crc, true);
    v.setBigUint64(8, BigInt(e.size), true);
    v.setBigUint64(16, BigInt(e.size), true);
    await this.out(d);
  }

  private centralHeader(e: EntryState): Uint8Array {
    const h = new Uint8Array(CENTRAL_FIXED + e.name.length + CENTRAL_EXTRA);
    const v = new DataView(h.buffer);
    v.setUint32(0, 0x02014b50, true);
    v.setUint16(4, VERSION, true);
    v.setUint16(6, VERSION, true);
    v.setUint16(8, FLAGS, true);
    v.setUint16(10, 0, true);
    v.setUint16(12, e.time, true);
    v.setUint16(14, e.date, true);
    v.setUint32(16, e.crc, true);
    v.setUint32(20, 0xffffffff, true);
    v.setUint32(24, 0xffffffff, true);
    v.setUint16(28, e.name.length, true);
    v.setUint16(30, CENTRAL_EXTRA, true);
    v.setUint32(42, 0xffffffff, true);
    h.set(e.name, CENTRAL_FIXED);
    const x = CENTRAL_FIXED + e.name.length;
    v.setUint16(x, 0x0001, true);
    v.setUint16(x + 2, 24, true);
    v.setBigUint64(x + 4, BigInt(e.size), true);
    v.setBigUint64(x + 12, BigInt(e.size), true);
    v.setBigUint64(x + 20, BigInt(e.offset), true);
    return h;
  }

  private async out(bytes: Uint8Array): Promise<void> {
    this.offset += bytes.length;
    await this.emit(bytes);
  }
}
