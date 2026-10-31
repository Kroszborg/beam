/**
 * ReceiverSession — the receiving-side controller.
 *
 * Starts from a link (key in the URL fragment) or a short code. With a link
 * it proves it holds the key; with a code it runs CPace with the sender and
 * receives the transfer key wrapped under the PAKE key. Meanwhile it keeps a
 * PeerConnection ready to *answer* the sender's offer, which comes once the
 * sender has admitted us. If the sender switches
 * this receiver to the relay, a RelayTransport replaces WebRTC. Either way the
 * FileReceiver is re-attached to each new channel and resumes from its gap.
 *
 * The user picks files and a destination after the (encrypted) file list
 * arrives — `accept()` must be called from that click, because saving straight
 * to disk opens a native picker that requires user activation.
 */
import type { Manifest, SignalPayload } from '@beam/shared';
import {
  Cpace,
  PakeError,
  pakeSid,
  authProof,
  unwrapTransferKey,
  importRawKey,
  base64UrlToBytes,
  bytesToBase64Url,
  type PakeKeys,
} from '../crypto/index.js';
import { parseCode, MAX_CODE_ATTEMPTS } from '../codes.js';
import { SignalingClient } from '../signaling/signalingClient.js';
import { StoreApi } from '../store/storeApi.js';
import { StoreTransport } from '../store/storeTransport.js';
import { PreviewStore } from '../preview/previewStore.js';
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
  /** Previews for the selected files (set once receiving starts). */
  preview: PreviewStore;
  error: string;
};

/** How long to wait for any channel before surfacing an error. */
const CONNECT_TIMEOUT_MS = 40_000;
/** How long a departed sender gets to come back before we use their stored copy. */
const STORE_FALLBACK_MS = 8_000;

/** What the receiver starts from: a share link, or a typed short code. */
export type ReceiveTarget = { roomId: string; keyFragment: string } | { code: string };

