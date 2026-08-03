# VaultChat — Phase 1: Analysis & Implementation Plan (Android only)

> **Status: PLAN ONLY. No source file was modified. No patch generated. No refactor performed.**
> This document is the deliverable. Coding begins only after your explicit approval.
>
> Scope of this analysis: the whole repository, read file-by-file, reconciled against
> `ARCHITECTURE.md`, `docs/GAP_CLOSURE_PLAN.md`, `docs/FEATURE_GAP_MATRIX.md`,
> `vaultchat-backend-go/PHASE6_NOTES.md`, and the two uploaded specs
> (`all_calls_plan.txt`, `calls_working_process.txt`) plus the product poster.
>
> Everything asserted below is grounded in a file that exists in this repo. Where a
> document in the repo disagrees with the code, the **code wins** and the drift is flagged.

---

## 1. Executive Summary

### 1.1 What this repository actually is

This is **not** a greenfield project matching the poster. It is a mature, shipping,
**Android-first** product:

| | |
|---|---|
| App | Expo 54 / React Native 0.81.5 / Hermes / New Architecture / React Compiler ON |
| Version | `app.json` **1.1.6**, `versionCode` **15** — already released |
| Client surface | ~150 screens (`app/`, expo-router), 50 components, 129 `lib/` modules, 74 `services/` modules |
| Backend | **Go** (`vaultchat-backend-go`, 18 route modules + Socket.IO hub), Node retained for BullMQ workers only |
| Native | 7 Kotlin modules (calls, VaultBeam stream, VaultView, VaultMedia), 8 Expo config plugins |
| Rust | 2 crates — `crypto-core` (X3DH/Double Ratchet/sender-keys/Shamir) and `vaultbeam-core` (chunked transfer), both wired through JSI/Nitro + JNI |
| Data | Postgres 16 (64 migrations), Redis 7, Kafka, MinIO/R2, **coturn** TURN relay |
| Total source | ~112,600 LOC (TS/TSX/Go/Rust/Kotlin/JS, excluding `node_modules`) |

The stack in the poster (React Native + Rust + Go) is **already the stack in the repo**.
The gap is not technology. The gap is feature scope.

### 1.2 The gap between the spec and the code

| Spec item (poster / `calls_working_process.txt`) | Reality in this repo |
|---|---|
| 1:1 voice/video WebRTC, HD audio, adaptive bitrate, Bluetooth, background calling | ✅ **Real and production-hardened** — see §5.1 |
| Screen share 1:1 (P2P) | ✅ Real — `replaceTrack()` swap in `app/videocall.tsx`, no renegotiation |
| Group voice/video via **LiveKit SFU**, 64 participants | ❌ **Zero LiveKit in the repo.** What exists is a **full-mesh** group call capped at **5** participants server-side (`meshMaxParticipants()`, `realtime/handlers.go:352`) |
| Webinar (host → 5 co-hosts → 20 speakers → unlimited audience) | ❌ **Nothing.** `grep -ri webinar` over the whole repo returns **0 hits** |
| Broadcast to unlimited audience, Creator Studio, multi-RTMP, YouTube restream | ❌ **Nothing.** `grep -ri rtmp` returns **0 hits**. `app/broadcast.tsx` is a *text* broadcast-channel screen (Telegram-style posts), not live streaming. `app/creator-channels.tsx` is a 17-line redirect to it |
| Recording + Replay + signed replay links | ❌ No server-side recording. `app/call-recording.tsx` (610 LOC) records **local device audio via `expo-av`**, not the call — and is unreachable from the UI |
| Raise hand, polls in-call, Q&A, host/co-host roles | ❌ Nothing. No role model exists anywhere (client or DB) |
| Desktop (Tauri/Rust), Web (React), iOS | 🕓 **Pending – Future Development** (see §12). No Tauri, no desktop dir. iOS has partial plugin scaffolding only |

**Bottom line:** the 1:1 call stack is genuinely excellent and better than the spec
describes. Everything *above* 1:1 — group at scale, webinar, broadcast, creator studio —
is **not started**, and every one of them is blocked on the same missing piece: **an SFU
and a server-side call session model.**

### 1.3 The single most valuable finding

There are **three independent, near-duplicate WebRTC implementations** living inside React
components:

- `app/voicecall.tsx` — 404 LOC
- `app/videocall.tsx` — 652 LOC (a superset copy of the above)
- `app/group-call-active.tsx` — 259 LOC (mesh)

Each one **separately** re-implements: `getUserMedia`, TURN fetch, `RTCPeerConnection`
construction, socket wiring, offer/answer/ICE handling, the E2EE signalling cipher,
`InCallManager` audio routing, teardown, the foreground service handshake, and call
logging. That is **~1,315 LOC of triplicated real-time protocol logic held in component
state.**

This is the root cause of nearly every problem listed in §7–§10, and it is also the
**hard blocker** for the entire roadmap: you cannot add host/co-host roles, raise-hand,
in-call chat, recording, or an SFU transport to three divergent copies of the protocol
without doing the work three times and getting three different bugs.

**The Phase 2 architecture proposal (§10) is therefore: extract one headless call engine,
make the screens thin renderers, and treat 1:1 as "mesh with N=1".** This *removes* code
(~1,315 → ~700 LOC), reduces re-renders, and is the prerequisite for every roadmap item.

### 1.4 Recommended Android scope

Do **not** start with LiveKit. Recommended order (detail in §11 / §15):

1. **A0 — Consolidate the call engine** (no new features, strictly less code).
2. **A1 — Surface what already works** (the mesh group call has *no entry point in the UI*).
3. **A2 — Server-side call sessions** (a `calls` + `call_participants` table in Go). Small, and unblocks roles/recording/replay/multi-device call log.
4. **A3 — Performance & size pass** (measured, targeted; includes ~4–7 MB of dead dependencies).
5. **A4 — SFU (LiveKit) behind the engine's transport interface** — screens unchanged.
6. **A5 — Webinar / broadcast roles on top of the SFU.**

---

## 2. Current Architecture Overview

### 2.1 System context

```
┌───────────────────────── Android client (Expo / RN 0.81 / Hermes / New Arch) ──────────────────────────┐
│  app/          expo-router — 6 tabs + ~145 stack screens                                               │
│  components/   50 shared UI components (ui/, chat/, auth/, family/, nav/, finance/, vaultlens/)        │
│  lib/          129 modules — transport, storage, call, media, sync, vaultbeam, family, nav, vaultcheck │
│  services/     74 modules — crypto (TS + Rust), security, auth, device, face, shopbook                 │
│  plugins/      8 Expo config plugins + 7 Kotlin native modules + 2 JNI/CMake bridges                   │
└───────────┬─────────────────────────────┬──────────────────────────┬───────────────────────────────────┘
            │ REST + JWT (lib/api.ts)     │ Socket.IO (lib/socket.ts)│ WebRTC media (DTLS-SRTP)
            ▼                             ▼                          ▼
┌──────────────────────── Caddy front door → https://api.corefinite.com ────────────────────────────────┐
│  go-api (vaultchat-backend-go)                                          coturn 4.6 (TURN/STUN relay)  │
│    internal/httpx     cors · JSON · JWT verify · rate limit · Sentry                                   │
│    internal/routes    auth · user · chats · uploads · stories · channels · contacts · vaultbeam ·      │
│                       vaultlens · communities · calls · link · gif · ai · nav · shopbook · admin       │
│    internal/realtime  Socket.IO hub — chat, presence, WebRTC relay, mesh call rooms, Redis adapter     │
│    internal/{db,redisx,storage,emitx,jobs,fcm,vault,metrics,workx}                                     │
└───────┬──────────────┬──────────────┬──────────────┬──────────────────────────────────────────────────┘
        ▼              ▼              ▼              ▼
   Postgres 16     Redis 7        Kafka 3.8     MinIO / Cloudflare R2      → FCM · SMTP · SMS · ModelsLab
   (64 migrations) (pub/sub +     (event bus)   (media at rest)
                    cache)         │
                                   └─► Node BullMQ workers (fanout, vaultlens) — the ONLY remaining Node role
```

### 2.2 Client boot path (`app/_layout.tsx`, 436 LOC)

The single most performance-critical file in the app. In order:

