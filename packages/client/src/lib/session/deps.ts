/**
 * Optional dependency injection for the session controllers.
 *
 * In production these default to the real SignalingClient / PeerConnection /
 * fetchIceConfig. Tests pass in-memory fakes so the reconnect, relay and
 * multi-receiver orchestration can be exercised without a browser or WebRTC.
 */
import type { PeerRole } from '@beam/shared';
import type { SignalingClient } from '../signaling/signalingClient.js';
import type { IceConfig, PeerConnection } from '../webrtc/index.js';
import type { chooseSink } from '../transfer/index.js';

export interface SessionDeps {
  createSignaling?: (url: string) => SignalingClient;
  createPeer?: (
    role: PeerRole,
    remoteId: string,
    signaling: SignalingClient,
    iceServers: RTCIceServer[],
  ) => PeerConnection;
  fetchIce?: (url: string) => Promise<IceConfig>;
  /** Override the delay before falling back to the relay (ms). */
  relayAfterMs?: number;
  /** Skip WebRTC and use the relay straight away (debugging, tests). */
  forceRelay?: boolean;
  /** Where received files go (tests use an in-memory sink). */
  chooseSink?: typeof chooseSink;
}
