# VaultBeam shared-Rust transport — rollout & kill-switch (Phase 3, Step 6)

The Rust backend ships **disabled by default**. The Kotlin `VaultBeamStream`
module stays in the tree as the fallback, and the **R2 relay tier is always on**
as the ultimate baseline — so this is opportunistic and reversible at every
stage. No wire-format change, so old-build and new-build peers interoperate.

## Flag

`EXPO_PUBLIC_VAULTBEAM_NATIVE_BACKEND` — `kotlin` (default) | `rust`.
Read once at load by `lib/vaultBeamStreamNative.ts`, which prefers the Rust
module only when the flag asks AND its full method surface is present; any
capability gap falls back to Kotlin (breadcrumb), and no native module at all
falls back to the relay tier. iOS reports available when only the Rust module
is built (first iOS VaultBeam).

## Fallback chain (never crashes a transfer)

```
flag=rust → VaultBeamStreamRust present + full surface + loads? → RUST
          → else Kotlin VaultBeamStream present?                 → KOTLIN
          → else                                                  → relay-only
flag=kotlin (default) → Kotlin present? → KOTLIN → else (iOS) RUST → else relay
```
Below all of it, the orchestrator's tier fallback (LAN/P2P → R2 relay) is the
safety net. Every selection + fallback emits a `vaultbeam` Sentry breadcrumb.

## Stages — GREENFIELD launch (no users in production yet)

There are no active users and no old builds in the field, so the staged
old⇄new migration this plan originally assumed does not apply. The flag is
also build-time inlined (`EXPO_PUBLIC_*`), so with one launch build every
peer runs the same backend — mixed-backend pairs cannot occur in the field.

1. **Default (`kotlin`)** — this PR as committed. Rust built in but dormant.
2. **Internal build (`rust`)** — run the SIMPLIFIED device gate (DESIGN.md):
   two devices on the same rust build; transfer on LAN, P2P, and relay;
   sha256 match; kill-and-resume. Optional: one kotlin⇄rust smoke as
   kill-switch insurance (already proven at the byte level by the vectors).
3. **Launch with `rust` as the default** — the point of the phase (one shared
   core + iOS). Kotlin stays in the tree purely as the kill-switch.

The byte-identical wire still matters after launch: it is what makes the
kill-switch instant (in-flight transfers resume on the other backend) and
what keeps future build N ⇄ N+1 pairs interoperating forever.

## Kill-switch

Set `EXPO_PUBLIC_VAULTBEAM_NATIVE_BACKEND=kotlin` (or unset). Instant, no data
migration — both backends read/write identical bytes and the same op-sqlite
transfer state, so an in-flight transfer resumes on the other backend. The
Kotlin module and the relay tier are untouched by this phase.

## Prebuild checklist (Step 3b glue verification)

- One-time targets: `rustup target add aarch64-linux-android
  armv7-linux-androideabi i686-linux-android x86_64-linux-android
  aarch64-apple-ios aarch64-apple-ios-sim`; `cargo install cargo-ndk`.
- Android: `expo prebuild --platform android` runs `withVaultBeamRust`
  (toolchain-gated — skips cleanly to Kotlin if cargo-ndk is absent), builds
  `libvaultbeam_core.a` per ABI, links the JNI shim into `libvaultbeamnative.so`.
  Verify `VaultBeamStreamRust` appears in `NativeModules`.
- iOS: build `VaultBeamCore.xcframework` (build script in
  `services/vaultbeam/rust/`), `pod install`, verify the Swift module registers.
- Green gate at every commit: `npm run typecheck`, `lint`, `test:e2ee`
  (includes the vaultbeam vectors guard + Rust↔JS parity).
