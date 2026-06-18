/**
 * Turning received chunks into saved files.
 *
 * Two paths:
 *   • File System Access API (Chromium) — streams chunks straight to disk one
 *     at a time, so a multi-GB file is never held in memory.
 *   • Fallback (Firefox/Safari) — assembles a Blob and triggers a download.
 *
 * Both read from IndexedDB chunk-by-chunk, and `save()` runs from a user click
 * (the required gesture for the save dialog). `getBytes()` exists mainly for
 * tests / integrity checks.
 */
import type { ManifestMessage } from '@beam/shared';
import type { ResumeStore } from './resumeStore.js';
import type { CompletedFile } from './types.js';

interface SaveFilePickerWindow {
  showSaveFilePicker?: (opts: { suggestedName?: string }) => Promise<{
    createWritable: () => Promise<{
      write: (data: BufferSource) => Promise<void>;
      close: () => Promise<void>;
    }>;
  }>;
}

/** Build the user-facing file list, each bound to its chunk range. */
export function buildReceivedFiles(
  store: ResumeStore,
  manifest: ManifestMessage,
): CompletedFile[] {
  let globalStart = 0;
  return manifest.files.map((d) => {
    const start = globalStart;
    globalStart += d.chunkCount;
    return {
      name: d.name,
      size: d.size,
      type: d.type,
      getBytes: () => readBytes(store, manifest.transferId, start, d.chunkCount),
      save: () => saveFile(store, manifest.transferId, start, d),
    };
  });
}

async function readBytes(
  store: ResumeStore,
  transferId: string,
  start: number,
  count: number,
): Promise<Uint8Array> {
  const parts: Uint8Array[] = [];
  let total = 0;
  for (let i = start; i < start + count; i++) {
    const data = await store.getChunk(transferId, i);
    if (data) {
      const u = new Uint8Array(data);
      parts.push(u);
      total += u.length;
    }
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const p of parts) {
    out.set(p, offset);
    offset += p.length;
  }
  return out;
}

async function saveFile(
  store: ResumeStore,
  transferId: string,
  start: number,
  descriptor: { name: string; type: string; chunkCount: number },
): Promise<void> {
  const picker = (window as unknown as SaveFilePickerWindow).showSaveFilePicker;

  // Streaming path — never holds the whole file in memory.
  if (typeof picker === 'function') {
    try {
      const handle = await picker({ suggestedName: descriptor.name });
      const writable = await handle.createWritable();
      for (let i = start; i < start + descriptor.chunkCount; i++) {
        const data = await store.getChunk(transferId, i);
        if (data) await writable.write(data);
      }
      await writable.close();
      return;
    } catch (err) {
      // User cancelled the picker — nothing to do.
      if ((err as DOMException)?.name === 'AbortError') return;
      // Otherwise fall through to the Blob download.
    }
  }

  // Fallback: assemble a Blob and trigger a download.
  const parts: BlobPart[] = [];
  for (let i = start; i < start + descriptor.chunkCount; i++) {
    const data = await store.getChunk(transferId, i);
    if (data) parts.push(data);
  }
  const blob = new Blob(parts, { type: descriptor.type || 'application/octet-stream' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = descriptor.name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 15_000);
}