1. `Buffer` polyfill → Sentry init (conditional on `EXPO_PUBLIC_SENTRY_DSN`)
2. `getLocalDb()` warm-up (op-sqlite JSI) — non-blocking
3. `ScreenCapture.preventScreenCaptureAsync()` (FLAG_SECURE app-wide)
4. `runSecurityCheck()` — **deliberately not awaited** (was a documented ~1.4 s cold-start stall)
5. E2EE identity provisioning + `registerForCalls()` (FCM token → `/call/token`)
6. `addPersistentListener('call_incoming')` — survives socket re-creation (documented past bug: calls silently not ringing)
7. Lazy `import()` of: `vaultBeamController`, `syncEngine`, `receipts`, `mediaOutbox`, `mediaCacheGC`
8. Notifee foreground/background/initial-notification call handlers
9. `<Stack>` with **~120 explicitly declared `<Stack.Screen>` entries**

This file is well-engineered (the async-security-scan decision and the persistent-listener
pattern are both correct and hard-won), but it is also where every new subsystem gets bolted
on, and it now boots 9 subsystems inside one `useEffect`.

### 2.3 Data plane

- **Local-first**: `lib/localDb.ts` (op-sqlite) is the UI's source of truth. Opening a chat is a local read; a background delta-sync (`lib/syncEngine.ts`, `GET /chats/delta`) reconciles.
- **Durable queues**: `lib/messageQueue.ts` (text), `lib/mediaOutbox.ts` (media + a file copy), `lib/receipts.ts` (coalesced read/delivered).
- **Cache**: `lib/localCache.ts` — generic paint-cached-then-refresh, used by communities/broadcast/etc.

### 2.4 Crypto

| Layer | Implementation |
|---|---|
| 1:1 messages | X3DH + Double Ratchet — `services/crypto/e2ee.ts` (TS) **and** `services/crypto/rust/src/e2ee.rs` (Rust), byte-identical, proven by `__vectors__/*.json` + `parity.selftest.ts` |
| Group messages | Sender Keys — `services/crypto/senderKey.ts` + `groupSession.rn.ts`, `GROUP_E2EE = true` |
| Media at rest | Per-file AES-256-GCM, key inside the E2E envelope — `MEDIA_E2EE = true` |
| Stories | Per-viewer wrapped content key — `STORY_E2EE = true` |
| **Call signalling** | `lib/callCrypto.ts` — per-call 32-byte key, ratchet-wrapped **once**, then AES-256-GCM per frame. Deliberately *not* per-frame ratcheting (documented: signalling is lossy/bursty and would exhaust `MAX_SKIP` and break *text* decrypt). **1:1 only — group calls send plaintext SDP today.** |
| Backend selection | `services/crypto/index.ts` picks Rust (Nitro JSI) when `libvaultcrypto.so` loaded, else TS. Never throws. |

**Doc drift found:** `ARCHITECTURE.md` §04 says group E2EE and media E2EE are "not yet
enforced / default off". `constants/flags.ts` has `GROUP_E2EE = true`, `MEDIA_E2EE = true`,
`STORY_E2EE = true` (all enabled 2026-06-28). `ARCHITECTURE.md` also lists TensorFlow.js in
the stack; there is no TF dependency in `package.json`. Both are stale doc, not stale code.

---

## 3. Mobile (Android) Architecture Review

### 3.1 What is genuinely strong

1. **Cold-start call ring.** `plugins/android/VaultCallMessagingService.kt` (373 LOC) is a real `FirebaseMessagingService`. A data-only high-priority FCM message starts the process **without the RN JS runtime**, wakes the screen, starts the foreground service, and posts a `CATEGORY_CALL` full-screen-intent notification with the caller's name and DP (async-loaded, initials fallback) and Answer/Decline actions. This is the correct architecture and is better than a `react-native-callkeep` integration would have been here (documented peer-dep conflict).
2. **Foreground service discipline.** `CallForegroundService.kt` uses `foregroundServiceType="microphone|camera"` + a partial wake lock, started within the 5 s window. `withVaultChatCalls.js` declares `FOREGROUND_SERVICE_MICROPHONE|CAMERA|MEDIA_PROJECTION`, `USE_FULL_SCREEN_INTENT`, `REQUEST_IGNORE_BATTERY_OPTIMIZATIONS`.
3. **OEM survival** is treated as a first-class product problem — `lib/batteryOptimization.ts` deep-links MIUI/ColorOS/FuntouchOS/Honor/Samsung autostart panels, `app/call-reliability.tsx` is a user-facing guide, and `CALLS_README.md` carries a per-OEM device test matrix.
4. **ICE tuning that reflects the actual user base.** `lib/icePriority.ts` rewrites candidate priority to prefer IPv6 host candidates — correct and high-value on Jio/Airtel where IPv4 is behind CGNAT and would otherwise force a paid TURN relay.
5. **Call-waiting.** `lib/callState.ts` is a 29-LOC module that solves hold/resume/hangup correctly, including the subtle "don't let a late unmount clear a newer call" guard.
6. **Signalling resilience.** The answer is re-emitted up to 5× and the ring/offer up to 10× at 3 s, with `setRemoteDescription` guarded by `signalingState === 'have-local-offer'` so replays are idempotent. This fixes a real, documented class of stranded calls.
7. **Server-side mesh cap.** `join_call` refuses the 6th participant and emits `call_full` rather than admitting them and melting the room. The comment explaining *why* (quadratic cost, mid-tier uplink collapse) is exactly right.
8. **Rust + JNI is real, not aspirational.** `crypto-core` and `vaultbeam-core` build to `staticlib`, are linked via CMake into `libvaultcrypto.so` / `libvaultbeam.so`, and — critically — `withCryptoCore.js` **degrades silently to the TS backend when the Rust toolchain is absent at prebuild time.** That is the right call for build reliability.

### 3.2 What is structurally weak

| # | Weakness | Evidence |
|---|---|---|
| W1 | **Triplicated WebRTC protocol logic inside React components** | `voicecall.tsx` 404 + `videocall.tsx` 652 + `group-call-active.tsx` 259 LOC, each with its own `pc`, ICE fetch, socket wiring, cipher, teardown |
| W2 | **Call state is component state** → a 1 Hz `setSeconds` interval re-renders the entire call screen, `RTCView` subtree included, once per second for the whole call | `voicecall.tsx:166`, `videocall.tsx:262` |
| W3 | **No server-side call session.** `callId` is literally `chatId`; there is no `calls` table | `CallService.ts:58`, `calls.go` (no persistence beyond `devices.fcm_token`) |
| W4 | **Call log is device-local only** (`AsyncStorage`, 300-entry cap) — no multi-device sync, lost on reinstall | `lib/callLog.ts` |
| W5 | **Group call signalling is plaintext** — `callCrypto.ts` scope note says 1:1 only; `group-call-active.tsx` does call `newCallCipher` per peer, but `join_call`/roster carry no protection and the mesh has no key-agreement ordering guarantee |
| W6 | **The mesh group call has no entry point.** `app/group-calls.tsx` is registered in `_layout.tsx` but **nothing in the app routes to it** (verified: only self-reference + the `<Stack.Screen>` line). Same for `screen-share`, `call-recording`, `whiteboard`, `voice-effects`, `meeting-scheduler` | `git show 6198e96` explicitly lists these as "not wired, on purpose" |
| W7 | **Two dead simulated call services** ship in the bundle | `services/webrtcService.ts` (212 LOC, `setTimeout(connect, 2000)`) and `constants/webrtcService.ts` (48 LOC) — **zero importers** |
| W8 | **Dead dependencies in the APK** | `firebase`, `@react-native-firebase/{app,auth,firestore,storage}` — **zero JS imports** anywhere; `expo-gl` — zero imports. Native FCM (Gradle) is separate and must stay |
| W9 | **`app/chat.tsx` is 4,471 LOC** — the highest-traffic screen in the app, one file, ~40 `useEffect`/`useCallback` blocks plus 8 bubble renderers |
| W10 | **`tsconfig` has `strict: false`, `noImplicitAny: false`, `strictNullChecks: false`** — the call path is full of `(pc as any)` and `data?.from` guards that the compiler cannot help with |

---

## 4. Folder-by-Folder Analysis

Format: **Purpose · Current implementation · Dependencies · Changes required? · Why**

