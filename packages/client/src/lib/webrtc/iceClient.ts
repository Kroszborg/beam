/**
 * Fetches ICE server configuration from the signaling server's `GET /ice`.
 *
 * This is the only thing the client needs from the server besides the
 * WebSocket — and notably it carries no secret. TURN credentials (when the
 * deployment uses TURN) are relay-only and never expose file data. The
 * response also says whether the server offers the WebSocket relay fallback.
 */
import type { IceConfigResponse } from '@beam/shared';

export interface IceConfig {
  iceServers: RTCIceServer[];
  relay: boolean;
}

export async function fetchIceConfig(signalingBaseUrl: string): Promise<IceConfig> {
  try {
    const res = await fetch(`${signalingBaseUrl.replace(/\/$/, '')}/ice`);
    if (!res.ok) throw new Error(`ICE config request failed: ${res.status}`);
    const body = (await res.json()) as IceConfigResponse;
    return { iceServers: body.iceServers as RTCIceServer[], relay: body.relay === true };
  } catch {
    // Fall back to a public STUN server so local/dev still works offline-ish.
    return { iceServers: [{ urls: 'stun:stun.l.google.com:19302' }], relay: false };
  }
}
