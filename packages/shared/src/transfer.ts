/**
 * Transfer protocol v2 — what travels over the peer-to-peer channel.
 *
 * ── Messages ──────────────────────────────────────────────────
 * Binary messages carry encrypted payloads, split into wire frames:
 *
 *   kind MANIFEST  the AES-GCM-encrypted manifest (file list, sizes, nonce)
 *   kind CHUNK     one AES-GCM-encrypted chunk of file data
 *
 * Small JSON strings carry control: the receiver's `hello`, its `request` (which chunks it
 * wants), `ack`s (flow control + truthful progress), `transfer-complete`, and
 * `error`.
 *
 * ── Integrity without a pre-pass ──────────────────────────────
 * Every chunk is sealed with AES-256-GCM under the link key, using
 * IV = baseNonce ‖ chunkIndex. The tag authenticates the bytes *and* their
 * position, the manifest (also sealed) fixes the exact chunk count and sizes,
 * and the receiver checks each chunk's length against it. So tampering,
 * reordering, substitution and truncation are all detected without hashing the
 * files before the link can be shared.
 *
 * ── Flow control ──────────────────────────────────────────────
 * The sender keeps at most RECEIVE_WINDOW_CHUNKS chunks un-acked. The receiver
 * acks a chunk only once it is on disk, so a slow disk slows the sender instead
 * of filling the receiver's memory.
 */

export const PROTOCOL_VERSION = 2;

/** Plaintext bytes per chunk: the unit of encryption, acking and resume. */
export const CHUNK_SIZE = 1024 * 1024; // 1 MiB

/** Chunks the sender may have in flight before it waits for an ack. */
export const RECEIVE_WINDOW_CHUNKS = 32;

/**
 * Wire frame payload limits. The actual size is min(peer's SCTP
 * max-message-size, MAX_FRAME_SIZE); MIN is the floor for unknown peers.
 */
export const MAX_FRAME_SIZE = 64 * 1024;
export const MIN_FRAME_SIZE = 16 * 1024;

/**
 * DataChannel send-buffer watermarks. The sender fills the channel's buffer up
 * to HIGH, then waits for the `bufferedamountlow` event at LOW. Keeping several
 * MB queued is what sustains throughput on high-latency links.
 */
export const SEND_BUFFER_HIGH = 4 * 1024 * 1024;
export const SEND_BUFFER_LOW = 1024 * 1024;

/** IV suffix reserved for the manifest (no chunk can have this index). */
export const MANIFEST_IV_INDEX = 0xffffffff;

/** Upper bounds a receiver enforces on a manifest before trusting it. */
export const MAX_FILES = 100_000;
export const MAX_PATH_LENGTH = 1024;

// ── Manifest (sent encrypted) ─────────────────────────────────

export interface FileEntry {
  /** Relative path; `/` separates folders. */
  path: string;
  size: number;
  type: string;
  lastModified: number;
}

export interface Manifest {
  v: typeof PROTOCOL_VERSION;
  transferId: string;
  files: FileEntry[];
  chunkSize: number;
  totalBytes: number;
  totalChunks: number;
}

// ── Control messages (JSON) ───────────────────────────────────

/**
 * Receiver → sender, first message on every channel: "I'm listening, send the
 * manifest". Waiting for it (instead of sending the manifest the moment the
 * channel opens) means nothing is lost when the receiver attaches late, as
 * with the relay transport.
 */
export interface HelloMessage {
  type: 'hello';
  v: number;
}

/** A run of global chunk indices: [start, end). */
export type ChunkRange = [start: number, end: number];

/**
 * Receiver → sender: send these chunks, in order. Replaces any earlier
 * request, so it also serves as "resume from here" after a reconnect and as
 * "cancel" when empty.
 */
export interface RequestMessage {
  type: 'request';
  transferId: string;
  ranges: ChunkRange[];
  /** Bytes the receiver wants in total, incl. those it already has. */
  wantBytes: number;
  /** Bytes of the wanted set it already holds (resume). */
  haveBytes: number;
}

/** Receiver → sender: `count` more chunks of the current request are on disk. */
export interface AckMessage {
  type: 'ack';
  count: number;
}

export interface TransferCompleteMessage {
  type: 'transfer-complete';
  transferId: string;
}

export interface ProtocolErrorMessage {
  type: 'error';
  code: ProtocolErrorCode;
  message: string;
}

export type ProtocolErrorCode =
  | 'verification-failed'
  | 'version-mismatch'
  | 'read-failed'
  | 'aborted';

export type ControlMessage =
  | HelloMessage
  | RequestMessage
  | AckMessage
  | TransferCompleteMessage
  | ProtocolErrorMessage;

// ── Binary frames ─────────────────────────────────────────────

/**
 * 12-byte big-endian frame header:
 *
 *   offset  size  field
 *   0       1     kind      FRAME_KIND_*
 *   1       1     version   PROTOCOL_VERSION
 *   2       2     reserved
 *   4       4     index     chunk index (0 for the manifest)
 *   8       4     total     byte length of the whole encrypted message
 *
 * Frames of one message are sent back to back on an ordered channel, so the
 * receiver appends payloads until it has `total` bytes.
 */
export const FRAME_HEADER_BYTES = 12;
export const FRAME_KIND_MANIFEST = 1;
export const FRAME_KIND_CHUNK = 2;

/** Global chunk-index layout shared by both peers: files in order, chunks never span files. */
export function chunkCountFor(size: number, chunkSize: number): number {
  return Math.max(1, Math.ceil(size / chunkSize));
}
