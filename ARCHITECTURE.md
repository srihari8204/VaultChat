# VaultChat — Architecture

> Reverse-engineered from source. Every claim below is grounded in the actual
> files (`server.js`, `routes/*`, `services/crypto/*`, `lib/*`,
> `constants/flags.ts`, `docker-compose.yml`) — nothing inferred.

VaultChat is a security-first encrypted messenger in three parts:

1. **Client** — Expo / React Native 0.81 app (`app/` via `expo-router`: 6 tabs +
   ~90 stack screens).
2. **Primary backend** — `vaultchat-backend/`, an Express + Socket.IO monolith on
   Postgres / Redis / Kafka / S3, Dockerized behind `https://api.corefinite.com`.
3. **Legacy Firebase plane** — still wired into part of the app (Auth / Firestore /
   Storage) plus a separate `server/index.js` Firebase-admin + Socket.IO server.

| | |
|---|---|
| App version | `1.1.0`, `main: expo-router/entry` |
| Runtime | React Native 0.81 · Expo 54 · Hermes · TypeScript |
| Backend | Node ≥18 · Express 4 · Socket.IO 4 |
| Datastores | Postgres 16 · Redis 7 · Kafka 3.8 (KRaft) · MinIO/S3 |
| E2EE | X3DH + Double Ratchet (`E2EE_ENABLED` + `E2EE_STRICT` = true) |
| Scale of surface | 16 route modules · ~60 SQL migrations |

---

## ⚠️ Key finding: two coexisting data planes

The app is **mid-migration** between two backends, and both are live in the code:

- **Primary (custom backend)** — `constants/server.ts` → `api.corefinite.com`;
  `lib/api.ts` (REST + JWT in SecureStore) and `lib/socket.ts` (Socket.IO).
  `lib/chatService.ts` posts messages to the `/chats` REST routes. **30 files**
  import `lib/api`.
- **Legacy (Firebase)** — **17 files** under `services/` and `lib/` still import
  `@react-native-firebase` (Auth / Firestore / Storage). `services/chatService.ts`
  writes messages *directly to Firestore*. A separate `server/index.js` runs a
  Firebase-admin + Socket.IO server.

So `services/chatService.ts` (Firestore) and `lib/chatService.ts` (REST backend)
are parallel implementations of the same concept. Treat the Firebase plane as
legacy-but-not-dead.

---

## 01 · System context & deployment

```mermaid
flowchart TB
  subgraph CLIENT["Mobile client — Expo / React Native"]
    APP["VaultChat app<br/>expo-router · Hermes"]
  end

  subgraph EDGE["Self-hosted backend — docker-compose"]
    API["api — Node/Express + Socket.IO<br/>server.js"]
    PG[("Postgres 16<br/>~60 migrations")]
    REDIS[("Redis 7<br/>pub/sub adapter + cache")]
    KAFKA[["Kafka 3.8 KRaft<br/>event bus"]]
    MINIO[("MinIO / S3<br/>media + attachments")]
    COTURN["coturn 4.6<br/>TURN/STUN relay"]
    WFAN["fanout-worker"]
    WLENS["vaultlens-worker"]
  end

  subgraph FB["Firebase (legacy / parallel plane)"]
    FAUTH["Auth"]
    FS[("Firestore")]
    FSTORE[("Storage")]
    SRV["server/ — Firebase-admin + Socket.IO"]
  end

  subgraph EXT["External services"]
    FCM["FCM push"]
    SMTP["Email — Resend / Nodemailer"]
    SMS["SMS / phone OTP"]
    MLAB["ModelsLab — AI / VaultLens"]
    GIF["GIF provider"]
  end

  APP -- "REST + JWT / lib/api.ts" --> API
  APP -- "Socket.IO / lib/socket.ts" --> API
  APP -- "WebRTC media" --> COTURN
  APP -. "17 files still use" .-> FAUTH
  APP -.-> FS
  APP -.-> FSTORE

  API --> PG
  API --> REDIS
  API --> KAFKA
  API --> MINIO
  API --> FCM
  API --> SMTP
  API --> SMS
  KAFKA --> WFAN
  KAFKA --> WLENS
  WLENS --> MLAB
  API --> GIF
  SRV -. Firestore .-> FS
```

`docker-compose.yml` services: `postgres`, `redis`, `kafka`, `minio`, `api`,
`coturn`, `vaultlens-worker`, `fanout-worker` (volumes: `pgdata`, `redisdata`,
`kafkadata`, `miniodata`).

---

## 02 · Client architecture

