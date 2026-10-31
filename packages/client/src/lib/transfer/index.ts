/**
 * Transfer protocol layer public API.
 *
 * Composes the encryption layer (crypto) and transport layer (webrtc) into the
 * end-to-end chunked, authenticated, flow-controlled, resumable transfer — but
 * depends on them only through their narrow public APIs, never their internals.
 */
export { FileSender, Upload } from './fileSender.js';
export type { UploadCallbacks } from './fileSender.js';
export { FileReceiver, toRanges } from './fileReceiver.js';
export type { FileReceiverCallbacks } from './fileReceiver.js';
export { TransferLayout } from './layout.js';
export { buildManifest, sealManifest, openManifest, validateManifest, ManifestError } from './manifest.js';
export { frames, Reassembler } from './wire.js';
export { ProgressTracker } from './progress.js';
export { ResumeStore } from './resumeStore.js';
export { chooseSink, sinkOptions, prepareSinks } from './sinks/choose.js';
export type { SinkOption } from './sinks/choose.js';
export type { FileSink, SinkFile, SinkKind } from './sinks/types.js';
export type {
  UploadState,
  ReceiverState,
  TransferProgress,
  CompletedFile,
} from './types.js';
