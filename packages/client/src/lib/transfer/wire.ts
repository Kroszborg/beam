/**
 * Wire framing (protocol v2): encrypted messages ⇄ DataChannel frames.
 *
 * An encrypted chunk (≈1 MiB) is larger than one SCTP message may be, so it
 * is cut into frames of at most `frameSize` bytes, each with a 12-byte header
 * (see FRAME_HEADER_BYTES in @beam/shared). The channel is ordered, so frames
 * of one message arrive contiguously; the reassembler copies each payload
 * straight into a buffer preallocated from the header's `total`, which keeps
 * the receive path to a single copy.
 */
import {
  FRAME_HEADER_BYTES,
  PROTOCOL_VERSION,
} from '@beam/shared';

export interface WireMessage {
  kind: number;
  index: number;
  payload: Uint8Array;
}

/** Split one encrypted message into ready-to-send frames. */
export function* frames(
  kind: number,
  index: number,
  payload: Uint8Array,
  frameSize: number,
): Generator<Uint8Array> {
  const body = frameSize - FRAME_HEADER_BYTES;
  const total = payload.length;
  let offset = 0;
  do {
    const n = Math.min(body, total - offset);
    const frame = new Uint8Array(FRAME_HEADER_BYTES + n);
    const v = new DataView(frame.buffer);
    v.setUint8(0, kind);
    v.setUint8(1, PROTOCOL_VERSION);
    v.setUint32(4, index, false);
    v.setUint32(8, total, false);
    frame.set(payload.subarray(offset, offset + n), FRAME_HEADER_BYTES);
    yield frame;
    offset += n;
  } while (offset < total);
}

export class WireError extends Error {}

/**
 * Rebuilds messages from frames. A frame that doesn't continue the message in
 * progress (e.g. the sender restarted after a reconnect) discards the partial
 * message — the receiver will re-request it.
 */
export class Reassembler {
  private kind = 0;
  private index = -1;
  private buf: Uint8Array | null = null;
  private filled = 0;

  constructor(private readonly maxMessageBytes: number) {}

  push(frame: ArrayBuffer): WireMessage | null {
    if (frame.byteLength < FRAME_HEADER_BYTES) throw new WireError('short frame');
    const v = new DataView(frame);
    const kind = v.getUint8(0);
    const version = v.getUint8(1);
    if (version !== PROTOCOL_VERSION) {
      throw new WireError(`peer speaks protocol v${version}, expected v${PROTOCOL_VERSION}`);
    }
    const index = v.getUint32(4, false);
    const total = v.getUint32(8, false);
    if (total > this.maxMessageBytes) throw new WireError('message too large');
    const payload = new Uint8Array(frame, FRAME_HEADER_BYTES);

    const continues =
      this.buf !== null && kind === this.kind && index === this.index && this.buf.length === total;
    if (!continues) {
      this.kind = kind;
      this.index = index;
      this.buf = new Uint8Array(total);
      this.filled = 0;
    }
    if (this.filled + payload.length > total) throw new WireError('frame overflow');
    this.buf!.set(payload, this.filled);
    this.filled += payload.length;

    if (this.filled < total) return null;
    const message = { kind, index, payload: this.buf! };
    this.buf = null;
    return message;
  }

  /** Forget any partial message (new channel). */
  reset(): void {
    this.buf = null;
    this.filled = 0;
  }
}
