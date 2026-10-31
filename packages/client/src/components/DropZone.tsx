import { useRef, useState, type DragEvent } from 'react';
import { UploadCloud, FolderUp } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { gatherFilesFromDataTransfer } from '@/lib/files';
import { cn } from '@/lib/utils';

/**
 * Large drag-and-drop target supporting single files, multiple files, and whole
 * folders (via drop or the folder picker).
 */
export function DropZone({ onFiles }: { onFiles: (files: File[]) => void }) {
  const [dragging, setDragging] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);
  const folderInput = useRef<HTMLInputElement>(null);

  const onDrop = async (e: DragEvent) => {
    e.preventDefault();
    setDragging(false);
    const files = await gatherFilesFromDataTransfer(e.dataTransfer);
    if (files.length) onFiles(files);
  };

  return (
    <div
      onDragOver={(e) => {
        e.preventDefault();
        setDragging(true);
      }}
      onDragLeave={() => setDragging(false)}
      onDrop={onDrop}
      className={cn(
        'relative flex flex-col items-center justify-center gap-5 rounded-[var(--radius-card)] border border-dashed px-6 py-16 text-center transition-colors',
        dragging
          ? 'border-white/40 bg-white/[0.05]'
          : 'border-[var(--color-line-strong)] bg-white/[0.02]',
      )}
    >
      <div className="dotgrid pointer-events-none absolute inset-0 rounded-[var(--radius-card)] opacity-20" />

      <div className="relative flex h-14 w-14 items-center justify-center rounded-[3px] border border-[var(--color-line-strong)] bg-[var(--color-paper)]">
        <UploadCloud
          className={cn(
            'h-6 w-6 transition-colors',
            dragging ? 'text-[var(--color-signal)]' : 'text-[var(--color-ink-soft)]',
          )}
        />
      </div>
      <div className="relative space-y-1.5">
        <p className="font-display text-xl text-[var(--color-ink)]">Drop files or folders</p>
        <p className="eyebrow text-[var(--color-ink-faint)]">encrypted before they leave your device</p>
      </div>
      <div className="relative flex flex-wrap items-center justify-center gap-3">
        <Button onClick={() => fileInput.current?.click()}>
          <UploadCloud className="h-4 w-4" /> Choose files
        </Button>
        <Button variant="secondary" onClick={() => folderInput.current?.click()}>
          <FolderUp className="h-4 w-4" /> Choose folder
        </Button>
      </div>

      <input
        ref={fileInput}
        type="file"
        multiple
        hidden
        onChange={(e) => {
          if (e.target.files) onFiles(Array.from(e.target.files));
          e.target.value = ''; // allow picking the same file again
        }}
      />
      <input
        ref={folderInput}
        type="file"
        hidden
        // @ts-expect-error non-standard but widely supported folder selection
        webkitdirectory=""
        directory=""
        multiple
        onChange={(e) => {
          if (e.target.files) onFiles(Array.from(e.target.files));
          e.target.value = ''; // allow picking the same file again
        }}
      />
    </div>
  );
}
