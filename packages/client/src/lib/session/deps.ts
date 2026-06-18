/**
 * Optional dependency injection for the session controllers.
 *
 * In production these default to the real SignalingClient / PeerConnection /
 * fetchIceServers. Tests pass in-memory fakes so the reconnect and
 * multi-receiver orchestration can be exercised without a real browser or
 * WebRTC stack.
 */
import type { PeerRole } from '@beam/shared';
import type { SignalingClient } from '../signaling/signalingClient.js';
import type { PeerConnection } from '../webrtc/index.js';

export interface SessionDeps {
  createSignaling?: (url: string) => SignalingClient;
  createPeer?: (
    role: PeerRole,
    roomId: string,
    signaling: SignalingClient,
    iceServers: RTCIceServer[],
  ) => PeerConnection;
  fetchIce?: (url: string) => Promise<RTCIceServer[]>;
}
