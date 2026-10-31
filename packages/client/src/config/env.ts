/**
 * Client environment. Vite inlines `import.meta.env.VITE_*` at build time.
 */

/**
 * Base URL of the signaling server (http/https; upgraded to ws/wss internally).
 * Empty or unset in a production build → the origin that served the app, for
 * single-container deploys where the server hosts the client.
 */
export const SIGNALING_URL: string =
  import.meta.env.VITE_SIGNALING_URL ||
  (import.meta.env.DEV ? 'http://localhost:8787' : window.location.origin);
