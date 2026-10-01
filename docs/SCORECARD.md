# VaultChat scorecard

A living score, out of 10, per feature. Every entry is measured against the code or the
live box, never against another document — several planning docs in this repo are months
stale and inflate or deflate what is actually true (see **Corrections** at the bottom).

**Update this file in the same commit as any change that moves a score.** The changelog is
the audit trail; an unexplained score move is a bug in this file.

Legend for the Δ column:

- **↑ / ↓** — the code changed and the score moved with it
- **=** — the code did not change; the previous score was **wrong** and is corrected here
- **—** — no movement since the last review

---

## Headline

| Dimension | Score | Basis |
|---|---|---|
| **Engineering quality** | **8.5** | 305k LOC, 432 test files, real X3DH + Double Ratchet, Go backend, Rust core, 138 migrations, deploy gating that refuses an unnamed tree |
| **Product validation** | **2.0** | 4 accounts, 90 messages, 4 chats, 6 calls ever — all the owner's own test accounts (prod, 2026-10-01) |
| **Combined, honestly** | **6.1** | Build quality is not the bottleneck. Distribution and verification are. |

A 10/10 is not reachable by writing more features. It needs real users; real users need a
distributable artifact; the artifact is currently debug-signed.

---

## Per feature

| Feature | Score | Δ | What caps it |
|---|---|---|---|
| Testing & verification rigour | 9.0 | — | 275 selftests + 157 Go test files, crypto vectors, parity gates, frozen socket contract. Cap: 72 of 155 selftests read source text rather than hitting Postgres/Redis |
| E2EE / crypto primitives | 8.5 | — | Real X3DH, Double Ratchet, X25519/Ed25519/HKDF/AES-GCM, signed + one-time prekeys, group sender keys, Shamir. **Cap: `MEDIA_E2EE`/`STORY_E2EE`/`GROUP_E2EE` are `true` in production and the round-trip verification their own comments demand has never run** |
| Messaging core | 8.5 | = | Durable outbox, catch-up, receipts, offline edit/delete/react, local-first cache. Corrected up: retry idempotency (VC-009) is shipped — migration 055 `UNIQUE (chat_id, sender_id, client_id)` plus re-select on conflict — not open as the parity table claims |
| Backend & data layer | 8.0 | — | Go, 138 migrations, contract tests, migration-ledger discipline. Cap: RLS is inert (the API connects as a superuser with `BYPASSRLS`) |
| Honesty / claim integrity | 8.5 | ↑ | Was 6.0. Deleted a screen claiming "encrypted with AES-256-GCM" that ran no crypto; stopped reporting push-token rows as a device count. Cap: `VAULT_CACHE_ENCRYPTED=false` while the product is positioned as a vault; call-recording needs a real notify + vault path, not just honest copy; the 227-task backlog is unswept for other overclaims |
| Cold start / performance | 8.0 | ↑ | Corrected up from 6.0: the 8–10s lag (Track A) is **fixed** — `socket.io-client` is not a dependency and three selftests enforce its absence; the client is CC-Wire protobuf. Now has a first measured baseline: median **2436 ms** to first frame (5 runs, emulator x86_64/API 36; pre-fix 2615 ms, difference within noise). Score moved for measurability + readable `[perf]` marks, NOT for a faster launch. Cap: no HANDSET number yet, and the 18s/15s/15s CC-Wire timeout ladder is still unexamined (`coldstart-evidence` D2) |
| Location / navigation | 7.5 | — | Self-hosted Valhalla + Photon, real turn-by-turn, works without GMS. Cap: the Photon index is not loaded, so geocoding still exits to komoot |
| 1:1 calls | 7.5 | — | LiveKit, native FCM ring, full-screen incoming from a cold start. Cap: 6 calls ever executed; no device matrix |
| VaultBeam P2P transfer | 7.0 | — | Rust transport, byte-identical wire parity gates. Cap: never passed the on-device cross-version gate; `vaultBeamController.ts:354` still re-uploads a whole file on transport switch |
| ShopBook | 7.0 | — | 5,364 lines, tax-inclusive money math, invoices, self-checked. Cap: zero real shops; money hard-codes two decimals, so BHD/KWD/JOD/TND and JPY/KRW/VND are unrepresentable |
| Theming | 7.0 | — | 99/145 screens; the tail is mostly deliberately always-dark. Cap: `theme-studio-ui` implementation not started (approval-gated) |
| Stories | 6.5 | — | `STORY_E2EE` on. Cap: no round-trip test at **any** layer, device or automated |
| Family Space / Emergency Connect | 6.0 | — | Deployed 2026-09-28. Cap: the feature's entire purpose is working when the app is **dead**, and that has never been tested on a device |
| Group calls | 5.0 | — | Screens exist and the SFU is reached. Cap: `calls-64-participant` has 11 open tasks, all device-gated; the client is 6-ready, not 64-ready |
| Ops resilience | 5.0 | — | Backups are good (nightly encrypted R2, verified through 2026-09-30). Cap: **0 Postgres replicas**, single shared box, pending kernel reboot, `caddy/Caddyfile:133` static upstream blocks go-api scale-out |
| Games | 4.0 | — | Cap: external binary, no source, no registry. Only 3 global tables, so private rooms are **impossible**, not merely unbuilt |
| Multi-device | 2.0 | — | Cap: the schema **forbids** it — `identity_keys.user_id` is a PRIMARY KEY and `/user/keybundle` does `ON CONFLICT DO UPDATE` + `DELETE FROM one_time_prekeys`, so a second install destroys the first device's identity |
| Distribution | 1.0 | — | Cap: debug-signed (`CN=Android Debug`), no Play listing, no keystore. `plugins/withReleaseSigning.js` is wired and ready but no-ops without credentials. **The cutover cost is now measured, not estimated:** a differently-signed APK is refused (`INSTALL_FAILED_UPDATE_INCOMPATIBLE`, reproduced 2026-10-02), so going to a real key forces uninstall → identity-key loss on every existing install |

