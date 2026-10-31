/**
 * Where received bytes go.
 *
 * The receiver decrypts each chunk and hands it to a sink. Which sink is used
 * decides how large a transfer can be:
 *
 *   • fs      — File System Access API (Chromium desktop). Writes go straight
 *               into the file(s) the user picked, at their byte offsets.
 *   • stream  — Service Worker streaming download. The browser's own download
 *               manager writes to disk; multi-file transfers stream as a zip.
 *   • idb     — IndexedDB, then a Blob download at the end. Bounded by the
 *               browser's storage quota; only used when neither of the above
 *               is available (e.g. Firefox private windows).
 *
 * The first two never hold more than one chunk in memory and never write the
 * file twice, which is what lets a transfer be as large as the receiver's disk.
 */
import type { CompletedFile } from '../types.js';

export type SinkKind = 'fs' | 'stream' | 'idb';

/** A file selected for download, in manifest order. */
export interface SinkFile {
  /** Index of the file in the manifest. */
  index: number;
  /** Relative path (may contain `/` for folder transfers). */
  path: string;
  size: number;
  type: string;
  lastModified: number;
}

export interface SinkChunk {
  chunkIndex: number;
  fileIndex: number;
  /** Byte offset of `data` within its file. */
  offset: number;
  data: Uint8Array;
}

export interface FileSink {
  readonly kind: SinkKind;
  /**
   * Whether `write` must be called in file order with sequential offsets.
   * Streaming sinks can't seek; the receiver always delivers in order, so this
   * only matters for resume (which then also resumes in order).
   */
  readonly sequential: boolean;
  /**
   * Prepare for writing. Resolves with chunk indices already persisted from an
   * earlier session (resume after reload) — empty for sinks that can't resume.
   */
  open(): Promise<Set<number>>;
  write(chunk: SinkChunk): Promise<void>;
  /**
   * Every selected byte has been written. Resolves with files the user still
   * has to save manually (idb sink), or null when they're already on disk.
   */
  close(): Promise<CompletedFile[] | null>;
  abort(): Promise<void>;
}