### `app/` — 152 files, ~150 routes (expo-router)
- **Purpose:** every screen. File-based routing, 6 tabs + ~145 stack screens.
- **Current:** `_layout.tsx` boots the app and declares ~120 routes explicitly. `(tabs)/` = chats, status, mini (centre raised button), calls, profile, alerts (hidden). Feature clusters: chat, calls, vault, vaultlens, vaultbeam, family, finance, shop-book, nav, security/privacy, onboarding.
- **Dependencies:** `lib/*`, `services/*`, `components/*`, `constants/theme`.
- **Changes required:** **YES, targeted.**
  - `voicecall.tsx`, `videocall.tsx`, `group-call-active.tsx` → reduced to renderers over the new engine (§10.1).
  - `group-calls.tsx` → needs a real entry point from group chat header + group-info.
  - `screen-share.tsx` → 222 LOC of UI over an `Alert` that literally says "nothing is transmitted". Either delete or point at the working `videocall.tsx` share path.
  - `call-recording.tsx` → records device audio, not the call. Must be re-scoped or removed (honesty).
  - `chat.tsx` → **no refactor recommended in Phase 2** (see §9.4).
- **Why:** the call screens are the direct blocker; the rest is honesty/reachability debt.

### `components/` — 50 files
- **Purpose:** shared UI. `ui/` design system (Avatar, Button, Card, Header, Sheet, Text), `chat/ViewerStack`, `auth/`, `family/FamilyMap`, `nav/NavMap`, `finance/`, `vaultlens/Shimmer`, plus chat primitives (MediaMessage, ReactionPicker, VoiceRecorder, GifPicker, TransferProgress, VaultBeamBubble…).
- **Current:** consistent, themed via `useTheme()` + `makeStyles(colors)` memoized per screen.
- **Dependencies:** `constants/theme`, `lib/theme`.
- **Changes required:** **YES, additive only.** Phase 2 needs `components/call/` — `CallControls`, `ParticipantTile`, `CallHeader` — shared by 1:1 and group so the toolset is written once.
- **Why:** today every call screen hand-rolls its own `ControlBtn`; the 1:1 and mesh screens have visually different, separately-maintained control bars.

### `hooks/` — 4 files
- **Purpose:** `use-color-scheme` (+ `.web`), `use-theme-color`, `useChatViewers`.
- **Current:** thin. `useChatViewers` (106 LOC) is the only substantial one.
- **Changes required:** **YES, additive.** `useCall()` / `useCallParticipants()` selector hooks over the engine store belong here.
- **Why:** keeps subscription granularity out of the screens — this is what kills W2.

### `lib/` — 129 files (the real application core)
Sub-groups:

| Group | Files | Purpose | Changes? |
|---|---|---|---|
| **Transport** | `api.ts` (257), `socket.ts` (234), `serverConfig`, `serverTime`, `networkState*` | JWT fetch wrapper w/ refresh-on-401; single Socket.IO client with persistent-listener re-arm; 3-state connection store | **No.** Both are correct and load-bearing. `addPersistentListener` in particular must not be touched. |
| **Call** | `CallService` (95), `callState` (29), `callCrypto` (137), `callLog` (56), `callNotification` (76), `callBackground` (51), `ringTracker` (18), `icePriority` (168), `sounds` (133), `batteryOptimization` (153) | Native bridge, hold/resume, E2EE signalling, history, Notifee FSI, headless handlers, ring de-dupe, IPv6 bias | **YES — this is where the new engine lands.** All ten stay; a new `lib/call/` package absorbs the protocol logic currently in the screens. |
| **Chat/data** | `chatService` (1505), `localDb` (673), `messageQueue` (336), `syncEngine` (140), `historySync`, `receipts` (74), `localCache` (77), `drafts`, `unreadStore`, `messageState` | REST + E2EE seam, op-sqlite local-first store, durable queues | **No.** Stable, performant, well-documented. Only additive: `getTurnConfig` should move behind the engine's ICE provider. |
| **Media** | `sendMedia`, `mediaCrypto`, `mediaStore`, `mediaOutbox` (194), `mediaAttachments`, `mediaKeyStore`, `mediaCacheGC`, `thumbnails`, `protectedMedia`, `viewOnceStore` | Upload/download, per-file GCM, outbox, cache GC | **No.** |
| **VaultBeam** | 13 files incl. `vaultBeamTransfer` (226), `vaultBeamController` (451), `vaultBeamDirect` (456), `vaultBeamStreamNative` (189), `transferForeground` (70) | 12 GB P2P/relay file transfer; **all bytes stay native** (JS only holds `{blockIndex, url}`) | **No.** This is the best-architected subsystem in the repo and the model the call engine should copy. |
| **Family** | `lib/family/` 9 files | Family Circle: presence, geofence, background location, alerts, device-local history | **No.** Out of Android call scope. |
| **Nav** | `lib/nav/` 12 files | Haptic turn-by-turn over self-hosted Valhalla; pure-function core | **No.** |
| **VaultCheck / VaultLens** | `lib/vaultcheck/` 8, `lib/vaultlens/` 3 | C2PA/deepfake detection; AI media gen client | **No.** |
| **Security/session** | `sessionManager`, `sessionLock`, `chatLock`, `stealthMode`, `ghostProtocol`, `screenGuard`, `cacheCrypto`, `vaultCrypto` | | **No.** |
| **Background** | `backgroundConnection` (116) | Notifee FGS keeping the socket alive on **no-GMS devices** (Huawei) | **No — but read it before touching the call FGS**: it holds a refcount that `transferForeground` shares. A second uncoordinated FGS would fight it. |

### `services/` — 74 files
- **`services/crypto/`** — TS core + `native/CryptoCore.ts` (Nitro JSI wrapper) + `rust/` crate + `__vectors__/` + 8 self-test files. **No changes.** Formats are FROZEN and vector-proven; touching this is the highest-risk action available in this repo.
- **`services/crypto/rust/`** — `e2ee.rs` (457), `sender_key.rs` (259), `shamir.rs` (218), `aead.rs` (73), `ffi.rs` (417). `opt-level="z"`, `lto=true`, `strip=true`. **No changes.**
- **`services/vaultbeam/rust/`** — `chunk.rs`, `fileio.rs`, `lan.rs`, `ffi.rs`. **No changes.**
- **`services/security/`** — `vaultKeys`, `sessionSeal`, `duressPin`, `duressVault`, `threatEngine`, `auditChain`, `safetyNumber`, `securityScore`. **No changes.**
- **`services/webrtcService.ts` (212 LOC)** — a **simulated** call service: `startCall()` fires `setTimeout(connectCall, 2000 + random)`. **Zero importers. DELETE.**
- **`services/encryptionService.ts`**, **`utils/encryption.ts`** — zero importers. **DELETE candidates** (verify against `services/crypto` first).
- **`services/faceService.ts` / `faceMatchService.ts`** — `expo-face-detector` + vision-camera. Out of scope, no change.

### `constants/` — 15 files
- `theme.ts` (Aurora tokens), `callTheme.ts` (28 LOC, static dark call chrome — correct), `flags.ts` (feature flags, §2.4), `server.ts` (single `SERVER_URL`), plus finance/security/country data.
- **`constants/webrtcService.ts` (48 LOC)** — a second dead simulated service ("Jitsi-based, works in Expo Go"). **Zero importers. DELETE.**
- **`constants/memoryShield.ts.bak`** — a `.bak` file committed to the repo. **DELETE.**
- **Changes:** deletions only, plus new call flags (`CALL_ENGINE_V2`, `SFU_ENABLED`) in `flags.ts` following the existing graceful-rollout convention.

### `utils/` — 8 files
`biometric`, `encryption` (dead), `finance*`, `interest`, `notifications`, `shopbook`. Pure helpers, unit-testable. **No changes** except the dead `encryption.ts`.

### `db/` — 8 files
On-device SQLite stores for the **finance mini-app only** (ledger, chitti, reminders, shop lists, timeline). Separate DB file from messaging. **No changes** — out of Android call scope.

### `shims/` — 5 files
`firebase-{app,auth,firestore,storage}.js` (Metro-redirected from `@react-native-firebase/*`) and `react-native-webrtc.js` (**web-only** shim). Since **no file imports the Firebase JS SDK any more**, the four Firebase shims + the four `@react-native-firebase/*` deps + `firebase` are dead weight. `react-native-webrtc.js` is a *web* shim — out of Android scope, but keep it (it costs nothing on Android; Metro only resolves it for `platform === 'web'`).

