/**
 * SenderSession — the sending-side controller.
 *
 * Composes the four layers into one lifecycle:
 *   crypto (session key + nonce) → signaling (room) → webrtc (peer connection)
 *   → transfer (FileSender).
 *
 * Reconnect/resume strategy: WebRTC handshakes are driven entirely by signaling
 * presence. Whenever a receiver appears (`peer-joined`) — whether for the first
 * time or after reconnecting — we (re)negotiate a fresh PeerConnection and the
 * FileSender replays its manifest, after which the receiver asks only for the
 * chunks it still needs. We also renegotiate if the peer connection itself
 * fails. This makes a dropped transfer self-heal without ever restarting from
 * zero.
 */
import {
  generateSessionKey,
  generateBaseNonce,
  exportKeyToFragment,
} from '../crypto/index.js';
import { SignalingClient } from '../signaling/signalingClient.js';
import { PeerConnection, fetchIceServers } from '../webrtc/index.js';
import { FileSender } from '../transfer/index.js';
import type { SenderState, TransferProgress } from '../transfer/index.js';
import { Emitter } from '../events.js';
import type { SessionDeps } from './deps.js';

export interface SenderRoomInfo {
  roomId: string;
  shareUrl: string;
}

/** How long to wait for a peer connection before surfacing an error. */
const CONNECT_TIMEOUT_MS = 30_000;

type SenderSessionEvents = {
  state: SenderState;
  progress: TransferProgress;
  room: SenderRoomInfo;
  error: string;
};

export class SenderSession {
  private readonly emitter = new Emitter<SenderSessionEvents>();
  private signaling: SignalingClient | null = null;
  private sender: FileSender | null = null;
  private pc: PeerConnection | null = null;
  private iceServers: RTCIceServer[] = [];
  private roomId: string | null = null;
  /** Whether a receiver is currently present in the room. */
  private peerPresent = false;

  readonly on = this.emitter.on.bind(this.emitter);

  constructor(
    private readonly signalingUrl: string,
    private readonly appOrigin: string,
    private readonly deps: SessionDeps = {},
  ) {}

  async start(files: File[]): Promise<void> {
    // 1. Keys never leave the browser; the key rides in the URL fragment.
    const key = await generateSessionKey();
    const baseNonce = generateBaseNonce();
    const keyFragment = await exportKeyToFragment(key);

    // 2. Build the manifest (hashing pre-pass) before we even have a peer.
    this.sender = new FileSender(files, key, baseNonce, {
      onState: (s) => this.emitter.emit('state', s),
      onProgress: (p) => this.emitter.emit('progress', p),
      onError: (m) => this.emitter.emit('error', m),
    });
    await this.sender.prepare();

    // 3. ICE config + signaling room.
    this.iceServers = await (this.deps.fetchIce ?? fetchIceServers)(this.signalingUrl);
    this.signaling = this.deps.createSignaling
      ? this.deps.createSignaling(this.signalingUrl)
      : new SignalingClient(this.signalingUrl);
    await this.signaling.connect();
    const { roomId } = await this.signaling.createRoom();
    this.roomId = roomId;

    const shareUrl = `${this.appOrigin}/r/${roomId}#${keyFragment}`;
    this.emitter.emit('room', { roomId, shareUrl });

    // 4. A receiver appearing is the definitive cue to (re)negotiate — works
    //    for the first receiver AND every later one that reuses the same link.
    this.signaling.on('peer-joined', () => {
      this.peerPresent = true;
      void this.negotiate();
    });

    // When a receiver leaves, drop the dead connection and wait. We do NOT
    // auto-offer into an empty room (that used to wedge the next receiver).
    this.signaling.on('peer-left', () => {
      this.peerPresent = false;
      this.pc?.close();
      this.pc = null;
      this.emitter.emit('state', 'waiting');
    });
  }

  /**
   * Tear down any existing connection and start a fresh offer. Called on every
   * `peer-joined`, so each receiver — first or fifth — gets a clean handshake.
   */
  private async negotiate(): Promise<void> {
    if (!this.signaling || !this.sender || !this.roomId) return;

    this.pc?.close();
    const pc = this.deps.createPeer
      ? this.deps.createPeer('sender', this.roomId, this.signaling, this.iceServers)
      : new PeerConnection('sender', this.roomId, this.signaling, this.iceServers);
    this.pc = pc;

    // If the channel never opens, surface a clear error instead of spinning.
    const timeout = setTimeout(() => {
      if (this.pc === pc) {
        this.emitter.emit(
          'error',
          "Couldn't connect to the other device. It may be on a restrictive network — ask them to retry, or try both devices on the same Wi-Fi.",
        );
      }
    }, CONNECT_TIMEOUT_MS);

    pc.on('channel-open', (transport) => {
      clearTimeout(timeout);
      void this.sender!.run(transport);
    });
    // Only retry on failure if a receiver is still around; a fresh peer-joined
    // would re-negotiate anyway. Guard on `this.pc === pc` so a superseded
    // connection never fights the current one.
    const retry = () => {
      if (this.peerPresent && this.pc === pc) {
        setTimeout(() => {
          if (this.peerPresent && this.pc === pc) void this.negotiate();
        }, 800);
      }
    };
    pc.on('failed', retry);

    try {
      await pc.start(); // create data channel + offer
    } catch (err) {
      this.emitter.emit('error', (err as Error).message);
    }
  }

  close(): void {
    this.pc?.close();
    this.signaling?.close();
    this.emitter.clear();
  }
}
