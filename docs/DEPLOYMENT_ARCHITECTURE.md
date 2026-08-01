# VaultChat — Deployment Architecture: Before → After

This document captures how VaultChat's deployment shape changed with the recent
tech-stack migration:

- **Backend:** Node.js monolith → **Go-first** (`go-api` owns 100% of the client
  surface; Node survives only as a background render worker).
- **Mobile native core:** JS/TS crypto + transport → **Rust** (`crypto-core`,
  `vaultbeam-core`) bridged into Android via **Kotlin** JNI packages (and iOS via
  an xcframework).
- **Event/messaging substrate:** Kafka + Node fan-out workers → **in-process
  fan-out in Go** (Kafka retired to a `legacy` profile).

Both states run under **Docker Compose** on the same Hetzner box. The diagrams
below render natively on GitHub.

---

## 1. BEFORE — Node monolith (Dockerized)

One Node process (`server.js`, Express + Socket.IO) served every REST route, the
realtime layer, and all background jobs. Kafka was the durable bus and a separate
Node `fanout-worker` delivered messages over the Redis Socket.IO adapter. The
mobile app did crypto and VaultBeam transport in **TypeScript/JS**.

```mermaid
flowchart TB
    subgraph Client["📱 Mobile app — React Native / Expo"]
        JS["JS/TS app logic"]
        TSC["Crypto: TypeScript (AES-GCM in JS)"]
        TVB["VaultBeam transport: JS/TS"]
        JS --> TSC
        JS --> TVB
    end

    Client -->|"ONE SERVER_URL :3000"| NODE

    subgraph Docker["🐳 Docker Compose — Hetzner box"]
        NODE["🟢 api (Node monolith)<br/>Express + Socket.IO<br/>17 REST modules + realtime + jobs"]
        FANOUT["🟢 fanout-worker (Node)<br/>consumes message.created"]
        VLW["🟢 vaultlens-worker (Node)<br/>BullMQ AI render"]

        PG[("Postgres 16")]
        REDIS[("Redis 7<br/>presence + adapter + queues")]
        KAFKA[["Kafka (KRaft)<br/>durable message bus"]]
        MINIO[("MinIO / S3<br/>media")]
        VALHALLA["Valhalla<br/>OSM routing"]
        COTURN["coturn<br/>TURN/STUN (WebRTC)"]

        NODE --> PG
        NODE --> REDIS
        NODE --> KAFKA
        NODE --> MINIO
        NODE --> VALHALLA
        KAFKA --> FANOUT
        FANOUT --> REDIS
        FANOUT --> PG
        VLW --> REDIS
        VLW --> MINIO
    end

    Client -.->|WebRTC media relay| COTURN

    classDef node fill:#3f6212,stroke:#84cc16,color:#fff;
    classDef infra fill:#1e3a5f,stroke:#60a5fa,color:#fff;
    class NODE,FANOUT,VLW node;
    class PG,REDIS,KAFKA,MINIO,VALHALLA,COTURN infra;
```

**Characteristics**
- Node owns REST + Socket.IO + jobs in one image (also runnable bare-metal under
  `pm2` per `ecosystem.config.js` — the pre-Docker lineage).
- Message delivery: `Kafka → fanout-worker → Redis adapter`.
- Crypto and VaultBeam transport execute in the JS engine on-device.

---

## 2. AFTER — Go-first (Dockerized) + Rust/Kotlin native mobile

`go-api` now serves **all 17 REST modules and the Socket.IO/WebSocket layer**.
Caddy is the single ingress and the per-route switch. Fan-out is **in-process in
Go** — Kafka and the Node `fanout-worker` are retired to a `legacy` profile (not
started). Node persists **only** as `vaultlens-worker`, whose QueueEvents listener
pushes `vaultlens:ready/failed` into Go's sockets via an internal bridge.

On device, crypto (`crypto-core`) and VaultBeam transport (`vaultbeam-core`) are
now **Rust** staticlibs, bridged into Android through **Kotlin** JNI packages
(`libvaultbeamnative.so`) and into iOS via an xcframework — selectable by feature
flag.

