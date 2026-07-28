# VaultChat → WhatsApp Parity: Task Status vs. Current Source

Verified against the working tree (branch `hetzner-deploy`), 2026-07-09.
Source of tasks: `docs_latest/vaultchat-whatsapp-parity-tasks.xlsx` (112 tasks, VC-001…112).

> The spreadsheet records **0 Done / 0% complete**. That is stale. The actual state is below.

## Summary

| Status | Count | % |
|---|---:|---:|
| **Done** | 33 | 29% |
| **Partial** | 57 | 51% |
| **Not Started** | 22 | 20% |

### By priority

| Priority | Total | Done | Partial | Not Started |
|---|---:|---:|---:|---:|
| **P0** (launch blocking) | 34 | 16 | 13 | 5 |
| P1 (pre-launch parity) | 48 | 12 | 30 | 6 |
| P2 (fast follow) | 26 | 5 | 12 | 9 |
| P3 (post-launch) | 4 | 0 | 2 | 2 |

---

## ⚠️ Critical findings (privacy / correctness), surfaced by this audit

These are not merely "incomplete" — they contradict the product's E2EE zero-knowledge premise or cause real bugs.

| # | Issue | Where | Why it matters |
|---|---|---|---|
| 1 | **Contact discovery hashes phone numbers with plain SHA-256, not a keyed HMAC** | `vaultchat-backend/routes/contacts.js:24`, `lib/chatService.ts:1334` | The phone-number space is ~10^10 — trivially brute-forced. Anyone with the DB (or the server) can enumerate every user's number. VC-044 explicitly specifies HMAC. |
| 2 | **Message push notifications carry sender name + message body** | `vaultchat-backend/routes/chats.js:179-196` | VC-040 requires a *content-free doorbell*. Today message content leaves your infra and reaches FCM/Apple in plaintext — for an E2EE app this defeats the guarantee. |
| 3 | **Read-receipt privacy toggle is stored but never enforced** | `routes/chats.js:1043-1099` (no `read_receipts` check) | Users who turn read receipts OFF still broadcast `message_read`. The setting is cosmetic. |
| 4 | **Reactions are stored server-side as plaintext emoji** | `migrations/008_reactions.sql:12-18` | The server can read every reaction. VC-031 requires reactions be tiny E2EE reference messages. |
| 5 | **Link previews are fetched by the RECEIVER's device** | `components/LinkPreview.tsx:20-37` | The receiver's device/IP hits an arbitrary attacker-chosen URL on render. VC-052 requires the *sender* fetch at compose time and embed the preview in the encrypted payload. |
| 6 | **Call signaling (SDP offer / ICE) is sent in plaintext**, including inside the FCM push | `app/videocall.tsx:325-353`, `routes/calls.js:77` | Only WebRTC's DTLS-SRTP protects media; the signaling envelope and SDP are readable by the server and by FCM. |
| 7 | **No client-generated idempotency key on send** | `lib/messageQueue.ts:74-76,144-147`; `routes/chats.js:734-853` | The persisted retry queue (VC-010) is **not idempotent**. A lost ack → retry → duplicate message row. |
| 8 | **Delete-for-everyone has no time window** | `routes/chats.js:987-1002` | Any own message can be revoked forever, unlike the spec/WhatsApp. |
| 9 | **Group blue tick = ANY member read, not ALL** | `app/chat.tsx:3510-3513` | Sender sees "read" when only one of N members has read. |

---

## P0 gaps (the launch-blocking short list)

**Not Started (5):**
- **VC-009** Client-generated message IDs as server idempotency key → *duplicate messages on retry*
- **VC-012** Mumbai VPS migration (currently Hetzner/Finland — RTT from Indian ISPs)
- **VC-027** Per-(user,device) receipts schema (today: per-user pointers on `chat_members`) → multi-device = rewrite
- **VC-056** Full local message schema (only 3 render-cache tables exist)
- **VC-069** Per-device identity schema (`devices` table is push tokens only)

