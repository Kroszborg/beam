import { describe, it, expect } from 'vitest';
import { PreviewStore, previewType } from './previewStore.js';

const bytesOf = async (b: Blob) => new Uint8Array(await b.arrayBuffer());
const seq = (start: number, n: number) => Uint8Array.from({ length: n }, (_, i) => (start + i) & 0xff);

describe('previewType', () => {
  it('allows media, images, text and PDF — by type or extension', () => {
    expect(previewType('a.mp4', '')).toEqual({ mime: 'video/mp4', kind: 'video' });
    expect(previewType('clip', 'video/webm')).toEqual({ mime: 'video/webm', kind: 'video' });
    expect(previewType('song.MP3', '')).toEqual({ mime: 'audio/mpeg', kind: 'audio' });
    expect(previewType('x.jpg', 'image/jpeg')?.kind).toBe('image');
    expect(previewType('notes.md', '')?.kind).toBe('text');
    expect(previewType('doc.pdf', '')?.kind).toBe('pdf');
  });

  it('never previews active content such as HTML or SVG', () => {
    expect(previewType('page.html', 'text/html')).toBeNull();
    expect(previewType('logo.svg', 'image/svg+xml')).toBeNull();
    expect(previewType('evil.mp4', 'text/html')).toEqual({ mime: 'video/mp4', kind: 'video' }); // forced type
    expect(previewType('x.xml', 'application/xml')).toBeNull();
    expect(previewType('app.exe', '')).toBeNull();
  });
});

describe('PreviewStore', () => {
  const file = (index: number, size: number, path = `f${index}.mp4`) => ({ index, path, size, type: '' });

  it('assembles bytes in order, holding chunks that arrive ahead of a gap', async () => {
    const store = new PreviewStore([file(0, 30)]);
    store.push(0, 0, seq(0, 10));
    store.push(0, 20, seq(20, 10)); // ahead of the gap
    expect(store.items()[0]).toMatchObject({ buffered: 10, complete: false });
    store.push(0, 0, seq(0, 10)); // duplicate
    store.push(0, 10, seq(10, 10)); // fills the gap
    expect(store.items()[0]).toMatchObject({ buffered: 30, complete: true });
    const whole = store.whole(0)!;
    expect(await bytesOf(whole.blob)).toEqual(seq(0, 30));
    store.dispose();
  });

  it('skips files that are not previewable, empty, or over the budget', () => {
    const store = new PreviewStore(
      [file(0, 10), file(1, 10, 'a.html'), file(2, 0), file(3, 100), file(4, 5)],
      20,
    );
    expect(store.items().map((i) => i.fileIndex)).toEqual([0, 4]);
    store.dispose();
  });

  it('serves ranges, waiting for bytes that are still arriving', async () => {
    const store = new PreviewStore([file(0, 100)]);
    store.push(0, 0, seq(0, 40));
    const head = await store.range(0, 10, 19);
    expect(head).toMatchObject({ start: 10, total: 100, mime: 'video/mp4' });
    expect(await bytesOf(head!.blob)).toEqual(seq(10, 10));

    const later = store.range(0, 50, null);
    setTimeout(() => store.push(0, 40, seq(40, 60)), 20);
    const tail = await later;
    expect(await bytesOf(tail!.blob)).toEqual(seq(50, 50));
    expect(await store.range(0, 100, null)).toBeNull(); // past the end
    store.dispose();
  });

  it('gives text previews once complete', async () => {
    const store = new PreviewStore([{ index: 0, path: 'a.txt', size: 5, type: 'text/plain' }]);
    expect(await store.text(0)).toBeNull();
    store.push(0, 0, new TextEncoder().encode('hello'));
    expect(await store.text(0)).toEqual({ text: 'hello', truncated: false });
    store.dispose();
  });
});
