import { useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { Plus } from 'lucide-react';
import { cn } from '@/lib/utils';

const FAQS = [
  {
    q: 'Are my files really never uploaded?',
    a: 'By default, yes. Files are encrypted in your browser and streamed directly to the receiver over a peer-to-peer WebRTC connection — the receiver downloads while you send. If two networks block direct connections, the encrypted stream passes through Beam’s server, which can’t read it and doesn’t keep it. The only exception is one you choose: “Keep an encrypted copy”, below.',
  },
  {
    q: 'What stops Beam from reading my files?',
    a: 'The AES-256 key is generated on your device and travels only in the share link’s URL fragment (after the #). Browsers never send the fragment to any server, so Beam literally never sees the key or the plaintext.',
  },
  {
    q: 'What happens if the connection drops mid-transfer?',
    a: 'Every chunk is written to disk as it arrives, so after a reconnect the transfer continues from the last chunk saved and only the rest is sent — it never restarts from zero.',
  },
  {
    q: 'How big can a transfer be?',
    a: 'As big as the receiver’s disk. Data goes straight to disk as it arrives — into the file or folder they pick, or through the browser’s download manager — so it never piles up in memory. Both tabs just need to stay open until it’s done.',
  },
  {
    q: 'Can I send a folder, or to several people?',
    a: 'Yes to both. Drop a folder and the receiver gets it as a folder (Chrome, Edge) or a single .zip (other browsers), and can untick files they don’t need. Several people can open the same link at once; each gets their own connection.',
  },
  {
    q: 'Can people download after I close the tab?',
    a: 'Only if you choose “Keep an encrypted copy”. Beam then uploads the same encrypted chunks to its server and keeps them for 24 hours (or until you delete them), so the link keeps working without you. Receivers can even start before your upload finishes. The server still never has the key.',
  },
  {
    q: 'What’s a short code?',
    a: 'Instead of a long link, you can show a code like 42-tiger-ocean; the receiver types it at /receive. Your browsers check it directly with a PAKE (a password-authenticated key exchange), so the server never learns it and nobody can guess it offline. After three wrong tries it stops working.',
  },
  {
    q: 'Can I watch a video before it’s finished?',
    a: 'Yes. Videos and audio play while they’re still arriving (as long as the beginning is there — most phone and web videos are fine), and images, text and PDFs open as soon as each file is complete.',
  },
  {
    q: 'Do I need an account?',
    a: 'No. There’s no signup, no login, and no profile. Drop a file, share the link or QR code, and transfer.',
  },
  {
    q: 'Does it work on phones?',
    a: 'Yes. Scan the QR code on the share screen, or type the short code at /receive. Installed as an app on Android, Beam also appears in the share menu.',
  },
];

/** Accessible accordion FAQ. */
export function Faq() {
  const [open, setOpen] = useState<number | null>(0);

  return (
    <section id="faq" className="scroll-mt-20 border-b border-[var(--color-line)] py-16">
      <div className="mb-10 flex items-center gap-3">
        <span className="eyebrow text-[var(--color-signal)]">—</span>
        <span className="eyebrow text-[var(--color-ink-faint)]">Frequently asked</span>
      </div>

      <div className="border-t border-[var(--color-line)]">
        {FAQS.map((item, i) => {
          const isOpen = open === i;
          return (
            <div key={item.q} className="border-b border-[var(--color-line)]">
              <button
                onClick={() => setOpen(isOpen ? null : i)}
                className="flex w-full items-center justify-between gap-6 py-5 text-left"
                aria-expanded={isOpen}
              >
                <span
                  className={cn(
                    'font-display text-lg transition-colors sm:text-xl',
                    isOpen ? 'text-[var(--color-ink)]' : 'text-[var(--color-ink-soft)]',
                  )}
                >
                  {item.q}
                </span>
                <Plus
                  className={cn(
                    'h-4 w-4 shrink-0 text-[var(--color-signal)] transition-transform duration-300',
                    isOpen && 'rotate-45',
                  )}
                />
              </button>
              <AnimatePresence initial={false}>
                {isOpen && (
                  <motion.div
                    initial={{ height: 0, opacity: 0 }}
                    animate={{ height: 'auto', opacity: 1 }}
                    exit={{ height: 0, opacity: 0 }}
                    className="overflow-hidden"
                  >
                    <p className="max-w-2xl pb-6 text-sm leading-relaxed text-[var(--color-ink-soft)]">
                      {item.a}
                    </p>
                  </motion.div>
                )}
              </AnimatePresence>
            </div>
          );
        })}
      </div>
    </section>
  );
}