```mermaid
flowchart TB
  subgraph NAV["app/ — expo-router (file-based routes)"]
    LAYOUT["_layout.tsx<br/>ThemeProvider · fonts · socket · push · sync boot"]
    TABS["(tabs): chats · calls · status · alerts · mini · profile"]
    SCREENS["~90 screens<br/>chat · vault · vaultlens · games · sos · onboarding"]
  end

  subgraph SVC["services/ — feature logic"]
    CHATF["chatService (Firebase)"]
    AUTHF["authService · groupService · mediaService"]
    subgraph CRY["services/crypto — E2EE core (pure JS)"]
      E2EE["e2ee.ts — X3DH + Double Ratchet"]
      SK["senderKey · groupSession"]
      SESS["e2eeSession · messageStore · shamir"]
    end
    subgraph SEC["services/security"]
      VK["vaultKeys · sessionSeal · duressPin"]
      TE["threatEngine · auditChain · safetyNumber"]
    end
  end

  subgraph LIB["lib/ — transport & platform"]
    API["api.ts — REST + JWT refresh"]
    SOCK["socket.ts — Socket.IO client"]
    CHATB["chatService.ts — /chats REST + E2EE seam"]
    SYNC["syncEngine · messageQueue · localDb (op-sqlite)"]
    CALL["CallService · callCrypto · webrtc"]
    MEDIA["sendMedia · mediaCrypto · mediaStore"]
  end

  NAV --> SVC
  SCREENS --> LIB
  CHATB --> CRY
  CHATB --> API
  SOCK --> API
  CALL --> SOCK
  MEDIA --> API
  SYNC --> API
  AUTHF --> FBSDK["@react-native-firebase"]
  CHATF --> FBSDK
```

`app/_layout.tsx` boots the app: `ThemeProvider`, fonts, Socket.IO, push
(`notifee` + `lib/push`), E2EE identity provisioning, `syncEngine`, receipts,
media outbox, and Sentry.

---

## 03 · Backend architecture

```mermaid
flowchart TB
  CL["Client"]

  subgraph SERVER["server.js — Express app"]
    MW["middleware<br/>cors · JSON · JWT verify · rateLimit · Sentry"]
    subgraph ROUTES["routes/"]
      R1["auth · user · contacts"]
      R2["chats (1952 loc) · stories · channels · communities"]
      R3["uploads · vaultbeam · vaultlens · games · ai · gif · link · calls"]
      R4["admin (/api/admin)"]
    end
    IO["Socket.IO server<br/>join_chat · new_message · typing · calls · games · admin"]
  end

  subgraph LIBB["lib/"]
    STORAGE["storage.js — S3/MinIO presign"]
    DELIV["delivery.js — receipts"]
    KAF["kafka.js — producer"]
    CALLFCM["callFcm.js — call wake push"]
    VAULT["vault.js · vaultlensQueue"]
    MODELS["modelslab.js — AI"]
  end

  subgraph WORKERS["workers/ (BullMQ / Kafka consumers)"]
    FANOUT["fanout.js — msg fan-out"]
    VLENS["vaultlens.js — AI media gen"]
  end

  subgraph DATA["Datastores & infra"]
    PG[("Postgres — db.js / pg pool")]
    RD[("Redis — redis.js")]
    KFK[["Kafka"]]
    S3[("MinIO / S3")]
  end

  CL -- REST --> MW --> ROUTES
  CL -- WebSocket --> IO
  ROUTES --> LIBB
  IO --> RD
  ROUTES --> PG
  ROUTES --> RD
  LIBB --> S3
  ROUTES --> KAF --> KFK
  KFK --> FANOUT
  KFK --> VLENS
  FANOUT --> IO
  VLENS --> S3
```

Socket.IO uses a Redis adapter (`@socket.io/redis-adapter`) so
`io.to(room).emit(...)` reaches sockets across processes.

### Route modules (`vaultchat-backend/routes/`)

| Mount | Module | Responsibility | Size |
|---|---|---|---|
| `/auth` | auth.js | Register / login, JWT issue+refresh, phone OTP, onboarding, prekeys | 890 |
| `/user` | user.js | Profile, devices, privacy, backup keys, security events | 1651 |
| `/chats` | chats.js | **Core messaging** — chats, messages, reactions, receipts, polls | 1952 |
| `/uploads` | uploads.js | Attachment upload / S3 presign / retention | 421 |
| `/stories` | stories.js | Stories with story keys, text-status | 384 |
| `/channels` | channels.js | Creator channels + realtime broadcast | 238 |
| `/contacts` | contacts.js | Contact sync (peppered phone hash), discoverability | 234 |
| `/vaultbeam` | vaultbeam.js | Device-to-device large file transfer | 232 |
| `/vaultlens` | vaultlens.js | AI media generation queue | 192 |
| `/api/admin` | admin.js | Admin dashboard API (`admin/index.html`) | 245 |
| `/communities` `/call` `/link` `/gif` `/games` `/ai` | communities · calls · link · gif · games · ai | Communities, call wake/signaling, link preview, GIF, games, AI | 82–132 |

