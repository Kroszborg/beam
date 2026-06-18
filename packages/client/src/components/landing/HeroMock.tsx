import { motion } from 'framer-motion';
import { Lock, FileArchive, ArrowDownToLine } from 'lucide-react';
import { QrCode } from '@/components/QrCode';

/**
 * Hero centerpiece — a polished mockup of Beam's share/transfer card mid-send.
 * It shows what the product actually does (a far better focal point than an
 * abstract effect): a secure channel, a file transferring, and the share link
 * + QR. A faint "receiver" card behind it tells the device-to-device story.
 */
export function HeroMock() {
  return (
    <div className="relative mx-auto w-full max-w-md">
      {/* Ambient glow behind the card */}
      <div
        className="pointer-events-none absolute -inset-10 -z-10"
        style={{
          background:
            'radial-gradient(closest-side, rgba(84,214,166,0.10), rgba(255,255,255,0.05), transparent 75%)',
        }}
      />

      {/* Faint receiver card peeking behind for depth */}
      <div className="absolute -right-5 -top-7 hidden w-[80%] rounded-2xl border border-white/[0.09] bg-[#121319] p-4 shadow-[0_30px_80px_-30px_rgba(0,0,0,0.9)] sm:block">
        <div className="flex items-center gap-2">
          <ArrowDownToLine className="h-3.5 w-3.5 text-[var(--color-ink-faint)]" />
          <span className="font-mono text-[10px] uppercase tracking-[0.16em] text-[var(--color-ink-faint)]">
            Peer · receiving
          </span>
        </div>
        <div className="mt-3 h-1 w-2/3 rounded-full bg-white/[0.06]" />
      </div>

      {/* Main "sending" card */}
      <motion.div
        initial={{ opacity: 0, y: 24, rotateX: 8 }}
        animate={{ opacity: 1, y: 0, rotateX: 0 }}
        transition={{ duration: 1, ease: [0.22, 1, 0.36, 1], delay: 0.25 }}
        className="relative"
      >
        <motion.div
          animate={{ y: [0, -9, 0] }}
          transition={{ duration: 6.5, repeat: Infinity, ease: 'easeInOut' }}
          className="rounded-[20px] border border-white/[0.14] bg-[#181a22] p-5 shadow-[0_50px_140px_-30px_rgba(0,0,0,0.95)] ring-1 ring-inset ring-white/[0.05]"
        >
          {/* header */}
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <span className="relative flex h-2 w-2">
                <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-[var(--color-mint)] opacity-60" />
                <span className="relative inline-flex h-2 w-2 rounded-full bg-[var(--color-mint)]" />
              </span>
              <span className="font-mono text-[11px] uppercase tracking-[0.16em] text-[var(--color-ink-soft)]">
                Secure channel
              </span>
            </div>
            <span className="flex items-center gap-1.5 font-mono text-[11px] text-[var(--color-mint)]">
              <Lock className="h-3 w-3" /> AES-256
            </span>
          </div>

          <div className="my-4 h-px bg-white/[0.07]" />

          {/* file + progress */}
          <div className="flex items-center gap-3">
            <span className="flex h-11 w-11 items-center justify-center rounded-xl border border-white/[0.08] bg-white/[0.04]">
              <FileArchive className="h-5 w-5 text-[var(--color-ink)]" strokeWidth={1.5} />
            </span>
            <div className="min-w-0 flex-1">
              <div className="truncate text-sm text-[var(--color-ink)]">designs.zip</div>
              <div className="font-mono text-xs text-[var(--color-ink-faint)]">248 MB</div>
            </div>
            <span className="font-mono text-sm tabular-nums text-[var(--color-mint)]">64%</span>
          </div>

          <div className="mt-4 h-1.5 overflow-hidden rounded-full bg-white/[0.06]">
            <motion.div
              initial={{ width: '0%' }}
              animate={{ width: '64%' }}
              transition={{ duration: 1.4, ease: 'easeOut', delay: 0.9 }}
              className="h-full rounded-full bg-gradient-to-r from-[var(--color-mint-deep)] to-[var(--color-mint)]"
            />
          </div>
          <div className="mt-2 flex justify-between font-mono text-[11px] text-[var(--color-ink-faint)]">
            <span>12.4 MB/s</span>
            <span>8s left</span>
          </div>

          <div className="my-4 h-px bg-white/[0.07]" />

          {/* share link + QR */}
          <div className="flex items-center gap-3">
            <QrCode value="https://beam.kroszborg.co/r/x8k2q9#secret" size={64} />
            <div className="min-w-0 flex-1">
              <span className="font-mono text-[10px] uppercase tracking-[0.16em] text-[var(--color-ink-faint)]">
                Share link
              </span>
              <code className="mt-1 block truncate font-mono text-xs text-[var(--color-ink-soft)]">
                beam.kroszborg.co/r/x8k2q9#…
              </code>
              <div className="mt-2 inline-flex rounded-md border border-white/[0.1] bg-white/[0.03] px-2.5 py-1 text-[11px] text-[var(--color-ink)]">
                Copy link
              </div>
            </div>
          </div>
        </motion.div>
      </motion.div>
    </div>
  );
}
