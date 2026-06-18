/**
 * Server configuration, parsed and validated from environment variables.
 *
 * Centralising this in one zod-validated object means the process fails fast
 * at boot with a clear message if something is misconfigured, rather than
 * deep inside a request handler.
 */
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
  REDIS_URL: z.string().default('redis://localhost:6379'),
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
});

const parsed = EnvSchema.parse(process.env);

export interface ServerConfig {
  port: number;
  host: string;
  redisUrl: string;
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
  redisUrl: parsed.REDIS_URL,
  roomTtlSeconds: parsed.ROOM_TTL_SECONDS,
  corsOrigins: csv(parsed.CORS_ORIGINS),
  stunUrls: csv(parsed.STUN_URLS),
  ...(turn ? { turn } : {}),
  ...(parsed.TURN_API_URL ? { turnApiUrl: parsed.TURN_API_URL } : {}),
};
