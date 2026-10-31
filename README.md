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
- **Short codes.** Besides the link, the sender can show a code like
  `42-tiger-ocean`; the receiver types it at `/receive`. It's a PAKE password
  (see below), so the server never learns it.
- **Send now, they download later (opt-in).** The sender can keep an encrypted
  copy on the server for 24 h. Receivers then download after the sender has
  closed the tab — or start while the copy is still uploading — and a receiver
  whose sender leaves mid-transfer continues from the copy without
  re-downloading anything.
- **Preview while receiving.** Video and audio play before they've finished
  arriving; images, text and PDFs open as soon as their file is complete.
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
- **Receivers prove themselves before getting anything.** A link receiver
  sends an HMAC over the key; the sender connects only if it checks out. So a
  room id alone (from a log, or by scanning short-code numbers) gets nobody a
  connection or any ciphertext.
- **Short codes use CPace** (a balanced PAKE) over ristretto255 via the
  audited `@noble/curves`. The code's words are the password; the server only
  maps its number to the room. Nobody — the server included — can test guesses
  offline, each online attempt needs the sender, and three failures disable
  the code (16 bits of words → under 1 in 20 000 odds per code). Only after the
  receiver confirms the key does the sender release the real AES key, wrapped
  under the PAKE key.
- **The server is a blind router.** Rooms, presence, SDP/ICE forwarding, and —
  only when needed — relaying ciphertext. Rooms expire.
- **Optional copies are ciphertext.** With "keep a copy", the server stores
  exactly the encrypted chunks and sealed file list that would have crossed
  the data channel, behind an upload token tied to the sender's room, with
  per-transfer, total and per-IP limits and a 24 h expiry.
- **Previews never execute content.** Only an allow-list of media types can be
  previewed, served with a forced type and `nosniff`; HTML/SVG never are.
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
├── server/   Fastify + WebSocket signaling, rooms (memory or Redis), relay,
│             short-code nameplates, store-and-forward (/store)
└── client/   React + Vite + Tailwind
    └── src/lib/
        ├── crypto/      AES-GCM keys and chunk sealing, CPace + link proofs
        ├── codes.ts     short-code word list and parsing
        ├── store/       copy uploader, and the copy presented as a channel
        ├── preview/     previews while receiving (+ service worker ranges)
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
link, encrypted copies (`STORE_ENABLED`, off by default, with size, disk and
expiry limits), and Redis + `SESSION_SECRET` for running several instances.
Copies live on one instance's disk, so with several instances route `/store`
to one of them (or share the directory).

## Scripts

| Command          | Effect                                                         |
| ---------------- | -------------------------------------------------------------- |
| `pnpm dev`       | Server and client in watch mode                                |
| `pnpm build`     | Build all packages                                             |
| `pnpm typecheck` | Type-check every package                                       |
| `pnpm test`      | Unit + integration tests (protocol, sessions, zip, signaling)  |
| `pnpm e2e`       | Real two-browser transfers in Chromium + Firefox (needs `pnpm dev`) |

`pnpm e2e` covers streaming download, streamed zip, save-to-folder, the
IndexedDB fallback, two receivers on one link, the relay, short codes (and a
wrong one being refused), downloading a copy after the sender closed the
browser (run the server with `STORE_ENABLED=true`), and previews of a real
video, image and text file — verifying every byte by SHA-256.
`BEAM_URL=https://your.site pnpm e2e` runs it against a deployment, and
`BEAM_E2E_DEBUG=1` logs each page's console and signaling messages. `BEAM_E2E_BIG_MB=4096 pnpm e2e -g large` runs a large-file
transfer and reports throughput and peak JS heap.

## Browser support

| Receiver                         | Where files go                            | Size limit          |
| -------------------------------- | ----------------------------------------- | ------------------- |
| Chrome / Edge / Opera (desktop)  | Straight into the chosen file or folder   | Disk                |
| Firefox, Safari, Chrome Android  | Browser download (one file, or a `.zip`)  | Disk                |
| Private windows without service workers | Browser storage, saved at the end  | Storage quota (warned up front) |

Senders work in any modern browser. Keep the sender tab open until receivers
finish; Beam holds a screen wake lock and asks before closing mid-transfer.

## Known limits

- **Previews of MP4s** play before they've finished only when the file is
  "fast start" (index at the front — true of most phone and web videos);
  otherwise they play once complete. Previews hold up to 512 MB in memory.
- **Short codes need the sender online** — the key exchange runs between the
  two browsers. A code can't unlock a stored copy after the sender has left;
  the link can.

## Roadmap

- **Transfer speed on real WAN links** — measure and tune frame size and
  buffer watermarks between machines in different places (loopback on one
  Windows box caps out at the WebRTC stack, ~6 MB/s).
