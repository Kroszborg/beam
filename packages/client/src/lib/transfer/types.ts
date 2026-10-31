/**
 * Shared types for the transfer layer: lifecycle states (which drive the UI)
 * and the progress snapshot shown to the user.
 */

/** Sender-side state of one receiver's upload. */
export type UploadState = 'connected' | 'sending' | 'complete' | 'error';

/** Receiver UI states, in order. */
export type ReceiverState =
  | 'idle'
  | 'joining' // contacting signaling, joining the room
  | 'connecting' // WebRTC handshake in progress
  | 'connected' // secure channel established, waiting for the file list
  | 'ready' // file list received, waiting for the user to choose where to save
  | 'receiving'
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
  /** Smoothed throughput in bytes/sec. */
  speedBps: number;
  /** Estimated seconds remaining, or null when not yet estimable. */
  etaSeconds: number | null;
}

/** A received file the user still has to save (IndexedDB fallback only). */
export interface CompletedFile {
  name: string;
  path: string;
  size: number;
  type: string;
  save: () => Promise<void>;
}
