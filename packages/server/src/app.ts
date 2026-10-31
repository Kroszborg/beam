/**
 * Fastify application wiring.
 *
 * Exposes:
 *   • GET  /health  — liveness probe
 *   • GET  /ice     — ICE server config (STUN, plus TURN when configured)
 *   • GET  /ws      — WebSocket signaling (+ encrypted relay), see SignalingHub
 *   • the built web app, when STATIC_DIR is set
 *
 *   • /store/*      — opt-in store-and-forward copies (when STORE_ENABLED)
 *
 * Relayed transfer frames and stored copies are end-to-end encrypted; the
 * server never has a key.
 */
import Fastify, { type FastifyInstance } from 'fastify';
import cors from '@fastify/cors';
import websocket from '@fastify/websocket';
import { Redis } from 'ioredis';
import { config } from './config.js';
import { buildIceConfig } from './ice/iceConfig.js';
import { SignalingHub } from './ws/signaling.js';
import type { RoomBackend } from './rooms/backend.js';
import { MemoryBackend } from './rooms/memoryBackend.js';
import { RedisBackend } from './rooms/redisBackend.js';
import { serveApp } from './static.js';
import { EncryptedStore, type StoreOptions } from './store/encryptedStore.js';
import { storeRoutes } from './store/routes.js';

export interface BuiltApp {
  app: FastifyInstance;
  /** Tear down backend connections on shutdown. */
  close: () => Promise<void>;
}

export interface BuildAppOptions {
  /** Inject a Redis instance (e.g. a mock in tests) to use the Redis backend. */
  redis?: Redis;
  /** Override relay availability (defaults to config). */
  relayEnabled?: boolean;
  /** Override store-and-forward settings (null disables it). */
  store?: StoreOptions | null;
}

/** One sender plus this many receivers may share a room. */
const maxMembers = () => 1 + config.maxReceivers;

export async function buildApp(options: BuildAppOptions = {}): Promise<BuiltApp> {
  const app = Fastify({
    trustProxy: config.trustProxy,
    logger: {
      level: process.env.LOG_LEVEL ?? 'info',
      transport:
        process.env.NODE_ENV === 'production'
          ? undefined
          : { target: 'pino-pretty' },
    },
  });

  let backend: RoomBackend;
  const redisUrl = config.redisUrl;
  if (options.redis || redisUrl) {
    const redis = options.redis ?? new Redis(redisUrl!, { lazyConnect: false });
    redis.on('error', (err) => app.log.error(err, 'redis error'));
    backend = new RedisBackend(redis, config.roomTtlSeconds, maxMembers());
  } else {
    app.log.info('REDIS_URL not set — using in-memory rooms (single instance)');
    backend = new MemoryBackend(config.roomTtlSeconds, maxMembers());
  }

  const relayEnabled = options.relayEnabled ?? config.relayEnabled;
  const hub = new SignalingHub(backend, { relayEnabled, secret: config.sessionSecret, log: app.log });

  await app.register(cors, {
    origin: config.corsOrigins.length > 0 ? config.corsOrigins : true,
  });
  // Relay frames are ≤ 64 KiB plus a small header; anything far larger is abuse.
  await app.register(websocket, { options: { maxPayload: 1024 * 1024 } });

  // The signaling server is an API, not the website. A friendly root response
  // avoids confusion when someone opens http://localhost:8787 in a browser.
  if (config.staticDir) await serveApp(app, config.staticDir);
  else app.get('/', async () => ({
    service: 'beam-signaling',
    status: 'ok',
    note: 'This is the Beam signaling API. The app runs on the client (default http://localhost:5173).',
    endpoints: ['/health', '/ice', '/ws'],
  }));

  app.get('/health', async () => ({ status: 'ok', uptime: process.uptime() }));

  const storeOptions = options.store === undefined ? config.store : (options.store ?? undefined);
  let store: EncryptedStore | null = null;
  if (storeOptions) {
    store = new EncryptedStore(storeOptions);
    await store.init();
    await storeRoutes(app, { store, ownsRoom: (roomId, peerId, token) => hub.ownsRoom(roomId, peerId, token) });
  }

  // The encryption key never reaches here — clients fetch ICE config only.
  app.get('/ice', async () => ({
    ...(await buildIceConfig()),
    relay: relayEnabled,
    ...(store ? { store: store.limits } : {}),
  }));

  // Reject WebSocket upgrades from disallowed browser origins. Browsers always
  // send an Origin header on WS, so this stops other websites from abusing the
  // signaling server. Non-browser clients (no Origin) are allowed through.
  const originAllowed = (origin?: string): boolean => {
    if (!origin) return true;
    if (config.corsOrigins.length === 0) return true;
    return config.corsOrigins.includes(origin);
  };

  app.get('/ws', { websocket: true }, (socket, req) => {
    if (!originAllowed(req.headers.origin)) {
      socket.close(1008, 'origin not allowed');
      return;
    }
    hub.handleConnection(socket);
  });

  const close = async (): Promise<void> => {
    hub.close();
    store?.close();
    await backend.close();
  };

  return { app, close };
}
