import { useState, type FormEvent } from 'react';
import { KeyRound, ArrowRight } from 'lucide-react';
import { PageShell } from '@/components/PageShell';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { SecurityNote } from '@/components/SecurityNote';
import { parseCode, suggestWords } from '@/lib/codes';
import { ReceiveFlow } from './Receive';

/**
 * /receive — type a short code (`42-tiger-ocean`) instead of opening a link.
 * The code stays in this page's memory: it's a password, so it never goes in
 * the URL, and only its number is ever sent to the server.
 */
export function ReceiveCodePage() {
  const [code, setCode] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);

  if (code) {
    return (
      <ReceiveFlow
        key={attempt}
        target={{ code }}
        onRetry={() => {
          setCode(null);
          setAttempt((n) => n + 1);
        }}
      />
    );
  }
  return <CodeForm onSubmit={setCode} />;
}

function CodeForm({ onSubmit }: { onSubmit: (code: string) => void }) {
  const [value, setValue] = useState('');
  const [touched, setTouched] = useState(false);
  const parsed = parseCode(value);
  const lastWord = value.split(/[^a-zA-Z0-9]+/).pop() ?? '';
  const hints = /^[a-z]+$/i.test(lastWord) ? suggestWords(lastWord).filter((w) => w !== lastWord.toLowerCase()) : [];

  const submit = (e: FormEvent) => {
    e.preventDefault();
    setTouched(true);
    if (parsed) onSubmit(parsed.password);
  };

  const complete = (word: string) => {
    const head = value.slice(0, value.length - lastWord.length);
    setValue(`${head}${word}${head.split(/[^a-zA-Z0-9]+/).filter(Boolean).length < 2 ? '-' : ''}`);
  };

  return (
    <PageShell narrow>
      <div className="space-y-6">
        <header className="space-y-3">
          <span className="eyebrow text-[var(--color-ink-faint)]">Receiver</span>
          <h1 className="font-display text-[2.4rem] leading-tight tracking-tight">Enter a code</h1>
          <p className="text-[0.95rem] leading-relaxed text-[var(--color-ink-soft)]">
            The sender sees a short code like <span className="font-mono text-[var(--color-ink)]">42-tiger-ocean</span>{' '}
            next to their link. Type it here to receive their files.
          </p>
        </header>

        <Card>
          <CardContent>
            <form onSubmit={submit} className="space-y-4">
              <label htmlFor="code" className="eyebrow block text-[var(--color-ink-faint)]">
                Code
              </label>
              <input
                id="code"
                data-testid="code-input"
                autoFocus
                autoComplete="off"
                autoCapitalize="none"
                spellCheck={false}
                inputMode="text"
                placeholder="42-tiger-ocean"
                value={value}
                onChange={(e) => setValue(e.target.value)}
                className="w-full rounded-xl border border-white/[0.1] bg-white/[0.03] px-4 py-3.5 font-mono text-lg tracking-wide text-[var(--color-ink)] outline-none transition-colors placeholder:text-[var(--color-ink-faint)] focus:border-white/30"
              />
              {hints.length > 0 && (
                <div className="flex flex-wrap gap-2">
                  {hints.map((w) => (
                    <button
                      key={w}
                      type="button"
                      onClick={() => complete(w)}
                      className="rounded-lg border border-white/[0.08] px-2.5 py-1 font-mono text-xs text-[var(--color-ink-soft)] hover:border-white/20 hover:text-[var(--color-ink)]"
                    >
                      {w}
                    </button>
                  ))}
                </div>
              )}
              {touched && !parsed && value.trim() !== '' && (
                <p className="text-sm text-[var(--color-danger)]">
                  A code is a number and two words, like 42-tiger-ocean. Check the spelling.
                </p>
              )}
              <Button type="submit" size="lg" className="w-full" disabled={!value.trim()}>
                <KeyRound className="h-4 w-4" />
                Receive files
                <ArrowRight className="h-4 w-4" />
              </Button>
            </form>
          </CardContent>
        </Card>

        <p className="text-xs leading-relaxed text-[var(--color-ink-faint)]">
          The code is checked by your browser and the sender's directly (a PAKE), so the server never
          learns it. Three wrong tries and the code stops working — ask the sender for a new one.
        </p>
        <SecurityNote />
      </div>
    </PageShell>
  );
}
