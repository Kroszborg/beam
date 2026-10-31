/**
 * End-to-end transfers between real browser contexts over real WebRTC (or the
 * server relay), through the local signaling server.
 *
 * Each test writes deterministic pseudo-random files, sends them through the
 * UI, receives them through one of the three sinks, and compares SHA-256
 * digests. Throughput is logged.
 *
 *   pnpm dev            (in another terminal)
 *   pnpm e2e
 *   BEAM_E2E_BIG_MB=4096 pnpm e2e -g large    # opt-in large-file run
 */
import { test, expect, type Browser, type BrowserContext, type Page } from '@playwright/test';
import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import yauzl from 'yauzl';

const dir = mkdtempSync(join(tmpdir(), 'beam-e2e-'));
test.afterAll(() => rmSync(dir, { recursive: true, force: true }));

interface Spec {
  name: string;
  mb: number;
}

/** Write `mb` MiB (fractions allowed) of seeded pseudo-random data. */
async function makeFile(name: string, mb: number, seed: number): Promise<string> {
  const path = join(dir, `${seed}-${name}`);
  const out = createWriteStream(path);
  let left = Math.round(mb * 1024 * 1024);
  let x = seed >>> 0 || 1;
  while (left > 0) {
    const block = Buffer.alloc(Math.min(left, 1024 * 1024));
    for (let i = 0; i + 4 <= block.length; i += 4) {
      x ^= x << 13; x >>>= 0; x ^= x >>> 17; x ^= x << 5; x >>>= 0;
      block.writeUInt32LE(x, i);
    }
    left -= block.length;
    if (!out.write(block)) await new Promise((r) => out.once('drain', r));
  }
  await new Promise<void>((r) => out.end(r));
  return path;
}

function sha256File(path: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const h = createHash('sha256');
    createReadStream(path)
      .on('data', (d) => h.update(d))
      .on('end', () => resolve(h.digest('hex')))
      .on('error', reject);
  });
}

/** SHA-256 of every entry in a zip on disk. */
function zipDigests(path: string): Promise<Map<string, string>> {
  return new Promise((resolve, reject) => {
    yauzl.open(path, { lazyEntries: true, validateEntrySizes: true }, (err, zip) => {
      if (err || !zip) return reject(err);
      const out = new Map<string, string>();
      zip.on('entry', (entry: yauzl.Entry) => {
        zip.openReadStream(entry, (e, stream) => {
          if (e || !stream) return reject(e);
          const h = createHash('sha256');
          stream.on('data', (d: Buffer) => h.update(d));
          stream.on('end', () => {
            out.set(entry.fileName, h.digest('hex'));
            zip.readEntry();
          });
        });
      });
      zip.on('end', () => resolve(out));
      zip.on('error', reject);
      zip.readEntry();
    });
  });
}

async function openSender(ctx: BrowserContext, paths: string[], query = ''): Promise<{ page: Page; url: string }> {
  const page = await ctx.newPage();
  await page.goto(`/send${query}`);
  await page.locator('input[type=file]:not([webkitdirectory])').setInputFiles(paths);
  await page.getByRole('button', { name: /create share link/i }).click();
  const code = page.locator('[data-testid=share-url]');
  await expect(code).toContainText('/r/', { timeout: 20_000 });
  return { page, url: (await code.textContent())!.trim() };
}

type Sink = 'stream' | 'fs' | 'idb';

async function openReceiver(ctx: BrowserContext, url: string, sink: Sink): Promise<Page> {
  const page = await ctx.newPage();
  if (sink === 'fs') {
    // Native pickers can't be automated: hand back handles in the origin
    // private file system, which supports the same createWritable() API.
    await page.addInitScript(() => {
      const w = window as unknown as Record<string, unknown>;
      w.showSaveFilePicker = async (o: { suggestedName?: string }) =>
        (await navigator.storage.getDirectory()).getFileHandle(o?.suggestedName ?? 'file', { create: true });
      w.showDirectoryPicker = async () => (await navigator.storage.getDirectory()).getDirectoryHandle('picked', { create: true });
    });
  } else {
    await page.addInitScript(() => {
      const w = window as unknown as Record<string, unknown>;
      delete w.showSaveFilePicker;
      delete w.showDirectoryPicker;
    });
  }
  const u = new URL(url);
  if (sink === 'idb') u.search = '?sink=idb';
  await page.goto(u.toString());
  await expect(page.locator('[data-testid=offered-file]').first()).toBeVisible({ timeout: 30_000 });
  return page;
}

