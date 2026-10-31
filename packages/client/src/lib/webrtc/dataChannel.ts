/**
 * A thin wrapper around RTCDataChannel that the transfer layer talks to.
 *
 * It adds what the raw channel lacks for high-throughput transfer:
 *
 *   1. A typed message surface (string control messages vs binary frames).
 *   2. Backpressure: `drained()` resolves on the `bufferedamountlow` event at
 *      SEND_BUFFER_LOW. The sender fills up to SEND_BUFFER_HIGH between
 *      wakeups, so it pays one event-loop round trip per few MB rather than
 *      per frame — the difference between ~7 MB/s and line speed.
 *   3. The peer's SCTP max-message-size, which sets the frame size.
 *
 * The wrapper is transport-only — it has no notion of chunks, encryption, or
 * files.
 */
import { SEND_BUFFER_LOW } from '@beam/shared';
import type { Transport, ChannelData } from './transport.js';

export class DataChannelTransport implements Transport {
  private closeHandlers: (() => void)[] = [];

  constructor(
    private readonly channel: RTCDataChannel,
    private readonly sctp: RTCSctpTransport | null = null,
  ) {
    channel.binaryType = 'arraybuffer';
    channel.bufferedAmountLowThreshold = SEND_BUFFER_LOW;
    channel.addEventListener('close', () => {
      for (const h of this.closeHandlers) h();
    });
  }

  get readyState(): RTCDataChannelState {
    return this.channel.readyState;
  }

  get bufferedAmount(): number {
    return this.channel.bufferedAmount;
  }

  get maxMessageSize(): number {
    return this.sctp?.maxMessageSize ?? 0;
  }

  onMessage(handler: (data: ChannelData) => void): void {
    this.channel.onmessage = (event) => handler(event.data as ChannelData);
  }

  onClose(handler: () => void): void {
    this.closeHandlers.push(handler);
  }

  send(data: string | ArrayBufferView | ArrayBuffer): void {
    // Overloads of RTCDataChannel.send accept all of these; cast to satisfy TS.
    this.channel.send(data as ArrayBuffer);
  }

  drained(): Promise<void> {
    if (this.channel.bufferedAmount <= this.channel.bufferedAmountLowThreshold || this.channel.readyState !== 'open') {
      return Promise.resolve();
    }
    return new Promise((resolve) => {
      const done = () => {
        this.channel.removeEventListener('bufferedamountlow', done);
        this.channel.removeEventListener('close', done);
        resolve();
      };
      this.channel.addEventListener('bufferedamountlow', done);
      this.channel.addEventListener('close', done);
    });
  }

  close(): void {
    this.channel.close();
  }
}
