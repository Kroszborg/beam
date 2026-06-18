import { useState } from 'react';
import { motion } from 'framer-motion';
import { ShieldCheck, Loader2, CheckCircle2 } from 'lucide-react';
import { PageShell } from '@/components/PageShell';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { DropZone } from '@/components/DropZone';
import { FileList } from '@/components/FileList';
import { ProgressView } from '@/components/ProgressView';
import { QrCode } from '@/components/QrCode';
import { CopyButton } from '@/components/CopyButton';
import { SecurityNote } from '@/components/SecurityNote';
import { StatusStepper } from '@/components/StatusStepper';
import { useSenderSession } from '@/hooks/useSenderSession';
import { formatBytes } from '@/lib/utils';

const STEPS = ['Preparing', 'Waiting', 'Connected', 'Sending', 'Complete'];
const STEP_INDEX: Record<string, number> = {
  preparing: 0,
  waiting: 1,
  connected: 2,
  sending: 3,
  complete: 4,
  error: 0,
};

export function SendPage() {
  const [files, setFiles] = useState<File[]>([]);
  const sender = useSenderSession();
  const started = sender.room !== null || sender.state !== 'idle';

  const addFiles = (incoming: File[]) =>
    setFiles((prev) => [...prev, ...incoming]);
  const removeFile = (i: number) => setFiles((prev) => prev.filter((_, idx) => idx !== i));

  return (
    <PageShell narrow>
      <div className="space-y-6">
        <header className="space-y-3">
          <span className="eyebrow text-[var(--color-ink-faint)]">Sender</span>
          <h1 className="font-display text-[2.4rem] leading-tight tracking-tight">Send files</h1>
          <p className="text-[0.95rem] leading-relaxed text-[var(--color-ink-soft)]">
            Encrypted in your browser, sent directly to the receiver. Nothing is uploaded.
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
                    Encrypt &amp; create share link
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
  const isError = sender.state === 'error';
  const isComplete = sender.state === 'complete';

  return (
    <motion.div initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} className="space-y-5">
      <Card>
        <CardContent className="space-y-5">
          <StatusStepper
            steps={STEPS}
            current={STEP_INDEX[sender.state] ?? 0}
            failed={isError}
            complete={isComplete}
          />

          {sender.state === 'preparing' && (
            <p className="flex items-center gap-2 text-sm text-[var(--color-ink-muted)]">
              <Loader2 className="h-4 w-4 animate-spin" />
              Encrypting and fingerprinting {files.length} file{files.length === 1 ? '' : 's'} ({formatBytes(total)})…
            </p>
          )}

          {!sender.room && !isError && sender.state !== 'preparing' && (
            <p className="flex items-center gap-2 text-sm text-[var(--color-ink-muted)]">
              <Loader2 className="h-4 w-4 animate-spin" />
              Creating your secure room…
            </p>
          )}

          {sender.room && !isComplete && (
            <div className="flex flex-col gap-6 sm:flex-row sm:items-start sm:justify-between">
              {/* min-w-0 lets the long URL truncate instead of forcing width */}
              <div className="min-w-0 flex-1 space-y-4">
                <div className="space-y-1.5">
                  <span className="eyebrow text-[var(--color-ink-faint)]">Share link</span>
                  <code className="block w-full truncate rounded-lg border border-white/[0.08] bg-white/[0.03] px-3 py-2.5 font-mono text-xs text-[var(--color-ink-soft)]">
                    {sender.room.shareUrl}
                  </code>
                </div>
                <div className="flex flex-wrap gap-2">
                  <CopyButton value={sender.room.shareUrl} label="Copy link" />
                  <CopyButton value={sender.room.roomId} label="Copy room code" />
                </div>
                <p className="text-xs leading-relaxed text-[var(--color-ink-faint)]">
                  Keep this tab open until the transfer completes. The key lives only in this link —
                  anyone with it can receive the files.
                </p>
              </div>

              <div className="flex shrink-0 justify-center sm:justify-end">
                <QrCode value={sender.room.shareUrl} size={168} />
              </div>
            </div>
          )}

          {sender.progress && (sender.state === 'sending' || isComplete) && (
            <ProgressView progress={sender.progress} />
          )}

          {isComplete && (
            <div className="flex items-center gap-2 rounded-xl border border-[var(--color-success)]/30 bg-[var(--color-success)]/10 px-4 py-3 text-sm text-[var(--color-success)]">
              <CheckCircle2 className="h-4 w-4" />
              Transfer complete — all files delivered and verified.
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

      {!isComplete && !isError && (
        <button
          onClick={() => window.location.assign('/send')}
          className="mx-auto block text-xs text-[var(--color-ink-faint)] underline-offset-4 transition-colors hover:text-[var(--color-ink)] hover:underline"
        >
          Cancel and start over
        </button>
      )}

      <SecurityNote />
    </motion.div>
  );
}