Spec backlog: **949 done / 227 open** across 35 OpenSpec changes (81%). Roughly 60 of the
227 are device-, vendor- or authorization-gated rather than coding work.

---

## Changelog

| Date | Change | Commit | Feature | Score |
|---|---|---|---|---|
| 2026-10-01 | Baseline established from measured code and live prod | — | all | see table |
| 2026-10-01 | Deleted `app/email-bridge.tsx` (mock inbox claiming AES-256-GCM with no crypto) and its `Stack.Screen`; removed the push-tokens-as-devices count from `app/dashboard.tsx` | `2661de2` | Honesty / claim integrity | 6.0 → **8.0** ↑ |
| 2026-10-01 | De-lied `app/call-recording.tsx`: removed "All participants have been notified" (no notify path exists at all) and "Recording encrypted and saved to File Vault" (no encryption, no vault write). Kept the screen — the recording logic is real and three selftests reference it | `18c0661` | Honesty / claim integrity | 8.0 → **8.5** ↑ |
| 2026-10-01 | Corrected `docs/FEATURE_GAP_MATRIX.md` row claiming the three E2EE flags are OFF | `18c0661` | — (doc only) | — |
| 2026-10-02 | **Phase 4 signing-cutover hazard reproduced on-device**, no longer inferred: a release APK re-signed with a throwaway key is refused with `INSTALL_FAILED_UPDATE_INCOMPATIBLE`, so uninstall is the only route, and `allowBackup=false` means no restore — identity key and ratchet state are lost and `/user/keybundle` then overwrites the account identity. Throwaway key deleted | `5c1b186` | Distribution | no change (**1.0**) — risk now proven, not reduced |
| 2026-10-02 | **Plan correction:** FCM delivery, notification channels and permission flows are **account-gated, not device-gated**. `registerPushToken()` is called from `app/(tabs)/chats.tsx:262` (post-sign-in), so a signed-out install correctly has `POST_NOTIFICATIONS=false` and zero channels. An emulator cannot discharge them — they need an SMS OTP. Not a defect | `5c1b186` | (device register) | — |
| 2026-10-01 | **Found by running the app:** `addPersistentListener` gave every listener its OWN 30-attempt connect ladder, so 7 boot listeners (3 in `_layout`, 3 from a loop in `syncEngine.initSync`, 1 in `backgroundConnection`) produced **74 of the 77 `[perf]` marks** in a signed-out cold start — burying the boot marks `coldstart-evidence` needs. Replaced with one shared ladder; ramp kept verbatim. **Verified on-device: 74 → 13 attempts** in the same 14s window, which is exactly what one ramping ladder predicts. First-frame median moved 2615 → 2436 ms but the ranges overlap (2288-2813 vs 2082-2853) so at n=5 that is **within noise and not claimed**; the win is the removed work and legible instrumentation | `659ea79` | Cold start / performance | 7.5 → **8.0** ↑ |
| 2026-10-01 | **First measured cold start in the repo** (`coldstart-evidence` C3/C5, previously device-blocked): median **2615 ms**, 5 runs, range 2288–2813. Boundary = `am start -W` TotalTime (first frame). Emulator x86_64 / API 36 / 2048 MB — NOT a handset, so C3 stays open for real devices. First launch (8095 ms) discarded: it included dexopt | — | (measurement) | — |
| 2026-10-01 | Emulator verified available with no downloads (2 x86_64 AVDs, android-36 `google_apis` + `google_apis_playstore`, both with GMS so FCM is testable). Preserved the arm64 APK as `app-release-arm64-v8a.apk` and started an x86_64 release build so the ~25 emulator-reachable device-gated tasks can begin | `659ea79` | (device register) | — |
| 2026-10-01 | Corrected all 8 stale source documents catalogued below: `SECRETS.md` (claimed a release keystore exists — the most harmful one), `docs_latest/parity-status-vs-source.md` (header warning + VC-009 row), the arm64-only claim in `responsive-breadth-and-toolchain`, and transport-citation stamps on `SECOND_REPLICA_READINESS` / `AKAMAI_K8S_TOPOLOGY` / `PERF_AUDIT` | `6e99c75` | — (docs only) | — |
| 2026-10-01 | **Self-correction:** the cap added two rows above cited `chat-summary`/`tone-detector`/`translate` as live overclaims. They were deleted in `6e3e586` and have no routes — I trusted `FEATURE_GAP_MATRIX.md` without checking, the exact error this file exists to stop | `6e99c75` | Honesty / claim integrity | no change (**8.5**) |
| 2026-10-01 | Verified VC-009 retry idempotency already shipped (migration 055 + `chats_helpers.go:770`); the parity table listing it Not Started is three months stale | — | Messaging core | 8.0 → **8.5** = |
| 2026-10-01 | Verified Track A (the 8–10s lag) already fixed; `socket.io-client` absent and selftest-enforced | — | Cold start / performance | 6.0 → **7.5** = |

