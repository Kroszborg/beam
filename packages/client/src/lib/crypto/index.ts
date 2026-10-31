/**
 * Encryption layer public API.
 *
 * This module knows nothing about WebRTC or files — it only turns bytes into
 * authenticated ciphertext and back, and manages the session key/nonce. That
 * isolation is deliberate: the transport and transfer layers depend on this,
 * never the reverse.
 */
export {
  generateSessionKey,
  exportKeyToFragment,
  importKeyFromFragment,
  importRawKey,
  exportRawKey,
  generateBaseNonce,
} from './keys.js';
export { encryptChunk, decryptChunk, deriveIv } from './cipher.js';
export { bytesToBase64Url, base64UrlToBytes, bytesEqual } from './encoding.js';
export {
  Cpace,
  PakeError,
  pakeSid,
  confirmMatches,
  wrapTransferKey,
  unwrapTransferKey,
  authProof,
  checkAuthProof,
  type PakeKeys,
} from './pake.js';