### `plugins/` — 37 files
| File | Role | Changes? |
|---|---|---|
| `withVaultChatCalls.js` (177) | Call permissions, `<service>`/`<receiver>`, copies 4 Kotlin files, registers `CallPackage`, adds `firebase-messaging:24.1.1`, iOS `UIBackgroundModes` | **YES (A4/A5 only)** — screen-share FGS type and, if an SFU lands, no manifest change needed |
| `withCryptoCore.js` | Rust crypto module, **no-ops without the toolchain** | No |
| `withVaultBeamRust.js`, `withVaultBeamStream.js` | VaultBeam native | No |
| `withVaultView.js`, `withVaultChatSync.js`, `withGradleMemory.js`, `withAppComponentFactoryFix.js` | Misc native | No |
| `android/*.kt` (7 modules) | `CallForegroundService` (155), `CallModule` (170), `VaultCallMessagingService` (373), `CallPackage`, `VaultBeamStreamModule` (459), `VaultMediaModule` (290), `VaultViewModule` (162) | **Call trio: YES, small additive** — see §11 |
| `crypto-core-android/`, `vaultbeam-core-android/` | CMake + JNI + Nitro C++ | No |
| `vaultview-ios/`, `vaultbeam-core-ios/` | iOS | **Pending – Future Development** |

### `assets/` — images + sounds (`note_chime.wav`, `note_bell.wav`, ringtones)
**Change required (A3):** audit unused images. Adaptive icon + splash are 4 PNG variants; verify none are orphaned. Low value, do last.

### Build config
| File | Note | Change? |
|---|---|---|
| `app.json` | v1.1.6 / vc 15, Hermes, `newArchEnabled`, `reactCompiler`, `typedRoutes`, 27 Android permissions, 8 plugins | **YES** — needs `FOREGROUND_SERVICE_MEDIA_PROJECTION` is present, but `BLUETOOTH_SCAN` / `MODIFY_AUDIO_SETTINGS` review for API 33+; version bump on release |
| `metro.config.js` | Sentry config + Firebase shim redirect + web WebRTC shim | **YES (A3)** — Firebase redirect block becomes dead once the deps are dropped |
| `babel.config.js` | `babel-preset-expo` only. **`babel-plugin-react-compiler` is a dependency and `reactCompiler: true` is set in `app.json`** — Expo wires it via the preset | No |
| `tsconfig.json` | `strict: false`, `strictNullChecks: false` | **Recommended (A3, opt-in per-dir)** — see §9.5 |
| `eslint.config.js` | expo config; 14 pre-existing errors | No |
| `eas.json` | preview + production Android profiles | No |
| `react-native.config.js` | autolinking override for `react-native-pdf-thumbnail` — **note: that package is not in `package.json`**, so this override is inert | Low-priority cleanup |

### Backend — `vaultchat-backend-go/` (49 Go files)
- `cmd/api/main.go`, `internal/{httpx,db,redisx,storage,emitx,jobs,fcm,vault,metrics,workx,realtime,routes}`.
- **`internal/routes/calls.go` (162 LOC)** — `POST /call/token`, `/call/initiate`, `/call/cancel`. Pure FCM doorbell; **no call persistence**. Deliberately never carries SDP (F6).
- **`internal/realtime/handlers.go` (377 LOC)** — chat handlers + `relay()` for `webrtc_{offer,answer,ice,end}`, `screen_share_{start,stop}`, `e2ee_rekey`, all VaultBeam signals; `call_incoming` with live-socket-aware push fallback; `join_call`/`leave_call` mesh rooms with `meshMaxParticipants()`.
- **`internal/realtime/cluster.go` (221)** — Redis-backed roster because `FetchSockets()` on the local adapter only sees one node.
- **Changes required (A2/A4/A5): YES, additive.** New `calls` tables + a `routes/calls.go` extension + (later) LiveKit token minting. **No existing Go route needs modification.**