---

## 04 · Message send flow (1:1, E2EE)

```mermaid
sequenceDiagram
  autonumber
  participant S as Sender app
  participant CR as services/crypto (X3DH+Ratchet)
  participant API as Backend /chats
  participant DB as Postgres
  participant K as Kafka + fanout
  participant IO as Socket.IO
  participant R as Recipient app

  S->>API: GET peer key bundle (IK/SPK/OPK)
  S->>CR: encryptForChat(text) → Double Ratchet envelope
  CR-->>S: ciphertext (base64)
  S->>API: POST /chats/:id/messages (ciphertext + clientId)
  API->>DB: persist message row
  API->>K: publish message event
  K->>IO: fan-out to chat room / user room
  IO-->>R: new_message (ciphertext)
  R->>CR: decrypt via ratchet session
  R->>API: delivery + read receipts
  API-->>S: receipt relayed over socket
```

With `E2EE_ENABLED` + `E2EE_STRICT` both **true** (`constants/flags.ts`), the
server only ever sees ciphertext for direct chats; a missing peer key bundle
makes the send fail-and-retry rather than leak plaintext.

**Not yet enforced:** group chats send *graceful plaintext* (sender-key / group
E2EE is scaffolded in `services/crypto/senderKey.ts` + `groupSession` but not the
enforced path). Media-at-rest encryption is gated behind `MEDIA_E2EE` (default
off).

---

## 05 · Cryptography & security model

**Messaging E2EE (`services/crypto/`)**
- `e2ee.ts` — real X3DH key agreement + Double Ratchet, built on `@noble/curves`,
  `@noble/hashes`, `@noble/ciphers` (same code runs in Node + Hermes).
- `e2eeSession(.rn)` — session bootstrap & SecureStore persistence.
- `senderKey` / `groupSession` — group sender-keys (scaffold).
- `shamir.ts` — Shamir secret sharing for key recovery.
- 47 self-tests (`*.selftest.ts`) run under Node + Hermes.

**Device / vault security (`services/security/`)**
- `vaultKeys`, `sessionSeal` — session sealed under the unlock PIN.
- `duressPin` / `duressVault` — decoy vault on a coercion PIN.
- `threatEngine`, `securityScore`, `auditChain`.
- `safetyNumber` — Signal-style contact verification.
- Backend: Argon2 / bcrypt hashing, JWT, Postgres RLS migrations.

**Feature flags (`constants/flags.ts`)**

| Flag | Default | Gates |
|---|---|---|
| `E2EE_ENABLED` | **on** | 1:1 X3DH + Double Ratchet |
| `E2EE_STRICT` | **on** | Never silently sends plaintext (fail + retry) |
| `VAULT_SESSION_SEALED` | off | Session tokens sealed under unlock PIN |
| `VAULT_CACHE_ENCRYPTED` | off | At-rest encryption of local SQLite cache |
| `MEDIA_E2EE` | off | Per-file AES-256-GCM media encryption |

---

## 06 · Notable subsystems

| Subsystem | Client | Backend / infra |
|---|---|---|
| **Voice / video calls** | `lib/CallService`, `callCrypto`, WebRTC shim, `incoming-call` / `voicecall` screens | `/call` route, `callFcm` wake-push, **coturn** TURN relay, socket signaling |
| **Games** (chess, ludo, poker, …) | ~22 boards in `components/games/`, `gameEngines.ts` | `/games`, `gameStore.js`, socket game rooms + match queue |
| **VaultLens** (AI media) | `vaultlens` screens, catalog | `/vaultlens`, queue → `vaultlens-worker` → ModelsLab |
| **VaultBeam** (P2P transfer) | `vaultBeamTransfer`, native stream plugin | `/vaultbeam` route, chunked transfers |
| **Stories / Status** | `(tabs)/status`, `StoryRing` | `/stories`, story keys, fan-out worker |
| **Offline / sync** | `op-sqlite` localDb, `syncEngine`, `messageQueue`, `mediaOutbox` | REST reconciliation + socket catch-up |
| **Push** | `notifee`, `lib/push` | `push.js` → FCM, device FCM tokens |

---

## 07 · Tech stack summary

**Client** — React Native 0.81 · Expo 54 · expo-router · TypeScript · Socket.IO
client · op-sqlite · Sentry · Firebase RN SDK · TensorFlow.js (blazeface /
mobilenet for face auth) · ethers (decentralized-id) · `@noble` crypto.

**Backend & infra** — Node ≥18 · Express 4 · Socket.IO 4 (+ Redis adapter) ·
Postgres 16 (pg) · Redis 7 (ioredis) · Kafka (kafkajs) · BullMQ · MinIO / AWS S3 ·
firebase-admin · Argon2 / bcrypt · JWT · coturn · Docker Compose · PM2 · Sentry.
