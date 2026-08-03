# VaultChat — Phase 1: Complete Mobile Analysis (Android + iOS)

> **STATUS: ANALYSIS ONLY. No code written. No file modified. No patch generated. No refactor performed.**
> The only file added to this repository is this document.
> Development begins **only** after your explicit approval.

**Scope:** Android **and** iOS as first-class platforms. Desktop / Windows / Linux / macOS / Web
are marked **Pending – Future Development** with recommendations only (§16).

**Method:** every file in `app/`, `components/`, `hooks/`, `lib/`, `services/`, `constants/`,
`utils/`, `db/`, `shims/`, `plugins/`, `vaultchat-backend-go/`, `vaultchat-backend/`, plus all
build config, was read or programmatically indexed. Screen capabilities were extracted from
actual imports, not inferred from names. Where a repo document contradicts the code, **the code
wins** and the drift is flagged.

---

# 1. Executive Summary

## 1.1 What this project is

A **shipping, production** encrypted-communication app — not a prototype.

| | |
|---|---|
| App | Expo 54 · React Native 0.81.5 · Hermes · New Architecture · React Compiler ON · TypeScript |
| Released | `app.json` **v1.1.6**, Android `versionCode` **15** |
| Routes | **147 screens** (expo-router file-based) across 6 tabs + ~141 stack screens |
| Client modules | 50 components · 4 hooks · **129** `lib/` modules · **74** `services/` modules · 15 constants · 8 `db/` stores |
| Native | **7 Kotlin modules** (calls ×3, VaultBeam stream, VaultView ×2, VaultMedia) · **4 Swift/ObjC files** (VaultView, VaultBeam) · **8 Expo config plugins** |
| Rust | 2 crates — `crypto-core` (X3DH/Double-Ratchet/sender-keys/Shamir) and `vaultbeam-core` (chunked transfer), both format-frozen and vector-tested |
| Backend | **Go** — 18 REST modules + Socket.IO hub. Node retained for BullMQ workers only |
| Data | Postgres 16 (64 migrations) · Redis 7 · Kafka · MinIO/R2 · **coturn** TURN relay |
| Size | ~112,600 LOC (TS/TSX/Go/Rust/Kotlin/Swift/JS, excl. `node_modules`) |

## 1.2 The headline finding for a two-platform product

**This is an Android product with an iOS build target, not a cross-platform product.**

The TypeScript layer is ~95% platform-neutral and will run on iOS today. But **every
capability that makes VaultChat competitive is implemented as an Android native module with no
iOS counterpart**:

| Capability | Android | iOS | Consequence on iOS today |
|---|---|---|---|
| Cold-start incoming-call ring | ✅ `VaultCallMessagingService.kt` (373 LOC, runs with **no JS runtime**) | ❌ **absent** | **Calls do not ring when the app is killed or backgrounded.** `lib/CallService.ts:21` — `has() = Platform.OS === 'android' && !!VaultCalls` — makes all 8 native call functions silent no-ops |
| Background call audio | ✅ `CallForegroundService.kt` (mic/camera FGS + wake lock) | ❌ absent | Audio dies when the user leaves the call screen |
| Full-screen lock-screen call UI | ✅ Notifee FSI + native `CATEGORY_CALL` | ❌ `lib/callNotification.ts:22` returns early on non-Android | No incoming-call UI at all when backgrounded |
| Multi-GB VaultBeam transfer | ✅ Kotlin `VaultBeamStreamModule` (459 LOC) + Rust JNI + `transferForeground.ts` FGS | ⚠️ Rust path **scaffolded but unbuilt**; Kotlin path Android-only; `transferForeground.ts:26` Android-only | Transfers pause/die on backgrounding; large files fall back to the JS heap path |
| Rust crypto core | ✅ CMake + JNI + Nitro (`withCryptoCore.js`) | ❌ **plugin has zero iOS handling** | iOS silently runs the **TypeScript** crypto backend. Functionally identical and vector-proven — but slower |
| Scheduled messages | ✅ `lib/scheduledRunner.ts` | ❌ `:22` Android-only | Scheduled sends never fire on iOS |
| No-GMS socket keep-alive | ✅ Notifee dataSync FGS | ❌ N/A (iOS forbids it) | Correct by design — but iOS then **requires** working APNs, which is not configured |
| Screenshot protection | ✅ FLAG_SECURE (real blocking) | ⚠️ detect-only (`UIScreen.isCaptured`) | **Correctly designed** — `lib/screenGuard.ts` is the one module that models the asymmetry honestly |
| VaultView protected media | ✅ Kotlin | ✅ Swift (`VaultViewGuard.swift`, `VaultViewMedia.swift`) | Works |

**Reading of this:** iOS is not "partially done" — it is **architecturally anticipated but
unimplemented at the native layer**. The good news is that the anticipation is real and
high-quality: every Android-only module already guards with `Platform.OS`, degrades to a safe
no-op instead of crashing, and several (`screenGuard`, `hapticPlayer`, `push`) document the
platform asymmetry in their headers. Nothing has to be undone. iOS is **additive work**.

## 1.3 The second finding: three copies of the call protocol

`app/voicecall.tsx` (405), `app/videocall.tsx` (653) and `app/group-call-active.tsx` (260) each
**independently** re-implement `getUserMedia`, TURN fetch, `RTCPeerConnection`, socket wiring,
offer/answer/ICE, the E2EE signalling cipher, `InCallManager` routing, teardown, foreground
service handshake and call logging — **~1,318 LOC of triplicated real-time protocol held in
React component state.**

This matters more now that iOS is in scope: **iOS support means writing the CallKit/PushKit
adapter three times** unless the protocol is consolidated first. It is also why a 1 Hz duration
tick re-renders the entire call screen (`RTCView` included), and why the answer-resend fix
exists in two screens but not the third.

## 1.4 Feature reality vs. the product spec

| Spec claim | Reality |
|---|---|
| 1:1 voice/video WebRTC, HD audio, Bluetooth, background calling | ✅ Real, production-hardened (Android) |
| Screen share 1:1 P2P | ✅ Real — `replaceTrack()`, no renegotiation (`videocall.tsx:444`) |
| Group voice/video, 64 participants, LiveKit SFU | ❌ **Zero LiveKit.** Full **mesh capped at 5** server-side (`realtime/handlers.go:352`) |
| Webinar (host/co-host/speaker/audience) | ❌ `grep -ri webinar` over the repo → **0 code hits** |
| Broadcast to unlimited audience, Creator Studio, multi-RTMP | ❌ `grep -ri rtmp` → **0 hits**. `app/broadcast.tsx` is *text* channels; `creator-channels.tsx` is an 18-line redirect |
| Recording + Replay | ❌ `app/call-recording.tsx` records the **device mic**, not the call — and is unreachable |
| P2P file transfer, resume, integrity, relay fallback | ✅ **Genuinely excellent** — 12 GB cap, all bytes native, 4-tier architecture |
| E2EE (X3DH, Double Ratchet, sender keys, PFS) | ✅ Real, dual TS+Rust, byte-parity vector-tested |

## 1.5 Recommended shape of the work

Nine phases (§13–§15, §18). The critical sequencing decision:

> **Consolidate the call engine (Phase 2) BEFORE building iOS (Phase 6).**
> Otherwise CallKit/PushKit must be wired into three divergent screens, and the iOS estimate
> roughly doubles.

---

# 2. Complete Screen / Page Inventory

**147 routes.** Format below is one table per category. Every requested per-screen attribute is
covered — *Navigation Flow* = Entry + Exits; *Features / APIs / DB / Storage / Permissions /
Notifications / Background / Offline / P2P / WebRTC / Encryption* are encoded in the
**Capabilities** column (legend immediately below) and expanded in prose per category; *Shared
Components* and *Performance* follow each table.

### Capability legend

| Code | Meaning |
|---|---|
| `API` | Calls the Go backend over REST (`lib/api.ts` / `lib/chatService.ts`) |
| `SOCK` | Uses the Socket.IO real-time connection |
| `SQL` | Reads/writes op-sqlite (`lib/localDb.ts` or `db/financeDb.ts`) |
| `ASYNC` | AsyncStorage |
| `SEC` | expo-secure-store (OS keystore / Keychain) |
| `CACHE` | `lib/localCache.ts` paint-cached-then-refresh (⇒ **offline read supported**) |
| `ENC` | Encryption in the screen's own path (E2EE / media / notes / location / call crypto) |
| `RTC` | WebRTC (`react-native-webrtc` / InCallManager) |
| `P2P` | VaultBeam device-to-device / relay transfer |
| `NOTIF` | Notifee or expo-notifications |
| `BG` | Background service / task (foreground service, TaskManager) |
| `NAT` | Direct `NativeModules` access |
| `CAM` `MIC` `LOC` `CON` `MED` `BIO` `FILE` | Permissions: camera · microphone · location · contacts · media library · biometric · filesystem |
| `⚠A` `⚠I` | Contains explicit `Platform.OS` Android- / iOS-specific branching |

---

## 2.1 Authentication & Onboarding — 17 screens

| Screen | LOC | Purpose | Entry ← | Exits → | Capabilities |
|---|---|---|---|---|---|
| `index` | 40 | Cold-start router: decides lock / onboard / tabs | App launch | `/lock` `/onboard` `/(tabs)/chats` | `SEC` `BIO` |
| `onboard` | 110 | Landing: mobile + email → `/auth/lookup` → branch new/existing | `index` | `/mpin-entry` `/email-verify` | `API` `⚠I` |
| `email-verify` | 80 | New-user email OTP → emailTicket | `onboard` | `/onboard-profile` | `API` |
| `onboard-profile` | 163 | Name + avatar; email/mobile prefilled & locked | `email-verify` | `/onboard-security` | `API` `CAM` `MED` `⚠I` |
| `onboard-security` | 80 | Pick 5 security questions + answers | `onboard-profile` | `/onboard-mpin` | `API` `⚠I` |
| `onboard-mpin` | 101 | Set + confirm 6-digit MPIN, commit account | `onboard-security` | `/onboard-success` | `API` `SEC` |
| `onboard-success` | 95 | Account secured; optional device MFA | `onboard-mpin` | `/(tabs)/chats` `/biometric-setup` | `BIO` |
| `mpin-entry` | 78 | Existing user enters 6-digit MPIN | `onboard` | `/mpin-recover` `/(tabs)/chats` | `API` `SEC` |
| `mpin-recover` | 152 | Forgot MPIN → security questions → reset | `mpin-entry` | `/onboard-mpin` | `API` `⚠I` |
| `security-questions` | 93 | Standalone Q&A setup/verify | Settings, recovery | back | `API` |
| `lock` | 708 | CRED-style app lock (PIN / biometric / duress) | Cold start, resume, `sessionLock` | `/(tabs)/chats` `/decoy-chats` | `SEC` `BIO` |
| `app-lock` | 94 | Cold-launch gate when device MFA is on | `index` | `/(tabs)/chats` | `API` `BIO` |
| `app-lock-chats` | 436 | Choose which chats require unlock | Settings | back | `API` `ASYNC` `BIO` `⚠A` |
| `biometric-setup` | 89 | Enrol fingerprint / Face ID | `onboard-success`, Settings | back | `BIO` |
| `facescan` | 312 | 3D-mesh face enrolment / verification | `onboard`, `face-verify-new-device` | `/(tabs)/chats` | `BIO` `CAM` `⚠A` |
| `face-verify-new-device` | 249 | Face check on a new device login | Login on unknown device | `/(tabs)/chats` | `BIO` `CAM` |
| `blocked` | 367 | Terminal screen after a failed security scan (keys already wiped) | `_layout` security check | **none — gesture-disabled** | — |

**Shared components:** `components/auth/{MpinInput, PhoneField, SecurityQuestionRow, EmailAccountPicker}`, `components/PinPad`, `components/ui/*`.
**Offline:** all auth screens require network except `lock`, `app-lock`, `index` (local secrets).
**Performance:** `lock.tsx` at 708 LOC runs on every cold start and every resume — the single most latency-sensitive screen after `_layout`. **Android:** biometric via `expo-local-authentication` (BiometricPrompt); duress PIN wipes to a decoy vault. **iOS:** same API maps to Face ID / Touch ID (`NSFaceIDUsageDescription` already declared). ⚠️ **App Store risk:** `duresspin` + `decoy-chats` + stealth-mode-behind-calculator are *hidden alternate functionality* — App Review Guideline **2.3.1**. See §6.6.

---

## 2.2 Messaging — 26 screens

