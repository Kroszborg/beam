import { File as FileIcon, X } from 'lucide-react';
import { formatBytes } from '@/lib/utils';
import { relativePath } from '@/lib/files';

/** Compact list of selected files with sizes and a running total. */
export function FileList({
  files,
  onRemove,
}: {
  files: File[];
  onRemove?: (index: number) => void;
}) {
  const total = files.reduce((s, f) => s + f.size, 0);

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <span className="eyebrow text-[var(--color-ink-faint)]">
          {files.length} file{files.length === 1 ? '' : 's'}
        </span>
        <span className="eyebrow text-[var(--color-ink)]">{formatBytes(total)}</span>
      </div>
      <ul className="max-h-64 divide-y divide-[var(--color-line)] overflow-auto border-y border-[var(--color-line)]">
        {files.map((file, i) => (
          <li key={`${file.name}-${i}`} className="flex items-center gap-3 py-2.5">
            <FileIcon className="h-4 w-4 shrink-0 text-[var(--color-ink-faint)]" />
            <span className="flex-1 truncate text-sm text-[var(--color-ink)]">{relativePath(file)}</span>
            <span className="shrink-0 font-mono text-xs text-[var(--color-ink-faint)]">
              {formatBytes(file.size)}
            </span>
            {onRemove && (
              <button
                onClick={() => onRemove(i)}
                className="shrink-0 rounded-[3px] p-1 text-[var(--color-ink-faint)] transition-colors hover:text-[var(--color-danger)]"
                aria-label={`Remove ${file.name}`}
              >
                <X className="h-3.5 w-3.5" />
              </button>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}
