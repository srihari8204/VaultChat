# VaultChat — Feature Reality Audit & Completion Plan

**Method:** evidence-based code trace (client→API→DB→realtime→render), 7 parallel deep audits. Verdicts cite `file:line`.
**Rubric:** **WORKS** = genuinely wired end-to-end, real data, no mock (still pending device test) · **PARTIAL** = wired but a real piece missing · **STUB** = UI only / hardcoded / canned / no backend · **BROKEN** = wired but a defect stops it working · **MISSING**.
**Mandate:** real prod code, NO demo/fake; honor encrypted-PII / E2EE.

> Earlier version of this doc marked features ✅ on *code presence*. This version reflects *actual wiring*. Big correction: the **core conversation is genuinely real**, but a long tail of secondary screens are write-only dead-ends or fabricated data.

---

## ✅ Genuinely real (WORKS — production-grade)
**Core messaging:** send/receive text (real DB insert + Socket.IO fan-out), realtime receive, reactions, reply, forward, edit (15-min window enforced), delete-for-everyone, @mentions (notify even if muted), disappearing, vanish-mode, view-once, star/bookmark, read receipts + delivery, **E2EE 1:1** (real Double-Ratchet, `E2EE_ENABLED=true`).
**Media in:** image/video/file/voice upload (real presigned/multipart → Postgres `attachments`), poll create+vote+tally, GIF (real Tenor proxy), location + live-location (encrypted socket relay), per-chat media gallery, video player.
**Calls:** 1:1 voice + video (real `getUserMedia` + `RTCPeerConnection` + ICE over socket), incoming-call ring (real `call_incoming` event → routes + answers offer).
**Stories:** post photo status, view feed (server-side visibility: shared-chat + block enforced), viewer list/count, mark-seen, TTL sweeper.
**Channels/broadcast:** create/join/post/subscribe (real `channels` tables, 3-way delivery: REST + socket room + push).
**Groups (backend):** create, members, **roles enforced server-side on every mutating route**, slow-mode/send/media/anti-spam-link policies **enforced on send path**, promote/demote/remove. Invite-link generation (real crypto token + redeem endpoint).
**Privacy/security (real):** settings privacy toggles (enforced server-side), MFA toggle, app-lock cold gate, hidden-chats (bcrypt PIN), **duress/decoy vault** (real scrypt + AES-256-GCM, PIN never stored), ghost-mode, stealth calculator, encrypted-notes (real AES-GCM at rest), personal vault (PBKDF2+AES-GCM), trusted-contacts, verify-contact (real 60-digit safety numbers), login-history (real `refresh_tokens` sessions), blocked list, GDPR export, account delete.
**AI (real):** ai-assistant + ai-chat-bot (real Ollama LLM), breachguard + dark-web-guard (real HaveIBeenPwned k-anonymity + Postgres monitors).
**Utilities (real):** scheduled-messages (Postgres + 30s server sweep, survives app close), emergency-SOS (GPS/shake → backend → trusted-contact push), qr-contact (real VaultID QR + scan), chat-export (real file write+share), message-reminder, in-chat-search (over decrypted cache), bookmarks, starred, **game-lobby** (real Socket.IO matchmaking + Postgres leaderboard).

## 🔴 BROKEN — wired but defective (real bugs, cheap fixes, highest priority)
| Feature | Defect | Evidence |
|---|---|---|
| **Pin message** | Duplicate `router.post('/:id/pin')` — chat-pin (1305) shadows message-pin (1776). Tapping pin writes `chat_members.pinned=false`, never `pinned_message_id`; real handler is dead code | `chats.js:1305` vs `:1776` |
| **Invite/join loop** | Links generate + redeem endpoint is real, but client `joinViaInvite` is **never called** and there's **no `/join/:code` deep-link** → generated links aren't joinable in-app. Join-requests inherit the dead end | `chatService.ts:864`, no handler in `_layout.tsx` |
| **group-admin + invite-link screens** | Fully built + route-registered but **nothing navigates to them** (chat only opens group-info, which has no path onward) — richest admin controls ship dark | `chat.tsx:932` |
| **Camera / video-notes / image-editor output** | All hand result back via `router.replace`/`setParams` (`capturedUri`/`editedUri`) but **no screen consumes those params** → captured photos, video notes, edited images silently vanish | `camera.tsx:54`, `video-notes.tsx:83`, `image-editor.tsx:222` |
| **app-lock-chats** | Hardcoded `DEMO_CHATS`; per-chat PIN stored **plaintext**; never actually gates a chat | `app-lock-chats.tsx:52,116` |

