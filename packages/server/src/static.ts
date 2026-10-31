/**
 * Optional: serve the built web app from this process (STATIC_DIR), so a
 * self-hosted Beam is a single container. Off when STATIC_DIR is unset —
 * e.g. when nginx or a CDN serves the client.
 *
 * Every app response gets a strict Content-Security-Policy: the page may only
 * talk to its own origin (plus Google Fonts for typography), which keeps the
 * key in the URL fragment from being exfiltrated by injected scripts.
 */
import { existsSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';
import type { FastifyInstance } from 'fastify';
import fastifyStatic from '@fastify/static';

const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  // Framer Motion and Tailwind runtime styles are inline.
  "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
  "font-src 'self' https://fonts.gstatic.com",
  "img-src 'self' data: blob:",
  "media-src 'self' blob:",
  "connect-src 'self'",
  "worker-src 'self'",
  "frame-src 'self'",
  "manifest-src 'self'",
  "base-uri 'none'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join('; ');

const SECURITY_HEADERS: Record<string, string> = {
  'Content-Security-Policy': CSP,
  'Referrer-Policy': 'no-referrer',
  'X-Content-Type-Options': 'nosniff',
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
};

export async function serveApp(app: FastifyInstance, dir: string): Promise<void> {
  const root = resolve(dir);
  if (!existsSync(join(root, 'index.html'))) {
    app.log.warn(`STATIC_DIR ${root} has no index.html — not serving the app`);
    return;
  }

  await app.register(fastifyStatic, {
    root,
    // Look files up per request (not a startup snapshot), so rebuilding the
    // client in place never leaves the server pointing at stale asset names.
    wildcard: true,
    index: false,
    // We set Cache-Control ourselves below.
    cacheControl: false,
    setHeaders(res, path) {
      for (const [k, v] of Object.entries(SECURITY_HEADERS)) res.setHeader(k, v);
      // Hashed assets are immutable; the worker and HTML must always revalidate.
      if (path.includes(`${sep}assets${sep}`)) res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
      else res.setHeader('Cache-Control', 'no-cache');
    },
  });

  // SPA: any other page route renders index.html. Missing files (a path whose
  // last segment has an extension) stay 404s rather than turning into HTML.
  app.setNotFoundHandler((req, reply) => {
    const read = req.method === 'GET' || req.method === 'HEAD';
    const path = req.url.split('?')[0]!;
    const looksLikeFile = /\.[a-z0-9]+$/i.test(path);
    if (!read || looksLikeFile || path.startsWith('/ws') || path.startsWith('/store') || path.startsWith('/__beam') ) {
      return reply.code(404).send({ error: 'not found' });
    }
    for (const [k, v] of Object.entries(SECURITY_HEADERS)) reply.header(k, v);
    reply.header('Cache-Control', 'no-cache');
    return reply.sendFile('index.html');
  });
}
