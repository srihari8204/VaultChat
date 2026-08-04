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
| `riskEngine.selftest.ts` | ✅ **Shipped.** 37 Node assertions. |
| `posture.ts` | ✅ **Shipped.** Turns an assessment into the dashboard's fixed, ordered factor rows (Device Integrity, Root, Frida, USB debugging, …) with `clear`/`warning`/`critical`/`pending`/`not_applicable` status; rollup rows take the worst member; `diffSnapshots()` reports only real, edge-triggered security transitions. Pure. |
| `posture.selftest.ts` | ✅ **Shipped.** 25 Node assertions. |
| `notificationPolicy.ts` | ✅ **Shipped.** Pure decision engine: edge-trigger (only worsenings push) + severity floor (warning/critical) + per-severity cooldown (critical 30 min, warning 12 h) + a single "significant score change" event. Injectable clock + last-sent map. |
| `notificationPolicy.selftest.ts` | ✅ **Shipped.** 12 Node assertions. |
| `orchestrator.ts` | ✅ **Shipped.** The scan pipeline — collect → score → build snapshot → diff → decide notifications → persist — pure via injected deps (collector, store, clock, platform). Returns notifications for the caller to record/fire; owns no RN side effects and no wipe. |
| `orchestrator.selftest.ts` | ✅ **Shipped.** 20 Node assertions (baseline→worsen→repeat, cross-scan cooldown, persistence round-trip, pending honesty). |
| `viewModel.ts` | ✅ **Shipped.** Pure mapping from a snapshot to the dashboard's render data: score/band header, per-status factor rows (colour + label), ranked & de-duplicated recommended actions, honest empty state, relative last-scan time. |
| `viewModel.selftest.ts` | ✅ **Shipped.** 26 Node assertions. |
| `collectors.ts` | ⚠️ **Device-only.** JS signal collector reusing the DeviceInfo probes from `securityService.ts` (root/emulator/USB); everything a native module is needed for is reported as `pending` (honest degradation). Not Node-tested — imports react-native. |
| `postureStore.ts` | ⚠️ **Device-only.** SecureStore-backed `StorageKV` + `scanDevice()` entry point wiring the tested core to the device. Not Node-tested — imports expo-secure-store. |

Wired into the app (device-only, not Node-tested):
- `app/aiguardian.tsx` — the **Security Hub** screen, a thin renderer over
  `viewModel`; calls `scanDevice()`, records each returned notification into the
  tamper-evident audit chain, shows the permanent "what this can't detect"
  disclosure.
- `app/(tabs)/mini.tsx` — the tile is renamed **Pegasus → Security Hub** (🛡️),
  same `/aiguardian` route.

**120 assertions total** (engine 37 + posture 25 + policy 12 + orchestrator 20 +
viewModel 26), auto-discovered by `scripts/test-all.js` (`npm test`).
The four pure modules are the complete decision core AND the end-to-end pipeline
— fully verifiable off-device. `collectors.ts` / `postureStore.ts` are thin RN
adapters that inject real dependencies into that tested core; they mirror
already-working app code and are marked device-only. The remaining slices need a
custom dev build (native module) and/or backend, so they are **not** written
blindly here.

### How the app calls it

```
import { scanDevice, getCurrentSnapshot } from 'services/security/deviceSecurity/postureStore';

const { snapshot, notifications } = await scanDevice();
// caller then: record each notification via auditChain.appendSecurityEvent(...)
//              and present it via the notifee "Security" channel.
// dashboard: getCurrentSnapshot() renders the last posture without re-scanning.
```

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

- ✅ **`postureStore.ts`** — SecureStore-backed persistence + `scanDevice()`
  entry point (shipped, device-only adapter).
- ✅ **JS collectors** — `collectors.ts` maps `react-native-device-info`
  `isRooted`/`isEmulator`/`isAdbEnabled` into `SecuritySignal[]` with honest
  `pending` for everything native-only (shipped, device-only adapter).

Remaining:

1. **`VaultShield` native module (Kotlin + Swift + Expo config plugin)** — the
   only substantial new native code: raw-socket Frida probe (replaces the broken
   HTTP probe in `securityService.ts`), `/proc/self/maps` + mount scan, ptrace
   self-check, signing-certificate digest, accessibility/IME/overlay enumeration.
   Its collector output merges into `collectJsSignals`, moving those types from
   `pending` → evaluated. Requires `expo prebuild` + a custom dev build.
- ✅ **Dashboard UI** — `app/aiguardian.tsx` rebuilt as the Security Hub over
  `viewModel` + `getCurrentSnapshot()`/`scanDevice()`; tile renamed to
  Security Hub (device-only, not Node-testable here).
- ✅ **Audit recording** — the screen records each returned notification via
  `auditChain.appendSecurityEvent`, so events reach the Alerts tab + ZK backup.

Remaining:

2. **Attestation client + `/attest/verify` backend** — Play Integrity / App
   Attest, the one signal an on-device attacker can't forge (`INTEGRITY_VERDICT_FAILED`).
3. **Push + background wiring** — present notifications on a dedicated notifee
   "Security" channel and wire `scanDevice()` into the app-launch deferred pass
   plus a WorkManager/BGTask periodic job. (The screen already runs a scan on
   demand; this adds passive, scheduled monitoring.)

Audit-chain recording (`services/security/auditChain.ts`) and its
zero-knowledge cloud mirror are reused as-is for the event log.

## Test

```
npm test -- deviceSecurity      # runs riskEngine.selftest.ts
```
