# VaultChat — Production Call Reliability

Native foreground service + cold-start FCM + full-screen-intent ring + OEM survival.

## What this fixes
1. **Audio drops when backgrounded** → `CallForegroundService` (mic/camera FGS type + wake lock).
2. **No ring when app is killed** → backend high-priority **data-only** FCM → `VaultCallMessagingService.onMessageReceived` runs from a **cold start**, no JS needed for the initial ring.
3. **Ring shows caller name + DP** → full-screen `CATEGORY_CALL` notification: name = content title, DP = large icon (loaded async, **initials fallback**), Answer/Decline actions.
4. **Missed-call notification** → when a ring is cancelled unanswered (caller hangs up / times out → `/call/cancel`), the native service posts a lock-screen **"Missed call from X"** with the caller DP. Answering first (`dismissIncoming`) clears the marker so it's not shown for answered calls.

> We use a **full-screen-intent notification** for the lock-screen ring instead of `react-native-callkeep` (its peer deps conflict with this RN/Expo version, and FSI is the simpler, more reliable cold-start path). The CallKit/PushKit iOS path is below.

## ⚠️ Hard prerequisites (it won't ring without these)
1. **Correct FCM service account.** The backend must init firebase-admin with the **`vaultchatprod01`** service account (matches `google-services.json`). The current `serviceAccountKey.json` is the old `vaultchat-ce9e3` project → every send fails with `messaging/mismatched-credential`. Put the right key at `vaultchat-backend/serviceAccountKey.json` or `FIREBASE_SERVICE_ACCOUNT` env.
2. **This replaces the Expo-push + Notifee call layer** added earlier. Don't run both (double rings). Keep this one.

## Files
| File | Role |
|---|---|
| `plugins/withVaultChatCalls.js` | Config plugin: manifest perms + `<service>`/`<receiver>`, copies Kotlin, registers `CallPackage`, iOS `UIBackgroundModes` (voip/audio) |
| `plugins/android/CallForegroundService.kt` | Mic/camera FGS + wake lock (background audio) |
| `plugins/android/VaultCallMessagingService.kt` | Cold-start FCM → FSI ring with name + DP; `CallActionReceiver` for Decline |
| `plugins/android/CallModule.kt` / `CallPackage.kt` | JS bridge: start/stop FGS, FCM token, API context, drain decline |
| `lib/CallService.ts` | JS orchestration (register, foreground, initiate/cancel) |
| `lib/batteryOptimization.ts` | OEM auto-start deep links + battery-opt request |
| `app/call-reliability.tsx` | Settings › Call Reliability guide |
| `vaultchat-backend/lib/callFcm.js` | High-priority data-only FCM sender |
| `vaultchat-backend/routes/calls.js` | `/call/token`, `/call/initiate`, `/call/cancel` |
| `migrations/054_device_fcm_token.sql` | `devices.fcm_token` |

## Build
```bash
# 1. install (already done): react-native-device-info, expo-intent-launcher present
# 2. generate native projects (runs the config plugin)
npx expo prebuild --clean
# 3. build
eas build -p android --profile preview
# backend
docker compose up -d --build api fanout-worker
docker compose exec api node migrate.js up   # applies 054
```