const DENIED: Record<string, string> = {
  unauthorized:
    "The sender couldn't verify this link. Make sure you copied all of it, including everything after the #.",
  'wrong-code': `That code doesn't match. Check the words and try again — after ${MAX_CODE_ATTEMPTS} wrong tries it stops working.`,
  'code-disabled': 'This code stopped working after too many wrong tries. Ask the sender for a new one.',
};

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
  /** A channel that opened before we had the key (code flow). */
  private pendingTransport: Transport | null = null;
  private pake: Cpace | null = null;
  private pakeKeys: PakeKeys | null = null;
  private roomId = '';
  /** Downloading the sender's stored copy instead of from the sender. */
  private store: StoreTransport | null = null;
  private storeTimer: ReturnType<typeof setTimeout> | null = null;
  private preview: PreviewStore | null = null;
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

  async start(target: ReceiveTarget): Promise<void> {
    this.setState('joining');

    let rawKey: Uint8Array | null = null;
    let password: string | null = null;
    let nameplate: string | null = null;
    if ('keyFragment' in target) {
      try {
        rawKey = base64UrlToBytes(target.keyFragment);
      } catch {
        rawKey = null;
      }
      if (!rawKey || rawKey.length !== 32) return this.fail('This link is missing its key or the key is invalid.');
    } else {
      const parsed = parseCode(target.code);
      if (!parsed) {
        return this.fail("That isn't a Beam code. It's a number and two words, like 42-tiger-ocean.");
      }
      password = parsed.password;
      nameplate = parsed.nameplate;
    }

    const ice = await (this.deps.fetchIce ?? fetchIceConfig)(this.signalingUrl);
    this.iceServers = ice.iceServers;
    if (this.closed) return;
    const signaling = this.deps.createSignaling
      ? this.deps.createSignaling(this.signalingUrl)
      : new SignalingClient(this.signalingUrl);
    this.signaling = signaling;
    let roomId = 'roomId' in target ? target.roomId : '';
    this.roomId = roomId;
    let selfId: string;
    let ownerPresent = true;
    try {
      await signaling.connect();
      if (this.closed) return signaling.close();
      if (!roomId) roomId = this.roomId = await signaling.resolveCode(nameplate!);
      if (this.closed) return signaling.close();
      const room = await signaling.joinRoom(roomId);
      if (this.closed) return signaling.close();
      this.ownerId = room.ownerId;
      selfId = room.peerId;
      ownerPresent = room.ownerPresent;
    } catch (err) {
      // The room is gone (the sender closed their tab) — but they may have
      // left an encrypted copy on the server.
      if (rawKey && (err as { code?: string }).code === 'room-not-found') {
        await this.useKey(rawKey);
        this.setState('connecting');
        if (await this.tryStore()) return;
      }
      return this.fail((err as Error).message);
    }

    this.setState('connecting');
    if (rawKey && !ownerPresent) {
      await this.useKey(rawKey);
      if (await this.tryStore()) return;
    }
    this.createPeer();

    signaling.on('signal', ({ from, data }) => {
      if (from !== this.ownerId) return;
      void this.onOwnerSignal(data).catch((err: Error) =>
        this.fail(err instanceof PakeError ? DENIED['wrong-code']! : err.message),
      );
    });

    // The sender's socket dropped. Its WebRTC link to us may well be fine, so
    // only note it; if the link is down too, the sender will re-offer when
    // back — or, if they don't, we switch to their stored copy (if any).
    signaling.on('peer-left', ({ peerId }) => {
      if (peerId !== this.ownerId) return;
      if (this.transport?.readyState !== 'open') this.emitter.emit('waiting', true);
      this.scheduleStoreFallback();
    });

    if (rawKey) {
      if (!this.receiver) await this.useKey(rawKey);
      signaling.sendSignal({ kind: 'auth', proof: authProof(rawKey, roomId, selfId) });
    } else {
      this.pake = new Cpace(password!, pakeSid(roomId, this.ownerId!, selfId), 'receiver');
      signaling.sendSignal({ kind: 'pake', step: 1, share: bytesToBase64Url(this.pake.share) });
    }

    this.connectTimer = setTimeout(() => {
      if (this.transport || this.state !== 'connecting') return;
      void this.tryStore().then((stored) => {
        if (!stored && !this.transport) {
          this.fail(
            "Couldn't connect to the sender. They may have closed the tab or be on a restrictive network — ask them to reopen the page and try again.",
          );
        }
      });
    }, CONNECT_TIMEOUT_MS);
  }

  /** If the sender doesn't come back soon, continue from their stored copy. */
  private scheduleStoreFallback(): void {
    if (this.storeTimer || this.store || !this.receiver) return;
    this.storeTimer = setTimeout(() => {
      this.storeTimer = null;
      if (this.isDone() || this.store || this.transport?.readyState === 'open') return;
      void this.tryStore();
    }, this.deps.storeFallbackMs ?? STORE_FALLBACK_MS);
  }

  /** Switch to the server copy if there is a usable one. */
  private async tryStore(): Promise<boolean> {
    if (!this.receiver || this.store || this.isDone() || this.closed) return false;
    const api = this.deps.store ?? new StoreApi(this.signalingUrl);
    const info = await api.info(this.roomId);
    if (!info || info.abandoned || this.store || this.closed) return false;
    if (this.connectTimer) clearTimeout(this.connectTimer);
    this.pc?.close();
    this.pc = null;
    this.relay?.close();
    this.relay = null;
    const store = new StoreTransport(api, this.roomId, (message) => this.fail(message));
    this.store = store;
    this.attach(store);
    this.emitter.emit('route', 'stored');
    return true;
  }

  private async onOwnerSignal(data: SignalPayload): Promise<void> {
    switch (data.kind) {
      case 'relay':
        return this.useRelay();
      case 'denied':
        return this.fail(DENIED[data.reason] ?? DENIED.unauthorized!);
      case 'pake':
        if (data.step !== 2 || !this.pake) return;
        this.pakeKeys = this.pake.finish(base64UrlToBytes(data.share));
        this.pake = null;
        this.signaling?.sendSignal({ kind: 'pake', step: 3, confirm: bytesToBase64Url(this.pakeKeys.receiverConfirm) });
        return;
      case 'key': {
        if (!this.pakeKeys || this.receiver) return;
        const raw = await unwrapTransferKey(this.pakeKeys.wrapKey, data.wrapped);
        this.pakeKeys = null;
        return this.useKey(raw);
      }
    }
  }

  /** We have the transfer key: set up the receiver (and any channel that beat us to it). */
  private async useKey(raw: Uint8Array): Promise<void> {
    const key = await importRawKey(raw);
    if (this.closed) return;
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
      onPlaintext: (fileIndex, offset, data) => this.preview?.push(fileIndex, offset, data),
    });
    const early = this.pendingTransport;
    this.pendingTransport = null;
    if (early && early === this.transport) this.receiver.attach(early);
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
    this.preview?.dispose();
    this.preview = new PreviewStore(files.map((f) => ({ index: f.index, path: f.path, size: f.size, type: f.type })));
    this.emitter.emit('preview', this.preview);
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
      if (this.transport !== transport || this.isDone() || transport === this.store) return;
      this.transport = null;
      this.emitter.emit('waiting', true);
      if (transport === this.relay) this.relay = null;
      // Ready for the sender's next offer (or relay signal) — or their copy.
      this.createPeer();
      this.scheduleStoreFallback();
    });
    if (this.receiver) this.receiver.attach(transport);
    else this.pendingTransport = transport;
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
    if (this.storeTimer) clearTimeout(this.storeTimer);
    this.store?.close();
    this.preview?.dispose();
    this.relay?.close();
    this.pc?.close();
    this.signaling?.close();
    this.emitter.clear();
  }
}
