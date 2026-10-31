/**
 * Maps the global chunk index space onto files, derived purely from the
 * manifest so both peers agree exactly: files in manifest order, each split
 * into `chunkSize` chunks, a chunk never spanning two files, and an empty file
 * still owning one (empty) chunk so it gets created on the receiver.
 */
import { chunkCountFor, type FileEntry } from '@beam/shared';

export interface ChunkTarget {
  fileIndex: number;
  byteStart: number;
  /** Plaintext length of this chunk. */
  length: number;
}

export class TransferLayout {
  /** Global index of each file's first chunk. */
  private readonly starts: number[] = [];
  private readonly counts: number[] = [];
  readonly totalChunks: number;

  constructor(
    private readonly files: Pick<FileEntry, 'size'>[],
    private readonly chunkSize: number,
  ) {
    let acc = 0;
    for (const f of files) {
      const n = chunkCountFor(f.size, chunkSize);
      this.starts.push(acc);
      this.counts.push(n);
      acc += n;
    }
    this.totalChunks = acc;
  }

  /** Chunk range [start, start + count) owned by a file. */
  range(fileIndex: number): { start: number; count: number } {
    return { start: this.starts[fileIndex]!, count: this.counts[fileIndex]! };
  }

  /** Resolve a global chunk index to its file, byte offset and length. */
  target(index: number): ChunkTarget {
    if (index < 0 || index >= this.totalChunks) throw new RangeError(`chunk ${index} out of range`);
    // Binary search: last file whose first chunk is <= index.
    let lo = 0;
    let hi = this.starts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (this.starts[mid]! <= index) lo = mid;
      else hi = mid - 1;
    }
    const byteStart = (index - this.starts[lo]!) * this.chunkSize;
    const size = this.files[lo]!.size;
    return { fileIndex: lo, byteStart, length: Math.min(this.chunkSize, size - byteStart) };
  }
}
