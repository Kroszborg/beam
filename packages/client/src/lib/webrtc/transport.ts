/**
 * The narrow transport contract the transfer layer depends on.
 *
 * DataChannelTransport (WebRTC) and RelayTransport (WebSocket fallback through
 * the server) satisfy it, and so does an in-memory pair in tests — which lets
 * the whole protocol (seal → frame → send → reassemble → decrypt → sink, plus
 * resume and flow control) run without a browser.
 */
export type ChannelData = string | ArrayBuffer;

export interface Transport {
  readonly readyState: RTCDataChannelState;
  /** Bytes queued locally and not yet handed to the network. */
  readonly bufferedAmount: number;
  /** Largest single message the peer accepts (0 if unknown). */
  readonly maxMessageSize: number;
  onMessage(handler: (data: ChannelData) => void): void;
  onClose(handler: () => void): void;
  send(data: string | ArrayBufferView | ArrayBuffer): void;
  /** Resolves once the send buffer has drained to the low-water mark (or the channel closed). */
  drained(): Promise<void>;
}
