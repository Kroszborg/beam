import { describe, it, expect } from 'vitest';
import { buildIceConfig, trimIceServers } from './iceConfig.js';

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

describe('trimIceServers', () => {
  // The shape Metered's credentials API returns, plus our configured STUN.
  const metered = [
    { urls: ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302'] },
    { urls: 'stun:stun.relay.metered.ca:80' },
    { urls: 'turn:global.relay.metered.ca:80', username: 'u', credential: 'c' },
    { urls: 'turn:global.relay.metered.ca:80?transport=tcp', username: 'u', credential: 'c' },
    { urls: 'turn:global.relay.metered.ca:443', username: 'u', credential: 'c' },
    { urls: 'turns:global.relay.metered.ca:443?transport=tcp', username: 'u', credential: 'c' },
  ];

  it('keeps one STUN and one TURN per transport (four URLs, not seven)', () => {
    expect(trimIceServers(metered)).toEqual([
      { urls: 'stun:stun.l.google.com:19302' },
      {
        urls: [
          'turn:global.relay.metered.ca:80',
          'turn:global.relay.metered.ca:80?transport=tcp',
          'turns:global.relay.metered.ca:443?transport=tcp',
        ],
        username: 'u',
        credential: 'c',
      },
    ]);
  });

  it('keeps TURN entries with different credentials separate', () => {
    const out = trimIceServers([
      { urls: 'turn:a.example:3478', username: 'a', credential: '1' },
      { urls: 'turns:b.example:443', username: 'b', credential: '2' },
    ]);
    expect(out).toEqual([
      { urls: ['turn:a.example:3478'], username: 'a', credential: '1' },
      { urls: ['turns:b.example:443'], username: 'b', credential: '2' },
    ]);
  });

  it('leaves a STUN-only list as a single STUN entry', () => {
    expect(trimIceServers([{ urls: ['stun:x:1', 'stun:y:2'] }])).toEqual([{ urls: 'stun:x:1' }]);
  });
});