## 🟡 PARTIAL — real base, missing a piece
| Feature | Missing piece | Evidence |
|---|---|---|
| Image/video caption | `sendMediaMessage` accepts `caption` but no UI ever passes it — media sends empty | `sendMedia.ts:25` |
| Stickers | Real send path, but "stickers" are hardcoded Unicode emoji, no image packs | `stickers.tsx:38` |
| Live-location background | Foreground real; background tracking best-effort only | `location-sharing.tsx` |
| Voice transcribe | Real on-device STT but needs native build + unreachable from composer | `voice-transcribe.tsx` |
| Call recording | Records device **mic only** (not remote stream); fake waveform; "notified"/"encrypted" claims do nothing | `call-recording.tsx:92,282` |
| Group calls | Honestly downgrades to 1:1; needs SFU/mesh | `group-calls.tsx:83` |
| Video stories | Backend accepts video; picker hardcoded to images | `status.tsx:106` |
| Story E2EE / Group E2EE / Media E2EE | Real per-viewer/sender-key crypto built, **flags OFF** | `flags.ts` (`STORY_E2EE`,`GROUP_E2EE`,`MEDIA_E2EE`) |
| Group photo/description | Photo real; **description has no column/write** despite UI | `group-info.tsx` |
| Delete-for-me | Only delete-for-everyone exists | `chats.js:939` |
| chat-summary / tone-detector / translate | Work locally but **don't call the real LLM** sitting one import away (regex/phrasebook) | `chat-summary.tsx:42`, `translate.tsx:41` |
| behavioral, trustscore, d2de-status, mini-apps, bot-api, game-play, whiteboard, auto-reply, meeting-scheduler | Real core, incomplete reach (single-feature, no engine, no sync, or only 1 game) | per-audit |

## ⚫ STUB / THEATER — UI only, hardcoded/fake, or no backend (honesty-mandate violations)
| Feature | What's fake | Evidence |
|---|---|---|
| **Communities** | `DEMO_COMMUNITIES=[]`, create/join = `Alert('Coming soon')`, **zero backend routes** | `communities.tsx:17,43` |
| **Doc scanner** | `Math.random` progress, fabricated "AES-256/OCR" labels, hardcoded recent-docs, no OCR/upload | `docscanner.tsx:106` |
| **storage-manager** | Fabricated MB constants + hardcoded "Alice Chen" per-chat list | `storage-manager.tsx:94,113` |
| **filevault** | Calls itself "Vault" but files **unencrypted** (stores `uri:''` reference), **plaintext** folder password, fake sizes | `filevault.tsx:50,56` |
| **deepfake** | "World-First AI" but score = JPEG base64 char-code variance + `Math.random×7` | `deepfakeDetection.ts:43` |
| **decentralized-id** | `// Simulate DID creation`, `Math.random` fake on-chain DID, `verified:true` baked in | `decentralized-id.tsx:61` |
| **digital-wellbeing** | `// Demo data`, hardcoded weekly stats, `Math.random` heatmap, never records real usage | `digital-wellbeing.tsx:83` |
| **family** | Static member array w/ pravatar pics, all actions canned Alerts | `family.tsx:16` |
| **watch-together** | Hardcoded "2 viewers / 35% / SYNCED", no player, no socket — claims "all P2P", transmits nothing | `watch-together.tsx:40,126` |
| **screen-share** | `Alert: "nothing is transmitted"`, no `getDisplayMedia` | `screen-share.tsx:37` |
| **zero-knowledge** | Static brochure, literal `status:'active'` strings, no crypto | `zero-knowledge.tsx:12` |
| **smart-notifications** | Hardcoded stats, "AI rules" toggles nothing reads | `smart-notifications.tsx:46,63` |
| **chat-themes / chat-wallpaper** | Persist keys `chat.tsx` **never reads**; bubble color hardcoded `#0E7256` | `chat.tsx:2826` |
| **last-seen-privacy** | Writes AsyncStorage only; no enforcement consumes it | `last-seen-privacy.tsx:69` |
| **vault-features** | "Fake PIN" writes `vault_fake_pin` nothing enforces; timer/screenshot toggles no enforcement | `vault-features.tsx:222` |
| **call history** | Static "coming back soon" placeholder, no DB | `(tabs)/calls.tsx` |
| **msgrequests** | AsyncStorage only, self-admits "server is notified — it isn't"; white-on-white render bug | `msgrequests.tsx:169` |
| Channel reactions/comments · story reply/react · text-only stories · group ban · invite QR | No routes / no UI at all | — |

