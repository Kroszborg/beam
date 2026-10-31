import { describe, it, expect } from 'vitest';
import { createHash } from 'node:crypto';
import yauzl from 'yauzl';
import { ZipStreamWriter, zipSize, sanitizeZipPath } from './zipWriter';
import { Crc32 } from './crc32';

function bytes(n: number, seed: number): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(n);
  let x = seed || 1;
  for (let i = 0; i < n; i++) {
    x = (x * 1103515245 + 12345) >>> 0;
    out[i] = x >>> 24;
  }
  return out;
}

const sha = (b: Uint8Array) => createHash('sha256').update(b).digest('hex');

function readZip(buf: Buffer): Promise<Map<string, Buffer>> {
  return new Promise((resolve, reject) => {
    yauzl.fromBuffer(buf, { lazyEntries: true, validateEntrySizes: true }, (err, zip) => {
      if (err || !zip) return reject(err);
      const out = new Map<string, Buffer>();
      zip.on('entry', (entry: yauzl.Entry) => {
        zip.openReadStream(entry, (e, stream) => {
          if (e || !stream) return reject(e);
          const parts: Buffer[] = [];
          stream.on('data', (d: Buffer) => parts.push(d));
          stream.on('end', () => {
            out.set(entry.fileName, Buffer.concat(parts));
            zip.readEntry();
          });
        });
      });
      zip.on('end', () => resolve(out));
      zip.on('error', reject);
      zip.readEntry();
    });
  });
}

describe('crc32', () => {
  it('matches the reference value and is chunk-boundary independent', () => {
    const c = new Crc32();
    c.update(new TextEncoder().encode('123456789'));
    expect(c.digest()).toBe(0xcbf43926);

    const data = bytes(10_001, 3);
    const whole = new Crc32();
    whole.update(data);
    const split = new Crc32();
    split.update(data.subarray(0, 7));
    split.update(data.subarray(7, 4096));
    split.update(data.subarray(4096));
    expect(split.digest()).toBe(whole.digest());
  });
});

describe('ZipStreamWriter', () => {
  it('produces an archive of exactly zipSize() bytes that standard readers accept', async () => {
    const files = [
      { name: 'photos/a.jpg', data: bytes(300_000, 1) },
      { name: 'empty.txt', data: new Uint8Array(0) },
      { name: 'docs/nested/ünïcode.bin', data: bytes(70_000, 2) },
    ];
    const entries = files.map((f) => ({ name: f.name, size: f.data.length, lastModified: 0 }));
    const parts: Uint8Array[] = [];
    const w = new ZipStreamWriter(entries, async (b) => {
      parts.push(b.slice());
    });
    for (let i = 0; i < files.length; i++) {
      const d = files[i]!.data;
      // Feed in uneven pieces like network chunks.
      for (let o = 0; o < d.length; o += 65_536) await w.write(i, d.subarray(o, o + 65_536));
    }
    await w.finish();

    const zip = Buffer.concat(parts);
    expect(zip.length).toBe(zipSize(entries));

    const read = await readZip(zip);
    expect([...read.keys()].sort()).toEqual(files.map((f) => f.name).sort());
    for (const f of files) expect(sha(read.get(f.name)!)).toBe(sha(f.data));
  });

  it('rejects out-of-order and overflowing writes', async () => {
    const w = new ZipStreamWriter(
      [
        { name: 'a', size: 2 },
        { name: 'b', size: 2 },
      ],
      async () => {},
    );
    await expect(w.write(0, new Uint8Array(3))).rejects.toThrow(/overflow/);
    const w2 = new ZipStreamWriter([{ name: 'a', size: 2 }, { name: 'b', size: 0 }], async () => {});
    await w2.write(0, new Uint8Array(2));
    await w2.write(1, new Uint8Array(0));
    await expect(w2.write(0, new Uint8Array(1))).rejects.toThrow(/order/);
  });

  it('sanitizes hostile paths', () => {
    expect(sanitizeZipPath('../../etc/passwd')).toBe('etc/passwd');
    expect(sanitizeZipPath('C:\\x\\..\\y.txt')).toBe('C:/x/y.txt');
    expect(sanitizeZipPath('/abs/./z')).toBe('abs/z');
    expect(sanitizeZipPath('')).toBe('file');
  });
});
