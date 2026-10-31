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
 * Admission: the sender only connects to a receiver that proves it may
 * receive — an HMAC over the link key (`auth`), or a successful CPace run on
 * the short code (`pake`), after which the transfer key is handed over
 * wrapped. Unproven peers get nothing, not even ciphertext.
 *
 * Connection strategy per receiver: offer WebRTC; if no data channel opens
 * within RELAY_AFTER_MS (or ICE fails) and the server offers a relay, switch
 * that receiver to the encrypted WebSocket relay. Connections that are still
 * healthy are never torn down because of a signaling blip — the WebRTC link
 * doesn't need the server once it's up.
 */
import type { SignalPayload, StoreLimits } from '@beam/shared';
import {
  generateSessionKey,
  generateBaseNonce,
  exportKeyToFragment,
  exportRawKey,
  Cpace,
  pakeSid,
  confirmMatches,
  wrapTransferKey,
  checkAuthProof,
  base64UrlToBytes,
  bytesToBase64Url,
  type PakeKeys,
} from '../crypto/index.js';
import { MAX_CODE_ATTEMPTS, randomWords } from '../codes.js';
import { StoreApi } from '../store/storeApi.js';
import { StoreUploader, type CopyStatus } from '../store/storeUploader.js';
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
  /** Set when the server can keep an encrypted copy (store-and-forward). */
  storeLimits?: StoreLimits;
}

/** The short code shown to the sender, if one was made. */
export interface SenderCode {
  code: string;
  /** Wrong guesses still allowed before the code stops working. */
  attemptsLeft: number;
  disabled: boolean;
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
  code: SenderCode;
  copy: CopyStatus;
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
  private rawKey: Uint8Array = new Uint8Array();
  private roomId = '';
  private peerId = '';
  /** Receivers that proved they may receive (auth proof or PAKE). */
  private readonly admitted = new Set<string>();
  /** In-flight PAKE runs, by receiver. */
  private readonly pakes = new Map<string, PakeKeys>();
  private code: { password: string; used: number; disabled: boolean } | null = null;
  private uploader: StoreUploader | null = null;

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
    this.rawKey = await exportRawKey(key);
    this.sender = new FileSender(files, key, generateBaseNonce());

    this.ice = await (this.deps.fetchIce ?? fetchIceConfig)(this.signalingUrl);
    if (this.closed) return;
    const signaling = this.deps.createSignaling
      ? this.deps.createSignaling(this.signalingUrl)
      : new SignalingClient(this.signalingUrl);
    this.signaling = signaling;
    await signaling.connect();
    const { roomId, peerId } = await signaling.createRoom();
    if (this.closed) return;
    this.roomId = roomId;
    this.peerId = peerId;

    this.emitter.emit('room', {
      roomId,
      shareUrl: `${this.appOrigin}/r/${roomId}#${keyFragment}`,
      ...(this.ice.store ? { storeLimits: this.ice.store } : {}),
    });
    this.emitter.emit('phase', 'waiting');

    // A receiver is connected once it proves itself (see onPeerSignal). After a
    // signaling blip it's announced again: reconnect only if its link is down.
    signaling.on('peer-joined', ({ peerId }) => {
      if (!this.admitted.has(peerId)) return;
      const entry = this.entries.get(peerId);
      if (entry && (this.healthy(entry) || entry.status.state === 'connecting')) return;
      this.connect(peerId);
    });

    signaling.on('signal', ({ from, data }) => {
      void this.onPeerSignal(from, data).catch(() => this.deny(from, 'unauthorized'));
    });

    signaling.on('peer-left', ({ peerId }) => {
      this.pakes.delete(peerId);
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

  /**
   * Make (or replace) a short code for this transfer. The server only learns
   * the number; the words are generated here and never sent anywhere.
   */
  async createCode(): Promise<void> {
    if (!this.signaling) return;
    const nameplate = await this.signaling.createCode();
    this.code = { password: `${nameplate}-${randomWords()}`, used: 0, disabled: false };
    this.emitCode();
  }

  /**
   * Upload an encrypted copy so receivers can download after this tab is
   * closed (store-and-forward). Receivers can start on it right away; the
   * link stays the same.
   */
  keepCopy(): void {
    if (!this.sender || !this.signaling || this.uploader) return;
    const token = this.signaling.token;
    if (!token) throw new Error('Not connected to the Beam server yet.');
    const api = this.deps.store ?? new StoreApi(this.signalingUrl);
    this.uploader = new StoreUploader(api, this.sender, { roomId: this.roomId, peerId: this.peerId, token }, (s) =>
      this.emitter.emit('copy', s),
    );
    void this.uploader.run();
  }

  /** Stop uploading the copy and delete it from the server. */
  async removeCopy(): Promise<void> {
    const uploader = this.uploader;
    this.uploader = null;
    await uploader?.remove();
  }

  private emitCode(): void {
    if (!this.code) return;
    this.emitter.emit('code', {
      code: this.code.password,
      attemptsLeft: Math.max(0, MAX_CODE_ATTEMPTS - this.code.used),
      disabled: this.code.disabled,
    });
  }

  private async onPeerSignal(from: string, data: SignalPayload): Promise<void> {
    if (data.kind === 'auth') {
      if (checkAuthProof(this.rawKey, this.roomId, from, data.proof)) this.admit(from);
      else this.deny(from, 'unauthorized');
      return;
    }
    if (data.kind !== 'pake') return;
    const code = this.code;

    if (data.step === 1) {
      if (!code || code.disabled || code.used >= MAX_CODE_ATTEMPTS) return this.deny(from, 'code-disabled');
      // Every run counts as an attempt until it succeeds, so parallel or
      // abandoned runs can't buy extra guesses.
      code.used += 1;
      this.emitCode();
      const pake = new Cpace(code.password, pakeSid(this.roomId, this.peerId, from), 'sender');
      this.pakes.set(from, pake.finish(base64UrlToBytes(data.share)));
      this.signaling?.sendSignal({ kind: 'pake', step: 2, share: bytesToBase64Url(pake.share) }, from);
      return;
    }

    if (data.step === 3) {
      const keys = this.pakes.get(from);
      this.pakes.delete(from);
      if (!keys || !code) return;
      if (!confirmMatches(keys.receiverConfirm, data.confirm)) {
        if (code.used >= MAX_CODE_ATTEMPTS) code.disabled = true;
        this.emitCode();
        return this.deny(from, code.disabled ? 'code-disabled' : 'wrong-code');
      }
      code.used -= 1; // refund: this attempt was the real receiver
      this.emitCode();
      const wrapped = await wrapTransferKey(keys.wrapKey, this.rawKey);
      this.signaling?.sendSignal({ kind: 'key', wrapped }, from);
      this.admit(from);
    }
  }

  private admit(peerId: string): void {
    if (this.admitted.has(peerId)) return;
    this.admitted.add(peerId);
    this.connect(peerId);
  }

  private deny(peerId: string, reason: 'unauthorized' | 'wrong-code' | 'code-disabled'): void {
    this.signaling?.sendSignal({ kind: 'denied', reason }, peerId);
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
