/**
 * ReceiverSession — the receiving-side controller.
 *
 * Imports the key from the URL fragment, joins the room, and keeps a
 * PeerConnection ready to *answer* the sender's offer. If the sender switches
 * this receiver to the relay, a RelayTransport replaces WebRTC. Either way the
 * FileReceiver is re-attached to each new channel and resumes from its gap.
 *
 * The user picks files and a destination after the (encrypted) file list
 * arrives — `accept()` must be called from that click, because saving straight
 * to disk opens a native picker that requires user activation.
 */
import type { Manifest } from '@beam/shared';
import { importKeyFromFragment } from '../crypto/index.js';
import { SignalingClient } from '../signaling/signalingClient.js';
import {
  PeerConnection,
  RelayTransport,
  fetchIceConfig,
  type Route,
  type Transport,
} from '../webrtc/index.js';
import { FileReceiver, TransferLayout, chooseSink } from '../transfer/index.js';
import type {
  ReceiverState,
  SinkKind,
  TransferProgress,
  CompletedFile,
} from '../transfer/index.js';
import { Emitter } from '../events.js';
import type { SessionDeps } from './deps.js';

type ReceiverSessionEvents = {
  state: ReceiverState;
  manifest: Manifest;
  progress: TransferProgress;
  route: Route | null;
  /** Files to save by hand (fallback storage), or null when already on disk. */
  complete: CompletedFile[] | null;
  /** The sender's connection dropped; we're waiting for it to come back. */
  waiting: boolean;
  error: string;
};

/** How long to wait for any channel before surfacing an error. */
const CONNECT_TIMEOUT_MS = 40_000;

export class ReceiverSession {
  private readonly emitter = new Emitter<ReceiverSessionEvents>();
  private signaling: SignalingClient | null = null;
  private receiver: FileReceiver | null = null;
  private pc: PeerConnection | null = null;
  private relay: RelayTransport | null = null;
  private transport: Transport | null = null;
  private iceServers: RTCIceServer[] = [];
  private ownerId: string | null = null;
  private manifest: Manifest | null = null;
  private state: ReceiverState = 'idle';
  private connectTimer: ReturnType<typeof setTimeout> | null = null;
  /** Set by close(); start() checks it after every await so a session torn
   *  down mid-start (e.g. React StrictMode remount) never joins the room. */
  private closed = false;

  readonly on = this.emitter.on.bind(this.emitter);

  constructor(
    private readonly signalingUrl: string,
    private readonly deps: SessionDeps = {},
  ) {}

  private setState(state: ReceiverState): void {
    this.state = state;
    this.emitter.emit('state', state);
  }

  async start(roomId: string, keyFragment: string): Promise<void> {
    this.setState('joining');

    let key: CryptoKey;
    try {
      key = await importKeyFromFragment(keyFragment);
    } catch {
      return this.fail('This link is missing its key or the key is invalid.');
    }

    this.receiver = new FileReceiver(key, {
      onState: (s) => this.setState(s),
      onManifest: (m) => {
        this.manifest = m;
        this.emitter.emit('manifest', m);
      },
      onProgress: (p) => this.emitter.emit('progress', p),
      onComplete: (files) => {
        this.closeConnections();
        this.emitter.emit('complete', files);
      },
      onError: (m) => this.emitter.emit('error', m),
    });

    const ice = await (this.deps.fetchIce ?? fetchIceConfig)(this.signalingUrl);
    this.iceServers = ice.iceServers;
    if (this.closed) return;
    const signaling = this.deps.createSignaling
      ? this.deps.createSignaling(this.signalingUrl)
      : new SignalingClient(this.signalingUrl);
    this.signaling = signaling;
    try {
      await signaling.connect();
      if (this.closed) return signaling.close();
      const room = await signaling.joinRoom(roomId);
      if (this.closed) return signaling.close();
      this.ownerId = room.ownerId;
    } catch (err) {
      return this.fail((err as Error).message);
    }

    this.setState('connecting');
    this.createPeer();

    signaling.on('signal', ({ from, data }) => {
      if (from === this.ownerId && data.kind === 'relay') this.useRelay();
    });

    // The sender's socket dropped. Its WebRTC link to us may well be fine, so
    // only note it; if the link is down too, the sender will re-offer when back.
    signaling.on('peer-left', ({ peerId }) => {
      if (peerId !== this.ownerId) return;
      if (this.transport?.readyState !== 'open') this.emitter.emit('waiting', true);
    });

    this.connectTimer = setTimeout(() => {
      if (!this.transport && this.state === 'connecting') {
        this.fail(
          "Couldn't connect to the sender. They may have closed the tab or be on a restrictive network — ask them to reopen the page and try again.",
        );
      }
    }, CONNECT_TIMEOUT_MS);
  }

