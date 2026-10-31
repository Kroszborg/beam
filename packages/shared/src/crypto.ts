/**
 * Crypto constants shared by both peers. Transfer-layer sizes (chunks, frames,
 * buffers) live in transfer.ts.
 */

/** AES-GCM symmetric key length in bits. */
export const AES_KEY_BITS = 256;

/** AES-GCM IV length in bytes (96-bit IV is the GCM-recommended size). */
export const IV_LENGTH = 12;

/**
 * Per-session random base nonce length in bytes. The 12-byte IV for each
 * chunk is `baseNonce (8 bytes) || chunkIndex (4 bytes, big-endian)`, which
 * guarantees a unique IV per (key, chunk) — a hard requirement for GCM.
 */
export const BASE_NONCE_LENGTH = 8;

/** GCM authentication tag length in bits. */
export const GCM_TAG_BITS = 128;
