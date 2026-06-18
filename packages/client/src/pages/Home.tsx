import { useEffect, useRef, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { motion } from 'framer-motion';
import {
  ArrowRight,
  LockKeyhole,
  Waypoints,
  BadgeCheck,
  ServerOff,
  KeyRound,
  FileCheck2,
  RotateCcw,
  type LucideIcon,
} from 'lucide-react';
import gsap from 'gsap';
import { ScrollTrigger } from 'gsap/ScrollTrigger';
import { PageShell } from '@/components/PageShell';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Reveal } from '@/components/Reveal';
import { SupportSection } from '@/components/landing/SupportSection';
import { AboutDev } from '@/components/landing/AboutDev';
import { Faq } from '@/components/landing/Faq';
import { HeroMock } from '@/components/landing/HeroMock';

const SPECS = ['AES-256-GCM', 'WebRTC P2P', 'No accounts'];

gsap.registerPlugin(ScrollTrigger);

const HOW: { n: string; title: string; body: string; icon: LucideIcon }[] = [
  { n: '01', title: 'Encrypt locally', body: 'Files are encrypted in your browser before a single byte ever leaves your device.', icon: LockKeyhole },
  { n: '02', title: 'Connect directly', body: 'A peer-to-peer channel opens between both devices. The server only introduces them.', icon: Waypoints },
  { n: '03', title: 'Verify on arrival', body: 'Each chunk is checked against a Merkle root, so what lands is exactly what was sent.', icon: BadgeCheck },
];

const SECURITY: { k: string; v: string; icon: LucideIcon }[] = [
  { k: 'No uploads', v: 'Files travel device to device. Nothing to leak, subpoena, or sell.', icon: ServerOff },
  { k: 'Keys stay local', v: 'The key lives in the link fragment. Servers never see it.', icon: KeyRound },
  { k: 'Tamper-evident', v: 'Per-chunk hashing surfaces any corruption or tampering instantly.', icon: FileCheck2 },
  { k: 'Resumable', v: 'Drop the connection and it continues from the gap, never from zero.', icon: RotateCcw },
];

const ease = [0.22, 1, 0.36, 1] as const;

