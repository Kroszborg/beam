/**
 * Helpers for collecting files from drops and inputs — including whole folders.
 *
 * Folder support comes from the (non-standard but widely supported) WebKit
 * entries API on DataTransferItem. We walk directory trees recursively so a
 * dropped folder yields all its files, and remember each file's path relative
 * to the drop so the receiver can recreate the folder structure.
 */

/** Paths recorded for dropped files (File.name is only the base name). */
const paths = new WeakMap<File, string>();

/**
 * A file's path relative to what the user picked: from a folder drop, from
 * the folder picker (`webkitRelativePath`), or just its name.
 */
export function relativePath(file: File): string {
  return paths.get(file) || file.webkitRelativePath || file.name;
}

interface FileSystemEntryLike {
  isFile: boolean;
  isDirectory: boolean;
  file?: (cb: (file: File) => void, err: (e: unknown) => void) => void;
  createReader?: () => {
    readEntries: (cb: (entries: FileSystemEntryLike[]) => void, err: (e: unknown) => void) => void;
  };
  fullPath?: string;
}

function readEntryFile(entry: FileSystemEntryLike): Promise<File> {
  return new Promise((resolve, reject) => {
    entry.file?.(resolve, reject);
  });
}

function readDirectory(entry: FileSystemEntryLike): Promise<FileSystemEntryLike[]> {
  const reader = entry.createReader?.();
  if (!reader) return Promise.resolve([]);
  return new Promise((resolve, reject) => {
    const all: FileSystemEntryLike[] = [];
    const readBatch = () => {
      reader.readEntries((entries) => {
        if (entries.length === 0) resolve(all);
        else {
          all.push(...entries);
          readBatch(); // readEntries returns in batches until empty
        }
      }, reject);
    };
    readBatch();
  });
}

async function walkEntry(entry: FileSystemEntryLike, out: File[]): Promise<void> {
  if (entry.isFile) {
    const file = await readEntryFile(entry);
    if (entry.fullPath) paths.set(file, entry.fullPath.replace(/^\/+/, ''));
    out.push(file);
  } else if (entry.isDirectory) {
    const entries = await readDirectory(entry);
    for (const child of entries) await walkEntry(child, out);
  }
}

/** Gather all files from a drop, recursing into any dropped folders. */
export async function gatherFilesFromDataTransfer(dt: DataTransfer): Promise<File[]> {
  const items = Array.from(dt.items).filter((i) => i.kind === 'file');

  // Prefer the entries API (supports folders); fall back to flat files.
  const entries = items
    .map((i) => (i as unknown as { webkitGetAsEntry?: () => FileSystemEntryLike | null }).webkitGetAsEntry?.())
    .filter((e): e is FileSystemEntryLike => Boolean(e));

  if (entries.length === 0) return Array.from(dt.files);

  const out: File[] = [];
  for (const entry of entries) await walkEntry(entry, out);
  return out;
}

/** Total byte size of a file list. */
export function totalSize(files: File[]): number {
  return files.reduce((sum, f) => sum + f.size, 0);
}
