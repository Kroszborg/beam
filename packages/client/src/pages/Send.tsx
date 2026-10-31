import { useEffect, useState } from 'react';
import { motion } from 'framer-motion';
import { ShieldCheck, Loader2, CheckCircle2, AlertTriangle, Users, KeyRound, RefreshCw, HardDrive, Trash2 } from 'lucide-react';
import { PageShell } from '@/components/PageShell';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { DropZone } from '@/components/DropZone';
import { FileList } from '@/components/FileList';
import { ProgressView } from '@/components/ProgressView';
import { QrCode } from '@/components/QrCode';
import { CopyButton } from '@/components/CopyButton';
import { SecurityNote } from '@/components/SecurityNote';
import { RouteBadge } from '@/components/RouteBadge';
import { useSenderSession } from '@/hooks/useSenderSession';
import { useKeepAlive } from '@/hooks/useKeepAlive';
import type { ReceiverStatus } from '@/lib/session/senderSession';
import { formatBytes } from '@/lib/utils';
import { takeSharedFiles } from '@/lib/sharedFiles';

export function SendPage() {
  const [files, setFiles] = useState<File[]>([]);
  const sender = useSenderSession();
  const started = sender.phase !== 'idle';

  const addFiles = (incoming: File[]) => setFiles((prev) => [...prev, ...incoming]);

  // Arrived via "Share → Beam" from another app (installed PWA).
  useEffect(() => {
    if (new URLSearchParams(window.location.search).get('shared') !== '1') return;
    void takeSharedFiles().then((shared) => {
      if (shared.length) setFiles((prev) => [...prev, ...shared]);
      window.history.replaceState(null, '', '/send');
    });
  }, []);
  const removeFile = (i: number) => setFiles((prev) => prev.filter((_, idx) => idx !== i));

  return (
    <PageShell narrow>
      <div className="space-y-6">
        <header className="space-y-3">
          <span className="eyebrow text-[var(--color-ink-faint)]">Sender</span>
          <h1 className="font-display text-[2.4rem] leading-tight tracking-tight">Send files</h1>
          <p className="text-[0.95rem] leading-relaxed text-[var(--color-ink-soft)]">
            Encrypted in your browser and streamed straight to the receiver — any size, nothing
            uploaded first.
          </p>
        </header>

        {!started ? (
          <div className="space-y-5">
            <DropZone onFiles={addFiles} />
            {files.length > 0 && (
              <Card>
                <CardContent className="space-y-5">
                  <FileList files={files} onRemove={removeFile} />
                  <Button size="lg" className="w-full" onClick={() => sender.start(files)}>
                    <ShieldCheck className="h-4 w-4" />
                    Create share link
                  </Button>
                </CardContent>
              </Card>
            )}
            <SecurityNote />
          </div>
        ) : (
          <ShareAndProgress sender={sender} files={files} />
        )}
      </div>
    </PageShell>
  );
}

