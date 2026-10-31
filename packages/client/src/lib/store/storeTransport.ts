/**
 * StoreTransport — the server's stored copy, presented as a channel.
 *
 * FileReceiver speaks the same protocol to it as to a live sender: `hello`
 * gets the sealed manifest, `request` gets the chunks in order, `ack`s open
 * the window. Underneath it's HTTP: chunks are fetched a few ahead, and one
 * that isn't uploaded yet is long-polled — so a download can run right behind
 * an upload that's still in progress. Decryption, disk writes and resume are
 * all FileReceiver's, unchanged.
 */
import {
  FRAME_KIND_CHUNK,
  FRAME_KIND_MANIFEST,
  MAX_FRAME_SIZE,
  RECEIVE_WINDOW_CHUNKS,
  type ChunkRange,
  type ControlMessage,
} from '@beam/shared';
import type { ChannelData, Transport } from '../webrtc/transport.js';
import { frames } from '../transfer/wire.js';
import { StoreApi, StoreHttpError } from './storeApi.js';

const PREFETCH = 4;
const MANIFEST_POLL_MS = 1500;

export class StoreTransport implements Transport {
  readyState: RTCDataChannelState = 'open';
  readonly bufferedAmount = 0;
  readonly maxMessageSize = MAX_FRAME_SIZE;
  private handler: ((d: ChannelData) => void) | null = null;
  private readonly closeHandlers: (() => void)[] = [];
  private generation = 0;
  private credits = RECEIVE_WINDOW_CHUNKS;
  private wake: (() => void) | null = null;
  private abort: AbortController | null = null;

  constructor(
    private readonly api: StoreApi,
    private readonly id: string,
    /** The copy is gone, abandoned, or unreadable: the session should give up. */
    private readonly onFail: (message: string) => void,
  ) {}

  onMessage(handler: (d: ChannelData) => void): void {
    this.handler = handler;
  }

  onClose(handler: () => void): void {
    this.closeHandlers.push(handler);
  }

  drained(): Promise<void> {
    return Promise.resolve();
  }

  send(data: string | ArrayBufferView | ArrayBuffer): void {
    if (typeof data !== 'string' || this.readyState !== 'open') return;
    let msg: ControlMessage;
    try {
      msg = JSON.parse(data) as ControlMessage;
    } catch {
      return;
    }
    if (msg.type === 'hello') void this.sendManifest().catch((e) => this.fail(e));
    else if (msg.type === 'request') void this.pump(msg.ranges).catch((e) => this.fail(e));
    else if (msg.type === 'ack') {
      this.credits += msg.count;
      this.wake?.();
    }
  }

  close(): void {
    if (this.readyState === 'closed') return;
    this.readyState = 'closed';
    this.generation += 1;
    this.abort?.abort();
    this.wake?.();
    this.closeHandlers.forEach((h) => h());
  }

  private deliver(kind: number, index: number, payload: Uint8Array): void {
    for (const frame of frames(kind, index, payload, MAX_FRAME_SIZE)) {
      if (this.readyState !== 'open') return;
      this.handler?.(frame.slice().buffer as ArrayBuffer);
    }
  }

  private async sendManifest(): Promise<void> {
    for (;;) {
      if (this.readyState !== 'open') return;
      const sealed = await this.api.manifest(this.id);
      if (sealed) return this.deliver(FRAME_KIND_MANIFEST, 0, sealed);
      await this.checkAlive();
      await new Promise((r) => setTimeout(r, MANIFEST_POLL_MS));
    }
  }

  /** Stream `ranges` in order. A newer request supersedes this one. */
  private async pump(ranges: ChunkRange[]): Promise<void> {
    const gen = ++this.generation;
    this.abort?.abort();
    const abort = new AbortController();
    this.abort = abort;
    this.credits = RECEIVE_WINDOW_CHUNKS;
    const indices: number[] = [];
    for (const [a, b] of ranges) for (let i = a; i < b; i++) indices.push(i);

    const fetchOne = async (index: number): Promise<Uint8Array> => {
      for (;;) {
        const data = await this.api.chunk(this.id, index, true, abort.signal);
        if (data) return data;
        if (gen !== this.generation) throw new Superseded();
        await this.checkAlive(); // not uploaded after a long-poll: is anyone still uploading?
      }
    };

    const ahead: Promise<Uint8Array>[] = [];
    let next = 0;
    const fill = () => {
      while (ahead.length < PREFETCH && next < indices.length) {
        const p = fetchOne(indices[next++]!);
        p.catch(() => {}); // surfaced when awaited
        ahead.push(p);
      }
    };
    try {
      fill();
      for (const index of indices) {
        while (this.credits <= 0 && gen === this.generation) {
          await new Promise<void>((r) => (this.wake = r));
        }
        if (gen !== this.generation) return;
        const data = await ahead.shift()!;
        fill();
        if (gen !== this.generation) return;
        this.credits -= 1;
        this.deliver(FRAME_KIND_CHUNK, index, data);
      }
    } catch (err) {
      if (err instanceof Superseded || gen !== this.generation) return;
      if ((err as Error).name === 'AbortError') return;
      throw err;
    }
  }

  /** Throws if the copy is gone or its upload was abandoned. */
  private async checkAlive(): Promise<void> {
    const info = await this.api.info(this.id);
    if (!info) throw new StoreHttpError(404, 'The copy on the server has expired or was deleted.');
    if (info.abandoned) {
      throw new StoreHttpError(410, 'The sender left before their copy finished uploading, so this file is incomplete.');
    }
  }

  private fail(err: unknown): void {
    if (this.readyState !== 'open') return;
    const message =
      err instanceof StoreHttpError && err.status === 404
        ? 'The copy on the server has expired or was deleted.'
        : (err as Error)?.message || 'Could not read the copy on the server.';
    this.onFail(message);
    this.close();
  }
}

class Superseded extends Error {}
