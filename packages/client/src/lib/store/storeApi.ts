/**
 * HTTP client for store-and-forward copies (contract in @beam/shared store.ts).
 * Every byte sent or received here is ciphertext.
 */
import type { StoreCreateRequest, StoreCreateResponse, StoreInfo } from '@beam/shared';

export class StoreHttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

type Fetch = typeof fetch;

const asBody = (data: Uint8Array) => data as unknown as BodyInit;

export class StoreApi {
  private readonly base: string;

  constructor(
    baseUrl: string,
    private readonly fetchImpl: Fetch = (...args) => fetch(...args),
  ) {
    this.base = `${baseUrl.replace(/\/$/, '')}/store`;
  }

  private async call(path: string, init: RequestInit = {}): Promise<Response> {
    const res = await this.fetchImpl(`${this.base}${path}`, { cache: 'no-store', ...init });
    if (res.status >= 400) {
      let message = `Server error (${res.status}).`;
      try {
        message = ((await res.json()) as { error?: string }).error ?? message;
      } catch {
        /* not JSON */
      }
      throw new StoreHttpError(res.status, message);
    }
    return res;
  }

  private auth(token: string, binary = false): HeadersInit {
    return {
      authorization: `Bearer ${token}`,
      ...(binary ? { 'content-type': 'application/octet-stream' } : {}),
    };
  }

  async create(req: StoreCreateRequest): Promise<StoreCreateResponse> {
    const res = await this.call('', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(req),
    });
    return (await res.json()) as StoreCreateResponse;
  }

  async putManifest(id: string, token: string, data: Uint8Array): Promise<void> {
    await this.call(`/${id}/manifest`, { method: 'PUT', headers: this.auth(token, true), body: asBody(data) });
  }

  async putChunk(id: string, token: string, index: number, data: Uint8Array): Promise<void> {
    await this.call(`/${id}/chunks/${index}`, { method: 'PUT', headers: this.auth(token, true), body: asBody(data) });
  }

  async complete(id: string, token: string): Promise<void> {
    await this.call(`/${id}/complete`, { method: 'POST', headers: this.auth(token) });
  }

  async remove(id: string, token: string): Promise<void> {
    await this.call(`/${id}`, { method: 'DELETE', headers: this.auth(token) });
  }

  /** Copy status, or null if there's no copy (or the server has no store). */
  async info(id: string): Promise<StoreInfo | null> {
    try {
      const res = await this.call(`/${id}`);
      const body = (await res.json()) as StoreInfo;
      return typeof body.totalChunks === 'number' ? body : null;
    } catch {
      return null;
    }
  }

  /** The sealed manifest, or null while it's not uploaded. Throws 404 if the copy is gone. */
  async manifest(id: string): Promise<Uint8Array | null> {
    try {
      return new Uint8Array(await (await this.call(`/${id}/manifest`)).arrayBuffer());
    } catch (err) {
      if (err instanceof StoreHttpError && err.status === 404 && (await this.info(id))) return null;
      throw err;
    }
  }

  /** One encrypted chunk, or null if it isn't uploaded yet (after waiting, with `wait`). */
  async chunk(id: string, index: number, wait: boolean, signal?: AbortSignal): Promise<Uint8Array | null> {
    const res = await this.call(`/${id}/chunks/${index}${wait ? '?wait=1' : ''}`, signal ? { signal } : {});
    if (res.status === 204) return null;
    return new Uint8Array(await res.arrayBuffer());
  }
}

/** Retry transient failures (network, 5xx, 429) with backoff; give up on others. */
export async function withRetry<T>(fn: () => Promise<T>, attempts = 6): Promise<T> {
  for (let i = 0; ; i++) {
    try {
      return await fn();
    } catch (err) {
      const status = err instanceof StoreHttpError ? err.status : 0;
      const transient = status === 0 || status >= 500 || status === 429;
      if (!transient || status === 507 || i + 1 >= attempts) throw err;
      await new Promise((r) => setTimeout(r, Math.min(8000, 250 * 2 ** i)));
    }
  }
}
