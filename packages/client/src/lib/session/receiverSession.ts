/**
 * ReceiverSession — the receiving-side controller.
 *
 * Mirror of SenderSession. Imports the key from the URL fragment, joins the
 * room, and keeps a PeerConnection ready to *answer* the sender's offer. On any
 * interruption (sender left, or the peer connection failed) it spins up a fresh
 * PeerConnection so it's ready to answer the sender's next offer — and because
 * the FileReceiver persists accepted chunks in IndexedDB, the reconnected
 * channel resumes from the gap rather than from zero.
 */
import { importKeyFromFragment } from '../crypto/index.js';
import { SignalingClient } from '../signaling/signalingClient.js';
import { PeerConnection, fetchIceServers } from '../webrtc/index.js';
import { FileReceiver } from '../transfer/index.js';
import type { SessionDeps } from './deps.js';
import type {
  ReceiverState,
  TransferProgress,
  CompletedFile,
} from '../transfer/index.js';
import { Emitter } from '../events.js';

type ReceiverSessionEvents = {
  state: ReceiverState;
  progress: TransferProgress;
  complete: CompletedFile[];
  error: string;
};

/** How long to wait for the peer connection before surfacing an error. */
const CONNECT_TIMEOUT_MS = 30_000;

export class ReceiverSession {
  private readonly emitter = new Emitter<ReceiverSessionEvents>();
  private signaling: SignalingClient | null = null;
  private receiver: FileReceiver | null = null;
  private pc: PeerConnection | null = null;
  private iceServers: RTCIceServer[] = [];
  private roomId: string | null = null;
  private done = false;
  private connectTimer: ReturnType<typeof setTimeout> | null = null;
  private channelOpened = false;

  readonly on = this.emitter.on.bind(this.emitter);

  constructor(
    private readonly signalingUrl: string,
    private readonly deps: SessionDeps = {},
  ) {}

  async start(roomId: string, keyFragment: string): Promise<void> {
    this.roomId = roomId;
    this.emitter.emit('state', 'joining');

    let key: CryptoKey;
    try {
      key = await importKeyFromFragment(keyFragment);
    } catch {
      this.emitter.emit('error', 'Invalid or missing decryption key in link.');
      this.emitter.emit('state', 'error');
      return;
    }

    this.receiver = new FileReceiver(key, {
      onState: (s) => this.emitter.emit('state', s),
      onProgress: (p) => this.emitter.emit('progress', p),
      onComplete: (files) => {
        this.done = true;
        this.emitter.emit('complete', files);
      },
      onError: (m) => this.emitter.emit('error', m),
    });

    this.iceServers = await (this.deps.fetchIce ?? fetchIceServers)(this.signalingUrl);
    this.signaling = this.deps.createSignaling
      ? this.deps.createSignaling(this.signalingUrl)
      : new SignalingClient(this.signalingUrl);
    await this.signaling.connect();

    try {
      await this.signaling.joinRoom(roomId);
    } catch (err) {
      this.emitter.emit('error', (err as Error).message);
      this.emitter.emit('state', 'error');
      return;
    }

    this.emitter.emit('state', 'connecting');
    this.createPeer();

    // If the channel never opens, surface a clear error rather than spinning.
    this.connectTimer = setTimeout(() => {
      if (!this.channelOpened && !this.done) {
        this.emitter.emit(
          'error',
          "Couldn't connect to the sender. They may be on a restrictive network, or have closed the tab — ask them to reopen and try again.",
        );
        this.emitter.emit('state', 'error');
      }
    }, CONNECT_TIMEOUT_MS);

    // If the sender drops and returns, be ready to answer its fresh offer.
    this.signaling.on('peer-left', () => {
      if (!this.done) this.createPeer();
    });
  }

  private createPeer(): void {
    if (!this.signaling || !this.receiver || !this.roomId || this.done) return;
    this.pc?.close();
    const pc = this.deps.createPeer
      ? this.deps.createPeer('receiver', this.roomId, this.signaling, this.iceServers)
      : new PeerConnection('receiver', this.roomId, this.signaling, this.iceServers);
    this.pc = pc;
    pc.on('channel-open', (transport) => {
      this.channelOpened = true;
      if (this.connectTimer) clearTimeout(this.connectTimer);
      this.receiver!.attach(transport);
    });
    pc.on('failed', () => {
      if (!this.done) setTimeout(() => this.createPeer(), 500);
    });
  }

  close(): void {
    if (this.connectTimer) clearTimeout(this.connectTimer);
    this.pc?.close();
    this.signaling?.close();
    this.emitter.clear();
  }
}