/** SHA-256 of a file in the receiver's origin private file system. */
async function opfsDigest(page: Page, path: string): Promise<string> {
  return page.evaluate(async (p) => {
    let dir = await navigator.storage.getDirectory();
    const parts = p.split('/');
    const name = parts.pop()!;
    for (const d of parts) dir = await dir.getDirectoryHandle(d);
    const file = await (await dir.getFileHandle(name)).getFile();
    const hash = await crypto.subtle.digest('SHA-256', await file.arrayBuffer());
    return [...new Uint8Array(hash)].map((b) => b.toString(16).padStart(2, '0')).join('');
  }, path);
}

interface RunOptions {
  sink: Sink;
  receivers?: number;
  senderQuery?: string;
  expectRoute?: string;
}

async function transfer(browser: Browser, files: Spec[], opts: RunOptions): Promise<number> {
  const paths = await Promise.all(files.map((f, i) => makeFile(f.name, f.mb, i + 7)));
  const digests = await Promise.all(paths.map(sha256File));
  const totalMb = files.reduce((s, f) => s + f.mb, 0);
  const contexts: BrowserContext[] = [];
  const ctx = async () => {
    const c = await browser.newContext({ acceptDownloads: true });
    contexts.push(c);
    if (process.env.BEAM_E2E_DEBUG) {
      // Timestamped page console + signaling frames, for diagnosing stalls.
      const who = `ctx${contexts.length}`;
      const t0 = Date.now();
      const log = (m: string) => console.log(`[dbg +${((Date.now() - t0) / 1000).toFixed(1)}s ${who}] ${m.slice(0, 160)}`);
      c.on('page', (p) => {
        p.on('console', (m) => log(`console.${m.type()}: ${m.text()}`));
        p.on('pageerror', (e) => log(`pageerror: ${e.message}`));
        p.on('requestfailed', (r) => log(`requestfailed ${r.url()} ${r.failure()?.errorText}`));
        p.on('websocket', (ws) => {
          log(`ws open ${ws.url()}`);
          ws.on('close', () => log('ws closed'));
          ws.on('framereceived', (f) => typeof f.payload === 'string' && log(`ws <- ${f.payload}`));
          ws.on('framesent', (f) => typeof f.payload === 'string' && log(`ws -> ${f.payload}`));
        });
      });
    }
    return c;
  };

  try {
    const { page: sender, url } = await openSender(await ctx(), paths, opts.senderQuery ?? '');
    const receivers = await Promise.all(
      Array.from({ length: opts.receivers ?? 1 }, async () => openReceiver(await ctx(), url, opts.sink)),
    );

    // Chromium exposes JS heap size; sample it to prove memory stays flat.
    let maxHeap = 0;
    const heapTimer = setInterval(() => {
      for (const p of [sender, ...receivers]) {
        void p
          .evaluate(() => (performance as unknown as { memory?: { usedJSHeapSize: number } }).memory?.usedJSHeapSize ?? 0)
          .then((h) => (maxHeap = Math.max(maxHeap, h)))
          .catch(() => {});
      }
    }, 2000);

    const t0 = Date.now();
    await Promise.all(
      receivers.map(async (rx, n) => {
        const button = rx.getByRole('button', { name: /^(download|save)/i });
        if (opts.sink === 'stream') {
          const [download] = await Promise.all([rx.waitForEvent('download', { timeout: 60_000 }), button.click()]);
          const saved = join(dir, `recv-${n}-${download.suggestedFilename()}`);
          await download.saveAs(saved);
          if (files.length === 1) {
            expect(download.suggestedFilename()).toBe(basename(paths[0]!));
            expect(await sha256File(saved)).toBe(digests[0]);
          } else {
            const inZip = await zipDigests(saved);
            files.forEach((f, i) => expect(inZip.get(paths[i]!.split(/[\\/]/).pop()!)).toBe(digests[i]));
          }
        } else {
          await button.click();
          if (opts.sink === 'fs') {
            await expect(rx.getByTestId('saved')).toBeVisible({ timeout: 10 * 60_000 });
            for (let i = 0; i < files.length; i++) {
              const name = paths[i]!.split(/[\\/]/).pop()!;
              expect(await opfsDigest(rx, files.length === 1 ? name : `picked/${name}`)).toBe(digests[i]);
            }
          } else {
            for (let i = 0; i < files.length; i++) {
              const row = rx.locator('[data-testid=received-file]').nth(i);
              await expect(row).toBeVisible({ timeout: 10 * 60_000 });
              const [download] = await Promise.all([
                rx.waitForEvent('download'),
                row.getByRole('button', { name: /save/i }).click(),
              ]);
              const saved = join(dir, `recv-${n}-${i}`);
              await download.saveAs(saved);
              expect(await sha256File(saved)).toBe(digests[i]);
            }
          }
        }
        if (opts.expectRoute) {
          // The receiver may already have moved on to the "saved" view.
          const routes = await sender.locator('[data-testid=route]').evaluateAll((els) => els.map((e) => e.getAttribute('data-route')));
          expect(routes).toContain(opts.expectRoute);
        }
      }),
    );
    clearInterval(heapTimer);
    const secs = (Date.now() - t0) / 1000;
    const rate = (totalMb * receivers.length) / secs;
    const heap = maxHeap ? `, peak JS heap ${(maxHeap / 1024 / 1024).toFixed(0)} MB` : '';
    console.log(`[e2e] ${opts.sink} ×${receivers.length}: ${totalMb} MB in ${secs.toFixed(1)}s → ${rate.toFixed(1)} MB/s${heap}`);

    await expect(sender.locator('[data-testid=receiver][data-state=complete]')).toHaveCount(receivers.length, {
      timeout: 30_000,
    });
    return rate;
  } finally {
    for (const c of contexts) await c.close();
  }
}