function ShareAndProgress({
  sender,
  files,
}: {
  sender: ReturnType<typeof useSenderSession>;
  files: File[];
}) {
  const total = files.reduce((s, f) => s + f.size, 0);
  const isError = sender.phase === 'error';
  const live = sender.receivers.filter((r) => r.state !== 'left');
  const busy = live.some((r) => r.state === 'connecting' || r.state === 'connected' || r.state === 'sending');
  // Keep the tab alive while the link is shared: closing it ends the transfer
  // — unless an encrypted copy on the server has taken over.
  useKeepAlive(!!sender.room && !isError && sender.copy?.state !== 'ready');

  return (
    <motion.div initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} className="space-y-5">
      <Card>
        <CardContent className="space-y-5">
          {!sender.room && !isError && (
            <p className="flex items-center gap-2 text-sm text-[var(--color-ink-muted)]">
              <Loader2 className="h-4 w-4 animate-spin" />
              Creating your secure link…
            </p>
          )}

          {sender.room && (
            <div className="flex flex-col gap-6 sm:flex-row sm:items-start sm:justify-between">
              {/* min-w-0 lets the long URL truncate instead of forcing width */}
              <div className="min-w-0 flex-1 space-y-4">
                <div className="space-y-1.5">
                  <span className="eyebrow text-[var(--color-ink-faint)]">Share link</span>
                  <code data-testid="share-url" className="block w-full truncate rounded-lg border border-white/[0.08] bg-white/[0.03] px-3 py-2.5 font-mono text-xs text-[var(--color-ink-soft)]">
                    {sender.room.shareUrl}
                  </code>
                </div>
                <div className="flex flex-wrap gap-2">
                  <CopyButton value={sender.room.shareUrl} label="Copy link" />
                </div>
                <ShortCode sender={sender} />
                <ServerCopy sender={sender} totalBytes={total} chunks={files.reduce((n, f) => n + Math.max(1, Math.ceil(f.size / (1024 * 1024))), 0)} />
                <p className="text-xs leading-relaxed text-[var(--color-ink-faint)]">
                  {files.length} file{files.length === 1 ? '' : 's'} · {formatBytes(total)}.{' '}
                  {sender.copy?.state === 'ready'
                    ? 'The link works from the server copy now — several people can use it at once.'
                    : 'Keep this tab open while people download — several can use the link at once.'}{' '}
                  The key lives only in the link: anyone with it can receive the files.
                </p>
              </div>

              <div className="flex shrink-0 justify-center sm:justify-end">
                <QrCode value={sender.room.shareUrl} size={168} />
              </div>
            </div>
          )}

          {isError && (
            <div className="rounded-xl border border-[var(--color-danger)]/30 bg-[var(--color-danger)]/10 px-4 py-3 text-sm text-[var(--color-danger)]">
              {sender.error ?? 'Something went wrong.'}{' '}
              <button className="underline" onClick={() => window.location.reload()}>
                Start over
              </button>
            </div>
          )}
        </CardContent>
      </Card>

      {sender.room && (
        <Card>
          <CardContent className="space-y-4">
            <div className="flex items-center gap-2">
              <Users className="h-4 w-4 text-[var(--color-ink-faint)]" />
              <span className="eyebrow text-[var(--color-ink-faint)]">Receivers</span>
            </div>
            {sender.receivers.length === 0 ? (
              <p className="flex items-center gap-2 text-sm text-[var(--color-ink-muted)]">
                <Loader2 className="h-4 w-4 animate-spin" />
                Waiting for someone to open the link…
              </p>
            ) : (
              <ul className="space-y-4">
                {sender.receivers.map((r) => (
                  <ReceiverRow key={r.id} r={r} single={sender.receivers.length === 1} />
                ))}
              </ul>
            )}
          </CardContent>
        </Card>
      )}

      {!isError && (
        <button
          onClick={() => {
            if (!busy || window.confirm('Stop sharing? Transfers in progress will stop.')) {
              window.location.assign('/send');
            }
          }}
          className="mx-auto block text-xs text-[var(--color-ink-faint)] underline-offset-4 transition-colors hover:text-[var(--color-ink)] hover:underline"
        >
          Stop sharing and start over
        </button>
      )}

      <SecurityNote />
    </motion.div>
  );
}

/**
 * Optional store-and-forward: upload an encrypted copy so receivers can
 * download after this tab is closed (or start before the upload finishes).
 */
function ServerCopy({
  sender,
  totalBytes,
  chunks,
}: {
  sender: ReturnType<typeof useSenderSession>;
  totalBytes: number;
  chunks: number;
}) {
  const limits = sender.room?.storeLimits;
  if (!limits) return null;
  const copy = sender.copy;
  const hours = Math.round(limits.ttlSeconds / 3600);
  const cipherBytes = totalBytes + chunks * 16;

  if (!copy || copy.state === 'deleted') {
    if (cipherBytes > limits.maxBytes) {
      return (
        <p className="text-xs text-[var(--color-ink-faint)]">
          Too large to keep a server copy (limit {formatBytes(limits.maxBytes)}) — keep this tab open.
        </p>
      );
    }
    return (
      <div className="space-y-1.5">
        <Button variant="secondary" size="sm" onClick={sender.keepCopy} data-testid="keep-copy">
          <HardDrive className="h-4 w-4" />
          Keep an encrypted copy for {hours} h
        </Button>
        <p className="text-xs leading-relaxed text-[var(--color-ink-faint)]">
          So people can download after you close this tab. The server stores only ciphertext and
          deletes it after {hours} hours.
        </p>
      </div>
    );
  }

  const pct = copy.totalBytes ? Math.floor((copy.uploadedBytes / copy.totalBytes) * 100) : 0;
  return (
    <div data-testid="server-copy" data-state={copy.state} className="space-y-2 rounded-xl border border-white/[0.08] bg-white/[0.02] px-4 py-3">
      <span className="eyebrow text-[var(--color-ink-faint)]">Server copy</span>
      {copy.state === 'uploading' && (
        <>
          <p className="flex items-center gap-2 text-sm text-[var(--color-ink-soft)]">
            <Loader2 className="h-4 w-4 animate-spin" />
            Uploading encrypted copy… {pct}%
          </p>
          <div className="h-1 overflow-hidden rounded-full bg-white/[0.06]">
            <div className="h-full bg-[var(--color-ink)] transition-[width]" style={{ width: `${pct}%` }} />
          </div>
          <p className="text-xs text-[var(--color-ink-faint)]">
            Receivers can already start. Keep this tab open until it's done.
          </p>
        </>
      )}
      {copy.state === 'ready' && (
        <p className="flex items-start gap-2 text-sm text-[var(--color-success)]">
          <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0" />
          <span>
            Copy kept until {copy.expiresAt ? new Date(copy.expiresAt).toLocaleString() : 'it expires'}. You can
            close this tab — the link keeps working.
          </span>
        </p>
      )}
      {copy.state === 'error' && <p className="text-sm text-[var(--color-danger)]">{copy.error}</p>}
      <div className="flex flex-wrap gap-2">
        {copy.state === 'error' && (
          <Button
            variant="secondary"
            size="sm"
            onClick={() => void sender.removeCopy().then(sender.keepCopy)}
          >
            <RefreshCw className="h-3.5 w-3.5" />
            Retry
          </Button>
        )}
        <Button variant="secondary" size="sm" onClick={() => void sender.removeCopy()}>
          <Trash2 className="h-3.5 w-3.5" />
          Delete copy
        </Button>
      </div>
    </div>
  );
}

