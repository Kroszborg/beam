/**
 * HTTP routes for store-and-forward copies. See @beam/shared store.ts.
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { StoreCreateRequest } from '@beam/shared';
import { EncryptedStore, StoreError, MAX_CHUNK_BYTES, MAX_MANIFEST_BYTES } from './encryptedStore.js';

/** How long a `?wait=1` chunk read may hold the request open. */
const LONG_POLL_MS = 25_000;

export interface StoreRouteDeps {
  store: EncryptedStore;
  /** Is `token` the sender token for this room and peer? */
  ownsRoom: (roomId: string, peerId: string, token: string) => boolean;
}

function bearer(req: FastifyRequest): string | undefined {
  const h = req.headers.authorization;
  return h?.startsWith('Bearer ') ? h.slice(7) : undefined;
}

function handle(reply: FastifyReply, err: unknown) {
  if (err instanceof StoreError) return reply.code(err.status).send({ error: err.message });
  throw err;
}

export async function storeRoutes(app: FastifyInstance, { store, ownsRoom }: StoreRouteDeps): Promise<void> {
  await app.register(async (scope) => {
    // Raw ciphertext bodies, capped per route below.
    scope.addContentTypeParser('application/octet-stream', { parseAs: 'buffer', bodyLimit: MAX_MANIFEST_BYTES }, (_req, body, done) =>
      done(null, body),
    );

    scope.post<{ Body: StoreCreateRequest }>('/store', async (req, reply) => {
      const b = req.body ?? ({} as StoreCreateRequest);
      if (!ownsRoom(String(b.roomId), String(b.peerId), String(b.token))) {
        return reply.code(403).send({ error: 'Only the sender of this room can keep a copy.' });
      }
      try {
        const created = await store.create(String(b.roomId), {
          totalChunks: Number(b.totalChunks),
          cipherBytes: Number(b.cipherBytes),
          ip: req.ip,
        });
        return reply.code(201).send(created);
      } catch (err) {
        return handle(reply, err);
      }
    });

    scope.put<{ Params: { id: string }; Body: Buffer }>(
      '/store/:id/manifest',
      { bodyLimit: MAX_MANIFEST_BYTES },
      async (req, reply) => {
        try {
          await store.putManifest(req.params.id, bearer(req), req.body);
          return reply.code(204).send();
        } catch (err) {
          return handle(reply, err);
        }
      },
    );

    scope.put<{ Params: { id: string; index: string }; Body: Buffer }>(
      '/store/:id/chunks/:index',
      { bodyLimit: MAX_CHUNK_BYTES + 1024 },
      async (req, reply) => {
        try {
          await store.putChunk(req.params.id, bearer(req), Number(req.params.index), req.body);
          return reply.code(204).send();
        } catch (err) {
          return handle(reply, err);
        }
      },
    );

    scope.post<{ Params: { id: string } }>('/store/:id/complete', async (req, reply) => {
      try {
        await store.complete(req.params.id, bearer(req));
        return reply.code(204).send();
      } catch (err) {
        return handle(reply, err);
      }
    });

    scope.delete<{ Params: { id: string } }>('/store/:id', async (req, reply) => {
      try {
        await store.delete(req.params.id, bearer(req));
        return reply.code(204).send();
      } catch (err) {
        return handle(reply, err);
      }
    });

    scope.get<{ Params: { id: string } }>('/store/:id', async (req, reply) => {
      try {
        return reply.header('cache-control', 'no-store').send(store.info(req.params.id));
      } catch (err) {
        return handle(reply, err);
      }
    });

    scope.get<{ Params: { id: string } }>('/store/:id/manifest', async (req, reply) => {
      try {
        const data = await store.readManifest(req.params.id);
        if (!data) return reply.code(404).send({ error: 'Not uploaded yet.' });
        return reply.header('cache-control', 'no-store').type('application/octet-stream').send(data);
      } catch (err) {
        return handle(reply, err);
      }
    });

    scope.get<{ Params: { id: string; index: string }; Querystring: { wait?: string } }>(
      '/store/:id/chunks/:index',
      async (req, reply) => {
        try {
          const wait = req.query.wait === '1' ? LONG_POLL_MS : 0;
          const data = await store.readChunk(req.params.id, Number(req.params.index), wait);
          if (!data) return reply.code(204).send();
          return reply.header('cache-control', 'no-store').type('application/octet-stream').send(data);
        } catch (err) {
          return handle(reply, err);
        }
      },
    );
  });
}
