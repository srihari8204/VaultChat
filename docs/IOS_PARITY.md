# iOS Parity — what works, what doesn't, and exactly what unblocks it

> Derived from the code, not from memory. Every claim below names the file that
> establishes it. Last reconciled against the tree at the `lib/call/native` seam.

## TL;DR

The TypeScript layer is ~95% platform-neutral and runs on iOS today. What is
missing is **native**, and it is missing in four specific places. Two of them
need a Mac; all of them need an Apple Developer account.

**The backend is already iOS-ready for calls.** This was overstated in the
earlier analysis and is worth correcting: `vaultchat-backend-go/internal/fcm/fcm.go`
already sends APNs VoIP headers through FCM's bridge —
`apns-push-type: voip`, `apns-priority: 10`, `apns-topic: <IOS_BUNDLE_ID>.voip`,
`content-available: 1`. No Go work is required for iOS calling. The gap is
entirely on the device plus credentials.

---

## Status by subsystem

| Subsystem | iOS today | Blocking gap |
|---|---|---|
| UI, navigation, theming | ✅ Works | — |
| Messaging, sync, offline queues, local DB | ✅ Works | — |
| E2EE (X3DH, ratchet, sender keys, media, stories) | ✅ Works, **TS backend** | `plugins/withCryptoCore.js` has no iOS branch, so iOS runs the TypeScript crypto rather than the Rust core. Correct and vector-proven, just slower on large media |
| 1:1 call, **foreground** | ✅ Should work | `@livekit/react-native-webrtc` + `react-native-incall-manager` both support iOS |
| 1:1 call, **backgrounded** | ❌ Broken | No CallKit → no audio session held |
| 1:1 call, **app killed** | ❌ Broken | No PushKit → nothing to receive the VoIP push the backend already sends |
| Incoming-call UI | ❌ Broken | `lib/callNotification.ts:22` returns early on non-Android |
| VaultBeam ≤ ~2 GB | ⚠️ Degraded | Rust iOS bridge is scaffolded (`plugins/vaultbeam-core-ios/`, `build-ios-xcframework.sh`) but the xcframework has never been built → JS-heap fallback |
| VaultBeam, backgrounded / > 2 GB | ❌ Broken | No foreground-service equivalent; needs background `URLSession` |
| Push (messages) | ⚠️ Unconfigured | `expo-notifications` supports APNs; no auth key, no `aps-environment` entitlement |
| Family Space background location | ✅ **Configured** | The one background subsystem already correct for iOS |
| Screenshot protection | ⚠️ **Detect-only, by design** | `lib/screenGuard.ts` models the asymmetry honestly: Android blocks (FLAG_SECURE), iOS can only detect (`UIScreen.isCaptured`) and refuses to decrypt while capture is live. **Do not "fix" this** |
| VaultView protected media | ✅ Implemented | `plugins/vaultview-ios/` Swift, wired by `withVaultView.js` |
| Haptic navigation | ⚠️ Degraded | `lib/nav/hapticPlayer.ts:31` — iOS ignores custom vibration patterns; needs Core Haptics |
| Scheduled messages | ➖ Not a gap in prod | `lib/scheduledRunner.ts` is Android-only, but `SCHEDULED_LOCAL = false`, so delivery is server-side on both platforms |
| Finance / Shop Book / notes / mini-apps | ✅ Works | Pure TS + SQLite |

---

## The four native gaps, in dependency order

### 1. Credentials (blocks everything, needs no Mac)

- Paid Apple Developer account
- Register bundle id `com.vaultchat.app`
- APNs auth key (`.p8`) for message push
- **VoIP push certificate**, uploaded to the **Firebase** project — FCM delivers
  the VoIP push, so it lives with Firebase, not in this repo
- `aps-environment` entitlement
- Decide `ITSAppUsesNonExemptEncryption` (see App Store section)

### 2. `eas build -p ios` spike (3–4 days, needs no Mac if using EAS cloud)

Build the tree as-is, with no new features, purely to find out what does not
compile. The known suspects, all present in `package.json`:
`expo-face-detector` (deprecated), `@react-native-voice/voice` (drags in legacy
`com.android.support`, already needs `withAppComponentFactoryFix.js` on Android),
and the `react-native-webrtc` pods.

**Do this before committing to any iOS estimate.** It moves the number by weeks
in either direction.

### 3. CallKit + PushKit (the real work — needs a Mac)

Fill in `lib/call/native/ios.ts`, which is a documented no-op scaffold today, and
add a `plugins/withVaultChatCallsIOS.js` + Swift sources mirroring how
`withVaultView.js` handles both platforms in one plugin.

Order matters, and step 3 is not a style preference:

1. `PKPushRegistry` with `desiredPushTypes = [.voIP]`; register the token so FCM
   can address the device.
