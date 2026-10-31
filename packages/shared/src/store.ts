/**
 * Store-and-forward (opt-in): the sender may leave an encrypted copy of a
 * transfer on the server, so receivers can download after the sender's tab is
 * closed — or while the upload is still running.
 *
 * The server stores exactly what would have crossed the data channel: the
 * sealed manifest and each AES-GCM chunk. It never has the key. Copies expire
 * after a TTL and are bounded per transfer and in total.
 *
 *   POST   /store                    create (proves room ownership) → upload token
 *   PUT    /store/:id/manifest       sealed manifest      (Bearer upload token)
 *   PUT    /store/:id/chunks/:index  one encrypted chunk  (Bearer upload token)
 *   POST   /store/:id/complete       all chunks uploaded  (Bearer upload token)
 *   DELETE /store/:id                remove the copy      (Bearer upload token)
 *   GET    /store/:id                StoreInfo
 *   GET    /store/:id/manifest       sealed manifest (404 until uploaded)
 *   GET    /store/:id/chunks/:index  chunk; `?wait=1` long-polls up to ~25 s
 *                                    and answers 204 if it's still not there
 *
 * The store id is the room id, so the share link doesn't change.
 */

export interface StoreCreateRequest {
  roomId: string;
  /** The sender's peer id and rejoin token — proof it owns the room. */
  peerId: string;
  token: string;
  totalChunks: number;
  /** Total ciphertext bytes (plaintext + 16-byte tag per chunk). */
  cipherBytes: number;
}

export interface StoreCreateResponse {
  uploadToken: string;
  expiresAt: number;
}

export interface StoreInfo {
  totalChunks: number;
  /** Chunks uploaded so far. */
  have: number;
  manifest: boolean;
  complete: boolean;
  /** The upload stopped before finishing (sender left); it won't complete. */
  abandoned: boolean;
  expiresAt: number;
}

/** Server limits, advertised in `GET /ice` when the store is enabled. */
export interface StoreLimits {
  maxBytes: number;
  ttlSeconds: number;
}
