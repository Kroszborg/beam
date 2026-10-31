/**
 * Receiver authentication, two ways.
 *
 * ── Links: `authProof` ────────────────────────────────────────
 * The link carries the full 256-bit key. Before the sender opens a connection
 * to a receiver, the receiver proves it holds that key with
 * HMAC(HKDF(key, "beam auth"), roomId | receiverPeerId). The server routes the
 * proof but can't forge one, so a room id alone (from logs, or by scanning
 * short-code nameplates) gets nobody a connection or any ciphertext.
 *
 * ── Short codes: CPace ────────────────────────────────────────
 * A short code is a low-entropy password, so it can't be the key. Instead the
 * two browsers run CPace (a balanced PAKE, draft-irtf-cfrg-cpace) over the
 * ristretto255 group:
 *
 *   G   = hash_to_curve(code ‖ sid)            sid = room | sender | receiver
 *   Ya  = ya·G (sender)   Yb = yb·G (receiver), exchanged via signaling
 *   K   = ya·Yb = yb·Ya
 *   ISK = SHA-512("beam-isk-v1" ‖ sid ‖ Ya ‖ Yb ‖ K)
 *
 * Someone who doesn't know the code (including the server, which relays the
 * shares) can't compute K, and can't test guesses offline from a transcript:
 * each guess needs a live run against the sender, who allows only a few
 * failures. The receiver proves knowledge first (HMAC(ISK, "receiver")); only
 * then does the sender release the real transfer key, AES-GCM-wrapped under a
 * key derived from ISK — so a wrong code yields nothing at all.
 */
import { ristretto255, ristretto255_hasher } from '@noble/curves/ed25519.js';
import { bytesToNumberLE, equalBytes } from '@noble/curves/utils.js';
import { sha256, sha512 } from '@noble/hashes/sha2.js';
import { hmac } from '@noble/hashes/hmac.js';
import { hkdf } from '@noble/hashes/hkdf.js';
import { randomBytes } from '@noble/hashes/utils.js';
import { bytesToBase64Url, base64UrlToBytes, asBufferSource } from './encoding.js';

const Point = ristretto255.Point;
const DST = 'beam-cpace-ristretto255-v1';
const utf8 = (s: string) => new TextEncoder().encode(s);

/** Length-prefixed concatenation, so field boundaries can't be shifted. */
function lv(...parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((s, p) => s + 4 + p.length, 0);
  const out = new Uint8Array(total);
  const view = new DataView(out.buffer);
  let o = 0;
  for (const p of parts) {
    view.setUint32(o, p.length);
    out.set(p, o + 4);
    o += 4 + p.length;
  }
  return out;
}

export class PakeError extends Error {}

/** Session id binding a PAKE run to one room and one sender/receiver pair. */
export function pakeSid(roomId: string, senderId: string, receiverId: string): string {
  return `${roomId}|${senderId}|${receiverId}`;
}

export interface PakeKeys {
  /** Receiver → sender key confirmation. */
  receiverConfirm: Uint8Array;
  /** Wraps the transfer key (sender → receiver). */
  wrapKey: Uint8Array;
}

export class Cpace {
  private readonly scalar: bigint;
  /** Our public share, sent to the peer. */
  readonly share: Uint8Array;

  constructor(
    password: string,
    private readonly sid: string,
    private readonly role: 'sender' | 'receiver',
  ) {
    const generator = ristretto255_hasher.hashToCurve(lv(utf8(password), utf8(sid)), { DST });
    let y = 0n;
    while (y === 0n) y = Point.Fn.create(bytesToNumberLE(randomBytes(64)));
    this.scalar = y;
    this.share = generator.multiply(y).toBytes();
  }

  /** Combine with the peer's share. Throws PakeError on an invalid share. */
  finish(peerShare: Uint8Array): PakeKeys {
    let peer;
    try {
      peer = Point.fromBytes(peerShare);
    } catch {
      throw new PakeError('Invalid key-exchange message.');
    }
    if (peer.is0()) throw new PakeError('Invalid key-exchange message.');
    const k = peer.multiply(this.scalar);
    if (k.is0()) throw new PakeError('Invalid key-exchange message.');
    const [ya, yb] = this.role === 'sender' ? [this.share, peerShare] : [peerShare, this.share];
    const isk = sha512(lv(utf8('beam-isk-v1'), utf8(this.sid), ya, yb, k.toBytes()));
    return {
      receiverConfirm: hmac(sha256, isk, utf8('beam receiver confirm')),
      wrapKey: hkdf(sha256, isk, undefined, utf8('beam wrap key'), 32),
    };
  }
}

/** Constant-time comparison of a received confirmation. */
export function confirmMatches(expected: Uint8Array, received: string): boolean {
  let given: Uint8Array;
  try {
    given = base64UrlToBytes(received);
  } catch {
    return false;
  }
  return given.length === expected.length && equalBytes(expected, given);
}

/** Wrap the raw transfer key: base64url(iv ‖ AES-GCM ciphertext). */
export async function wrapTransferKey(wrapKey: Uint8Array, rawKey: Uint8Array): Promise<string> {
  const k = await crypto.subtle.importKey('raw', asBufferSource(wrapKey), 'AES-GCM', false, ['encrypt']);
  const iv = randomBytes(12);
  const ct = new Uint8Array(
    await crypto.subtle.encrypt({ name: 'AES-GCM', iv: asBufferSource(iv) }, k, asBufferSource(rawKey)),
  );
  const out = new Uint8Array(iv.length + ct.length);
  out.set(iv);
  out.set(ct, iv.length);
  return bytesToBase64Url(out);
}

/** Unwrap a transfer key; throws PakeError if it doesn't authenticate. */
export async function unwrapTransferKey(wrapKey: Uint8Array, wrapped: string): Promise<Uint8Array> {
  try {
    const data = base64UrlToBytes(wrapped);
    const k = await crypto.subtle.importKey('raw', asBufferSource(wrapKey), 'AES-GCM', false, ['decrypt']);
    const pt = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: asBufferSource(data.subarray(0, 12)) },
      k,
      asBufferSource(data.subarray(12)),
    );
    return new Uint8Array(pt);
  } catch {
    throw new PakeError('Could not unwrap the transfer key.');
  }
}

/** Link receivers' proof that they hold the key (see header). */
export function authProof(rawKey: Uint8Array, roomId: string, receiverId: string): string {
  const authKey = hkdf(sha256, rawKey, undefined, utf8('beam auth'), 32);
  return bytesToBase64Url(hmac(sha256, authKey, utf8(`${roomId}|${receiverId}`)));
}

export function checkAuthProof(rawKey: Uint8Array, roomId: string, receiverId: string, proof: string): boolean {
  const authKey = hkdf(sha256, rawKey, undefined, utf8('beam auth'), 32);
  return confirmMatches(hmac(sha256, authKey, utf8(`${roomId}|${receiverId}`)), proof);
}
