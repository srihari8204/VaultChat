# WhatsApp vs VaultChat — Architecture & Feature Comparison

> Maps every layer of the WhatsApp reference doc against VaultChat's current locked stack and roadmap. ✅ = at parity or better, ⚠️ = partial / needs work, ❌ = gap, 🏆 = VaultChat advantage.

---

## 1. Core Stack, Side by Side

| Layer | WhatsApp | VaultChat | Verdict |
|---|---|---|---|
| Client | Native Android (Java/Kotlin) + native iOS | React Native + Expo SDK 54 | ⚠️ RN is fine for v1; native modules (libsignal-rn, op-sqlite via JSI) cover the perf-critical paths. WhatsApp's native client is why it runs on 2G-era phones — watch RN bundle size and startup time on low-end Androids |
| Transport | Custom binary protocol (FunXMPP) over raw TCP/TLS + Noise pipes; tiny frames | Socket.IO over HTTP(S) | ⚠️ **This is Track A.** Socket.IO stuck on long-polling = your 8–10s delays. Even upgraded to WebSocket, Socket.IO frames (JSON + protocol overhead) are far heavier than WhatsApp's binary stanzas. Fix the upgrade now; consider a binary payload format (protobuf over raw WS) later |
| E2EE protocol | Signal: X3DH + Double Ratchet + Sender Keys | Signal via libsignal-rn: same three primitives | ✅ Protocol parity — same guarantees |
| Server | Erlang-derived custom stack (ejabberd lineage), massive fanout | Fastify 5 / Node.js, Socket.IO, Redis + BullMQ | ✅ for current scale. Go/Rust rewrite correctly deferred — measure first |
| Message DB (server) | Queue only — undelivered ciphertext, deleted on delivery | PostgreSQL 17 + PgBouncer | ⚠️ See §3 — the retention model is the important difference, not the engine |
| Cache/queue | Custom | Redis 7 + BullMQ | ✅ |
| Media store | Meta CDN, encrypted blobs | Cloudflare R2 | ✅ Same model (ciphertext blobs) achievable; R2's zero egress fees is a real cost 🏆 at small scale |
| TURN/relay | Proprietary global relay fleet | coturn on Hetzner | ⚠️ Works; single-region relay hurts Indian call latency until Mumbai migration |
| Local DB | SQLite (msgstore.db etc.), encrypted at rest | op-sqlite (JSI) | ✅ Right choice confirmed. Add at-rest encryption (SQLCipher build) + FTS5 table to match WhatsApp's local search |
| Infra location | Global edge | Hetzner Finland → Mumbai planned | ⚠️ Mumbai move = biggest single latency win for your market |

## 2. Message Pipeline

| Mechanic | WhatsApp | VaultChat status | Action |
|---|---|---|---|
| Optimistic local insert (UI never waits on network) | Core pattern: insert PENDING → 🕓 instantly | Verify: if VaultChat waits for server ack before rendering, that alone *feels* like seconds of lag independent of Track A | **Adopt if missing — cheapest perceived-speed win available** |
| Client-generated message IDs | Yes (enables offline queue + dedup) | Needed for optimistic insert + retry idempotency | Adopt |
| Offline outbound queue with backoff | Local DB queue, socket-independent | Confirm BullMQ handles server side; client side needs its own persisted queue | Adopt client-side |
| Ack ladder (server ack → per-device delivered → read) | ✓ / ✓✓ / blue ✓✓, receipts table per device | Standard receipts likely; per-*device* granularity matters once multi-device ships | Design receipts table per (user, device) now |
| Server deletes on delivery | Yes — queue, not archive | Postgres makes it tempting to keep rows forever | See §3 |
| Typing/presence | Subscribe-on-open, throttled stanzas | Socket.IO rooms map naturally | ✅ easy parity |

## 3. Server Retention — the philosophical fork

WhatsApp: server = **store-and-forward queue**. Delivered ciphertext is deleted; undelivered expires ~30 days. Result: server breach yields almost nothing; but no backup = history gone.

VaultChat currently: PostgreSQL as system of record. Two honest options:

