/**
 * Streaming-download sink, backed by public/sw.js.
 *
 * Works wherever service workers can stream a Response (Firefox, Safari,
 * Chromium incl. Android). One selected file streams as itself; several stream
 * as a single store-only ZIP64 archive whose exact size is known up front.
 *
 * Writes are strictly sequential (a download can't seek), which matches how
 * chunks arrive: in order, and in order again after a reconnect.
 */
import { ZipStreamWriter, zipSize } from '../../zip/zipWriter.js';
import { nanoid } from '../ids.js';
import type { FileSink, SinkChunk, SinkFile } from './types.js';

const SW_URL = '/sw.js';
const KEEPALIVE_MS = 10_000;

let registration: Promise<ServiceWorkerRegistration | null> | null = null;

/** Register the worker once; resolves null where streaming isn't possible. */
export function registerStreamWorker(): Promise<ServiceWorkerRegistration | null> {
  if (registration) return registration;
  registration = (async () => {
    try {
      if (!('serviceWorker' in navigator) || !window.isSecureContext) return null;
      await navigator.serviceWorker.register(SW_URL, { scope: '/' });
      return await withTimeout(navigator.serviceWorker.ready, 5_000);
    } catch {
      return null;
    }
  })();
  return registration;
}

export async function streamDownloadAvailable(): Promise<boolean> {
  return (await registerStreamWorker())?.active != null;
}

/** Download name for a set of files: the shared top folder, else a generic one. */
export function archiveName(files: SinkFile[]): string {
  const roots = new Set(files.map((f) => (f.path.includes('/') ? f.path.split('/')[0] : '')));
  const [root] = roots;
  return roots.size === 1 && root ? `${root}.zip` : `beam-${files.length}-files.zip`;
}

export function createStreamSink(files: SinkFile[]): FileSink {
  return files.length === 1 ? new SingleStreamSink(files[0]!) : new ZipStreamSink(files);
}

/** One browser download fed chunk by chunk through the service worker. */
class Download {
  private readonly port: MessagePort;
  /** The end handed to the service worker. */
  private readonly remote: MessagePort;
  private credits = 0;
  private waiter: (() => void) | null = null;
  private cancelled = false;
  private keepalive: ReturnType<typeof setInterval> | null = null;
  private iframe: HTMLIFrameElement | null = null;

  constructor(
    private readonly name: string,
    private readonly size: number,
    private readonly mime: string,
  ) {
    const channel = new MessageChannel();
    this.port = channel.port1;
    this.port.onmessage = ({ data }) => {
      if (data.type === 'pull') this.credits += 1;
      else if (data.type === 'cancel') this.cancelled = true;
      this.waiter?.();
      this.waiter = null;
    };
    this.remote = channel.port2;
  }

  async start(): Promise<void> {
    const reg = await registerStreamWorker();
    const worker = reg?.active;
    if (!worker) throw new Error('Streaming download is not available in this browser.');
    const id = nanoid();
    const registered = new Promise<void>((resolve) => {
      const prev = this.port.onmessage;
      this.port.onmessage = (e) => {
        if (e.data.type === 'registered') {
          this.port.onmessage = prev;
          resolve();
        } else prev?.call(this.port, e);
      };
    });
    worker.postMessage(
      { type: 'beam-download', id, name: this.name, size: this.size, mime: this.mime },
      [this.remote],
    );
    await withTimeout(registered, 5_000);

    const iframe = document.createElement('iframe');
    iframe.hidden = true;
    iframe.src = `/__beam_dl/${id}/${encodeURIComponent(this.name)}`;
    document.body.appendChild(iframe);
    this.iframe = iframe;
    this.keepalive = setInterval(() => {
      void fetch('/__beam_dl/ping').catch(() => {});
    }, KEEPALIVE_MS);
  }

  async write(data: Uint8Array): Promise<void> {
    while (this.credits === 0 && !this.cancelled) {
      await new Promise<void>((r) => (this.waiter = r));
    }
    if (this.cancelled) throw new Error('The download was cancelled in the browser.');
    this.credits -= 1;
    // Transfer (not copy) the buffer to the worker when the view owns all of it.
    const owned =
      data.byteOffset === 0 && data.byteLength === data.buffer.byteLength
        ? (data.buffer as ArrayBuffer)
        : data.slice().buffer;
    this.port.postMessage({ type: 'chunk', buf: owned }, [owned]);
  }

  end(): void {
    this.port.postMessage({ type: 'end' });
    this.cleanup();
  }

  abort(): void {
    this.port.postMessage({ type: 'abort' });
    this.cleanup();
  }

  private cleanup(): void {
    if (this.keepalive) clearInterval(this.keepalive);
    // Leave the iframe a moment so the browser finishes handing off the stream.
    const iframe = this.iframe;
    setTimeout(() => iframe?.remove(), 60_000);
  }
}

class SingleStreamSink implements FileSink {
  readonly kind = 'stream' as const;
  readonly sequential = true;
  private readonly dl: Download;

  constructor(file: SinkFile) {
    this.dl = new Download(file.path.split('/').pop() || 'download', file.size, file.type);
  }

  async open(): Promise<Set<number>> {
    await this.dl.start();
    return new Set();
  }

  async write({ data }: SinkChunk): Promise<void> {
    if (data.length) await this.dl.write(data);
  }

  async close(): Promise<null> {
    this.dl.end();
    return null;
  }

  async abort(): Promise<void> {
    this.dl.abort();
  }
}

class ZipStreamSink implements FileSink {
  readonly kind = 'stream' as const;
  readonly sequential = true;
  private readonly dl: Download;
  private readonly zip: ZipStreamWriter;
  /** manifest file index → position in the archive */
  private readonly position = new Map<number, number>();

  constructor(files: SinkFile[]) {
    const entries = files.map((f) => ({ name: f.path, size: f.size, lastModified: f.lastModified }));
    files.forEach((f, i) => this.position.set(f.index, i));
    this.dl = new Download(archiveName(files), zipSize(entries), 'application/zip');
    this.zip = new ZipStreamWriter(entries, (bytes) => this.dl.write(bytes));
  }

  async open(): Promise<Set<number>> {
    await this.dl.start();
    return new Set();
  }

  async write({ fileIndex, data }: SinkChunk): Promise<void> {
    const pos = this.position.get(fileIndex);
    if (pos === undefined) throw new Error(`zip sink: unexpected file ${fileIndex}`);
    await this.zip.write(pos, data);
  }

  async close(): Promise<null> {
    await this.zip.finish();
    this.dl.end();
    return null;
  }

  async abort(): Promise<void> {
    this.dl.abort();
  }
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return Promise.race([
    p,
    new Promise<T>((_, reject) => setTimeout(() => reject(new Error('timed out')), ms)),
  ]);
}
