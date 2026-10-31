/**
 * Incremental CRC-32 (IEEE 802.3), slicing-by-8.
 *
 * Needed by the streaming zip writer: entries are written with a data
 * descriptor, so each file's CRC is accumulated chunk by chunk as it streams
 * through and only emitted after the file's last byte. Slicing-by-8 processes
 * eight bytes per table round, which keeps CRC well ahead of network speed.
 */

const TABLES: Uint32Array[] = (() => {
  const t0 = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t0[n] = c >>> 0;
  }
  const tables = [t0];
  for (let s = 1; s < 8; s++) {
    const prev = tables[s - 1]!;
    const t = new Uint32Array(256);
    for (let n = 0; n < 256; n++) t[n] = (prev[n]! >>> 8) ^ t0[prev[n]! & 0xff]!;
    tables.push(t);
  }
  return tables;
})();

export class Crc32 {
  private crc = 0xffffffff;

  update(data: Uint8Array): void {
    const [t0, t1, t2, t3, t4, t5, t6, t7] = TABLES as [
      Uint32Array, Uint32Array, Uint32Array, Uint32Array,
      Uint32Array, Uint32Array, Uint32Array, Uint32Array,
    ];
    let crc = this.crc;
    let i = 0;
    const end8 = data.length - (data.length % 8);
    for (; i < end8; i += 8) {
      const a = (data[i]! | (data[i + 1]! << 8) | (data[i + 2]! << 16) | (data[i + 3]! << 24)) ^ crc;
      const b = data[i + 4]! | (data[i + 5]! << 8) | (data[i + 6]! << 16) | (data[i + 7]! << 24);
      crc =
        t7[a & 0xff]! ^ t6[(a >>> 8) & 0xff]! ^ t5[(a >>> 16) & 0xff]! ^ t4[a >>> 24]! ^
        t3[b & 0xff]! ^ t2[(b >>> 8) & 0xff]! ^ t1[(b >>> 16) & 0xff]! ^ t0[b >>> 24]!;
    }
    for (; i < data.length; i++) crc = t0[(crc ^ data[i]!) & 0xff]! ^ (crc >>> 8);
    this.crc = crc;
  }

  digest(): number {
    return (this.crc ^ 0xffffffff) >>> 0;
  }
}
