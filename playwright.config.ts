import { defineConfig, devices } from '@playwright/test';

/**
 * Real two-browser transfer tests: a sender page and a receiver page in
 * separate contexts, talking over actual WebRTC through the local signaling
 * server. Run `pnpm dev` (with Redis) first, or let `webServer` start it.
 */
export default defineConfig({
  testDir: './e2e',
  timeout: 10 * 60_000,
  fullyParallel: false,
  workers: 1,
  reporter: [['list']],
  use: {
    baseURL: process.env.BEAM_URL ?? 'http://localhost:5173',
    acceptDownloads: true,
  },
  projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'] } },
    { name: 'firefox', use: { ...devices['Desktop Firefox'] } },
  ],
});
