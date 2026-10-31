/**
 * SenderSession — the sending-side controller.
 *
 * Composes the layers into one lifecycle:
 *   crypto (link key + nonce) → signaling (room) → per-receiver connection
 *   (WebRTC, or the relay fallback) → transfer (one FileSender, one Upload per
 *   receiver).
 *
 * The link is ready as soon as the room exists — there's no hashing pre-pass —
 * and several receivers can use it at once, each with its own connection,
 * progress and resume state.
 *
 * Connection strategy per receiver: offer WebRTC; if no data channel opens
 * within RELAY_AFTER_MS (or ICE fails) and the server offers a relay, switch
 * that receiver to the encrypted WebSocket relay. Connections that are still
 * healthy are never torn down because of a signaling blip — the WebRTC link
 * doesn't need the server once it's up.
 */
import {
  generateSessionKey,
  generateBaseNonce,
  exportKeyToFragment,
} from '../crypto/index.js';
import { SignalingClient } from '../signaling/signalingClient.js';
import {
  PeerConnection,
  RelayTransport,
  fetchIceConfig,
  type IceConfig,
  type Route,
  type Transport,
} from '../webrtc/index.js';
import { FileSender, type Upload } from '../transfer/index.js';
import type { TransferProgress, UploadState } from '../transfer/index.js';
import { Emitter } from '../events.js';
import type { SessionDeps } from './deps.js';

export interface SenderRoomInfo {
  roomId: string;
  shareUrl: string;
}

export type SenderPhase = 'idle' | 'preparing' | 'waiting' | 'active' | 'error';

/** What the sender's UI shows for each receiver. */
export interface ReceiverStatus {
  id: string;
  /** Joined order, for stable display ("Receiver 2"). */
  ordinal: number;
  state: 'connecting' | UploadState | 'left';
  route: Route | null;
  progress: TransferProgress | null;
  error: string | null;
}

/** Fall back to the relay if WebRTC hasn't opened a channel by then. */
const RELAY_AFTER_MS = 10_000;
/** Give up on a receiver that can't be reached at all. */
const CONNECT_TIMEOUT_MS = 30_000;

type SenderSessionEvents = {
  phase: SenderPhase;
  room: SenderRoomInfo;
  receivers: ReceiverStatus[];
  error: string;
};

interface Entry {
  status: ReceiverStatus;
  pc: PeerConnection | null;
  transport: Transport | null;
  upload: Upload | null;
  timers: ReturnType<typeof setTimeout>[];
}

export class SenderSession {
  private readonly emitter = new Emitter<SenderSessionEvents>();
  private signaling: SignalingClient | null = null;
  private sender: FileSender | null = null;
  private ice: IceConfig = { iceServers: [], relay: false };
  private readonly entries = new Map<string, Entry>();
  private ordinal = 0;
  private closed = false;

  readonly on = this.emitter.on.bind(this.emitter);

  constructor(
    private readonly signalingUrl: string,
    private readonly appOrigin: string,
    private readonly deps: SessionDeps = {},
  ) {}

  async start(files: File[]): Promise<void> {
    this.emitter.emit('phase', 'preparing');
    // Keys never leave the browser; the key rides in the URL fragment.
    const key = await generateSessionKey();
    const keyFragment = await exportKeyToFragment(key);
    this.sender = new FileSender(files, key, generateBaseNonce());

    this.ice = await (this.deps.fetchIce ?? fetchIceConfig)(this.signalingUrl);
    if (this.closed) return;
    const signaling = this.deps.createSignaling
      ? this.deps.createSignaling(this.signalingUrl)
      : new SignalingClient(this.signalingUrl);
    this.signaling = signaling;
    await signaling.connect();
    const { roomId } = await signaling.createRoom();
    if (this.closed) return;

    this.emitter.emit('room', { roomId, shareUrl: `${this.appOrigin}/r/${roomId}#${keyFragment}` });
    this.emitter.emit('phase', 'waiting');

    signaling.on('peer-joined', ({ peerId }) => {
      const entry = this.entries.get(peerId);
      // A receiver that only lost its signaling socket keeps its connection.
      if (entry && this.healthy(entry)) return;
      this.connect(peerId);
    });

    signaling.on('peer-left', ({ peerId }) => {
      const entry = this.entries.get(peerId);
      if (!entry) return;
      if (entry.status.route !== 'relay' && this.healthy(entry)) return;
      this.drop(entry, 'left');
    });

    // Back on the server after a blip: forget receivers that are gone and
    // reopen relay tunnels (they ran over the socket that just dropped).
    signaling.on('rejoined', ({ members }) => {
      const present = new Set(members);
      for (const entry of this.entries.values()) {
        if (entry.status.state === 'left' || entry.status.state === 'complete') continue;
        if (!present.has(entry.status.id)) this.drop(entry, 'left');
        else if (entry.status.route === 'relay') this.useRelay(entry);
      }
    });
  }