| Screen | LOC | Purpose | Entry ← | Exits → | Capabilities |
|---|---|---|---|---|---|
| `(tabs)/chats` | 753 | Chat list (WhatsApp-style), archive, swipe actions | Tab bar (default) | `/chat` `/story-viewer` `/voicecall` `/videocall` `/contact-info` `/group-info` | `API` `SQL` `ASYNC` `SOCK` `P2P` `NOTIF` |
| `chat` | **4,472** | **The message thread.** Text, media, voice, polls, reactions, replies, forward, VaultBeam, view-once, invisible ink, disappearing, lock | `(tabs)/chats`, deep link, notification, search | 17 routes incl. `/videocall` `/voicecall` `/media-viewer` `/create-poll` `/group-info` | `API` `SQL` `SOCK` `P2P` `ENC` `NOTIF` `CAM` `MIC` `MED` `BIO` `FILE` `NAT` `⚠A` `⚠I` |
| `group-chat` | 43 | Legacy redirect → `/chat` | legacy links | `/chat` | — |
| `new-chat` | 180 | "New chat" search + action rows | `(tabs)/chats` FAB | `/chat` `/create-group` `/contacts` | `API` `⚠I` |
| `create-group` | 230 | Create a group chat | `new-chat` | `/chat` | `API` |
| `group-info` | 556 | Group detail: members, media, settings | `chat` header | `/media-gallery` `/group-admin` `/invite-link` | `API` `CACHE` `CAM` `MED` |
| `group-admin` | 482 | Admin controls: roles, permissions, removal | `group-info` | back | `API` `⚠A` |
| `invite-link` | 222 | Generate/revoke group invite links | `group-info` | back | `API` |
| `join/[code]` | 109 | Redeem an invite link | Deep link `vaultchat://join/…` | `/chat` | `API` |
| `communities` | 228 | Communities: umbrella over group chats | `new-chat`, `dashboard` | `/chat` | `API` `CACHE` |
| `broadcast` | 326 | Broadcast **text** channels (Telegram-style posts) | `(tabs)/chats` header, `chat` | back | `API` `SOCK` `CACHE` |
| `creator-channels` | 18 | **Redirect** → `/broadcast` (old fake-monetization screen removed) | legacy | `/broadcast` | — |
| `msgrequests` | 268 | Message requests from unknown senders | Settings | `/chat` | `ASYNC` |
| `hidden-chats` | 305 | PIN-gated hidden conversations | Settings, long-press | `/chat` | `API` |
| `archived` *(inside `(tabs)/chats`)* | — | Archived chats (not a separate route) | chat list | — | — |
| `in-chat-search` | 257 | On-device search inside one chat | `chat` menu | back (jump to msg) | `API` |
| `search` | 164 | Global search: chats + messages | `(tabs)/chats` header | `/chat` | `API` `SQL` |
| `bookmarks` | 203 | Saved / starred messages | Settings | `/chat` | `API` `CACHE` |
| `schedule-message` | 230 | Compose a scheduled message | `chat` menu, `scheduled` | back | `API` |
| `scheduled` | 243 | Pending scheduled messages | Settings | `/schedule-message` | `API` `CACHE` |
| `message-reminder` | 313 | Per-message reminder (client-only) | `chat` long-press | back | `ASYNC` `NOTIF` |
| `create-poll` | 193 | Compose a poll | `chat` attach menu | back | `API` |
| `stickers` | 132 | Sticker picker | `chat` composer | back | `API` |
| `chat-themes` | 160 | Bubble colour themes | `chat` menu | back | `ASYNC` |
| `chat-wallpaper` | 273 | Per-chat / global wallpaper | `chat` menu | back | `ASYNC` `CAM` `MED` |
| `chat-export` | 222 | Export chat as text/HTML | `chat` menu, `contact` | back | `API` `FILE` |
| `chat-backup` | 227 | Encrypted chat backup (.vcbak) | Settings | back | `FILE` |

**Shared components:** `components/{MediaMessage, MessageActionSheet, ReactionPicker, SmartReplyBar, VoiceRecorder, LinkPreview, GifPicker, InvisibleInk, FormattingToolbar, VaultBeamBubble, TransferProgress, WritingAssistant}`, `components/chat/ViewerStack`, `components/ui/*`, `hooks/useChatViewers`.
**Offline:** **strong.** `lib/localDb` is the source of truth; `lib/messageQueue` (text) and `lib/mediaOutbox` (media + file copy) are durable outboxes; `lib/receipts` coalesces and re-flushes; `lib/syncEngine` does a one-pass global catch-up on reconnect.
**Encryption:** 1:1 = X3DH + Double Ratchet (`E2EE_ENABLED` + `E2EE_STRICT` both **true** — never silently sends plaintext); groups = sender keys (`GROUP_E2EE` **true**); media = per-file AES-256-GCM (`MEDIA_E2EE` **true**).
**Performance:** `chat.tsx` is the highest-traffic screen and the largest file in the repo. It already does the right things — `memo`, keyset pagination (`PAGE_SIZE = 50`), local-first reads, debounced typing/receipts. See §12.4 for why I recommend **not** refactoring it.

---

## 2.3 Calls — 9 screens

| Screen | LOC | Purpose | Entry ← | Exits → | Capabilities |
|---|---|---|---|---|---|
| `(tabs)/calls` | 251 | Call log, grouped WhatsApp-style, redial | Tab bar | `/voicecall` `/videocall` | `API` |
| `voicecall` | 405 | 1:1 audio WebRTC | `chat`, `contact-info`, `(tabs)/calls`, `(tabs)/chats`, `family-member`, `incoming-call` | back | `API` `SOCK` `RTC` `ENC` `MIC` |
| `videocall` | 653 | 1:1 video WebRTC + screen share + beautify filters | same as above | back | `API` `SOCK` `RTC` `ENC` `MIC` `CAM` `⚠A` |
| `incoming-call` | 156 | Ringing UI: Accept / Decline / call-waiting | `_layout` socket listener, FCM intent, Notifee | `/voicecall` `/videocall` `/group-call-active` | `SOCK` `NOTIF` |
| `group-calls` | 156 | Group call hub: member list + start | ❌ **no entry point in the app** | `/group-call-active` `/voicecall` `/videocall` | `API` `SOCK` |
| `group-call-active` | 260 | **Real full-mesh** group call (≤5, server-enforced) | `group-calls`, `incoming-call` | back | `API` `SOCK` `RTC` `ENC` `MIC` `CAM` |
| `call-recording` | 611 | Records the **device mic** via expo-av — *not* the call | ❌ **no entry point** | back | `ASYNC` `MIC` `⚠A` |
| `screen-share` | 223 | Control panel over an `Alert` stating nothing is transmitted | ❌ **no entry point** | back | `⚠I` |
| `call-reliability` | 106 | OEM battery/autostart survival guide | Settings | Android settings deep links | `⚠A` |

**Shared components:** `constants/callTheme.ts` (static dark chrome). ⚠️ `ControlBtn` is defined **twice** and `formatDuration` **three times** — no shared call component exists.
**Background:** `CallForegroundService.kt` (mic/camera FGS + partial wake lock) — Android only.
**Encryption:** `lib/callCrypto.ts` — per-call 32-byte key ratchet-wrapped **once**, then AES-256-GCM per frame. Deliberately not per-frame ratcheting (documented: signalling is lossy/bursty and would exhaust `MAX_SKIP` and break *text* decrypt). **Scope: 1:1 only.**
**Performance:** the 1 Hz `setSeconds` interval re-renders the whole screen including `RTCView` — ~600 full reconciles on a 10-minute call.
**iOS:** ❌ **the entire native layer is missing.** See §6.2 — this is the #1 iOS work item.

---

## 2.4 P2P / VaultBeam — 3 screens + in-chat surfaces

| Screen | LOC | Purpose | Entry ← | Exits → | Capabilities |
|---|---|---|---|---|---|
| `vaultdrop` | 244 | Send a large file device-to-device | `(tabs)/mini`, `chat` attach | back | `FILE` `P2P` |
| `vaultbeam-settings` | 133 | Auto-download policy (Wi-Fi / trusted / size cap) | Settings | back | `P2P` `⚠I` |
| `storage-manager` | 353 | Real on-disk usage; per-chat cleanup | Settings | `/chat` | `API` `SQL` `ASYNC` `FILE` `⚠A` |
| *in-chat* `VaultBeamBubble` + `TransferProgress` | — | Offer / accept / progress / resume, inside `chat` | `chat` | — | `P2P` `ENC` |

**Architecture (the best-engineered subsystem in the repo):** 4 tiers — LAN TCP → WebRTC data channel (`vaultBeamDirect.ts`, 456 LOC) → R2 relay (`vaultBeamTransfer.ts`) → resume. **Every file byte and all crypto stays native**; JS holds only `{blockIndex, url}`, which is how a 12 GB cap is possible without OOM. Backed by `lib/vaultBeam*` (13 modules), `plugins/android/VaultBeamStreamModule.kt` (459 LOC), the `vaultbeam-core` Rust crate, and `internal/routes/vaultbeam.go` (25 KB).
**Background:** `lib/transferForeground.ts` posts an ongoing FGS notification so minimising the app doesn't kill a multi-GB transfer. **Android only (`:26`).**
**Offline / resume:** on-disk recipient resume + a no-progress watchdog (`VB_RELIABILITY_FIXES = true`); sender resume on app kill via `resumePendingSends()` in `_layout`.
**iOS:** ⚠️ **Rust path scaffolded, unbuilt** (`build-ios-xcframework.sh` must run on macOS + Xcode; missing → iOS is relay-only). Kotlin path is Android-only. **No background transfer** — see §6.3.

---

## 2.5 Media & Files — 13 screens

| Screen | LOC | Purpose | Entry ← | Exits → | Capabilities |
|---|---|---|---|---|---|
| `media-viewer` | 365 | Universal in-app viewer (image/video/audio) | `chat`, `media-gallery`, `file-viewer` | `/file-preview` | `API` `MIC` `MED` `FILE` |
| `video-player` | 850 | Full video player: speed, PiP-style, gestures | `media-viewer`, `chat` | back | `ASYNC` `MIC` `⚠I` |
| `file-viewer` | 827 | Universal file viewer (code, docs, archives) | `chat`, `vault` | `/media-viewer` | `MIC` `FILE` `⚠I` |
| `file-preview` | 252 | Preview with syntax highlighting | `media-viewer`, `chat` | back | `FILE` |
| `media-gallery` | 297 | Per-chat media grid | `chat` menu, `group-info`, `contact-info` | `/media-viewer` | `API` `CACHE` |
| `slideshow` | 214 | Photo slideshow | `media-gallery` | back | `MED` |
| `image-editor` | 582 | Crop / rotate / draw before sending | `chat` attach | back (returns URI) | `⚠I` |
| `camera` | 232 | In-app camera (WhatsApp-style) | `chat` composer | back (returns URI) | `CAM` `MED` |
| `docscanner` | 376 | Real photo → PDF document scanner | `chat` attach, `(tabs)/mini` | back | `ASYNC` `CAM` `FILE` |
| `scanner` | 621 | QR / barcode scanner | `qr-contact`, `family-setup` | varies | `CAM` `FILE` |
| `vault` | 768 | Encrypted file vault | `(tabs)/mini`, `vault-features` | `/file-viewer` | `SEC` `ENC` `CAM` `MED` `FILE` |
| `filevault` | 16 | Redirect → `/vault` | legacy | `/vault` | `SEC` |
| `vaultcheck` | 214 | C2PA / deepfake authenticity result | `chat` long-press on media | back | — |

**Shared components:** `components/{MediaMessage, ProtectedMediaView, ProgressRing}`, `lib/{mediaStore, mediaCrypto, mediaKeyStore, thumbnails, protectedMedia, viewOnceStore, mediaCacheGC}`.
**Encryption:** `MEDIA_E2EE = true` — per-file AES-256-GCM, key inside the E2E envelope; the server stores opaque ciphertext. Receive path is tolerant (no key → direct URL) so legacy/group media still renders.
**Android:** `lib/mediaStore.ts:30` uses an Android base path and `RNFS.scanFile()` for MediaStore indexing. **iOS:** needs `PHPhotoLibrary` save + `NSPhotoLibraryAddUsageDescription` (**currently missing** — only `NSPhotoLibraryUsageDescription` is declared).

---

## 2.6 Status / Stories — 3 screens

| Screen | LOC | Purpose | Entry ← | Exits → | Capabilities |
|---|---|---|---|---|---|
| `(tabs)/status` | 529 | Stories feed + post | Tab bar | `/story-viewer` `/camera` | `API` `ASYNC` `SOCK` `ENC` `CAM` `MED` |
| `story-viewer` | 453 | Fullscreen story playback + replies | `(tabs)/status`, `(tabs)/chats`, `chat` avatar | back | `API` `MIC` |
| `status-privacy` | 128 | Who can see my status | Settings, `(tabs)/status` | back | `API` |

**Encryption:** `STORY_E2EE = true` — one content key per story, wrapped **separately per authorised viewer** over the pairwise Double Ratchet.
**Shared:** `components/StoryRing`.

---

## 2.7 Contacts & Profile — 12 screens

