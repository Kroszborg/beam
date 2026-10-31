import { ShieldCheck, Lock, KeyRound, ServerOff } from 'lucide-react';

const POINTS = [
  { icon: ServerOff, text: 'Nothing stored unless you choose' },
  { icon: Lock, text: 'AES-256-GCM end-to-end' },
  { icon: KeyRound, text: 'Keys stay in your browser' },
  { icon: ShieldCheck, text: 'Integrity verified per chunk' },
];

/** Compact reassurance strip reused across the transfer screens. */
export function SecurityNote() {
  return (
    <ul className="grid grid-cols-2 gap-x-4 gap-y-2.5 sm:grid-cols-4">
      {POINTS.map(({ icon: Icon, text }) => (
        <li key={text} className="flex items-center gap-2">
          <Icon className="h-3.5 w-3.5 shrink-0 text-[var(--color-signal)]" />
          <span className="text-xs text-[var(--color-ink-soft)]">{text}</span>
        </li>
      ))}
    </ul>
  );
}
