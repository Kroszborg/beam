# Beam

**Send files of any size directly between devices — encrypted, no uploads, no accounts.**

Open the page, drop files, share the link. The receiver starts downloading the
moment they open it, while you're still sending; there's no "upload, then
download" step that doubles the wait. Files are encrypted in your browser and
streamed peer-to-peer over WebRTC; the server only introduces the two browsers
and never sees the key.

```
Sender browser ──encrypt──▶ ░░ WebRTC DataChannel (P2P) ░░ ──decrypt──▶ Receiver ──▶ disk
                                       ▲
                       signaling: SDP / ICE (+ encrypted relay if P2P is impossible)
                                       │
                               Beam server (no files stored, never has the key)
```

## What it does

- **Any size.** Received bytes go straight to disk — into the file or folder you
  pick (Chromium), or through the browser's download manager via a service
  worker stream (Firefox, Safari, Android). Nothing is buffered in memory or in
  browser storage, so the limit is the receiver's disk, not a tab's RAM.
- **Instant link.** No hashing pass before sharing; the link exists the moment
  you click.
- **Folders and many files.** Drop a folder: Chromium receivers recreate it in a
  folder they choose; others get one streamed `.zip` (ZIP64, exact size known
  up front, so the browser shows real progress).
- **Pick what you want.** The receiver sees the (encrypted) file list first and
  ticks only the files they need.
- **Several receivers per link.** Each gets its own connection, progress and resume.
- **Survives drops.** A dropped connection resumes from the last chunk written
  to disk; a signaling blip doesn't interrupt a running transfer at all.
- **Works behind hostile NATs.** If no direct path exists (and no TURN server
  helps), the transfer is tunnelled through the Beam server — still end-to-end
  encrypted. The UI shows which path is in use (same network / direct / TURN /
  relay) so a slow transfer explains itself.
- **One container to self-host.** No Redis needed for a single instance.

## Security model

- **AES-256-GCM, client-side.** Every 1 MiB chunk is sealed under a key that
  lives only in the link's URL fragment (`/r/room#key`). Browsers never send the
  fragment to servers.
- **The file list is encrypted too.** Names, sizes and types travel sealed with
  the same key; the server can't see what is being sent.
- **Integrity is cryptographic.** Each chunk's IV is `nonce ‖ chunk index`, so
  the GCM tag authenticates the bytes *and* their position; the sealed manifest
  fixes the exact chunk count and lengths. Tampering, reordering, substitution
  and truncation are all detected.
- **The server is a blind router.** Rooms, presence, SDP/ICE forwarding, and —
  only when needed — relaying ciphertext. Nothing is stored; rooms expire.
- **Re-reading a changed file is refused**, so a chunk index is never encrypted
  twice with different contents (which would break GCM).

## How a transfer flows

1. Sender creates a room; the link (with key) is shown immediately.
2. Receiver opens it, joins, and a WebRTC connection is negotiated. If none
   opens within 10 s, the sender switches that receiver to the relay.
3. Receiver says `hello`; sender sends the sealed manifest.
4. Receiver picks files and a destination, then sends a `request` for the
   chunk ranges it wants (after a reconnect: only the gaps).
5. Sender streams chunks: read → encrypt → 64 KiB frames, keeping the channel's
   send buffer between 1 and 4 MiB and at most 32 chunks un-acked.
6. Receiver decrypts each chunk, writes it to disk, then acks it — so a slow
   disk slows the sender instead of filling memory.

## Monorepo layout

```
packages/
├── shared/   wire contracts: signaling + transfer protocol v2, constants
├── server/   Fastify + WebSocket signaling, rooms (memory or Redis), relay
└── client/   React + Vite + Tailwind
    └── src/lib/
        ├── crypto/      AES-GCM keys and chunk sealing
        ├── webrtc/      peer connection, DataChannel + relay transports
        ├── signaling/   WebSocket client with rejoin-after-reconnect
        ├── transfer/    manifest, framing, sender/receiver, flow control
        │   └── sinks/   fs (File System Access), stream (service worker), idb
        ├── zip/         streaming ZIP64 writer + CRC-32
        └── session/     sender/receiver orchestration (multi-receiver, relay)
```

## Getting started

Prerequisites: **Node ≥ 22** and **pnpm ≥ 9**. Redis is optional.

```bash
pnpm install
cp .env.example .env      # optional
pnpm dev                  # client http://localhost:5173, server :8787
```

## Self-hosting

```bash
docker build -t beam .
docker run -p 8787:8787 beam                      # try it on http://localhost:8787

BEAM_DOMAIN=beam.example.com docker compose up -d # with automatic HTTPS (Caddy)
```

Browsers only enable the needed crypto and service-worker APIs on HTTPS (or
localhost). See `.env.example` for options: TURN, relay on/off, receivers per
link, and Redis + `SESSION_SECRET` for running several instances.

## Scripts

| Command          | Effect                                                         |
| ---------------- | -------------------------------------------------------------- |
| `pnpm dev`       | Server and client in watch mode                                |
| `pnpm build`     | Build all packages                                             |
| `pnpm typecheck` | Type-check every package                                       |
| `pnpm test`      | Unit + integration tests (protocol, sessions, zip, signaling)  |
| `pnpm e2e`       | Real two-browser transfers in Chromium + Firefox (needs `pnpm dev`) |

`pnpm e2e` covers streaming download, streamed zip, save-to-folder, the
IndexedDB fallback, two receivers on one link and the relay, verifying every
byte by SHA-256. `BEAM_E2E_BIG_MB=4096 pnpm e2e -g large` runs a large-file
transfer and reports throughput and peak JS heap.

## Browser support

| Receiver                         | Where files go                            | Size limit          |
| -------------------------------- | ----------------------------------------- | ------------------- |
| Chrome / Edge / Opera (desktop)  | Straight into the chosen file or folder   | Disk                |
| Firefox, Safari, Chrome Android  | Browser download (one file, or a `.zip`)  | Disk                |
| Private windows without service workers | Browser storage, saved at the end  | Storage quota (warned up front) |

Senders work in any modern browser. Keep the sender tab open until receivers
finish; Beam holds a screen wake lock and asks before closing mid-transfer.

## Roadmap

Not built yet, roughly in priority order:

- **Short codes** (`beam 7-tiger-ocean`) as an alternative to the long link —
  needs a PAKE (e.g. SPAKE2/CPace) so a short code can't be brute-forced.
- **Preview while receiving** — play video/audio or view images before the
  transfer finishes.
- **Store-and-forward (opt-in)** — hold encrypted chunks on the server for a
  limited time so the receiver can download after the sender has left.
- **Transfer speed on real WAN links** — measure and tune frame size and
  buffer watermarks between real machines (loopback on one Windows box caps
  out at the WebRTC stack, ~6 MB/s).
