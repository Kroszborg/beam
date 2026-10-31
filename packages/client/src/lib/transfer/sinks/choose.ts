/**
 * Picking the best sink for this browser.
 *
 * Preference: fs (save straight into the chosen file/folder) → stream (the
 * browser's download manager) → idb (bounded by storage quota). `?sink=` in
 * the page URL forces one, for testing.
 *
 * `chooseSink` must run inside the user's click: the fs path opens a native
 * picker, which browsers only allow with fresh user activation, so nothing may
 * be awaited before it.
 */
import { pickFsSink, fsAccessAvailable } from './fsSink.js';
import { createStreamSink, registerStreamWorker, streamDownloadAvailable } from './streamSink.js';
import { IdbSink, storageHeadroom } from './idbSink.js';
import type { FileSink, SinkFile, SinkKind } from './types.js';

export interface SinkOption {
  kind: SinkKind;
  /** For idb: bytes the browser will let us store, if known. */
  headroom: number | null;
}

function forced(): SinkKind | null {
  const v = new URLSearchParams(window.location.search).get('sink');
  return v === 'fs' || v === 'stream' || v === 'idb' ? v : null;
}

/** Warm up the service worker early so it's active by the time the user clicks. */
export function prepareSinks(): void {
  void registerStreamWorker();
}

export async function sinkOptions(fileCount: number): Promise<SinkOption> {
  const f = forced();
  if (f) return { kind: f, headroom: f === 'idb' ? await storageHeadroom() : null };
  if (fsAccessAvailable(fileCount)) return { kind: 'fs', headroom: null };
  if (await streamDownloadAvailable()) return { kind: 'stream', headroom: null };
  return { kind: 'idb', headroom: await storageHeadroom() };
}

export function chooseSink(
  kind: SinkKind,
  transferId: string,
  files: SinkFile[],
  ranges: Map<number, { start: number; count: number }>,
): Promise<FileSink> {
  switch (kind) {
    case 'fs':
      return pickFsSink(files);
    case 'stream':
      return Promise.resolve(createStreamSink(files));
    case 'idb':
      return Promise.resolve(new IdbSink(transferId, files, ranges));
  }
}
