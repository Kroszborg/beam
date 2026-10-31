import { Wifi, Globe, Server, Radio, HardDrive } from 'lucide-react';
import type { Route } from '@/lib/webrtc';

const ROUTES: Record<Route, { label: string; hint: string; Icon: typeof Wifi }> = {
  lan: { label: 'Direct · same network', hint: 'Peer-to-peer over your local network.', Icon: Wifi },
  direct: { label: 'Direct · peer-to-peer', hint: 'Peer-to-peer over the internet.', Icon: Globe },
  turn: { label: 'Via TURN relay', hint: 'A TURN server forwards the encrypted stream; speed depends on it.', Icon: Radio },
  relay: {
    label: 'Via Beam relay',
    hint: "A direct connection wasn't possible, so the encrypted stream goes through the Beam server. It can't read it.",
    Icon: Server,
  },
  stored: {
    label: 'From the server copy',
    hint: 'The sender left an encrypted copy on the Beam server; you are downloading that. The server cannot read it.',
    Icon: HardDrive,
  },
};

/** How the bytes are travelling — explains the speed you're seeing. */
export function RouteBadge({ route }: { route: Route | null }) {
  if (!route) return null;
  const { label, hint, Icon } = ROUTES[route];
  return (
    <span
      title={hint}
      data-testid="route"
      data-route={route}
      className="inline-flex items-center gap-1.5 rounded-[3px] border border-[var(--color-line-strong)] px-2 py-1 font-mono text-[11px] text-[var(--color-ink-soft)]"
    >
      <Icon className="h-3 w-3" />
      {label}
    </span>
  );
}