  /** Current receivers, oldest first. */
  get receivers(): ReceiverStatus[] {
    return [...this.entries.values()].map((e) => ({ ...e.status }));
  }

  private emitReceivers(): void {
    this.emitter.emit('receivers', this.receivers);
    const active = [...this.entries.values()].some((e) => e.status.state !== 'left');
    this.emitter.emit('phase', active ? 'active' : 'waiting');
  }

  private update(entry: Entry, patch: Partial<ReceiverStatus>): void {
    Object.assign(entry.status, patch);
    this.emitReceivers();
  }

  private healthy(entry: Entry): boolean {
    return entry.transport?.readyState === 'open';
  }

  /** (Re)connect to a receiver: fresh WebRTC offer, relay as fallback. */
  private connect(peerId: string): void {
    if (!this.signaling || !this.sender) return;
    let entry = this.entries.get(peerId);
    if (entry) this.teardown(entry);
    else {
      entry = {
        status: { id: peerId, ordinal: ++this.ordinal, state: 'connecting', route: null, progress: null, error: null },
        pc: null,
        transport: null,
        upload: null,
        timers: [],
      };
      this.entries.set(peerId, entry);
    }
    const e = entry;
    this.update(e, { state: 'connecting', route: null, error: null });
    if (this.deps.forceRelay && this.ice.relay) return this.useRelay(e);

    const pc = this.deps.createPeer
      ? this.deps.createPeer('sender', peerId, this.signaling, this.ice.iceServers)
      : new PeerConnection('sender', peerId, this.signaling, this.ice.iceServers);
    e.pc = pc;

    pc.on('channel-open', (transport) => {
      if (e.pc !== pc || e.status.route === 'relay') return;
      this.clearTimers(e);
      this.serve(e, transport, null);
      void pc.route().then((route) => {
        if (e.pc === pc && route) this.update(e, { route });
      });
    });
    pc.on('failed', () => {
      if (e.pc !== pc || this.healthy(e)) return;
      if (this.ice.relay) this.useRelay(e);
      else this.update(e, { state: 'error', error: unreachable });
    });

    const relayAfter = this.deps.relayAfterMs ?? RELAY_AFTER_MS;
    if (this.ice.relay) {
      e.timers.push(setTimeout(() => {
        if (e.pc === pc && !this.healthy(e)) this.useRelay(e);
      }, relayAfter));
    }
    e.timers.push(setTimeout(() => {
      if (!this.healthy(e) && e.status.state === 'connecting') this.update(e, { state: 'error', error: unreachable });
    }, CONNECT_TIMEOUT_MS));

    void pc.start().catch((err: Error) => this.update(e, { state: 'error', error: err.message }));
  }

  /** Tunnel this receiver's transfer through the server instead of WebRTC. */
  private useRelay(entry: Entry): void {
    if (!this.signaling) return;
    entry.pc?.close();
    entry.pc = null;
    entry.upload?.stop();
    this.signaling.sendSignal({ kind: 'relay' }, entry.status.id);
    this.serve(entry, new RelayTransport(this.signaling, entry.status.id), 'relay');
  }

  private serve(entry: Entry, transport: Transport, route: Route | null): void {
    entry.upload?.stop();
    entry.transport = transport;
    this.update(entry, { route, state: 'connected' });
    entry.upload = this.sender!.serve(transport, {
      onState: (state) => this.update(entry, { state }),
      onProgress: (progress) => this.update(entry, { progress }),
      onError: (error) => this.update(entry, { error }),
    });
    transport.onClose(() => {
      if (entry.transport !== transport) return;
      entry.transport = null;
      if (entry.status.state === 'complete' || entry.status.state === 'left') return;
      // WebRTC dropped mid-transfer: renegotiate; the receiver resumes from its gap.
      if (route !== 'relay' && this.signaling?.connected) this.connect(entry.status.id);
      else this.update(entry, { state: 'connecting' });
    });
  }

  private drop(entry: Entry, state: 'left'): void {
    this.teardown(entry);
    if (entry.status.state === 'complete') return this.emitReceivers();
    this.update(entry, { state });
  }

  private teardown(entry: Entry): void {
    this.clearTimers(entry);
    entry.upload?.stop();
    entry.upload = null;
    const t = entry.transport;
    entry.transport = null;
    if (t instanceof RelayTransport) t.close();
    entry.pc?.close();
    entry.pc = null;
  }

  private clearTimers(entry: Entry): void {
    for (const t of entry.timers) clearTimeout(t);
    entry.timers = [];
  }

  close(): void {
    this.closed = true;
    for (const entry of this.entries.values()) this.teardown(entry);
    this.signaling?.close();
    this.emitter.clear();
  }
}

const unreachable =
  "Couldn't connect to this device. It may be on a restrictive network — ask them to retry, or try both devices on the same Wi-Fi.";