test('single file → streaming download', async ({ browser }) => {
  await transfer(browser, [{ name: 'small.bin', mb: 1.3 }], { sink: 'stream' });
});

test('several files → streamed zip', async ({ browser }) => {
  await transfer(
    browser,
    [
      { name: 'a.bin', mb: 9 },
      { name: 'empty.txt', mb: 0 },
      { name: 'b.bin', mb: 3.7 },
    ],
    { sink: 'stream' },
  );
});

test('save straight to disk (File System Access)', async ({ browser, browserName }) => {
  test.skip(browserName !== 'chromium', 'File System Access API is Chromium-only');
  await transfer(browser, [{ name: 'one.bin', mb: 6.5 }], { sink: 'fs' });
  await transfer(browser, [{ name: 'x.bin', mb: 2 }, { name: 'y.bin', mb: 1.1 }], { sink: 'fs' });
});

test('IndexedDB fallback', async ({ browser }) => {
  await transfer(browser, [{ name: 'idb.bin', mb: 5.2 }, { name: 'tiny.txt', mb: 0.01 }], { sink: 'idb' });
});

test('two receivers on one link', async ({ browser }) => {
  await transfer(browser, [{ name: 'shared.bin', mb: 40 }], { sink: 'stream', receivers: 2 });
});

test('server relay fallback', async ({ browser }) => {
  await transfer(browser, [{ name: 'relayed.bin', mb: 30 }], {
    sink: 'stream',
    senderQuery: '?relay=1',
    expectRoute: 'relay',
  });
});

test('throughput (200 MB)', async ({ browser }) => {
  await transfer(browser, [{ name: 'medium.bin', mb: 200 }], { sink: 'stream' });
});

test('bench: 200 MB per sink', async ({ browser, browserName }) => {
  test.skip(!process.env.BEAM_BENCH, 'set BEAM_BENCH=1');
  const sinks = (process.env.BEAM_BENCH_SINKS ?? 'fs,idb,stream,relay').split(',');
  const mb = Number(process.env.BEAM_BENCH_MB ?? 200);
  for (const sink of sinks) {
    if (sink === 'relay') {
      await transfer(browser, [{ name: 'bench-relay.bin', mb }], { sink: 'stream', senderQuery: '?relay=1' });
      continue;
    }
    if (sink === 'fs' && browserName !== 'chromium') continue;
    await transfer(browser, [{ name: `bench-${sink}.bin`, mb }], { sink: sink as Sink });
  }
});

const bigMb = Number(process.env.BEAM_E2E_BIG_MB ?? 0);
test('large file', async ({ browser }) => {
  test.skip(!bigMb, 'set BEAM_E2E_BIG_MB to run');
  test.setTimeout(60 * 60_000);
  await transfer(browser, [{ name: 'large.bin', mb: bigMb }], { sink: 'stream' });
});
