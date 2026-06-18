/**
 * Builds the ICE server list handed to clients via `GET /ice`.
 *
 * STUN is always included. TURN can come from two sources (either/both):
 *   1. Static `TURN_URL` / `TURN_USERNAME` / `TURN_CREDENTIAL` env vars.
 *   2. A `TURN_API_URL` that returns a ready iceServers JSON array (e.g.
 *      Metered's credentials endpoint). We fetch this server-side — so the API
 *      key never reaches the browser — and cache it, since those credentials
 *      rotate but are valid for a while.
 *
 * Either way the browser just receives a final iceServers list; no client
 * change is needed to switch relays.
 */
import type { IceConfigResponse, IceServerConfig } from '@beam/shared';
import { config } from '../config.js';

/** Cache the fetched API servers so we don't hit the provider on every /ice. */
let apiCache: { servers: IceServerConfig[]; at: number } | null = null;
const API_CACHE_MS = 50 * 60 * 1000; // 50 minutes

async function fetchApiServers(url: string): Promise<IceServerConfig[]> {
  if (apiCache && Date.now() - apiCache.at < API_CACHE_MS) {
    return apiCache.servers;
  }
  try {
    const res = await fetch(url);
    if (!res.ok) return apiCache?.servers ?? [];
    const data = (await res.json()) as IceServerConfig[];
    if (Array.isArray(data)) {
      apiCache = { servers: data, at: Date.now() };
      return data;
    }
    return apiCache?.servers ?? [];
  } catch {
    // Network hiccup — fall back to the last good list (or none).
    return apiCache?.servers ?? [];
  }
}

export async function buildIceConfig(): Promise<IceConfigResponse> {
  const iceServers: IceServerConfig[] = [];

  if (config.stunUrls.length > 0) {
    iceServers.push({ urls: config.stunUrls });
  }

  if (config.turn) {
    const urls = config.turn.url
      .split(',')
      .map((u) => u.trim())
      .filter(Boolean);
    iceServers.push({
      urls: urls.length === 1 ? urls[0]! : urls,
      username: config.turn.username,
      credential: config.turn.credential,
    });
  }

  if (config.turnApiUrl) {
    iceServers.push(...(await fetchApiServers(config.turnApiUrl)));
  }

  return { iceServers };
}
