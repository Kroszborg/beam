import { describe, it, expect } from 'vitest';
import { buildIceConfig } from './iceConfig.js';

describe('buildIceConfig', () => {
  it('always includes STUN servers by default', async () => {
    const { iceServers } = await buildIceConfig();
    expect(iceServers.length).toBeGreaterThan(0);
    const stun = iceServers.find((s) =>
      (Array.isArray(s.urls) ? s.urls : [s.urls]).some((u) =>
        u.startsWith('stun:'),
      ),
    );
    expect(stun).toBeDefined();
  });

  it('omits TURN credentials when TURN is not configured', async () => {
    // With no TURN_* env vars set, no entry should carry a credential.
    const { iceServers } = await buildIceConfig();
    expect(iceServers.every((s) => s.credential === undefined)).toBe(true);
  });
});
