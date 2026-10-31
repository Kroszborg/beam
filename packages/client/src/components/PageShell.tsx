import type { ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { Brand } from './Brand';
import { DEV_INFO } from '@/config/dev';

const NAV = [
  { href: '/receive', label: 'Receive' },
  { href: '/#how', label: 'How it works' },
  { href: '/#faq', label: 'FAQ' },
  { href: '/#about', label: 'About' },
];

/** Shared page chrome: minimal header, centered column, quiet footer. */
export function PageShell({ children, narrow = false }: { children: ReactNode; narrow?: boolean }) {
  return (
    <div className="flex min-h-full flex-col">
      <header className="sticky top-0 z-30 border-b border-white/[0.06] bg-[var(--color-paper)]/70 backdrop-blur-xl">
        <div className="mx-auto flex h-16 w-full max-w-6xl items-center justify-between px-6">
          <Brand />
          <nav className="flex items-center gap-7">
            {NAV.map((item) => (
              <a
                key={item.href}
                href={item.href}
                className={`link-ul text-sm text-[var(--color-ink-soft)] transition-colors hover:text-[var(--color-ink)] ${
                  item.href === '/receive' ? 'inline-block' : 'hidden sm:inline-block'
                }`}
              >
                {item.label}
              </a>
            ))}
            <Link
              to="/send"
              className="rounded-[10px] border border-white/12 bg-white/[0.03] px-4 py-2 text-sm font-medium text-[var(--color-ink)] transition-colors hover:bg-white/[0.07]"
            >
              Send a file
            </Link>
          </nav>
        </div>
      </header>

      <main className="mx-auto w-full flex-1 px-6 py-14 sm:py-20">
        <div className={narrow ? 'mx-auto max-w-2xl' : 'mx-auto max-w-6xl'}>{children}</div>
      </main>

      <footer className="border-t border-white/[0.06]">
        <div className="mx-auto w-full max-w-6xl px-6 py-10">
          <div className="flex flex-col gap-6 sm:flex-row sm:items-center sm:justify-between">
            <Brand />
            <p className="max-w-xs text-sm leading-relaxed text-[var(--color-ink-faint)]">
              Encrypted, peer-to-peer file transfer. No uploads. No accounts.
            </p>
          </div>
          <hr className="rule my-7" />
          <div className="flex flex-col gap-4 text-sm text-[var(--color-ink-faint)] sm:flex-row sm:items-center sm:justify-between">
            <span>© {new Date().getFullYear()} Beam</span>
            <nav className="flex items-center gap-6">
              <Link to="/privacy" className="link-ul hover:text-[var(--color-ink)]">
                Privacy
              </Link>
              <Link to="/terms" className="link-ul hover:text-[var(--color-ink)]">
                Terms
              </Link>
              <a
                href={DEV_INFO.portfolioUrl}
                target="_blank"
                rel="noopener"
                className="link-ul font-medium text-[var(--color-ink-soft)] hover:text-[var(--color-ink)]"
              >
                Built by {DEV_INFO.name}
              </a>
            </nav>
          </div>
        </div>
      </footer>
    </div>
  );
}