### Backend — `vaultchat-backend/` (Node, 173 files)
Retained for **BullMQ workers only** (`workers/vaultlens.js`, `workers/fanout.js`) which push results back through `/internal/emit`. The `routes/*.js` mirrors are **dead in production** — Caddy routes everything to Go. `ARCHITECTURE.md` records this has already caused one incident (VaultView revoke 404'ing).
- **Changes: NO.** But **anything added to Go must not be mirrored here** — and conversely, adding a call route only to Node would be dead on arrival.

### Infra
`docker-compose.yml` (caddy, go-api, pgbouncer, postgres, redis, kafka, minio, api[legacy], valhalla, **coturn**, vaultlens-worker, fanout-worker, prometheus, grafana), `caddy/Caddyfile`, `coturn/turnserver.conf` (REST `use-auth-secret`, TURN + TURNS:5349, relay ports 49160–49200), `monitoring/` (Prometheus + Grafana SLI dashboard).
- **Changes (A4): YES** — an SFU is a new compose service + firewall rules + a Caddy route. This is an **operations** decision, not a code decision.

---

## 5. Module-by-Module Analysis (call & real-time subsystem)

### 5.1 1:1 calls — the working path

**Outgoing (`voicecall.tsx` / `videocall.tsx`):**
```
InCallManager.start({media, auto:true})           ← audio route, follows BT/wired
getCurrentUserAsync()                             ← identity
mediaDevices.getUserMedia({audio[,video]})
getTurnConfig()                                   ← GET /user/turn (coturn REST creds)
new RTCPeerConnection({iceServers})
pc.createOffer() → setLocalDescription()
newCallCipher(peerUid, offer)                     ← mint call key, ratchet-wrap once
socket.emit('call_incoming', {…, offer: sealed})
socket.emit('webrtc_offer',  {…, offer: sealed})
POST /call/initiate                               ← FCM doorbell (no SDP)
setInterval 3 s × 9: re-emit SAME sealed wire     ← survives a killed→woken callee
```
**Incoming:** `_layout.tsx` `call_incoming` listener → de-dupe via `ringTracker` → foreground?
`/incoming-call` : backgrounded? Notifee FSI. Accept → `/voicecall|/videocall?isIncoming=true&initialOffer=…`
→ `openCallOffer()` → `setRemoteDescription` → `createAnswer` → sealed answer re-emitted 5×.

**Cold-start (app killed):** FCM data message → `VaultCallMessagingService.onMessageReceived`
(no JS) → wake screen + start FGS + full-screen `CATEGORY_CALL` notification with name + DP →
tap → `getInitialCallIntent()` in `_layout` → `/incoming-call` → caller's 3 s re-emit delivers
the offer live.

**Assessment:** correct, resilient, and thoughtfully commented. **Keep the protocol exactly as
is.** The problem is *where it lives*, not *what it does*.

### 5.2 Group calls — mesh, capped at 5, unreachable

- `app/group-calls.tsx` (155) — member list + "Start group call"; **no route reaches it.**
- `app/group-call-active.tsx` (259) — real full mesh: one `RTCPeerConnection` per peer, glare resolved by `me < uid` sends the offer, per-peer `CallCipher`, pending-ICE buffering before `remoteDescription`.
- Server: `join_call` → roster (Redis in cluster mode) → `call_roster` / `call_peer_joined` / `call_peer_left`; refuses >5 with `call_full`.
- **Gaps:** no `call_full` handling visible in the client; no participant names in the roster (only uids); no in-call toolset; no reconnect/renegotiate on peer ICE failure (the `oniceconnectionstatechange` handler is an empty branch with a comment).

### 5.3 Screen share

Two implementations, one real:
- **Real:** `videocall.tsx:444` — `getDisplayMedia()` → `sender.replaceTrack(screenTrack)`. No renegotiation, no call drop, stays P2P + DTLS-SRTP. Android-only button. Correct approach.
- **Fake:** `app/screen-share.tsx` — 222 LOC of toggles over an `Alert` that admits nothing is transmitted. Unreachable.
- Server relays `screen_share_start|stop`, but **the client never emits them** — so the peer has no banner.

### 5.4 Recording

`app/call-recording.tsx` (610) uses `expo-av` `Audio.Recording` to record **the device
microphone**, stored in `AsyncStorage` under `vc_call_recordings`. It is not connected to any
call, and it is unreachable. Real call recording requires either an SFU-side recorder (server)
or `MediaProjection` + local mixing (client). **Currently: not implemented.**

### 5.5 What the spec needs that has no module at all

| Spec capability | Module needed | Exists? |
|---|---|---|
| SFU publish/subscribe transport | `lib/call/transport/sfu.ts` + LiveKit server | ❌ |
| Host / co-host / speaker / audience roles | `call_participants.role` + server enforcement | ❌ |
| Raise hand, in-call polls, Q&A | socket events + UI | ❌ |
| Active-speaker detection, pinning, thumbnail mode | SFU-provided | ❌ |
| Recording + replay + signed replay links | recording worker + R2 + signed URLs | ❌ |
| RTMP egress (YouTube / custom) | streaming gateway | ❌ |
| Creator Studio (scene compositing, game capture) | desktop-only per spec | 🕓 Pending |

---

## 6. Files That Need Changes

### 6.1 To MODIFY (Android scope)

| File | Change | Why |
|---|---|---|
| `app/voicecall.tsx` | Strip protocol → render engine state (~404 → ~140 LOC) | W1, W2 |
| `app/videocall.tsx` | Same (~652 → ~230 LOC) | W1, W2 |
| `app/group-call-active.tsx` | Same (~259 → ~150 LOC) | W1 |
| `app/incoming-call.tsx` | Route through the engine's `accept()`/`reject()` instead of pushing params | single accept path |
| `app/(tabs)/calls.tsx` | Read from the (new) synced call log; add "join group call" affordance | W4 |
| `app/group-calls.tsx` | Reachable + `call_full` handling + member presence | W6 |
| `app/chat.tsx` | **Only** the header call buttons → group chat opens `group-calls` | W6 |
| `app/group-info.tsx` | Add a "Group call" action | W6 |
| `app/_layout.tsx` | Delegate call routing to the engine; remove ~60 LOC of inline call plumbing | boot-path weight |
| `constants/flags.ts` | Add `CALL_ENGINE_V2`, later `SFU_ENABLED` | graceful rollout, matches existing convention |
| `lib/CallService.ts` | Becomes the engine's native-bridge adapter only | separation |
| `lib/callCrypto.ts` | Extend scope note + a group-aware key path (A5) | W5 |
| `plugins/android/CallModule.kt` | Add: audio-device enumeration/selection, proximity sensor, `MediaProjection` token handoff | in-call toolset |
| `plugins/withVaultChatCalls.js` | Manifest additions when the above land | build |
| `vaultchat-backend-go/internal/routes/calls.go` | Add session CRUD (`POST /call/session`, `GET /call/history`) | W3, W4 |
| `vaultchat-backend-go/internal/realtime/handlers.go` | Roster carries display name + role; emit `call_state` | roles |
| `package.json` | Drop dead deps (§9.2) | APK size |
| `metro.config.js` | Drop the Firebase shim block once deps are gone | dead config |
| `ARCHITECTURE.md` | Correct the E2EE-flag drift + TF.js claim | doc accuracy |

### 6.2 To CREATE

| File | Purpose | Est. LOC |
|---|---|---|
| `lib/call/engine.ts` | Headless call engine: lifecycle, state machine, external store | ~260 |
| `lib/call/peer.ts` | One `RTCPeerConnection` + its cipher + ICE buffer (used N times) | ~150 |
| `lib/call/signal.ts` | Socket wiring, one place; offer/answer/ICE/end + retry policy | ~120 |
| `lib/call/media.ts` | `getUserMedia`/`getDisplayMedia`, track swap, `InCallManager` routing | ~110 |
| `lib/call/store.ts` | `useSyncExternalStore` snapshot + selectors (`useCallStatus`, `useParticipant(uid)`, `useCallDuration`) | ~90 |
| `lib/call/types.ts` | `CallSession`, `Participant`, `CallRole`, `TransportKind` | ~60 |
| `hooks/useCall.ts` | Screen-facing selector hooks | ~40 |
| `components/call/CallControls.tsx` | One control bar for 1:1 + group | ~120 |
| `components/call/ParticipantTile.tsx` | Memoized `RTCView` tile; **only re-renders on its own stream/mute change** | ~80 |
| `components/call/CallHeader.tsx` | Name/status/duration — the *only* component subscribed to the 1 Hz tick | ~50 |
| `vaultchat-backend/migrations/066_calls.sql` | `calls`, `call_participants` (+ RLS, matching the existing migration style) | ~60 |
| `docs/CALL_ARCHITECTURE.md` | The engine contract + transport interface | doc |

**Net client LOC: ~1,315 removed from screens, ~1,080 added as shared modules → a real reduction plus one place to fix bugs.**

### 6.3 To DELETE

| File | LOC | Justification |
|---|---|---|
| `services/webrtcService.ts` | 212 | Simulated call service (`setTimeout` "connect"). Zero importers. A trap. |
| `constants/webrtcService.ts` | 48 | Second simulated service ("Jitsi-based"). Zero importers. |
| `utils/encryption.ts` | 91 | Zero importers; `services/crypto` is the real one. Verify then delete. |
| `services/encryptionService.ts` | — | Zero importers. Verify then delete. |
| `constants/memoryShield.ts.bak` | — | `.bak` file in version control. |
| `app/screen-share.tsx` | 222 | UI over an Alert saying nothing is transmitted; unreachable. **Decision needed** — delete, or rebuild as the in-call share panel. |
| `shims/firebase-*.js` (4) | — | Only if the Firebase deps go (§9.2). |

**Nothing in `services/crypto`, `services/*/rust`, `lib/vaultBeam*`, `lib/family`, `lib/nav`,
or any Go route is proposed for deletion.**

### 6.4 Configuration / dependency / database changes

- **Config:** `constants/flags.ts` + 2 flags; `app.json` permission review; `metro.config.js` shim cleanup.
- **Dependencies removed:** `firebase`, `@react-native-firebase/app|auth|firestore|storage`, `expo-gl`. (Native `com.google.firebase:firebase-messaging` in Gradle **stays** — it is what makes cold-start ringing work, and `google-services.json` + the google-services Gradle plugin must stay with it.)
- **Dependencies added:** none for A0–A3. `@livekit/react-native` + `@livekit/react-native-webrtc` only at A4 — and note **that package replaces `react-native-webrtc`**, which is a build-level decision, not a drop-in.
- **Database:** one new migration (`066_calls.sql`). Additive only; no existing table altered.

---

## 7. Performance Opportunities

Ordered by (measured impact ÷ risk).

| # | Issue | Current | Proposed | Gain | Risk |
|---|---|---|---|---|---|
| P1 | **1 Hz whole-screen re-render during every call** | `setSeconds(s=>s+1)` in the call screen's own state; the component tree — `RTCView` included — reconciles once per second for the call's entire duration | Duration lives in the engine store; only `<CallHeader>` subscribes | On a 10-min video call: ~600 full reconciles → ~600 reconciles of one `<Text>`. Directly reduces CPU → battery and frame drops during video | Low |
| P2 | **Mesh re-render storm** | `setPeers({...prev})` clones the whole peer map on every track/URL change → every tile re-renders | Per-participant store slice + memoized `ParticipantTile` | At 5 participants, tile re-renders drop ~5× | Low |
| P3 | **Ring/answer re-emit loops** | Up to 9 ring emits + 5 answer emits, unconditional timers | Stop on first ICE-connected (already partly done) + back off 3s→5s→8s | Fewer socket writes + radio wake-ups while ringing | Low |
| P4 | **Boot path does 9 things in one `useEffect`** | `_layout.tsx` kicks localDb, security scan, E2EE provision, FCM register, 5 lazy imports, 4 notification handlers | Keep the async pattern; move call plumbing into the engine's `init()`; defer `mediaCacheGC` + `vaultBeamController.resumePendingSends` to after first paint | Measurable cold-start win; the security-scan fix already proved this class is worth ~1.4 s | Medium — boot order is load-bearing |
| P5 | **TURN fetched per call screen** | `getTurnConfig()` on every call mount, and again per screen | Cache in the engine with a TTL from the credential expiry | One fewer round-trip before ICE starts → faster call setup | Low |
| P6 | **`app/chat.tsx` 4,471 LOC** | Single module; Metro parses/evaluates it on first chat open | Extract the 8 bubble renderers into `components/chat/bubbles/` | Faster first-chat-open, better memoization boundaries | **Medium-high — see §9.4. Do not do this in Phase 2.** |
| P7 | **APK size — dead deps** | `firebase` + 4 `@react-native-firebase` packages with zero JS imports | Remove | Firebase JS SDK is multi-MB; the RNFirebase packages pull native artefacts too. **Must be measured with a before/after `bundleRelease`, not assumed** | Low, but requires a full prebuild + device smoke test of push/calls |
| P8 | **No adaptive bitrate / FPS control** (spec calls for it) | Whatever `getUserMedia` + libwebrtc negotiate | `RTCRtpSender.setParameters()` with `maxBitrate`/`scaleResolutionDownBy`, driven by `getStats()` | Directly serves the spec's "adaptive bitrate / adaptive FPS / low battery" goals; also the single best mesh-quality lever before an SFU | Medium |
| P9 | **No hardware-codec preference** (spec calls for it) | Default codec order | Reorder SDP `m=video` toward H.264 where hardware-backed | Lower CPU + battery on mid-tier Android | Medium — codec munging is fiddly; measure per device |

---

## 8. Memory Optimization Opportunities

| # | Issue | Proposal | Notes |
|---|---|---|---|
| M1 | **Leaked call resources on abnormal teardown.** `teardown()` is thorough, but it lives in three components and is only guaranteed to run on unmount. A crash/replace path can leave a `MediaStream` + `RTCPeerConnection` alive | Engine owns a single disposal registry; `dispose()` is idempotent and called from one place | This is the classic RN WebRTC leak. A live camera track holds native buffers |
| M2 | **Mesh holds N `MediaStream` URLs in React state** and re-clones the map | Store peers in a plain `Map` outside React; expose immutable snapshots per participant | Cuts GC churn during a call |
| M3 | **`lib/callLog.ts` reads + rewrites the entire 300-entry JSON array on every log** | Move to the existing op-sqlite `localDb` (already open, already the app's store) | Removes a JSON parse/serialize of the full log per call end |
| M4 | **`app/call-recording.tsx` keeps recordings in `AsyncStorage`** | Metadata in SQLite, bytes on disk | Only if the screen survives the §5.4 decision |
| M5 | **Screen-share swap keeps the camera track alive** (`cameraTrackRef`) for swap-back — correct, but never released if the call ends mid-share | Engine disposal registry covers it | Small but real |
| M6 | **Bundle/JS heap: two dead call services + dead crypto utils are parsed at startup** | Delete (§6.3) | ~350 LOC of Hermes bytecode never used |

---

## 9. Code Simplification Opportunities

### 9.1 The big one — collapse three WebRTC implementations into one
Covered in §1.3, §6.2, §10.1. **~1,315 LOC → ~1,080 LOC, and from 3 bug sites to 1.**
This is the only *large* simplification I recommend.

### 9.2 Dead code removal
§6.3: ~570 LOC of client code with zero importers, plus 5 npm packages with zero JS imports.

### 9.3 Duplicated UI primitives
`ControlBtn` is defined **twice** (`voicecall.tsx:368`, `videocall.tsx:599`), and
`formatDuration` **three times** (`voicecall`, `videocall`, `(tabs)/calls`, plus a 4th in the
dead `services/webrtcService.ts`). One `components/call/` + one `lib/format.ts` fixes it.

### 9.4 `app/chat.tsx` (4,471 LOC) — **recommend NOT refactoring in Phase 2**
It is large, but per your own refactoring rules it is **stable, performant, and shipping**.
It already uses `memo`, keyset pagination (`PAGE_SIZE = 50`), a local-first read path, and
debounced receipts/typing. Splitting it touches the highest-traffic, highest-risk screen in
the app for a benefit that is real but unmeasured. **Recommendation: measure first
(`lib/perf.ts` already exists and marks the send path), and only extract the bubble renderers
if first-chat-open time proves it.** Flagging it here as an opportunity, explicitly deferred.

### 9.5 TypeScript strictness
`strict: false` + `strictNullChecks: false` is why the call path is littered with
`(pc as any)` and defensive `data?.from` checks. **Proposal: do not flip it globally** (it
would produce thousands of errors across 150 screens). Instead enable strictness for the new
`lib/call/` package only, via a scoped `tsconfig` — new code is strict, old code is untouched,
and the strict island grows naturally.

### 9.6 Doc reconciliation
`ARCHITECTURE.md` (E2EE flags, TF.js), `CODEBASE_ANALYSIS.md` (49 KB, describes a
Firebase/Firestore architecture that **no longer exists**), and `react-native.config.js`
(override for an absent package) all describe a system that has moved on. Stale docs cost
real time — `ARCHITECTURE.md` itself records two sections that were wrong for months.

---

## 10. Architecture Improvements

### 10.1 Proposal: one headless call engine (`lib/call/`)

```
                    ┌──────────────────────────────────────────────┐
  screens ─────────►│  hooks/useCall.ts  (selector subscriptions)  │
  (thin renderers)  └───────────────────┬──────────────────────────┘
                                        │ useSyncExternalStore
                    ┌───────────────────▼──────────────────────────┐
                    │  lib/call/store.ts   immutable snapshot       │
                    └───────────────────┬──────────────────────────┘
                                        │
                    ┌───────────────────▼──────────────────────────┐
                    │  lib/call/engine.ts                          │
                    │    state machine: idle→ringing→connecting→   │
                    │    connected→ended;  participants: Map<uid>  │
                    │    disposal registry; duration tick           │
                    └───┬───────────┬───────────┬──────────────┬───┘
                        │           │           │              │
              ┌─────────▼──┐ ┌──────▼─────┐ ┌───▼──────┐ ┌─────▼────────┐
              │ peer.ts    │ │ signal.ts  │ │ media.ts │ │ CallService  │
              │ 1 RTCPC    │ │ socket +   │ │ gUM/gDM  │ │ (native FGS, │
              │ + cipher   │ │ retry      │ │ InCallMgr│ │  FCM, ring)  │
              └────────────┘ └────────────┘ └──────────┘ └──────────────┘
                        ▲
                        │  swappable transport
              ┌─────────┴─────────────────────────────────┐
              │ MeshTransport (today)  |  SfuTransport (A4)│
              └───────────────────────────────────────────┘
```

**Design rules (matching your stated priorities):**
- **Less code:** one implementation, N=1 for 1:1. No class hierarchy, no DI container, no event-bus abstraction — plain modules and one store.
- **No unnecessary abstraction:** exactly **one** interface — `Transport` (`join`, `leave`, `publish`, `subscribe`, `onParticipant`). Mesh and SFU implement it. Nothing else is abstracted.
- **Minimal re-renders:** state lives outside React; screens subscribe to *slices*. The duration tick reaches one `<Text>`.
- **Low memory:** a single disposal registry means a call can never leak a camera.
- **Battery:** one set of timers, one audio-session owner, one foreground-service handshake.
- **Maintainability:** a bug in ICE handling is fixed once.
- **Future-proof:** the SFU is a new `Transport` file. **Zero screen changes.**

### 10.2 Proposal: a server-side call session

```sql
-- migrations/066_calls.sql (additive; no existing table touched)
calls (id, chat_id, kind, transport, started_by, started_at, ended_at, ended_reason)
call_participants (call_id, user_id, role, joined_at, left_at)   -- role: host|cohost|speaker|audience
```
Unblocks, in order: multi-device call history (W4), missed-call correctness, group-call ring
resilience, **roles** (the prerequisite for webinar/broadcast), recording metadata, replay links.
It is ~60 LOC of SQL and ~150 LOC of Go. **Do this before the SFU, not after** — otherwise the
SFU integration has nowhere to put roles.

### 10.3 Recommended approach where alternatives exist

| Decision | Options | **Recommendation** | Why |
|---|---|---|---|
| Group calls > 5 | (a) raise the mesh cap, (b) LiveKit SFU, (c) mediasoup | **(b) LiveKit**, but **only at A4** | (a) is what the code already forbids for good reason — quadratic cost. (c) is more control but far more ops. LiveKit has a maintained RN SDK and a Go server SDK, which matches this stack exactly. **Caveat: `@livekit/react-native-webrtc` replaces `react-native-webrtc`** — that must be validated against VaultBeam's `vaultBeamDirect.ts`, which also uses WebRTC data channels |
| SFU + E2EE | (a) drop E2EE for group, (b) LiveKit E2EE (insertable streams), (c) keep mesh for small/E2EE, SFU for large | **(c)** | Preserves the app's core promise. Mesh ≤5 stays E2EE; >5 goes SFU with the security posture stated honestly to the user. This also means A4 does not regress anything |
| Call state | (a) keep in components, (b) Redux/Zustand, (c) plain module + `useSyncExternalStore` | **(c)** | Zero new dependency, exactly the pattern already used in `lib/socket.ts` (`useConnectionState`), `lib/unreadStore.ts`, `lib/nav/navSettings.ts`. Consistent with the codebase; no new concepts for maintainers |
| Call history | (a) keep AsyncStorage, (b) server table, (c) op-sqlite | **(c) now, (b) at A2** | op-sqlite is already open at boot; server sync makes it multi-device |
| Screen share | (a) fix `screen-share.tsx`, (b) delete it and put share in the call screen | **(b)** | The working implementation is already in `videocall.tsx`. A standalone screen for an in-call feature is the wrong shape |
| Recording | (a) client `MediaProjection`, (b) SFU-side recorder | **(b), at A4+** | Client-side recording of a P2P call means mixing remote audio on the phone — expensive, battery-hostile, and legally fraught. Server recording is what the spec's "Cloud Recording" implies anyway |

---

## 11. Android Implementation Plan

Each item states: **Why · Current · Proposed · Files · Modules · Perf · Memory · Complexity · Risk · Backward compatibility.**

### A0 — Call engine consolidation *(foundation; no user-visible change)*
- **Why:** three divergent copies of the WebRTC protocol block every roadmap item (§1.3).
- **Current:** protocol in `voicecall.tsx` (404), `videocall.tsx` (652), `group-call-active.tsx` (259).
- **Proposed:** `lib/call/{engine,peer,signal,media,store,types}.ts` + `hooks/useCall.ts` + `components/call/*`. Screens become renderers. 1:1 = mesh with N=1.
- **Files:** create 10, modify 5 screens + `_layout.tsx` + `flags.ts`.
- **Modules:** call, socket, native bridge, crypto (consumer only — **crypto itself untouched**).
- **Performance:** removes the 1 Hz full-screen re-render (P1) and the mesh clone storm (P2).
- **Memory:** single disposal registry (M1, M2, M5).
- **Complexity:** **High** — this is the biggest single piece of work in the plan.
- **Risks:** call regressions are the most user-visible failure mode this app has. Mitigations: (1) ship behind `CALL_ENGINE_V2` with the old screens intact for one release, exactly as `E2EE_ENABLED`/`MEDIA_E2EE` were rolled out; (2) the wire protocol is **byte-identical** — old and new builds interoperate; (3) the OEM device matrix in `CALLS_README.md` is the acceptance gate.
- **Backward compatibility:** **full.** No wire change, no DB change, no protocol change.

### A1 — Surface what already works
- **Why:** a working mesh group call, screen share, and 5 more screens ship dark (W6).
- **Current:** `group-calls.tsx` reachable from nothing.
- **Proposed:** group-chat header call button → `/group-calls`; `group-info.tsx` action; handle `call_full` with the real reason; emit `screen_share_start|stop` so the peer gets a banner; decide the fate of `screen-share.tsx` / `call-recording.tsx` (recommend: delete the first, re-scope or delete the second).
- **Files:** `app/chat.tsx` (header only), `app/group-info.tsx`, `app/group-calls.tsx`, `app/group-call-active.tsx`, `app/videocall.tsx`.
- **Perf/Memory:** neutral. **Complexity:** Low. **Risk:** Low.
- **Backward compatibility:** full.

### A2 — Server-side call sessions
- **Why:** W3, W4; prerequisite for roles, recording, replay.
- **Proposed:** `066_calls.sql`; Go `POST /call/session`, `PATCH /call/session/:id`, `GET /call/history`; roster carries name + role; client call log syncs.
- **Files:** 1 migration, `routes/calls.go`, `realtime/handlers.go`, `lib/callLog.ts`, `app/(tabs)/calls.tsx`.
- **Perf:** call log moves off AsyncStorage (M3). **Complexity:** Medium. **Risk:** Low (additive).
- **Backward compatibility:** full — old clients keep their local log; the server table is new.

### A3 — Performance, size & dead-code pass
- **Why:** P3–P7, M6, §9.2.
- **Proposed:** delete §6.3 files; drop the 5 dead npm packages **with a measured before/after `bundleRelease`**; TURN cache; ring back-off; boot-path deferrals; scoped strict TS for `lib/call/`.
- **Risk:** **Medium on the dependency removal only** — removing `@react-native-firebase/*` changes the native build; push and cold-start ringing must be re-verified on a real device before this ships. Everything else is Low.
- **Backward compatibility:** full.

### A4 — SFU (LiveKit) behind the `Transport` interface — *infra-gated*
- **Why:** the spec's 64-participant video, unlimited webinar audience, and cloud recording are all impossible on mesh.
- **Proposed:** LiveKit server as a compose service; Go mints join tokens; `lib/call/transport/sfu.ts`; `SFU_ENABLED` flag; **mesh stays the path for ≤5 E2EE calls** (§10.3).
- **Files:** `docker-compose.yml`, `caddy/Caddyfile`, firewall, `routes/calls.go`, 1 new client transport file. **Screens: unchanged** (that is the point of A0).
- **Complexity:** **High.** **Risk: High, and mostly operational** — a media server is a service to run, monitor, scale and pay for. `PHASE6_NOTES.md` already states this correctly: *"a multi-week infrastructure project that cannot be written blind."*
- **Hard prerequisite:** you provision the SFU host. This cannot start before that exists.
- **Backward compatibility:** flag-gated; mesh path untouched.

### A5 — Roles, webinar & broadcast (Android participant + host)
- **Why:** the spec's core differentiator.
- **Proposed:** `call_participants.role` enforced server-side; raise-hand / in-call chat / reactions over existing socket relays; audience-mode UI (subscribe-only); host controls (mute, promote, remove).
- **Depends on:** A2 (roles) + A4 (SFU).
- **Complexity:** High. **Risk:** Medium (product surface, not protocol).
- **Backward compatibility:** additive.

### Explicitly NOT in the Android plan
Creator Studio (scene compositing, game capture), multi-RTMP egress, producer mode,
multi-monitor, professional audio/camera devices, local recording — all **desktop-scoped in
your own spec**. See §12.

---

## 12. Pending Items — Desktop, Linux, Windows, macOS, Web, iOS

**Status: Pending – Future Development.** No code written, no files changed, nothing removed.
Existing cross-platform scaffolding is preserved as-is.

| Platform | What exists today | Status | Recommendation for the future |
|---|---|---|---|
| **iOS** | `plugins/vaultview-ios/`, `plugins/vaultbeam-core-ios/` (podspec, Swift, bridging header), `services/vaultbeam/rust/build-ios-xcframework.sh`, `app.json` `UIBackgroundModes: [voip, audio, remote-notification]` set by `withVaultChatCalls.js`, iOS `infoPlist` usage strings, `components/ui/icon-symbol.ios.tsx` | **Pending – Future Development** | The CallKit/PushKit `AppDelegate.swift` glue is already written out in `CALLS_README.md` §iOS. It needs a VoIP push certificate and `apns-push-type: voip`. The A0 engine is platform-agnostic by construction, so iOS gets it for free — only the ring/FGS adapter differs. **Do not delete any iOS plugin file.** |
| **Web** | `react-native-web` dep, `app.json` `web.bundler: metro`, `shims/react-native-webrtc.js` (browser WebRTC + `<video>` `RTCView`), `hooks/use-color-scheme.web.ts`, `Platform.OS === 'web'` guards throughout `_layout.tsx` and `lib/` | **Pending – Future Development** | The web shim is already correct for 1:1 calls. Keep the `Platform.OS !== 'web'` guards — removing them is the easiest way to break the web build silently. |
| **Windows / macOS / Linux (Tauri + Rust)** | **Nothing.** No Tauri config, no `src-tauri`, no desktop directory | **Pending – Future Development** | High leverage when it happens: `services/crypto/rust` and `services/vaultbeam/rust` are already `crate-type = ["lib", "staticlib"]` with frozen, vector-tested wire formats — a Tauri app can link the *same* crates and be protocol-compatible on day one. That is the strongest argument for keeping those crates untouched. |
| **Desktop Pro features** (Producer Mode, multi-monitor, Creator Studio, RTMP, local recording, folder upload, download manager) | Nothing | **Pending – Future Development** | All of these are desktop-scoped in your own spec. They depend on A4 (SFU) + a streaming gateway. Do not attempt any of them on Android. |

**Cross-platform preservation commitment:** every change proposed in §6 is either
Android-native (Kotlin/plugins), platform-agnostic TypeScript, or additive Go. The
`Platform.OS` guards, the web shim, and the iOS plugin sources are untouched.

---

## 13. Risks

| # | Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|---|
| R1 | **Call regression during A0.** Calls are the most visible feature; a broken ring is a support incident | Medium | **Critical** | `CALL_ENGINE_V2` flag; old screens kept for one release; wire protocol byte-identical; the `CALLS_README.md` OEM matrix (MIUI/ColorOS/Vivo/Honor/Samsung/Pixel) is the release gate |
| R2 | **WebRTC cannot be validated without real devices and real networks.** Two-device, cross-carrier, cross-NAT | **High** | High | Every call change requires a physical two-device test. This is stated plainly in `group-call-active.tsx`'s own header comment and in `PHASE6_NOTES.md`. No amount of code review substitutes |
| R3 | **`@livekit/react-native-webrtc` replaces `react-native-webrtc`** — and **VaultBeam Tier-2 also uses WebRTC data channels** (`lib/vaultBeamDirect.ts`, 456 LOC) | Medium | **High** | Validate VaultBeam P2P transfer end-to-end before adopting the LiveKit fork. If incompatible, A4 must keep two stacks or defer |
| R4 | **Removing Firebase JS deps changes the native build**; native FCM must keep working | Medium | High | Verify `google-services.json` + the google-services Gradle plugin + `firebase-messaging:24.1.1` survive; device-test cold-start ringing and push after the prebuild |
| R5 | **Touching `services/crypto` breaks message decryption irreversibly** | Low | **Critical** | **Do not touch it.** Formats are frozen and vector-proven. The plan does not modify a single crypto file |
| R6 | **Boot-path change breaks headless wakes.** `ARCHITECTURE.md` records that a missing import in `_layout.tsx` silently killed background Family location | Medium | High | Any `_layout.tsx` edit must preserve the side-effect imports (`lib/callBackground`, `lib/family/background`). Headless wake test required |
| R7 | **SFU is an operations commitment**, not a code task: capacity, bandwidth cost, monitoring, TURN interaction | High | High | Gate A4 on you provisioning and owning the host. `PHASE6_NOTES.md` already documents this correctly |
| R8 | **Scope creep from the poster.** Webinar/Creator Studio/RTMP are 6–12 months of work, mostly desktop | High | Medium | This plan explicitly bounds Android to A0–A5 and marks the rest Pending |
| R9 | **`strict: false` hides null bugs in new call code** | Medium | Medium | Scoped strict `tsconfig` for `lib/call/` only |
| R10 | **Stale documentation misleads implementation** (`CODEBASE_ANALYSIS.md` describes a Firebase architecture that no longer exists) | High | Low-Medium | Reconcile as part of A3; treat `ARCHITECTURE.md` as the only current doc |

---

## 14. Estimated Development Time

Assumes one experienced RN + Go engineer, **with two physical Android devices available**.
Excludes SFU infrastructure provisioning (yours).

| Item | Build | Two-device / OEM testing | Total |
|---|---|---|---|
| **A0** Call engine consolidation | 8–11 d | 4–5 d | **12–16 d** |
| **A1** Surface working features | 2–3 d | 1–2 d | **3–5 d** |
| **A2** Server-side call sessions | 3–4 d | 1 d | **4–5 d** |
| **A3** Perf / size / dead code | 3–4 d | 2 d (build + push regression) | **5–6 d** |
| **Subtotal — Android core (A0–A3)** | | | **24–32 working days (~5–6.5 weeks)** |
| **A4** SFU integration (excl. infra) | 10–15 d | 5–7 d | **15–22 d** |
| **A5** Roles / webinar / broadcast (Android) | 15–20 d | 5 d | **20–25 d** |
| **Total Android through A5** | | | **59–79 working days (~12–16 weeks)** |

Not estimated (Pending – Future Development): iOS parity, Web, Tauri desktop, Creator Studio,
RTMP egress, cloud recording infrastructure.

**Confidence:** high on A0–A3 (the code is fully understood). **Low on A4–A5** — they depend
on infrastructure that does not exist yet, and `PHASE6_NOTES.md` is right that an SFU
"cannot be written blind."

---

## 15. Development Roadmap

```
Week 1-3   A0  Call engine        [lib/call/, components/call/, hooks/useCall]
                                  flag: CALL_ENGINE_V2=false → device matrix → true
Week 4     A1  Surface features   [group call entry points, screen-share decision]
Week 5     A2  Call sessions      [066_calls.sql, routes/calls.go, synced history]
Week 6-7   A3  Perf & size        [dead code, deps, TURN cache, boot deferrals]
           ── ANDROID CORE COMPLETE · release candidate · versionCode 16 ──
Week 8+    ⛔ GATE: SFU host provisioned by you?  ── no ──► stop; ship A0-A3
                        │ yes
Week 8-11  A4  LiveKit SFU        [transport/sfu.ts, Go token minting, SFU_ENABLED]
                                  mesh remains the ≤5 E2EE path
Week 12-16 A5  Roles / webinar    [call_participants.role, raise-hand, audience UI]
           ── PENDING – FUTURE DEVELOPMENT: iOS · Web · Tauri desktop · Creator Studio · RTMP ──
```

**Milestone gates:**
- **After A0:** every existing call scenario passes the `CALLS_README.md` matrix on ≥3 OEMs. If it does not, do not proceed — revert the flag.
- **After A3:** measured APK size delta and cold-start delta, or the changes do not ship.
- **Before A4:** SFU host exists, is monitored, and has a budget. Otherwise stop at A3 — **A0–A3 is a complete, shippable, self-contained improvement.**

---

## 16. Final Recommendations

1. **Approve A0–A3 first, and treat them as the whole of Phase 2.** They are self-contained, need no new infrastructure, remove more code than they add, and leave the app strictly better. A4–A5 should be a separate approval once the SFU host exists.

2. **Consolidate the call engine before adding a single call feature.** Every roadmap item — roles, raise-hand, recording, SFU — costs 3× today and will produce 3 different bugs. This is the highest-leverage change available in the repository.

3. **Do not touch `services/crypto` or the Rust crates.** Frozen, vector-tested, parity-proven, and the reason a future Tauri desktop client can be protocol-compatible on day one.

4. **Do not refactor `app/chat.tsx`.** It is large but stable and performant. Your own refactoring rules say leave it. Measure with the `lib/perf.ts` tracer that already exists; only act if the data says so.

5. **Ship the mesh group call that already works.** It is finished code with no entry point. That is the cheapest user-visible win in this repo — days, not weeks.

6. **Be honest in the UI about what is not built.** `app/screen-share.tsx` currently shows a full control panel over an `Alert` admitting nothing is transmitted, and `app/call-recording.tsx` records the device mic rather than the call. The repo has a strong documented honesty mandate (`docs/FEATURE_GAP_MATRIX.md` has a whole "STUB / THEATER" section) — these two are the remaining violations in the call surface.

7. **Treat the SFU as an operations decision, not an engineering task.** LiveKit is the right choice for this stack, but the code is the small part. Validate the `@livekit/react-native-webrtc` ↔ VaultBeam data-channel interaction **before** committing.

8. **Keep the mesh path for small E2EE calls even after the SFU lands.** ≤5 participants stays end-to-end encrypted; >5 goes SFU. This preserves the product's central promise instead of quietly trading it away for scale.

9. **Reconcile the docs as you go.** `CODEBASE_ANALYSIS.md` (49 KB) describes a Firebase/Firestore architecture that has been deleted. Either delete it or mark it historical — it will mislead the next engineer, exactly as `ARCHITECTURE.md` records happening before.

10. **Budget testing at ~40% of build time for anything touching calls.** Every serious call bug in this repo's history — the dropped answer, the lost socket listener, the OEM ring failures — was only findable on real devices on real networks.

---

**Awaiting your approval before any code is written.**

If you'd like, I can narrow or re-order the plan first — e.g. approve only A1 (ship the working
group call) to get a fast win, approve A0–A3 as the full Phase 2, or ask me to expand any
section (per-file diffs for A0, the `066_calls.sql` schema, or the LiveKit evaluation) in more
detail before deciding.
