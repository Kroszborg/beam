import { useEffect, useMemo, useState } from 'react';
import { useParams } from 'react-router-dom';
import { motion } from 'framer-motion';
import { Download, ShieldCheck, Loader2, AlertTriangle, FolderDown, File as FileIcon } from 'lucide-react';
import type { Manifest } from '@beam/shared';
import { PageShell } from '@/components/PageShell';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { ProgressView } from '@/components/ProgressView';
import { SecurityNote } from '@/components/SecurityNote';
import { StatusStepper } from '@/components/StatusStepper';
import { RouteBadge } from '@/components/RouteBadge';
import { useReceiverSession, type UseReceiver } from '@/hooks/useReceiverSession';
import { useKeepAlive } from '@/hooks/useKeepAlive';
import { sinkOptions, type ReceiverState, type SinkOption } from '@/lib/transfer';
import { formatBytes } from '@/lib/utils';

const STEPS = ['Joining', 'Connecting', 'Choose', 'Receiving', 'Complete'];
const STEP_INDEX: Record<ReceiverState, number> = {
  idle: 0,
  joining: 0,
  connecting: 1,
  connected: 1,
  ready: 2,
  receiving: 3,
  complete: 4,
  error: 0,
};

export function ReceivePage() {
  const { roomId } = useParams<{ roomId: string }>();
  // The key rides in the URL fragment and is never sent to the server.
  const keyFragment = typeof window !== 'undefined' ? window.location.hash.replace(/^#/, '') : '';
  const rx = useReceiverSession(roomId, keyFragment);
  const { state, progress, error, route, waiting } = rx;

  const isError = state === 'error';
  const isComplete = state === 'complete';
  useKeepAlive(state === 'receiving');

  return (
    <PageShell narrow>
      <div className="space-y-6">
        <header className="space-y-2">
          <h1 className="text-2xl font-semibold tracking-tight">Receiving files</h1>
          <p className="text-sm text-[var(--color-ink-muted)]">
            A direct, end-to-end encrypted connection to the sender.
          </p>
        </header>

        <motion.div initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }}>
          <Card>
            <CardContent className="space-y-5">
              <StatusStepper steps={STEPS} current={STEP_INDEX[state]} failed={isError} complete={isComplete} />

              {(state === 'idle' || state === 'joining' || state === 'connecting' || state === 'connected') && (
                <p className="flex items-center gap-2 text-sm text-[var(--color-ink-muted)]">
                  <Loader2 className="h-4 w-4 animate-spin" />
                  {state === 'connected'
                    ? 'Connected — fetching the file list…'
                    : 'Establishing a secure connection to the sender…'}
                </p>
              )}

              {state === 'ready' && rx.manifest && <ChooseFiles manifest={rx.manifest} accept={rx.accept} />}

              {state === 'receiving' && (
                <div className="space-y-4">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <span className="text-sm text-[var(--color-ink-soft)]">
                      {waiting ? 'Connection lost — waiting for the sender to come back…' : 'Receiving…'}
                    </span>
                    <RouteBadge route={route} />
                  </div>
                  {progress && <ProgressView progress={progress} />}
                  <button
                    onClick={() => {
                      if (window.confirm('Cancel this download?')) rx.cancel();
                    }}
                    className="text-xs text-[var(--color-ink-faint)] underline-offset-4 hover:text-[var(--color-ink)] hover:underline"
                  >
                    Cancel download
                  </button>
                </div>
              )}

              {isComplete && <Completed rx={rx} />}

              {isError && (
                <div className="flex items-start gap-2 rounded-xl border border-[var(--color-danger)]/30 bg-[var(--color-danger)]/10 px-4 py-3 text-sm text-[var(--color-danger)]">
                  <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
                  <div>
                    {error ?? 'The transfer could not be completed.'}
                    <div className="mt-1 text-[var(--color-ink-subtle)]">
                      Ask the sender to keep their tab open, then{' '}
                      <button className="underline" onClick={() => window.location.reload()}>
                        retry
                      </button>
                      .
                    </div>
                  </div>
                </div>
              )}
            </CardContent>
          </Card>
        </motion.div>

        {!isComplete && (
          <a
            href="/"
            className="mx-auto block text-center text-xs text-[var(--color-ink-faint)] underline-offset-4 transition-colors hover:text-[var(--color-ink)] hover:underline"
          >
            Leave
          </a>
        )}

        <SecurityNote />
      </div>
    </PageShell>
  );
}

