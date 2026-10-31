/**
 * Transport over the signaling WebSocket — the fallback when no direct WebRTC
 * path exists (strict NATs/firewalls and no TURN server).
 *
 * It carries exactly the same frames and control messages as the DataChannel,
 * and the frames are already AES-GCM encrypted, so the server relays
 * ciphertext. Backpressure uses the WebSocket's bufferedAmount; it has no
 * low-water event, so `drained()` polls briefly.
 */
import { SEND_BUFFER_LOW } from '@beam/shared';
import type { SignalingClient } from '../signaling/signalingClient.js';
import type { ChannelData, Transport } from './transport.js';

const RELAY_MAX_MESSAGE = 64 * 1024;
const POLL_MS = 10;

export class RelayTransport implements Transport {
  private state: RTCDataChannelState = 'open';
  private handler: ((data: ChannelData) => void) | null = null;
  private readonly closeHandlers: (() => void)[] = [];
  private readonly unsubscribe: (() => void)[];

  constructor(
    private readonly signaling: SignalingClient,
    private readonly peerId: string,
  ) {
    this.unsubscribe = [
      signaling.on('relay', ({ from, data }) => {
        if (from === peerId && this.state === 'open') this.handler?.(data);
      }),
      // A dropped socket ends this transport; the session opens a new one after rejoining.
      signaling.on('close', () => this.close()),
    ];
  }

  get readyState(): RTCDataChannelState {
    return this.state;
  }

  get bufferedAmount(): number {
    return this.signaling.bufferedAmount;
  }

  get maxMessageSize(): number {
    return RELAY_MAX_MESSAGE;
  }

  onMessage(handler: (data: ChannelData) => void): void {
    this.handler = handler;
  }

  onClose(handler: () => void): void {
    this.closeHandlers.push(handler);
  }

  send(data: string | ArrayBufferView | ArrayBuffer): void {
    if (this.state !== 'open') return;
    if (!this.signaling.sendRelay(this.peerId, data)) this.close();
  }

  async drained(): Promise<void> {
    while (this.state === 'open' && this.signaling.bufferedAmount > SEND_BUFFER_LOW) {
      await new Promise((r) => setTimeout(r, POLL_MS));
    }
  }

  close(): void {
    if (this.state === 'closed') return;
    this.state = 'closed';
    for (const u of this.unsubscribe) u();
    for (const h of this.closeHandlers) h();
  }
}
