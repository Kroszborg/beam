/**
 * Previews while receiving.
 *
 * As chunks are decrypted, previewable files (video, audio, images, text,
 * PDF) are also kept here as Blob parts — the browser may page large Blobs to
 * disk — within a fixed budget. Video and audio can play before the file has
 * finished: the <video> element requests /__beam_preview/<store>/<file>, the
 * service worker forwards each Range request to this page, and it's answered
 * from the bytes received so far (waiting a little for ones not here yet).
 * Images and text are shown once their file is complete.
 *
 * Safety: decrypted content is never rendered as HTML/SVG on this origin.
 * Kinds come from an allow-list of media types, the service worker serves a
 * forced Content-Type with nosniff, and text is rendered as text.
 */
import { Emitter } from '../events.js';

export type PreviewKind = 'video' | 'audio' | 'image' | 'text' | 'pdf';

export interface PreviewFile {
  index: number;
  path: string;
  size: number;
  type: string;
}

export interface PreviewItem {
  fileIndex: number;
  name: string;
  kind: PreviewKind;
  mime: string;
  size: number;
  /** Bytes from the start of the file that are available. */
  buffered: number;
  complete: boolean;
}

/** Total bytes kept for previews per transfer. */
export const PREVIEW_BUDGET = 512 * 1024 * 1024;
/** Most a single range response carries; the player asks again for more. */
const MAX_RANGE_BYTES = 8 * 1024 * 1024;
/** How long a range request waits for bytes that haven't arrived. */
const RANGE_WAIT_MS = 20_000;
const TEXT_PREVIEW_BYTES = 256 * 1024;

const BY_MIME: Record<string, PreviewKind> = {
  'video/mp4': 'video',
  'video/webm': 'video',
  'video/ogg': 'video',
  'video/quicktime': 'video',
  'audio/mpeg': 'audio',
  'audio/mp4': 'audio',
  'audio/x-m4a': 'audio',
  'audio/aac': 'audio',
  'audio/ogg': 'audio',
  'audio/wav': 'audio',
  'audio/x-wav': 'audio',
  'audio/webm': 'audio',
  'audio/flac': 'audio',
  'image/png': 'image',
  'image/jpeg': 'image',
  'image/gif': 'image',
  'image/webp': 'image',
  'image/avif': 'image',
  'image/bmp': 'image',
  'text/plain': 'text',
  'text/markdown': 'text',
  'text/csv': 'text',
  'application/json': 'text',
  'application/pdf': 'pdf',
};

const BY_EXT: Record<string, string> = {
  mp4: 'video/mp4', m4v: 'video/mp4', webm: 'video/webm', ogv: 'video/ogg', mov: 'video/quicktime',
  mp3: 'audio/mpeg', m4a: 'audio/mp4', aac: 'audio/aac', ogg: 'audio/ogg', oga: 'audio/ogg', opus: 'audio/ogg',
  wav: 'audio/wav', flac: 'audio/flac',
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp',
  avif: 'image/avif', bmp: 'image/bmp',
  txt: 'text/plain', md: 'text/markdown', csv: 'text/csv', log: 'text/plain', json: 'application/json',
  pdf: 'application/pdf',
};

/** The allow-listed MIME type and kind for a file, or null if it isn't previewable. */
export function previewType(path: string, type: string): { mime: string; kind: PreviewKind } | null {
  const declared = type.toLowerCase().split(';')[0]!.trim();
  if (BY_MIME[declared]) return { mime: declared, kind: BY_MIME[declared]! };
  const ext = path.toLowerCase().split('.').pop() ?? '';
  const mime = BY_EXT[ext];
  return mime ? { mime, kind: BY_MIME[mime]! } : null;
}

interface Entry {
  file: PreviewFile;
  mime: string;
  kind: PreviewKind;
  parts: Blob[];
  /** Contiguous bytes from offset 0. */
  buffered: number;
  /** Chunks that arrived ahead of a gap, by offset. */
  ahead: Map<number, Blob>;
  objectUrl: string | null;
}

const registry = new Map<string, PreviewStore>();
let responderInstalled = false;

/**
 * Answer the service worker's range requests for /__beam_preview/<id>/<file>.
 * Installed once per page.
 */
export function installPreviewResponder(): void {
  if (responderInstalled || typeof navigator === 'undefined' || !navigator.serviceWorker) return;
  responderInstalled = true;
  navigator.serviceWorker.addEventListener('message', (event) => {
    const msg = event.data as { type?: string; path?: string; start?: number; end?: number | null; whole?: boolean };
    const port = event.ports[0];
    if (msg?.type !== 'beam-preview' || !port || typeof msg.path !== 'string') return;
    const [, , id, file] = msg.path.split('/'); // "", "__beam_preview", id, file
    const store = registry.get(id ?? '');
    if (!store) return port.postMessage({ status: 'missing' });
    const fileIndex = Number(file);
    void (msg.whole ? Promise.resolve(store.whole(fileIndex)) : store.range(fileIndex, msg.start ?? 0, msg.end ?? null))
      .then((r) => port.postMessage(r ? { status: 'ok', ...r } : { status: 'missing' }))
      .catch(() => port.postMessage({ status: 'missing' }));
  });
}