## ❌ MISSING (no implementation)
Usernames/@handles · emoji status · message threads · albums/grouped media · auto-download settings · HD/compressed toggle · custom chat folders · select-multiple bulk actions · story-ring in chat list · i18n · multi-account · cloud-sync-all-messages · global server search (intentionally removed — E2EE).

---

# Completion Plan — priority by (value × effort × honesty-risk)

### P0 — Fix BROKEN real features (days, huge ROI: these already mostly work)
1. **Pin message** — remove/merge the duplicate `/:id/pin` route so message-pin reaches `chats.js:1776`.
2. **Invite/join** — add `joinViaInvite` call + `/join/:code` deep-link handler + paste/scan-to-join UI. Unlocks invite links *and* join-requests.
3. **Group nav** — link `group-info` → `group-admin` + `invite-link` (and surface `msgrequests` from chats list).
4. **Capture consumers** — make `chat.tsx` read `capturedUri`/`editedUri`/`video-note` params and send via `sendMediaMessage`; add camera + video-notes to the attach menu.
5. **Caption input** — wire the existing `caption` field into the media composer.

### P1 — Kill security theater (honesty mandate; some are dangerous)
6. **filevault** — actually encrypt file bytes (reuse `vaultCrypto`) + hash folder password, or relabel/remove. *(Currently lies about encryption.)*
7. **app-lock-chats** — real chat list, hashed PIN, actually gate chat open.
8. **encrypted-notes** password generator — swap `Math.random` → CSPRNG (`@noble` randomBytes).
9. **Build-or-cut the stubs:** storage-manager (real FS usage), smart-notifications, chat-themes/chat-wallpaper (have `chat.tsx` consume them), last-seen-privacy (route to `/user/settings`), vault-features fake-PIN, deepfake, decentralized-id, digital-wellbeing, family, zero-knowledge, watch-together, doc-scanner. Each → made real or removed from nav. Delete dead `generateAriaResponse` block (`ai-chat-bot.tsx:153-325`).

### P2 — Use the LLM you already have (cheap, high-impact — backend is live)
10. Route **translate, chat-summary, tone-detector** through `aiAssist(...)` instead of regex/phrasebook.

### P3 — Build the genuine functional gaps
11. **Communities backend** (schema + routes) + wire client off the mockup.
12. **Channel reactions/comments**; **story reply/react**; **video + text-only stories**.
13. **Group** description column, ban table, invite **QR** render.
14. **Call history** table + route + write call records from signaling.

### P4 — Enable the crypto that's already built (then deploy)
15. Enable + multi-device test: `MEDIA_E2EE`, `STORY_E2EE`, `GROUP_E2EE`, vault session/cache flags (+ migrations 039/040/043).
16. Close open test bugs: push delivery (FCM creds → Expo), profile-photo after 043, decrypt-fail-after-delete.

### P5 — Calls to production (infra-gated)
17. Verify/set **`TURN_SECRET`+`TURN_HOST`** + run coturn (most likely cause of "calls failing"). Then **SFU** for group, real **screen-share** (`getDisplayMedia` + reuse `screen_share_*` relays), real **call-recording** (mix remote stream), real **watch-together** sync.

### P6 — Telegram-grade polish & platform
18. Usernames/@handles, emoji status, albums, threads, jump-to-date, auto-download, multi-select, story-ring.
19. **i18n** (touches every screen — before more UI), **push** hardening, **multi-device**, on-device AI.

### P7 — Cleanup
20. Drop legacy plaintext columns + dead routes once all clients on new APK.

**Start: P0.** Five fixes turn already-working features from broken→working for very little code — the best ROI in the whole list. Then P1 (honesty) and P2 (free LLM wins) before any net-new building.
