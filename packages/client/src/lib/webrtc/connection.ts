/**
 * High-level WebRTC peer connection to one remote peer.
 *
 * Encapsulates the offer/answer + ICE choreography against a SignalingClient
 * and surfaces a single clean event: `channel-open`, delivering a ready
 * DataChannelTransport. Roles are fixed — the sender is the offerer and owns
 * the DataChannel; the receiver answers and adopts it — which sidesteps
 * negotiation glare entirely. A sender holds one PeerConnection per receiver;
 * signals are routed by peer id.
 *
 * Once `channel-open` fires, the bulk transfer runs peer-to-peer with no
 * further server involvement.
 */
import type { PeerRole, SignalPayload } from '@beam/shared';
import { Emitter } from '../events.js';
import { DataChannelTransport } from './dataChannel.js';
import type { SignalingClient } from '../signaling/signalingClient.js';

/** How the bytes are actually travelling, for the UI. */
export type Route = 'lan' | 'direct' | 'turn' | 'relay';

type ConnectionEvents = {
  'channel-open': DataChannelTransport;
  /**
   * Receiver only: a new offer arrived on an already-negotiated connection —
   * the sender restarted the handshake. The session answers it on a fresh
   * PeerConnection (see `handleSignal`).
   */
  'new-offer': SignalPayload;
  state: RTCPeerConnectionState;
  connected: void;
  disconnected: void;
  failed: void;
};

const DATA_CHANNEL_LABEL = 'beam';

export class PeerConnection {
  private readonly pc: RTCPeerConnection;
  private readonly emitter = new Emitter<ConnectionEvents>();
  /** ICE candidates that arrive before the remote description is set. */
  private readonly pendingCandidates: RTCIceCandidateInit[] = [];
  private remoteDescriptionSet = false;
  private unsubscribeSignal: (() => void) | null = null;
  private channel: RTCDataChannel | null = null;

  readonly on = this.emitter.on.bind(this.emitter);

  constructor(
    private readonly role: PeerRole,
    /** The peer on the other end. */
    readonly remoteId: string,
    private readonly signaling: SignalingClient,
    iceServers: RTCIceServer[],
  ) {
    this.pc = new RTCPeerConnection({ iceServers });

    // Trickle our ICE candidates to the other peer as they're discovered.
    this.pc.onicecandidate = (event) => {
      this.signal({ kind: 'ice', candidate: event.candidate ? event.candidate.toJSON() : null });
    };

    this.pc.onconnectionstatechange = () => {
      const state = this.pc.connectionState;
      this.emitter.emit('state', state);
      if (state === 'connected') this.emitter.emit('connected', undefined);
      else if (state === 'failed') this.emitter.emit('failed', undefined);
      else if (state === 'disconnected' || state === 'closed')
        this.emitter.emit('disconnected', undefined);
    };

    // The receiver adopts the channel the sender opens.
    this.pc.ondatachannel = (event) => {
      this.adoptChannel(event.channel);
    };

    this.unsubscribeSignal = this.signaling.on('signal', ({ from, data }) => {
      if (from !== remoteId) return;
      if (
        role === 'receiver' &&
        this.remoteDescriptionSet &&
        data.kind === 'sdp' &&
        data.description.type === 'offer'
      ) {
        this.emitter.emit('new-offer', data);
        return;
      }
      void this.handleSignal(data);
    });
  }

  /** Apply a signal from the remote peer (also used to hand over a new offer). */
  handleSignal(payload: SignalPayload): Promise<void> {
    return this.onSignal(payload).catch(() => {});
  }

  private signal(data: SignalPayload): void {
    this.signaling.sendSignal(data, this.role === 'sender' ? this.remoteId : undefined);
  }

  /** Sender-only: create the DataChannel and kick off the offer. */
  async start(): Promise<void> {
    if (this.role !== 'sender') return;
    const channel = this.pc.createDataChannel(DATA_CHANNEL_LABEL, {
      ordered: true, // reliable + ordered: frames of a chunk arrive contiguously
    });
    this.adoptChannel(channel);

    const offer = await this.pc.createOffer();
    await this.pc.setLocalDescription(offer);
    this.signal({
      kind: 'sdp',
      description: { type: offer.type, ...(offer.sdp ? { sdp: offer.sdp } : {}) },
    });
  }

  private adoptChannel(channel: RTCDataChannel): void {
    this.channel = channel;
    const open = () => this.emitter.emit('channel-open', new DataChannelTransport(channel, this.pc.sctp));
    if (channel.readyState === 'open') open();
    else channel.addEventListener('open', open, { once: true });
  }

  private async onSignal(payload: SignalPayload): Promise<void> {
    if (payload.kind === 'sdp') {
      await this.pc.setRemoteDescription(payload.description as RTCSessionDescriptionInit);
      this.remoteDescriptionSet = true;
      await this.flushPendingCandidates();

      // Receiver answers an incoming offer.
      if (payload.description.type === 'offer') {
        const answer = await this.pc.createAnswer();
        await this.pc.setLocalDescription(answer);
        this.signal({
          kind: 'sdp',
          description: { type: answer.type, ...(answer.sdp ? { sdp: answer.sdp } : {}) },
        });
      }
    } else if (payload.kind === 'ice') {
      if (!payload.candidate) return; // end-of-candidates sentinel
      if (this.remoteDescriptionSet) {
        await this.pc.addIceCandidate(payload.candidate).catch(() => {});
      } else {
        this.pendingCandidates.push(payload.candidate);
      }
    }
  }

  private async flushPendingCandidates(): Promise<void> {
    while (this.pendingCandidates.length > 0) {
      const candidate = this.pendingCandidates.shift()!;
      try {
        await this.pc.addIceCandidate(candidate);
      } catch {
        // A stale/duplicate candidate is non-fatal.
      }
    }
  }

  /** Classify the selected ICE candidate pair: same network, direct, or via TURN. */
  async route(): Promise<Route | null> {
    try {
      const stats = await this.pc.getStats();
      let pair: { localCandidateId?: string; remoteCandidateId?: string } | undefined;
      stats.forEach((s) => {
        if (s.type === 'transport' && s.selectedCandidatePairId) pair = stats.get(s.selectedCandidatePairId);
      });
      if (!pair) {
        stats.forEach((s) => {
          if (s.type === 'candidate-pair' && s.state === 'succeeded' && (s.selected || s.nominated)) pair ??= s;
        });
      }
      if (!pair) return null;
      const local = stats.get(pair.localCandidateId ?? '')?.candidateType;
      const remote = stats.get(pair.remoteCandidateId ?? '')?.candidateType;
      if (local === 'relay' || remote === 'relay') return 'turn';
      if (local === 'host' && remote === 'host') return 'lan';
      return 'direct';
    } catch {
      return null;
    }
  }

  get connectionState(): RTCPeerConnectionState {
    return this.pc.connectionState;
  }

  close(): void {
    this.unsubscribeSignal?.();
    this.unsubscribeSignal = null;
    this.channel?.close();
    this.pc.close();
    this.emitter.clear();
  }
}