2. `CXProvider` + `CXProviderDelegate`.
3. In `pushRegistry(_:didReceiveIncomingPushWith:for:completion:)` call
   `reportNewIncomingCall()` **synchronously**. iOS permanently revokes an app's
   VoIP push privileges if it accepts a VoIP push and does not report a call.
4. Start WebRTC audio in `provider(_:didActivate:)`, not before — CallKit owns
   the `AVAudioSession`.
5. Flip **both** `IOS_CALLKIT_IMPLEMENTED` in `plugins/withVaultChatCalls.js`
   (which re-adds the `voip` background mode) and `canRingWhenKilled` in
   `lib/call/native/ios.ts`, in the same change.

A starting `AppDelegate` sketch is in `CALLS_README.md` §iOS. It has never been
applied or compiled — treat it as a sketch.

> **Do this AFTER `CALL_ENGINE_V2` is validated.** The engine gives CallKit one
> seam (`NativeCallAdapter`) instead of three screens to wire. Doing it first
> roughly doubles the work.

### 4. Rust cores + background transfer (needs a Mac)

- **Crypto:** add an iOS branch to `plugins/withCryptoCore.js` and a
  `services/crypto/rust/build-ios-xcframework.sh`, mirroring the one that already
  exists at `services/vaultbeam/rust/build-ios-xcframework.sh`. Both crates are
  already `crate-type = ["lib", "staticlib"]`.
- **VaultBeam:** run the existing `build-ios-xcframework.sh` on macOS, then add
  background `URLSession` block transfer. This maps cleanly onto VaultBeam's
  block-indexed model (`{blockIndex, url}`), which is why it is feasible at all.

---

## Info.plist

**Already declared:** `NSCameraUsageDescription`, `NSMicrophoneUsageDescription`,
`NSSpeechRecognitionUsageDescription`, `NSFaceIDUsageDescription`,
`NSContactsUsageDescription`, `NSLocationWhenInUse…`, `NSPhotoLibraryUsageDescription`,
`NSPhotoLibraryAddUsageDescription`, `NSLocalNetworkUsageDescription`,
`NSLocationAlwaysAndWhenInUse…`, `NSLocationAlways…`, `NSMotionUsageDescription`,
`UIBackgroundModes: [location]` (+ `audio`, `remote-notification` injected by
`withVaultChatCalls.js`).

**Still needed:** `aps-environment` entitlement; `UIBackgroundModes: fetch` /
`processing` if background sync lands; `voip` re-added with CallKit.

**Deliberately NOT added** — both were in an earlier plan and reading the code
contradicted it:
- `NSBonjourServices` — the VaultBeam LAN tier dials a signalled site-local IPv4
  over direct TCP (`services/vaultbeam/rust/src/lan.rs`); it does not browse mDNS.
- `NSBluetoothAlwaysUsageDescription` — Bluetooth call audio is routed by
  `AVAudioSession` via `react-native-incall-manager`; nothing uses CoreBluetooth.
  Declaring an unused permission is itself a review question.

---

## App Store review

| Risk | Guideline | Action |
|---|---|---|
| `voip` background mode with no CallKit | VoIP policy | **Already fixed** — gated behind `IOS_CALLKIT_IMPLEMENTED=false` in `withVaultChatCalls.js`. Was a near-certain rejection |
| Stealth mode (app disguised as a calculator) | 2.3.1 / 4.3 | **Recommend disabling on iOS.** This is the pattern Apple removes; not worth the fight |
| Duress PIN + decoy vault (`app/duresspin.tsx`, `app/decoy-chats.tsx`) | 2.3.1 hidden features | Legitimate anti-coercion feature, but must be **disclosed and discoverable**, not concealed. Provide reviewer credentials for BOTH the real and decoy PIN in App Review notes |
| Panic wipe (`app/memoryshield.tsx`) | 2.3.1 | Disclose in review notes; keep user-initiated and clearly labelled |
| Strong encryption | Export compliance | `ITSAppUsesNonExemptEncryption` — this ships X25519 / Ed25519 / AES-256-GCM / ChaCha20-Poly1305, which is non-exempt. The honest value is `true` plus an annual self-classification report. **Account owner's decision — deliberately left unset in `app.json`** |
| Always-on location | 5.1.1 | Family Space justifies it; show clear in-app rationale before the prompt |

---

## Platform limits that cannot be engineered away

State these to users; do not paper over them.

1. **No screenshot blocking** — detection only. `lib/screenGuard.ts` already
   handles this correctly and says so.
2. **No persistent background socket** — push is mandatory. `lib/backgroundConnection.ts`
   is correctly Android-only.
3. **No arbitrary background execution** — transfers must use background `URLSession`.
4. **No custom vibration patterns** without Core Haptics.
5. **App disguise is effectively prohibited.**

---

## Out of scope

Desktop, Windows, Linux, macOS and Web remain **Pending – Future Development**.
Note for later: both Rust crates are format-frozen and vector-tested, so a future
Tauri client can link the same crates and be protocol-compatible on day one —
which is the standing argument for never editing them casually.
