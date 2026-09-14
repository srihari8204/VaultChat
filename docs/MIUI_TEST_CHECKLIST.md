# MIUI test checklist — Redmi Note 8 Pro, MIUI V125 / Android 11, arm64-v8a

The hardware gate in `CALLS_README.md`, run in order, on the device class it
names first. Do **Phase 0 before anything else** — four of the later steps
cannot pass without it, and MIUI gives no error when they fail, it just does
nothing.

---

## Phase 0 — MIUI settings (once, by hand, before testing)

None of these can be toggled by the app. There is no API for any of them.

| # | Where | Set to |
|---|---|---|
| 0.1 | Settings → Apps → Manage apps → VaultChat → **Autostart** | ON |
| 0.2 | Settings → Apps → Manage apps → VaultChat → **Battery saver** | *No restrictions* |
| 0.3 | Settings → Apps → Manage apps → VaultChat → Other permissions → **Show on Lock screen** | ON |
| 0.4 | Settings → Apps → Manage apps → VaultChat → Other permissions → **Display pop-up windows while running in background** | ON |
| 0.5 | Settings → Apps → Manage apps → VaultChat → Notifications → **Incoming calls** channel | enabled, **Floating notification** ON, Lock screen = *Show content* |
| 0.6 | Recents (square button) → pull down on the VaultChat card → **padlock** | locked |

If a later call step fails, re-check 0.1/0.3/0.4 before filing a bug. Those
three are the usual cause and the app cannot detect them.

---

## Phase 1 — cold launch

1. Install the APK. Launch from the launcher.
   **Correct:** splash → onboarding or the chat list. No crash, no white screen.
   (Release build is R8-minified — a crash here is a missing ProGuard keep rule,
   check `logcat | grep -i "ClassNotFound\|UnsatisfiedLink"`.)
2. Onboarding step 7 "App Permissions" → tap **Grant Permissions**.
   **Correct:** system dialogs for camera, mic, contacts, location, notifications.
   Grant all. The "Full-screen calls" row does **not** appear on Android 11 —
   that row is Android 14+ only. Correct behaviour is its absence.
3. Settings → **Call reliability**.
   **Correct:** header reads "Xiaomi / Redmi / POCO (MIUI)" with 3 steps. Tap
   *Allow* (battery) → system dialog; tap *Open settings* → MIUI's **Autostart**
   list opens directly (not the generic app-info page). If it lands on app-info
   instead, note it: the MIUI class name has moved and the deep link fell back.

## Phase 2 — login

4. Sign in.
   **Correct:** chat list loads. `logcat | grep "\[push\]"` shows
   `[push] registered for call wake-ups`. Anything starting `[push][FAIL]` means
   the device has no call wake-up for this session — stop and fix before Phase 4.

## Phase 3 — messaging

5. From a second device, send this device a message while VaultChat is **open**.
   **Correct:** appears in the chat instantly, no status-bar notification.
6. Background VaultChat (home button). Send another.
   **Correct:** status-bar notification titled with the **chat name** (resolved
   locally — the push carries no content), body "New message". Send a third
   without opening: the same notification now reads "2 new messages".
7. Tap it. **Correct:** opens *that chat*, not the chat list.
8. Send a message from this device.
   **Correct:** delivers, ticks update.

## Phase 4 — calls (the actual gate)

Use a second account on another handset as the peer. `callId` is the chatId, so
use the same 1:1 chat throughout.

9. **Foregrounded.** VaultChat open on the chat list. Peer calls.
   **Correct:** the in-app incoming-call screen. Exactly **one** ring — no
   status-bar call notification alongside it (the native service suppresses
   itself when the app is in the foreground).
10. Answer. Talk both ways.
    **Correct:** two-way audio. A persistent "VaultChat call • in progress"
    notification with a running timer.
11. While connected, press **home**.
    **Correct:** audio continues. The ongoing notification stays.
12. Press **back** on the live call screen instead.
    **Correct:** shrinks to a floating PiP window, call stays up. It must not
    hang up.
13. Hang up. **Correct:** notification disappears within a second or two. Pull
    down the shade and confirm no orphaned "in progress" entry.
14. **Backgrounded.** Home button, screen stays on. Peer calls.
    **Correct:** full-screen call UI takes over, caller's **name** and **photo**
    (or a coloured initial), Answer/Decline. Decline → peer's ring stops.
15. **Force-stopped.** Swipe VaultChat away from Recents. Confirm it is gone.
    Peer calls.
    **Correct:** it rings from a cold start, full screen, name + photo.
    **This is the step Phase 0.1 (Autostart) gates.** No ring → re-check 0.1
    before anything else.
16. Answer it. **Correct:** app opens straight into the connected call with
    audio, not into the chat list.
17. **Lock screen.** Lock the phone (power button), screen off. Peer calls.
    **Correct:** screen wakes by itself, full-screen ring over the lock screen —
    not a banner sitting on top of the lock screen. **Phase 0.3 + 0.4 gate this.**
18. Decline from the lock screen without unlocking.
    **Correct:** ring stops; peer sees the call end.
19. **Missed call.** Peer calls, let it ring out / peer hangs up before you
    answer.
    **Correct:** ring clears and is replaced by "Missed call — <name>" with the
    caller's photo. Tap it → opens the calls list.
20. **Video.** Repeat 14 and 17 with a video call.
    **Correct:** same ring, "VaultChat video call" as the subtitle, camera
    preview on answer.
21. **Overnight / doze.** Leave the phone locked and idle 30+ minutes, then have
    the peer call.
    **Correct:** still rings. This is the one that Phase 0.2 (No restrictions)
    gates, and the one most likely to fail on MIUI.

---

## What "failed" means

- **Steps 15, 17, 21 fail → almost always Phase 0, not the app.** Re-run Phase 0,
  reboot, retry once before treating it as a bug.
- **Step 9 shows two rings** → real bug, the foreground arbitration in
  `VaultCallMessagingService.appInForeground()` mis-read the process state.
- **Step 13 leaves a stuck notification** → real bug in
  `CallForegroundService.stop()`.
- **Step 2's logcat shows `[push][FAIL] code=NO_PROVIDER`** → Play Services
  problem on the handset, not the app.
- **Nothing rings at all, on any step, on any setting** → check the backend
  first: `CALLS_README.md` §Hard prerequisites — a mismatched firebase-admin
  service account makes every send fail with `messaging/mismatched-credential`
  and looks exactly like an OEM kill from the device side.