---

## Corrections to repo documents

Found while scoring. Each would mislead anyone planning from it.

**All eight were corrected in the source documents on 2026-10-01** — each now carries an
inline correction or a stale-citation stamp, so the error cannot be inherited by reading
the document alone. This table is kept as the record of what was wrong and why.

| Document | Wrong claim | Reality |
|---|---|---|
| `docs/FEATURE_GAP_MATRIX.md:41` | The three E2EE flags are OFF | All three are `true` (`constants/flags.ts:108,121,134`) |
| `docs_latest/parity-status-vs-source.md:70` | VC-009 Not Started | Shipped; that document is dated 2026-07-09 |
| `SECRETS.md:11-12` | `vaultchat-release.jks` and `keystore.properties` exist on disk | Neither exists; no release key has ever been created |
| `docs/SECOND_REPLICA_READINESS.md:34-41` | Cites `ioClient(SERVER_URL, {transports:['websocket']})` as the only socket construction | That code no longer exists; the client is CC-Wire |
| `docs/AKAMAI_K8S_TOPOLOGY.md:25` | Finding F4, "sticky sessions not required", derived from the citation above | The conclusion may still hold, but needs re-deriving under CC-Wire |
| `PERF_AUDIT.md:14,36` | The live transport is "Go + Socket.IO"; recommends enabling the Socket.IO Redis adapter | Socket.IO is gone; `REDIS_ADAPTER=1` is already on |
| `openspec/changes/responsive-breadth-and-toolchain` | Every release is arm64-only, so armv7 handsets get nothing | All four ABIs are the default (`plugins/withGradleMemory.js:27`, `android/gradle.properties:30`). The missing MSVC linker only blocks `npm run test:rust` |
| `docs/reviews/2026-09-08-full-stack-audit.md` | Reads as a list of open findings | It records findings **as found**. All 14 are closed; F03's fix is at `uploads.go:943` with a two-user regression test |

---

## How to score

A feature scores against what it would take for a stranger to trust it in production, not
against how much code exists. Two deductions recur:

1. **Shipped but unverified** caps a feature at roughly 6.5 however good the code is. A
   capability enabled in production with its own verification comment still outstanding is
   a liability, not a feature.
2. **Zero real usage** caps the product dimension regardless of engineering quality. Six
   calls and ninety messages cannot distinguish "works" from "has never been stressed".
