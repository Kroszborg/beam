/**
 * File System Access sink (Chromium desktop).
 *
 * One file → a save dialog. Several files → a folder picker, recreating the
 * sender's relative paths inside it. Each chunk is written at its byte offset
 * through a FileSystemWritableFileStream, which Chromium backs with a swap file
 * on disk, so memory use stays at one chunk regardless of file size.
 *
 * The picker must be opened during the user's click, so `pickFsSink` calls it
 * before awaiting anything else.
 */
import type { FileSink, SinkChunk, SinkFile } from './types.js';

interface Writable {
  write(data: { type: 'write'; position: number; data: BufferSource }): Promise<void>;
  close(): Promise<void>;
  abort(): Promise<void>;
}
interface FileHandle {
  createWritable(opts?: { keepExistingData?: boolean }): Promise<Writable>;
}
interface DirHandle {
  getDirectoryHandle(name: string, opts?: { create?: boolean }): Promise<DirHandle>;
  getFileHandle(name: string, opts?: { create?: boolean }): Promise<FileHandle>;
}
interface PickerWindow {
  showSaveFilePicker?: (opts?: { suggestedName?: string }) => Promise<FileHandle>;
  showDirectoryPicker?: (opts?: { mode?: 'read' | 'readwrite'; id?: string }) => Promise<DirHandle>;
}

export function fsAccessAvailable(fileCount: number): boolean {
  const w = window as unknown as PickerWindow;
  return fileCount === 1
    ? typeof w.showSaveFilePicker === 'function'
    : typeof w.showDirectoryPicker === 'function';
}

/** Open the native picker and build a sink for the chosen location. */
export function pickFsSink(files: SinkFile[]): Promise<FileSink> {
  const w = window as unknown as PickerWindow;
  if (files.length === 1) {
    const only = files[0]!;
    return w.showSaveFilePicker!({ suggestedName: baseName(only.path) }).then(
      (handle) => new FsSink(files, async () => handle),
    );
  }
  return w.showDirectoryPicker!({ mode: 'readwrite', id: 'beam' }).then(
    (dir) => new FsSink(files, (f) => createInDir(dir, f.path)),
  );
}

class FsSink implements FileSink {
  readonly kind = 'fs' as const;
  readonly sequential = false;
  private readonly open_ = new Map<number, { w: Writable; left: number }>();

  constructor(
    private readonly files: SinkFile[],
    private readonly handleFor: (f: SinkFile) => Promise<FileHandle>,
  ) {}

  async open(): Promise<Set<number>> {
    // Empty files never receive a chunk with data; create them up front.
    for (const f of this.files) {
      if (f.size === 0) {
        const w = await (await this.handleFor(f)).createWritable();
        await w.close();
      }
    }
    return new Set();
  }

  async write({ fileIndex, offset, data }: SinkChunk): Promise<void> {
    if (data.length === 0) return;
    let entry = this.open_.get(fileIndex);
    if (!entry) {
      const f = this.files.find((x) => x.index === fileIndex);
      if (!f) throw new Error(`fs sink: unexpected file ${fileIndex}`);
      const w = await (await this.handleFor(f)).createWritable();
      entry = { w, left: f.size };
      this.open_.set(fileIndex, entry);
    }
    await entry.w.write({ type: 'write', position: offset, data: data as BufferSource });
    entry.left -= data.length;
    // Closing commits the swap file to its final name.
    if (entry.left <= 0) {
      await entry.w.close();
      this.open_.delete(fileIndex);
    }
  }

  async close(): Promise<null> {
    for (const { w } of this.open_.values()) await w.close();
    this.open_.clear();
    return null;
  }

  async abort(): Promise<void> {
    for (const { w } of this.open_.values()) await w.abort().catch(() => {});
    this.open_.clear();
  }
}

function baseName(path: string): string {
  return path.split('/').pop() || 'download';
}

/** Create `path` (with sub-folders) inside `root`, never overwriting a file. */
async function createInDir(root: DirHandle, path: string): Promise<FileHandle> {
  const parts = path.split('/').filter((p) => p && p !== '.' && p !== '..');
  const name = parts.pop() || 'file';
  let dir = root;
  for (const p of parts) dir = await dir.getDirectoryHandle(p, { create: true });

  const dot = name.lastIndexOf('.');
  const stem = dot > 0 ? name.slice(0, dot) : name;
  const ext = dot > 0 ? name.slice(dot) : '';
  for (let n = 0; ; n++) {
    const candidate = n === 0 ? name : `${stem} (${n})${ext}`;
    try {
      await dir.getFileHandle(candidate);
    } catch {
      return dir.getFileHandle(candidate, { create: true });
    }
  }
}