export class PreviewStore {
  readonly id = Math.random().toString(36).slice(2, 12);
  private readonly entries = new Map<number, Entry>();
  private readonly emitter = new Emitter<{ change: PreviewItem[] }>();
  private readonly waiters = new Set<() => void>();
  private changeTimer: ReturnType<typeof setTimeout> | null = null;
  readonly on = this.emitter.on.bind(this.emitter);

  constructor(files: PreviewFile[], budget = PREVIEW_BUDGET) {
    let left = budget;
    for (const file of files) {
      const t = previewType(file.path, file.type);
      if (!t || file.size === 0 || file.size > left) continue;
      left -= file.size;
      this.entries.set(file.index, { file, ...t, parts: [], buffered: 0, ahead: new Map(), objectUrl: null });
    }
    if (this.entries.size) {
      registry.set(this.id, this);
      installPreviewResponder();
    }
  }

  get empty(): boolean {
    return this.entries.size === 0;
  }

  /** A decrypted chunk. Must be called before the bytes are handed to a sink (which may transfer them). */
  push(fileIndex: number, offset: number, data: Uint8Array): void {
    const e = this.entries.get(fileIndex);
    if (!e || offset + data.length <= e.buffered) return; // not previewable, or a duplicate
    const blob = new Blob([data as unknown as BlobPart]);
    if (offset > e.buffered) {
      e.ahead.set(offset, blob);
      return;
    }
    e.parts.push(offset === e.buffered ? blob : blob.slice(e.buffered - offset));
    e.buffered = offset + data.length;
    // Pull in anything that was waiting behind the gap.
    for (let next = e.ahead.get(e.buffered); next; next = e.ahead.get(e.buffered)) {
      e.ahead.delete(e.buffered);
      e.parts.push(next);
      e.buffered += next.size;
    }
    this.waiters.forEach((w) => w());
    this.scheduleChange();
  }

  items(): PreviewItem[] {
    return [...this.entries.values()].map((e) => ({
      fileIndex: e.file.index,
      name: e.file.path.split('/').pop() || e.file.path,
      kind: e.kind,
      mime: e.mime,
      size: e.file.size,
      buffered: e.buffered,
      complete: e.buffered >= e.file.size,
    }));
  }

  /** Streaming URL for <video>/<audio> (needs the service worker). */
  streamUrl(fileIndex: number): string {
    return `/__beam_preview/${this.id}/${fileIndex}`;
  }

  /** Blob URL of a complete file (images; media without a service worker). */
  objectUrl(fileIndex: number): string | null {
    const e = this.entries.get(fileIndex);
    if (!e || e.buffered < e.file.size) return null;
    e.objectUrl ??= URL.createObjectURL(new Blob(e.parts, { type: e.mime }));
    return e.objectUrl;
  }

  /** The first part of a complete text file, as text. */
  async text(fileIndex: number): Promise<{ text: string; truncated: boolean } | null> {
    const e = this.entries.get(fileIndex);
    if (!e || e.buffered < e.file.size) return null;
    const blob = new Blob(e.parts).slice(0, TEXT_PREVIEW_BYTES);
    return { text: await blob.text(), truncated: e.file.size > TEXT_PREVIEW_BYTES };
  }

  /** A complete file in one piece (a PDF opened in its own tab). */
  whole(fileIndex: number): { blob: Blob; start: number; total: number; mime: string } | null {
    const e = this.entries.get(fileIndex);
    if (!e || e.buffered < e.file.size) return null;
    return { blob: new Blob(e.parts), start: 0, total: e.file.size, mime: e.mime };
  }

  /** Bytes [start, end] of a file, waiting a while for ones not here yet. */
  async range(
    fileIndex: number,
    start: number,
    end: number | null,
  ): Promise<{ blob: Blob; start: number; total: number; mime: string } | null> {
    const e = this.entries.get(fileIndex);
    if (!e || start >= e.file.size) return null;
    if (e.buffered <= start) {
      await new Promise<void>((resolve) => {
        const done = () => {
          if (e.buffered > start || e.buffered >= e.file.size) {
            clearTimeout(timer);
            this.waiters.delete(done);
            resolve();
          }
        };
        const timer = setTimeout(() => {
          this.waiters.delete(done);
          resolve();
        }, RANGE_WAIT_MS);
        this.waiters.add(done);
      });
      if (e.buffered <= start) return null;
    }
    const stop = Math.min(end === null ? Infinity : end + 1, e.buffered, start + MAX_RANGE_BYTES);
    return { blob: new Blob(e.parts).slice(start, stop), start, total: e.file.size, mime: e.mime };
  }

  private scheduleChange(): void {
    if (this.changeTimer) return;
    this.changeTimer = setTimeout(() => {
      this.changeTimer = null;
      this.emitter.emit('change', this.items());
    }, 250);
  }

  dispose(): void {
    registry.delete(this.id);
    if (this.changeTimer) clearTimeout(this.changeTimer);
    for (const e of this.entries.values()) if (e.objectUrl) URL.revokeObjectURL(e.objectUrl);
    this.entries.clear();
    this.waiters.forEach((w) => w());
    this.emitter.clear();
  }
}