1. **WhatsApp model** (delete on delivery): strongest privacy story, aligns with "privacy-first" brand, forces you to build backups + device-transfer (QR local transfer like WhatsApp's) properly.
2. **Encrypted mailbox model** (retain ciphertext for multi-device catch-up, like Signal's sealed queues but longer): easier multi-device, weaker story.

Recommendation: pick explicitly and put it in the privacy policy — this is a marketing asset either way, but only if deliberate. Your Status design already commits to zero-content-server; extending that principle to chats is the consistent move.

## 4. Push / Wake-up — ⚠️ your special problem

| | WhatsApp | VaultChat |
|---|---|---|
| Doorbell | FCM high-priority data msg (Android), APNs+NSE (iOS) | FCM planned (call-reliability prompt already covers this) |
| Content in push | Never — socket delivers content | Same model recommended |
| **No-GMS devices** | WhatsApp maintains a persistent-connection fallback + works on Huawei via its own long-lived socket | **Your own test device (P30 Pro, no Play Services) can't receive FCM.** You need: persistent foreground-service socket fallback, and eventually HMS Push Kit for Huawei users |

This is actually a 🏆 opportunity for the Indian/global-south market: a documented "works without Google" mode (persistent socket + battery-optimization exemption flow, reusing your OEM battery-manager work from the call-reliability track).

## 5. Media Pipeline

| Mechanic | WhatsApp | VaultChat | 
|---|---|---|
| Per-file random media key, HKDF → AES-CBC+HMAC, ciphertext to CDN | Yes | Same pattern on R2; you already use AES-256-GCM elsewhere — GCM per media file is fine (simpler than WhatsApp's CBC+HMAC legacy) ✅ |
| Key travels inside E2EE message | Yes | Adopt identically |
| Embedded micro-thumbnail in message | Yes — instant blur-up render | Adopt — big perceived-speed win |
| Forward = re-send URL+key, no re-upload | Yes | Adopt — saves R2 ops and mobile data |
| Auto-download matrix (network × type) | Yes | Roadmap item (Settings → Storage & Data equivalent) |
| Sender-generated link previews | Yes (receiver never fetches URL) | Adopt — free privacy differentiator, one sprint |

VaultBeam sits *beside* this: WhatsApp has no true P2P transfer — DataChannel direct transfer with TURN-ciphertext fallback is a genuine 🏆 differentiator (no server storage at all for large files).

## 6. Groups, Status, Calls

| Area | WhatsApp | VaultChat |
|---|---|---|
| Groups | Sender Keys, rotate on member removal, server sees membership | libsignal-rn Sender Keys = parity ✅. Copy the rotation-on-leave rule exactly — it's the security-critical detail |
| Status | Sender-Key fan-out to privacy-audience; 24h expiry; blobs on CDN | Your Track F design (zero-content-server + eager key fan-out) is architecturally the same as WhatsApp's — validation that the design is right ✅ |
| 1:1 calls | E2EE signaling over chat socket, SRTP keys inside E2EE, P2P or relay | WebRTC + coturn = same shape ✅; add "always relay" privacy toggle (hides IP) — small feature, on-brand |
| Group calls | SFU relaying encrypted streams | Later-stage; defer |
| Call reliability | Native OS integration | Your callkeep/foreground-service/OEM-whitelist prompt already mirrors this ✅ |

## 7. Local Storage & Search

| | WhatsApp | VaultChat gap |
|---|---|---|
| Encrypted DB at rest | Yes (Keystore-wrapped) | Add SQLCipher-enabled op-sqlite build |
| FTS message search (local only) | msgstore FTS table | Your plan is *better*: sqlite-vec semantic search 🏆 — but ship plain FTS5 first (cheap, expected), layer embeddings after |
| Media folder management + storage manager | Yes | Roadmap; low priority pre-scale |
| Backups | Drive/iCloud, optional E2E passphrase | ❌ Biggest structural gap. If you adopt delete-on-delivery (§3), encrypted backup + QR device-transfer become launch-blocking, not nice-to-have |

## 8. Feature Surface — where VaultChat wins and loses

**VaultChat advantages (no WhatsApp equivalent):** 🏆
- Mini Apps tab: 19-game suite (Ludo, Tambola for groups), Notes Vault, File Hub — WhatsApp has nothing comparable; strongest India virality lever
- VaultView (FLAG_SECURE + watermark + stego ID + remote revoke) vs WhatsApp's honor-system view-once
- VaultCheck (C2PA + on-device deepfake + rPPG) — no messenger has this
- AI Sticker Studio with festival drop engine; WhatsApp's avatar stickers are far weaker
- On-device IndicTrans2 translation — WhatsApp has no translation at all in most markets
- VaultBeam P2P transfer
- Alerts tab as structural differentiator

**WhatsApp advantages VaultChat must close before launch:** ❌
1. Optimistic-insert send pipeline + client message IDs (§2)
2. Binary/lean transport actually on WebSocket (Track A)
3. Push story on no-GMS devices (§4)
4. Encrypted backup + device transfer (§7)
5. Micro-thumbnails, forward-without-reupload, sender-side link previews (§5)
6. Multi-device (client-fanout per device) — fine to defer, but design the receipts/session schema per-device *now* so it isn't a rewrite
7. Contact discovery (hashed address-book sync) — table stakes for "who's on VaultChat"
8. Safety-number verification screen + key-change notices — cheap, and core to the privacy brand

## 9. Priority ordering (mapped to your tracks)

1. **Track A first (unchanged advice):** WebSocket upgrade fix + optimistic insert + client IDs + persisted outbound queue. These four together take messages from "8–10s" to "instant-feeling" even before Mumbai.
2. Mumbai VPS migration (latency floor for everything: chat, calls, R2 region).
3. Media pipeline parity items (§5) — small, high-visibility.
4. Backup/transfer decision (§3) — decide the retention model now because it constrains everything downstream.
5. Tracks D–F as planned; group-key rotation rule from §6 goes into Track F acceptance criteria.
6. No-GMS push mode — schedule after Track A; you literally can't dogfood push on your own P30 Pro until this exists.

---

*Comparison compiled July 2026 against the WhatsApp reference doc (same conversation) and VaultChat's locked v2 stack.*
