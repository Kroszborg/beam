/**
 * Building, sealing and opening the transfer manifest.
 *
 * The manifest (file paths, sizes, types, chunk layout) is encrypted with the
 * link key like the file data, so neither the signaling server nor anything in
 * between learns file names or sizes. It is sealed with
 * IV = baseNonce ‖ 0xFFFFFFFF, an index no chunk can use, and the 8-byte base
 * nonce travels in front of the ciphertext. The receiver validates every field
 * before trusting it, since it decides allocation and file names.
 */
import {
  BASE_NONCE_LENGTH,
  CHUNK_SIZE,
  MANIFEST_IV_INDEX,
  MAX_FILES,
  MAX_PATH_LENGTH,
  PROTOCOL_VERSION,
  chunkCountFor,
  type FileEntry,
  type Manifest,
} from '@beam/shared';
import { encryptChunk, decryptChunk } from '../crypto/index.js';
import { relativePath } from '../files.js';

export function buildManifest(files: File[], transferId: string, chunkSize = CHUNK_SIZE): Manifest {
  const entries: FileEntry[] = files.map((f) => ({
    path: relativePath(f),
    size: f.size,
    type: f.type,
    lastModified: f.lastModified,
  }));
  return {
    v: PROTOCOL_VERSION,
    transferId,
    files: entries,
    chunkSize,
    totalBytes: entries.reduce((s, f) => s + f.size, 0),
    totalChunks: entries.reduce((s, f) => s + chunkCountFor(f.size, chunkSize), 0),
  };
}

export async function sealManifest(
  key: CryptoKey,
  baseNonce: Uint8Array,
  manifest: Manifest,
): Promise<Uint8Array> {
  const plaintext = new TextEncoder().encode(JSON.stringify(manifest));
  const ciphertext = await encryptChunk(key, baseNonce, MANIFEST_IV_INDEX, plaintext);
  const out = new Uint8Array(BASE_NONCE_LENGTH + ciphertext.length);
  out.set(baseNonce, 0);
  out.set(ciphertext, BASE_NONCE_LENGTH);
  return out;
}

export class ManifestError extends Error {}

export async function openManifest(
  key: CryptoKey,
  sealed: Uint8Array,
): Promise<{ manifest: Manifest; baseNonce: Uint8Array }> {
  if (sealed.length <= BASE_NONCE_LENGTH) throw new ManifestError('Manifest is truncated.');
  const baseNonce = sealed.slice(0, BASE_NONCE_LENGTH);
  let plaintext: Uint8Array;
  try {
    plaintext = await decryptChunk(key, baseNonce, MANIFEST_IV_INDEX, sealed.subarray(BASE_NONCE_LENGTH));
  } catch {
    throw new ManifestError('Could not decrypt the file list — the link key is wrong or the data was tampered with.');
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder().decode(plaintext));
  } catch {
    throw new ManifestError('File list is malformed.');
  }
  return { manifest: validateManifest(parsed), baseNonce };
}

const isUint = (n: unknown): n is number =>
  typeof n === 'number' && Number.isSafeInteger(n) && n >= 0;

export function validateManifest(m: unknown): Manifest {
  const bad = (why: string): never => {
    throw new ManifestError(`Invalid file list: ${why}.`);
  };
  if (!m || typeof m !== 'object') bad('not an object');
  const o = m as Record<string, unknown>;
  if (o.v !== PROTOCOL_VERSION) {
    throw new ManifestError(
      'The sender is using a different version of Beam. Ask them to reload the page and share a new link.',
    );
  }
  if (typeof o.transferId !== 'string' || o.transferId.length > 64) bad('transfer id');
  if (!isUint(o.chunkSize) || o.chunkSize < 64 * 1024 || o.chunkSize > 16 * 1024 * 1024) bad('chunk size');
  if (!Array.isArray(o.files) || o.files.length === 0 || o.files.length > MAX_FILES) bad('file count');

  const chunkSize = o.chunkSize as number;
  let totalBytes = 0;
  let totalChunks = 0;
  const files = (o.files as unknown[]).map((f): FileEntry => {
    const e = (f ?? {}) as Record<string, unknown>;
    if (typeof e.path !== 'string' || !e.path || e.path.length > MAX_PATH_LENGTH) bad('file path');
    if (!isUint(e.size)) bad('file size');
    totalBytes += e.size as number;
    totalChunks += chunkCountFor(e.size as number, chunkSize);
    return {
      path: e.path as string,
      size: e.size as number,
      type: typeof e.type === 'string' ? e.type.slice(0, 255) : '',
      lastModified: isUint(e.lastModified) ? e.lastModified : Date.now(),
    };
  });
  if (o.totalBytes !== totalBytes) bad('total size');
  if (o.totalChunks !== totalChunks || totalChunks >= MANIFEST_IV_INDEX) bad('chunk count');

  return {
    v: PROTOCOL_VERSION,
    transferId: o.transferId as string,
    files,
    chunkSize,
    totalBytes,
    totalChunks,
  };
}