```mermaid
flowchart TB
    subgraph Client["📱 Mobile app — React Native / Expo"]
        JS["JS/TS app logic"]
        subgraph Native["Native core (flag-selectable)"]
            KOT["🟣 Kotlin JNI packages<br/>VaultBeamStreamRust / Call modules"]
            RCRYPTO["🦀 crypto-core (Rust)<br/>AES-256-GCM staticlib"]
            RVB["🦀 vaultbeam-core (Rust)<br/>transport staticlib"]
            KOT --> RVB
            KOT --> RCRYPTO
        end
        JS --> KOT
        JS -. "flag=ts fallback" .-> RCRYPTO
    end

    Client -->|"ONE SERVER_URL :80 / :3000 compat"| CADDY

    subgraph Docker["🐳 Docker Compose — Hetzner box (default profile)"]
        CADDY["Caddy<br/>ingress + per-route switch"]
        GO["🔵 go-api (Go)<br/>17 REST modules + Socket.IO hub<br/>in-process fan-out + jobs"]
        VLW["🟢 vaultlens-worker (Node)<br/>BullMQ render + QueueEvents<br/>→ Go internal bridge"]

        PG[("Postgres 16")]
        REDIS[("Redis 7<br/>presence + queues")]
        MINIO[("MinIO / R2<br/>media")]
        VALHALLA["Valhalla<br/>OSM routing"]
        COTURN["coturn<br/>TURN/STUN (WebRTC)"]

        CADDY --> GO
        GO --> PG
        GO --> REDIS
        GO --> MINIO
        GO --> VALHALLA
        VLW --> REDIS
        VLW --> MINIO
        VLW -->|"POST /internal/emit"| GO
    end

    Client -.->|WebRTC media relay| COTURN

    subgraph Legacy["profile: legacy — NOT started (rollback/bench only)"]
        NODEAPI["🟢 api (Node)"]
        KAFKA[["Kafka"]]
        FANOUT["🟢 fanout-worker (Node)"]
    end
    CADDY -.->|"emergency per-route flip"| NODEAPI

    classDef go fill:#134e4a,stroke:#2dd4bf,color:#fff;
    classDef node fill:#3f6212,stroke:#84cc16,color:#fff;
    classDef rust fill:#7c2d12,stroke:#fb923c,color:#fff;
    classDef kot fill:#4c1d95,stroke:#a78bfa,color:#fff;
    classDef infra fill:#1e3a5f,stroke:#60a5fa,color:#fff;
    classDef legacy fill:#374151,stroke:#9ca3af,color:#d1d5db;
    class GO,CADDY go;
    class VLW,NODEAPI,FANOUT node;
    class RCRYPTO,RVB rust;
    class KOT kot;
    class PG,REDIS,MINIO,VALHALLA,COTURN infra;
    class KAFKA legacy;
```

**Characteristics**
- Caddy `:80` (and `:3000` compat so existing APKs keep working) → `go-api :4000`.
- Message delivery: **in-process in Go** — no Kafka, no fan-out worker on the hot
  path.
- `/internal/*` is key-guarded (`INTERNAL_EMIT_KEY`) and Caddy refuses it from
  outside; it's how the Node worker feeds results back into Go's sockets.
- Instant rollback: uncomment a route's block in `caddy/Caddyfile` +
  `docker compose --profile legacy up -d api` to route it back to Node.

---

## 3. Request/message flow — side by side

```mermaid
flowchart LR
    subgraph B["BEFORE"]
        direction TB
        b1["App"] --> b2["Node :3000"]
        b2 --> b3["Kafka"]
        b3 --> b4["fanout-worker"]
        b4 --> b5["Redis adapter"]
        b5 --> b6["Socket.IO → recipients"]
    end
    subgraph A["AFTER"]
        direction TB
        a1["App"] --> a2["Caddy :80"]
        a2 --> a3["go-api :4000"]
        a3 --> a4["in-process fan-out"]
        a4 --> a5["Go Socket.IO hub → recipients"]
    end
```

---

## 4. What changed, at a glance

| Layer | Before | After |
|---|---|---|
| **Client surface (REST + realtime)** | Node `api` (Express + Socket.IO) | **Go** `go-api` (all 17 modules + Socket.IO) |
| **Ingress** | Direct to Node `:3000` | **Caddy** `:80` / `:3000` compat, per-route switch |
| **Message fan-out** | Kafka → Node `fanout-worker` → Redis adapter | **In-process in Go** |
| **Kafka** | Durable bus (active) | Retired to `legacy` profile (not started) |
| **Node's role** | Everything | **Only** `vaultlens-worker` (BullMQ render) |
| **On-device crypto** | TypeScript AES-GCM | **Rust** `crypto-core` staticlib (flag) |
| **On-device VaultBeam transport** | JS/TS | **Rust** `vaultbeam-core` staticlib (flag) |
| **Android native bridge** | — | **Kotlin** JNI packages → `libvaultbeamnative.so` |
| **iOS native bridge** | — | Rust **xcframework** |
| **Orchestration** | Docker Compose (Node monolith) | Docker Compose, Go-first default profile |
| **Background jobs** | Node `server.js` | Ported into `go-api` (`internal/jobs`) |

**Unchanged infra** (both states, same Docker Compose): Postgres 16, Redis 7,
MinIO/R2 object storage, Valhalla routing, coturn TURN/STUN.

---

## 5. Deploy commands

**Before (Node monolith):**
```bash
docker compose up -d          # single Node api + kafka + fanout-worker + infra
```

**After (Go-first):**
```bash
docker compose -f docker-compose.yml -f docker-compose.prod.yml up -d --build
# default profile = caddy + go-api + postgres + redis + minio + valhalla +
# coturn + vaultlens-worker (Node). api / kafka / fanout-worker stay behind
# --profile legacy and are NOT started.
```

**Rust-enabled mobile build (opt-in via flags):**
```bash
EXPO_PUBLIC_CRYPTO_BACKEND=rust \
EXPO_PUBLIC_VAULTBEAM_NATIVE_BACKEND=rust \
  # then: cd android && ./gradlew assembleRelease
```

---

_Sources: `docker-compose.yml`, `docker-compose.prod.yml`, `DEPLOY_STEPS.md`,
`vaultchat-backend-go/MIGRATION.md`, `vaultchat-backend/DEPLOY_HETZNER.md`,
`services/vaultbeam/rust/Cargo.toml`, `plugins/vaultbeam-core-android/`._