| Screen | LOC | Purpose | Entry ← | Exits → | Capabilities |
|---|---|---|---|---|---|
| `(tabs)/profile` | 464 | My profile, avatar, presence | Tab bar | `/settings` `/vaultid` `/qr-contact` | `API` `SOCK` `NOTIF` `CAM` `MED` `CACHE` |
| `contacts` | 331 | Contact discovery (peppered phone hash) | `new-chat`, Settings | `/chat` | `API` `CON` `⚠I` |
| `contact` | 268 | Contact card | `chat`, `contacts` | `/chat` `/voicecall` `/videocall` `/chat-export` | — |
| `contact-info` | 460 | Full contact detail + privacy | `chat` header | 7 routes incl. `/verify-contact` `/media-gallery` | `API` `ENC` `CACHE` |
| `sync-contact` | 280 | Mutual-consent contact sync | `contacts` | `/chat` | `API` `⚠I` |
| `qr-contact` | 207 | Add contact via QR | `(tabs)/profile`, `new-chat` | `/chat` | `API` `CAM` |
| `vaultid` | 436 | VaultID — discovery without a phone number | `(tabs)/profile` | back | — |
| `verify-contact` | 165 | Safety-number verification (#101) | `contact-info` | back | `API` `ENC` |
| `trusted-contacts` | 212 | Emergency / trusted contacts | `emergency-sos`, Settings | back | `API` `CACHE` |
| `blocked` *(see §2.1)* | 367 | — | — | — | — |
| `msgrequests` *(see §2.2)* | 268 | — | — | — | — |
| `decentralized-id` | 226 | W3C `did:key` self-custodied identity (Ed25519, **not** a blockchain) | `(tabs)/mini`, Settings | back | `SEC` |

**Permissions:** `READ_CONTACTS` (Android) / `NSContactsUsageDescription` (iOS, already declared).
**Privacy design:** contact sync uploads a **peppered hash**, never raw numbers.

---

## 2.8 Settings & Privacy — 21 screens

| Screen | LOC | Purpose | Entry ← | Capabilities |
|---|---|---|---|---|
| `settings` | 556 | Settings hub — the main fan-out | `(tabs)/profile` | `API` `SOCK` `P2P` `NOTIF` `BIO` `FILE` |
| `privacy-dashboard` | 509 | Privacy score + posture | Settings | `API` `ASYNC` `ENC` `BIO` `⚠A` |
| `vault-features` | 822 | Screenshot alerts, disappearing, incognito keyboard | Settings | `API` `SEC` |
| `receipt-control` | 203 | Per-contact read receipts / typing / last seen | Settings | `API` |
| `last-seen-privacy` | 135 | Last-seen & online visibility | Settings | `API` `ASYNC` `⚠A` |
| `ghost-mode` | 347 | Per-contact privacy overrides | Settings, `chat`, `contact-info` | `API` `CACHE` |
| `status-privacy` | 128 | Status audience | Settings | `API` |
| `notification-sounds` | 115 | Per-channel notification sounds | Settings | — |
| `notifications` | 264 | Notification centre / preferences | Settings, `(tabs)/alerts` | `API` `LOC` `CACHE` |
| `permissions` | 106 | Permission status + rationale | Settings, onboarding | `NOTIF` `CAM` `LOC` `CON` |
| `storage-manager` | 353 | On-disk usage + cleanup | Settings | `API` `SQL` `ASYNC` `FILE` `⚠A` |
| `offline-mode` | 448 | Offline behaviour + pending queue | Settings | `ASYNC` `⚠A` |
| `network-test` | 477 | Built-in speed test | Settings | `ASYNC` `⚠I` |
| `chat-backup` | 227 | Encrypted backup | Settings | `FILE` |
| `backup-pin` | 81 | Separate PIN for backups | `chat-backup` | `BIO` |
| `duresspin` | 192 | Duress PIN → decoy vault | `vault-features` | `/(tabs)/chats` |
| `decoy-chats` | 167 | Ghost-Protocol decoy chat list (**intentionally inert tabs**) | `lock` (duress PIN) | `/decoy-chat` |
| `decoy-chat` | 124 | Decoy conversation | `decoy-chats` | `⚠I` |
| `memoryshield` | 324 | Panic wipe / auto-destruct | Settings | `BIO` |
| `login-history` | 243 | Active sessions + remote sign-out | Settings | `API` `CACHE` |
| `d2de-status` | 105 | Encryption status explainer | Settings, `chat` | — |

**Shared:** `components/ui/*`, `lib/theme` (`useTheme()` + memoized `makeStyles(colors)` — the consistent styling pattern across the whole app).
⚠️ **iOS App Store:** `duresspin`, `decoy-chats`, `decoy-chat`, `memoryshield` (panic wipe) and stealth mode are the guideline-**2.3.1** exposure. See §6.6.

---

## 2.9 Security & Alerts — 6 screens

| Screen | LOC | Purpose | Entry ← | Capabilities |
|---|---|---|---|---|
| `(tabs)/alerts` | 229 | Security console — tamper-evident audit chain (#41) | `(tabs)/chats` header (hidden tab) | — |
| `aiguardian` | 240 | Threat/spam guardian | Settings, `(tabs)/alerts` | — |
| `emergency-sos` | 440 | SOS trigger + trusted-contact alert | `(tabs)/mini`, Settings | `API` `LOC` `⚠I` |
| `dashboard` | 222 | Security/feature dashboard | Settings, `(tabs)/mini` | `ENC` `CACHE` |
| `perf-debug` | 124 | Hidden diagnostics (`lib/perf.ts` ring buffer) | Hidden gesture | `ENC` |
| `setup-complete` | 70 | Post-setup confirmation | onboarding | `ENC` |

---

## 2.10 Family Space — 8 screens

| Screen | LOC | Purpose | Entry ← | Exits → | Capabilities |
|---|---|---|---|---|---|
| `family` | 661 | Family Space hub: roster, map, battery | `(tabs)/mini` | 7 family routes + `/chat` | `API` `ENC` `LOC` `BG` `⚠I` |
| `family-setup` | 87 | Create or join a Circle | `family` | back | `⚠I` |
| `family-add` | 241 | Add people to a Circle | `family` | back | `API` |
| `family-member` | 263 | Member detail | `family`, `family-alerts` | `/chat` `/voicecall` `/family-history` | `API` |
| `family-places` | 269 | Safe zones / geofences | `family` | back | `ENC` `LOC` `⚠I` |
| `family-alerts` | 165 | Alert inbox | `family` | `/family-member` | — |
| `family-history` | 185 | **Device-local** location history (never uploaded) | `family`, `family-member` | back | — |
| `components/family/FamilyMap` | — | Leaflet-in-WebView map | `family` | — | — |

**Background:** `lib/family/background.ts` registers an `expo-location` background task; `_layout.tsx` imports it at module scope **because a headless OS wake only runs that layout's imports** — a documented past bug.
**Encryption:** positions are E2EE `FamilyPing`s; history never leaves the device.
**Android:** `ACCESS_BACKGROUND_LOCATION` + `FOREGROUND_SERVICE_LOCATION` declared. **iOS:** `NSLocationAlwaysAndWhenInUseUsageDescription` + `UIBackgroundModes: ["location"]` declared — ✅ **this is the one background subsystem already configured for iOS.**

---

## 2.11 Location & Navigation — 6 screens

| Screen | LOC | Purpose | Entry ← | Capabilities |
|---|---|---|---|---|
| `location` | 309 | Live location sharing (full-stack) | `chat` attach | `API` `SOCK` `ENC` `LOC` |
| `location-sharing` | 272 | Sharing controls / active sessions | `chat`, Settings | `API` `SOCK` `ENC` `LOC` |
| `current-location` | 208 | One-shot current position | `(tabs)/mini`, `chat` | `API` `LOC` `⚠I` |
| `navigate` | 209 | Haptic turn-by-turn (Direction-Lock profiles) | `(tabs)/mini`, any location bubble | `LOC` `⚠I` |
| `components/nav/NavMap` + `NavBanner` | — | Map + mini-banner | `navigate` | — |
| `lib/nav/*` (12 modules) | — | Pure geodesy + haptic language + Valhalla routing | — | — |

**iOS limitation:** `lib/nav/hapticPlayer.ts:31` — *"iOS: accent only, no custom pattern."* Android honours a millisecond vibration pattern via RN `Vibration`; iOS ignores custom patterns and falls back to an `expo-haptics` impact. **The entire haptic-navigation differentiator is degraded on iOS** and needs a Core Haptics (`CHHapticEngine`) implementation to reach parity. See §6.4.

---

## 2.12 Mini-Apps hub — 5 screens + Finance (16) + Shop Book (1)

| Screen | LOC | Purpose | Entry ← | Exits → | Capabilities |
|---|---|---|---|---|---|
| `(tabs)/mini` | 679 | Mini-apps hub (raised centre tab button) | Tab bar | `/vaultlens` `/navigate` `/family` `/finance` `/shop-book` `/encrypted-notes` `/docscanner` `/aiguardian` `/decentralized-id` | `ASYNC` `CAM` |
| `encrypted-notes` | 714 | Encrypted notes vault + attachments | `(tabs)/mini` | back | `ASYNC` `ENC` `CAM` `MED` `BIO` `FILE` `⚠I` |
| `vaultlens` | 274 | AI media generation (home) | `(tabs)/mini` | `/vaultlens-result` | `ASYNC` `CAM` `MED` |
| `vaultlens-result` | 185 | Generated result + actions | `vaultlens` | back | `API` `MED` `FILE` |
| `whiteboard` | 169 | Drawing / annotation canvas | ❌ **no entry point** | back | — |
| `shop-book` | **2,266** | Shop Book mini-app (2nd largest file) | `(tabs)/mini` | back | `LOC` `MIC` `⚠A` `⚠I` |
| `finance/*` **(16 routes)** | 2,069 total | Vault Finance: dashboard, ledger (5), chitti (3), interest, EMI, reminders, reports, calendar, saved, search, import/export | `(tabs)/mini` → `finance/index` | internal | `SQL` (own DB) `FILE` `⚠I` |
| `interest-calculator` | 12 | Redirect → `/finance` | legacy | `/finance` | — |
| `meeting-scheduler` | 807 | NL date parsing meeting scheduler | ❌ **no entry point** | back | `ASYNC` |
| `voice-transcribe` | 162 | On-device dictation | `chat` composer | back | `API` `MIC` |
| `voice-effects` | 199 | Voice effects | ❌ **no entry point** | back | `ASYNC` `MIC` |
| `voice-speed` | 202 | Playback speed | `media-viewer`, `chat` audio bubble | back | `MIC` |
| `email-bridge` | 738 | File → email bridge | Settings | back | — |

**Finance / Shop Book note:** entirely **on-device SQLite** (`db/financeDb.ts`, separate DB file from messaging) with no backend. Fully offline. Cross-platform clean — no native modules, no platform guards beyond safe-area padding.

---

## 2.13 System / Infrastructure routes — 4

| Route | LOC | Purpose |
|---|---|---|
| `_layout` | 437 | Root layout: Sentry, fonts, theme, security scan, E2EE provisioning, FCM register, socket listeners, notification handlers, ~120 `<Stack.Screen>` declarations |
| `(tabs)/_layout` | 117 | 5 visible tabs + hidden `alerts`; raised centre "Apps" button; unread badge |
| `finance/_layout` | 32 | Finance sub-stack |
| `add/[...segments]` | 95 | Deep-link handler `vaultchat://add/<vaultId>/<name>` |
| `components/ErrorBoundary` | 41 | Route-level error boundary (component, not a route) |

---

## 2.14 Unreachable screens — built but dark

Confirmed by reference analysis (their **only** mention is the `<Stack.Screen>` registration in `_layout.tsx`). `git show 6198e96` records these as "not wired, on purpose".

| Screen | LOC | Assessment |
|---|---|---|
| `group-calls` | 156 | ✅ **Real, working code.** Ships dark. Cheapest user-visible win in the repo |
| `group-call-active` | 260 | ✅ Real mesh call — reachable only *via* `group-calls` |
| `meeting-scheduler` | 807 | ✅ Real, self-contained. Needs a home |
| `whiteboard` | 169 | ✅ Real. Belongs in the chat attach menu |
| `voice-effects` | 199 | ⚠️ Belongs in the call/voice-note surface |
| `call-recording` | 611 | ❌ **Misleading** — records the device mic, not the call |
| `screen-share` | 223 | ❌ **Misleading** — panel over an `Alert` saying nothing is transmitted |

**Total: 2,425 LOC unreachable**, of which ~834 LOC is actively misleading.

---

# 3. Navigation Flow

## 3.1 Cold-start / authentication spine

```
App launch
   ↓
app/_layout.tsx  ── Buffer polyfill → Sentry → localDb warm-up → FLAG_SECURE
   │                → runSecurityCheck() (async, NOT awaited)
   │                → E2EE provisioning + registerForCalls()
   │                → socket listeners + notification handlers
   ↓
app/index.tsx  (cold-start router)
   ├── threat detected ──────────────────► /blocked   [terminal, gesture-disabled]
   ├── no account ──────► /onboard ──► /email-verify ──► /onboard-profile
   │                                          ↓
   │                          /onboard-security ──► /onboard-mpin ──► /onboard-success
   │                                                                       ↓
   │                                                        [optional] /biometric-setup
   │                                                                       ↓
   ├── account, locked ──► /lock  or  /app-lock ──────────────────────────►│
   │        └── duress PIN ──► /decoy-chats ──► /decoy-chat  [decoy world]  │
   ├── existing, new device ──► /mpin-entry ──► /mpin-recover               │
   │                            └── /face-verify-new-device ────────────────►│
   └── account, unlocked ───────────────────────────────────────────────────►
                                                                             ↓
                                                                   /(tabs)/chats
```

## 3.2 Main tab shell

```
                        ┌──────────── (tabs)/_layout ────────────┐
                        │  Chats · Status · [APPS] · Calls · Profile │
                        │  (alerts = hidden route, href:null)     │
                        └────────────────────────────────────────┘
   ┌──────────┬──────────┬────────────────┬──────────┬──────────────┐
   ▼          ▼          ▼                ▼          ▼              ▼
 chats     status      mini             calls     profile       alerts (hidden,
   │          │          │                │          │           from chats header)
   │          │          │                │          │
   │          ▼          ▼                ▼          ▼
   │    story-viewer  9 mini-apps   voicecall/    settings
   │    status-privacy               videocall    vaultid
   │                                     │        qr-contact
   ▼                                     │        decentralized-id
 /chat  ◄── deep link · notification tap · search · contacts · join/[code]
```

## 3.3 The chat hub (17 outbound routes — the busiest node)

```
                                    /chat
   ┌────────────┬────────────┬────────┼────────┬────────────┬────────────┐
   ▼            ▼            ▼        ▼        ▼            ▼            ▼
 header      composer     attach   long-press  menu      bubble tap   avatar tap
   │            │            │        │          │            │            │
 voicecall   voice-       camera   message-   chat-        media-      story-viewer
 videocall   transcribe   image-   reminder   wallpaper    viewer      contact-info
 contact-    stickers     editor   vaultcheck chat-themes  file-
 info        GifPicker    docscan  forward→   ghost-mode   preview
 group-info               location schedule-  group-info
                          create-  message    in-chat-
                          poll                search
                          VaultBeam           chat-export
```

## 3.4 Call flow (all three entry paths)

```
 A. FOREGROUND         B. BACKGROUNDED (socket alive)   C. KILLED (Android only)
 ────────────          ─────────────────────────────    ───────────────────────
 socket                socket 'call_incoming'           FCM data-only push
 'call_incoming'              ↓                                 ↓
       ↓                displayIncomingCall()          VaultCallMessagingService
 ringTracker de-dupe    (Notifee full-screen intent)    .onMessageReceived  [NO JS]
       ↓                       ↓                                ↓
 /incoming-call         Answer / Decline action         wake screen + start FGS
       │                       ↓                        + CATEGORY_CALL FSI notif
       │                _layout notifee handler                 ↓
       │                       ↓                        tap → getInitialCallIntent()
       └───────────────────────┴────────────────────────────────┘
                                ↓
              /voicecall  |  /videocall  |  /group-call-active
                                ↓
              teardown → addCallLog() → back → /(tabs)/calls
```
> **Path C does not exist on iOS.** Paths A and B are also broken on iOS because
> `lib/callNotification.ts` returns early on non-Android. See §6.2.

## 3.5 Settings fan-out (21 destinations)

```
(tabs)/profile → settings
   ├─ PRIVACY & SECURITY  → vault-features · privacy-dashboard · receipt-control
   │                        last-seen-privacy · memoryshield · ghost-mode
   │                        status-privacy · d2de-status · login-history
   ├─ DATA & ACCOUNT      → msgrequests · storage-manager · offline-mode
   │                        chat-backup → backup-pin · bookmarks · scheduled
   ├─ CHAT                → chat-themes · chat-wallpaper · app-lock-chats · hidden-chats
   ├─ CALLS               → call-reliability
   ├─ NOTIFICATIONS       → notification-sounds · notifications · permissions
   ├─ TRANSFERS           → vaultbeam-settings
   └─ NETWORK             → network-test
```

## 3.6 Full navigation map (condensed)

```
launch → _layout → index ──┬─ blocked
                           ├─ onboard → email-verify → onboard-profile → onboard-security
                           │            → onboard-mpin → onboard-success → biometric-setup
                           ├─ lock / app-lock ─┬─ (duress) decoy-chats → decoy-chat
                           ├─ mpin-entry → mpin-recover / face-verify-new-device
                           └──────────────────► (tabs)
(tabs) ─┬─ chats ─┬─ chat ─┬─ [17 routes: calls, media, poll, info, search, export …]
        │         ├─ new-chat → create-group / contacts / qr-contact
        │         ├─ search → chat
        │         ├─ broadcast / communities / archived
        │         └─ alerts → aiguardian / notifications
        ├─ status → story-viewer / status-privacy / camera
        ├─ mini ─┬─ vaultlens → vaultlens-result
        │        ├─ navigate · family → [7 family routes]
        │        ├─ finance → [16 finance routes]
        │        ├─ shop-book · encrypted-notes · docscanner
        │        ├─ vaultdrop · emergency-sos · decentralized-id · aiguardian
        ├─ calls → voicecall / videocall / incoming-call
        │          [group-calls → group-call-active — UNREACHABLE]
        └─ profile → settings → [21 routes] · vaultid · qr-contact
deep links: vaultchat://add/<id>/<name> → add/[...segments] → chat
            vaultchat://join/<code>     → join/[code]        → chat
notification tap → chat  |  call push → incoming-call
```

---

# 4. Screen Categories

| Category | Count | Screens |
|---|---|---|
| **Authentication & Onboarding** | 17 | index, onboard, email-verify, onboard-profile, onboard-security, onboard-mpin, onboard-success, mpin-entry, mpin-recover, security-questions, lock, app-lock, app-lock-chats, biometric-setup, facescan, face-verify-new-device, blocked |
| **Messaging** | 26 | (tabs)/chats, chat, group-chat, new-chat, create-group, group-info, group-admin, invite-link, join/[code], communities, broadcast, creator-channels, msgrequests, hidden-chats, in-chat-search, search, bookmarks, schedule-message, scheduled, message-reminder, create-poll, stickers, chat-themes, chat-wallpaper, chat-export, chat-backup |
| **Calls** | 9 | (tabs)/calls, voicecall, videocall, incoming-call, group-calls, group-call-active, call-recording, screen-share, call-reliability |
| **P2P / VaultBeam** | 3 | vaultdrop, vaultbeam-settings, storage-manager |
| **Media & Files** | 13 | media-viewer, video-player, file-viewer, file-preview, media-gallery, slideshow, image-editor, camera, docscanner, scanner, vault, filevault, vaultcheck |
| **Status / Stories** | 3 | (tabs)/status, story-viewer, status-privacy |
| **Contacts & Profile** | 12 | (tabs)/profile, contacts, contact, contact-info, sync-contact, qr-contact, vaultid, verify-contact, trusted-contacts, decentralized-id, msgrequests*, blocked* |
| **Settings & Privacy** | 21 | settings, privacy-dashboard, vault-features, receipt-control, last-seen-privacy, ghost-mode, status-privacy*, notification-sounds, notifications, permissions, storage-manager*, offline-mode, network-test, chat-backup*, backup-pin, duresspin, decoy-chats, decoy-chat, memoryshield, login-history, d2de-status |
| **Security & Alerts** | 6 | (tabs)/alerts, aiguardian, emergency-sos, dashboard, perf-debug, setup-complete |
| **Family Space** | 8 | family, family-setup, family-add, family-member, family-places, family-alerts, family-history, (FamilyMap) |
| **Location & Navigation** | 4 | location, location-sharing, current-location, navigate |
| **Mini-Apps** | 12 | (tabs)/mini, encrypted-notes, vaultlens, vaultlens-result, whiteboard, meeting-scheduler, voice-transcribe, voice-effects, voice-speed, email-bridge, interest-calculator, shop-book |
| **Finance sub-app** | 16 | index, ledger/{index,new,[id],edit,update}, chitti/{index,new,[id]}, customer, interest, emi, reminders, reports, calendar, saved, search, io |
| **System / Layout** | 4 | _layout, (tabs)/_layout, finance/_layout, add/[...segments] |

*\* screen counted in two categories; the deduplicated route total is **147**.*

---

# 5. Android Compatibility Review

**Verdict: fully supported. Android is the reference platform.** Every feature works; the
issues are polish, reachability and size — not capability.

## 5.1 Supported / native functionality

| Subsystem | Android implementation | Status |
|---|---|---|
| Incoming calls (killed app) | `VaultCallMessagingService.kt` — real `FirebaseMessagingService`; data-only high-priority FCM starts the process with **no RN runtime**, wakes the screen, starts the FGS, posts a `CATEGORY_CALL` full-screen-intent notification with caller name + DP (async, initials fallback) + Answer/Decline | ✅ Production |
| Background call audio | `CallForegroundService.kt` — `foregroundServiceType="microphone\|camera"`, partial wake lock, `startForeground()` inside the 5 s window | ✅ Production |
| Screen capture blocking | `FLAG_SECURE` app-wide via `expo-screen-capture` + `VaultViewGuard` | ✅ Real blocking |
| Screen share in call | `getDisplayMedia()` → `sender.replaceTrack()` — no renegotiation, stays P2P + DTLS-SRTP | ✅ Real |
| VaultBeam large transfer | `VaultBeamStreamModule.kt` (459 LOC) + Rust JNI + `transferForeground.ts` FGS | ✅ 12 GB cap |
| Rust crypto | `withCryptoCore.js` → cargo-ndk → `libvaultcrypto.so` via CMake + Nitro JSI. **Degrades to TS if the toolchain is absent** | ✅ |
| No-GMS devices | `withVaultChatSync.js` + `backgroundConnection.ts` — Notifee `dataSync` FGS keeps the socket alive on Huawei etc. | ✅ Genuine differentiator |
| Scheduled messages | `scheduledRunner.ts` + Notifee triggers, re-armed on boot | ✅ |
| OEM survival | `batteryOptimization.ts` deep-links MIUI / ColorOS / FuntouchOS / Honor / Samsung panels; `call-reliability.tsx` guides the user | ✅ Best-in-class |
| Native ringtone | `CallModule.playSystemRingtone()` | ✅ |
| Haptic navigation | RN `Vibration` millisecond patterns | ✅ Full fidelity |

## 5.2 Permissions declared (`app.json`, 27) + plugin-added (10)

`CAMERA` · `RECORD_AUDIO` · `INTERNET` · `ACCESS_NETWORK_STATE` · `MODIFY_AUDIO_SETTINGS` ·
`BLUETOOTH` · `BLUETOOTH_CONNECT` · `USE_FULL_SCREEN_INTENT` · `FOREGROUND_SERVICE` ·
`FOREGROUND_SERVICE_DATA_SYNC` · `WAKE_LOCK` · `SYSTEM_ALERT_WINDOW` · `VIBRATE` ·
`RECEIVE_BOOT_COMPLETED` · `POST_NOTIFICATIONS` · `USE_BIOMETRIC` · `USE_FINGERPRINT` ·
`READ_CONTACTS` · `ACCESS_FINE_LOCATION` · `ACCESS_COARSE_LOCATION` · `READ/WRITE_EXTERNAL_STORAGE` ·
`NFC` · `ACCESS_BACKGROUND_LOCATION` · `FOREGROUND_SERVICE_LOCATION` · `ACTIVITY_RECOGNITION`
**+ plugin:** `FOREGROUND_SERVICE_MICROPHONE` · `FOREGROUND_SERVICE_CAMERA` ·
`FOREGROUND_SERVICE_MEDIA_PROJECTION` · `REQUEST_IGNORE_BATTERY_OPTIMIZATIONS` · `DISABLE_KEYGUARD`

**Play Store risk flags:**
- `SYSTEM_ALERT_WINDOW` — restricted; Play requires a declared, justified use. **Verify it is actually used**; if not, remove it.
- `READ/WRITE_EXTERNAL_STORAGE` — legacy; scoped storage means these are ignored on API 33+ and may trigger review questions. Should be scoped or dropped.
- `NFC` — I found **no NFC usage** in the client. Likely removable.
- `ACCESS_BACKGROUND_LOCATION` — requires a Play Console declaration + a demo video (Family Space justifies it, but the paperwork is mandatory).
- `REQUEST_IGNORE_BATTERY_OPTIMIZATIONS` — Play restricts this to apps with a qualifying core use case; calls/VoIP qualify, but it must be declared.

## 5.3 Background behaviour

| Mechanism | Where | Notes |
|---|---|---|
| Call FGS (mic/camera) | `CallForegroundService.kt` | Survives Doze via partial wake lock |
| Transfer FGS | `transferForeground.ts` | Shares a refcount with `backgroundConnection` — **they must not be started independently** |
| Socket FGS (dataSync) | `backgroundConnection.ts` | No-GMS devices only |
| Location background task | `lib/family/background.ts` | Registered at module scope in `_layout` (headless wakes only run those imports) |
| Notifee background events | `lib/callBackground.ts` | Registered at JS-load time so it fires on a headless launch |
| FCM cold start | `VaultCallMessagingService.kt` | No JS involved |

## 5.4 Android weaknesses (all fixable, none architectural)

1. Three duplicated WebRTC implementations (§7.6).
2. 2,425 LOC of unreachable screens, 834 of it misleading (§2.14).
3. ~570 LOC of dead client code with **zero importers**: `services/webrtcService.ts` (212, a *simulated* call service), `constants/webrtcService.ts` (48), `utils/encryption.ts` (91), `services/encryptionService.ts`, plus `constants/memoryShield.ts.bak` committed to VCS.
4. 5 npm packages with **zero JS imports**: `firebase`, `@react-native-firebase/{app,auth,firestore,storage}`, `expo-gl` → pure APK weight. (Native `com.google.firebase:firebase-messaging` in Gradle **must stay** — it is what makes cold-start ringing work.)
5. `react-native.config.js` contains an autolinking override for `react-native-pdf-thumbnail`, **which is not in `package.json`** — inert config.
6. 1 Hz whole-screen re-render during every call (§11.1).

---

# 6. iOS Compatibility Review

**Verdict: the app will build and launch on iOS, and most screens will work. But every
background, call, and native-performance capability is missing, and there are two App Store
approval risks that must be resolved before submission.**

## 6.1 iOS status by subsystem

| Subsystem | iOS status | Detail |
|---|---|---|
| UI / navigation / theming | ✅ **Works** | expo-router, Reanimated, gesture-handler, safe-area — all cross-platform. `components/ui/icon-symbol.ios.tsx` already exists (SF Symbols variant) |
| Messaging, chat, sync, offline queues | ✅ **Works** | 100% TypeScript; op-sqlite, AsyncStorage, SecureStore→Keychain all supported |
| E2EE (X3DH, ratchet, sender keys, media, stories) | ✅ **Works** — ⚠️ **TS backend only** | `withCryptoCore.js` has **zero iOS handling**; iOS silently uses the TypeScript crypto. Vector-proven identical, but slower on large media |
| 1:1 WebRTC call **while in foreground** | ✅ Should work | `react-native-webrtc` + `react-native-incall-manager` both support iOS |
| 1:1 call **backgrounded** | ❌ **Broken** | No FGS equivalent; `startCallForeground()` is a no-op. Needs CallKit + `AVAudioSession` |
| 1:1 call **killed app** | ❌ **Broken** | No PushKit; no VoIP ring |
| Incoming-call UI | ❌ **Broken** | `lib/callNotification.ts:22` returns early on non-Android |
| Group mesh call | ❌ Same as above | Plus it is unreachable on both platforms |
| VaultBeam ≤ ~2 GB | ⚠️ Partial | Rust iOS bridge scaffolded (`VaultBeamStreamRust.swift`, `build-ios-xcframework.sh`), **but the xcframework is not built** → JS-heap fallback |
| VaultBeam > 2 GB / background | ❌ **Broken** | No FGS; iOS suspends after ~30 s. Needs `URLSession` background transfer |
| Push notifications (messages) | ⚠️ **Unconfigured** | `expo-notifications` supports APNs, but no APNs key/cert, no `aps-environment` entitlement, no `eas.json` iOS profile |
| Scheduled messages | ❌ `scheduledRunner.ts:22` Android-only | Needs `UNNotificationRequest` + a send-on-foreground fallback |
| Family Space background location | ✅ **Configured** | `NSLocationAlwaysAndWhenInUse…` + `UIBackgroundModes: ["location"]` declared. The one background feature ready for iOS |
| Screenshot protection | ⚠️ **Detect-only by design** | `lib/screenGuard.ts` models this honestly: Android blocks (FLAG_SECURE), iOS detects (`UIScreen.isCaptured`) and refuses to decrypt while capture is live. **Correct — do not "fix" it** |
| VaultView protected media | ✅ **Implemented** | `VaultViewGuard.swift` + `VaultViewMedia.swift` + podspec, wired by `withVaultView.js` |
| Haptic navigation | ⚠️ **Degraded** | `hapticPlayer.ts:31` — iOS gets an impact accent, not the pattern language. Needs Core Haptics |
| Native ringtone | ❌ | `sounds.ts:18` gates on Android; iOS falls back to `expo-av` |
| No-GMS socket keep-alive | ➖ **N/A** | Correct — iOS forbids persistent background sockets. Push is the answer |
| Battery-optimisation deep links | ➖ **N/A** | Correct — iOS has no equivalent |
| Media save to library | ⚠️ | `mediaStore.ts` uses Android paths + `RNFS.scanFile`. iOS needs `PHPhotoLibrary` and **`NSPhotoLibraryAddUsageDescription` is not declared** |
| Finance / Shop Book / notes / mini-apps | ✅ **Works** | Pure TS + SQLite |

## 6.2 iOS blocker #1 — Calls (the critical path)

**Why it is different:** Android permits a foreground service that keeps mic/camera alive and a
`FirebaseMessagingService` that runs from a cold start with no JS. iOS permits **neither**. The
only sanctioned way to receive a call on iOS is **PushKit VoIP push → `CXProvider.reportNewIncomingCall()`
reported *immediately***; if you fail to report, iOS revokes the app's VoIP privileges.

**Required changes:**
1. **PushKit registration** — `PKPushRegistry` with `desiredPushTypes = [.voIP]`; register the VoIP token to a new `POST /call/token` platform (`ios-voip`).
2. **CallKit provider** — `CXProvider` + `CXProviderDelegate`; report the incoming call synchronously in `didReceiveIncomingPushWith`; start WebRTC audio in `provider(_:didActivate:)`.
3. **Backend** — the Go `internal/fcm` sender must gain an **APNs VoIP** path (`apns-push-type: voip`, VoIP certificate). Today `calls.go` only reads `devices.fcm_token`.
4. **`lib/CallService.ts`** — `has()` must become a platform-dispatched adapter, not an Android gate.
5. **`lib/callNotification.ts`** — CallKit replaces the Notifee full-screen intent on iOS.
6. **Audio session** — `AVAudioSession` category `.playAndRecord`, mode `.voiceChat`, activated by CallKit.

**Skeleton already written:** `CALLS_README.md` §iOS contains the `AppDelegate.swift` PushKit/CallKit
glue. It has never been applied — the file says so.
**Prerequisites you must provide:** an Apple Developer account, a **VoIP push certificate**, and an APNs auth key.
**Best approach:** implement it as `plugins/withVaultChatCallsIOS.js` + Swift sources under
`plugins/calls-ios/`, mirroring the existing `withVaultView.js` pattern (Android + iOS in one plugin, iOS skipped when the template is absent). **Do this after the call engine is consolidated** (§13 Phase 2) so it is written once, not three times.

## 6.3 iOS blocker #2 — Background transfer

VaultBeam's Android design (foreground service + native byte pipeline) has no iOS analogue.
**Approach:** `URLSession` with `background` configuration and per-block upload/download tasks —
iOS will continue them after suspension and relaunch the app on completion. This maps cleanly
onto VaultBeam's existing **block-indexed** model (`{blockIndex, url}`), which is the reason it
is feasible at all. **Constraint:** background `URLSession` is file-based and does not allow
arbitrary in-flight computation, so the per-chunk AES-GCM must happen at block-write time
(which the Rust core already does).

## 6.4 iOS blocker #3 — Haptic navigation parity

`lib/nav/hapticLanguage.ts` defines a full vibration *language* (Direction-Lock profiles). iOS
ignores custom `Vibration` patterns. **Approach:** a `CHHapticEngine` module that translates each
`HapticPattern` into a `CHHapticPatternPlayer`. The pattern data is already pure and
platform-neutral — only the player is per-platform, which the module header anticipates.

## 6.5 iOS Info.plist — declared vs. required

**Declared today:** `NSCameraUsageDescription`, `NSMicrophoneUsageDescription`,
`NSSpeechRecognitionUsageDescription`, `NSFaceIDUsageDescription`, `NSContactsUsageDescription`,
`NSLocationWhenInUse…`, `NSPhotoLibraryUsageDescription`, `NSLocationAlwaysAndWhenInUse…`,
`NSLocationAlways…`, `NSMotionUsageDescription`, `UIBackgroundModes: ["location"]`
*(+ `voip`, `audio`, `remote-notification` injected by `withVaultChatCalls.js`)*.

**Missing / required before submission:**
| Key | Needed by |
|---|---|
| `NSPhotoLibraryAddUsageDescription` | Saving media to the library (`mediaStore`, `media-viewer`, `vaultlens-result`) |
| `NSBluetoothAlwaysUsageDescription` | Bluetooth audio routing in calls |
| `NSLocalNetworkUsageDescription` + `NSBonjourServices` | **VaultBeam LAN tier** (`vaultbeam-core/src/lan.rs`) — iOS 14+ hard-requires this |
| `NSFaceIDUsageDescription` | ✅ present |
| `aps-environment` entitlement | APNs (messages **and** VoIP) |
| `UIBackgroundModes: fetch`, `processing` | Background sync / transfer completion |
| `ITSAppUsesNonExemptEncryption` / export-compliance docs | **Mandatory** — this app ships strong non-exempt crypto |

Also missing: **no `ios` block in `eas.json`** — no bundle identifier config, no credentials, no
submit profile. iOS has never been built through EAS.

## 6.6 App Store review considerations ⚠️

| Risk | Guideline | Assessment | Mitigation |
|---|---|---|---|
| **Duress PIN → decoy vault; Ghost Protocol decoy chats** | **2.3.1 Hidden features** | **High.** Apple rejects apps with functionality not disclosed in review. The feature is legitimate (documented anti-coercion), but it must not look concealed | Document it explicitly in App Review notes; provide reviewer credentials for both the real and decoy PIN; surface it as a *named, discoverable* Settings feature rather than a secret |
| **Stealth mode (hide app behind a calculator)** | **2.3.1 / 4.3** | **High — likely rejection.** Disguising the app is exactly the pattern Apple removes | **Recommend disabling stealth-mode on iOS** rather than fighting it |
| **Panic wipe / auto-destruct (`memoryshield`)** | 2.3.1 | Medium | Disclose in review notes; make it user-initiated and clearly labelled |
| **Strong encryption** | Export compliance | Certain | Set `ITSAppUsesNonExemptEncryption`; France requires a separate declaration |
| **`ACCESS_BACKGROUND_LOCATION` analogue (Always location)** | 5.1.1 | Medium | Family Space justifies it; must show clear in-app rationale before the prompt |
| **VoIP background mode without CallKit** | 4.5 / VoIP policy | Certain rejection today | `withVaultChatCalls.js` already declares `UIBackgroundModes: [voip]` **but no CallKit exists.** Declaring `voip` without using PushKit/CallKit is a rejection trigger. **Either implement §6.2 or remove the `voip` mode before submitting** |
| **Duplicate/placeholder screens** (`screen-share.tsx` admitting nothing is transmitted) | 2.1 / 4.2 | Medium | Remove or complete before submission |

> **The `voip` background mode without CallKit is the single most likely immediate rejection.**
> It is declared today by `plugins/withVaultChatCalls.js:withIosVoip`.

## 6.7 Android vs iOS difference summary

| Behaviour | Android | iOS | Why | Best approach |
|---|---|---|---|---|
| Killed-app call ring | FCM data-only + `FirebaseMessagingService`, no JS | Impossible | Android allows background process start; iOS does not | PushKit VoIP → CallKit, reported immediately |
| Background call audio | Foreground service | No FGS | Platform model | CallKit + `AVAudioSession` |
| Persistent socket | Notifee `dataSync` FGS | Forbidden | iOS suspends the app | APNs push-to-wake; never a background socket |
| Screenshot | Block (FLAG_SECURE) | Detect only | Apple provides no FLAG_SECURE | Already modelled correctly in `screenGuard.ts` |
| Big-file background transfer | FGS + native pipeline | Suspended | Platform model | Background `URLSession` |
| Custom vibration patterns | Full | Ignored | RN `Vibration` limitation | Core Haptics |
| Battery-optimisation whitelist | Deep-linkable | None | Platform model | N/A — correctly no-op |
| Native crypto | Rust via JNI | Not wired | Plugin gap | Add an iOS branch to `withCryptoCore.js` (xcframework, same as VaultBeam) |
| Ringtone | System ringtone API | Restricted | Platform model | Bundled audio via `expo-av` (already the fallback) |
| Media save | MediaStore + `scanFile` | PhotoKit | Platform model | `expo-media-library` (already a dependency) |

---

# 7. Current Architecture Review

## 7.1 Strengths

1. **Local-first data model.** `lib/localDb.ts` (op-sqlite) is the UI's source of truth; delta-sync reconciles. Opening a chat is a local read. This is the Signal/WhatsApp model, done properly.
2. **Durable everything.** `messageQueue` (text), `mediaOutbox` (media + a file copy), `receipts` (coalesced, re-flushed), `syncEngine` (one-pass global catch-up). Offline behaviour is genuinely strong.
3. **Crypto that is proven, not claimed.** Dual TS + Rust implementations, byte-identical, verified by frozen JSON vectors and parity self-tests (`npm run test:e2ee` runs 8 suites).
4. **VaultBeam.** The 4-tier transfer architecture with all bytes native is the best-engineered subsystem in the repo and the model everything else should follow.
5. **Honest platform modelling.** `screenGuard.ts` and `hapticPlayer.ts` document asymmetry instead of pretending parity. `withCryptoCore.js` degrades silently rather than failing the build.
6. **Real Android depth.** Cold-start FCM, foreground services, OEM survival, IPv6-first ICE for CGNAT carriers — these come from real field experience, not a tutorial.
7. **Consistent styling pattern.** `useTheme()` + `const S = useMemo(() => makeStyles(colors), [colors])` used across ~150 screens.
8. **Backend consolidation is done.** Go owns all 18 REST modules + Socket.IO; Node is workers only.
9. **Documented decisions.** `ARCHITECTURE.md`, `PHASE6_NOTES.md`, `docs/GAP_CLOSURE_PLAN.md` and detailed file headers explain *why*, including what was deliberately **not** shipped.

## 7.2 Weaknesses

| # | Weakness | Evidence |
|---|---|---|
| W1 | Three duplicated WebRTC implementations | §1.3 — 1,318 LOC |
| W2 | Call state is React component state | 1 Hz re-render of the whole screen |
| W3 | No server-side call session (`callId === chatId`, no `calls` table) | `CallService.ts:58`, `calls.go` |
| W4 | Call log is device-local AsyncStorage, 300-entry cap | `lib/callLog.ts` |
| W5 | Group-call signalling has no E2EE key-agreement ordering guarantee | `callCrypto.ts` scope note |
| W6 | 2,425 LOC unreachable; 834 LOC actively misleading | §2.14 |
| W7 | ~570 LOC dead code + 5 dead npm packages | §5.4 |
| W8 | `app/chat.tsx` = 4,472 LOC; `app/shop-book.tsx` = 2,266 | file sizes |
| W9 | `tsconfig`: `strict: false`, `strictNullChecks: false` | causes `(pc as any)` throughout the call path |
| W10 | **iOS native layer absent** | §6 |
| W11 | Stale docs: `CODEBASE_ANALYSIS.md` (49 KB) describes a Firebase architecture that was deleted; `ARCHITECTURE.md` misstates E2EE flags and lists TensorFlow.js (not a dependency) | verified against `constants/flags.ts` and `package.json` |

## 7.3 Performance issues

| Issue | Location | Impact |
|---|---|---|
| 1 Hz full-screen re-render during calls | `voicecall.tsx:166`, `videocall.tsx:262` | ~600 reconciles per 10-min call, `RTCView` included |
| Mesh peer-map cloning | `group-call-active.tsx` `setPeers({...prev})` | every tile re-renders on any peer change |
| TURN fetched per call screen mount | all three call screens | extra RTT before ICE starts |
| Ring/answer re-emit loops | 9 ring + 5 answer emits, unconditional timers | radio wake-ups while ringing |
| `_layout` boots 9 subsystems in one `useEffect` | `_layout.tsx:76-273` | cold-start cost (the async security-scan fix already proved this class is worth ~1.4 s) |
| Two dead call services parsed at startup | `services/webrtcService.ts`, `constants/webrtcService.ts` | Hermes bytecode for code never executed |
| `chat.tsx` module size | 4,472 LOC | first-chat-open parse/eval |
| No adaptive bitrate / FPS control | all call screens | spec explicitly asks for it; also the best mesh-quality lever pre-SFU |
| No hardware-codec preference | all call screens | H.264 hardware path unselected → higher CPU/battery on mid-tier |

## 7.4 Memory issues

- **M1 — leaked call resources.** `teardown()` is thorough but lives in three components and only reliably runs on unmount. A crash/replace path can leave a live `MediaStream` (native camera buffers) and `RTCPeerConnection`.
- **M2 — mesh holds N `MediaStream` URLs in React state** and re-clones the map on every change → GC churn during calls.
- **M3 — `lib/callLog.ts` parses + rewrites the full 300-entry JSON array on every call end** while op-sqlite is already open.
- **M4 — `call-recording.tsx` stores recordings in AsyncStorage.**
- **M5 — screen-share keeps `cameraTrackRef` alive** for swap-back; never released if the call ends mid-share.
- **M6 — ~570 LOC of dead code + 5 dead packages** occupy bundle and heap.

## 7.5 Code duplication

| Duplicate | Occurrences |
|---|---|
| WebRTC protocol logic | **3×** (1,318 LOC) |
| `ControlBtn` component | **2×** (`voicecall.tsx:368`, `videocall.tsx:599`) |
| `formatDuration` | **4×** (voicecall, videocall, `(tabs)/calls`, dead `webrtcService`) |
| Simulated call service | **2×** (`services/` + `constants/`, both dead) |
| `useS()` / `makeStyles(colors)` boilerplate | ~150× — *acceptable*, it is the codebase's idiom and each is screen-specific |
| Node route mirrors of Go routes | 16 files — **dead in production**, retained deliberately |

## 7.6 Large components

| File | LOC | Recommendation |
|---|---|---|
| `app/chat.tsx` | 4,472 | **Do not refactor** (§12.4) — stable, performant, highest-risk. Measure first |
| `app/shop-book.tsx` | 2,266 | Self-contained mini-app; low blast radius. Split only if it becomes active work |
| `app/video-player.tsx` | 850 | Acceptable |
| `app/file-viewer.tsx` | 827 | Acceptable |
| `app/vault-features.tsx` | 822 | Acceptable |
| `app/meeting-scheduler.tsx` | 807 | Unreachable — decide before investing |
| `app/videocall.tsx` | 653 | **Target of Phase 2** → ~230 LOC |
| `app/voicecall.tsx` | 405 | **Target of Phase 2** → ~140 LOC |

## 7.7 Reusable components

**Existing:** `components/ui/{Avatar, Button, Card, Header, Sheet, Text, collapsible, icon-symbol(+.ios)}` — a real design system with an iOS variant; `components/auth/*`; chat primitives; `components/{ProgressRing, TransferProgress, NetworkBanner, ConnectionBanner}`.
**Missing (needed for both platforms):** `components/call/{CallControls, ParticipantTile, CallHeader}` — the absence of these is exactly why `ControlBtn` exists twice.

## 7.8 Dependency issues

| Issue | Detail |
|---|---|
| **Dead** | `firebase`, `@react-native-firebase/{app,auth,firestore,storage}`, `expo-gl` — zero JS imports |
| **Inert config** | `react-native.config.js` overrides `react-native-pdf-thumbnail`, absent from `package.json` |
| **iOS-risky** | `expo-face-detector` (deprecated), `@react-native-voice/voice` (drags in legacy `com.android.support`, requiring `withAppComponentFactoryFix.js`) |
| **Future conflict** | `@livekit/react-native-webrtc` **replaces** `react-native-webrtc` — and **VaultBeam Tier-2 uses WebRTC data channels** (`vaultBeamDirect.ts`, 456 LOC). Must be validated before any SFU adoption |
| **Deprecated** | `expo-av` (superseded by `expo-audio`/`expo-video` in SDK 52+) — used by `call-recording`, `chat`, `story-viewer`, `media-viewer`, `video-player` |

## 7.9 Navigation complexity

147 routes in a **flat** expo-router stack with ~120 explicit `<Stack.Screen>` declarations in
one file. Flat is simple and fast, but: `chat` fans out to 17 routes; `settings` to 21; 7 screens
have no entry point at all. **Recommendation: keep the flat structure** (it is fast and
predictable) but add a `lib/routes.ts` typed route map so entry points are auditable and a
screen can never again ship dark. `typedRoutes: true` is already enabled — this builds on it.

## 7.10 State management

**No global state library** — deliberately. The pattern is a plain module + `useSyncExternalStore`:
`lib/socket.ts` (`useConnectionState`), `lib/unreadStore.ts`, `lib/nav/navSettings.ts`,
`lib/networkStateStore.ts`. This is lightweight, zero-dependency, and correct.
**Gap:** the call subsystem is the one place that ignores this pattern and puts real-time state
in component state (W2). **Recommendation: bring calls in line with the existing pattern** — no
new dependency, no new concept.

## 7.11 Networking · 7.12 Database · 7.13 Storage

- **REST:** `lib/api.ts` (257 LOC) — one fetch wrapper, JWT attach, refresh-on-401, tokens in SecureStore. Clean.
- **Realtime:** `lib/socket.ts` (234 LOC) — one Socket.IO connection, websocket-only, jittered reconnect, 3-state connection store, and `addPersistentListener` which re-arms listeners across socket re-creation (this is what makes incoming calls reliable; a documented past bug).
- **Server DB:** Postgres 16 + pgbouncer, 64 migrations, RLS. Redis for pub/sub + cache. Kafka for fan-out.
- **Client DB:** op-sqlite (`lib/localDb.ts`) for messages/chats; a **separate** SQLite file for finance (`db/financeDb.ts`).
- **Storage:** SecureStore (secrets/tokens) · AsyncStorage (prefs, call log, drafts) · FileSystem/RNFS (media, transfers) · MinIO/R2 server-side.
- **Encryption at rest:** `VAULT_CACHE_ENCRYPTED` exists but is **off** — the local SQLite message cache holds plaintext bodies today.

## 7.14 Background services · 7.15 Notifications

Covered in §5.3 (Android) and §6.1 (iOS). Notifications: `expo-notifications` (Expo push / APNs / FCM) **plus** Notifee (channels, full-screen intents, foreground services) **plus** the native `VaultCallMessagingService`. Three layers, each with a distinct job — justified, but it means **push must be regression-tested on both platforms after any dependency change**.

## 7.16 WebRTC · 7.17 P2P · 7.18 Encryption

Covered in §2.3, §2.4, §2.2. Summary: WebRTC = strong protocol, wrong location (in components).
P2P = exemplary. Encryption = the most trustworthy part of the codebase; **do not touch it**.

---

# 8. Folder-by-Folder Analysis

| Folder | Files | Purpose | Dependencies | Changes needed? | Why |
|---|---|---|---|---|---|
| `app/` | 152 | 147 routes, expo-router | lib, services, components, constants | **Yes — targeted.** 3 call screens → renderers; 7 unreachable screens resolved; `_layout` slimmed | Call engine + reachability |
| `app/(tabs)/` | 7 | 5 visible tabs + hidden alerts | lib, components | Minor (calls tab reads synced log) | W4 |
| `app/finance/` | 16 | Finance mini-app | `db/*`, `utils/finance*` | **No** | Self-contained, offline, cross-platform clean |
| `components/` | 50 | Shared UI + design system | constants/theme, lib/theme | **Yes — additive.** New `components/call/*` | Kill `ControlBtn` duplication; shared 1:1 + group toolset |
| `hooks/` | 4 | Colour scheme, theme colour, chat viewers | — | **Yes — additive.** `useCall*` selector hooks | Fixes W2 re-renders |
| `lib/` (transport) | `api`, `socket`, `serverConfig`, `serverTime`, `networkState*` | REST + realtime | — | **No** | Correct and load-bearing; `addPersistentListener` must not be touched |
| `lib/` (call) | 10 files, 916 LOC | Native bridge, hold, crypto, log, notification, ring, ICE, sounds, battery | react-native-webrtc, notifee, NativeModules | **Yes — this is where the engine lands** | W1, W2, W3, W4, iOS adapter |
| `lib/` (chat/data) | `chatService` (1505), `localDb` (673), `messageQueue`, `syncEngine`, `receipts`, `localCache`, `historySync`, `drafts`, `unreadStore` | Local-first data core | op-sqlite, api | **No** | Stable and performant |
| `lib/` (media) | 10 files | Upload/download, per-file GCM, outbox, cache GC | FileSystem, RNFS | **Minor (iOS)** | `mediaStore` needs a PhotoKit path |
| `lib/vaultBeam*` | 13 files | 4-tier P2P transfer | native modules, Rust | **Yes — iOS only** | Background `URLSession` + xcframework build |
| `lib/family/` | 9 | Family Circle presence/geofence/history | expo-location, TaskManager | **No** | Already iOS-configured |
| `lib/nav/` | 12 | Haptic turn-by-turn over Valhalla | expo-location, Vibration | **Yes — iOS only** | Core Haptics for pattern parity |
| `lib/vaultcheck/` | 8 | C2PA / deepfake detection | — | **No** | Pure TS |
| `lib/vaultlens/` | 3 | AI media client | api | **No** | |
| `services/crypto/` | 22 + Rust | E2EE core (TS + Rust + vectors + 8 self-tests) | @noble/*, Nitro | **iOS build only — never the code** | Formats FROZEN, vector-proven. Highest-risk area in the repo |
| `services/security/` | 12 | vaultKeys, sessionSeal, duress, threatEngine, auditChain, safetyNumber | SecureStore | **No** (⚠️ App Store disclosure — §6.6) | |
| `services/` (other) | ~15 | auth, device, face, shopbook, d2de, shadowContact, trustedContact | | **Delete 2 dead files** | Zero importers |
| `services/vaultbeam/rust/` | 7 | Transport core crate | crypto-core | **iOS build only** | `build-ios-xcframework.sh` must run |
| `constants/` | 15 | Theme, flags, call theme, server URL, data tables | — | **Yes — delete 2 dead + add flags** | |
| `utils/` | 8 | Pure helpers | — | **Delete 1 dead** | |
| `db/` | 8 | Finance on-device SQLite | expo-sqlite | **No** | |
| `shims/` | 5 | Firebase JS shims (4) + web WebRTC shim | — | **Delete 4** if Firebase deps go; **keep** the web shim | |
| `plugins/` | 37 | 8 config plugins + 7 Kotlin + 4 Swift/ObjC + 2 CMake/JNI | @expo/config-plugins | **Yes — major iOS additions** | §14–15 |
| `assets/` | images + sounds | Icons, splash, notification sounds | — | Minor audit | |
| `vaultchat-backend-go/` | 49 | Go API + Socket.IO hub | pgx, go-redis, socket.io-go | **Yes — additive** (`calls` tables, APNs VoIP) | W3, iOS |
| `vaultchat-backend/` | 173 | Node — **BullMQ workers only** | bullmq, kafkajs | **No** | Route mirrors are dead in prod. Never add a route here |
| `caddy/`, `coturn/`, `monitoring/`, `admin/` | — | Infra | — | **No** (until an SFU) | |

---

# 9. Module-by-Module Analysis

*(Detailed call-subsystem walkthrough. Other subsystems are covered in §8 and §2.)*

**Outgoing 1:1 call:** `InCallManager.start()` → `getCurrentUserAsync()` → `getUserMedia()` →
`getTurnConfig()` → `new RTCPeerConnection` → `createOffer/setLocalDescription` →
`newCallCipher()` (mint call key, ratchet-wrap once) → emit `call_incoming` + `webrtc_offer`
(sealed) → `POST /call/initiate` (FCM doorbell, **no SDP**) → re-emit the same sealed wire every
3 s ×9.

**Incoming:** `_layout` `call_incoming` listener → `ringTracker` de-dupe → foreground?
`/incoming-call` : backgrounded? Notifee FSI → Accept → call screen with `isIncoming=true` →
`openCallOffer()` → `createAnswer` → sealed answer re-emitted ×5 (idempotent via
`signalingState === 'have-local-offer'`).

**Cold start (Android):** data-only FCM → `VaultCallMessagingService.onMessageReceived` (no JS) →
wake screen + FGS + `CATEGORY_CALL` FSI → tap → `getInitialCallIntent()` → `/incoming-call`.

**Group mesh:** `join_call` → server roster (Redis in cluster mode) → `call_roster` /
`call_peer_joined` / `call_peer_left`; per-pair offer/answer/ICE through the same relay; glare
resolved by "smaller uid offers"; server refuses the 6th with `call_full` (**the client does not
handle `call_full`**).

**Assessment:** the protocol is correct and battle-tested. **Keep it byte-identical.** The
problem is location, not behaviour — which is what makes the Phase-2 consolidation low-risk:
the wire format does not change, so old and new builds interoperate.

---

# 10. Files That Will Need Changes

### 10.1 Modify

| File | Change | Phase |
|---|---|---|
| `app/voicecall.tsx` | → renderer (~405 → ~140) | 2 |
| `app/videocall.tsx` | → renderer (~653 → ~230) | 2 |
| `app/group-call-active.tsx` | → renderer (~260 → ~150) | 2 |
| `app/incoming-call.tsx` | route via engine `accept()`/`reject()` | 2 |
| `app/_layout.tsx` | delegate call plumbing to engine `init()`; keep side-effect imports | 2, 4 |
| `app/(tabs)/calls.tsx` | synced call log; group-call affordance | 2 |
| `app/group-calls.tsx`, `app/group-info.tsx`, `app/chat.tsx` (header only) | entry points + `call_full` handling | 3 |
| `lib/CallService.ts` | Android gate → **platform-dispatched adapter** | 2, 6 |
| `lib/callNotification.ts` | CallKit path for iOS | 6 |
| `lib/callLog.ts` | AsyncStorage → op-sqlite + server sync | 2, 4 |
| `lib/scheduledRunner.ts` | iOS `UNNotificationRequest` path | 6 |
| `lib/transferForeground.ts` | iOS background `URLSession` path | 6 |
| `lib/mediaStore.ts` | iOS PhotoKit save path | 6 |
| `lib/nav/hapticPlayer.ts` | Core Haptics | 6 |
| `constants/flags.ts` | `CALL_ENGINE_V2`, later `SFU_ENABLED` | 2 |
| `app.json` | iOS Info.plist keys (§6.5); Android permission cleanup | 5, 6 |
| `eas.json` | **add an iOS build + submit profile** | 6, 9 |
| `metro.config.js` | drop the Firebase shim block | 4 |
| `plugins/withCryptoCore.js` | add an iOS xcframework branch | 6 |
| `plugins/withVaultBeamStream.js` | iOS note / route to the Rust path | 6 |
| `plugins/withVaultChatCalls.js` | split Android/iOS; **remove `voip` mode until CallKit exists** | 6 |
| `vaultchat-backend-go/internal/routes/calls.go` | call sessions + APNs VoIP token platform | 2, 6 |
| `vaultchat-backend-go/internal/fcm/fcm.go` | APNs VoIP sender alongside FCM | 6 |
| `vaultchat-backend-go/internal/realtime/handlers.go` | roster carries name + role | 2 |
| `package.json` | drop 5 dead deps; migrate `expo-av` | 4 |
| `tsconfig.json` | scoped strict for `lib/call/` only | 4 |
| `ARCHITECTURE.md` | fix E2EE-flag + TF.js drift | 1 |

### 10.2 Create

| File | Purpose | Est. LOC | Phase |
|---|---|---|---|
| `lib/call/engine.ts` | Headless engine: lifecycle, state machine, disposal registry | ~260 | 2 |
| `lib/call/peer.ts` | One `RTCPeerConnection` + cipher + ICE buffer (used N×) | ~150 | 2 |
| `lib/call/signal.ts` | All socket wiring + retry policy, one place | ~120 | 2 |
| `lib/call/media.ts` | `getUserMedia`/`getDisplayMedia`, track swap, audio routing | ~110 | 2 |
| `lib/call/store.ts` | `useSyncExternalStore` snapshot + selectors | ~90 | 2 |
| `lib/call/types.ts` | `CallSession`, `Participant`, `CallRole`, `TransportKind` | ~60 | 2 |
| `lib/call/native/android.ts` · `native/ios.ts` | Platform adapters (FGS+FCM / CallKit+PushKit) | ~90 ×2 | 2, 6 |
| `hooks/useCall.ts` | Selector hooks | ~40 | 2 |
| `components/call/{CallControls,ParticipantTile,CallHeader}.tsx` | Shared 1:1 + group UI | ~250 | 2 |
| `lib/routes.ts` | Typed route map — makes an unreachable screen impossible | ~120 | 3 |
| `plugins/withVaultChatCallsIOS.js` + `plugins/calls-ios/*.swift` | PushKit + CallKit + AVAudioSession | ~400 | 6 |
| `plugins/haptics-ios/*.swift` | Core Haptics pattern player | ~150 | 6 |
| `vaultchat-backend/migrations/066_calls.sql` | `calls`, `call_participants` (+RLS) | ~60 | 2 |
| `docs/CALL_ARCHITECTURE.md` · `docs/IOS_PARITY.md` | Contracts | doc | 2, 6 |

**Net client change: ~1,318 LOC removed from screens, ~1,420 LOC added as shared, dual-platform modules.** More capability, one bug site, both platforms.

### 10.3 Delete

| File | LOC | Justification |
|---|---|---|
| `services/webrtcService.ts` | 212 | Simulated call service (`setTimeout` "connect"). Zero importers. A trap |
| `constants/webrtcService.ts` | 48 | Second simulated service. Zero importers |
| `utils/encryption.ts` | 91 | Zero importers; `services/crypto` is the real one |
| `services/encryptionService.ts` | — | Zero importers |
| `constants/memoryShield.ts.bak` | — | `.bak` file in version control |
| `app/screen-share.tsx` | 223 | Panel over an Alert admitting nothing is transmitted; unreachable. **Decision needed** |
| `app/call-recording.tsx` | 611 | Records the device mic, not the call; unreachable. **Decision needed** |
| `shims/firebase-*.js` (4) | — | Only if the Firebase deps go |

**Nothing in `services/crypto`, the Rust crates, `lib/vaultBeam*`, `lib/family`, `lib/nav`, or any Go route is proposed for deletion.**

---

# 11. Performance Improvement Opportunities

| # | Opportunity | Gain | Complexity | Risk | Platform |
|---|---|---|---|---|---|
| P1 | Move call duration + state out of React; only `<CallHeader>` subscribes | ~600 full reconciles → ~600 `<Text>` updates per 10-min call. Direct CPU/battery/frame-rate win | Med | Low | Both |
| P2 | Per-participant store slices + memoized `ParticipantTile` | ~5× fewer tile re-renders at 5 participants | Med | Low | Both |
| P3 | Cache TURN config with a TTL from credential expiry | One fewer RTT before ICE → faster call setup | Low | Low | Both |
| P4 | Ring/answer re-emit back-off (3→5→8 s), stop on first ICE-connected | Fewer socket writes + radio wake-ups → battery | Low | Low | Both |
| P5 | Defer `mediaCacheGC` + `resumePendingSends` past first paint | Cold-start win (same class as the ~1.4 s security-scan fix) | Low | Med | Both |
| P6 | `callLog` → op-sqlite | Removes a full-array JSON parse+write per call end | Low | Low | Both |
| P7 | Drop 5 dead npm packages | APK/IPA size — **must be measured before/after, not assumed** | Low | Med | Both |
| P8 | Adaptive bitrate/FPS via `RTCRtpSender.setParameters()` driven by `getStats()` | Serves the spec's adaptive-bitrate + battery goals; best mesh-quality lever pre-SFU | Med | Med | Both |
| P9 | Hardware codec preference (H.264 where hardware-backed) | Lower CPU + battery on mid-tier Android; better thermals on iOS | Med | Med | Both |
| P10 | Rust crypto on iOS (`withCryptoCore` iOS branch) | Large-media encrypt/decrypt speed-up on iOS | Med | Low | iOS |
| P11 | Split the 8 bubble renderers out of `chat.tsx` | Faster first-chat-open | Med | **Med-High** | Both — **deferred, see §12.4** |
| P12 | `FlashList` for chat + chat-list | Smoother scrolling, lower memory on long threads | Med | Med | Both — measure first |

---

# 12. Code Simplification Opportunities

**12.1 — Collapse three WebRTC implementations into one engine.** ~1,318 LOC → ~700 LOC of protocol; 3 bug sites → 1; and iOS CallKit gets written **once**. This is the only *large* simplification I recommend, and it is the enabler for §14, §15 and any future SFU.

**12.2 — Delete dead code.** ~570 LOC with zero importers + 5 dead packages + 1 `.bak` file + 1 inert autolinking override.

**12.3 — De-duplicate UI primitives.** `ControlBtn` ×2, `formatDuration` ×4 → `components/call/` + one `lib/format.ts`.

**12.4 — `app/chat.tsx` (4,472 LOC): recommend NOT refactoring.** It is large but **stable, performant and shipping**. It already uses `memo`, keyset pagination, local-first reads and debounced receipts/typing. Splitting it touches the highest-traffic, highest-risk screen for an unmeasured benefit. **Measure first with the `lib/perf.ts` tracer that already exists**; extract the bubble renderers only if first-chat-open time proves it. Flagged as an opportunity, explicitly deferred.

**12.5 — TypeScript strictness: do not flip globally.** `strict: true` across 147 screens would produce thousands of errors. Enable it for the new `lib/call/` package via a scoped `tsconfig` — new code is strict, old code untouched, and the strict island grows naturally.

**12.6 — Typed route map (`lib/routes.ts`).** With `typedRoutes: true` already on, a central map makes "screen with no entry point" a lint-visible condition instead of an audit finding.

**12.7 — Doc reconciliation.** `CODEBASE_ANALYSIS.md` (49 KB) describes a deleted Firebase architecture; `ARCHITECTURE.md` misstates three feature flags and lists a non-existent dependency. Stale docs have already cost this project real time — `ARCHITECTURE.md` itself records two sections that were wrong for months.

---

# 13. Architecture Improvement Plan

## 13.1 The one new abstraction: a headless call engine

```
  screens (thin renderers) ──► hooks/useCall.ts ──► lib/call/store.ts
                                                          │ useSyncExternalStore
                                                          ▼
                                                 lib/call/engine.ts
                                    state machine · participants Map · disposal registry
                          ┌──────────────┬──────────────┬──────────────┐
                          ▼              ▼              ▼              ▼
                       peer.ts       signal.ts       media.ts     native adapter
                    (1 RTCPC +      (socket +      (gUM/gDM,     ┌──────┴──────┐
                     cipher)         retry)         routing)   android.ts   ios.ts
                          ▲                                    FGS + FCM   CallKit +
                          │ swappable Transport                            PushKit
              ┌───────────┴────────────────────┐
              │ MeshTransport │ SfuTransport   │  ← future, zero screen changes
              └────────────────────────────────┘
```

**Design rules, matched to your stated goals:**
- **Less code** — one implementation; 1:1 is mesh with N=1.
- **No unnecessary abstraction** — exactly **two** interfaces: `Transport` and `NativeCallAdapter`. Nothing else. No DI container, no event bus, no class hierarchy.
- **Minimal re-renders** — state outside React; screens subscribe to slices.
- **Low memory** — one disposal registry ⇒ a call can never leak a camera.
- **Battery** — one timer set, one audio-session owner, one FGS/CallKit handshake.
- **Scalable** — the SFU is a new file behind `Transport`; iOS is a new file behind `NativeCallAdapter`.
- **Consistent** — `useSyncExternalStore` is *already* the codebase's state idiom (`lib/socket.ts`, `lib/unreadStore.ts`, `lib/nav/navSettings.ts`). No new concepts for maintainers.

## 13.2 Server-side call session (additive)

```sql
-- migrations/066_calls.sql   (additive; no existing table altered)
calls (id, chat_id, kind, transport, started_by, started_at, ended_at, ended_reason)
call_participants (call_id, user_id, role, joined_at, left_at)  -- role: host|cohost|speaker|audience
```
Unblocks, in order: multi-device call history · missed-call correctness · group-call ring
resilience · **roles** (prerequisite for any webinar/broadcast work) · recording metadata.
~60 LOC SQL + ~150 LOC Go.

## 13.3 Recommended decisions where alternatives exist

| Decision | Options | **Recommendation** | Why |
|---|---|---|---|
| Call state | components / Redux / Zustand / plain module + `useSyncExternalStore` | **plain module + `useSyncExternalStore`** | Zero new deps; already the codebase idiom |
| iOS calls | react-native-callkeep / hand-rolled CallKit+PushKit | **Hand-rolled, as a config plugin** | `callkeep`'s peer deps already conflict with this RN/Expo version (documented in `CALLS_README.md`); the plugin pattern matches `withVaultView.js` |
| iOS crypto | keep TS / build the Rust xcframework | **Build the xcframework** | `build-ios-xcframework.sh` already exists for VaultBeam; same pattern for crypto-core. Requires macOS |
| iOS background transfer | give up / background `URLSession` | **Background `URLSession`** | Maps cleanly onto VaultBeam's block-indexed model |
| Group > 5 | raise mesh cap / LiveKit / mediasoup | **LiveKit — but only after Phases 2-6** | Mesh cost is quadratic (the code already forbids it correctly). LiveKit has maintained RN + Go SDKs. ⚠️ **`@livekit/react-native-webrtc` replaces `react-native-webrtc`** — validate against VaultBeam data channels first |
| SFU + E2EE | drop E2EE for group / insertable streams / mesh≤5 + SFU>5 | **mesh ≤5 stays E2EE; SFU >5** | Preserves the product's central promise instead of quietly trading it for scale |
| Screen share | fix `screen-share.tsx` / delete it, keep the in-call path | **Delete it** | The working implementation is already in `videocall.tsx`; a standalone screen for an in-call feature is the wrong shape |
| Stealth mode on iOS | ship it / disable it | **Disable on iOS** | Guideline 2.3.1/4.3 — likely rejection, not worth the fight |

---

# 14. Android Development Plan

*(Android is already the reference platform; this is consolidation, reachability and polish.)*

| ID | Work | Files | Perf | Memory | Complexity | Risk | Back-compat |
|---|---|---|---|---|---|---|---|
| **A1** | Call engine — Android adapter (`lib/call/native/android.ts`) wrapping the existing `VaultCalls` module; screens → renderers | 10 new, 6 modified | P1, P2 | M1, M2, M5 | **High** | **Med-High** — behind `CALL_ENGINE_V2`; wire format byte-identical so old/new builds interoperate; `CALLS_README.md` OEM matrix is the release gate | Full |
| **A2** | Surface unreachable features: group call entry points, `call_full` handling, `screen_share_start/stop` emit, whiteboard → attach menu, meeting-scheduler home; delete/re-scope `screen-share` + `call-recording` | 8 screens | — | — | Low | Low | Full |
| **A3** | Server-side call sessions + synced call log | 1 migration, 2 Go files, 2 client files | P6 | M3 | Med | Low | Full (additive) |
| **A4** | Permission hygiene: justify or drop `SYSTEM_ALERT_WINDOW`, `NFC`, legacy storage; Play Console declarations for background location + battery-optimisation | `app.json` | — | — | Low | **Med** — Play review | Full |
| **A5** | Dead code + dependency removal, measured before/after `bundleRelease` | 6 deletions, `package.json`, `metro.config.js` | P7 | M6 | Low | **Med** — removing `@react-native-firebase/*` changes the native build; push + cold-start ring must be re-verified on device | Full |
| **A6** | Adaptive bitrate/FPS + hardware-codec preference | `lib/call/media.ts` | P8, P9 | — | Med | Med | Full |
| **A7** | `expo-av` → `expo-audio`/`expo-video` migration | 5 screens | — | — | Med | Med | Full |

---

# 15. iOS Development Plan

*(This is net-new work. Ordered by dependency.)*

| ID | Work | Files | Complexity | Risk | Prerequisites |
|---|---|---|---|---|---|
| **I0** | **Foundations** — Apple Developer account, bundle ID registration, APNs auth key, **VoIP push certificate**, `eas.json` iOS build + submit profiles, first `eas build -p ios` to prove the RN/native tree compiles | `eas.json`, credentials | Low | **Med** — unknowns surface here (`expo-face-detector`, `@react-native-voice/voice`, `react-native-webrtc` pods) | **You provide the Apple account** |
| **I1** | **Info.plist + entitlements** — add the 5 missing keys (§6.5), `aps-environment`, export-compliance declaration | `app.json` | Low | Low | I0 |
| **I2** | **APNs message push** — Go `internal/fcm` gains an APNs sender; `lib/push.ts` registers the iOS token; verify tap-to-chat routing | 2 Go files, 1 client file | Med | Low | I0, I1 |
| **I3** | **CallKit + PushKit** — `plugins/withVaultChatCallsIOS.js` + Swift (`PKPushRegistry`, `CXProvider`, `AVAudioSession`); Go APNs **VoIP** sender; `lib/call/native/ios.ts` adapter. **Remove the `voip` background mode until this lands** | ~400 LOC Swift + plugin + 2 Go files | **High** | **High** — Apple revokes VoIP privileges if the call is not reported immediately; also the #1 App Store rejection risk today | **A1 (engine) must land first**, else this is written 3× |
| **I4** | **Rust crypto on iOS** — iOS branch in `withCryptoCore.js` + xcframework build script (mirroring `build-ios-xcframework.sh`) | 1 plugin, 1 script | Med | Low | macOS + Xcode |
| **I5** | **VaultBeam on iOS** — run `build-ios-xcframework.sh`, wire `VaultBeamStreamRust.swift`, add background `URLSession` block transfer, `NSLocalNetworkUsageDescription` + `NSBonjourServices` for the LAN tier | 1 script, 1 plugin, 1 lib file | **High** | Med | I0, macOS |
| **I6** | **Background & scheduling parity** — `UNNotificationRequest` for scheduled messages; `BGAppRefreshTask`/`BGProcessingTask` for sync; verify Family Space background location end-to-end (already configured) | 3 lib files | Med | Med | I1, I2 |
| **I7** | **Media & platform polish** — PhotoKit save path, Core Haptics pattern player, `expo-av` route, iOS ringtone via bundled audio, SF Symbols audit | 4 lib files + 1 plugin | Med | Low | I1 |
| **I8** | **App Store compliance** — disable stealth mode on iOS; disclose duress PIN / decoy vault / panic wipe in review notes with reviewer credentials; remove `screen-share.tsx`; export-compliance paperwork | config + review notes | Low | **High** — this is the approval gate | §6.6 |
| **I9** | **iOS device matrix testing** — a matrix equivalent to `CALLS_README.md`: iPhone SE/13/15, iOS 16/17/18, locked-screen ring, killed-app ring, backgrounded audio, CarPlay/Bluetooth routing, Low Power Mode | — | Med | Med | I3 |

**Platform limitations that cannot be engineered away (state them to users, do not paper over them):**
1. No screenshot **blocking** — detection only. `screenGuard.ts` already handles this correctly.
2. No persistent background socket — push is mandatory.
3. No arbitrary background execution — transfers must use background `URLSession`.
4. No custom vibration patterns without Core Haptics.
5. Stealth mode / app disguise is effectively prohibited.

---

# 16. Pending Items — Desktop, Windows, Linux, macOS, Web

**Status: Pending – Future Development.** No code, no changes, nothing removed. Existing
scaffolding preserved.

| Platform | What exists today | Recommendation |
|---|---|---|
| **Web** | `react-native-web` dep, `app.json` `web.bundler: metro`, `shims/react-native-webrtc.js` (browser WebRTC + `<video>` `RTCView`), `hooks/use-color-scheme.web.ts`, `Platform.OS === 'web'` guards throughout | The shim is already correct for 1:1 calls. **Keep every `Platform.OS !== 'web'` guard** — removing them is the easiest way to break the web build silently. Revisit only after mobile parity |
| **Windows / macOS / Linux (Tauri + Rust)** | **Nothing.** No Tauri config, no `src-tauri` | **High leverage when it happens:** `services/crypto/rust` and `services/vaultbeam/rust` are already `crate-type = ["lib","staticlib"]` with **frozen, vector-tested wire formats**. A Tauri client can link the same crates and be protocol-compatible on day one. This is the strongest argument for never touching those crates |
| **macOS (Catalyst / Designed-for-iPad)** | `app.json` `ios.supportsTablet: true` | Cheapest desktop beachhead once iOS ships — but CallKit and PushKit behave differently on macOS; treat it as a separate platform, not a free win |
| **Desktop Pro features** (Producer Mode, multi-monitor, Creator Studio, RTMP, local recording) | Nothing | All desktop-scoped in your own spec, and all depend on an SFU + streaming gateway. **Do not attempt any of these on mobile** |

**Cross-platform preservation commitment:** every change proposed in §10 is platform-guarded TS,
Android-native, iOS-native, or additive Go. The web shim, `.web.ts` variants and all
`Platform.OS` guards are untouched.

---

# 17. Risks

| # | Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|---|
| R1 | **Call regression during engine consolidation** — calls are the most visible feature | Med | **Critical** | `CALL_ENGINE_V2` flag; old screens kept one release; **wire protocol byte-identical** so builds interoperate; OEM matrix is the gate |
| R2 | **WebRTC cannot be validated without real devices on real networks** (two-device, cross-carrier, cross-NAT) | **High** | High | Physical two-device testing is mandatory for every call change. Stated in the code's own headers and in `PHASE6_NOTES.md`. Now doubled: Android **and** iPhone |
| R3 | **iOS CallKit/PushKit is unforgiving** — failing to report a call immediately makes iOS revoke VoIP privileges | Med | **High** | Report synchronously in `didReceiveIncomingPushWith`; test on device only (simulators cannot validate VoIP push) |
| R4 | **App Store rejection** — `voip` background mode without CallKit (today), stealth mode, duress/decoy features | **High** | **High** | §6.6 + I8. Resolve *before* the first submission — a rejection resets the review clock |
| R5 | **`@livekit/react-native-webrtc` replaces `react-native-webrtc`**, and VaultBeam Tier-2 uses WebRTC data channels | Med | High | Validate VaultBeam end-to-end before adopting; otherwise keep two stacks or defer the SFU |
| R6 | **Removing Firebase JS deps changes the native build**; native FCM must keep working | Med | High | Keep `google-services.json`, the google-services Gradle plugin and `firebase-messaging:24.1.1`; device-test cold-start ring + push after prebuild |
| R7 | **Touching `services/crypto` breaks decryption irreversibly** | Low | **Critical** | **Do not touch it.** The plan modifies zero crypto source files — only the iOS *build* path |
| R8 | **Boot-path change breaks headless wakes** — a missing `_layout` import silently killed background Family location once already | Med | High | Preserve side-effect imports (`lib/callBackground`, `lib/family/background`); headless-wake test required |
| R9 | **iOS build surfaces unknown native incompatibilities** (`expo-face-detector` deprecated, `@react-native-voice/voice` legacy, WebRTC pods) | **High** | Med | **Do I0 first** — a throwaway `eas build -p ios` before committing to the iOS estimate |
| R10 | **No macOS/Xcode in this environment** — iOS native work cannot be compiled or tested here | **Certain** | High | iOS phases require a Mac (or EAS cloud builds + a physical iPhone). Plan accordingly |
| R11 | **Scope creep from the product spec** — webinar/Creator Studio/RTMP are 6–12 months, mostly desktop | High | Med | This plan bounds mobile to Phases 1–9 and marks the rest Pending |
| R12 | **`strict: false` hides null bugs in new call code** | Med | Med | Scoped strict `tsconfig` for `lib/call/` |
| R13 | **Stale docs mislead implementation** | High | Low-Med | Reconcile in Phase 1; treat `ARCHITECTURE.md` as the only current doc |

---

# 18. Estimated Development Timeline

One experienced RN + Go engineer. **Assumes two physical Android devices, one physical iPhone,
and a Mac (or EAS cloud builds).** Excludes SFU infrastructure provisioning.

| Phase | Work | Build | Testing | Total |
|---|---|---|---|---|
| **1 — Project Analysis** | This document | — | — | ✅ **Complete** |
| **2 — Architecture** | Call engine (A1) · call sessions (A3) · typed route map | 11–15 d | 5–6 d | **16–21 d** |
| **3 — UI** | Surface unreachable features (A2) · shared `components/call/*` · resolve misleading screens | 5–7 d | 2–3 d | **7–10 d** |
| **4 — Performance** | P1–P9 · dead code · dependency removal (A5) · scoped strict TS | 6–8 d | 3–4 d | **9–12 d** |
| **5 — Android** | Permission hygiene (A4) · adaptive bitrate/codecs (A6) · `expo-av` migration (A7) · OEM matrix | 6–8 d | 4–5 d | **10–13 d** |
| **6 — iOS** | I0 foundations 3–4 d · I1 plist 1 d · I2 APNs 3–4 d · **I3 CallKit/PushKit 10–14 d** · I4 Rust crypto 3–4 d · I5 VaultBeam 8–12 d · I6 background 4–5 d · I7 polish 4–5 d · I8 compliance 2–3 d · I9 device matrix 5–7 d | 38–52 d | included | **43–59 d** |
| **7 — Testing** | Two-platform regression, crypto vectors, OEM + iOS device matrices, offline/background scenarios | — | 10–14 d | **10–14 d** |
| **8 — Optimization** | Measured pass: startup, memory, battery, scroll, chat load, transfer throughput | 6–8 d | 4–5 d | **10–13 d** |
| **9 — Release** | Store listings, Play declarations, App Review notes, export compliance, staged rollout, crash monitoring | 5–7 d | 3–4 d | **8–11 d** |
| | | | **TOTAL** | **113–153 working days ≈ 23–31 weeks (5.5–7.5 months)** |

**Confidence:** **High** for Phases 2–5 (the code is fully understood). **Low-Medium** for Phase 6
— iOS has never been built here, and R9/R10 are real. **Recommend a 3–4 day I0 spike
(`eas build -p ios`, no features) before committing to the iOS number.** That spike will move the
Phase-6 estimate by weeks in either direction.

**Fastest path to a shippable improvement:** Phases 2–5 = **42–56 days (~9–11 weeks)**, Android
only, no new infrastructure, and it leaves the app strictly better while de-risking all of iOS.

---

# 19. Recommendations

1. **Approve Phases 2–5 first; treat Phase 6 (iOS) as a separate go/no-go after an I0 spike.** The Android work is self-contained, needs no new infrastructure, removes more code than it adds, and every hour of it directly reduces the iOS estimate.

2. **Consolidate the call engine before writing any iOS code.** This is the single highest-leverage decision in the plan. CallKit + PushKit against three divergent screens is roughly double the work and triple the bug surface. Consolidate once; adapt twice.

3. **Do the iOS foundations spike (I0) immediately, in parallel with Phase 2.** Three to four days of `eas build -p ios` will tell you whether `expo-face-detector`, `@react-native-voice/voice` and the WebRTC pods build at all. Everything in the Phase-6 estimate hangs on that answer.

4. **Fix the App Store exposure before the first submission, not after.** `plugins/withVaultChatCalls.js` declares the `voip` background mode today with **no CallKit behind it** — that is a near-certain rejection. Either implement I3 or remove the mode. Stealth mode should be disabled on iOS; duress PIN and decoy vault should be *documented and discoverable*, not concealed.

5. **Do not touch `services/crypto` or the Rust crates.** Frozen, vector-proven, parity-tested — and the reason a future Tauri desktop client could be protocol-compatible on day one. The plan changes only the iOS *build* path, never a line of crypto.

6. **Do not refactor `app/chat.tsx`.** Large, but stable and performant, and the highest-traffic screen in the app. Measure with the `lib/perf.ts` tracer that already exists; act only if the data demands it.

7. **Ship the group call that already works.** `group-calls` + `group-call-active` are 416 lines of real, working mesh code with no entry point. Days of work, immediate user-visible value, on both platforms.

8. **Be honest in the UI about what is not built.** `screen-share.tsx` renders a full control panel over an `Alert` admitting nothing is transmitted; `call-recording.tsx` records the device mic rather than the call. This repo has a documented honesty mandate (`docs/FEATURE_GAP_MATRIX.md` has a whole "STUB / THEATER" section) — these are the last two violations in the call surface, and they are also an App Review 2.1 risk.

9. **Treat the SFU as an operations decision, not an engineering task** — and keep the mesh path for small E2EE calls even after it lands. ≤5 stays end-to-end encrypted; >5 goes SFU. That preserves the product's central promise instead of quietly trading it for scale.

10. **Budget ~40% of build time for testing on anything touching calls, and double the device matrix now that iOS is in scope.** Every serious call bug in this repo's history — the dropped answer, the lost socket listener, the OEM ring failures — was findable only on real devices on real networks.

---

**Awaiting your approval before a single line of code is written.**

I can also, before you decide: expand any section, produce the full per-screen detail for a
specific category, draft the `066_calls.sql` schema, write the CallKit/PushKit integration
design in detail, or run the I0 iOS-build feasibility analysis on paper.
