# Device Security & Monitoring module

Privacy-first device-posture monitoring that replaces the old "Pegasus" tile
(`/aiguardian`). It **observes, scores, and alerts** — it does not retaliate.
Unlike `services/security/threatEngine.ts` (which drives the boot self-destruct),
this module has **no `wipe` path**: its worst action is a notification. Duress PIN,
key self-destruct, breach monitoring and threat-intel are intentionally **out of
scope** and live elsewhere.

## Working principle

Collect signals about the device, the OS state, and the app binary → convert them
into a weighted **0–100 risk score** with four bands → record every change in the
tamper-evident on-device audit chain → notify the user only on meaningful
transitions. Everything is evaluated on-device; nothing about the user's content
or app inventory leaves the phone.

Two rules are load-bearing and inherited from the rest of `services/security`:

1. **Never invent a verdict.** A factor that can't be evaluated yet is `pending`,
   carries zero weight, and is excluded from the score — never assumed safe. This
   is the same rule that replaced the old hardcoded "97/100".
2. **Detect, don't destroy.** Detection code that wipes data multiplies the cost
   of a false positive. Here the strongest response is "mark critical + alert".

## Status — what's in this folder now

| File | Status |
|------|--------|
| `riskEngine.ts` | ✅ **Shipped.** Pure, deterministic 0–100 scoring engine: per-signal weight × confidence, cluster overlap-capping, four bands, pending handling, remediation + band presentation tables. No RN imports. |
| `riskEngine.selftest.ts` | ✅ **Shipped.** 37 Node assertions (`npm test`), auto-discovered by `scripts/test-all.js`. Proves bands, capping, confidence weighting, pending=0-weight, clamping, determinism. |

The engine is the foundation every later slice depends on and the only part that
is fully verifiable off-device. The remaining slices need a custom dev build
(native module) and/or a real device, so they are **not** written blindly here.

## Scoring model (implemented)

`risk = min(100, Σ contribution)`, `contribution = rawWeight × confidence`, with
same-condition signals grouped into a cluster whose combined contribution is
capped (so a rooted phone showing su + Magisk + root can't be counted three
times). Confidence < 1.0 marks heuristic detections (e.g. hook frameworks, which
a determined attacker can hide) so they weigh less than deterministic ones (a
mismatched signing certificate).

Bands on the risk scale: **low** 0–14 · **medium** 15–34 · **high** 35–64 ·
**critical** 65–100. Lone root/jailbreak/Frida/re-signed-APK/failed-attestation
reach critical alone; config signals (dev options, USB) stay low and only
escalate in combination. Full weight/confidence table and cluster caps are in
`riskEngine.ts` (`CATALOG`, `CLUSTER_CAP`).

## Roadmap — remaining slices (not yet built)

Each needs an environment this repo build can't validate in isolation; they land
behind a feature flag, dark by default, exactly like the E2EE rollout.

1. **`postureStore.ts`** — persist the current + previous `PostureSnapshot`
   (SecureStore JSON), diff on each scan to emit `SECURITY_STATE_CHANGED` deltas.
2. **JS collectors** — map existing signals (`react-native-device-info`
   `isRooted`/`isEmulator`, `Settings` reads for dev-options/USB) into
   `SecuritySignal[]`. Reuses libs already in the bundle.
3. **`VaultShield` native module (Kotlin + Swift + Expo config plugin)** — the
   only substantial new native code: raw-socket Frida probe (replaces the broken
   HTTP probe in `securityService.ts`), `/proc/self/maps` + mount scan, ptrace
   self-check, signing-certificate digest, accessibility/IME/overlay enumeration.
   Requires `expo prebuild` + a custom dev build; cannot run in Expo Go.
4. **Attestation client + `/attest/verify` backend** — Play Integrity / App
   Attest, the one signal an on-device attacker can't forge (`INTEGRITY_VERDICT_FAILED`).
5. **Dashboard UI** — rebuild `/aiguardian` into the Security Hub reading the
   posture store (score ring, factor pills, last-scan, recommended actions,
   permanent "what this can't detect" disclosure). Renders bands via `BAND_META`.
6. **Notification wiring** — dedicated notifee "Security" channel; edge-triggered,
   cooldown-deduped, high/critical only.

Audit-chain recording (`services/security/auditChain.ts`) and its
zero-knowledge cloud mirror are reused as-is for the event log.

## Test

```
npm test -- deviceSecurity      # runs riskEngine.selftest.ts
```
