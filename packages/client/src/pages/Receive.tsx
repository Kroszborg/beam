import { useParams } from 'react-router-dom';
import { motion } from 'framer-motion';
import { Download, ShieldCheck, Loader2, AlertTriangle } from 'lucide-react';
import { PageShell } from '@/components/PageShell';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { ProgressView } from '@/components/ProgressView';
import { SecurityNote } from '@/components/SecurityNote';
import { StatusStepper } from '@/components/StatusStepper';
import { useReceiverSession } from '@/hooks/useReceiverSession';
import { formatBytes } from '@/lib/utils';
import type { ReceiverState } from '@/lib/transfer';

const STEPS = ['Joining', 'Connecting', 'Receiving', 'Verifying', 'Complete'];
const STEP_INDEX: Record<ReceiverState, number> = {
  idle: 0,
  joining: 0,
  connecting: 1,
  connected: 1,
  receiving: 2,
  verifying: 3,
  complete: 4,
  error: 0,
};

export function ReceivePage() {
  const { roomId } = useParams<{ roomId: string }>();
  // The key rides in the URL fragment and is never sent to the server.
  const keyFragment = typeof window !== 'undefined' ? window.location.hash.replace(/^#/, '') : '';
  const { state, progress, files, error } = useReceiverSession(roomId, keyFragment);

  const isError = state === 'error';
  const isComplete = state === 'complete';

  return (
    <PageShell narrow>
      <div className="space-y-6">
        <header className="space-y-2">
          <h1 className="text-2xl font-semibold tracking-tight">Receiving files</h1>
          <p className="text-sm text-[var(--color-ink-muted)]">
            Room <code className="text-[var(--color-ink)]">{roomId}</code> — a direct, encrypted
            connection to the sender.
          </p>
        </header>

        <motion.div initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }}>
          <Card>
            <CardContent className="space-y-5">
              <StatusStepper
                steps={STEPS}
                current={STEP_INDEX[state]}
                failed={isError}
                complete={isComplete}
              />

              {(state === 'joining' || state === 'connecting' || state === 'connected') && (
                <p className="flex items-center gap-2 text-sm text-[var(--color-ink-muted)]">
                  <Loader2 className="h-4 w-4 animate-spin" />
                  {state === 'connected'
                    ? 'Secure connection established — waiting for files…'
                    : 'Establishing a secure peer-to-peer connection…'}
                </p>
              )}

              {progress && (state === 'receiving' || state === 'verifying' || isComplete) && (
                <ProgressView progress={progress} />
              )}

              {state === 'verifying' && (
                <p className="flex items-center gap-2 text-sm text-[var(--color-ink-muted)]">
                  <ShieldCheck className="h-4 w-4 text-[var(--color-accent-2)]" />
                  Verifying integrity (Merkle root) and assembling files…
                </p>
              )}

              {isComplete && files && (
                <div className="space-y-3">
                  <div className="flex items-center gap-2 text-sm text-[var(--color-success)]">
                    <ShieldCheck className="h-4 w-4" />
                    Verified &amp; complete — {files.length} file{files.length === 1 ? '' : 's'} received.
                  </div>
                  <ul className="space-y-2">
                    {files.map((f) => (
                      <li
                        key={f.name}
                        className="flex items-center gap-3 rounded-xl border border-white/[0.08] bg-white/[0.03] px-3 py-2.5"
                      >
                        <span className="flex-1 truncate text-sm text-[var(--color-ink)]">{f.name}</span>
                        <span className="text-xs text-[var(--color-ink-faint)]">{formatBytes(f.size)}</span>
                        <Button size="sm" onClick={() => void f.save()}>
                          <Download className="h-4 w-4" /> Save
                        </Button>
                      </li>
                    ))}
                  </ul>
                </div>
              )}

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
            Cancel
          </a>
        )}

        <SecurityNote />
      </div>
    </PageShell>
  );
}
