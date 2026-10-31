import { useEffect, useState } from 'react';
import { Play, Image as ImageIcon, FileText, Music, ExternalLink, X } from 'lucide-react';
import type { PreviewItem, PreviewKind, PreviewStore } from '@/lib/preview/previewStore';
import { formatBytes } from '@/lib/utils';

/** Media can start once this much of the file has arrived. */
const MEDIA_START_BYTES = 256 * 1024;

const ICON: Record<PreviewKind, typeof Play> = {
  video: Play,
  audio: Music,
  image: ImageIcon,
  text: FileText,
  pdf: FileText,
};

function ready(item: PreviewItem): boolean {
  if (item.kind === 'video' || item.kind === 'audio') {
    return item.buffered >= Math.min(item.size, MEDIA_START_BYTES);
  }
  return item.complete;
}

/** Media plays through the service worker while it streams in; without one, only when complete. */
const streaming = () => typeof navigator !== 'undefined' && !!navigator.serviceWorker?.controller;

/** Preview received files — videos and audio before they've finished arriving. */
export function Previews({ store }: { store: PreviewStore }) {
  const [items, setItems] = useState<PreviewItem[]>(() => store.items());
  const [open, setOpen] = useState<number | null>(null);

  useEffect(() => {
    setItems(store.items());
    return store.on('change', setItems);
  }, [store]);

  if (items.length === 0) return null;
  const current = items.find((i) => i.fileIndex === open) ?? null;

  return (
    <div data-testid="previews" className="space-y-3 border-t border-[var(--color-line)] pt-4">
      <span className="eyebrow text-[var(--color-ink-faint)]">Preview</span>
      <ul className="space-y-1.5">
        {items.map((item) => {
          const Icon = ICON[item.kind];
          const canOpen = ready(item) && (item.complete || streaming());
          const pct = Math.floor((item.buffered / item.size) * 100);
          return (
            <li key={item.fileIndex} className="flex items-center justify-between gap-3 text-sm">
              <span className="flex min-w-0 items-center gap-2 text-[var(--color-ink-soft)]">
                <Icon className="h-4 w-4 shrink-0 text-[var(--color-ink-faint)]" />
                <span className="truncate">{item.name}</span>
                <span className="shrink-0 font-mono text-[11px] text-[var(--color-ink-faint)]">
                  {item.complete ? formatBytes(item.size) : `${pct}%`}
                </span>
              </span>
              <button
                data-testid="preview-open"
                disabled={!canOpen}
                onClick={() => setOpen(open === item.fileIndex ? null : item.fileIndex)}
                className="shrink-0 rounded-lg border border-white/[0.1] px-2.5 py-1 text-xs text-[var(--color-ink-soft)] transition-colors enabled:hover:border-white/25 enabled:hover:text-[var(--color-ink)] disabled:opacity-40"
              >
                {open === item.fileIndex ? 'Close' : canOpen ? 'Preview' : item.kind === 'video' || item.kind === 'audio' ? 'Buffering…' : 'When complete'}
              </button>
            </li>
          );
        })}
      </ul>
      {current && <Viewer store={store} item={current} onClose={() => setOpen(null)} />}
    </div>
  );
}

function Viewer({ store, item, onClose }: { store: PreviewStore; item: PreviewItem; onClose: () => void }) {
  const [text, setText] = useState<{ text: string; truncated: boolean } | null>(null);
  // Fix the source when opened: swapping a playing <video>'s src would restart it.
  const [mediaSrc] = useState(() =>
    streaming() ? store.streamUrl(item.fileIndex) : store.objectUrl(item.fileIndex),
  );

  useEffect(() => {
    if (item.kind === 'text' && item.complete) void store.text(item.fileIndex).then(setText);
  }, [store, item.kind, item.complete, item.fileIndex]);

  return (
    <div className="relative overflow-hidden rounded-xl border border-white/[0.08] bg-black/40">
      <button
        onClick={onClose}
        aria-label="Close preview"
        className="absolute right-2 top-2 z-10 rounded-full bg-black/60 p-1.5 text-[var(--color-ink-soft)] hover:text-[var(--color-ink)]"
      >
        <X className="h-3.5 w-3.5" />
      </button>
      {item.kind === 'video' && mediaSrc && (
        <video data-testid="preview-video" src={mediaSrc} controls autoPlay playsInline className="max-h-[60vh] w-full" />
      )}
      {item.kind === 'audio' && mediaSrc && (
        <audio data-testid="preview-audio" src={mediaSrc} controls autoPlay className="w-full p-4" />
      )}
      {item.kind === 'image' && (
        <img
          data-testid="preview-image"
          src={store.objectUrl(item.fileIndex) ?? undefined}
          alt={item.name}
          className="mx-auto max-h-[60vh] object-contain"
        />
      )}
      {item.kind === 'text' && (
        <pre data-testid="preview-text" className="max-h-[50vh] overflow-auto whitespace-pre-wrap break-words p-4 font-mono text-xs text-[var(--color-ink-soft)]">
          {text ? text.text + (text.truncated ? '\n\n… (preview shows the first 256 KB)' : '') : 'Loading…'}
        </pre>
      )}
      {item.kind === 'pdf' && (
        <div className="p-4">
          <a
            href={streaming() ? store.streamUrl(item.fileIndex) : (store.objectUrl(item.fileIndex) ?? '#')}
            target="_blank"
            rel="noopener"
            className="inline-flex items-center gap-1.5 text-sm text-[var(--color-ink)] underline-offset-4 hover:underline"
          >
            Open the PDF in a new tab <ExternalLink className="h-3.5 w-3.5" />
          </a>
        </div>
      )}
    </div>
  );
}
