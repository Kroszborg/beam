/**
 * Session key management.
 *
 * The whole security model rests on one rule: **the AES key never reaches the
 * backend.** It is generated in the sender's browser, exported into the share
 * link's URL *fragment* (everything after `#`), and re-imported in the
 * receiver's browser. Browsers never transmit the fragment to a server, so the
 * signaling backend only ever sees the room id.
 *
 *   https://beam.app/r/abc123#<base64url-key>
 *                      └─room┘ └────key────┘
 *                      server    client-only
 */
import { AES_KEY_BITS } from '@beam/shared';
import { bytesToBase64Url, base64UrlToBytes, asBufferSource } from './encoding.js';

const ALGORITHM = 'AES-GCM';

/** Generate a fresh, extractable AES-256-GCM session key. */
export async function generateSessionKey(): Promise<CryptoKey> {
  return crypto.subtle.generateKey(
    { name: ALGORITHM, length: AES_KEY_BITS },
    true, // extractable — we must export it into the URL fragment
    ['encrypt', 'decrypt'],
  );
}

/** Export a key to the base64url string carried in the URL fragment. */
export async function exportKeyToFragment(key: CryptoKey): Promise<string> {
  const raw = await crypto.subtle.exportKey('raw', key);
  return bytesToBase64Url(new Uint8Array(raw));
}

/** Re-import a key from the base64url fragment value. */
export async function importKeyFromFragment(value: string): Promise<CryptoKey> {
  const raw = base64UrlToBytes(value);
  return crypto.subtle.importKey('raw', asBufferSource(raw), { name: ALGORITHM }, true, [
    'encrypt',
    'decrypt',
  ]);
}

/** Raw key bytes (for receiver authentication and PAKE key wrapping). */
export async function exportRawKey(key: CryptoKey): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.exportKey('raw', key));
}

export async function importRawKey(raw: Uint8Array): Promise<CryptoKey> {
  return crypto.subtle.importKey('raw', asBufferSource(raw), { name: ALGORITHM }, true, ['encrypt', 'decrypt']);
}

/** A random per-session base nonce (8 bytes) used to derive chunk IVs. */
export function generateBaseNonce(): Uint8Array {
  const nonce = new Uint8Array(8);
  crypto.getRandomValues(nonce);
  return nonce;
}