export function HomePage() {
  const heroRef = useRef<HTMLElement>(null);
  const auraRef = useRef<HTMLDivElement>(null);

  // Subtle scroll parallax on the ambient background (transform only).
  useEffect(() => {
    if (!heroRef.current || !auraRef.current) return;
    const ctx = gsap.context(() => {
      gsap.to(auraRef.current, {
        scrollTrigger: { trigger: heroRef.current, start: 'top top', end: 'bottom top', scrub: 1 },
        yPercent: -10,
        ease: 'none',
      });
    });
    return () => ctx.revert();
  }, []);

  return (
    <PageShell>
      {/* ── Hero — split product showcase ────────────────────── */}
      <section
        ref={heroRef}
        className="relative grid items-center gap-14 py-8 lg:min-h-[80vh] lg:grid-cols-[1.04fr_0.96fr] lg:gap-10 lg:py-12"
      >
        {/* one soft, parallaxed glow for atmosphere */}
        <div ref={auraRef} className="pointer-events-none absolute inset-0 -z-0 overflow-hidden" aria-hidden>
          <div
            className="animate-float-slow absolute left-[28%] top-[38%] h-[40rem] w-[40rem] -translate-x-1/2 -translate-y-1/2 rounded-full blur-[140px]"
            style={{ background: 'radial-gradient(circle, rgba(255,255,255,0.06), transparent 62%)' }}
          />
        </div>

        {/* Copy */}
        <div className="relative z-10 text-center lg:text-left">
          <motion.p
            initial={{ opacity: 0, y: 10 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.6, ease }}
            className="eyebrow inline-flex items-center gap-2 text-[var(--color-ink-faint)]"
          >
            <span className="h-1.5 w-1.5 rounded-full bg-[var(--color-mint)]" />
            End-to-end encrypted · peer-to-peer
          </motion.p>

          <motion.h1
            initial={{ opacity: 0, y: 16 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.9, ease, delay: 0.06 }}
            className="mx-auto mt-6 max-w-[13ch] text-[2.7rem] leading-[1.02] tracking-[-0.02em] sm:text-[4.3rem] lg:mx-0 lg:text-[5rem] lg:leading-[0.94]"
          >
            Send files, <span className="serif-italic">privately.</span>
          </motion.h1>

          <motion.p
            initial={{ opacity: 0, y: 16 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.9, ease, delay: 0.14 }}
            className="mx-auto mt-6 max-w-md text-base leading-relaxed text-[var(--color-ink-soft)] sm:text-lg lg:mx-0"
          >
            Encrypted in your browser. Streamed straight to the other device. No cloud,
            no accounts, no trace.
          </motion.p>

          <motion.div
            initial={{ opacity: 0, y: 16 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.9, ease, delay: 0.22 }}
            className="mt-9 flex w-full flex-col items-center gap-3 sm:flex-row sm:justify-center lg:w-auto lg:justify-start"
          >
            <Button asChild size="lg" className="w-full sm:w-auto">
              <Link to="/send">
                Send a file
                <ArrowRight className="h-4 w-4 transition-transform duration-200 group-hover/btn:translate-x-0.5" />
              </Link>
            </Button>
            <Button asChild variant="ghost" size="lg" className="w-full sm:w-auto">
              <a href="#how">How it works</a>
            </Button>
          </motion.div>

          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            transition={{ duration: 0.8, delay: 0.34 }}
            className="mt-10 flex flex-wrap items-center justify-center gap-x-5 gap-y-2 lg:justify-start"
          >
            {SPECS.map((s) => (
              <span key={s} className="eyebrow text-[var(--color-ink-faint)]">
                {s}
              </span>
            ))}
          </motion.div>
        </div>

        {/* Product mockup */}
        <div className="relative z-10">
          <HeroMock />
        </div>
      </section>

      {/* ── How it works ─────────────────────────────────────── */}
      <Section id="how">
        <SectionHead eyebrow="How it works" title="Three steps. No middlemen." />
        <div className="mt-14 grid gap-4 sm:grid-cols-3">
          {HOW.map((step, i) => (
            <Reveal key={step.n} delay={i * 0.08}>
              <Card className="group/card h-full overflow-hidden transition-all duration-300 hover:-translate-y-1 hover:border-white/[0.14] hover:bg-white/[0.04]">
                <CardContent className="relative p-7">
                  <span className="serif pointer-events-none absolute -right-1 -top-4 select-none text-[6.5rem] leading-none text-white/[0.045] transition-colors duration-300 group-hover/card:text-white/[0.07]">
                    {step.n}
                  </span>
                  <div className="relative">
                    <span className="inline-flex h-11 w-11 items-center justify-center rounded-xl border border-white/[0.08] bg-white/[0.04] text-[var(--color-ink)] transition-colors duration-300 group-hover/card:border-white/20">
                      <step.icon className="h-[22px] w-[22px]" strokeWidth={1.5} />
                    </span>
                    <h3 className="mt-5 font-display text-xl">{step.title}</h3>
                    <p className="mt-3 text-[0.95rem] leading-relaxed text-[var(--color-ink-soft)]">
                      {step.body}
                    </p>
                  </div>
                </CardContent>
              </Card>
            </Reveal>
          ))}
        </div>
      </Section>

      {/* ── Security ──────────────────────────────────────────── */}
      <Section id="security">
        <SectionHead eyebrow="Security" title="We couldn't read your files if we tried." />
        <div className="mx-auto mt-14 grid max-w-4xl gap-x-14 gap-y-10 text-left sm:grid-cols-2">
          {SECURITY.map((item, i) => (
            <Reveal key={item.k} delay={i * 0.06}>
              <div className="flex gap-4 border-t border-white/[0.08] pt-5">
                <span className="mt-0.5 inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-xl border border-white/[0.08] bg-white/[0.04] text-[var(--color-ink)]">
                  <item.icon className="h-5 w-5" strokeWidth={1.5} />
                </span>
                <div>
                  <h3 className="text-lg">{item.k}</h3>
                  <p className="mt-2 text-[0.95rem] leading-relaxed text-[var(--color-ink-soft)]">
                    {item.v}
                  </p>
                </div>
              </div>
            </Reveal>
          ))}
        </div>
      </Section>

      <Faq />
      <SupportSection />
      <AboutDev />

      {/* ── Closing ──────────────────────────────────────────── */}
      <section className="py-24">
        <Reveal>
          <div className="relative overflow-hidden rounded-[28px] border border-white/[0.08] bg-white/[0.02] px-8 py-20 text-center">
            <div
              className="pointer-events-none absolute inset-x-0 top-0 h-48"
              style={{ background: 'radial-gradient(460px 180px at 50% 0, rgba(255,255,255,0.1), transparent 70%)' }}
            />
            <div className="relative">
              <h2 className="mx-auto max-w-xl text-[2.2rem] leading-tight sm:text-[3rem]">
                Send something the <span className="serif-italic">quiet</span> way.
              </h2>
              <div className="mt-9 flex justify-center">
                <Button asChild size="lg">
                  <Link to="/send">
                    Send a file
                    <ArrowRight className="h-4 w-4 transition-transform duration-200 group-hover/btn:translate-x-0.5" />
                  </Link>
                </Button>
              </div>
            </div>
          </div>
        </Reveal>
      </section>
    </PageShell>
  );
}

/** A section — spacing only, no hard divider line. */
function Section({ id, children }: { id: string; children: ReactNode }) {
  return (
    <section id={id} className="scroll-mt-24 py-20 sm:py-28">
      {children}
    </section>
  );
}

function SectionHead({ eyebrow, title }: { eyebrow: string; title: string }) {
  return (
    <Reveal className="mx-auto max-w-2xl text-center">
      <p className="eyebrow text-[var(--color-ink-faint)]">{eyebrow}</p>
      <h2 className="mt-4 text-[2.1rem] leading-tight sm:text-[2.9rem]">{title}</h2>
    </Reveal>
  );
}