  /**
   * Begin receiving `fileIndices`, saving via `sink`. Call directly from the
   * click handler: the fs sink opens its picker before anything is awaited.
   */
  async accept(fileIndices: number[], sink: SinkKind): Promise<void> {
    const manifest = this.manifest;
    if (!manifest || !this.receiver) return;
    const layout = new TransferLayout(manifest.files, manifest.chunkSize);
    const files = fileIndices.map((index) => ({ index, ...manifest.files[index]! }));
    const ranges = new Map(fileIndices.map((i) => [i, layout.range(i)] as const));
    const picked = await (this.deps.chooseSink ?? chooseSink)(sink, manifest.transferId, files, ranges);
    await this.receiver.accept(fileIndices, picked);
  }

  private createPeer(): void {
    if (!this.signaling || !this.ownerId || this.relay) return;
    this.pc?.close();
    const pc = this.deps.createPeer
      ? this.deps.createPeer('receiver', this.ownerId, this.signaling, this.iceServers)
      : new PeerConnection('receiver', this.ownerId, this.signaling, this.iceServers);
    this.pc = pc;
    pc.on('channel-open', (transport) => {
      if (this.pc !== pc) return;
      this.attach(transport);
      void pc.route().then((route) => {
        if (this.pc === pc) this.emitter.emit('route', route);
      });
    });
    // Be ready to answer the sender's next offer.
    pc.on('failed', () => {
      if (this.pc === pc && !this.relay && !this.isDone()) this.createPeer();
    });
    // The sender restarted the handshake (its side of the channel dropped
    // first): answer on a fresh connection.
    pc.on('new-offer', (offer) => {
      if (this.pc !== pc || this.relay || this.isDone()) return;
      this.createPeer();
      void this.pc?.handleSignal(offer);
    });
  }

  private useRelay(): void {
    if (!this.signaling || !this.ownerId || this.isDone()) return;
    this.pc?.close();
    this.pc = null;
    this.relay?.close();
    const relay = new RelayTransport(this.signaling, this.ownerId);
    this.relay = relay;
    this.attach(relay);
    this.emitter.emit('route', 'relay');
  }

  private attach(transport: Transport): void {
    if (this.connectTimer) clearTimeout(this.connectTimer);
    this.transport = transport;
    this.emitter.emit('waiting', false);
    transport.onClose(() => {
      if (this.transport !== transport || this.isDone()) return;
      this.transport = null;
      this.emitter.emit('waiting', true);
      if (transport === this.relay) this.relay = null;
      // Ready for the sender's next offer (or relay signal).
      this.createPeer();
    });
    this.receiver!.attach(transport);
  }

  private isDone(): boolean {
    return this.state === 'complete' || this.state === 'error';
  }

  private fail(message: string): void {
    this.emitter.emit('error', message);
    this.setState('error');
  }

  private closeConnections(): void {
    if (this.connectTimer) clearTimeout(this.connectTimer);
    // Give the final ack/complete messages a moment to flush.
    const pc = this.pc;
    const relay = this.relay;
    const signaling = this.signaling;
    setTimeout(() => {
      relay?.close();
      pc?.close();
      signaling?.close();
    }, 1500);
  }

  /** Abort an in-progress transfer (e.g. user pressed cancel). */
  async cancel(): Promise<void> {
    await this.receiver?.cancel();
  }

  close(): void {
    this.closed = true;
    if (this.connectTimer) clearTimeout(this.connectTimer);
    this.relay?.close();
    this.pc?.close();
    this.signaling?.close();
    this.emitter.clear();
  }
}