## Wiring — ✅ DONE (already in the app)
| Where | What |
|---|---|
| `app/_layout.tsx` | `registerForCalls()` on startup (after token); `getInitialCallIntent()` → routes a notification-launched call to `incoming-call`; `drainDeclinedCall()` → emits `webrtc_end` for a decline made while killed |
| `app/voicecall.tsx` / `app/videocall.tsx` | `startCallForeground()`/`dismissIncomingNotification()` on connect; `stopCallForeground()` in teardown; `initiateCall()` (FCM ring) on outgoing dial; `cancelCall()` on hangup-before-answer (→ missed call) |
| `app/settings.tsx` | "Call reliability" row → `app/call-reliability.tsx` |
| native intent extras | `vc_action`, `callId`, `callerId`, `callerName`, `isVideo` — `getInitialCallIntent()` returns them so the in-app screen can answer (offer arrives via the caller's 3s socket re-emit) |

`callId` is the **chatId** (caller and callee agree on it) so `/call/cancel` correctly matches the callee's ring for the missed-call conversion.

## iOS — CallKit + PushKit (manual AppDelegate, Swift)
The plugin sets `UIBackgroundModes = [voip, audio, remote-notification]`. Add the PushKit/CallKit glue to `ios/<App>/AppDelegate.swift` after prebuild (or via a `withAppDelegate` mod):
```swift
import PushKit
import CallKit

// in AppDelegate:
lazy var provider: CXProvider = {
  let cfg = CXProviderConfiguration()
  cfg.supportsVideo = true
  cfg.maximumCallsPerCallGroup = 1
  cfg.supportedHandleTypes = [.generic]
  return CXProvider(configuration: cfg)
}()

func registerVoip() {
  let r = PKPushRegistry(queue: .main)
  r.delegate = self
  r.desiredPushTypes = [.voIP]
}

// PKPushRegistryDelegate — report to CallKit IMMEDIATELY (iOS kills VoIP perms otherwise)
func pushRegistry(_ r: PKPushRegistry, didReceiveIncomingPushWith payload: PKPushPayload,
                  for type: PKPushType, completion: @escaping () -> Void) {
  let d = payload.dictionaryPayload
  let name = (d["callerName"] as? String) ?? "VaultChat"
  let callId = (d["callId"] as? String) ?? UUID().uuidString
  let update = CXCallUpdate()
  update.localizedCallerName = name
  update.remoteHandle = CXHandle(type: .generic, value: callId)
  update.hasVideo = (d["isVideo"] as? String) == "true"
  provider.reportNewIncomingCall(with: UUID(uuidString: callId) ?? UUID(), update: update) { _ in completion() }
}
// CXProviderDelegate: didActivate audioSession → start WebRTC audio here.
```
iOS also needs a **VoIP push certificate** (`apns-push-type: voip`) uploaded to your APNs config. iOS is secondary for this app (Android-OEM user base).

## Test matrix (MUST test on device — cold start can't be validated in a simulator)
| Device | Background audio | Ring when KILLED | Lock-screen ring (name+DP) | Notes |
|---|---|---|---|---|
| **Xiaomi/Redmi (MIUI)** | ☐ | ☐ | ☐ | needs Autostart + "No restrictions" + lock in recents |
| **Oppo/Realme (ColorOS)** | ☐ | ☐ | ☐ | Startup Manager + Allow background activity |
| **Vivo/iQOO** | ☐ | ☐ | ☐ | Background startup + High background power |
| **Honor/Huawei** | ☐ | ☐ | ☐ | App launch → manual → all three toggles |
| **Samsung (One UI)** | ☐ | ☐ | ☐ | Never sleeping apps + Unrestricted |
| **Stock Android (Pixel)** | ☐ | ☐ | ☐ | baseline; should work after battery-opt allow |
| **iOS** | ☐ | ☐ | ☐ | CallKit + VoIP cert required |

For each: (a) connect a call → background the app → audio continues; (b) **swipe the app away (kill)** → have a peer call → it rings full-screen; (c) decline from the lock screen → caller sees it stop.

## OEM settings each device needs (in-app guide: Settings › Call reliability)
- **MIUI**: Autostart ON · Battery saver → No restrictions · lock app in recents.
- **ColorOS (Oppo/Realme)**: Startup manager → allow · Battery → allow background activity.
- **Vivo/iQOO**: Background startup → allow · High background power consumption → enable · Autostart.
- **Honor/Huawei**: App launch → Manage manually → Auto-launch + Secondary launch + Run in background.
- **Samsung**: Never sleeping apps → add · App battery → Unrestricted.
