# Tasks — Family Navigation

## 1. Engine

- [x] 1.1 `lib/nav/routeProgress.ts` — windowed projection, prefix-sum table,
      rescan guard, Kalman smoothing, off-route ladder, arrival. Self-checked.
- [x] 1.2 Wire into `navigationService.onFix`; one projection per fix, every
      distance derived from it.
- [x] 1.3 Gate rerouting on the confirmed verdict instead of `miss.missed`, so
      one bad sample cannot spend a Valhalla request.
- [x] 1.4 Publish `verdict` + `arrived` on `NavBanner` (additive).
- [x] 1.5 `lib/nav/navPresentation.ts` — camera ladder with hysteresis,
      off-route copy, distance/ETA formatting. Self-checked.

## 2. Native

- [x] 2.1 `services/nav/rust` — `nav-core` crate, C ABI mirroring `vc_crypto_call`.
- [x] 2.2 Link into the EXISTING `libvaultcrypto.so`; register `NavCore` as a
      second HybridObject from the same `JNI_OnLoad`. No second module/plugin/loader.
- [x] 2.3 `lib/nav/native/NavCore.ts` — backend selector with TS fallback.
- [x] 2.4 `tests/parity.rs` against vectors emitted by the TS reference.

## 3. UI

- [x] 3.1 `components/family/NavigationLayer.tsx` — maneuver capsule, dock,
      off-route banner, follow control, arrival card.
- [x] 3.2 `FamilyMap` reports user gestures (`onUserMove`) so Follow is explicit.
- [x] 3.3 Saved-place destination chips (own places only, real places only).
- [x] 3.4 Restore north-up when a session ends. *(Found on the Honor.)*
- [x] 3.5 `components/family/SelectedMemberSheet.tsx` — marker tap opens a
      sheet with distance, live status, Route / Follow / Chat, and Start
      navigation once a me→member route is drawn. Chat reuses the
      `createDirectChat` path from `family-member.tsx`.
- [x] 3.6 A me→member route can now be NAVIGATED from the route bar; it was
      CLEAR-only before, so "member → route → start" was impossible.

## 4. Verification

- [x] 4.1 `lib/nav/navE2E.selftest.ts` — 1540 assertions, 10 simulated scenarios.
- [x] 4.2 `cargo test` + `clippy -D warnings` + Android cross-compile.
- [x] 4.3 Symbol-verify `vc_nav_call`/`NavCore` inside the shipping APK.
- [x] 4.4 Install on both phones (md5-verified) and run the device map harness.
- [x] 4.5 Drive a real journey on the Honor: route overview → NAVIGATE → dock →
      manual reroute → end → camera restored.
- [x] 4.8 Device (Honor): marker tap → SelectedMemberSheet. Member was
      *Sharing off*, so the sheet showed the Unavailable state with Route and
      Follow disabled and Chat enabled; Chat opened the direct thread. Privacy
      honoured, not bypassed.
- [x] 4.9 Device (Honor): controlled GPS via shell test provider (burst
      re-add, the Honor purges overrides within ~30 s). Verified: maneuver
      capsule from real Valhalla maneuvers, Follow appears on a raw drag and
      restores on tap, `Checking route…` precedes any reroute, session
      survives every phase.
- [x] 4.10 DEFECT found by 4.9 and fixed: a large displacement arriving with a
      still sensor speed was BLENDED by the Kalman filter (estimate landed
      mid-route; remaining distance read 373/483 km at a static point).
      Process noise is now bounded below by the observed jump, in
      routeProgress.ts and lib.rs, with a test on each side.
- [ ] 4.11 Device: member → **route → Start navigation** with a SHARING member
      (needs the Redmi's owner to enable sharing; not bypassed).
- [ ] 4.12 Device: saved place → route → navigate → ARRIVED with controlled fixes.
      (Blocked on this account: it lacks `manage_zones`, so the Safe Zones tile
      is not drawn and the gate was NOT deep-linked around.)
- [x] 4.13 `NavCore.ts` now logs which backend bound (`console.warn`, kept in
      release like FamilyMap's basemap line) so runtime invocation is
      observable on any phone that surfaces app logs.
- [ ] 4.14 Device: read the `[NavCore] native backend bound` line during a
      real session. The Honor suppresses third-party logcat; needs the Redmi
      (logs) or the Honor's Project Menu log switch.
- [ ] 4.6 iOS — **blocked**: no `ios/` project and no macOS on this machine.
      `crypto-core` is Android-only today, so iOS runs the TS path by design.
- [ ] 4.7 Live off-route / arrival on a moving vehicle. The stationary bench
      cannot produce the fix sequence; proven in simulation only.
