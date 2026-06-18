/**
 * Shared types for the transfer layer: lifecycle states (which drive the UI)
 * and the progress snapshot shown to the user.
 */

/** Sender UI states, in order. */
export type SenderState =
  | 'idle'
  | 'preparing' // building manifest (hashing chunks, computing Merkle root)
  | 'waiting' // manifest ready, waiting for a receiver to connect
  | 'connected' // secure channel open, about to stream
  | 'sending'
  | 'complete'
  | 'error';

/** Receiver UI states, in order. */
export type ReceiverState =
  | 'idle'
  | 'joining' // contacting signaling, joining the room
  | 'connecting' // WebRTC handshake in progress
  | 'connected' // secure channel established
  | 'receiving'
  | 'verifying' // final Merkle verification + assembly
  | 'complete'
  | 'error';

/** A live snapshot of transfer progress, suitable for direct rendering. */
export interface TransferProgress {
  bytesTransferred: number;
  totalBytes: number;
  chunksTransferred: number;
  totalChunks: number;
  /** 0..1 */
  percent: number;
  /** Instantaneous-ish throughput in bytes/sec. */
  speedBps: number;
  /** Estimated seconds remaining, or null when not yet estimable. */
  etaSeconds: number | null;
}

/** A received file ready for the user to save (streamed from IndexedDB). */
export interface CompletedFile {
  name: string;
  size: number;
  type: string;
  /** Read the whole file's bytes (for integrity checks / tests). */
  getBytes: () => Promise<Uint8Array>;
  /** Save to disk — streams via the File System Access API where available. */
  save: () => Promise<void>;
}