**Partial (13):** VC-026 (receipt privacy unenforced), VC-038/039 (delete-on-delivery off by default, TTL=never), VC-040 (push carries content), VC-041 (foreground service is call-only), VC-044 (unkeyed hash), VC-049/050 (no content hashes; no URL in envelope), VC-060 (Signal store in SecureStore, not sqlite), VC-071 (no orchestrated cold-open), VC-092 (composer missing sticker/contact/audio), VC-102 (no grouping/inline-reply/mention-bypass), VC-110 (queue is text-only — media not offline-queued)

---

## Full task table

| ID | Cat | Pri | Task | Status | Evidence | Gap |
|---|---|---|---|---|---|---|
| VC-001 | Speed | P0 | Diagnose socket transport | **Done** | `lib/socket.ts:83-95`, `lib/perf.ts:69-72` | — |
| VC-002 | Speed | P0 | Fix WebSocket upgrade path | **Done** | `lib/socket.ts:71`; nginx in `DEPLOY_HETZNER.md:150-156` | Proxy conf lives in a doc, not a committed `.conf` |
| VC-003 | Speed | P0 | Sticky sessions / socket routing | **Done** | `vaultchat-backend/server.js:66-82`, `docker-compose.yml:102` | — |
| VC-004 | Speed | P1 | Redis pub/sub adapter | **Done** | `server.js:66-82`, Kafka fanout `server.js:119-128` | — |
| VC-005 | Speed | P1 | Fast reconnect w/ resume token | Partial | `lib/socket.ts:73-77` | No resume token; full JWT re-auth each reconnect (`server.js:672-690`) |
| VC-006 | Speed | P2 | Heartbeat/ping tuning | **Done** | `server.js:57-58`, `lib/socket.ts:77` | — |
| VC-007 | Speed | P2 | Binary payload (protobuf/msgpack) | Not Started | default JSON parser `server.js:55-60` | No binary parser either side |
| VC-008 | Speed | P0 | Optimistic local insert on send | **Done** | `app/chat.tsx:806-824`, `lib/messageQueue.ts:100-106` | Queue is AsyncStorage, not sqlite (equivalent) |
| VC-009 | Speed | P0 | Client-generated msg IDs (idempotency) | **Not Started** | `messageQueue.ts:74-76,144-147`; `routes/chats.js:734-853` | tempId never sent; no server dedup → retry duplicates |
| VC-010 | Speed | P0 | Persisted outbound queue + backoff | **Done** | `messageQueue.ts:24-27,211-228` | — |
| VC-011 | Speed | P0 | Ack → tick state machine | **Done** | `app/chat.tsx:3506-3517,3868-3875`; `006_delivery.sql:12-13` | — |
| VC-012 | Speed | P0 | Mumbai VPS migration | **Not Started** | Hetzner/Finland `docker-compose.yml:107` | No ap-south region |
| VC-013 | Speed | P1 | Media edge locality (CDN) | Partial | S3-compatible `lib/storage.js:1-2,91-95` | No CDN/cache rules; staging on MinIO |
| VC-014 | Speed | P1 | DB indexes on hot paths | Partial | `002_chats.sql:72,29` | No receipts index (no receipts table) |
| VC-015 | Speed | P1 | PgBouncer + server tuning | Partial | `DEPLOY_HETZNER.md:59-62`, `db.js:1-8` | Express not Fastify; PgBouncer ops-only |
| VC-016 | Speed | P0 | Cold start renders from local DB | **Done** | `chats.tsx:102-107`, `chat.tsx:400-401` | — |
| VC-017 | Speed | P1 | Cursor-based **local** pagination | Partial | `chat.tsx:1629` `getMessages({before})` | Older pages hit server, not local DB |
| VC-018 | Speed | P1 | FlashList + memoized bubbles | Partial | `chat.tsx:2033` FlatList, memo 2058 | Uses tuned FlatList; no FlashList in repo |
| VC-019 | Speed | P2 | Hermes + startup profiling | **Done** | `app.json:11`, `lib/perf.ts`, `app/perf-debug.tsx` | Inline requires not explicit |
| VC-020 | Speed | P1 | Embedded micro-thumbnail | **Done** | `lib/sendMedia.ts:64-66,94-96`, `thumbnails.ts:23-42` | — |
| VC-021 | Speed | P1 | Compression profiles (Std/HD) | Not Started | — | No image tiers, video bitrate tiers, or compose toggle |
| VC-022 | Speed | P2 | Progressive video playback | Not Started | `chat.tsx:3316-3336` full download then play | No partial-file streaming |
| VC-023 | Speed | P1 | Subscribe-on-open presence | Not Started | global `presence_changed` `chat.tsx:553-558` | No per-peer subscribe/unsubscribe |
| VC-024 | Speed | P2 | Typing throttling | **Done** | `chat.tsx:750-764` | — |
| VC-025 | Data Flow | P0 | Delivered receipt + routing | **Done** | `chat.tsx:494-495`; `routes/chats.js:1014-1035` | Only fires while that chat is open |
| VC-026 | Data Flow | P0 | Read receipt batching + privacy | Partial | `chat.tsx:698-709`; `009_blocks.sql:26` | **Toggle never enforced** (`chats.js:1043-1099`); no reciprocity |
| VC-027 | Data Flow | P0 | Per-(user,device) receipts schema | **Not Started** | `006_delivery.sql:8-10` ("per-USER") | Receipts ignore `devices`; multi-device = rewrite |
| VC-028 | Data Flow | P2 | Played receipt (voice) | Not Started | — | No played receipt type/UI |
| VC-029 | Data Flow | P1 | Delete-for-everyone (revoke) | Partial | `routes/chats.js:987-1002`; `chat.tsx:3584-3587` | **No time window** enforced |
| VC-030 | Data Flow | P2 | Edit message flow | **Done** | `chatService.ts:622-627`; `routes/chats.js:62,971`; tag `chat.tsx:3859` | In-place PATCH, not a referencing message |
| VC-031 | Data Flow | P1 | Reactions as reference messages | Partial | `chatService.ts:1276-1282`; `008_reactions.sql:12-18` | **Plaintext emoji server-side**, not E2EE |
| VC-032 | Data Flow | P1 | Quoted reply w/ snapshot | Partial | `chat.tsx:361-363,1648-1673` | No content snapshot embedded |
| VC-033 | Data Flow | P2 | Forward metadata + limits | Partial | `chatService.ts:1288-1297`; `chat.tsx:3684` | No forward-count, no "many times", no limits |
| VC-034 | Data Flow | P1 | Mentions + mute bypass | **Done** | `chat.tsx:804-805`; `routes/chats.js:131-146` | — |
| VC-035 | Data Flow | P0 | Sender Key distribution | **Done** | `groupSession.rn.ts:60-72`; `040_group_sender_keys.sql` | — |
| VC-036 | Data Flow | P0 | Sender Key rotation on removal | **Done** | `groupSession.rn.ts:80-88` | Rotation is lazy (on next send) |
| VC-037 | Data Flow | P2 | Group blue-tick aggregation | Partial | `chat.tsx:2373-2410` info rollup | Tick = **ANY** member read (`3510-3513`), not ALL |
| VC-038 | Data Flow | P0 | Per-device offline queue, delete on delivery | Partial | `server.js:168-227` | Per-user not per-device; **off by default**, TTL=0 (never) |
| VC-039 | Data Flow | P0 | Retention model decision + policy doc | Partial | `server.js:168-183`; `044_attachment_retention.sql` | No standalone policy doc |
| VC-040 | Data Flow | P0 | FCM content-free doorbell | Partial | calls: `routes/calls.js:57-89` | **Message push carries sender name + body** (`chats.js:179-196`) |
| VC-041 | Data Flow | P0 | No-GMS foreground-service socket | Partial | `lib/batteryOptimization.ts:36-153`; `CallForegroundService.kt` | FG service is **call-only**; no persistent message socket, no GMS detection |
| VC-042 | Data Flow | P2 | HMS Push Kit (Huawei) | Not Started | — | Absent |
| VC-043 | Data Flow | P2 | iOS APNs + NSE decrypt | Not Started | `lib/push.ts` generic Expo push | No NSE target |
| VC-044 | Data Flow | P0 | Contact discovery via hashed sync | Partial | `routes/contacts.js:26-72`; `chatService.ts:1320-1360` | **Plain SHA-256, not HMAC** → brute-forceable |
| VC-045 | Data Flow | P1 | Push name in envelope | Partial | `routes/chats.js:172,179` (push title only) | No `pushName` in message payload |
| VC-046 | Data Flow | P1 | Security-code-changed notices | Partial | `safetyNumber.ts`, `app/verify-contact.tsx` | No auto identity-change detection/bubble/resend-block |
| VC-047 | Data Flow | P0 | Prekey directory + replenishment | **Done** | `011_prekeys.sql`; `routes/user.js:1256-1401`; `e2eeSession.ts:181` | Keys per-user, not per-device |
| VC-048 | Data Flow | P1 | Server-side privacy gating | Partial | `server.js:465-471`; `009_blocks.sql:5-8` | "About" not gated; `profile_photo_visible` unused in `/chats` |
| VC-049 | Data Flow | P0 | Media key + AES-256-GCM upload | Partial | `mediaCrypto.ts:20-41`; `mediaAttachments.ts:21-38` | **No content hashes** computed |
| VC-050 | Data Flow | P0 | Media URL+key+hashes in envelope | Partial | `mediaAttachments.ts:115-132` | Key only; no URL, no hashes; no pre-decrypt verify |
| VC-051 | Data Flow | P1 | Forward media w/o re-upload | **Done** | `chatService.ts:1288-1298` | — |
| VC-052 | Data Flow | P1 | Sender-generated link previews | **Not Started** | `components/LinkPreview.tsx:20-37` | **Receiver's device fetches the URL** (inverse of spec) |
| VC-053 | Data Flow | P1 | Status fanout to audience | **Done** | `lib/storyKeys.ts`; `status.tsx:212-218`; `stories.js:55-71,277-290` | Per-viewer key wrap, not shared sender-key |
| VC-054 | Data Flow | P1 | E2EE call signaling | Not Started | `videocall.tsx:325-353`; `routes/calls.js:77` | **Plaintext SDP/ICE** over socket + push |
| VC-055 | Data Flow | P2 | Always-relay privacy toggle | Not Started | `videocall.tsx:288-292` | No `iceTransportPolicy:'relay'` |
| VC-056 | Storage | P0 | Full local message schema | **Not Started** | `lib/localDb.ts:61-86` (3 tables) | No media/quoted/mentions/reactions/receipts/call_log/participant/drafts tables |
| VC-057 | Storage | P1 | At-rest DB encryption (SQLCipher) | Partial | `cacheCrypto.ts:50-90` field-level AES-GCM | Not SQLCipher; only 3 columns; gated off |
| VC-058 | Storage | P1 | FTS5 index | **Not Started** | `localDb.ts:188-210` JS substring scan | No FTS5 virtual table/triggers |
| VC-059 | Storage | P2 | Per-chat draft persistence | **Done** | `lib/drafts.ts:18-48`; `chats.tsx:583` | In AsyncStorage |
| VC-060 | Storage | P0 | Signal store on op-sqlite | Partial | `e2eeSession.ts:65-99` over SecureStore KV | Not sqlite; no trusted-identities store |
| VC-061 | Storage | P2 | Media dirs + gallery visibility | Partial | `mediaStore.ts:34-45,114-119` | No `.nomedia` toggle (forces `scanFile`) |
| VC-062 | Storage | P1 | Thumbnail + partial-download cache | Partial | `thumbnails.ts:23-42`; `mediaStore.ts:81-95` | No eviction; no partial cache |
| VC-063 | Storage | P3 | Storage manager screen | **Done** | `app/storage-manager.tsx:49-70`; `localDb.ts:216-228` | — |
| VC-064 | Storage | P0 | Delivered-ciphertext deletion job | **Done** | `server.js:184-227,151-166` | Env-gated off by default |
| VC-065 | Storage | P1 | Media blob lifecycle/GC | Partial | `server.js:240-278`; `044_attachment_retention.sql` | No dedupe by ciphertext hash |
| VC-066 | Storage | P1 | Local encrypted backup | **Done** | `cloudBackup.ts:188-213`, keep 7 | — |
| VC-067 | Storage | P1 | Cloud backup + passphrase wrap | Partial | `cloudBackup.ts:115-147,51-85` | **Key is account-managed** (`/user/backup/key`), no user passphrase/64-digit key |
| VC-068 | Storage | P2 | QR device-to-device transfer | Not Started | `app/vaultbeam.tsx` (P2P file over WebRTC) | Not QR, not local Wi-Fi, not chat history |
| VC-069 | Storage | P0 | Per-device identity schema | **Not Started** | `005_devices.sql:13-23` (push tokens only) | No account→device→session/queue/receipt graph |
| VC-070 | Storage | P3 | App-state sync mutation log | Not Started | `012_pin_archive.sql` (server columns) | No E2EE append-only log |
| VC-071 | Data Fetching | P0 | Cold-open sequence orchestration | Partial | pieces exist across `chat.tsx`, `socket.ts`, `messageQueue.ts` | No single ordered pipeline |
| VC-072 | Data Fetching | P0 | Ordered drain + out-of-order decrypt | **Done** | `services/crypto/e2ee.ts:184-288` (MKSKIPPED, MAX_SKIP=1000) | — |
| VC-073 | Data Fetching | P1 | Auto-download matrix | Partial | `mediaPrefs.ts:10-36` (global always/wifi/never) | No type × network matrix, no roaming |
| VC-074 | Data Fetching | P1 | Resumable chunked transfer | Partial | `transferManager.ts:87-97,142-155` (P2P only) | Media `getMedia` is a full download, no range/resume |
| VC-075 | Data Fetching | P2 | Profile photo versioning | Not Started | `routes/user.js:461` plain string | No version hash / cache invalidation |
| VC-076 | Data Fetching | P1 | Global + in-chat local search | Partial | `app/search.tsx`, `app/in-chat-search.tsx` | Not FTS-backed; no filter chips; no jump-to-date |
| VC-077 | Data Fetching | P3 | Semantic search (sqlite-vec) | Not Started | — | Absent |
| VC-078 | Data Fetching | P2 | GIF search via server proxy | Partial | `routes/gif.js:1-52` | No local recents |
| VC-079 | UI | P0 | Chat row full anatomy | **Done** | `chats.tsx:544-591` | Name chain simplified; no push-name→number fallback |
| VC-080 | UI | P1 | Typing/recording preview override | Partial | `chats.tsx:570-571` | No "recording audio…" |
| VC-081 | UI | P2 | Filter chips row | Partial | `chats.tsx:38-44,342-356` | No Favourites, no custom lists |
| VC-082 | UI | P2 | Archived row + keep-archived | Partial | `chats.tsx:285,535-537` | No archived header row, no keep-archived setting |
| VC-083 | UI | P1 | Swipe + long-press chat actions | Partial | `chats.tsx:523-542,390` | Pin not capped at 3; no mark read/unread; no lock/block |
| VC-084 | UI | P1 | Header live presence subtitle | **Done** | `chat.tsx:1787-1793,2139-2148` | Typing shown above composer, not in subtitle |
| VC-085 | UI | P1 | Text bubble rich rendering | Partial | `chat.tsx:2742-2771` linkify | **No markdown parsing**, no phone linkify, no large-emoji rule |
| VC-086 | UI | P1 | All media bubble types | Partial | `chat.tsx:3733-3838` | No contact bubble; voice has no speed control |
| VC-087 | UI | P1 | System bubbles | Partial | `chat.tsx:2054` day dividers | No E2EE notice, group events, timer/key-change bubbles |
| VC-088 | UI | P1 | Long-press multi-select toolbar | Partial | `chat.tsx:880-928`; `MessageActionSheet.tsx:64-99` | Single-message sheet, not multi-select; no Report |
| VC-089 | UI | P2 | Message Info screen | Partial | `chat.tsx:2374-2410` modal | No per-recipient timestamps; no Played row |
| VC-090 | UI | P1 | Swipe-to-reply | **Done** | `chat.tsx:2056` | — |
| VC-091 | UI | P1 | Reaction picker + strip | Partial | `chat.tsx:3880-3893,2342-2363` | No reactor-list view |
| VC-092 | UI | P0 | Full composer bar | Partial | `chat.tsx:2210-2338` | No sticker panel; attach missing Contact + Audio |
| VC-093 | UI | P1 | Voice hold/lock/cancel recorder | Partial | `chat.tsx:2216-2227,2316-2324` | Tap-to-start; no slide-up lock / slide-left cancel |
| VC-094 | UI | P1 | @Mention autocomplete | **Done** | `chat.tsx:766-780,2121-2136` | Colored tokens, not chips |
| VC-095 | UI | P2 | Pinned + unknown-contact banners | Partial | `chat.tsx:2011-2030` | No unknown-contact Add/Block/Report banner |
| VC-096 | UI | P1 | Full-screen media viewer | Partial | `media-viewer.tsx:117-137,255-256` | Tap-zoom not pinch; no swipe-down; no prev/next; no All-Media grid |
| VC-097 | UI | P2 | Camera composer + edit tools | Partial | `camera.tsx:143-145`; `image-editor.tsx:280-282` | Separate screens; no blur/sticker, HD toggle, caption, recipient chips |
| VC-098 | UI | P1 | Status rings + story viewer | Partial | `status.tsx:254,418`; `story-viewer.tsx:312-337,367-400` | No reply bar in viewer |
| VC-099 | UI | P1 | Safety-number verification | Partial | `verify-contact.tsx:108,118-138` | No QR render, no scan-to-verify |
| VC-100 | UI | P1 | Settings tree parity | Partial | `settings.tsx:247-324` | No Storage&Data section (storage-manager unlinked); no Account header |
| VC-101 | UX | P0 | Instant-send feel | **Done** | `chat.tsx:808-824,3860-3870` | — |
| VC-102 | UX | P0 | Rich grouped notifications | Partial | `notificationService.ts:69,161-166`; `push.ts:25-29` | No grouping/threadId, no inline reply/mark-read, no mention-bypass |
| VC-103 | UX | P2 | Per-chat tones + mute durations | Partial | `chat.tsx:1016-1029` | Mute is boolean; no 8h/1w/Always |
| VC-104 | UX | P2 | Voice autoplay + proximity | Not Started | — | Absent |
| VC-105 | UX | P1 | Read-receipt reciprocity | Partial | `notifications.tsx:21`; `receipt-control.tsx:68-88` | No reciprocity enforcement, no group exception |
| VC-106 | UX | P1 | Disappearing messages timer | Partial | `chat.tsx:1031-1055`; `chatService.ts:979` | Plain REST not E2EE control msg; **no local purge job** |
| VC-107 | UX | P2 | Chat lock + app lock | **Done** | `lib/chatLock.ts:29-81`; `app/index.tsx:22-23` | — |
| VC-108 | UX | P3 | Per-chat wallpaper + theme | **Done** | `chat.tsx:1852-1860,2076` | — |
| VC-109 | UX | P0 | Battery-exemption onboarding | **Done** | `batteryOptimization.ts:36-153`; `call-reliability.tsx` | Reached via Settings, not first-run |
| VC-110 | UX | P0 | Full offline compose UX | Partial | `messageQueue.ts:84-107,212-228` | **Text-only queue**; media not offline-queued |
| VC-111 | UX | P1 | Media retry/download affordances | Partial | `chat.tsx:839-844,1435` | Not resumable; no size label on download |
| VC-112 | UX | P2 | Accessibility (font scale, TalkBack) | **Not Started** | 0 matches for `accessibilityLabel` in `app/*.tsx` | No a11y labels |

---

## Recommended order (revised from the sheet, given actual state)

1. **Fix the 9 critical findings above** — several are one-file changes with outsized privacy impact (HMAC contact hashing, content-free push, enforce read-receipt toggle, revoke window).
2. **VC-009** idempotency key — cheap, prevents duplicate messages on retry.
3. **VC-027 + VC-069** per-device schema — do these *before* launch; afterwards they're a rewrite, not a migration.
4. **VC-040 / VC-041** push + no-GMS delivery.
5. **VC-056 / VC-058** local schema + FTS5 (unlocks VC-017 local pagination and VC-076 search).
6. Then the P1 UI tail (VC-085 markdown, VC-086 contact bubble, VC-096 viewer, VC-099 QR).