/** Review the sender's files, pick which to take, and where they go. */
function ChooseFiles({ manifest, accept }: { manifest: Manifest; accept: UseReceiver['accept'] }) {
  const [selected, setSelected] = useState<Set<number>>(() => new Set(manifest.files.map((_, i) => i)));
  const [option, setOption] = useState<SinkOption | null>(null);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

  const selectedBytes = useMemo(
    () => [...selected].reduce((s, i) => s + manifest.files[i]!.size, 0),
    [selected, manifest],
  );
  useEffect(() => {
    void sinkOptions(selected.size).then(setOption);
  }, [selected.size]);

  const many = manifest.files.length > 1;
  const tooBig = option?.kind === 'idb' && option.headroom != null && selectedBytes > option.headroom;

  const start = () => {
    if (!option || selected.size === 0) return;
    setBusy(true);
    setProblem(null);
    // Called straight from the click: the save picker needs user activation.
    accept([...selected].sort((a, b) => a - b), option.kind).catch((err: Error) => {
      setBusy(false);
      if (err?.name !== 'AbortError') setProblem(err?.message || 'Could not start the download.');
    });
  };

  const toggle = (i: number) =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(i)) next.delete(i);
      else next.add(i);
      return next;
    });

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <span className="eyebrow text-[var(--color-ink-faint)]">
          {manifest.files.length} file{manifest.files.length === 1 ? '' : 's'} offered
        </span>
        {many && (
          <button
            className="eyebrow text-[var(--color-ink-soft)] hover:text-[var(--color-ink)]"
            onClick={() =>
              setSelected(selected.size === manifest.files.length ? new Set() : new Set(manifest.files.map((_, i) => i)))
            }
          >
            {selected.size === manifest.files.length ? 'Select none' : 'Select all'}
          </button>
        )}
      </div>
      <ul className="max-h-72 divide-y divide-[var(--color-line)] overflow-auto border-y border-[var(--color-line)]">
        {manifest.files.map((f, i) => (
          <li key={i} data-testid="offered-file">
            <label className="flex cursor-pointer items-center gap-3 py-2.5">
              {many ? (
                <input type="checkbox" checked={selected.has(i)} onChange={() => toggle(i)} className="accent-[var(--color-signal)]" />
              ) : (
                <FileIcon className="h-4 w-4 shrink-0 text-[var(--color-ink-faint)]" />
              )}
              <span className="flex-1 truncate text-sm text-[var(--color-ink)]">{f.path}</span>
              <span className="shrink-0 font-mono text-xs text-[var(--color-ink-faint)]">{formatBytes(f.size)}</span>
            </label>
          </li>
        ))}
      </ul>

      {option && <p className="text-xs leading-relaxed text-[var(--color-ink-faint)]">{describe(option, selected.size, selectedBytes)}</p>}
      {tooBig && (
        <p className="text-xs text-[var(--color-danger)]">
          This browser can only hold about {formatBytes(option!.headroom!)} here. Use Chrome, Edge,
          Firefox or Safari in a normal (non-private) window to receive large files.
        </p>
      )}
      {problem && <p className="text-xs text-[var(--color-danger)]">{problem}</p>}

      <Button size="lg" className="w-full" disabled={!option || busy || selected.size === 0} onClick={start}>
        {option?.kind === 'fs' && selected.size > 1 ? <FolderDown className="h-4 w-4" /> : <Download className="h-4 w-4" />}
        {busy ? 'Starting…' : `${option?.kind === 'fs' ? 'Save' : 'Download'} ${formatBytes(selectedBytes)}`}
      </Button>
    </div>
  );
}

function describe(option: SinkOption, count: number, bytes: number): string {
  switch (option.kind) {
    case 'fs':
      return count > 1
        ? 'Pick a folder — files are written straight into it as they arrive, folders included.'
        : "Pick where to save — the file is written straight to disk as it arrives.";
    case 'stream':
      return count > 1
        ? `Downloads through your browser as one .zip (${formatBytes(bytes)} + a few KB), written to disk as it arrives.`
        : 'Downloads through your browser, written to disk as it arrives.';
    case 'idb':
      return 'This browser can’t stream to disk, so files are held in browser storage and saved at the end.';
  }
}

function Completed({ rx }: { rx: UseReceiver }) {
  if (rx.files) {
    return (
      <div className="space-y-3">
        <div className="flex items-center gap-2 text-sm text-[var(--color-success)]">
          <ShieldCheck className="h-4 w-4" />
          Verified &amp; complete — save your file{rx.files.length === 1 ? '' : 's'}:
        </div>
        <ul className="space-y-2">
          {rx.files.map((f) => (
            <li
              key={f.path}
              data-testid="received-file"
              className="flex items-center gap-3 rounded-xl border border-white/[0.08] bg-white/[0.03] px-3 py-2.5"
            >
              <span className="flex-1 truncate text-sm text-[var(--color-ink)]">{f.path}</span>
              <span className="text-xs text-[var(--color-ink-faint)]">{formatBytes(f.size)}</span>
              <Button size="sm" onClick={() => void f.save()}>
                <Download className="h-4 w-4" /> Save
              </Button>
            </li>
          ))}
        </ul>
      </div>
    );
  }
  return (
    <div data-testid="saved" className="space-y-2">
      <div className="flex items-center gap-2 text-sm text-[var(--color-success)]">
        <ShieldCheck className="h-4 w-4" />
        Verified &amp; saved.
      </div>
      {rx.progress && (
        <p className="text-xs text-[var(--color-ink-faint)]">
          {formatBytes(rx.progress.totalBytes)} received. Check your downloads or the folder you picked.
        </p>
      )}
    </div>
  );
}
