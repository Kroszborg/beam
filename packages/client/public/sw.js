/**
 * Beam service worker. Two jobs:
 *
 *   1. Share target — when Beam is installed (PWA), "Share → Beam" from any app
 *      POSTs the files to /share-target. They're parked in IndexedDB and the
 *      send page picks them up.
 *
 *   2. Streaming downloads — the page decrypts chunks and posts them here over
 *      a MessagePort; a hidden iframe navigates to /__beam_dl/<id>/<name>, and
 *      this worker answers with a ReadableStream fed from the port. The
 *      browser's download manager writes it to disk, so a file of any size is
 *      saved without being held in memory or browser storage. Backpressure:
 *      the stream's pull() asks the page for the next chunk, so the page sends
 *      only as fast as the download is written.
 *
 * Nothing is cached. Shared files are held only until the send page takes them.
 */

const PREFIX = '/__beam_dl/';
/** id -> { port, name, size, mime } awaiting their fetch. */
const pending = new Map();

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));

self.addEventListener('message', (event) => {
  const msg = event.data;
  if (!msg || msg.type !== 'beam-download' || !event.ports[0]) return;
  pending.set(msg.id, { port: event.ports[0], name: msg.name, size: msg.size, mime: msg.mime });
  event.ports[0].postMessage({ type: 'registered' });
});

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  if (url.origin !== self.location.origin) return;

  if (url.pathname === '/share-target' && event.request.method === 'POST') {
    event.respondWith(receiveShare(event.request));
    return;
  }
  if (!url.pathname.startsWith(PREFIX)) return;

  const rest = url.pathname.slice(PREFIX.length);
  // Keepalive pings from the page keep this worker from being stopped while a
  // long download is mid-stream (fetch events extend the worker's lifetime).
  if (rest === 'ping') {
    event.respondWith(new Response(null, { status: 204 }));
    return;
  }

  const id = rest.split('/')[0];
  const entry = pending.get(id);
  if (!entry) {
    event.respondWith(new Response('This download link has expired.', { status: 404 }));
    return;
  }
  pending.delete(id);
  event.respondWith(streamResponse(entry));
});

function streamResponse({ port, name, size, mime }) {
  let wake = null;
  const stream = new ReadableStream(
    {
      start(controller) {
        port.onmessage = ({ data }) => {
          if (data.type === 'chunk') {
            controller.enqueue(new Uint8Array(data.buf));
            if (wake) {
              wake();
              wake = null;
            }
          } else if (data.type === 'end') {
            controller.close();
            port.close();
          } else if (data.type === 'abort') {
            controller.error(new Error('Transfer aborted'));
            port.close();
          }
        };
      },
      pull() {
        port.postMessage({ type: 'pull' });
        return new Promise((resolve) => (wake = resolve));
      },
      cancel() {
        port.postMessage({ type: 'cancel' });
      },
    },
    { highWaterMark: 4 },
  );

  const ascii = name.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_');
  const headers = new Headers({
    'Content-Type': mime || 'application/octet-stream',
    'Content-Disposition': `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(name)}`,
    'X-Content-Type-Options': 'nosniff',
    'Cache-Control': 'no-store',
  });
  if (typeof size === 'number' && size >= 0) headers.set('Content-Length', String(size));
  return new Response(stream, { headers });
}

// ── Share target ──────────────────────────────────────────────

const SHARE_DB = 'beam-share';

function shareDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(SHARE_DB, 1);
    req.onupgradeneeded = () => req.result.createObjectStore('pending');
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function receiveShare(request) {
  try {
    const form = await request.formData();
    const files = form.getAll('files').filter((f) => f instanceof File);
    const db = await shareDb();
    await new Promise((resolve, reject) => {
      const tx = db.transaction('pending', 'readwrite');
      tx.objectStore('pending').put(files, 'files');
      tx.oncomplete = resolve;
      tx.onerror = () => reject(tx.error);
    });
    db.close();
  } catch {
    // Fall through to the send page; the user can pick the files manually.
  }
  return Response.redirect('/send?shared=1', 303);
}
