/**
 * Server configuration, parsed and validated from environment variables.
 *
 * Centralising this in one zod-validated object means the process fails fast
 * at boot with a clear message if something is misconfigured, rather than
 * deep inside a request handler.
 */
import { randomBytes } from 'node:crypto';
import { z } from 'zod';

/** Split a comma-separated env string into a trimmed, non-empty list. */
const csv = (value: string | undefined): string[] =>
  (value ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

const EnvSchema = z.object({
  PORT: z.coerce.number().int().positive().default(8787),
  HOST: z.string().default('0.0.0.0'),
  // Unset → in-memory rooms (single instance, nothing else to run). Set it to
  // run several instances that share rooms through Redis.
  REDIS_URL: z.string().optional(),
  ROOM_TTL_SECONDS: z.coerce.number().int().positive().default(3600),
  CORS_ORIGINS: z.string().default('http://localhost:5173'),
  STUN_URLS: z
    .string()
    .default('stun:stun.l.google.com:19302,stun:stun1.l.google.com:19302'),
  TURN_URL: z.string().optional(),
  TURN_USERNAME: z.string().optional(),
  TURN_CREDENTIAL: z.string().optional(),
  // A URL that returns a ready-to-use iceServers JSON array (e.g. Metered's
  // `/api/v1/turn/credentials?apiKey=...`). Fetched server-side and cached so
  // the API key never reaches the browser and creds rotate automatically.
  TURN_API_URL: z.string().url().optional(),
  // Signs rejoin tokens. Must be shared by all instances behind one load
  // balancer; a random per-process secret is used when unset.
  SESSION_SECRET: z.string().min(16).optional(),
  // Serve the built web app from this process too (single-container deploys).
  STATIC_DIR: z.string().optional(),
  // How many receivers can join one link at the same time.
  MAX_RECEIVERS: z.coerce.number().int().min(1).max(64).default(8),
  // WebSocket relay fallback for peers that can't connect directly. The relay
  // only ever carries end-to-end encrypted data, but it does cost the
  // operator bandwidth; set to "false" to disable.
  RELAY_ENABLED: z
    .enum(['true', 'false'])
    .default('true')
    .transform((v) => v === 'true'),
  // Store-and-forward: senders may opt to leave an encrypted copy on this
  // server so receivers can download after they close the tab. Off unless
  // enabled — it costs disk and bandwidth. Copies are ciphertext only.
  STORE_ENABLED: z
    .enum(['true', 'false'])
    .default('false')
    .transform((v) => v === 'true'),
  STORE_DIR: z.string().default('./data/store'),
  STORE_MAX_TRANSFER_MB: z.coerce.number().int().positive().default(2048),
  STORE_MAX_TOTAL_MB: z.coerce.number().int().positive().default(10240),
  STORE_TTL_HOURS: z.coerce.number().positive().default(24),
  STORE_MAX_UPLOADS_PER_IP: z.coerce.number().int().positive().default(3),
  // Which proxies to trust for the client IP (per-IP limits). "loopback"
  // fits nginx/Caddy on the same host; "false" uses the socket address.
  TRUST_PROXY: z.string().default('loopback'),
});

const parsed = EnvSchema.parse(process.env);

export interface ServerConfig {
  port: number;
  host: string;
  /** Present → Redis backend; absent → in-memory. */
  redisUrl?: string;
  roomTtlSeconds: number;
  corsOrigins: string[];
  stunUrls: string[];
  /** Present only when all three TURN env vars are set. */
  turn?: {
    url: string;
    username: string;
    credential: string;
  };
  /** Optional URL that returns an iceServers JSON array (e.g. Metered). */
  turnApiUrl?: string;
  maxReceivers: number;
  relayEnabled: boolean;
  sessionSecret: string;
  staticDir?: string;
  store?: {
    dir: string;
    maxTransferBytes: number;
    maxTotalBytes: number;
    ttlSeconds: number;
    maxActivePerIp: number;
  };
  trustProxy: string | boolean;
}

const turn =
  parsed.TURN_URL && parsed.TURN_USERNAME && parsed.TURN_CREDENTIAL
    ? {
        url: parsed.TURN_URL,
        username: parsed.TURN_USERNAME,
        credential: parsed.TURN_CREDENTIAL,
      }
    : undefined;

export const config: ServerConfig = {
  port: parsed.PORT,
  host: parsed.HOST,
  ...(parsed.REDIS_URL ? { redisUrl: parsed.REDIS_URL } : {}),
  roomTtlSeconds: parsed.ROOM_TTL_SECONDS,
  corsOrigins: csv(parsed.CORS_ORIGINS),
  stunUrls: csv(parsed.STUN_URLS),
  ...(turn ? { turn } : {}),
  ...(parsed.TURN_API_URL ? { turnApiUrl: parsed.TURN_API_URL } : {}),
  maxReceivers: parsed.MAX_RECEIVERS,
  relayEnabled: parsed.RELAY_ENABLED,
  sessionSecret: parsed.SESSION_SECRET ?? randomBytes(32).toString('hex'),
  ...(parsed.STATIC_DIR ? { staticDir: parsed.STATIC_DIR } : {}),
  ...(parsed.STORE_ENABLED
    ? {
        store: {
          dir: parsed.STORE_DIR,
          maxTransferBytes: parsed.STORE_MAX_TRANSFER_MB * 1024 * 1024,
          maxTotalBytes: parsed.STORE_MAX_TOTAL_MB * 1024 * 1024,
          ttlSeconds: Math.round(parsed.STORE_TTL_HOURS * 3600),
          maxActivePerIp: parsed.STORE_MAX_UPLOADS_PER_IP,
        },
      }
    : {}),
  trustProxy: parsed.TRUST_PROXY === 'false' ? false : parsed.TRUST_PROXY === 'true' ? true : parsed.TRUST_PROXY,
};
