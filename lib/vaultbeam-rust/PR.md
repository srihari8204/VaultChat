# Phase 3 — VaultBeam transport core to shared Rust (reuse Phase 1 crypto)

Moves VaultBeam's chunk crypto, framing, file IO, and LAN TCP into a shared
Rust core (`vaultbeam-core`) that **reuses the Phase 1 crypto-core for
AES-256-GCM** (one crypto implementation, not two), selectable at runtime,
**byte-identical on the wire**, shipped **disabled by default**. This unifies
the duplicated chunk crypto and gives **iOS VaultBeam for the first time**. The
Kotlin module stays as fallback; the **R2 relay tier is untouched** and remains
the always-available baseline.

## Wire-format invariance (the acceptance bar)

Nothing on the wire changed. The Kotlin `VaultBeamStream` contract is frozen as
golden vectors (`services/crypto/__vectors__/vaultbeam.json`, Step 0) and the
Rust core reproduces it **byte-for-byte**:

- `nonce` = 4B `transferId` UTF-8 prefix (zero-padded) ‖ `u64_be(chunkId)`
- `aad` = `"transferId|fileId|chunkId"`; `wire` = `ct ‖ 16B GCM tag`
- `chunkId` = plaintext offset (segmented) | global chunk index (uniform/P2/LAN)
- block wire = concat of chunk wires (partial tail); LAN frame =
  `[i32_be idx][i32_be ctLen][ct]` + token auth + 1-byte ack

Proven green: 16 Rust crate tests (incl. vectors), and the Rust↔JS parity gate
(`vaultbeam-parity.selftest.ts`) showing **Rust ≡ JS oracle ≡ frozen vectors**
across all golden chunks, 20 random cases (u64 nonce, empty plaintext),
sha256(file), and block layout. Because the vectors ARE the Kotlin contract,
this establishes Rust ≡ Kotlin's wire.

## Cross-version interop proof

Same wire ⇒ an old (Kotlin) peer and a new (Rust) peer interoperate on every
tier. The host half is proven above. The **on-device gate** (two real builds:
old⇄new on LAN, P2P, relay, both directions; resume across a backend switch;
throughput/memory vs Kotlin) is documented in `DESIGN.md` and is the sign-off
before staged rollout — it needs a device/prebuild, exactly like Phase 1's
on-device crypto soak.

## iOS enablement

No iOS VaultBeam native exists today. The shared Rust staticlib +
`VaultBeamCore.xcframework` + a thin Swift bridge give iOS the full byte
pipeline. `vaultBeamStreamNative.ts` now reports available on iOS when the Rust
module is built.

## Rollback

Per-stage and instant: `EXPO_PUBLIC_VAULTBEAM_NATIVE_BACKEND=kotlin` (kill-
switch). No data migration — identical bytes + identical op-sqlite state, so an
in-flight transfer resumes on the other backend. Fallback chain rust → kotlin →
relay never crashes a transfer; every selection/fallback leaves a Sentry
breadcrumb. Full rollout plan in `ROLLOUT.md`.

## What's shared vs platform (boundaries)

- **Rust (shared):** chunk seal/open (via crypto-core GCM), nonce/aad/geometry,
  positional file IO, sha256, prealloc/delete, blocking LAN TCP, block
  seal/open layout.
- **Platform (thin):** the RN bridge shim (Kotlin/JNI + iOS Swift) marshaling to
  the Rust C-ABI, and the presigned-URL HTTPS PUT/GET (Design A′ — avoids a Rust
  TLS stack; native proxy/background). WebRTC, `vaultbeam_*` signaling,
  negotiation, and op-sqlite state stay in JS — unchanged.

## Commits

Step 0 vectors → Step 1 design → Step 2 crate + crypto-core `gcm_*` → Step 3a
FFI + `vb-cli` → Step 3b block ops → Step 4 backend switch → Step 5 host parity
→ Step 6 docs. `withVaultBeamRust` + the Kotlin/JNI/iOS glue are
prebuild-verified. `npm run typecheck` (0 new errors), `lint`, `test:e2ee`
(vectors + parity) green at every commit.

## Out of scope (unchanged)

crypto-core internals (reuse only), the Go backend (Phase 2), the relay
protocol/routes, WebRTC itself, and any UI.