/**
 * Optional short code (`42-tiger-ocean`) for when a link is awkward — reading
 * it out loud, typing it on a TV or another person's laptop.
 */
function ShortCode({ sender }: { sender: ReturnType<typeof useSenderSession> }) {
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const make = async () => {
    setBusy(true);
    setProblem(null);
    try {
      await sender.createCode();
    } catch (e) {
      setProblem((e as Error).message || "Couldn't create a code.");
    } finally {
      setBusy(false);
    }
  };
  const code = sender.code;

  if (!code) {
    return (
      <div className="space-y-1.5">
        <Button variant="secondary" size="sm" onClick={make} disabled={busy} data-testid="make-code">
          {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <KeyRound className="h-4 w-4" />}
          Use a short code instead
        </Button>
        {problem && <p className="text-xs text-[var(--color-danger)]">{problem}</p>}
      </div>
    );
  }

  return (
    <div className="space-y-2 rounded-xl border border-white/[0.08] bg-white/[0.02] px-4 py-3">
      <span className="eyebrow text-[var(--color-ink-faint)]">Short code</span>
      {code.disabled ? (
        <p className="text-sm text-[var(--color-danger)]">
          Disabled after too many wrong tries — someone may be guessing.
        </p>
      ) : (
        <p data-testid="short-code" className="font-mono text-2xl tracking-wide text-[var(--color-ink)]">
          {code.code}
        </p>
      )}
      <p className="text-xs leading-relaxed text-[var(--color-ink-faint)]">
        {code.disabled
          ? 'The link still works. Make a new code if you need one.'
          : `They open ${window.location.host}/receive and type it in. It stops working after ${code.attemptsLeft} more wrong ${code.attemptsLeft === 1 ? 'try' : 'tries'}.`}
      </p>
      <div className="flex flex-wrap gap-2">
        {!code.disabled && <CopyButton value={code.code} label="Copy code" size="sm" />}
        <Button variant="secondary" size="sm" onClick={make} disabled={busy}>
          <RefreshCw className="h-3.5 w-3.5" />
          New code
        </Button>
      </div>
    </div>
  );
}

const STATE_LABEL: Record<ReceiverStatus['state'], string> = {
  connecting: 'Connecting…',
  connected: 'Connected — choosing files',
  sending: 'Sending',
  complete: 'Delivered',
  error: 'Failed',
  left: 'Left',
};

function ReceiverRow({ r, single }: { r: ReceiverStatus; single: boolean }) {
  return (
    <li data-testid="receiver" data-state={r.state} className="space-y-2.5 border-t border-[var(--color-line)] pt-4 first:border-0 first:pt-0">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="flex items-center gap-2 text-sm text-[var(--color-ink)]">
          {r.state === 'complete' ? (
            <CheckCircle2 className="h-4 w-4 text-[var(--color-success)]" />
          ) : r.state === 'error' ? (
            <AlertTriangle className="h-4 w-4 text-[var(--color-danger)]" />
          ) : r.state === 'left' ? null : (
            <Loader2 className="h-4 w-4 animate-spin text-[var(--color-ink-faint)]" />
          )}
          Receiver {r.ordinal} · {STATE_LABEL[r.state]}
        </span>
        <RouteBadge route={r.route} />
      </div>
      {r.progress && r.state !== 'left' && <ProgressView progress={r.progress} compact={!single} />}
      {r.state === 'complete' && (
        <p className="text-sm text-[var(--color-success)]">Transfer complete — delivered and verified.</p>
      )}
      {r.error && <p className="text-sm text-[var(--color-danger)]">{r.error}</p>}
    </li>
  );
}
