# VaultChat — Fix Status and Updated Ratings

_Updated 2026-10-04 · branch `ccr-9258b8b7-m4748a` · baseline `18eb6d2` (the rating in `2026-10-04_screen_ratings.md`)_

This file tracks what the remediation plan (`2026-10-04_screen_remediation_plan.md`) has fixed and the updated rating of every screen.

**Status of all fixes below:** written and committed, with typecheck, lint and tests passing. Nothing has been deployed or tried on a phone yet. Items marked 📱 need a device check before they count as verified.

## 1. Summary

| | Before (baseline) | Now |
|---|---|---|
| Screens rated | 193 | 174 remain (19 mock/legacy/unwired routes deleted) |
| Mean score, all 193 screens | 6.0 | — |
| Mean score, the 174 that remain | 6.2 | **7.1** |
| Screens improved / unchanged / worse | — | **132 / 42 / 0** |
| Screens at 8 or above | 7 | 28 |
| Screens below 5 | 32 | 2 (the `group-chat` and `creator-channels` redirect shims) |
| Highest score | 8 | 8 |
| `tsc --noEmit` | 0 errors | 0 errors |
| `expo lint` | 0 errors, 267 warnings | 0 errors, 158 warnings |
| `npm test` | 351/355 | 386/390 (35 new selftest suites) |
| `openspec validate --all --strict` | 48/50 | 49/51 (the same two changes fail, for having no deltas) |

The four `npm test` failures before and after are the same. All four are environmental: `lib/call/minimize`, `lib/layoutMetrics` and `services/securityEmulatorFlag` need the generated `android/` folder, and `utils/moneySeam` needs Node 24.

**How the new ratings were produced.** Reviewers who had not written any of the fixes re-scored every changed screen with the original six-dimension rubric. They checked each fixer's claims against the code and reported regressions. Two re-rating rounds ran:
- **Round 1:** 147 screens, after the first fix round.
- **Round 2:** 36 screens, after a second round that fixed the regressions round 1 found.

Every score cites `path:line`; the evidence is in the appendix. Screens whose file did not change keep their baseline score.

**Why no screen reaches 10.** Scores stop below 10 for these reasons:
- Some fixes still need a device check.
- Some fixes are blocked on backend changes (§4).
- Large files are still unsplit: `chat.tsx` and `shop-book.tsx`.
- The app-wide accessibility work is not done: most rows, chips and toggles still lack screen-reader roles and state.

Each screen's remaining "Still needed for 10/10" list is in the appendix.

## 2. What was fixed

Fixes were written by 9 parallel packages in round 1, an integration pass, and 5 packages in round 2.

| Area | Main fixes |
|---|---|
| **Fake / unwired screens** | Deleted 19 routes that faked outcomes or duplicated real screens: scanner, email-bridge, vaultdrop, contact, the legacy lock, security-questions, biometric-setup, setup-complete, call-recording, voice-effects, meeting-scheduler, stickers, msgrequests, voice-speed, voice-transcribe, slideshow, current-location, location-sharing and sync-contact. Offline Mode now reads the real outbox; Network test counts only real requests. Copy that claimed outcomes the code doesn't produce is corrected. Toggles nothing reads are removed. |
| **Vault & PINs** | The Vault opens with the PIN the app actually sets. A new key format survives PIN changes, and old files still open. The vault refuses to save over an unreadable file list. Decrypted copies are cleaned up. Changing the Device PIN needs the current PIN. The chat-lock PIN uses salted scrypt with backoff. Delete account checks the MPIN (on the phone only; see §4). |
| **Locks & launch** | The app relocks on resume (📱). Notification taps wait for the lock and sign-in screens and are replayed after unlock. `/blocked` shows a threat result only when a scan actually found one, so a crafted link can't fake one. The root has an error boundary. |
| **Chat** | Link previews are sent. A failed edit is rolled back. A locked chat sends no read receipts, clears no notifications, and its messages are hidden from screen readers. View-once and Invisible Ink text never leaves the bubble: no forward, copy, star, export or reminder text, and the pinned bar is masked. Bookmarks and scheduled messages keep no plain-text copy on the phone. Export chat can be reached again. The @mention picker opens again. |
| **Media** | Video seek works and load errors show (📱). The media viewer no longer restarts playback. Image-editor brush, brightness and contrast reach the saved image. Shelf and gallery respect view-once. Decrypted temp files are cleaned up. The archive viewer checks sizes before unpacking. The login token is sent only to the app's own server. |
| **Safety & family** | SOS is sent before any permission prompt. It goes to all trusted contacts if the contact list fails to load, and includes the position only if it is under 5 minutes old (📱). The `[sos-probe]` debug logging is removed. Navigation uses the route you picked. Location Lock shows a live marker and reports errors. Family circles are created as typed groups. Privacy copy now says positions are also stored on the server. |
| **Spaces** | Runs carry stops with a place and time, riders are assigned to stops, and drivers can mark every rider. The device-side command collector is in place: ring and message work, other commands are reported as unsupported. Links and shift editors added. Load errors replace false "nothing here" states. |
| **Shop Book / Finance / Admin** | Shop Book: each shop has its own cart, the Pro badge shows only when the server says the shop is entitled, verification documents can be uploaded, errors show a retry, and deletes ask for confirmation. Finance: iOS date picker, correct chitti member numbering, snooze keeps a reminder recurring, honest PDFs. CSV import/export escapes formulas and skips duplicates, and restore runs in one transaction. Admin pages: locked-down CSP, no inline handlers, confirmations, and the log token is kept for the browser session only. |
| **Groups & tabs** | Communities keep their cached list when offline. One shared permission check decides who can change roles or remove members. Note and task edits from someone posing as another member are rejected. Calendar reminders are scheduled and respect lock-screen privacy. A failed privacy save is reported. `/add`, `/join` and `/i` links ask before acting. New call actually starts a call. |
| **Calls & games** | Back on an incoming call declines it, and double taps are guarded. The live host can always end the broadcast. Call buttons tell screen readers whether they are on or off. Join-by-code asks which game. Resign, Drop and Clear ask for confirmation. Your chosen ringtone is used. |

The per-item logs, with evidence for each claim, were kept in the working session (`fixes/P1–P9, H, R1–R5`). The re-ratings in the appendix verify those claims against the code.

## 3. Regressions found and fixed

The independent re-raters found problems that the fixes had introduced or left behind. All of the following are now fixed:
- **Notification taps:** they could land on top of the lock screen. A later fix made every tap after a locked launch get held forever. Both are resolved, and a selftest covers "locked at launch, unlocked since".
- **SOS:** a failed contact load blocked sending entirely.
- **Status privacy:** a failed load could be saved over the server's list, and switching from "except" to "only" reused the excluded list as the allowed list.
- **Encrypted notes:** after a failed load, attaching a file could create a replacement key.
- **Chat:** Invisible Ink text showed in the pinned bar, and the lock screen said "Incorrect PIN" during the backoff wait.
- **Exports and reminders:** they included view-once and Invisible Ink text.
- **Vault:**
  - An unreadable file list could be overwritten.
  - Deleting a file before saving the list could leave an entry pointing at a deleted file.
  - Export could share an empty list.
- **Group calendar:** reminders showed other members' event titles on the lock screen.
- **Communities:** a client-only "owner" rule contradicted the server.
- **Media viewer:** the login token could be sent to any host named in a link.

## 4. Blocked — needs a backend or ops change (not deployable from here)

| Item | What is needed |
|---|---|
| Delete account | The server's `DELETE /user/account` should require the MPIN; today only the phone checks it (`vaultchat-backend-go/internal/routes/user.go`). |
| Shop Book "other" reject reason | The endpoint has no field for the typed text (`shopbook.go` `sbOwnerSetStatus`). |
| Admin returns filter | `sbAdminReturns` should honour `?shopId=`. |
| Pro upgrade | There is no owner "request Pro" or purchase endpoint. The button was removed instead of faking it. |
| Spaces "Call guardian" | `runGet` should return guardian contacts to the assigned driver. |
| Spaces shift | Needs `GET` for the shift; it is cached on the phone until then. |
| Spaces stops | Saving stops deletes and re-creates them, so arrival marks are lost on edit. |
| `/join` preview | There is no endpoint that shows a group's name before joining. |
| Shared https links | Host `assetlinks.json` on `vaultchat.app`, then set `autoVerify: true`. iOS also needs Associated Domains. |

## 5. Decisions for you

- **Legacy call code (~1,170 lines).** It never runs while `CALL_ENGINE_V2` is on. `constants/flags.ts` keeps it as the rollback until the hardware test pass in `CALLS_README.md` has been done, so it was not deleted.
- **Calendar reminders under the "hidden" notification preview.** They currently fire with generic text instead of being dropped.
- **Sealed caches.** The ghost-mode list and the session IPs now go only to the encrypted cache. While `VAULT_CACHE_ENCRYPTED` is off, those two screens have nothing to show offline.
- **Deleted screens that worked.** `voice-speed`, `voice-transcribe` and `slideshow` worked but had no entry point. They were deleted per the plan; restore them from git and wire them in if you want them.
- **Two group-creation flows.** "New group" now uses invites with consent. The Family-Space `group-create` flow is unchanged.

## 6. Still open (known, not done)

- A family-alert tap while the app is only backgrounded doesn't route yet (`lib/callBackground.ts` has no family branch).
- The resume relock applies only to users with device MFA.
- `index.tsx` can still replace a tap on an allowed cold start. This existed before the fixes.
- Plan Phase 3 app-wide items, which belong to `interaction-integrity` and `glass-screen-polish`:
  - a stricter accessibility check across every touchable;
  - splitting `chat.tsx` and `shop-book.tsx`;
  - the remaining hard-coded colours.
- Every remaining per-screen gap is listed under "Still needed for 10/10" in the appendix.

## 7. Updated scorecard — all 193 screens

The **Round 1** column is the first re-rating. **Now** is the latest score: round 2 where a screen was re-rated again, otherwise round 1, otherwise unchanged.

| Area | Screen | Before | Round 1 | Now | Δ | Status |
|---|---|---|---|---|---|---|
| Launch, auth & lock | `app/(tabs)/_layout.tsx` | 7.5 | 7.5 | **7.5** | 0 | re-rated |
| Launch, auth & lock | `app/_layout.tsx` | 6.5 | 7 | **7** | +0.5 | re-rated |
| Launch, auth & lock | `app/app-lock.tsx` | 6 | 7 | **7.5** | +1.5 | re-rated |
| Launch, auth & lock | `app/backup-pin.tsx` | 4.5 | 7 | **7** | +2.5 | re-rated |
| Launch, auth & lock | `app/biometric-setup.tsx` | 3.5 | — | **—** |  | deleted |
| Launch, auth & lock | `app/blocked.tsx` | 6.5 | 7 | **7.5** | +1 | re-rated |
| Launch, auth & lock | `app/delete-account.tsx` | 7.5 | 8 | **8** | +0.5 | re-rated |
| Launch, auth & lock | `app/email-verify.tsx` | 7.5 | — | **7.5** | 0 | unchanged |
| Launch, auth & lock | `app/index.tsx` | 7 | 7.5 | **7.5** | +0.5 | re-rated |
| Launch, auth & lock | `app/lock.tsx` | 2.5 | — | **—** |  | deleted |
| Launch, auth & lock | `app/mpin-entry.tsx` | 7.5 | 8 | **8** | +0.5 | re-rated |
| Launch, auth & lock | `app/mpin-recover.tsx` | 7 | 7 | **7** | 0 | re-rated |
| Launch, auth & lock | `app/onboard-mpin.tsx` | 8 | — | **8** | 0 | unchanged |
| Launch, auth & lock | `app/onboard-profile.tsx` | 6.5 | — | **6.5** | 0 | unchanged |
| Launch, auth & lock | `app/onboard-security.tsx` | 7.5 | — | **7.5** | 0 | unchanged |
| Launch, auth & lock | `app/onboard-success.tsx` | 7.5 | — | **7.5** | 0 | unchanged |
| Launch, auth & lock | `app/onboard.tsx` | 7.5 | — | **7.5** | 0 | unchanged |
| Launch, auth & lock | `app/permissions.tsx` | 6.5 | 6.5 | **6.5** | 0 | re-rated |
| Launch, auth & lock | `app/restore-backup.tsx` | 6.5 | 7 | **7** | +0.5 | re-rated |
| Launch, auth & lock | `app/security-questions.tsx` | 3.5 | — | **—** |  | deleted |
| Launch, auth & lock | `app/setup-complete.tsx` | 4.5 | — | **—** |  | deleted |
| Tabs, contacts & links | `app/(tabs)/alerts.tsx` | 6.5 | 7.5 | **7.5** | +1 | re-rated |
| Tabs, contacts & links | `app/(tabs)/calls.tsx` | 6.5 | 7.5 | **7.5** | +1 | re-rated |
| Tabs, contacts & links | `app/(tabs)/chats.tsx` | 7 | 7.5 | **7.5** | +0.5 | re-rated |
| Tabs, contacts & links | `app/(tabs)/mini.tsx` | 8 | — | **8** | 0 | unchanged |
| Tabs, contacts & links | `app/(tabs)/profile.tsx` | 6.5 | 7 | **7** | +0.5 | re-rated |
| Tabs, contacts & links | `app/(tabs)/status.tsx` | 6.5 | 6.5 | **6.5** | 0 | re-rated |
| Tabs, contacts & links | `app/add/[...segments].tsx` | 6.5 | 8 | **8** | +1.5 | re-rated |
| Tabs, contacts & links | `app/contact-info.tsx` | 6.5 | 7 | **7** | +0.5 | re-rated |
| Tabs, contacts & links | `app/contact.tsx` | 3 | — | **—** |  | deleted |
| Tabs, contacts & links | `app/contacts.tsx` | 6.5 | 7 | **7** | +0.5 | re-rated |
| Tabs, contacts & links | `app/i/[token].tsx` | 6 | 6.5 | **7** | +1 | re-rated |
| Tabs, contacts & links | `app/invite-link.tsx` | 7 | 7.5 | **7.5** | +0.5 | re-rated |
| Tabs, contacts & links | `app/join/[code].tsx` | 7 | 8 | **8** | +1 | re-rated |
| Tabs, contacts & links | `app/msgrequests.tsx` | 4 | — | **—** |  | deleted |
| Tabs, contacts & links | `app/new-chat.tsx` | 6.5 | 7.5 | **7.5** | +1 | re-rated |
| Tabs, contacts & links | `app/qr-contact.tsx` | 6.5 | 7 | **7** | +0.5 | re-rated |
| Tabs, contacts & links | `app/search.tsx` | 7.5 | 8 | **8** | +0.5 | re-rated |
| Tabs, contacts & links | `app/sync-contact.tsx` | 5.5 | — | **—** |  | deleted |
| Tabs, contacts & links | `app/verify-contact.tsx` | 7.5 | 8 | **8** | +0.5 | re-rated |
| Chat conversation | `app/chat.tsx` | 6 | 7.5 | **7.5** | +1.5 | re-rated |
| Chat tools & backup | `app/app-lock-chats.tsx` | 3.5 | 7.5 | **7.5** | +4 | re-rated |
| Chat tools & backup | `app/backup-e2ee.tsx` | 6 | 7.5 | **7.5** | +1.5 | re-rated |
| Chat tools & backup | `app/bookmarks.tsx` | 5.5 | 7.5 | **7.5** | +2 | re-rated |
| Chat tools & backup | `app/broadcast.tsx` | 5.5 | 7 | **7** | +1.5 | re-rated |
| Chat tools & backup | `app/chat-backup.tsx` | 6 | 7 | **7** | +1 | re-rated |
| Chat tools & backup | `app/chat-code.tsx` | 7 | 8 | **8** | +1 | re-rated |
| Chat tools & backup | `app/chat-export.tsx` | 5.5 | 6 | **7** | +1.5 | re-rated |
| Chat tools & backup | `app/chat-themes.tsx` | 6 | 7.5 | **7.5** | +1.5 | re-rated |
| Chat tools & backup | `app/chat-wallpaper.tsx` | 5.5 | 7 | **7** | +1.5 | re-rated |
| Chat tools & backup | `app/create-poll.tsx` | 7 | 8 | **8** | +1 | re-rated |
| Chat tools & backup | `app/hidden-chats.tsx` | 5.5 | — | **5.5** | 0 | unchanged |
| Chat tools & backup | `app/import-chats.tsx` | 6.5 | 7.5 | **7.5** | +1 | re-rated |
| Chat tools & backup | `app/in-chat-search.tsx` | 7 | 8 | **8** | +1 | re-rated |
| Chat tools & backup | `app/message-reminder.tsx` | 5.5 | 7 | **7.5** | +2 | re-rated |
| Chat tools & backup | `app/receipt-control.tsx` | 6.5 | 7 | **7** | +0.5 | re-rated |
| Chat tools & backup | `app/schedule-message.tsx` | 6.5 | 8 | **8** | +1.5 | re-rated |
| Chat tools & backup | `app/scheduled.tsx` | 6 | 7 | **7** | +1 | re-rated |
| Chat tools & backup | `app/stickers.tsx` | 4.5 | — | **—** |  | deleted |
| Groups & communities | `app/communities.tsx` | 5.5 | 6.5 | **6.5** | +1 | re-rated |
| Groups & communities | `app/create-group.tsx` | 6 | 7 | **7** | +1 | re-rated |
| Groups & communities | `app/creator-channels.tsx` | 3.5 | 4.5 | **4.5** | +1 | re-rated |
| Groups & communities | `app/group-admin.tsx` | 5.5 | 6 | **6** | +0.5 | re-rated |
| Groups & communities | `app/group-calendar.tsx` | 6 | 7 | **7** | +1 | re-rated |
| Groups & communities | `app/group-calls.tsx` | 5.5 | 7 | **7** | +1.5 | re-rated |
| Groups & communities | `app/group-chat.tsx` | 4 | — | **4** | 0 | unchanged |
| Groups & communities | `app/group-create.tsx` | 7 | — | **7** | 0 | unchanged |
| Groups & communities | `app/group-info.tsx` | 6 | 7 | **7** | +1 | re-rated |
| Groups & communities | `app/group-insights.tsx` | 6.5 | 6.5 | **6.5** | 0 | re-rated |
| Groups & communities | `app/group-invitations.tsx` | 7 | — | **7** | 0 | unchanged |
| Groups & communities | `app/group-invites.tsx` | 7 | 7 | **7** | 0 | re-rated |
| Groups & communities | `app/group-join.tsx` | 7 | — | **7** | 0 | unchanged |
| Groups & communities | `app/group-members.tsx` | 7 | 7.5 | **7.5** | +0.5 | re-rated |
| Groups & communities | `app/group-notes.tsx` | 6 | 7 | **7** | +1 | re-rated |
| Groups & communities | `app/group-privacy.tsx` | 6.5 | 7.5 | **7.5** | +1 | re-rated |
| Groups & communities | `app/group-tasks.tsx` | 6.5 | 7.5 | **7.5** | +1 | re-rated |
| Groups & communities | `app/group-trip.tsx` | 6.5 | 7.5 | **7.5** | +1 | re-rated |
| Calls, live & voice | `app/call-recording.tsx` | 3.5 | — | **—** |  | deleted |
| Calls, live & voice | `app/call-reliability.tsx` | 6.5 | — | **6.5** | 0 | unchanged |
| Calls, live & voice | `app/group-call-active.tsx` | 6.5 | 7 | **7** | +0.5 | re-rated |
| Calls, live & voice | `app/incoming-call.tsx` | 6.5 | 7.5 | **7.5** | +1 | re-rated |
| Calls, live & voice | `app/live-view.tsx` | 6.5 | 6.5 | **7** | +0.5 | re-rated |
| Calls, live & voice | `app/live.tsx` | 7 | — | **7** | 0 | unchanged |
| Calls, live & voice | `app/live/join/[code].tsx` | 7 | — | **7** | 0 | unchanged |
| Calls, live & voice | `app/network-test.tsx` | 5 | 7 | **7** | +2 | re-rated |
| Calls, live & voice | `app/videocall.tsx` | 6.5 | 6.5 | **6.5** | 0 | re-rated |
| Calls, live & voice | `app/voice-effects.tsx` | 4 | — | **—** |  | deleted |
| Calls, live & voice | `app/voice-speed.tsx` | 4.5 | — | **—** |  | deleted |
| Calls, live & voice | `app/voice-transcribe.tsx` | 6 | — | **—** |  | deleted |
| Calls, live & voice | `app/voicecall.tsx` | 6.5 | 7 | **7** | +0.5 | re-rated |
| Media & files | `app/archive-viewer.tsx` | 6.5 | 7.5 | **7.5** | +1 | re-rated |
| Media & files | `app/camera.tsx` | 7.5 | 7.5 | **7.5** | 0 | re-rated |
| Media & files | `app/docscanner.tsx` | 5.5 | 6 | **6** | +0.5 | re-rated |
| Media & files | `app/file-preview.tsx` | 5 | 7 | **7.5** | +2.5 | re-rated |
| Media & files | `app/file-viewer.tsx` | 6.5 | 6.5 | **6.5** | 0 | re-rated |
| Media & files | `app/image-editor.tsx` | 4 | 5.5 | **5.5** | +1.5 | re-rated |
| Media & files | `app/media-gallery.tsx` | 6 | 6 | **6** | 0 | re-rated |
| Media & files | `app/media-viewer.tsx` | 4.5 | 6 | **6** | +1.5 | re-rated |
| Media & files | `app/reader.tsx` | 7.5 | 8 | **8** | +0.5 | re-rated |
| Media & files | `app/scanner.tsx` | 2 | — | **—** |  | deleted |
| Media & files | `app/shelf.tsx` | 6.5 | 8 | **8** | +1.5 | re-rated |
| Media & files | `app/slideshow.tsx` | 4.5 | — | **—** |  | deleted |
| Media & files | `app/story-viewer.tsx` | 6.5 | 7.5 | **7.5** | +1 | re-rated |
| Media & files | `app/video-player.tsx` | 3.5 | 5.5 | **5.5** | +2 | re-rated |
| Media & files | `app/whiteboard.tsx` | 4.5 | 5.5 | **5.5** | +1 | re-rated |
| Family Circle | `app/family-add.tsx` | 7 | 7.5 | **7.5** | +0.5 | re-rated |
| Family Circle | `app/family-alerts.tsx` | 7.5 | 8 | **8** | +0.5 | re-rated |
| Family Circle | `app/family-history.tsx` | 6 | 7.5 | **7.5** | +1.5 | re-rated |
| Family Circle | `app/family-items.tsx` | 6 | 6.5 | **6.5** | +0.5 | re-rated |
| Family Circle | `app/family-map.tsx` | 5.5 | 7 | **7** | +1.5 | re-rated |
| Family Circle | `app/family-member.tsx` | 6.5 | 7 | **7** | +0.5 | re-rated |
| Family Circle | `app/family-places.tsx` | 6.5 | 7.5 | **7.5** | +1 | re-rated |
| Family Circle | `app/family-setup.tsx` | 6 | 7.5 | **8** | +2 | re-rated |
| Family Circle | `app/family.tsx` | 6 | 7 | **7** | +1 | re-rated |
| Location & safety | `app/aiguardian.tsx` | 7 | 7.5 | **7.5** | +0.5 | re-rated |
| Location & safety | `app/current-location.tsx` | 4.5 | — | **—** |  | deleted |
| Location & safety | `app/emergency-sos.tsx` | 4.5 | 6.5 | **7** | +2.5 | re-rated |
| Location & safety | `app/location-lock.tsx` | 5.5 | 6.5 | **7** | +1.5 | re-rated |
| Location & safety | `app/location-sharing.tsx` | 4.5 | — | **—** |  | deleted |
| Location & safety | `app/location.tsx` | 6 | 6.5 | **6.5** | +0.5 | re-rated |
| Location & safety | `app/lock-alert.tsx` | 6 | 6.5 | **7** | +1 | re-rated |
| Location & safety | `app/lock-history.tsx` | 6 | 6.5 | **7** | +1 | re-rated |
| Location & safety | `app/lock-settings.tsx` | 6 | 6.5 | **6.5** | +0.5 | re-rated |
| Location & safety | `app/navigate.tsx` | 6 | 7 | **7** | +1 | re-rated |
| Location & safety | `app/trusted-contacts.tsx` | 6 | 7 | **7** | +1 | re-rated |
| Spaces | `app/space-admin.tsx` | 6 | 7 | **7** | +1 | re-rated |
| Spaces | `app/space-attendance.tsx` | 5 | 5 | **5** | 0 | re-rated |
| Spaces | `app/space-checkin.tsx` | 5.5 | 6.5 | **6.5** | +1 | re-rated |
| Spaces | `app/space-devices.tsx` | 4.5 | 6 | **6.5** | +2 | re-rated |
| Spaces | `app/space-incidents.tsx` | 5.5 | 7 | **7** | +1.5 | re-rated |
| Spaces | `app/space-leave.tsx` | 6 | 6 | **6** | 0 | re-rated |
| Spaces | `app/space-ops-map.tsx` | 5.5 | 6.5 | **6.5** | +1 | re-rated |
| Spaces | `app/space-overview.tsx` | 6 | 6.5 | **6.5** | +0.5 | re-rated |
| Spaces | `app/space-pending.tsx` | 5.5 | 7 | **7** | +1.5 | re-rated |
| Spaces | `app/space-people.tsx` | 6 | 7 | **7** | +1 | re-rated |
| Spaces | `app/space-roster.tsx` | 6 | 7 | **7** | +1 | re-rated |
| Spaces | `app/space-run-driver.tsx` | 5 | 6.5 | **6.5** | +1.5 | re-rated |
| Spaces | `app/space-run.tsx` | 6 | 6.5 | **6.5** | +0.5 | re-rated |
| Spaces | `app/space-runs-admin.tsx` | 4.5 | 6.5 | **7** | +2.5 | re-rated |
| Spaces | `app/space-tasks.tsx` | 6 | 7 | **7** | +1 | re-rated |
| Spaces | `app/space-transport.tsx` | 6.5 | 6.5 | **6.5** | 0 | re-rated |
| Spaces | `app/space-visitors.tsx` | 5.5 | 6.5 | **6.5** | +1 | re-rated |
| Finance | `app/finance/_layout.tsx` | 8 | — | **8** | 0 | unchanged |
| Finance | `app/finance/calendar.tsx` | 6.5 | 7 | **7** | +0.5 | re-rated |
| Finance | `app/finance/chitti/[id].tsx` | 5 | 6 | **6** | +1 | re-rated |
| Finance | `app/finance/chitti/index.tsx` | 7 | 7 | **7** | 0 | re-rated |
| Finance | `app/finance/chitti/new.tsx` | 7 | 7 | **7** | 0 | re-rated |
| Finance | `app/finance/customer.tsx` | 6 | 6.5 | **6.5** | +0.5 | re-rated |
| Finance | `app/finance/emi.tsx` | 7.5 | 8 | **8** | +0.5 | re-rated |
| Finance | `app/finance/index.tsx` | 6.5 | 7.5 | **7.5** | +1 | re-rated |
| Finance | `app/finance/interest.tsx` | 7 | 7 | **7** | 0 | re-rated |
| Finance | `app/finance/io.tsx` | 6.5 | 7.5 | **7.5** | +1 | re-rated |
| Finance | `app/finance/ledger/[id].tsx` | 6.5 | 7 | **7** | +0.5 | re-rated |
| Finance | `app/finance/ledger/edit.tsx` | 6 | 7 | **7** | +1 | re-rated |
| Finance | `app/finance/ledger/index.tsx` | 7 | 7 | **7** | 0 | re-rated |
| Finance | `app/finance/ledger/new.tsx` | 6.5 | 7 | **7** | +0.5 | re-rated |
| Finance | `app/finance/ledger/update.tsx` | 6.5 | 7.5 | **7.5** | +1 | re-rated |
| Finance | `app/finance/reminders.tsx` | 6 | 7 | **7** | +1 | re-rated |
| Finance | `app/finance/reports.tsx` | 6 | 6.5 | **6.5** | +0.5 | re-rated |
| Finance | `app/finance/saved.tsx` | 6.5 | 6.5 | **6.5** | 0 | re-rated |
| Finance | `app/finance/search.tsx` | 6 | 6.5 | **6.5** | +0.5 | re-rated |
| Finance | `app/interest-calculator.tsx` | 7 | — | **7** | 0 | unchanged |
| Finance | `app/split.tsx` | 7 | — | **7** | 0 | unchanged |
| Shop Book & admin | `admin/index.html` | 6.5 | 7 | **7** | +0.5 | re-rated |
| Shop Book & admin | `admin/logs.html` | 6.5 | 7 | **7** | +0.5 | re-rated |
| Shop Book & admin | `admin/shopbook.html` | 5.5 | 7 | **7** | +1.5 | re-rated |
| Shop Book & admin | `app/shop-book.tsx` | 5.5 | 6.5 | **6.5** | +1 | re-rated |
| Settings, privacy & vault | `app/d2de-status.tsx` | 5 | 7 | **7** | +2 | re-rated |
| Settings, privacy & vault | `app/encrypted-notes.tsx` | 5 | 6 | **6** | +1 | re-rated |
| Settings, privacy & vault | `app/filevault.tsx` | 8 | — | **8** | 0 | unchanged |
| Settings, privacy & vault | `app/ghost-mode.tsx` | 6 | 8 | **8** | +2 | re-rated |
| Settings, privacy & vault | `app/last-seen-privacy.tsx` | 7 | 7.5 | **7.5** | +0.5 | re-rated |
| Settings, privacy & vault | `app/login-history.tsx` | 7.5 | 8 | **8** | +0.5 | re-rated |
| Settings, privacy & vault | `app/privacy-dashboard.tsx` | 4.5 | 8 | **8** | +3.5 | re-rated |
| Settings, privacy & vault | `app/settings.tsx` | 6.5 | 8 | **8** | +1.5 | re-rated |
| Settings, privacy & vault | `app/status-privacy.tsx` | 6.5 | 7 | **7.5** | +1 | re-rated |
| Settings, privacy & vault | `app/vault-features.tsx` | 3.5 | 6 | **6** | +2.5 | re-rated |
| Settings, privacy & vault | `app/vault.tsx` | 3.5 | 6 | **6.5** | +3 | re-rated |
| Settings, privacy & vault | `app/vaultbeam-settings.tsx` | 5.5 | 6.5 | **6.5** | +1 | re-rated |
| Settings, privacy & vault | `app/vaultcheck.tsx` | 7 | — | **7** | 0 | unchanged |
| Settings, privacy & vault | `app/vaultdrop.tsx` | 2.5 | — | **—** |  | deleted |
| Utilities & games | `app/cache-cleanup.tsx` | 7.5 | 8 | **8** | +0.5 | re-rated |
| Utilities & games | `app/dashboard.tsx` | 6.5 | 7 | **7** | +0.5 | re-rated |
| Utilities & games | `app/email-bridge.tsx` | 2.5 | — | **—** |  | deleted |
| Utilities & games | `app/eye-check.tsx` | 8 | — | **8** | 0 | unchanged |
| Utilities & games | `app/games.tsx` | 7.5 | 7.5 | **7.5** | 0 | re-rated |
| Utilities & games | `app/meeting-scheduler.tsx` | 4 | — | **—** |  | deleted |
| Utilities & games | `app/notification-sounds.tsx` | 6.5 | 7.5 | **7.5** | +1 | re-rated |
| Utilities & games | `app/notifications.tsx` | 6 | 7 | **7** | +1 | re-rated |
| Utilities & games | `app/offline-mode.tsx` | 3 | 8 | **8** | +5 | re-rated |
| Utilities & games | `app/perf-debug.tsx` | 8 | — | **8** | 0 | unchanged |
| Utilities & games | `app/storage-manager.tsx` | 6 | 7 | **7** | +1 | re-rated |
| Utilities & games | `app/vision-comfort.tsx` | 8 | — | **8** | 0 | unchanged |


## Appendix A — Round 1 re-rating (147 screens)

### A — Launch, Auth, Onboarding & App Lock — re-rating

Independent static re-review against base `18eb6d2` → `HEAD` (`f774ffa`), same rubric (`RUBRIC.md`). I read every screen in full, plus the changed helpers: `components/ResumeLock.tsx`, `lib/resumeLockPolicy.ts`, `services/lockService.ts`, `lib/postSignIn.ts`, `lib/routePattern.ts`, `components/{ErrorBoundary,UsageCounter,TermsGate,UpdateGate}.tsx`, `services/security/{pinFormat,pinStore}.ts`, `lib/onboarding.ts:86-98,162-168`, `lib/api.ts:58-76,199-222`, `lib/authNav.ts`, `lib/spaces/deviceAgent.ts`. I did not edit any repo file.

I re-ran these selftests and all passed: `lib/resumeLockPolicy`, `lib/routePattern`, `lib/orphanRoutes` (50 assertions), `lib/onboardNav`, `lib/launchVeil`, `lib/confirmIdentity`, `lib/screenBackCoverage`, `lib/a11yCoverage`, `services/security/pinFormat`. I confirmed that `app/lock.tsx`, `app/security-questions.tsx`, `app/biometric-setup.tsx` and `app/setup-complete.tsx` are deleted. These things cannot be checked statically: device behaviour (resume timing, navigation ordering, Modals left open over the lock) and server behaviour (MPIN lockout, `/auth/mpin/verify`). Fixes that depend on them are credited only for what the code shows.

| Screen | Old | New | Δ |
|---|---|---|---|
| `app/_layout.tsx` (root shell) | 6.5 | 7 | +0.5 |
| `app/index.tsx` | 7 | 7.5 | +0.5 |
| `app/(tabs)/_layout.tsx` | 7.5 | 7.5 | 0 |
| `app/mpin-entry.tsx` | 7.5 | 8 | +0.5 |
| `app/mpin-recover.tsx` | 7 | 7 | 0 |
| `app/app-lock.tsx` | 6 | 7 | +1 |
| `app/restore-backup.tsx` | 6.5 | 7 | +0.5 |
| `app/delete-account.tsx` | 7.5 | 8 | +0.5 |
| `app/blocked.tsx` | 6.5 | 7 | +0.5 |
| `app/permissions.tsx` | 6.5 | 6.5 | 0 |
| `app/backup-pin.tsx` | 4.5 | 7 | +2.5 |

---

#### `app/_layout.tsx` — **6.5 → 7**
- **Scores now:** Function 8 · States 8 · UI 7 · A11y 7 · Security 7 · Code 4
- **Original items:**
  1. ❌ The security verdict is still not ordered against the launch gate. `runSecurityCheck` → `router.replace('/blocked')` (`app/_layout.tsx:372-381`) still runs independently of the gate's `router.replace('/onboard'|'/app-lock')` (`:275,280,294`).
  2. ◐ Relock on resume is partly fixed. `<ResumeLock />` is mounted (`app/_layout.tsx:912`). It relocks after the configured timeout (`services/lockService.ts:137-148`, `lib/resumeLockPolicy.ts:86-88`), but only when device MFA is on (`components/ResumeLock.tsx:24`). A Device-PIN/sealed-session user without MFA is never relocked on resume.
  3. ✅ The root error boundary is fixed: `<ErrorBoundary screen="root">` wraps the providers (`app/_layout.tsx:1071-1077`).
  4. ✅ The orphan routes are fixed. The files are deleted and their `Stack.Screen` entries are gone (`app/_layout.tsx:945-948` no longer lists security-questions or biometric-setup, and `lock` is absent). `lib/orphanRoutes.selftest.ts` passes (50).
  5. ❌ The split is not done. The file is 1081 lines and still has 13 `as any` casts (e.g. `:275,280,294,436,753,793,824`).
  6. ✅ The UsageCounter path leak is fixed (`components/UsageCounter.tsx:84-89`, `lib/routePattern.ts:104-106`). The TermsGate stale recheck is fixed (`components/TermsGate.tsx:35-36,80-85`).
- **Regressions:**
  - A cold-start family-alert tap now does `router.push('/family-alerts')` (`app/_layout.tsx:792-794`) without waiting for the launch gate (`:268-295`); `index.tsx:44` waits on `launchAllowed`. Two outcomes are possible:
    - If the push lands after the `/app-lock` or `/onboard` replace, the alerts screen sits above the lock or sign-in.
    - If both navigations land before the effect at `:315-317` sees `pathname === launchGate`, `landed` is never set and the veil (`:318,1051-1058`) stays up.
    - Which of these happens is not verifiable statically.
  - Navigation on resume is unordered:
    - `ResumeLock` pushes `/app-lock` asynchronously on `'active'` (`components/ResumeLock.tsx:33-38`).
    - The resume-time notification routing also pushes on `'active'`: `consumeNativeLaunchIntent` → `/chat` (`app/_layout.tsx:663-699`), and so does `attachTapHandler` (`:815-833`).
    - A push that lands after the lock push sits above `/app-lock`. Not verifiable statically.
  - `useSpaceDeviceAgent()` was added at the root (`app/_layout.tsx:231`). It is idle unless this phone is bound as a space device (`lib/spaces/deviceAgent.ts:91-95`), so this is not a regression in itself. Its ring/message `Alert`s (`:69-79`) can appear over `/app-lock`; they are not sensitive.
- **Subscreens:**
  - Launch veil — 8 → 8. Unchanged; see the new veil-wedge risk above.
  - UpdateGate — 6.5 → 6.5. Unchanged: no-op "Update now" without `updateUrl` (`components/UpdateGate.tsx:38-41`), check once at mount (`:26-36`), no top inset on the advise bar (`:122-125`), English-only strings, and `UpdateSpinner` still has no importer (`:84-90`).
  - TermsGate — 6.5 → 7.5. The stale-state and cache recheck are fixed (`components/TermsGate.tsx:35-36,80-85`). Still open: signed-out polling continues every 30 s indefinitely (`:68-69`), there is no ScrollView around the block (`:118-160`), and the a11y label is hard-coded English (`:150`).
  - ErrorBoundary — 5 → 7. It is mounted at the root, reports to Sentry (`components/ErrorBoundary.tsx:25-34`), and has header/button roles (`:40,45-46`). Two problems remain:
    - "Try Again" only clears `hasError` (`:44`), so a deterministic render crash re-throws immediately.
    - Its copy "Please restart the app" (`:41`) contradicts the button.
  - UsageCounter — 6 → 8.5. It now counts the route pattern from `useSegments()`, with the guard in `lib/routePattern.selftest.ts`.
  - CallBar — 7 → 7. Unchanged (`components/CallBar.tsx` has no diff).
  - ResumeLock (new) — 7. Strengths:
    - The pure policy is tested (`lib/resumeLockPolicy.selftest.ts`).
    - Only `'background'` starts the clock (`services/lockService.ts:141-142`).
    - Auth and lock routes are exempt (`components/ResumeLock.tsx:22`), and app-lock returns via `router.back()` with `resume=1` (`app/app-lock.tsx:40-43`).

    Gaps: it applies only to MFA users (`components/ResumeLock.tsx:24`), and it has the unordered-navigation race above.
- **Still needed for 10/10:**
  1. Make the security verdict and every notification or cold-start push wait on the launch gate. `await launchAllowed` as `app/index.tsx:44` does, before `app/_layout.tsx:378,668-673,793,816-831`. Re-check the verdict inside the gate's allow branch (`:281-284`).
  2. Order resume routing after the resume lock. Have `consumeNativeLaunchIntent` (`app/_layout.tsx:697-699`) and the tap handlers defer while `/app-lock` is pending or on top, or stash the target and replay it from `app/app-lock.tsx:40-43`.
  3. Extend the resume lock to sealed-session/Device-PIN users, or state the MFA-only scope in the UI (`components/ResumeLock.tsx:24`).
  4. Split the file: call routing (`app/_layout.tsx:408-834`), notification ingest (`:580-638`) and boot work into hooks. Drop the 13 `as any` route casts.
  5. ErrorBoundary: remount the subtree on "Try Again" (key bump) and align the copy (`components/ErrorBoundary.tsx:41,44`).
  6. UpdateGate: add a store-URL fallback and an AppState recheck, inset the advise bar (`components/UpdateGate.tsx:26-41,122-125`). TermsGate: stop polling while signed out and add a ScrollView (`components/TermsGate.tsx:68-69,118`).

#### `app/index.tsx` — **7 → 7.5**
- **Scores now:** Function 8 · States 7 · UI 6 · A11y 7 · Security 8 · Code 8
- **Original items:**
  1. ✅ The new-phone restore gap is fixed outside this file. Both sign-in exits now call `openRestoreIfNewPhone()` (`lib/postSignIn.ts:19-27`, `app/mpin-entry.tsx:52`, `app/mpin-recover.tsx:90`). It uses the same `shouldCheckRestore` as `app/index.tsx:46`.
  2. ✅ The catch now logs (`app/index.tsx:49-54`).
  3. ✅ The image is marked decorative (`app/index.tsx:88-90`).
- **Regressions:** none.
- **Subscreens:** Fallback splash view — 6.5 → 7. It is now hidden from a11y. `#010628` stays hard-coded (`:97`) but documented as the native splash colour (`:58-66`).
- **Still needed for 10/10:**
  1. The header comment is stale. It describes `/signed-in`/`/welcome` routing (`app/index.tsx:1-8`), which the code no longer does.
  2. If `router.replace` throws (`:46-48`), the user stays on the splash fallback with no way out. Render a retry, or route to `/(tabs)/chats`, instead of only logging (`:49-54`).
  3. Read the splash colour from one shared constant rather than a literal (`:97`).

#### `app/(tabs)/_layout.tsx` — **7.5 → 7.5**
- **Scores now:** Function 8 · States 8 · UI 8 · A11y 7 · Security 8 (n/a) · Code 7
- **Original items:**
  1. ✅ The unread count is now announced via `tabBarAccessibilityLabel` (`app/(tabs)/_layout.tsx:105,125`).
  2. ❌ Labels are still capped at `maxFontSizeMultiplier={1.2}` (`:42,85`).
  3. ❌ `useStyles`/`useUnreadTotal` still run in every icon (`:30,52,73`). The fix added one more `useUnreadTotal` subscriber (`:105`) instead of passing the count down.
  4. ❌ The gradient/shadow hex values are still literals (`:35,173`).
- **Regressions:** none. The extra subscriber is a code-health nit, not a regression.
- **Subscreens:** Mini Apps center button — 7 → 7 (unchanged, `:25-45`).
- **Still needed for 10/10:**
  1. Compute `unread` once in `TabLayout` (`:105`) and pass it to `TabIcon` (drop `:73`). Hoist `useStyles` (`:30,52`).
  2. Allow larger label scaling using the 2-line fallback already present (`:42,85`).
  3. Move `['#9D82F5','#6036BB']`/`['#9471ED','#5830AC']` and `#05030D` into theme tokens (`:35,173`).

#### `app/mpin-entry.tsx` — **7.5 → 8**
- **Scores now:** Function 9 · States 8 · UI 8 · A11y 7 · Security 6 · Code 9
- **Original items:**
  1. ✅ A missing `userId` now shows an error and calls `resetTo('/onboard')` (`app/mpin-entry.tsx:44`). The message is set just before the navigation, so it is effectively not seen.
  2. ❌ There is still no SMS/device factor for a new device (`:47`). Lockout is still only claimed in the comment at `:2`. The server side is not verifiable statically.
  3. ✅ The skip-restore gap is fixed (`:52`, `lib/postSignIn.ts:19-27`).
- **Regressions:** none.
- **Subscreens:** None.
- **Still needed for 10/10:**
  1. Add a possession factor (OTP or device binding) before `verifyMpinRemote` on a new device (`app/mpin-entry.tsx:47`; `/auth/lookup` still yields `userId` unauthenticated per the original review).
  2. Label `MpinInput` for screen readers. Its Pressable and hidden TextInput are unchanged (`components/auth/MpinInput.tsx:58,69-79`).
  3. "Forgot MPIN?" has a role but no state when `userId` is missing (`app/mpin-entry.tsx:92-98`). It pushes `/mpin-recover` with an empty id. Guard it like `submit` does (`:44`).

#### `app/mpin-recover.tsx` — **7 → 7**
- **Scores now:** Function 9 · States 7 · UI 8 · A11y 6 · Security 6 · Code 6
- **Original items:**
  1. ✅ `router.replace` is replaced by `openRestoreIfNewPhone()`, falling back to `resetTo('/(tabs)/chats')` (`app/mpin-recover.tsx:90`).
  2. ❌ Recovery is still knowledge-only: 3 answers, no OTP (`:97,72`).
  3. ❌ Raw answers are still sent: the filter trims (`:70`) but the payload uses `answers[q]` (`:71`).
  4. ❌ `isWeak` is still a local copy (`:79`). It is now one of three: `app/backup-pin.tsx:25` and onboard-mpin each have their own.
- **Regressions:** none in this file. It is now also reachable from `app/app-lock.tsx:103`, where hardware Back on this screen is swallowed by app-lock's global `BackHandler` (see app-lock). The on-screen back (`:105-113`) still works.
- **Subscreens:**
  - Answer phase — 7 → 7. Inputs are still unlabelled (`:131-138`).
  - New/confirm MPIN phase — 6.5 → 6.5. It still uses the weaker local `isWeak` without the DOB rule (`:79`).
- **Still needed for 10/10:**
  1. Add an SMS/OTP step before `verifyRecoveryAnswers` issues the ticket (`app/mpin-recover.tsx:72`).
  2. Send trimmed answers (`:71`).
  3. Extract one shared `isWeak` (with the DOB rule) for onboard-mpin, mpin-recover (`:79`) and backup-pin (`app/backup-pin.tsx:25`).
  4. Add `accessibilityLabel={questionLabel(q)}` to each answer input (`:131-138`). Label `MpinInput` (`:174-175`).

#### `app/app-lock.tsx` — **6 → 7**
- **Scores now:** Function 8 · States 7 · UI 7 · A11y 7 · Security 7 · Code 7
- **Original items:**
  1. ✅ "Forgot MPIN?" → `/mpin-recover` is added. With no cached user, the button reads "Sign in again" (`app/app-lock.tsx:102-112,187-189`).
  2. ◐ Accessibility is partly fixed:
     - All five touchables now have `accessibilityRole` (`:156,162,169,172,184,187`).
     - Errors are live regions (`:161,183`).
     - The emoji is hidden (`:131`).
     - The sealed-PIN `TextInput` still has no `accessibilityLabel` (`:138-149`).
  3. ◐ Async safety is partly fixed. `getCachedUser` now has a catch (`:59`). `tryBiometric` still has no unmount guard (`:68-71`).
  4. ❌ MPIN mode still does not explain offline failure. `onboardingError` passes the raw `e.message` (`lib/onboarding.ts:87-88`).
  5. ◐ The gate is no longer cold-launch only: resume relock exists via `ResumeLock` (`resume=1`, `app/app-lock.tsx:27-29,40-43`). It is MFA-only (see root).
- **Regressions:**
  - The `BackHandler` listener (`app/app-lock.tsx:54-57`) is global and stays registered while app-lock is mounted underneath. When `forgotMpin` pushes `/mpin-recover` on top (`:103`), hardware Back there returns `router.canGoBack()` = true and is consumed. The user must use the on-screen back (`app/mpin-recover.tsx:105-113`).
  - Mid-severity: the new "Forgot MPIN?" route lets someone holding a locked phone get past the app lock with the knowledge-only recovery (`app/mpin-recover.tsx:97`). This is the same strength as signing in elsewhere, so it is not a new capability. It is worth knowing until recovery has an OTP.
- **Subscreens:**
  - Sealed-session PIN mode — 6 → 7. It now has roles and a live error (`:156-161`). The input is unlabelled (`:138`).
  - Biometric mode — 6 → 7. Roles added (`:169,172`).
  - MPIN mode — 5 → 7.5. It has Forgot MPIN / Sign in again (`:187-189`) and a live error (`:183`). It gives no offline hint.
  - Forgotten PIN Alert — 7 → 7. Unchanged (`:87-98`).
- **Still needed for 10/10:**
  1. Only consume Back while app-lock is focused: use `useFocusEffect`, or check `navigation.isFocused()` inside the handler (`app/app-lock.tsx:54-57`).
  2. Label the sealed-PIN input (`:138-149`). Label `MpinInput` (`components/auth/MpinInput.tsx:58,69-79`).
  3. Add an unmount guard to `tryBiometric` (`:68-71`). Map network errors in MPIN mode to "You're offline — use biometrics or try again when connected" (`:120-122`).
  4. See root #2/#3: resume routing must not land above this screen, and the resume lock should cover sealed-session users.

#### `app/restore-backup.tsx` — **6.5 → 7**
- **Scores now:** Function 9 · States 7 · UI 7 · A11y 4 · Security 7 · Code 7
- **Original items:**
  1. ✅ It is now reachable after an in-session sign-in (`lib/postSignIn.ts:19-27` from `app/mpin-entry.tsx:52` and `app/mpin-recover.tsx:90`). `leave` uses `resetTo`, which replays the stashed link (`app/restore-backup.tsx:68-73`).
  2. ❌ There are still no `accessibilityRole` or busy state on `:109,142,153,170`.
  3. ❌ The raw `e.message` is still surfaced (`:90`).
  4. ❌ `Row`'s `S` prop is still `any` (`:185`).
- **Regressions:** none.
- **Subscreens:** "Chats restored" state — 6.5 → 6.5. The CTA still has no role (`:109`).
- **Still needed for 10/10:**
  1. Add `accessibilityRole="button"` and `accessibilityState={{ disabled, busy }}` to the four touchables (`app/restore-backup.tsx:109,142,153,170`).
  2. A failed `cloudBackupMeta()` is shown as "No backup was found" (`:64,129`). Distinguish a lookup failure, with retry, from a real "none".
  3. Map known errors instead of interpolating `e.message` (`:88-90`). Type `S` as `ReturnType<typeof makeStyles>` (`:185`).
  4. `leave` awaits `markRestorePromptSeen()` with no catch (`:69`). If it throws, Continue/Not now does nothing.

#### `app/delete-account.tsx` — **7.5 → 8**
- **Scores now:** Function 9 · States 8 · UI 8 · A11y 8 · Security 7 · Code 8
- **Original items:**
  1. ◐ Re-authentication is now client-side only. The MPIN field appears after the identity matches (`app/delete-account.tsx:216-233`), and `run` checks `verifyMpinRemote` before `DELETE` (`:110-121`). The server does not require it: `DELETE /user/account` is plain `RequireAuth` (`vaultchat-backend-go/internal/routes/user.go:79`), and the file says so in a `ponytail:` note (`:21-22`).
  2. ✅ Reason chips use `radio` with checked state (`:244-245`). The CTA has a role and state (`:256-257`). Retry has a role (`:184`). Both inputs are labelled (`:206,229`).
  3. ✅ The unused `Platform` import is removed (`:26-29`).
- **Regressions:**
  - Minor: re-auth reuses the sign-in call. That call swaps the tokens and overwrites the cached user with `{ id }` only (`lib/onboarding.ts:166-167`, `lib/api.ts:212`). If the `DELETE` then fails (`app/delete-account.tsx:134-137`), the device keeps a stripped cached profile.
- **Subscreens:** Final "Delete account?" Alert — 7 → 7 (`:142-149`). The MPIN step is inline, not a separate subscreen.
- **Still needed for 10/10:**
  1. Server: require a fresh MPIN proof on `DELETE /user/account` (`vaultchat-backend-go/internal/routes/user.go:79`). Send it from `deleteAccount` (`app/delete-account.tsx:123`).
  2. Use a verify-only endpoint, or restore the cached user after `verifyMpinRemote` (`lib/onboarding.ts:162-168`), so a failed delete leaves state untouched.
  3. Map the delete failure instead of the raw `e.message` (`app/delete-account.tsx:136`).

#### `app/blocked.tsx` — **6.5 → 7**
- **Scores now:** Function 8 · States 7 · UI 7 · A11y 7 · Security 7 · Code 7
- **Original items:**
  1. ✅ The mis-wire is fixed. Privacy Dashboard no longer pushes `/blocked`; the only callers pass a verdict (`app/_layout.tsx:378`, `app/(tabs)/alerts.tsx:118`). With no `restrict`/`wipe` level, Back is not blocked and a "Nothing is blocked / Go back" view renders (`app/blocked.tsx:131,148,176-194`).
  2. ✅ "Contact Support" offers `mailto:` (`:161-174`).
  3. ✅ Header roles are added (`:184,213`) and keys are stable (`:231,278`).
- **Regressions:** none.
- **Subscreens:**
  - Contact Support Alert — 5 → 7.5. It has a real "Email support" action (`:169-171`).
  - "Nothing is blocked" state (new) — 8 (`:176-194`).
- **Still needed for 10/10:**
  1. The verdict is taken from route params (`app/blocked.tsx:125,131,135`):
     - A crafted `vaultchat://blocked?level=wipe` shows the "keys permanently wiped" trap screen with Back disabled.
     - A notification push (`app/_layout.tsx:668,816`) can land above a real verdict.
     - Read the verdict from `securityService` state, and have the root refuse other navigation while it stands.
  2. Order against the launch gate (root #1).
  3. Replace the literal `rgba(239,68,68,…)`/`rgba(34,197,94,…)` with tokens (`:326,362,433`).

#### `app/permissions.tsx` — **6.5 → 6.5**
- **Scores now:** Function 8 · States 7 · UI 6 · A11y 4 · Security 7 · Code 6
- **Original items:**
  1. ❌ The per-row status glyph has no label or state (`app/permissions.tsx:144-146`). The buttons have no roles (`:151,163,171`).
  2. ❌ "Grant Permissions" still fires every prompt, background location included, in one go (`:84-101`). There is no per-row request or `canAskAgain` link.
  3. ❌ Hard-coded colours remain (`:188,193-194,201,206-208`).
  4. ❌ `lib/screenBackCoverage.selftest.ts:49-50` still exempts this screen as "nothing pushes to it". That is false: `app/settings.tsx:429` pushes it.
- **Regressions:**
  - Code health: the only fix was `done()` (`:37`). Since the onboarding chain is deleted (comment `:35-36`), every `!fromSettings` branch is now dead and the header comment is false:
    - the 8-step dots (`:129`)
    - "Step 7 of 8" (`:134`)
    - auto-advance (`:117`)
    - "Skip — grant later" (`:172`)
    - the header comment "Entered from Settings as well as mid-onboarding" (`:15`)
- **Subscreens:** Full-screen-intent row — 6.5 → 6.5. Unchanged, no role or label (`:150-159`).
- **Still needed for 10/10:**
  1. Request per row with a rationale. Link `canAskAgain=false` rows to OS settings (`lib/permissionDenied.ts`), instead of the all-at-once `requestAll` (`app/permissions.tsx:84-101`).
  2. Add labels/state to the status glyphs (`:144-146`) and roles to the three buttons and the FSI row (`:151,163,171`).
  3. Delete the dead onboarding branches and fix the comment (`:15,117,129,134,172`). Drop the stale exemption (`lib/screenBackCoverage.selftest.ts:49-50`).
  4. Tokenise `#4A9FFF`/`#22C55E`/`#F59E0B` and the rgba values (`:188,193-194,201,206-208`).

#### `app/backup-pin.tsx` — **4.5 → 7**
- **Scores now:** Function 8 · States 7 · UI 6 · A11y 7 · Security 7 · Code 6
- **Original items:**
  1. ✅ The current PIN is now required before replacing it. A new `current` stage appears when `hasPin()` is true, or when that check fails (`app/backup-pin.tsx:42-50`). It is verified via `pinStore.verifyPin` and shows a backoff message (`:58-67`). The vault key is re-wrapped first and rolled back on save failure (`:87-97`).
  2. ✅ Save now has try/catch with a "nothing was changed" message (`:100-103`). ◐ Weak-PIN rejection is added (`:25,82`) but is a third local copy, not shared.
  3. ✅ Keys have roles, labels (Delete/Continue) and state (`:143-145`). There is a back control (`:118-120`) and a header role (`:123`). The dots row is announced (`:128`).
  4. ✅ The onboarding dots and "Used if biometrics fail" copy are removed. The copy describes the real effect (`:108-111`).
  5. ❌ It does not reuse `components/PinPad.tsx`. It still renders its own keypad (`:132-151`), even though PinPad now supports variable length (fix log P2 7e).
- **Regressions:** none found. `checkCurrent` has `try/finally` without `catch` (`:61-66`), so a throwing `verifyPin` becomes an unhandled rejection with no message. This is minor and new code, not a regression of old behaviour.
- **Subscreens:**
  - Current PIN stage (new) — 7. It has backoff-aware errors (`:63-64`), but a forgotten current PIN has no recovery path other than Back (`:118`).
  - Set PIN stage — 4.5 → 7. Weak-PIN check added (`:82`).
  - Confirm PIN stage — 4.5 → 7. Save failure is handled with rollback (`:88-103`).
- **Still needed for 10/10:**
  1. Add a `catch` in `checkCurrent` that shows "Couldn't check your PIN" (`app/backup-pin.tsx:61-66`). Catch `Haptics.impactAsync` (`:71`).
  2. Reuse `components/PinPad.tsx` (variable length + submit) instead of the bespoke keypad (`:132-151`). Share one `isWeak` with mpin-recover and onboard-mpin (`:25`).
  3. Offer a recovery path for a forgotten current PIN, e.g. MPIN re-auth (`:58-67`).
  4. Replace `#4A9FFF` and the rgba literals with auth-theme tokens (`:166,171,176`). Hide the decorative emoji (`:122`).

---

### B — Main Tabs, Contacts & Links — re-rating

Base commit 18eb6d2 → HEAD f774ffa. This is a static, read-only review. I read every screen below in full at HEAD and compared each one with `git diff 18eb6d2 HEAD`. I treated the fix-log claims (P8, P2, H) as unverified until I found them in the code. Nothing here was checked on a device or against the server.

Evidence I ran myself (`npx tsx`, each printed its pass line):
- `lib/a11yCoverage.selftest.ts`, `lib/themeCoverage.selftest.ts` (22 passed, 20 exemptions), `lib/screenBackCoverage.selftest.ts`, `lib/orphanRoutes.selftest.ts` (50 passed), `lib/responsiveCoverage.selftest.ts`, and the new `lib/vaultIdLink.selftest.ts` ("ok").
- `npx eslint` on all 15 screens: 0 errors and 24 warnings. Among them: unused `avatarLetter` (chats.tsx:842), unused `cancel` (profile.tsx:82), unused `Dimensions` and `initials` (contact-info.tsx:13, 225), and 17 `import/first` warnings in status.tsx.

Not in this re-rating, because they were not assigned to this batch: `app/(tabs)/mini.tsx`, `app/contact.tsx`, `app/sync-contact.tsx`, `app/msgrequests.tsx`. Also, `components/ui/ChatRow.tsx` has been deleted since the base commit (it is no longer in `components/ui/`, and `lib/orphanRoutes.selftest.ts:123-127` guards that it stays unused).

| Screen | Old | New | Δ |
|---|---|---|---|
| `app/(tabs)/chats.tsx` | 7 | 7.5 | +0.5 |
| `app/(tabs)/status.tsx` | 6.5 | 6.5 | 0 |
| `app/(tabs)/calls.tsx` | 6.5 | 7.5 | +1 |
| `app/(tabs)/profile.tsx` | 6.5 | 7 | +0.5 |
| `app/(tabs)/alerts.tsx` | 6.5 | 7.5 | +1 |
| `app/new-chat.tsx` | 6.5 | 7.5 | +1 |
| `app/search.tsx` | 7.5 | 8 | +0.5 |
| `app/contacts.tsx` | 6.5 | 7 | +0.5 |
| `app/contact-info.tsx` | 6.5 | 7 | +0.5 |
| `app/qr-contact.tsx` | 6.5 | 7 | +0.5 |
| `app/verify-contact.tsx` | 7.5 | 8 | +0.5 |
| `app/add/[...segments].tsx` | 6.5 | 8 | +1.5 |
| `app/join/[code].tsx` | 7 | 8 | +1 |
| `app/i/[token].tsx` | 6 | 6.5 | +0.5 |
| `app/invite-link.tsx` | 7 | 7.5 | +0.5 |

---

#### `app.json` — intent-filter change (cross-cutting, not scored)
- **What changed:** app.json:64-83 adds an Android `VIEW` filter for `https://vaultchat.app` with `pathPrefix` `/add/` and `/join/`, and `autoVerify: false`.
- **Effect:**
  - The filter covers the hosts the app shares: qr-contact.tsx:56 and invite-link.tsx:19.
  - Because `autoVerify` is false, these are not verified App Links. On Android 12+, whether a tap opens the app or the browser is **not verifiable statically**; by platform default, unverified web links open in the browser unless the user enables the link.
  - There is no iOS `associatedDomains`. The only match for that key in app.json is absent; the grep of app.json found only the `scheme` and intent-filter `https` entries.
  - `app/i/[token].tsx:4` still advertises `https://vaultchat.app/i/<token>`, which this filter does not cover.
- **Status:** ◐. In-app QR and link production now matches a filter, but opening into the app depends on hosting `assetlinks.json` and then setting `autoVerify: true` (P8 deferred row 5), and on iOS Associated Domains (P8 deferred row 4).

#### `app/(tabs)/chats.tsx` — **7 → 7.5**
- **Scores now:** Function 8 · States 8 · UI 7 · A11y 7 · Security 8 · Code 6
- **Original items:**
  1. ✅ The row has `accessibilityRole="button"`, a composed label (name, unread count, draft, preview, time), `accessibilityState.selected` in select mode, and pin/mute/archive/delete `accessibilityActions` (chats.tsx:910-926). Delete still goes through the confirming `doDelete` (452-467). The unused `components/ui/ChatRow.tsx` has been deleted.
  2. ✅ The empty state is a `ScrollView` with a `RefreshControl` (chats.tsx:681-688). The error bar is a retry button (653-657).
  3. ❌ The dead styles are still present: `headerBtnTxt` 1053, `avatar` 1095, `avatarGroup` 1096, `avatarImg` 1097, `avatarTxt` 1098, `presenceDot` 1099, `rowPin` 1103, `rowMuted` 1105, `actionIcon` 1131, `fabTxt` 1135. The stale "Long-press action sheet" comment remains (1117).
  4. ❌ Hard-coded colours remain: `'#4A9FFF'` (994), `'rgba(0,0,0,0.85)'` (1042), and the error-bar rgba (1062). RN `Text` is still imported (12).
  5. ❌ There are still 19 `as any` (the same count as the base commit). `formatRelative` is still local (1025-1033).
- **Regressions:** none in behaviour. New lint warning: `avatarLetter` is unused (842).
- **Also improved (tabs layout):** the Chats tab announces "Chats, N unread" (app/(tabs)/_layout.tsx:105, 125).
- **Subscreens:**
  - Temporary-chat sheet — 7 → 7.5. `SheetItem` now has a role (824); the Modal still has no `accessibilityViewIsModal` (751-753).
  - Avatar photo popup — 7 → 7. It still awaits `listStoriesFeed()` with no feedback (417-428). Message/Audio/Video/Info have no roles (791-809).
  - Selection / bulk mode — 7 → 7.5. Selected state was added (915). Bulk actions still run one at a time (492, 518).
  - Folder chips — 8 → 8. Counts are still re-filtered on every render (660-664).
  - Swipe actions — 6 → 7.5. They are now reachable through `accessibilityActions` (917-926). Archive is still a white icon on `colors.surfaceSolid` (899-900); light-mode contrast is not verifiable statically.
- **Still needed for 10/10:**
  1. Remove the dead styles (chats.tsx:1053, 1095-1099, 1103, 1105, 1131, 1135), fix the stale comment (1117), and delete unused `avatarLetter` (842).
  2. Replace `'#4A9FFF'` (994) and the rgba values (1042, 1048, 1062) with palette tokens. Swap RN `Text` (12) for `AppText`.
  3. Give the Archive swipe action a token background with checked contrast (899-900).
  4. Avatar popup: use the story-feed cache or show a pressed/loading state (417-428). Add `accessibilityRole="button"` to its four actions (791-809). Add `accessibilityViewIsModal` to both Modals (751, 771).
  5. Run bulk actions with `Promise.allSettled` (492, 518). Memoise the folder counts (660-664).
  6. Reduce the 19 `as any` route casts with typed routes, and share `formatRelative` (1025) with status.tsx:577 through `lib/format`.

#### `app/(tabs)/status.tsx` — **6.5 → 6.5**
- **Scores now:** Function 7 · States 8 · UI 7 · A11y 4 · Security 8 · Code 6
- **Original items:**
  1. ✅ The socket listener is attached only after the `cancel` check (status.tsx:165-170).
  2. ✅ Each posted asset is removed from `previewAssets` as it succeeds (304-307). The partial-failure alert says how many posted and that Post retries only the rest (311-319).
  3. ❌ No labels or roles on the status rows (352, 527), swatches (402), emoji buttons (428, 438) or thumbnails (479).
  4. ✅ `.catch` was added to both `AsyncStorage.getItem().then` calls (104, 115).
  5. ❌ Font sizes are still fixed: title 28 (593), rowName 15 (641), rowSub 12 (642). Dead styles remain: `headerBtnTxt` (595) and `avatarRing*` (632-635).
  6. ❌ The "Long-press TODO" is still there (525-526). Muting is still AsyncStorage-only (121).
- **Regressions:** none found. Removing assets matches on `uri` (307), which assumes picker URIs are unique; that is not verifiable statically.
- **Subscreens:**
  - Text status composer — 6.5 → 6.5. Unchanged: swatches unlabelled (402), and Close discards typed text without asking (395).
  - Media preview + caption editor — 6 → 7.5. Retry is now idempotent (304-319). Thumbnails are still unlabelled (479). Whether the video preview renders a frame (`Image` on a video URI, 470) is not verifiable statically.
  - GatePicker — 7 → 7 (file unchanged since the base commit).
  - Emoji panel — 6 → 6. Emoji buttons are unlabelled (428, 438).
  - Status options menu — 6 → 6. Still an `Alert` with one action (375-378).
  - StoryRing — 8 → 8 (unchanged).
- **Still needed for 10/10:**
  1. Accessibility: give status rows a role and a composed label (352, 527), e.g. "Alice, 3 updates, 2 unseen, 2h ago". Label the swatches by colour name (402), the emoji (428, 438) and the thumbnails (479).
  2. Confirm discard when the composer has text (395) or the preview batch is non-empty (459).
  3. Scale fonts with `m.textScale` (593, 641, 642, 644, 645), and remove the dead styles (595, 632-635).
  4. GatePicker (components/status/GatePicker.tsx): radio roles and checked state, `secureTextEntry`/`autoCorrect={false}` on the answer, hoist `Opt`, and tokenise `'#E5533D'`. All carried over from the original review.
  5. Resolve the My-status long-press TODO (525-526). Route the options icon straight to `/status-privacy` (375-378). Move the mid-file imports to the top (38-66; 17 lint warnings).
  6. Document that mutes are device-local, or sync them (121).

#### `app/(tabs)/calls.tsx` — **6.5 → 7.5**
- **Scores now:** Function 8 · States 7 · UI 7 · A11y 8 · Security 8 · Code 7
- **Original items:**
  1. ✅ The FAB pushes `/contacts?mode=call` (calls.tsx:268). contacts.tsx then offers Voice/Video and routes to `/voicecall` or `/videocall` (contacts.tsx:193-220).
  2. ✅ The removal copy now says "on this device" (calls.tsx:167), which matches lib/callLog.ts:93-101.
  3. ✅ Tapping a row opens call info (209-211). Call-back remains a separate button (231).
  4. ◐ `.catch` was added to both `getCallLog()` calls (84, 106-108). The merge still fails silently (110). `removeCallLog` and `hideServerCalls` still swallow write errors (lib/callLog.ts:79-85, 111-121), so `removeGroup` removes the row even when the write failed (calls.tsx:147-151).
  5. ◐ The row has a role, label and hint (212-214). `DirArrow` is still declared in render (189-197), and `renderItem` is not memoised (199).
- **Regressions:** the header comment is stale. It still says "Tap = redial" (calls.tsx:6), which the new row behaviour (206-210) contradicts.
- **Subscreens:**
  - Call actions sheet — 8 → 8. Rows are still `key={i}` (components/ui/Sheet.tsx:79).
  - Call info modal — 7 → 8. It now has `accessibilityViewIsModal` (275), a labelled backdrop (274) and labelled actions (284, 287). There is still no explicit Close button. The sheet sits inside the accessible backdrop `Pressable` (274-275); whether VoiceOver can then focus the inner buttons separately is not verifiable statically.
  - Remove / Clear confirmations — 5 → 8. The copy is now true (167, 175). A failed write is still not reported.
- **Still needed for 10/10:**
  1. Let `removeCallLog`/`hideServerCalls` reject (lib/callLog.ts:84, 120). In calls.tsx:147-151 and 177-184, only drop rows after a successful write, and alert otherwise.
  2. Show a non-blocking notice when the server merge fails (calls.tsx:110).
  3. Render the info backdrop as a sibling of the sheet, not its parent (274-275). Add a Close button.
  4. Hoist `DirArrow` (189), wrap `renderItem` in `useCallback` (199), and fix the stale header comment (6).
  5. Key Sheet rows on `a.label` (components/ui/Sheet.tsx:79).

#### `app/(tabs)/profile.tsx` — **6.5 → 7**
- **Scores now:** Function 8 · States 7 · UI 7 · A11y 6 · Security 8 · Code 6
- **Original items:**
  1. ✅ The tick shows only when the edited value equals the account number (profile.tsx:387).
  2. ✅ Saving sends only `name` or `status` (128-135). The phone row only collapses; a number is saved only through OTP verification (146-149, 228-241). Whether the server accepts a partial PUT is not verifiable statically.
  3. ❌ No keyboard avoidance. It is still a plain `ScrollView` (282) with inline inputs (487-491) and the OTP box (415-419).
  4. ✅ Per-row "Edit/Save <field>" labels with state (502). The avatar is labelled "Change profile photo" with busy state (307-308). Remove photo has a role and a confirm (326-331).
  5. ❌ The empty effect remains (81-86; lint: unused `cancel`). The header still says photo upload is deferred (4). `keyboardType?: any` remains (477).
- **Regressions:** none found.
- **Subscreens:**
  - Inline edit rows — 6 → 7. Labels are correct and save is per field. There is still no cancel once a row is editing.
  - Phone OTP step — 6.5 → 7. Editing the number resets the step (379-384). There is still no resend or timer, and Verify/Cancel have no roles (421, 424).
  - Sign-out confirmation — 8 → 8. `await logoutUser()` is still unwrapped (252).
- **Still needed for 10/10:**
  1. Wrap the content in `KeyboardSafe` (282), as new-chat.tsx:139 does.
  2. Wrap `logoutUser()` in try/catch with an alert (252).
  3. Add a cancel/revert for an editing row (501-506), and an OTP resend with cooldown (412-428).
  4. Add roles to the header back button (291-296), Settings (300), "Verify this number" (407), Verify/Cancel (421, 424) and the two action rows (444, 449).
  5. Delete the empty effect (81-86) and the stale header line (4). Type `keyboardType` as `KeyboardTypeOptions` (477).

#### `app/(tabs)/alerts.tsx` — **6.5 → 7.5**
- **Scores now:** Function 9 · States 7 · UI 7 · A11y 6 · Security 8 · Code 8
- **Original items:**
  1. ✅ The scan is confirmed, and the dialog explains that keys get erased (alerts.tsx:135-145). A non-clean report routes to `/blocked` with `threats`/`level` (116-119), the same as the launch scan (app/_layout.tsx:378). `clean` here also covers `monitor` (services/securityService.ts:292). Clean and monitor results show an alert (121-126).
  2. ✅ Scan failures alert (127-128).
  3. ❌ `RefreshControl refreshing={false}` is unchanged (234). Errors are still shown only when the list is empty (237-246).
  4. ❌ `syncAuditChain().then(setEvents…)` still has no unmount guard (98-102).
  5. ◐ The scan button has a role, label and state (199-201). `SEV_COLOR` is still hex (28-34). Rows still have no role or expanded state (151-155).
- **Regressions:** none found.
- **Subscreens:**
  - Expanded event details — 6 → 6 (unchanged, 151-180).
  - Scan confirmation (new Dialog, 137-144) — 8. The consequence is clear and the result is acted on.
- **Still needed for 10/10:**
  1. Track a real `refreshing` state (234). Show an error bar when events are already listed (237).
  2. Guard the background sync with an `alive` ref (98-102).
  3. Give rows `accessibilityRole="button"` and `accessibilityState={{expanded: isOpen}}` (151-155).
  4. Move `SEV_COLOR` (28-34) and the `bannerBad` rgba (274) into theme tokens with light/dark variants.

#### `app/new-chat.tsx` — **6.5 → 7.5**
- **Scores now:** Function 8 · States 8 · UI 7 · A11y 7 · Security 8 · Code 7
- **Original items:**
  1. ✅ The placeholder is now "Search name" (new-chat.tsx:167), which matches the name-only filter (113-116).
  2. ✅ Group, community and address-book rows are hidden in TTL mode (182-185, 199).
  3. ✅ On a `listChats()` failure it falls back to `getCachedChats()`, with a "Tap to retry" note (84-92, 201-205).
  4. ◐ An `opening` ref guards taps (45-50). Rows (211-212), `ActionRow` (130) and Start chat (191-192) have roles. `ActionRow` is still declared inside render (129-134).
  5. ✅ The `Platform` import is gone (10-13), and the header text was updated (1-4).
- **Regressions:** none found. The retry call `loadContacts()` (202) passes no cancel predicate, a minor gap.
- **Subscreens:**
  - New contact by phone — 7 → 7.5. The CTA now has role and busy state (191-192). The dial code is still hard-coded to `'+91'` (75).
- **Still needed for 10/10:**
  1. Default the dial code from the device locale or the user's own number instead of `'+91'` (75).
  2. Hoist `ActionRow` out of render (129-134).
  3. Raise the back button to a 44dp minimum (237), as search.tsx:171 does.
  4. Optionally match phone numbers in search, now that the placeholder no longer promises it (113-116).

#### `app/search.tsx` — **7.5 → 8**
- **Scores now:** Function 8 · States 7 · UI 8 · A11y 8 · Security 9 · Code 8
- **Original items:**
  1. ✅ Falls back to `getCachedChats()` offline (search.tsx:49-53).
  2. ✅ A `stale` flag stops older results overwriting newer ones (65-71).
  3. ◐ Result rows have roles and composed labels (138-139, 152-153). Matches are still not highlighted (157).
  4. ❌ The section data is still `any[]` (87).
- **Regressions:** none found.
- **Subscreens:** none.
- **Still needed for 10/10:**
  1. Say when chat names come from the offline cache. A failed `searchAllMessages` currently reads as "Nothing found" (69, 122).
  2. Highlight the matched term in `h.content` (157).
  3. Type sections as a discriminated union instead of `any[]` (87, 130).

#### `app/contacts.tsx` — **6.5 → 7**
- **Scores now:** Function 8 · States 7 · UI 7 · A11y 7 · Security 7 · Code 7
- **Original items:**
  1. ✅ A failed match chunk sets `chunkFailed`, skips the invite split and shows an error (contacts.tsx:144-154, 179-182).
  2. ◐ The header comment no longer claims numbers never leave the device (14-17). The transmitted value is still an unsalted SHA-256 (the scheme is unchanged). The P8 log says the server peppers it; that is not verifiable statically.
  3. ✅ Call mode: `mode=call` changes the title (299) and row action (250-261), then Voice/Video picker (214-220) → `createDirectChat` → `/voicecall` or `/videocall` (193-212).
  4. ❌ The address book is still re-hashed on every mount, with no cache (191).
  5. ◐ Rows have roles and labels (251-253, 268-269). White initials (`avatarTxt` `'#fff'`, 379) still sit on the invite `glassSoft` avatar (378). The flat list is still hand-built (280-290).
- **Regressions:** none found.
- **Subscreens:**
  - Scanning progress — 8 → 8.
  - Permission-denied state — 5 → 7.5. It shows "Open settings" when `canAskAgain` is false (95-101, 321-322).
  - Call-mode Voice/Video picker (new Dialog, 214-220) — 7. It is a real call path, but an `Alert`, with no indication of which contact is being opened beyond the title.
- **Still needed for 10/10:**
  1. Cache matched rows and rescan on demand (191).
  2. Move to a keyed/OPRF lookup, or document the server pepper next to `hashPhoneForLookup` (comment at 14-17).
  3. Use a token ink for invite initials (378-379), and tokenise the error-bar rgba (370).
  4. Replace the hand-built list (280-290) with `SectionList`. Raise the back and refresh buttons to 44dp (358, 361).

#### `app/contact-info.tsx` — **6.5 → 7**
- **Scores now:** Function 8 · States 8 · UI 7 · A11y 6 · Security 8 · Code 6
- **Original items:**
  1. ✅ `readCache` is now inside try (contact-info.tsx:99-100).
  2. ✅ The back button uses `HEADER_TOP` (420).
  3. ❌ Shared-file rows are still plain `View`s with no action (312-316).
  4. ◐ The `Switch` is labelled (277). "See All" still has no role (296), and `ActionButton` is still declared in render (227-234).
  5. ❌ Dead styles remain (`avatar`, `avatarImg`, `avatarText`, `onlineDot`, 421-424). So do the unused `Dimensions` import (13), the stale comment (46-50), and hard-coded rgba values (384, 439, 442, 447). The unused `initials` (225) is also still there.
  6. ✅ Opening a peer link asks first and shows the host (326-334). RN's `URL.host` handles userinfo (`node_modules/react-native/Libraries/Blob/URL.js:125-131`), so `a@evil.com` shows `evil.com`.
- **Regressions:** none found.
- **Subscreens:**
  - Block / Unblock / Report dialogs — 7 → 7. Unchanged. Report succeeding and then block failing still reverts to "not blocked" with a generic "Failed" (211-220).
- **Still needed for 10/10:**
  1. Make file rows open the document or `/media-gallery` (312-316).
  2. Add roles to the back button (243), `ActionButton` (228), "See All" (296), common-group rows (350), the encryption and Ghost cards (362, 383) and the danger buttons (398, 403). Hoist `ActionButton` (227).
  3. Report and block separately, so that a block failure after a successful report says the report went through (211-220).
  4. Remove the dead styles (421-424), `Dimensions` (13), `initials` (225) and the stale comment (46-50). Tokenise the rgba values (384, 439, 442, 447). Fix the effect's missing deps (151).

#### `app/qr-contact.tsx` — **6.5 → 7**
- **Scores now:** Function 7 · States 7 · UI 6 · A11y 7 · Security 8 · Code 8
- **Original items:**
  1. ✅ `parseVaultIdPayload` (qr-contact.tsx:68; lib/vaultIdLink.ts:15-24) accepts only the two schemes, the `https://vaultchat.app/add/` link, `@id`, or a bare id matching `[A-Za-z0-9_.-]{3,64}`. The selftest passes.
  2. ◐ The shared https link (56) now has an Android intent filter (app.json:64-83), but with `autoVerify: false` and no iOS domains (see the app.json section).
  3. ✅ Tabs have `role="tab"` with selected state (109-115). The QR has an image role and label (128).
  4. ◐ Still RN `Text` (10). A profile-load failure is still silent and falls through to "No VaultID yet" (43, 131).
- **Regressions:** none found.
- **Subscreens:**
  - My QR tab — 7 → 7. Labelled now, but there is still no error or Retry on a load failure (43).
  - Scan tab — 6.5 → 7.5. Strict payload parsing, and "Open settings" on permanent denial (151-154).
  - "Contact found" confirmation — 7 → 7.
- **Still needed for 10/10:**
  1. Add a load-error state with Retry for `getMyProfile` (40-45, 131).
  2. Make the shared link open the app: verified App Links plus iOS Associated Domains (app.json:64-83).
  3. Swap RN `Text` for `AppText` (10). Raise the back button to 44dp (184).

#### `app/verify-contact.tsx` — **7.5 → 8**
- **Scores now:** Function 8 · States 8 · UI 7 · A11y 8 · Security 8 · Code 9
- **Original items:** (the original cited lines up to :331, but the file has 167 lines at the base commit and 174 now; the citations below are current.)
  1. ✅ The "unavailable" state has Try again (verify-contact.tsx:104-106).
  2. ✅ The toggle is `role="switch"` with checked, busy and disabled state (130-132). The number is announced in 5-digit groups (115).
  3. ◐ The title has `numberOfLines={1}` (91). Still RN `Text` (12).
  4. ❌ No QR comparison or copy; read-aloud only (118-123).
- **Regressions:** none found.
- **Subscreens:** none.
- **Still needed for 10/10:**
  1. Offer QR scan comparison or copy-to-clipboard (`copyAndAutoClear`) for the number (112-116).
  2. Swap to `AppText` (12).
  3. Hide Try again for the non-retryable "Missing account or contact" case (49, 104).

#### `app/add/[...segments].tsx` — **6.5 → 8**
- **Scores now:** Function 8 · States 8 · UI 8 · A11y 8 · Security 8 · Code 8
- **Original items:**
  1. ✅ Phases go resolving → **confirm** ("Contact found · Open chat / Cancel") → opening (add/[...segments].tsx:31-35, 106-124). The confirm uses the server name, not the link's name hint (61).
  2. ✅ `safeDecode` handles malformed `%` (27-29, 49).
  3. ✅ The error state has Try again for network errors only (62-66, 97-101).
  4. ✅ Uses `AppText` (19). Buttons have roles, and the CTA has a label and state (98, 102, 110-121, 129).
- **Regressions:** none found.
- **Subscreens:** none.
- **Still needed for 10/10:**
  1. Validate `parts[0]` against the VaultID charset before calling the server (48), reusing `lib/vaultIdLink.ts:10`.
  2. Make the https entry actually open the app (app.json:64-83, iOS).
  3. Hide the decorative 🔗 from screen readers (94).

#### `app/join/[code].tsx` — **7 → 8**
- **Scores now:** Function 7 · States 8 · UI 8 · A11y 8 · Security 7 · Code 9
- **Original items:**
  1. ◐ Opening the link no longer joins. It shows a confirm phase ("Join this group? · Join group / Not now", join/[code].tsx:38, 67-81). There is no group-name preview; that is blocked on the backend and documented with a `ponytail:` note (12-13).
  2. ✅ The false "paste-to-join" claim is gone from the header (3-15).
  3. ◐ The `/join/` intent filter was added (app.json:64-83). `autoVerify: false`, and there is no iOS domain.
  4. ✅ Uses `AppText` (25). The CTAs have roles (75, 78, 97, 108, 111).
- **Regressions:** none found. With a missing code, the error state still offers Try again, which can only fail again (57, 108).
- **Subscreens:**
  - Pending-approval state — 8 → 8.
  - Error state with retry — 8 → 8.
  - Join confirmation (new Step, 67-81) — 7. The user consents without seeing the group name.
- **Still needed for 10/10:**
  1. Show the group name before joining, once `GET /chats/join/:code` exists (12-13).
  2. Give the "joining" phase an exit (84-90).
  3. Hide Try again when the code is missing (57, 108). Add header roles to the other phase titles (87, 95, 106).
  4. Verified links plus iOS Associated Domains (app.json:64-83).

#### `app/i/[token].tsx` — **6 → 6.5**
- **Scores now:** Function 4 · States 7 · UI 7 · A11y 7 · Security 7 · Code 8
- **Original items:**
  1. ◐ It now starts in a confirm phase ("Accept this invitation?", i/[token].tsx:31, 61-76). The route is still not retired, and nothing in the app produces these tokens (unchanged per the original review).
  2. ✅ `headerShown:false` with on-screen exits in every phase (60, 73, 81, 96).
  3. ◐ `AppText` (20) and theme colours inline (58-99). Still a static `StyleSheet` (105-113), and `colors.primary + '1a'` assumes hex colours (63, 87).
- **Regressions:** "Cancel" while redeeming (81-83) only navigates to chats. The in-flight `redeemInvitation` keeps running, and on success still calls `router.replace('/chat')` (38-40). So Cancel neither cancels the join nor reliably keeps the user on chats.
- **Subscreens:**
  - Error state with retry — 7 → 7.
- **Still needed for 10/10:**
  1. Make Cancel effective. Either drop it during the request, or guard the `router.replace` with an aborted ref (38-40, 81-83). Wording that says the join may still complete would also do.
  2. Retire the legacy route on a deadline, or remove it (lib/chatService.ts redeemInvitation is LEGACY per the original review).
  3. Drop the unverifiable `https://vaultchat.app/i/` claim from the header (4); it is not in app.json:64-83.
  4. Use `makeStyles(colors)` and `brandAlpha`-style helpers instead of hex concatenation (63, 87, 105-113).

#### `app/invite-link.tsx` — **7 → 7.5**
- **Scores now:** Function 7 · States 8 · UI 7 · A11y 7 · Security 8 · Code 8
- **Original items:**
  1. ✅ A permanent link needs confirmation (invite-link.tsx:53-66).
  2. ✅ A missing `chatId` shows an error (45). The error bar retries (131-135). There is still no pull-to-refresh (153).
  3. ◐ `JOIN_BASE` (19) is covered by the new Android filter, without verification and with no iOS domain (app.json:64-83).
  4. ◐ Create and link buttons have roles and labels (141-142, 166-178). Still RN `Text` (10).
- **Regressions:** none found.
- **Subscreens:**
  - Invite QR modal — 7 → 8. It has `accessibilityViewIsModal` (194) and a labelled QR (196). Whether it opens the app depends on the app.json section.
  - Revoke confirmation — 8 → 8.
  - Permanent-link confirmation (new Dialog, 57-64) — 8.
- **Still needed for 10/10:**
  1. Verified links plus iOS Associated Domains for `JOIN_BASE` (19; app.json:64-83).
  2. Swap RN `Text` for `AppText` (10). Raise the link buttons (`paddingVertical: 7`, 229) and the back button (213) to a 44dp minimum.
  3. Add a `RefreshControl` to the list (153). Count only non-expired links in "ACTIVE LINKS" (107, 149).
  4. Tokenise the error-bar and backdrop rgba values (219, 232).

---

### C1 — Chat Conversation Screen — re-rating

Base 18eb6d2 → HEAD f774ffa. Diff for this batch: `app/chat.tsx` (+236/−172 across the three files), `components/chat/MessageBubble.tsx`, `components/MessageActionSheet.tsx`, plus helpers the fixes rely on (`components/ConnectionBanner.tsx`, `components/chat/chatStyles.ts`, `components/chat/ViewerStack.tsx`, `components/GifPicker.tsx`, `components/ui/Sheet.tsx`, `lib/chatLock.ts`, `lib/chatService.ts` forwardMessage, `lib/inChatSearchCount.ts`). I read all 4,644 lines of the current `app/chat.tsx` in chunks.

Checks I ran (read-only), all exit 0: `npx tsx` lib/a11yCoverage, themeCoverage, chatLockReceipts, inChatSearchCount, chatLockFactors, screenBackCoverage, forwardPolicy. `npx eslint app/chat.tsx`: 0 errors, 35 warnings (24 import/first, 9 exhaustive-deps, 2 array-type). The P3 log said about 31. `as any` in chat.tsx went from 44 to 45. Note: `lib/chatLockReceipts.selftest.ts` only regex-matches the source (`:12-37`). It proves the gates are written, not that they behave on a device. Nothing here is device-verified or deployed.

| Screen | Old | New | Δ |
|---|---|---|---|
| `app/chat.tsx` — Chat conversation (1:1 + group + split pane) | 6 | **7.5** | +1.5 |

#### `app/chat.tsx` — **6 → 7.5**
- **Scores now:** Function 8 · States 8.5 · UI 7 · A11y 7.5 · Security 8 · Code 5 (avg 7.33 → **7.5**)
  - Function 7→8: composer link-preview bug fixed, dead quick-react modal gone, search count fixed, Chat-lock entry point added, error Retry added. Still open: GIF and Forward bypass the outbox, groups have no Clear/Leave, search covers only the loaded window, and a probable stale closure on the mention picker.
  - States 8→8.5: edit rollback, load Retry, "Too short" feedback, key-change try/catch, and an honest screenshot alert. New gap: during the new PIN backoff the gate says "Incorrect PIN".
  - UI 6→7: listed hex/rgba values tokenised, safe-area insets in the media preview, header hitSlop. The `chatStyles.ts` banner palette is unchanged.
  - A11y 5→7.5: broad labelling sweep, bubble action, focusable camera control, live regions. Still missing: a bubble summary label, a modal flag on the lock veil and the photo/info modals, thumbnail labels.
  - Security 7→8: read receipts, presence and notification clears gated on the lock; Forward/Copy hidden plus an API backstop; PIN backoff with scrypt. New leak: the pinned bar shows Invisible Ink text (regression). Star and Remind still copy ink text.
  - Code 4→5: about 30 imports and the dead modal/comments removed. Still 4,644 lines, 45 `as any`, `useS()` per bubble, the dead `color` field, and 9 hook-deps warnings.
- **Original items:**
  1. ✅ Read receipts gated on the lock: read effect `app/chat.tsx:1383`, timer re-check `1397`, cleanup flush `1428`, deps `1435`, render-time ref `546-547`. Viewer emission gated `616`, notification clear gated `722-724`. ✅ PIN backoff and salted KDF moved into the lib: `lib/chatLock.ts:108-129` (`afterFailure`/`chatPinWaitMs`, `makeChatPinHash`). ◐ chat.tsx does not use `pinRetryAfterMs`, so see Regressions.
  2. ✅ `composerLp` added to the `onSend` deps (`1606`).
  3. ✅ Edit rollback when `enqueueEdit` throws: the `undoEdit` closure (`1542`, `1555-1560`) is called in the catch (`1601`).
  4. ◐ Accessibility. Labelled with roles: avatar `3524-3525`, title (with hint) `3541-3543`, scroll FAB `3979-3980`, pinned bar `3791-3793`, key-change buttons `3688-3698`, live-location ✕ `3769`, attach cells `4353-4354`, forward rows `4561-4562`, photo actions `4316-4332`, lock Unlock/Back/PIN `4626-4636`, media send `4492-4494` and view-once switch `4471-4473`. Camera is focusable with actions (`4201-4209`), bubble has a `longpress` action (`MessageBubble.tsx:1388-1389`), header targets are 36+2×4 (`3580-3620`, `chatStyles.ts:121`). Remaining: the bubble has no `accessibilityLabel` summary (`MessageBubble.tsx:1364`), media-preview thumbnails are unlabelled (`4447`), and mic/send/reply-cancel/link-preview-close have labels but no role (`4227-4238`, `4106`, `4076`).
  5. ◐ Search mode now counts `renderMessages` (`3644`, `lib/inChatSearchCount.ts:13-21`). It still searches only the loaded window, has no prev/next, and "Search in chat" still opens the inline bar rather than `/in-chat-search` (`2024-2028`).
  6. ✅ Back hidden when `embedded` (`3515-3519`).
  7. ◐ Dead code: quick-react modal, `reactPicker`, `QUICK_REACTS` and orphan comments removed (diff), along with about 30 unused imports (`20-209`) and five unused `const me`. The stale meId comment is gone (`1376`). "Slide to cancel" copy fixed (`4117`). Remaining: the dead attach `color` field (`2756-2775`, render uses `colors.text` at `4357`), the stale "Day 8 — quick-react picker" header over `modalBackdrop` (`chatStyles.ts:464-465`), and an unused eslint-disable (`1488`).
  8. ◐ Theme: lock icon `colors.success` (`3550`), Read tick `colors.tickRead` (`4292`), live-location subtitle and ✕ `textDim` (`3767`, `3770`), media preview `colors.text`/`surfaceSolid` (`4420`, `4461`, `4474`, `4478`), insets (`4404`, `4409`, `4466`). Remaining fixed colours: the "secured" text `e2eBadge #22C55E` (`chatStyles.ts:175`), errorBar/screenshot/memory/key-change/vanish/ink/edit palettes (`chatStyles.ts:180-200`, `255-265`), the live-location banner background (`app/chat.tsx:3755`), and the view-once badge at fixed `top: 100` (`4436`).
  9. ◐ Privacy: Forward/Copy are hidden for `viewOnce`/`invisibleInk` (`1677-1682`). `forwardMessage` refuses those and strips `localUri` (`lib/chatService.ts:2748-2752`). ❌ GIF and Forward still bypass the outbox (`2736`, `2288`).
  10. ❌ Not split (4,644 lines). `as any` went from 44 to 45. `useS()` still runs per bubble (`MessageBubble.tsx:1133`). Pinned text preview ✅ (`3784`). There is no multi-select.
  - Also from the subscreen fixes: ✅ error Retry (`3661-3672`, `loadNonce` `366`, `958`); ✅ screenshot alert only after the report resolves (`1880-1885`); ✅ "Too short" alert (`2378`); ✅ typing shows "Someone" plus a live region (`4021-4025`); ✅ `mentionsRef` reset (`716`); ✅ "Replying to You" (`4088`); ✅ quoted edit banner (`4034-4036`); ✅ ConnectionBanner token and live region (`ConnectionBanner.tsx:25`, `35`). ❌ The notification-sound picker still does not mark the current sound, although `Sheet` now supports `selected` (`app/chat.tsx:1943-1950`, `components/ui/Sheet.tsx:24-25`). ❌ Groups still have no Clear/Leave (`2118` `if (peer)` only).
- **Regressions:**
  - **Pinned bar shows Invisible Ink text.** The new preview prints `pm.content` for any `text` row (`app/chat.tsx:3784`) and puts it in the bar's `accessibilityLabel` (`3792`). The bubble itself hides ink text from recipients until tilt (`MessageBubble.tsx:1589`). A pinned ink message is now readable without tilting. Fix: skip the preview when `pm.meta?.invisibleInk`.
  - **"Incorrect PIN" during backoff.** `verifyPin` now returns false without checking while backoff runs (`lib/chatLock.ts:110`), but `submitLockPin` maps every false to "Incorrect PIN" (`app/chat.tsx:3288`). A correct PIN typed during the wait is reported as wrong. `app/in-chat-search.tsx:79` and `app/app-lock-chats.tsx:93` already use `pinRetryAfterMs`; chat.tsx does not.
  - **ConnectionBanner contrast (dark).** `#B00020` was swapped for `c.danger`. Per fix log H (deferred #10), dark `danger` is `#EF4444`, and white 13px text on it is about 3.8:1, below 4.5:1 (`ConnectionBanner.tsx:22`, `35`, `37`). I did not recompute this ratio; it is the fixer's own measurement.
- **Newly observed (pre-existing, not caused by the fixes):**
  - The mention picker probably never opens. `onInputChange` reads `chat?.type` (`1502`), but its deps are `[chatId, meId, stopTypingIfActive]` (`1512`). The load sets `meId` (`764`) before `chat` (`770`, `848`), in separate renders, so the callback keeps `chat === null`. ESLint flags it (`1512:6`). This is not verifiable on a device statically, but the stale closure is in the code.
  - Locked content stays mounted under the veil. The FlatList renders `renderMessages` unconditionally (`3821-3823`). The veil is a sibling overlay (`4580-4581`, `chatStyles.ts:107`) with no `accessibilityViewIsModal`/`importantForAccessibility="no-hide-descendants"` on the content, so a screen reader may still traverse locked messages. Needs a device check.
  - In embedded split mode, Clear chat and Block call `router.back()` (`2207`, `2226`), which pops the whole split screen. That is the same hazard the Back fix addressed.
- **Subscreens** (the original listed 34 rows, not 33):
  - Message thread (FlatList) — 7 → 7.5. Bubble a11y action added and note/task ops filtered (`343-344`). Still no summary label, still `useS()` per bubble, still mounted under the lock veil.
  - Header (title, presence, calls, overflow trigger) — 6.5 → 8.5. Roles, labels, hint, hitSlop, `colors.success`, embedded Back. "secured" text still `#22C55E` (`chatStyles.ts:175`).
  - Overflow menu + Screenshot/Sound/Disappearing pickers — 7.5 → 8. Chat-lock entry added (`2082-2089`) and the target screen now reads `chatId` (`app/app-lock-chats.tsx:68`, `133`). Sound picker still has no current mark (`1943-1950`); flat 16+ rows.
  - In-chat search bar — 4.5 → 6. Count is correct (`3644`). Loaded window only, no prev/next, not routed to `/in-chat-search`.
  - ConnectionBanner — 7 → 8. Token and live region. Dark contrast is about 3.8:1 (H log).
  - Error bar — 6 → 8. Retry re-runs the load (`3664-3671`). Background is still rgba (`chatStyles.ts:180`).
  - Security-code-change banner — 6 → 7.5. Roles, labels, try/catch with alert (`3696-3707`). Palette still fixed (`chatStyles.ts:195-200`).
  - Inbound screenshot banner — 6.5 → 7.5. Live region added (`3716`). `#FCD34D` still fixed (`chatStyles.ts:192`).
  - Memory Bubble — 5.5 → 6.5. Role and hint (`3734-3735`). Fixed colours (`chatStyles.ts:184-185`); loaded messages only (`3406-3426`).
  - Live-location banner — 5 → 7. `textDim` and a labelled Ionicons ✕ (`3767-3771`). Background rgba is hard-coded (`3755`); the ✕ is still nested in the banner touchable.
  - Pinned-message bar — 6 → 7. Text preview, label and hint added, unpin has a role. **Regression:** it leaks Invisible Ink text (`3784`).
  - Scroll FAB + "Load newer" pill — 7 → 8.5. FAB labelled with the new-message count (`3979-3980`).
  - @mention picker — 5.5 → 6. Reset per chat and rows have a role. Still inserts the first name only (`1516`) and uses ASCII `\w` (`1501`, `1517`), and the stale `chat` closure probably keeps it from opening (`1502`, `1512`).
  - Live viewers stack + "Viewing now" modal — 6.5 → 7. Emission gated on the lock (`616`), and a close button and labelled backdrop were added (`ViewerStack.tsx:53-61`). Still uses `glassSoft` (`ViewerStack.tsx:94`), has no modal a11y flag, and its activity colours are fixed.
  - Typing indicator — 6.5 → 8.5. "Someone" fallback and a live region (`4021-4025`).
  - Edit mode bar — 5.5 → 8. Throw rollback, quoted preview, Cancel role (`4032-4040`). Background is rgba (`chatStyles.ts:255`).
  - Vanish Mode / Invisible Ink bars — 6 → 6.5. Ink bar has a role and hint (`4058-4059`). Palettes still fixed (`chatStyles.ts:257-265`).
  - Composer link-preview card — 4.5 → 8. Deps fixed (`1606`). The close button is labelled but has no role (`4076`).
  - Reply bar — 7.5 → 8.5. "You" for your own message (`4088`).
  - Composer + camera tap/slide — 6.5 → 8. Camera is focusable with `activate` and `videoNote` actions (`4201-4209`). Mic/Send are labelled without a role.
  - Voice recording mode — 5.5 → 8. Honest copy (`4117`) and a "Too short" alert (`2378`).
  - Quick-react Modal — 2 → **removed** (n/a). The modal, state, `QUICK_REACTS` and the `reactSheet*` styles are deleted (diff; `chatStyles.ts:464-466`).
  - Long-press MessageActionSheet — 7 → 8. Roles, labels, labelled backdrop, `accessibilityViewIsModal` (`MessageActionSheet.tsx:69-91`). Forward/Copy are hidden for view-once/ink (`app/chat.tsx:1679-1682`). Star still snapshots `plain` (`1688`) and Remind passes a plaintext `preview` route param (`1693`) for ink messages.
  - Message Info modal — 6.5 → 7. `colors.tickRead` (`4292`). No per-member timestamps; rows are not grouped.
  - Profile photo viewer — 6 → 7.5. Four actions have roles and labels (`4316-4335`). The modal has no a11y modal flag.
  - Attach menu — 6.5 → 7. Cells have roles and labels (`4353-4354`). The `color` field is still dead (`2756-2775`) and actions still wait on `setTimeout(a.onPress, 120)` (`4352`).
  - GifPicker overlay + preview — 7 → 7.5. Tabs are `tab` with selected state, cells have a label and hint (`GifPicker.tsx:166-189`). The send still bypasses the outbox (`app/chat.tsx:2736`).
  - Media caption preview — 6 → 7.5. Send and view-once are labelled with state, tokens and insets applied (`4466-4495`). Thumbnails are unlabelled (`4447`); the view-once badge sits at fixed `top: 100` (`4436`).
  - Forward picker — 5.5 → 6.5. Roles, "Group"/"Chat" label, lib refusal and meta strip (`lib/chatService.ts:2748-2752`). No search; not queued (`2288`).
  - Per-chat lock gate — 6.5 → 7.5. Receipts, presence and notification clear gated; lib backoff and scrypt; roles and PIN label. "Incorrect PIN" during backoff (`3288`). Content mounted under the veil (`3821`, `4580`).
  - Not-found / loading — 8 → 9. Spinner labelled (`3484`).
  - Failure / destructive Alerts — 7.5 → 8.5. The screenshot alert now reflects the actual report outcome (`1880-1885`).
  - Group-chat mode — 6.5 → 7. Note/task ops are no longer bubbles (`343-344`). No Clear/Leave (`2118`); mention issues remain.
  - Embedded split-pane mode — 6 → 7. Back hidden (`3515`). Clear chat and Block still `router.back()` (`2207`, `2226`).
  - `components/chat/MessageBubble.tsx` (bubble component) — 7 → 7.5. `longpress` accessibility action (`1388-1389`). The Reader receives `{chatId, id}` instead of plaintext when the cache has the body (`1001-1002`, `1603-1605`). No summary `accessibilityLabel` (`1364`); `useS()` per bubble (`1133`); 1,784-line file.
  - `components/MessageActionSheet.tsx` — 7 → 8. Same as the action-sheet row above; the unused `Dimensions` import and stale comment are removed (`:11`, `:36`).
- **Still needed for 10/10:**
  1. Stop the pinned bar from revealing Invisible Ink text: skip the preview when `pm.meta?.invisibleInk` (`app/chat.tsx:3784`, `3792`). Hide Star/Remind for ink and view-once messages, or store no snapshot for them (`1683-1694`), and stop passing the plaintext `preview` route param (`1693`).
  2. In `submitLockPin`, check `pinRetryAfterMs(lockInfo)` first and show "Try again in N s" instead of "Incorrect PIN" (`app/chat.tsx:3287-3288`), as `app/in-chat-search.tsx:79` does. Hide the message list from assistive tech while `lockState !== 'open'` (e.g. `importantForAccessibility="no-hide-descendants"` on the content, or don't render `renderMessages`; `3821`, `4580`).
  3. Fix the stale `chat` closure in `onInputChange` by adding `chat?.type` to the deps (`1502`, `1512`). Make mentions full-name and Unicode-aware (`1501`, `1516-1517`).
  4. Route GIF and Forward sends through the outbox (`2736`, `2288`).
  5. Search: route "Search in chat" to `/in-chat-search` (`2024-2028`), or add prev/next and search beyond the loaded window (`3631-3659`).
  6. Groups: add Clear chat and Leave group (`2110-2118`). In embedded mode, avoid `router.back()` after Clear and Block (`2207`, `2226`).
  7. Mark the current notification sound with `selected` (`1943-1950`; `Sheet.tsx:24-25`).
  8. Theme: tokenise the remaining banner palettes and the "secured" text (`chatStyles.ts:175`, `180-200`, `255-265`) and the live-location background (`app/chat.tsx:3755`). Use an `onDanger` ink or a darker dark-mode danger so ConnectionBanner reaches 4.5:1 (`ConnectionBanner.tsx:22`, `35`). Position the view-once badge from insets (`4436`).
  9. A11y: add a bubble `accessibilityLabel` (sender, text or type, time, tick state) (`MessageBubble.tsx:1364`). Label preview thumbnails (`4447`). Add roles to mic/send/reply-cancel/link-preview-close (`4227-4238`, `4106`, `4076`). Add `accessibilityViewIsModal` to the Info, photo and attach modals and ViewerStack (`4262`, `4304`, `4342`).
  10. Code health: split the component (4,644 lines). Reduce the 45 `as any`. Hoist `useS()` out of the bubble (`MessageBubble.tsx:1133`). Drop the dead attach `color` field (`2756-2775`) and the stale `chatStyles.ts:464` header. Fix the remaining hook-deps warnings (`560`, `1659`, `1807`, `1899` — `title` is stale in `recordScreenshotAttempt`, `2235`).
  11. Message Info: per-member timestamps and grouped rows (`4275-4280`). A message multi-select mode (none exists).

---

### C2 — Chat Tools, Backup & Import — re-rating

Base 18eb6d2 → HEAD f774ffa. I read every screen in full. Static and read-only. Overall = mean of six, rounded to the nearest 0.5 (ties round up).

| Screen | Old | New | Δ |
|---|---|---|---|
| `app/in-chat-search.tsx` | 7 | 8 | +1 |
| `app/message-reminder.tsx` | 5.5 | 7 | +1.5 |
| `app/schedule-message.tsx` | 6.5 | 8 | +1.5 |
| `app/scheduled.tsx` | 6 | 7 | +1 |
| `app/create-poll.tsx` | 7 | 8 | +1 |
| `app/bookmarks.tsx` | 5.5 | 7.5 | +2 |
| `app/chat-code.tsx` | 7 | 8 | +1 |
| `app/chat-export.tsx` | 5.5 | 6 (**UNWIRED**) | +0.5 |
| `app/chat-themes.tsx` | 6 | 7.5 | +1.5 |
| `app/chat-wallpaper.tsx` | 5.5 | 7 | +1.5 |
| `app/receipt-control.tsx` | 6.5 | 7 | +0.5 |
| `app/broadcast.tsx` | 5.5 | 7 | +1.5 |
| `app/app-lock-chats.tsx` | 3.5 (UNWIRED) | 7.5 | +4 |
| `app/import-chats.tsx` | 6.5 | 7.5 | +1 |
| `app/chat-backup.tsx` | 6 | 7 | +1 |
| `app/backup-e2ee.tsx` | 6 | 7.5 | +1.5 |

Evidence for the batch (`npx tsx`, all exit 0 at HEAD): `lib/bookmarkBodies`, `lib/scopedChoice`, `lib/chatExportFormat`, `lib/chatCode`, `lib/chatLockFactors`, `lib/chatLockReceipts`, `lib/a11yCoverage`, `lib/themeCoverage`, `lib/orphanRoutes` and `lib/waImport` selftests. `orphanRoutes` checks only a fixed list of routes, so it did not catch the chat-export finding below.

**Batch-level finding: `/chat-export` has no in-app entry.** Its only caller was `app/contact.tsx:125`. P1 deleted that file (`git diff --stat 18eb6d2 HEAD -- app/contact.tsx` shows 285 deletions; P1.md:74). Grepping `chat-export` across app/components/lib/hooks/services/constants finds only the Stack registration (`app/_layout.tsx:971`), comments and selftests. The original review missed something too: `app/contact.tsx` was itself rated UNWIRED (ratings/B.md:14), so the screen was already unreachable at base. Now nothing references it at all. The P3 export fixes are therefore unreachable from the UI.

---

#### `app/in-chat-search.tsx` — **7 → 8**
- **Scores now:** Function 8.5 · States 8.5 · UI 7.5 · A11y 7.5 · Security 8 · Code 7.5
- **Original items:**
  - ✅ Lock gate before any search. `getLock` fails closed on an unreadable table (`app/in-chat-search.tsx:59-74`). Search runs only when `gate === 'open'` (`:100`). Biometric is tried automatically (`:71`). PIN uses the backoff-aware `verifyPin`/`pinRetryAfterMs` (`:76-90`, `lib/chatLock.ts:108-134`). `verifyPin` mutates the held lock, so the backoff applies within the screen (`lib/chatLock.ts:105-115`). 'both' requires both factors (`:85-88`).
  - ✅ Result rows have role, label and hint (`:160-166`). Back and clear have roles and labels (`:249`, `:267`).
  - ✅ The stale "follow-up" header note is replaced (`:7-8`).
  - ❌ `renderItem`/`highlightMatch` are still rebuilt on every render (`:134-174`).
- **Regressions:** new hard-coded `'#fff'` on the unlock button text (`:383`).
- **Subscreens:** Lock gate (new, Step `:178-241`) — 7.5. Real gate with live-region errors. Fixes needed: not keyboard-avoiding, `'#fff'`.
- **Still needed for 10/10:**
  1. Memoise `renderItem`/`highlightMatch` (`app/in-chat-search.tsx:134-174`).
  2. Wrap the lock-gate PIN input in `KeyboardSafe`, since the input is centred and may sit under the keyboard (`:189-238`). Replace `'#fff'` with `c.bubbleOutText` (`:383`).
  3. Add `accessibilityLabel` to the search `TextInput`; today it has only a placeholder (`:255-265`).
  4. Type `debounce` instead of `useRef<any>` (`:38`).

#### `app/message-reminder.tsx` — **5.5 → 7**
- **Scores now:** Function 7.5 · States 7 · UI 7.5 · A11y 7 · Security 7 · Code 7
- **Original items:**
  - ✅ The tray never carries message text. Content comes from `notifContent(getNotifPreview(), …)`, the body is static, and 'hidden' explains and does not schedule (`app/message-reminder.tsx:147-158`, `lib/privacyPrefs.ts:55-63`).
  - ✅ No plaintext is stored. Rows hold ids only (`:166-170`). The list reads text from the sealed local cache (`:89-95`, `lib/localDb.ts:399-404`, `:1112-1122`).
  - ✅ `loadReminders` persists the prune and scrubs legacy previews (`:76-82`).
  - ◐ The route path is gone from the copy. `Router` is typed (`:31`) and the unused `colors`/`S` are gone. The dead `backTxt` style remains (`:341`), as does `as any` on the trigger (`:163`).
  - ✅ Preset and list rows have role, label and hint (`:204-212`, `:308-315`). AuroraBackground is on the loading and list views (`:282`, `:287`).
  - ✅ (subscreen fix) `setBusy(true)` runs before the permission awaits (`:134-135`).
- **Regressions:** none.
- **Subscreens:** Composer — 6 → 7.5. Reminders list — 5.5 → 7.
- **Still needed for 10/10:**
  1. The list shows message text from locked chats without unlocking them. `cachedText` reads `localDb` with no `getLock` check (`app/message-reminder.tsx:89-95`, `:321-323`). Apply the lock gate used in `app/in-chat-search.tsx:59-90`, or hide text for locked chats.
  2. Fix the copy. The empty state says "⏰ Remind me about this" (`:299`), but the action is "Remind" (`app/chat.tsx:1691`). The note says "Settings → Reminders" (`:230`), but the row is "Message reminders" (`app/settings.tsx:465`).
  3. A storage failure reads as "No reminders" because `loadReminders` returns `[]` on any error (`:84`). Surface an error. Catch `saveReminders` in the cancel path (`:273-275`).
  4. Remove `as any` on the trigger (`:163`) and the dead `backTxt` style (`:341`).

#### `app/schedule-message.tsx` — **6.5 → 8**
- **Scores now:** Function 8 · States 7.5 · UI 8 · A11y 7.5 · Security 8.5 · Code 7.5
- **Original items:**
  - ✅ Header copy now says "⋮ menu → Schedule a message" (`app/schedule-message.tsx:3-4`).
  - ✅ The iOS picker path uses the shared `useDatePicker` (inline sheet on iOS) (`:92-95`, `components/finance/useDatePicker.tsx:28-74`). Not verifiable statically on device.
  - ✅ Wrapped in `KeyboardSafe` (`:98`).
  - ✅ The input has a label (`:118`). Quick, custom and schedule buttons have roles and state (`:134-136`, `:150`, `:165-166`).
  - ✅ The local copy is now sealed in the kv table (`lib/scheduledLocalCopy.ts:34-39`). Legacy copies are migrated only after the sealed write succeeds (`:46-53`).
  - ✅ `'#fff'` → `c.bubbleOutText` (`:211`).
- **Regressions:** none.
- **Subscreens:** Custom date/time picker — 5 → 7.5. It is cross-platform, but the sheet uses finance theming (`useFinanceTheme`, `components/finance/useDatePicker.tsx:23,58`). Needs a device check on iOS.
- **Still needed for 10/10:**
  1. Move `useDatePicker` out of `components/finance/` and off `useFinanceTheme`, so chat screens do not depend on finance styling (`app/schedule-message.tsx:21`, `components/finance/useDatePicker.tsx:16,23`).
  2. `doSchedule` guards double taps only through disabled state (`:71`). Add a ref guard like `app/chat-export.tsx:48`.
  3. Remove the dead `backTxt` style (`:195`).

#### `app/scheduled.tsx` — **6 → 7**
- **Scores now:** Function 6.5 · States 7.5 · UI 7.5 · A11y 7 · Security 8 · Code 6
- **Original items:**
  - ✅ The list cache is written without `content`, legacy caches are scrubbed, and previews come from the sealed copy (`app/scheduled.tsx:43`, `:85`, `:98-101`, `:47-54`). Ciphertext is replaced by "🔒 Encrypted scheduled message" (`:52`).
  - ✅ Empty-state copy now says "tap ⋮ and choose 'Schedule a message'" (`:172`).
  - ❌ The dead `SCHEDULED_LOCAL` branches and `as any` casts remain (`:73-79`, `:120`, `:126-134`, `constants/flags.ts:142`). P3.md:54 deferred this.
  - ✅ Rows have role, state and hint (`:194-196`).
  - ✅ Reloads on focus (`:111`).
- **Regressions:** none.
- **Subscreens:** Cancel/Edit dialog — 6 → 6.5 (the Edit branch is still dead).
- **Still needed for 10/10:**
  1. Delete the `SCHEDULED_LOCAL` branches, their `as any` casts and the unused imports (`app/scheduled.tsx:34-36`, `:73-79`, `:120`, `:126-134`).
  2. Delivered rows never delete their sealed copy. `deleteScheduledCopy` is called only on cancel (`:121`), despite the claim in `lib/scheduledLocalCopy.ts:7`. Prune copies for `sentAt` rows.
  3. `withLocalCopies` passes non-text rows through unchanged (`:49`), and the row prints `r.content` for them (`:204`). Apply the same `looksEncrypted` guard.
  4. A cold-load error with no rows shows the empty state with no retry, and that `ScrollView` has no `RefreshControl` (`:165-174`). Add a retry.
  5. Remove the double load on mount, where the effect and the focus effect both call `load()` (`:95-111`). Remove the dead `backTxt` style (`:252`).

#### `app/create-poll.tsx` — **7 → 8**
- **Scores now:** Function 8.5 · States 7.5 · UI 8 · A11y 8 · Security 8 · Code 8
- **Original items:**
  - ✅ Duplicate options are rejected case-insensitively after trim (`app/create-poll.tsx:63-67`).
  - ✅ Options use stable ids as keys (`:35-36`, `:120`).
  - ✅ The Switch is labelled (`:159`). Send has role, label and state (`:96-98`). Add option has a role (`:142`). Inputs are labelled (`:112`, `:128`).
  - ✅ Wrapped in `KeyboardSafe` (`:81`).
- **Regressions:** none.
- **Subscreens:** none.
- **Still needed for 10/10:**
  1. Back discards a typed poll with no prompt (`app/create-poll.tsx:84`). Confirm when `question` or any option is non-empty.
  2. The Send button is about 40dp tall (`paddingVertical: 10`, `:178`). Give it `minHeight: 44`.
  3. Remove the dead `backTxt` and `removeBtnTxt` styles (`:175`, `:190`).

#### `app/bookmarks.tsx` — **5.5 → 7.5**
- **Scores now:** Function 8 · States 7.5 · UI 7.5 · A11y 7.5 · Security 7.5 · Code 7.5
- **Original items:**
  - ✅ The cache holds no bodies, and legacy caches are scrubbed (`app/bookmarks.tsx:68-71`, `:83`, `:122`, `lib/bookmarkBodies.ts:24-32`).
  - ✅ Ciphertext is never shown. `bookmarkBody` prefers the sealed snapshot and shows a server body only if it is not an envelope (`lib/bookmarkBodies.ts:14-22`, `app/bookmarks.tsx:42-48`).
  - ✅ Removal deletes the sealed snapshot (`app/bookmarks.tsx:119`, `lib/chatService.ts:1754-1763`).
  - ✅ Tapping jumps to the message via `setPendingJump` (`:107`). The header note is updated (`:3-9`).
  - ✅ Rows have role, hint and a "Remove bookmark" accessibility action (`:172-175`). Back has a role (`:143`).
  - ✅ Empty state says "Star" (`:156`).
- **Regressions:** none.
- **Subscreens:** none.
- **Still needed for 10/10:**
  1. Bodies from locked chats are shown without unlocking (`app/bookmarks.tsx:42-48`, `:184-189`). Check `getLock` per chat and hide text for locked chats.
  2. The empty state has no pull-to-refresh, because the `ScrollView` lacks `RefreshControl` (`:152`). A failed refresh with a cache shows nothing at all (`:87`). Show a "showing saved copy" hint.
  3. Drop the unreachable `|| '(deleted chat)'` (`:182`), the `as any` on `router.push` (`:108`) and the dead `backTxt` (`:230`).

#### `app/chat-code.tsx` — **7 → 8**
- **Scores now:** Function 8 · States 8.5 · UI 8 · A11y 7.5 · Security 7.5 · Code 8
- **Original items:**
  - ✅ Tabs use `role="tab"` with `selected` (`app/chat-code.tsx:171-172`). Options use `radio` with `checked` and a label (`:242-244`). The countdown is a live region (`:199`).
  - ✅ A load error shows tap-to-retry (`:91-98`, `:189-195`).
  - ◐ `'#fff'` → `bubbleOutText` (`:266`, `:308`, `:332`, `:362`). The `Platform` import is removed. The inaccurate "second device gets linked" comment is still there (`:354-357`).
  - ✅ (subscreen) Copy uses `copyAndAutoClear` (`:215`). (subscreen) The input is labelled (`:294`).
- **Regressions:** none. The polite live region on a one-second tick (`:199`) may announce every second; not verifiable statically.
- **Subscreens:** Share-a-code tab — 7 → 8. Enter-a-code tab — 7.5 → 8.
- **Still needed for 10/10:**
  1. Fix the stale comment at `app/chat-code.tsx:354-357`.
  2. Raise touch targets. Tabs are `minHeight: 40` (`:329`). The Copy/Share actions (`:351`) and Stop (`:364`) have no minimum size.
  3. Put the live region on a coarser value (for example the minutes, or ≤30 s only), so TalkBack does not speak every tick (`:199-202`).
  4. "New code" silently invalidates a live code that may already have been read out (`:259-268`). Confirm first.

#### `app/chat-export.tsx` — **5.5 → 6** — **UNWIRED**
- **Scores now:** Function 3 · States 7 · UI 6 · A11y 7 · Security 7.5 · Code 6.5
- **Original items:**
  - ✅ No ciphertext in exports. The union prefers the readable local copy over a sealed server body (`lib/messageHistory.ts:51-58`). The rest goes through `hydrateMessages` (`app/chat-export.tsx:74-77`), and `exportBody` refuses to print envelopes (`lib/chatExportFormat.ts:14-17`). The selftest passes. Real decrypt success is not verifiable statically.
  - ✅ The file is written to `cacheDirectory` and deleted in `finally` after sharing (`:94-108`).
  - ✅ `busyRef` is set before `authorizeExport()` (`:48`, `:192-195`).
  - ✅ Group sender names come from `getChat` members (`:85-87`, `:200-203`).
  - ✅ An "Export incomplete" alert shows at the page cap (`:66-72`, `:208-210`).
  - ◐ The export buttons have roles and state (`:285`, `:293`). `'#00000099'`, `'#FFFFFF'` and `BRAND_ACCENT` remain (`:369`, `:339`, `:375`).
  - ◐ (subscreen) PIN attempt limit: the backoff is now enforced inside `verifyPin` (`lib/chatLock.ts:108-116`). `submitPin` still says "Incorrect PIN." during the backoff and never calls `pinRetryAfterMs` (`:131-134`, `:333`).
- **Regressions:** the screen has no in-app entry (see the batch note). It was only reachable from the now-deleted `app/contact.tsx`.
- **Subscreens:** Chat-lock PIN modal — 6 → 6.5.
- **Still needed for 10/10:**
  1. Wire it in. Add an "Export chat" action to `app/contact-info.tsx` next to Search (`:264`), or to the chat ⋮ menu (`app/chat.tsx` near `:2088`), passing `chatId` and `peerName`. Add `/chat-export` to `lib/orphanRoutes.selftest.ts`.
  2. In `submitPin`, show `pinRetryAfterMs` ("Try again in N s") instead of "Incorrect PIN." (`app/chat-export.tsx:131-134`). Filter the input to digits with `maxLength={8}` to match `lib/chatLock` (`:325-328`).
  3. Show the truncation warning before the share sheet, not after the file has been shared (`:204-210`).
  4. Replace `'#00000099'`, `'#FFFFFF'` and `BRAND_ACCENT` in RN styles with tokens (`:339`, `:369`, `:375`).

#### `app/chat-themes.tsx` — **6 → 7.5**
- **Scores now:** Function 8 · States 7 · UI 7.5 · A11y 7.5 · Security 8 · Code 7.5
- **Original items:**
  - ✅ Per-chat Default is stored explicitly as `SCOPED_DEFAULT`, and `getBubbleColors` resolves through `resolveScoped` (`app/chat-themes.tsx:69-74`, `:141-151`, `lib/scopedChoice.ts:13-17`). The selftest passes.
  - ✅ Save is wrapped in try/catch with rollback and an alert (`:69-79`). The load is wrapped too (`:59-66`).
  - ✅ Swatches are radios with checked state and a label (`:122`). Reset has role and label (`:96`).
  - ✅ The title shows the scope (`:95`). `Alert` is now used.
- **Regressions:** none.
- **Subscreens:** none.
- **Still needed for 10/10:**
  1. A per-chat screen with no per-chat key shows "Default" selected while the chat actually uses the global colour (`app/chat-themes.tsx:57-66`). There is also no way to return a chat to "follow all chats", because Reset stores `'default'` (`:73-74`, `:96`). Show the inherited value and add a "Same as all chats" option.
  2. A tap made before the initial load resolves is overwritten by the load (`:59-66`). Ignore the load result once the user has picked.

#### `app/chat-wallpaper.tsx` — **5.5 → 7**
- **Scores now:** Function 7.5 · States 6 · UI 7.5 · A11y 7.5 · Security 7.5 · Code 5.5
- **Original items:**
  - ✅ The picked image is copied into `documentDirectory/wallpapers/` on save (`app/chat-wallpaper.tsx:94-102`). Not verifiable statically on device.
  - ✅ Per-chat Default is stored as `SCOPED_DEFAULT` (`:103-106`). `getWallpaper` and the load handle the sentinel (`:54-64`, `:86`).
  - ❌ `PreviewBg` is still an inline component that remounts `Image`/`LinearGradient` each render (`:130-144`).
  - ❌ The save model still differs from Bubble theme. "Set wallpaper" is required (`:250`), back discards with no prompt (`:153`), and Reset only changes the selection (`:111`).
  - ✅ Tabs have `role="tab"` with `selected` (`:178`). Default, colour and gradient tiles are radios with checked state (`:192-194`, `:203`, `:220`). The `Dimensions` import is removed. `'#fff'` → tokens (`:284`, `:303`).
- **Regressions:** each save writes a new `wallpapers/<chat>_<ts>.jpg`, and the previous copy is never deleted (`:99-101`). Storage grows with every change.
- **Subscreens:** Colors tab — 6 → 7.5. Gradients tab — 5.5 → 7.5. My photo tab — 5 → 7 (persistent copy, but old copies leak).
- **Still needed for 10/10:**
  1. Hoist `PreviewBg` to module scope, passing `selected` and styles as props (`app/chat-wallpaper.tsx:130-144`).
  2. Delete the previously saved wallpaper file when replacing or resetting it (`:94-106`).
  3. Pick one save model across theme and wallpaper. Either save on tap, or prompt on back with unsaved changes (`:153`, `:250`).
  4. Add a `saving` guard to `save` (a double tap copies twice) (`:91`). Wrap `launchImageLibraryAsync` in try/catch (`:119-125`).
  5. Colour tiles announce hex codes ("Wallpaper colour #ECE5DD", `:203`). Give them human names.

#### `app/receipt-control.tsx` — **6.5 → 7**
- **Scores now:** Function 8 · States 6.5 · UI 7 · A11y 7.5 · Security 7 · Code 6.5
- **Original items:**
  - ✅ The optimistic patch and the rollback touch only `[userId][hideKey]` (`app/receipt-control.tsx:82-98`).
  - ◐ Labels include the contact name (`:174-176`). The target is `hitSlop={5}` on a 34dp box (`:113`, `:213`). With `gap: 6` (`:212`), neighbouring hit areas overlap, and the visual target is still 34dp.
  - ◐ The error clears on success (`:94`). The load failure still has no retry or pull-to-refresh (`:59-60`, `:161-186`).
  - ◐ `as any` is replaced with a typed cast (`:93`). `Toggle` is still defined inside render (`:109-120`).
- **Regressions:** none.
- **Subscreens:** none.
- **Still needed for 10/10:**
  1. Add a retry (button or `RefreshControl`) for a failed initial load. Today it shows the error plus "No contacts yet" (`app/receipt-control.tsx:59-60`, `:183`).
  2. Make the toggles 44dp visually, or widen the gap so the hit areas do not overlap (`:212-213`).
  3. Hoist `Toggle` to module scope (`:109-120`).
  4. Rapid repeated taps on the same flag read a stale `rules` through `shownFor` (`:78-80`). Derive `nextShown` inside the functional update, or serialise per flag.

#### `app/broadcast.tsx` — **5.5 → 7**
- **Scores now:** Function 6.5 · States 6 · UI 7.5 · A11y 7.5 · Security 7 · Code 6.5
- **Original items:**
  - ◐ The invite now shares the code plus `vaultchat://broadcast?code=…` (`app/broadcast.tsx:153-154`), and the screen opens Join pre-filled from `code` (`:39`, `:54-57`). The scheme exists (`app.json:8`). However, on a cold launch into a locked or signed-out app, the stashed link is `usePathname()` (`app/_layout.tsx:236`, `:272`, `:277`, `:291`), which carries no query, so `?code=` is lost after unlock. P3's claim that "lib/pendingLink keeps the query string" holds only for full URLs (`lib/pendingLink.ts:41-61`). Whether other apps make `vaultchat://` tappable is not verifiable statically.
  - ✅ A `BackHandler` closes the channel view (`:61-68`). The post bar is in `KeyboardSafe` (`:196`).
  - ❌ No pagination; posts are fixed at `limit: 50` (`:138`).
  - ❌ `channel_post` is not filtered by channel (`:100-103`). This needs `channelId` in the payload (backend).
  - ❌ No leave/unsubscribe and no admin delete. P3.md:55 deferred this.
  - ✅ A "not end-to-end encrypted" note is shown (`:177`).
  - ✅ Create, Join, Share, POST and Cancel have roles. Inputs are labelled and `maxLength` is set (`:167`, `:207`, `:234`, `:238`, `:278-283`, `:305`, `:308`).
- **Regressions:** none.
- **Subscreens:** Channel list — 5.5 → 6.5 (Aurora added, still no refresh). Channel detail — 5 → 7. Create modal — 6 → 7.5. Join modal — 6 → 7.5.
- **Still needed for 10/10:**
  1. Preserve the query when stashing launch links (use the full URL or `useGlobalSearchParams`), so `?code=` survives the auth gate (`app/_layout.tsx:236`, `:272`).
  2. Add pull-to-refresh/retry to the channel list. A cold-load failure is only an Alert, followed by an empty list (`app/broadcast.tsx:70-79`, `:247-269`).
  3. Guard `openChannel` against out-of-order loads when switching channels quickly (`:135-140`).
  4. Paginate posts with `before` (`:138`, `lib/chatService.ts` `listChannelPosts`).
  5. Add leave and admin delete. Filter `channel_post` once the payload carries `channelId` (`:100-103`).
  6. Replace the `rgba(0,0,0,0.55)` scrim with a token (`:350`).

#### `app/app-lock-chats.tsx` — **3.5 → 7.5** (no longer UNWIRED)
- **Scores now:** Function 8 · States 7.5 · UI 7 · A11y 7 · Security 8 · Code 6
- **Original items:**
  - ✅ Wired from Settings "Chat locks" (`app/settings.tsx:423`) and the chat ⋮ menu "Chat lock" with `chatId` (`app/chat.tsx:2082-2089`). The screen reads `chatId`/`chatName` and opens that chat's setup once (`app/app-lock-chats.tsx:68`, `:131-149`).
  - ✅ The remove button has a solid `c.danger` fill (`:491-493`, `:640`).
  - ✅ The PIN is confirmed (`:209-213`, `:282-292`) and digits-only, 4–8 (`:44`, `:205`). The backoff message comes from `pinRetryAfterMs` (`:90-96`).
  - ✅ `setChatLock`/`removeChatLock` are in try/catch with alerts (`:186-190`, `:216-224`). Loading, error and retry states cover `listChats` (`:122-136`, `:433-450`).
  - ✅ "No messages" became "Not locked" (`:365-367`).
  - ✅ Both overlays are `<Modal>` + `KeyboardSafe` with `onRequestClose` (`:237-238`, `:459-460`). The Switch is labelled with the chat name (`:389-390`). Chips are radios with checked state (`:258-260`, `:303-305`).
  - ◐ The `#2B7FE0`, `#F59E0B` and `#9CA3AF` colours are gone and the StatusBar comment is deleted. `'#FFF'` (`:335-336`, `:647`) and `rgba(0,0,0,0.7)` (`:583`) remain.
  - ✅ (lib) Per-lock salted scrypt plus a persisted backoff (`lib/chatLock.ts:85-134`). The `chatLockFactors` selftest passes.
- **Regressions:** none. The chat menu passes only `chatId` (`app/chat.tsx:2088`), so a chat missing from `listChats` is titled "Chat" (`app/app-lock-chats.tsx:134`).
- **Subscreens:** Lock config panel — 4 → 7.5. Remove-lock PIN prompt — 3 → 7.5.
- **Still needed for 10/10:**
  1. Pass `chatName` from the chat menu (`app/chat.tsx:2088`).
  2. Replace `'#FFF'` and `rgba(0,0,0,0.7)` with tokens (`app/app-lock-chats.tsx:335-336`, `:583`, `:647`).
  3. Raise chip touch targets (`paddingVertical: 8`, about 33dp; `:600-610`) to 44dp.
  4. Remove the `eslint-disable exhaustive-deps` (`:120`) by making `loadChats` a `useCallback`. Add an unmount guard to the async loads (`:109-136`). Drop `opt.icon as any` (`:262`) by typing `icon` as an Ionicons name.
  5. Lift `renderConfigPanel` into a component. The file is 648 lines (`:228-346`).

#### `app/import-chats.tsx` — **6.5 → 7.5**
- **Scores now:** Function 8.5 · States 8 · UI 7 · A11y 7.5 · Security 7 · Code 6
- **Original items:**
  - ✅ `loadChat` returns success. `runImport` explains the failure with a Retry (`app/import-chats.tsx:139-151`, `:250-258`).
  - ✅ `doneRef` holds the live count for the error and cancel outcomes (`:125`, `:335`, `:363`, `:373`).
  - ✅ Cancel during reading/matching drops the parse through `parseGen` (`:127`, `:186-188`, `:204`, `:211`, `:234`, `:242-245`, `:472`).
  - ✅ Roles: the ack is a checkbox with state (`:700`), date pills are radios (`:723`), source rows are buttons with a disabled state (`:431-433`), contact rows are buttons with a label (`:641`), and the progress bar has a value (`:497-503`).
  - ❌ Imported media is still written as plaintext under `APP_DOCS/VaultChat/Imported` (`:287-297`). P3.md:59 deferred this.
  - ❌ `'#fff'` (`:702`) and the `rgba(...)` literals (`:848`, `:850`, `:872`) remain. Piece props are still `s: any` (`:588`, `:597`, `:606`, `:616`, `:657`, `:752`). The file grew to 874 lines.
- **Regressions:** none.
- **Subscreens:** Pick chat — 7 → 7.5. Pick source — 7 → 8. Pick file — 8 → 8. Reading/matching — 6 → 7.5. Preview — 7 → 8. Importing — 6.5 → 8. Done — 6.5 → 7.5. Failed — 8 → 8.
- **Still needed for 10/10:**
  1. Seal or document the imported media (`app/import-chats.tsx:287-297`, `constants/flags.ts:95`).
  2. Show "could not load chats" with a retry. Today a `listChats` failure renders "No conversations yet" (`:157-159`, `:620-627`).
  3. Wrap the date-order re-parse in try/catch; it is not caught (`:481-485` → `:203`). If a cancelled parse later throws, ignore it so it does not flip to 'failed' (`:180-183`).
  4. Move `getCurrentUserAsync`/`setMeta` before the import into the `try`, so a throw cannot strand the 'importing' stage (`:265-273`).
  5. Replace `'#fff'` and the `rgba` literals with tokens (`:702`, `:848-872`). Type the `s` prop. Split the steps into files.

#### `app/chat-backup.tsx` — **6 → 7**
- **Scores now:** Function 7.5 · States 7.5 · UI 7 · A11y 6.5 · Security 7 · Code 6.5
- **Original items:**
  - ✅ The "Include videos" switch is removed (`app/chat-backup.tsx:313-314`).
  - ✅ While loading, the header and a spinner show. On error, a retry shows (`:195-224`). `getBackupSettings` is caught (`:67-69`).
  - ✅ `useFocusEffect` refresh keeps `mode` current (`:88`).
  - ✅ `patch` rolls back and alerts (`:90-99`).
  - ◐ Radio rows have role and checked state (`:270`, `:307`). Restore has a role (`:260`). The secret input and Unlock are labelled (`:350`, `:356-361`). The E2EE row (`:278`) and the Google row (`:296`) still have no `accessibilityRole`.
  - ❌ The "Restart the app to see them" copy remains (`:166`, `:187`). P3.md:57 deferred this.
- **Regressions:** none.
- **Subscreens:** Backup secret modal — 6 → 7. Its Cancel and UNLOCK are bare text with no padding (`:353-365`, `:407-409`), so the targets are small. Restore confirm — 7 → 7.
- **Still needed for 10/10:**
  1. Reload the chat list after a restore instead of asking for an app restart (`app/chat-backup.tsx:166`, `:187`).
  2. Give the E2EE and Google rows `accessibilityRole="button"` (`:278`, `:296`). Give the modal Cancel/UNLOCK `minHeight: 44` with padding (`:353-365`).
  3. Replace `'#fff'` (`:257`, `:388`) and the `rgba(0,0,0,0.5)` scrim (`:398`) with tokens.
  4. Guard `refresh`'s fire-and-forget setters against unmount (`:67-75`).

#### `app/backup-e2ee.tsx` — **6 → 7.5**
- **Scores now:** Function 7.5 · States 8 · UI 7 · A11y 7 · Security 7.5 · Code 7
- **Original items:**
  - ✅ `keyshown` guards the header back, the Android back (`BackHandler`) and "I've saved it" with `confirmLeaveKey`. The iOS swipe is disabled (`app/backup-e2ee.tsx:52-67`, `:132`, `:137`, `:199`).
  - ✅ The key is copied with `copyAndAutoClear` and a 30 s clear (`:185-192`).
  - ✅ A load failure goes to an `error` stage with Try again, not "off" (`:43-47`, `:155-167`).
  - ❌ No re-type check of the key before leaving `keyshown` (`:171-205`). P3.md:56 deferred this.
  - ✅ The `header` fragment puts AuroraBackground on every stage (`:129-131`). Loading has a spinner (`:151`). Inputs are labelled (`:219`, `:224`) and buttons have roles and state (`:161`, `:184`, `:198`, `:231-232`, `:236`, `:262`, `:289`, `:292`).
  - ❌ No direct "change password / switch to key". `turnOff` still re-uploads a server-readable backup first (`:112-127`).
- **Regressions:** none.
- **Subscreens:** Loading — 4 → 7. Error (new) — 7.5. Off — 7 → 7.5. Create password — 6.5 → 7.5. Key shown once — 4 → 7. On — 7 → 7.5.
- **Still needed for 10/10:**
  1. Before leaving `keyshown`, ask for a few groups of the key to be re-typed (`app/backup-e2ee.tsx:196-201`).
  2. Add "Change password" and "Switch to key" on the `on` stage that call `enableE2EEBackup` directly, with no detour through account mode (`:244-268`, `:112-127`).
  3. Wrap the password stage in `KeyboardSafe` so TURN ON stays visible (`:207-241`).
  4. Replace `'#fff'` (`:234`, `:324`) and the dead `?? '#e5484d'` fallbacks (`:263`, `:327-328`) with tokens.

---

### D — Groups & Communities — re-rating

Base `18eb6d2` → `HEAD` (`f774ffa`). Fix logs read: `fixes/P8.md`, `fixes/H.md`. Every claim below was checked against the current file and `git diff 18eb6d2 HEAD -- <file>`; the fix logs were not taken on trust.

Checks run (read-only):
- `npx tsc --noEmit -p .` → exit 0.
- `npx eslint` on the 14 screens → 0 errors, 1 warning (`app/group-insights.tsx:144`, unnecessary dep `reload`).
- Selftests, all passing: `lib/groups/groupScreenFixes.selftest.ts`, `lib/orphanRoutes.selftest.ts` (50, including `/creator-channels` reached from nowhere), `lib/a11yCoverage.selftest.ts`, `lib/screenBackCoverage.selftest.ts`.

Nothing here is device-verified or deployed. Items marked 📱 need a device check.

| Screen | Old | New | Δ |
|---|---|---|---|
| `app/group-admin.tsx` | 5.5 | 6.0 | +0.5 |
| `app/group-calendar.tsx` | 6.0 | 7.0 | +1.0 |
| `app/group-info.tsx` | 6.0 | 7.0 | +1.0 |
| `app/group-insights.tsx` | 6.5 | 6.5 | 0 |
| `app/group-invites.tsx` | 7.0 | 7.0 | 0 |
| `app/group-members.tsx` | 7.0 | 7.5 | +0.5 |
| `app/group-notes.tsx` | 6.0 | 7.0 | +1.0 |
| `app/group-privacy.tsx` | 6.5 | 7.5 | +1.0 |
| `app/group-tasks.tsx` | 6.5 | 7.5 | +1.0 |
| `app/group-trip.tsx` | 6.5 | 7.5 | +1.0 |
| `app/group-calls.tsx` | 5.5 | 7.0 | +1.5 |
| `app/create-group.tsx` | 6.0 | 7.0 | +1.0 |
| `app/communities.tsx` | 5.5 | 6.5 | +1.0 |
| `app/creator-channels.tsx` | 3.5 | 4.5 | +1.0 |

### Cross-screen duplication (original §1–§6), now
- **§1 create-group vs group-create:** ◐ Consent is fixed. `create-group` now creates the group solo and sends invitations (`app/create-group.tsx:101-103`). Two creation UIs remain; the fix log calls this a product decision.
- **§2 invite policy conflict:** ❌ The footer still says "There is no link or code to share" (`app/group-invites.tsx:355-356`), while `app/group-info.tsx:553` still routes admins to `/invite-link`.
- **§3 role/remove gating:** ✅ There is now one shared check, `memberActions` (`lib/groups/permissions.ts:286-305`). It is used by group-admin (`:379`), group-members (`:116-118`) and group-info (`:592-595`), and is covered by `groupScreenFixes.selftest.ts` §1. ❌ The two approval systems are still separate: `approveMembers`/join-requests at `app/group-admin.tsx:103-104,166-173`, and `approvalMode` in group-members/group-invites.
- **§4 two hubs:** ◐ group-info now links shared calendar, notes and tasks for any group (`app/group-info.tsx:484-512`). Trip, insights and privacy are still Family-only, which is deliberate.
- **§5 notes/tasks fold duplication:** ❌ The rebuild/publish code is still duplicated: `app/group-notes.tsx:56-113` vs `app/group-tasks.tsx:66-132`.
- **§6 redirect shims:** ◐ `/creator-channels` is guarded in `lib/orphanRoutes.selftest.ts:141`, but it is still listed in `app/_layout.tsx:212`.

---

#### `app/group-admin.tsx` — **5.5 → 6.0**
- **Scores now:** Function 7 · States 6 · UI 6 · A11y 5 · Security 7.5 · Code 5.5
- **Original items:**
  1. ✅ The rank-aware check replaces `isAdmin && role !== 'owner'`. See `:379-381` (`memberActions`), the remove gate at `:399`, and the role options filtered per actor at `:408`.
  2. ❌ The two approval systems are still there: `approveMembers` + `listJoinRequests` at `:103-104, :166-185`.
  3. ✅ Load failure now shows "Couldn't load members. Tap to retry" (`:365-369`), with `loadFailed` set at `:107`.
  4. ◐ Accessibility, partly done:
     - Done: role options are radios with state (`:413-415`); rows have a label, hint and expanded state (`:388-391`); the remove button has a role (`:400`).
     - Not done: policy and slow-mode chips have no role/state (`:190`, `:293-297`, `:308-312`); both Switches are unlabelled (`:328`, `:337`); the remove button is still nested inside the row touchable (`:384-404`); the Approve pill has no role (`:355`).
  5. ❌ `PolicyToggle` is still defined in the render body (`:187-195`), and "Who can send" is still an inline copy (`:291-303`).
  6. ❌ The banner `setTimeout` is not cleared on unmount (`:84`).
  7. ✅ The header comment is corrected (`:4-9`).
  8. ❌ The main view still has no `<AuroraBackground />`: compare `:244` with the loading view at `:234`.
  9. ❌ `'#888'` is still used (`:329`, `:338`).
- **Regressions:** none found. The roles offered now come from the server's assignable list, so moderator/guest get correct labels via `GROUP_ROLE_LABELS` (`:30`, `:397`).
- **Subscreens:**
  - Role menu — 5 → 7.5. It has radio roles/state and rank-correct options (`:406-425`).
  - Remove-member confirm — 7 → 7.5. It is now reachable only for members the actor outranks (`:399`).
- **Still needed for 10/10:**
  1. Reconcile the approval system with `approvalMode`/`pendingMembers` (`:103-104, :166-185`).
  2. Label the Switches (`:328`, `:337`).
  3. Give the chips `accessibilityRole="radio"` + `selected` (`:190`, `:293-297`, `:308-312`).
  4. Un-nest the remove button from the row (`:384-404`); with a default `accessible` parent, the screen reader may merge it into the row (📱).
  5. Hoist `PolicyToggle` to module scope and use it for "Who can send" (`:187-195`, `:291-303`).
  6. Clear the banner timer on unmount (`:84`).
  7. Add `<AuroraBackground />` to the main view (`:244`).
  8. Replace `'#888'` with a token (`:329`, `:338`).
  9. When load fails, the Group Info section says "Only admins can edit group info" (`:275`) because `myRole` defaults to member. Hide that section while `loadFailed`.

#### `app/group-calendar.tsx` — **6.0 → 7.0**
- **Scores now:** Function 7 · States 7 · UI 7 · A11y 6.5 · Security 7 · Code 7.5
- **Original items:**
  1. ✅ Reminders are now scheduled. `syncReminders` (`:84-87`) feeds `eventReminderItems` (`lib/groups/calendar.ts:194-205`) into `syncEventReminders` (`lib/groups/taskReminders.ts:94-103`). It runs on focus, add and delete (`:137, :185, :205`). Selftest §2 passes. 📱 notification actually fires.
  2. ◐ First-load failure now shows "Couldn't load this month" with Retry (`:242-250`). Decrypt failures are still dropped silently (`:65`).
  3. ✅ Stale-month guard: `loadSeq` (`:103, :117, :121, :127-128`).
  4. ◐ Rows now have a label, a hint and a `delete` accessibility action (`:269-272`). They still have no `accessibilityRole`, and there is still no visible delete affordance; delete is long-press only (`:267, :300`).
  5. ✅ Add is disabled while `me` is null (`:368-370`).
  6. ❌ No edit flow (`:158-211`).
  7. ❌ Any member is offered delete on any event (`:191-211`). Server authorization is not verifiable statically.
- **Regressions:** one minor privacy point. Calendar reminders put another member's event title on this device's lock screen (`lib/groups/taskReminders.ts:47` reuses `reminderText`, whose body is the title, `lib/groups/reminders.ts:138`). The rationale in `reminders.ts:134-137` ("the user's own words … to the one person responsible") does not hold for shared events. Consider a generic body or a setting.
- **Subscreens:**
  - New-event sheet — 6 → 7. The chips are radios with state (`:332, :345, :360`) and Add is gated on `me`. Scheduling is still 3 day presets × 9 hours (`:44-50`).
- **Still needed for 10/10:**
  1. Replace the presets (`:44-50`) with a real date/time picker.
  2. Add an edit flow.
  3. Show a visible delete control and give rows `accessibilityRole="button"` (`:265-274`).
  4. Check `createdBy` before offering delete, or confirm the server enforces it (`:191-211`).
  5. Surface undecryptable events (`:65`) instead of dropping them.
  6. Decide whether lock-screen reminders may show event titles (`lib/groups/taskReminders.ts:47`).
  7. Show a refresh-failed indicator when a reload fails but older rows are still shown (`:127`, `:242`).

#### `app/group-info.tsx` — **6.0 → 7.0**
- **Scores now:** Function 8.5 · States 7 · UI 6 · A11y 7 · Security 7.5 · Code 5.5
- **Original items:**
  1. ✅ Load failure with no cache now shows an error screen with Retry and Go back (`:304-318`). The loading spinner also has a Back button and a label (`:320-330`).
  2. ✅ Rename and description Save have a `saving` guard and disabled/busy state (`:172-197`, `:380-383`, `:408-411`).
  3. ❌ No `KeyboardSafe`. The multiline description (`:398-406`) sits in a plain ScrollView (`:340`).
  4. ✅ Accessibility:
     - Photo labelled (`:349-351`).
     - Rename target labelled (`:386-387`).
     - Switch labelled (`:524`).
     - Nav rows, Add member and Leave have `accessibilityRole="button"` (`:430, :441, :458, :539, :552, :603`).
     - Remove labelled (`:658`).
  5. ❌ The member list is still a `FlatList` with `scrollEnabled={false}` inside a ScrollView (`:584-586`).
  6. ❌ Still uses raw RN `Text` (`:27`), has no `<AuroraBackground />` in the main view (`:340`), and uses `'#22C55E'` (`:714`).
  7. ◐ `patchChat` is now in the deps (`:185, :197, :225, :249`). The dead styles `backTxt` (`:673`) and `navChevron` (`:700`) remain.
- **Regressions:** none. The new "SHARED" section (`:484-512`) passes `{groupId, name}`, which matches what the calendar, notes and tasks screens read.
- **Subscreens:**
  - Rename editor — 6 → 7.5.
  - Description editor — 6 → 7. It has a guard, but still no keyboard handling.
  - Leave confirm — 7 → 7.
  - Remove confirm — 7 → 7.5. It is gated via `memberActions` (`:592-595`).
- **Still needed for 10/10:**
  1. Wrap the screen in `KeyboardSafe` (`:340`, `:398-406`).
  2. Replace the nested non-scrolling `FlatList` (`:584-586`), e.g. a `FlatList` root with header/footer components.
  3. Resolve the `/invite-link` vs "no link" policy (`:553` vs `app/group-invites.tsx:355-356`).
  4. Use `AppText` (`:27`), add `<AuroraBackground />` to the main view (`:340`) and replace `'#22C55E'` with `c.online` (`:714`).
  5. Delete the dead styles (`:673`, `:700`).
  6. The no-id "Go back" has no `accessibilityRole` (`:297-299`).

#### `app/group-insights.tsx` — **6.5 → 6.5**
- **Scores now:** Function 7 · States 6.5 · UI 7 · A11y 5 · Security 8 · Code 6
- **Original items:**
  1. ◐ The effect is wrapped in try/catch/finally (`:78-141`), so the spinner always clears. But on failure `me` stays null and `mayViewOthers` stays false, so the screen shows the identity message "We could not confirm who you are…" (`:222`) for what may be a network error. The catch at `:140` says "the screen's empty state applies".
  2. ❌ No tab role/state (`:167-188`).
  3. ❌ `frequentDestinations(trips, 3)` is still called twice per render (`:277, :279`).
  4. ❌ The footer still says "from data it already holds" (`:306`) and the comment says nothing is fetched (`:120`), but the screen calls `getMessages(groupId, {limit: 300})` (`:124`).
  5. ❌ `AVATAR_COLORS` is still hard-coded (`:38`).
- **Regressions:** none.
- **Subscreens:** Week/Month tabs — 6 → 6.
- **Still needed for 10/10:**
  1. Add a real error state in the catch at `:140`, distinct from the identity message at `:222`.
  2. Add `accessibilityRole="tab"` + `selected` (`:170-185`).
  3. Correct the fetch claim (`:120`, `:306`).
  4. Use `useMemo` for `frequentDestinations` (`:277-280`).
  5. Move the palette to tokens (`:38`).
  6. Fix the lint warning on the deps (`:144`).

#### `app/group-invites.tsx` — **7.0 → 7.0**
- **Scores now:** Function 8 · States 7 · UI 7.5 · A11y 6 · Security 7 · Code 7
- **Original items:**
  1. ❌ A search error still renders as "Nobody found" (`:109-110` → `:244`).
  2. ◐ Avatars now use `attachmentUrl` + the Authorization header (`:65`, `:196-197`). 📱 avatars render.
  3. ❌ The policy conflict with `/invite-link` remains (`:355-356`).
  4. ❌ No busy guard on resend (`:160-163`). Refresh failures are still silent (`:85-90`).
  5. ❌ The Invite/Approve pills still have no `accessibilityRole` (`:261`, `:303-305`).
- **Regressions:** none. The unused `Platform` import was removed (`:22`).
- **Subscreens:**
  - Turn-down confirm — 7 → 7.
  - Withdraw/revoke confirm — 7 → 7.
- **Still needed for 10/10:**
  1. Track a search error separately from empty results (`:109-110`).
  2. Resolve the link policy (`:355-356`).
  3. Add a resend busy guard (`:160-163`).
  4. Show refresh errors (`:88-90`).
  5. Add roles to the pills (`:261`, `:303`).

#### `app/group-members.tsx` — **7.0 → 7.5**
- **Scores now:** Function 8 · States 7 · UI 7 · A11y 7 · Security 8 · Code 7
- **Original items:**
  1. ✅ Load failure shows an error with Retry (`:258-267`), with `failed` set at `:98-100`.
  2. ◐ Avatars use `attachmentUrl` + auth (`:198-200`). 📱 avatars render.
  3. ✅ Accessibility:
     - Rows have a label, hint and state (`:224-227`).
     - Mode rows are radios (`:301`).
     - Sheet options are radios (`:405-406`).
     - Transfer and Remove have roles (`:422, :435`).
  4. ❌ The share picker still has no loading state, and errors become an empty list (`:161-165`, `:351-356`). Its rows and Close have no role (`:360`, `:369`).
  5. ❌ The IIFE inside JSX remains (`:382`). `ROLE_TONE` and `'#F59E0B'` are not tokens (`:48-49`, `:424`).
  6. ◐ Role and remove logic is now shared with group-admin (`memberActions`, `:116-118`). The approval systems are not merged.
- **Regressions:** none. Note a behaviour change: untyped groups now get admin/member role options here (`lib/groups/permissions.ts:268,299-301`); before, `typed` was required. The fix log says the server accepts these roles; I did not verify that.
- **Subscreens:**
  - Member actions sheet — 7 → 8.
  - Share picker — 5.5 → 5.5.
  - Join-mode list — 6.5 → 7.5.
- **Still needed for 10/10:**
  1. Give the share picker loading/error states and roles (`:161-165`, `:351-371`).
  2. Show refresh failure when members are already listed (`:258` only handles `members.length === 0`).
  3. Extract the sheet IIFE into a component (`:382`).
  4. Move `ROLE_TONE`/`#F59E0B` to tokens (`:48-49`, `:424`).
  5. Add roles to the Close buttons (`:369`, `:444`).
  6. Merge the approval model with group-admin.

#### `app/group-notes.tsx` — **6.0 → 7.0**
- **Scores now:** Function 7.5 · States 7 · UI 7 · A11y 6.5 · Security 7 · Code 6
- **Original items:**
  1. ✅ Ops whose `by` differs from the server-stamped `senderId` are dropped (`:71`; server stamping noted at `lib/chatService.ts:1001`). Any member can still delete any note (`lib/groups/notes.ts:84`); this is shared-edit semantics.
  2. ✅ `VCNOTE1:` ops are filtered from the timeline (`app/chat.tsx:344`) and from the chat-list preview (`app/(tabs)/chats.tsx:863`). 📱 confirm.
  3. ❌ Still a 400-message scan window (`:31, :61`).
  4. ✅ `publish` returns a boolean and the editor stays open on failure (`:107-112`, `:136-137`). Save is disabled while `me` is null (`:243-245`).
  5. ◐ Cards have a role and label (`:191`). The fold duplication with tasks remains.
- **Regressions:** none. An error state with Retry was added (`:170-178`).
- **Subscreens:** Note editor — 6 → 7.5.
- **Still needed for 10/10:**
  1. Replace the 400-message window with durable storage or paging (`:31, :61`).
  2. Extract the rebuild/publish fold shared with tasks (`:56-113`).
  3. Decide who may delete a note (`lib/groups/notes.ts:84`).
  4. Show a refresh-failed indicator when notes are already listed (`:76-77` with `:170`).
  5. Surface undecryptable ops (`:66`).

#### `app/group-privacy.tsx` — **6.5 → 7.5**
- **Scores now:** Function 8 · States 7 · UI 8 · A11y 7 · Security 8 · Code 8
- **Original items:**
  1. ✅ `setGroupPrivacy` now throws on write failure (`lib/groups/store.ts:326`; selftest §3). The screen alerts "Not saved" and keeps the stored value (`:72-80`). Group-privacy is the only caller.
  2. ✅ `patch` has a try/catch, and a missing `groupId` shows "Group not found" (`:88-97`).
  3. ✅ Accessibility:
     - All three Switches are labelled (`:165`, `:175`, `:194`).
     - Precision rows are radios (`:145`).
     - Duration chips are radios (`:208`).
     - The timer link has a role (`:217`).
  4. ✅ The 1h/8h chip selection is derived from `sharingUntil` (`:200-204`). It is approximate: any time over 1h left reads as "8 hours".
- **Regressions:** none.
- **Subscreens:** Stop-timer confirm — 7 → 7.5.
- **Still needed for 10/10:**
  1. Nothing re-renders as time passes. Chip state, `describePrivacy(p, Date.now())` (`:126`) and "Sharing stops HH:MM" (`:224-225`) go stale or point at a past time after expiry. Add a timer, or clear an expired `sharingUntil`.
  2. `reloadPrivacy` failure is silent (`:82`). The value is saved but may not reach the live publisher until the next start.
  3. An unknown but present `groupId` still shows defaults (`:58-66`).

#### `app/group-tasks.tsx` — **6.5 → 7.5**
- **Scores now:** Function 8 · States 7.5 · UI 8 · A11y 7.5 · Security 7 · Code 7.5
- **Original items:**
  1. ✅ The sender check (`:82`). Any member can still delete any task (`lib/groups/tasks.ts:104`).
  2. ✅ The `VCTASK1:` filter (`app/chat.tsx:344`, `app/(tabs)/chats.tsx:863`). 📱 confirm.
  3. ✅ Error state with retry (`:233-237`). Add is disabled while `me` is null (`:183`). The draft is kept on a failed send (`:144`).
  4. ✅ Chips are radios with state (`:197, :206, :214`). The done toggle is a checkbox (`:249`). The unused `Platform` import was removed (`:11-14`).
- **Regressions:** none.
- **Subscreens:** Due-date and assignee chips — 6 → 8.
- **Still needed for 10/10:**
  1. Replace the 400-message scan window (`:33, :73`).
  2. Extract the fold shared with notes (`:66-132`).
  3. Decide who may delete a task (`lib/groups/tasks.ts:104`).
  4. Show refresh failure when tasks are already listed (`:233` only handles the empty case).

#### `app/group-trip.tsx` — **6.5 → 7.5**
- **Scores now:** Function 8 · States 7 · UI 8 · A11y 6.5 · Security 7 · Code 7.5
- **Original items:**
  1. ✅ `endTrip(trip)` uses `active ?? trip` (`lib/groups/tripSession.ts:449-452`); the screen passes its trip (`:162`). The legacy marker is awaited and throws (`:458`). The server path still swallows failure and relies on the TTL (`tripSession.ts:456`). 📱
  2. ✅ Leave and End are in try/catch (`:150-163`).
  3. ✅ Coordinates are range-checked (`:113-116`).
  4. ✅ `circleMembers` now runs only when `groupId` is set (`:66-67`).
  5. ✅ Start is disabled while `me` is null (`:203-205`). Location permission for `geocodeAsync` is not verifiable statically.
  6. ✅ The lead toggle is a checkbox (`:191`). `Platform` was removed (`:11-14`).
- **Regressions:** none.
- **Subscreens:** Leave/End confirms — 5 → 7.5.
- **Still needed for 10/10:**
  1. A missing `groupId` still allows "Start trip" → `startTrip('' …)` (`:126`). Show a not-found state.
  2. Tell the user when the server end call fails (`lib/groups/tripSession.ts:456`), instead of clearing the UI silently.
  3. Label the destination input (`:186`).
  4. Location permission handling for `geocodeAsync` (`:118`) is not verifiable statically.

#### `app/group-calls.tsx` — **5.5 → 7.0**
- **Scores now:** Function 7.5 · States 7 · UI 6.5 · A11y 7 · Security 6.5 · Code 6.5
- **Original items:**
  1. ✅ Start is disabled while loading or with 0 members (`:137-145`), and a `starting` ref guards double taps (`:56-57, :92-93`).
  2. ✅ Error state with Retry (`:153-159`), with `failed` set at `:67-68`.
  3. ✅ `mode` is validated (`:48`).
  4. ✅ The comments and the notice are fixed (`:82`, `:150`).
  5. ◐ The dead `notice` style was removed. It still uses raw RN `Text` (`:27`).
  6. ✅ Mode buttons are radios (`:130`); rows say "Voice call <name>" (`:168-169`).
  7. ❌ A 1:1 call still passes the group `chatId` (`:77`). Not verifiable statically.
- **Regressions:** none.
- **Subscreens:** Voice/Video toggle — 5 → 8.
- **Still needed for 10/10:**
  1. Confirm or fix the 1:1 call `chatId` (`:77`).
  2. The legacy-build ring loop swallows all errors (`:97-104`). Tell the user if ringing failed.
  3. Use `AppText` (`:27`).
  4. Reset `starting` if the push throws (`:92-115`).

#### `app/create-group.tsx` — **6.0 → 7.0**
- **Scores now:** Function 8 · States 7.5 · UI 6 · A11y 7 · Security 7.5 · Code 7
- **Original items:**
  1. ✅ The group is created with `allowEmpty` and picked people are invited (`:101-111`). The server accepts `allowEmpty` (`vaultchat-backend-go/internal/routes/chats.go:1656-1659`). Partial invite failures are reported (`:106-110`). 📱
  2. ✅ Load error is now separate from empty, with Retry (`:180-187`).
  3. ❌ No `KeyboardSafe`. The absolute bottom bar (`:204`, `:256`) and inputs (`:145`, `:173`) are unwrapped.
  4. ✅ Rows are checkboxes with state (`:121-122`); chips are labelled "Remove <name>" (`:160-161`).
  5. ◐ Dead styles were removed. The hard-coded rgba error bar remains (`:234`).
- **Regressions:** none. Every picked person is still invited only when the group create succeeds (`:101-103`).
- **Subscreens:** Selected-member chips — 5 → 8.
- **Still needed for 10/10:**
  1. Add `KeyboardSafe` (`:133-219`).
  2. Use tokens for `errorBar` (`:234`).
  3. Add `accessibilityLabel`s to the name and search inputs (`:145`, `:173`).
  4. Name who failed in the partial-invite alert, or keep failures retryable in place (`:106-110`).
  5. Merge the UI with `group-create`, or document the split.

#### `app/communities.tsx` — **5.5 → 6.5**
- **Scores now:** Function 6 · States 7 · UI 7 · A11y 7 · Security 6 · Code 6.5
- **Original items:**
  1. ✅ `listCommunities` now throws (`lib/chatService.ts`; selftest §4). The cached list is kept, with an error bar or an empty error state and Retry (`:40-53`, `:160-173`).
  2. ✅ Hardware Back returns from detail to the list (`:57-61`). 📱
  3. ◐ "New group" is now shown only when `detail.isOwner` (`:136`). But the comment "server-side rule mirrored by isOwner" (`:135`) is wrong: `communitiesCreateGroup` lets any community member create a group (`vaultchat-backend-go/internal/routes/communities.go:203-215`). The client gate is stricter than the server and is not a security control.
  4. ❌ No leave, edit or delete features.
  5. ✅ Community and group rows have role and label (`:123, :187`). Modal buttons and CTAs have roles (`:179, :214-215`).
- **Regressions:** none at runtime, but the `:135` comment is factually incorrect (see item 3).
- **Subscreens:**
  - Community detail — 5.5 → 6.5.
  - Name modal — 6 → 7. Its inputs have no label (`:209, :211`).
- **Still needed for 10/10:**
  1. Decide who may create groups. Enforce owner-only on the server (`communities.go:203-215`) or drop the client gate, and fix the comment (`:135`).
  2. Add management features: leave, edit, delete, add an existing group.
  3. `openCommunity` reads the cache outside try and has no stale-response guard (`:63-76`).
  4. Label the modal inputs (`:209, :211`).
  5. Show progress on the error-bar retry (`:161`).

#### `app/creator-channels.tsx` — **3.5 → 4.5**
- **Scores now:** Function 1 · States 4 · UI 6 · A11y 5 · Security 6 · Code 4
- **Original items:**
  1. ◐ Guarded in `lib/orphanRoutes.selftest.ts:141` (passes, "reached only from nowhere"). The route and its `INSET_SCREENS` entry (`app/_layout.tsx:212`) are still there.
  2. ✅ Shows a themed background and a labelled spinner (`:18-22`).
- **Regressions:** none.
- **Subscreens:** none.
- **Still needed for 10/10:**
  1. Delete the file and its `INSET_SCREENS` entry (`app/_layout.tsx:212`). It is still **UNWIRED**: the Function score cannot rise while it only redirects.

---

### E+K — Calls, Live, Voice + Utilities, Games — re-rating

| Screen | Old | New | Δ |
|---|---|---|---|
| `app/voicecall.tsx` | 6.5 | 7 | +0.5 |
| `app/videocall.tsx` | 6.5 | 6.5 | 0 |
| `app/incoming-call.tsx` | 6.5 | 7.5 | +1 |
| `app/group-call-active.tsx` | 6.5 | 7 | +0.5 |
| `app/network-test.tsx` | 5 | 7 | +2 |
| `app/live-view.tsx` | 6.5 | 6.5 | 0 |
| `app/notifications.tsx` | 6 | 7 | +1 |
| `app/notification-sounds.tsx` | 6.5 | 7.5 | +1 |
| `app/storage-manager.tsx` | 6 | 7 | +1 |
| `app/cache-cleanup.tsx` | 7.5 | 8 | +0.5 |
| `app/offline-mode.tsx` (rewritten) | 3 | 8 | +5 |
| `app/dashboard.tsx` | 6.5 | 7 | +0.5 |
| `app/games.tsx` (+ boards/sheets) | 7.5 | 7.5 | 0 |

Method and evidence:
- Baseline is commit 18eb6d2. I read every change with `git diff 18eb6d2 HEAD -- <file>` and then re-read the current files. The working tree is clean. Every fix claim in `fixes/P9.md` and `fixes/P1.md` was checked against the current code, and the citations below use current line numbers.
- I ran these checks myself and all passed: `npx tsc --noEmit -p .` (exit 0, no errors); `lib/games/tableCode.selftest.ts`; `lib/ringtoneChoice.selftest.ts`; `lib/speedTest.selftest.ts` (5); `lib/outboxSummary.selftest.ts` (6); `lib/a11yCoverage.selftest.ts`; `lib/themeCoverage.selftest.ts` (22 assertions, 20 exemptions); `lib/gamesBackCoverage.selftest.ts` (17); `lib/orphanRoutes.selftest.ts` (50).
- The overall score is the mean of the six dimensions, rounded to the nearest 0.5, with an exact .75 rounded up. Group-call, network-test and notifications each land on exactly 6.75.
- Nothing here is device-verified. The back-button handling, Alert-from-sheet timing, the native ringtone and real call and broadcast behaviour are all not verifiable statically.
- Legacy call bodies: P9 D1 explains why they were deferred. `constants/flags.ts:182-190` documents them as the rollback path until the hardware matrix passes. That reason holds, but the code-health cost still counts against the score.

---

#### `app/voicecall.tsx` — **6.5 → 7**
- **Scores now:** Function 8 · States 7 · UI 7 · A11y 7 · Security 7 · Code 5
- **Original items:**
  1. ◐ Dead `VoiceCallLegacy` and unused imports. The imports `callFail`, `offerTag` and `enterPipMode` are removed (`app/voicecall.tsx:39`, the diag import is gone). `VoiceCallLegacy` is still there (`:351`); see the deferral note above.
  2. ✅ `CallControlButton` now has a role, label and selected state (`components/call/CallControlButton.tsx:44-48`).
  3. ❌ The encryption badge is still hard-coded to `"transport"`, and the comment calling it "the strong one" still sits beside it (`app/voicecall.tsx:322-323`).
  4. ❌ `inviteToCall` is still fire-and-forget (`:290`).
  5. ❌ The add-person button has a label but no role (`:305-310`).
- **Regressions:** none.
- **Subscreens:**
  - Add-to-call sheet: 7 → 7.
  - In-call chat: 7.5 → 7.5.
  - Reaction picker: 6.5 → 6.5. The emoji buttons are still unlabelled (`components/call/CallReactions.tsx:77`).
- **Still needed for 10/10:**
  1. Remove `VoiceCallLegacy` (`app/voicecall.tsx:351` onward) once the rollback gate in `constants/flags.ts:182-190` is cleared.
  2. Derive the encryption badge with `protectionFor(...)` and fix the comment (`app/voicecall.tsx:322-323`).
  3. Await `engine.inviteToCall` and report the result (`:290`).
  4. Add `accessibilityRole="button"` to the add-person button (`:305`). Label the reaction emoji (`components/call/CallReactions.tsx:77`).

#### `app/videocall.tsx` — **6.5 → 6.5**
- **Scores now:** Function 7.5 · States 7 · UI 6.5 · A11y 6.5 · Security 7 · Code 5
- **Original items:**
  1. ◐ Legacy body and imports. The imports are removed (`app/videocall.tsx:27`, the diag import is gone). `VideoCallLegacy` remains (`:563`).
  2. ✅ The camera control now speaks "Turn camera off" / "Turn camera on" (`:521`).
  3. ❌ The share banner is still positioned at `top: 110` (`:1100`).
  4. ❌ "Beauty" is still a local tint presented as a filter (`:538`).
  5. ◐ `CallControlButton` has role and state (`components/call/CallControlButton.tsx:44-48`), but the filter chips still have no role, label or state (`app/videocall.tsx:493`).
  6. ❌ The badge is still hard-coded to `"transport"` (`:454`).
- **Regressions:** minor. Stop-share passes `active` unconditionally (`app/videocall.tsx:523`), so with the new state prop it announces "Stop, selected". This is cosmetic.
- **Subscreens:**
  - Add-to-call sheet: 7 → 7. The invite result is still ignored (`:418`).
  - Beauty filter strip: 5 → 5.
  - In-call chat / reactions: 7.5 → 7.5.
- **Still needed for 10/10:**
  1. Remove `VideoCallLegacy` (`:563` onward) after the rollback gate.
  2. Position the share banner from `insets.top` (`:1100`).
  3. Give the filter chips `accessibilityRole="button"` and `accessibilityState.selected` (`:493`), and rename "Beauty" or implement the processor path (`:538`).
  4. Derive the encryption badge (`:454`).
  5. Await `inviteToCall` and report the result (`:418`).
  6. Drop `active` from the Stop button (`:523`).

#### `app/incoming-call.tsx` — **6.5 → 7.5**
- **Scores now:** Function 8 · States 7.5 · UI 7.5 · A11y 7.5 · Security 7 · Code 7
- **Original items:**
  1. ✅ Hardware back now declines, which sends `webrtc_end` and writes a call log (`app/incoming-call.tsx:219-227`, `:204-214`). Needs a device check.
  2. ✅ Re-entry guards are in place (`:172`, `:205`).
  3. ✅ The dead accept-wait state and the `Alert` import are gone (`:10`, `:111-137`).
  4. ✅ Accept and Decline have roles and labels, including the call-waiting label (`:243`, `:251-252`).
  5. ✅ The body has a top inset (`:235`).
  - Also new: the caller-hangup and decline paths fall back to `replace('/')` when there is no history (`:152`, `:167`).
- **Regressions:** none.
- **Subscreens:** Call-waiting mode: 6.5 → 7.5. Back and double-tap are now guarded, and the label is accurate (`:252`).
- **Still needed for 10/10:**
  1. Surface or retry a failed `webrtc_end` emit. It is still swallowed by `catch {}` (`:209-212`), so the caller can keep ringing with no signal to the user.
  2. A group decline sends `webrtc_end` only to `peerUid` (`:211`). Confirm that this is what the group ring expects (not verifiable statically).
  3. Merge the duplicated `canGoBack` fallback in the hang-up handler (`:152`) into `leave()` (`:167`).
  4. Hide the decorative avatar initial from the screen reader (`:237`).

#### `app/group-call-active.tsx` — **6.5 → 7**
- **Scores now:** Function 8 · States 7 · UI 6 · A11y 6.5 · Security 7.5 · Code 5.5
- **Original items:**
  1. ✅ The end-of-call exit has a `canGoBack` fallback (`app/group-call-active.tsx:282-286`).
  2. ❌ There is still no safe-area handling. The controls use a fixed `paddingBottom: 36` (`:828`).
  3. ❌ `ParticipantTile` has no role or label (`:82-86`), and neither do the ✋ badge (`:96-98`) or the Add pill (`:374-377`).
  4. ❌ `GroupCallLegacy` remains (`:492`), and `CtrlBtn` is still typed `any` (`:774`).
  5. ❌ The invite and role calls are still not awaited (`:159-161`, `:235`, `:240`).
- **Regressions:** none.
- **Subscreens:**
  - Moderation sheet: 7 → 7.
  - Add people sheet: 7 → 7.
  - Pager: 7.5 → 7.5. It still has no `accessibilityState.disabled` (`:423-436`).
  - In-call chat / reactions: 7.5 → 7.5.
- **Still needed for 10/10:**
  1. Apply `useSafeAreaInsets` to the controls (`:828`) and to the top chrome.
  2. Add a role and a "Moderate <name>" label to tappable tiles (`:82-86`). Label the hand badge (`:96-98`) and the Add pill (`:374`).
  3. Await `setRole` and `inviteToCall` and report failures. Confirm "Move to audience" before applying it (`:159-161`, `:235`, `:240`).
  4. Add `accessibilityState.disabled` to the pager buttons (`:424`, `:432`).
  5. Remove `GroupCallLegacy` after the rollback gate (`:492`), and type `CtrlBtn` (`:774`).

#### `app/network-test.tsx` — **5 → 7**
- **Scores now:** Function 7.5 · States 7 · UI 6 · A11y 6.5 · Security 7 · Code 6.5
- **Original items:**
  1. ✅ Results are no longer fabricated. Only 2xx samples count (`lib/speedTest.ts:21-31`, `app/network-test.tsx:152`, `:176`). A failed ping is no longer counted as a round trip (`:136`). A metric with no successful sample shows as "Failed" (`:402-403`), and a run where nothing worked becomes `failed` (`:217-218`). Covered by `lib/speedTest.selftest.ts`.
  2. ✅ The run has try/catch and a `mounted` guard (`:76-77`, `:196-237`), plus a failed panel (`:381-388`).
  3. ✅ `checkConnection` returns its value (`:89-99`), and the run uses that value (`:197`, `:229`).
  4. ✅ The Cloudflare and IP exposure is disclosed (`:340-342`), and the server label is now "Test server reachable" (`:337`).
  5. ✅ The dead needle animation and the `backArrow` style are removed.
  6. ◐ Start has a role, label and state (`:362-364`), and the gauge is labelled (`:252-253`). Hard-coded colours remain: `#FBBF24` (`:260`, `:335`, `:397`), `#2D7AE0` (`:367`), and `rgba(74,159,255,…)` (`:453`, `:460`, `:473`, `:485`, `:496`, `:505`).
  7. ✅ The double top inset is removed (`:452`). The screen is in `INSET_SCREENS` (`app/_layout.tsx:218`).
- **Regressions:** none. History now saves complete runs only (`:222`), which is intended.
- **Subscreens:**
  - Results grid: 5.5 → 7.5.
  - History list: 6 → 6.5. Rows are unlabelled, and the ↓ ↑ ⏱ glyphs are read raw (`:424-435`).
  - Failed panel (new, `:381-388`): 7.5.
- **Still needed for 10/10:**
  1. Replace the hard-coded colours with tokens (`:260`, `:335`, `:367`, `:397`, `:453-505`).
  2. Give history rows an accessible summary (`:418-437`). The gauge's `progressbar` role has no `accessibilityValue` (`:252`).
  3. `saveHistory` prepends to the `history` captured in the closure (`:121`). Use a functional update.
  4. Remove the unused `connectionType` state (`:68`) and the IIFE in JSX (`:355-378`). Abort in-flight fetches on unmount instead of only muting them.
  5. Optional: move the test to an app-owned endpoint. This is backend work, and P1 deferred #5 covers it.

#### `app/live-view.tsx` — **6.5 → 6.5**
- **Scores now:** Function 8 · States 7 · UI 7 · A11y 6.5 · Security 7 · Code 4.5
- **Original items:**
  1. ◐ Host exits:
     - The End button now shows while waiting (`app/live-view.tsx:1551-1562`).
     - `exitScreen` ends the broadcast on the owner's Failed path or confirms first (`:757-760`).
     - Hardware back is handled (`:763-766`).
     - Not done: `endBroadcast` on unmount (P9 D2). That case depends on the server sweep (`lib/broadcast.ts:136`), which I could not verify statically.
  2. ✅ All three "Go back" buttons use `exitScreen`, which leads to `leaveAsViewer` or `replace('/live')` (`:1194`, `:1215`, `:1325`). `stop()` falls back when there is no history (`:714`).
  3. ❌ The component is still one 2030-line component with duplicated teardown (`:690-741`). The new `exitScreen` adds another branch.
  4. ❌ The chat issues remain: unread is still length-based and capped (`:842-845`, `:632`); the draft is cleared before the send and lost on failure (`:642-647`); there is no auto-scroll.
  5. ❌ Poll and composer roles are missing, and double-tap is still the only way to show the chrome.
  6. ❌ `__getValue` is still used (`:1046`, `:1060-1061`).
  7. ❌ The plaintext passcode still travels in the route param (`:59`).
- **Regressions:**
  - Minor: `exitScreen` → `void stop()` has no re-entry guard (`:758`, `:690-715`). A double tap on the Failed "Go back" can call `endBroadcast` twice and `router.back()` twice.
  - Minor: hardware back now always exits, or prompts the host to end (`:764`), instead of first closing an open chat, poll or invite panel.
- **Subscreens:**
  - Waiting / Failed / Ended states: 6 → 7.5.
  - Top chrome row: 7 → 8.
  - Live chat: 6.5 → 6.5.
  - Poll card: 6.5 → 6.5.
  - Poll composer: 6 → 6.
  - Invite panel: 7.5 → 7.5.
  - Host media controls: 8 → 8.
  - Camera PiP: 6.5 → 6.5.
  - Stage strip: 6 → 6.
- **Still needed for 10/10:**
  1. Split the screen and merge the teardown paths into one helper (`:690-766`, stage geometry `:789-1163`).
  2. Fix the chat: compute unread from ids (`:842-845`), restore the draft on a failed send (`:642-647`), and auto-scroll.
  3. Add a busy guard to `stop()` (`:690`). Let back close the open panels before leaving (`:764`).
  4. Add roles and labels to the poll options and composer buttons, and provide a non-gesture way to show the chrome.
  5. Replace `__getValue` (`:1046`, `:1060`).
  6. Move the passcode out of route params (`:59`).
  7. End the broadcast on unmount, or confirm the server sweep reaps `starting` broadcasts (`lib/broadcast.ts:136`).

#### `app/notifications.tsx` — **6 → 7**
- **Scores now:** Function 7.5 · States 7 · UI 6 · A11y 6.5 · Security 7 · Code 6.5
- **Original items:**
  1. ✅ The Privacy tab now has an error message and retry (`app/notifications.tsx:183-189`, `:235-242`).
  2. ✅ A failed contacts load is told apart from "none" (`:111`, `:313-314`). Panic stays armable when the load failed (`:163`). The "none" case links to `/trusted-contacts` (`:164-167`, `:316`).
  3. ✅ The Switches are labelled (`:254`, `:292`). The panic label, state and live region follow the armed and countdown state (`:304`).
  4. ❌ The 7–9 pt text is still there (`:202`, `:225`, `:229`, `:246`, `:370`), and so are the hard-coded reds and whites (`:192`, `:299`, `:307-308`, `:320`).
  5. ❌ The nav bar is still at `bottom:18` (`:367`), still pushes on every tap (`:191`), and still duplicates NAV (`:24-30`).
  6. ✅ A failed toggle now reverts only that key (`:180`).
  7. ◐ The unused `colors` and `S` are removed (`:351-353`). The `as any` casts remain (`:191`, `:208`).
- **Regressions:** none. The new copy, "The panic button still alerts everyone you have added" (`:314`), relies on the server holding the contacts list. `sendSOS` posts without contact ids (`lib/chatService.ts:1340-1343`), so that is consistent, but the server side is not verifiable statically.
- **Subscreens:**
  - SOS history tab: 6.5 → 6.5. There is still no refresh or retry (`:217-232`).
  - Privacy tab: 6 → 7.5.
  - Panic tab: 6.5 → 7.5.
- **Still needed for 10/10:**
  1. Raise the micro text to type-scale sizes (`:202`, `:225`, `:229`, `:246`, `:260`, `:285`, `:312`, `:326`, `:370`). Replace `rgba(239,68,68,…)` and `#FFFFFF` with danger and on-primary tokens (`:192`, `:299`, `:307-308`, `:320`).
  2. Use `SCREEN_BOTTOM` for the nav (`:367`), and use `replace` or a shared NAV (`:24-30`, `:191`).
  3. Add pull-to-refresh or a retry to SOS history (`:76`, `:217`).
  4. Remove the `as any` casts (`:191`, `:208`).

#### `app/notification-sounds.tsx` — **6.5 → 7.5**
- **Scores now:** Function 8 · States 7 · UI 7 · A11y 7.5 · Security 8 · Code 8.5
- **Original items:**
  1. ✅ The ringtone pick is honoured. "Phone ringtone" (`'system'`) is now an explicit choice and the default (`lib/ringtoneChoice.ts:19-23`, `lib/sounds.ts:105-110`). Old prefs are migrated (`lib/ringtoneChoice.ts:37-41`, `lib/sounds.ts:46-49`). The note about closed-app ringing is honest (`app/notification-sounds.tsx:115-118`). Selftest passes. Needs a device check.
  2. ✅ Ringtone rows have the radio role and `checked` state (`:102-104`). The play icon shows only for previewable tones (`:110`).
  3. ✅ The Switches are labelled (`:69`, `:85`).
  4. ✅ A spinner shows while loading (`:38`).
  5. ✅ The preview has its own Sound, and unmount stops only the preview (`:28`, `lib/sounds.ts:132-151`).
  6. ❌ `thumbColor="#fff"` remains (`:71`, `:87`), and the screen still uses the raw `Text` instead of `AppText` (`:8`).
- **Regressions:** none. On iOS a stored `'system'` highlights Pulse (`:94-95`). That matches `resolveRingtone`'s fallback to `RINGTONES[0]` (`lib/sounds.ts:34`).
- **Subscreens:** none.
- **Still needed for 10/10:**
  1. Use a theme token for `thumbColor` (`:71`, `:87`) and `AppText` for text (`:8`).
  2. `setSoundPrefs` swallows persistence errors (`lib/sounds.ts:53-58`), so a failed save looks saved. Surface it.
  3. Mark the radio rows as a group, for example with `accessibilityRole="radiogroup"` on the container (`:91-113`).

#### `app/storage-manager.tsx` — **6 → 7**
- **Scores now:** Function 8 · States 7 · UI 6.5 · A11y 6.5 · Security 8 · Code 6
- **Original items:**
  1. ◐ There is now a `loadFailed` state with a retry (`app/storage-manager.tsx:109`, `:157`, `:294-301`). However, `walk()` still swallows `readDirectoryAsync` errors (`:65`), so the most likely failure still shows "No app files on disk yet." The Total card shows "0 B" on failure (`:280`).
  2. ◐ The gradients and borders use tokens (`:262`, `:275`, `:292`, `:320`, `:340`, `:356`, `:405`, `:410`, `:420`). `#FF9F43` remains (`:150`).
  3. ✅ The action rows, day chips and per-chat rows have roles, labels and states (`:324`, `:347`, `:359`, `:364`, `:380-382`).
  4. ✅ "Cache cleanup" is disabled while clearing (`:359`). The `mounted` guard is in place (`:110-112`, `:124`, `:159`).
  5. ❌ `walk()` still duplicates the cache manager, and `info: any` (`:68`) and the `as any` casts (`:307`, `:325`, `:359`) remain.
- **Regressions:** none.
- **Subscreens:**
  - Destructive confirmations: 8 → 8. Delete-old still reports no count.
  - Load-failed state (new, `:294-301`): 6.5. It is reachable only when something other than the directory read throws.
- **Still needed for 10/10:**
  1. Let `walk()` report read failures (`:65`) so that `loadFailed` actually triggers. Hide or mark the total on failure (`:280`).
  2. Reuse `services/cache/cacheManager` instead of the measure-and-delete `walk` (`:58-91`). Type `info` and remove the `as any` casts.
  3. Return and show the number of files removed by delete-old (`:221-238`).
  4. Use a token for `#FF9F43` (`:150`). Give the full-screen loading state (`:246-253`) a back control.
  5. Add an accessible label to the category rows (`:304-315`).

#### `app/cache-cleanup.tsx` — **7.5 → 8**
- **Scores now:** Function 8.5 · States 8 · UI 7.5 · A11y 7.5 · Security 9 · Code 8.5
- **Original items:**
  1. ✅ Category rows use the checkbox role with `checked` (`app/cache-cleanup.tsx:150`). Chips use the radio role with `checked` and labels (`:176`). The Switch (`:188`) and the Smart button (`:127`) are labelled.
  2. ✅ `load()` uses try/catch/finally with an error state and retry (`:49-63`, `:136-142`). The hero shows "…" while loading (`:122`).
  3. ❌ `dbCache` is still shown as a selectable 0 B row (`services/cache/cacheManager.ts:71`, rendered at `:145-156`).
  4. ◐ The Switch track uses tokens (`:188`). `'#fff'` remains (`:128`, `:177`, `:218`).
- **Regressions:** none.
- **Subscreens:**
  - Clear confirmation: 8.5 → 8.5.
  - Load-failed state (new, `:136-142`): 8.
- **Still needed for 10/10:**
  1. Hide `dbCache` or label it "not measured" (`services/cache/cacheManager.ts:71`).
  2. Raise the chips to a 44 dp target. They have only `paddingVertical: 5` (`:234`).
  3. Handle rejections from `setAutoCleanDays` and `setClearOnLogout` (`:104-105`).
  4. Replace `'#fff'` with an on-primary token (`:128`, `:177`, `:218`).

#### `app/offline-mode.tsx` (rewritten) — **3 → 8**
- **Scores now:** Function 8 · States 7.5 · UI 8 · A11y 8 · Security 8 · Code 8
- **Original items:**
  1. ✅ The fabricated data is gone. The screen reads the real outbox through `queueList('msg')` and the pure `summarizeOutbox` (`app/offline-mode.tsx:62-70`, `lib/outboxSummary.ts:34-47`, selftest passes). Counts refresh on queue events (`:81`). Only the old mock keys are removed (`:32`, `:83`).
  2. ✅ Retry calls the real `messageQueue.retry` and `flush` and claims no success (`:89-107`; APIs at `lib/messageQueue.ts:149`, `:268`, `:596`).
  3. ✅ The keyword wipe is replaced by a link to `/cache-cleanup` (`:212-225`).
  4. ✅ Tokens throughout. Roles and labels are on the back, retry and link controls (`:117`, `:153`, `:183-185`, `:216-217`).
  5. ✅ The dead branch and the duplicate `formatBytes` are gone (the file is 260 lines).
- **Regressions:** none. The fix log (P1 deferred #4) notes that rows sealed while the vault is locked may be undercounted. That is not verifiable statically.
- **Subscreens:**
  - Sync progress card: removed, n/a.
  - Clear-cache confirmation: removed, n/a.
  - Outbox card (new, `:144-194`): 8.
- **Still needed for 10/10:**
  1. Guard `loadOutbox`'s `setState` after unmount (`:62-70`, `:105`).
  2. After a retry, say what happened, for example "3 sent, 1 still failing", using the next summary (`:99-106`). List the failed messages with links to their chats.
  3. Replace `#FFFFFF` on primary with a token (`:187`, `:251`).
  4. Say "some messages could not be counted while locked" when the vault is locked (`:64`). Needs a device check.

#### `app/dashboard.tsx` — **6.5 → 7**
- **Scores now:** Function 6.5 · States 7 · UI 7 · A11y 7 · Security 7.5 · Code 7.5
- **Original items:**
  1. ✅ The loops are stopped on unmount (`app/dashboard.tsx:88-95`).
  2. ✅ OK, REVIEW and the score now use success, accent and danger (`:104`, `:166`).
  3. ❌ The REVIEW rows are still read-only (`:165-182`).
  4. ✅ There is a retry button (`:157-164`) and an in-flight guard (`:65-68`, `:80`).
  5. ❌ The only entry point is still notifications' nav bar (`app/notifications.tsx:26`), and NAV is still duplicated (`:16-22`). It still pushes on every tap (`:99`).
- **Regressions:** none.
- **Subscreens:** none.
- **Still needed for 10/10:**
  1. Make each REVIEW row actionable by deep-linking to sessions, devices, privacy and PIN (`:165-182`).
  2. Add a real entry point from Settings or Security, and share or replace the duplicated NAV (`:16-22`, `:99`).
  3. Disable the refresh button visibly while loading. Today it only dims (`:118`).
  4. Give the score ring an accessible summary, for example "Security score 67, fair" (`:122-135`).

#### `app/games.tsx` + boards/sheets — **7.5 → 7.5**
- **Scores now:** Function 8 · States 7 · UI 8 · A11y 7 · Security 8.5 · Code 7.5
- **Original items:**
  1. ✅ Join by code: links and invite lines name their game, and a bare code asks "Which game is this code for?" (`app/games.tsx:238-246`, `:384-396`, `lib/games/tableCode.ts:20-35`; selftest passes).
  2. ✅ The VoiceSheet copy now matches the SFU without E2EE (`components/games/feedback.tsx:444`, matching `lib/games/useTableVoice.ts:32-41`).
  3. ◐ Confirmations were added for Chess Resign (`components/games/Chess.tsx:691-695`), Rummy Drop on both entry points (`components/games/Rummy.tsx:441-445`, `:1048`, `:1166`) and History Clear (`components/games/HistorySheet.tsx:125-128`). The Rummy leave copy still contradicts the hub (`Rummy.tsx:1082` vs `app/games.tsx:120`).
  4. ❌ Quick-match cancel race, Searching retry, and refresh of "Your games" (`lib/games/useQuickMatch.ts` unchanged; `app/games.tsx:537-577`).
  5. ❌ Searching, BotOffer and the promotion picker are still not Modals, and hardware back is handled only when a board is open (`app/games.tsx:134`).
  6. ❌ Pieces are still announced as letters (`Chess.tsx:1345`), and the Rummy micro text is unchanged (`Rummy.tsx:2382`, `:2450`, `:2528`, `:2609`, `:2718`).
  7. ✅ `Square`'s memo now holds (`Chess.tsx:562`, `Square` calls `onPress(sq)`).
  8. ◐ The stale "no SFU" comment is fixed (`Rummy.tsx:347-348`). Not done: the duplicate `useReduceMotion` (`Rummy.tsx:1203`), the hard-coded host (`Rummy.tsx:1484`), RulesSheet's nested ScrollView, and `useAddBot` in TicTacToe.
- **Regressions:** none. The new code sheet uses `Sheet`, which is a `Modal` with `onRequestClose` (`components/games/feedback.tsx:201`), so back closes it.
- **Subscreens:**
  - ModeSheet: 8 → 8.
  - Searching: 6 → 6.
  - BotOffer: 7.5 → 7.5.
  - LeaderboardSheet: 8.5 → 8.5.
  - HistorySheet: 7 → 8.
  - InviteSheet: 7 → 7.
  - RulesSheet: 7 → 7.
  - VoiceSheet: 5.5 → 7.5.
  - "Which game" code sheet (new, `app/games.tsx:384-396`): 8.
  - Chess: 7 → 7.5.
    - Lobby: 7.5 → 7.5.
    - Connecting: 8 → 8.
    - Table settings: 8 → 8.
    - Players: 8 → 8.
    - Promotion picker: 6.5 → 6.5.
    - Draw-offer banner: 6 → 6.
  - Ludo: 7.5 → 7.5.
    - Lobby: 7.5 → 7.5.
    - Dice receipts: 8.5 → 8.5.
    - Emote: 7.5 → 7.5.
    - Settings: 6 → 6.
  - Rummy: 7 → 7.5.
    - Table list: 7.5 → 7.5.
    - Seat failed: 8 → 8.
    - Room / lobby: 7.5 → 7.5.
    - Pool & Deals: 7 → 7.
    - Result: 8 → 8.
    - Standings: 8 → 8.
    - Leave confirmation: 6 → 6.
    - Declare confirmation: 8.5 → 8.5.
    - Emote: 7.5 → 7.5.
    - Table settings: 7 → 8.
  - Tic-Tac-Toe: 7 → 7.
    - Lobby: 6.5 → 6.5.
- **Still needed for 10/10:**
  1. Fix the quick-match cancel race in `lib/games/useQuickMatch.ts`. Add Retry to Searching (`app/games.tsx:577`). Refresh "Your games" on focus and surface its failures (`lib/games/useLiveTables.ts`).
  2. Make Searching, BotOffer and PromoPicker Modals, or handle back for them (`app/games.tsx:134`, `:537`, `:652`; `Chess.tsx:1331-1345`).
  3. Make the Rummy leave copy consistent with the hub (`Rummy.tsx:1082` vs `app/games.tsx:120`).
  4. Accessibility: use piece names instead of letters (`Chess.tsx:1345`, plus the square labels at `:852`). Raise the Rummy micro text (`Rummy.tsx:2382`, `:2450`, `:2528`, `:2609`, `:2718`). Explain to a non-host why Start is disabled.
  5. Code health: remove the duplicate `useReduceMotion` (`Rummy.tsx:1203`) and centralise `games.corefinite.com` (`Rummy.tsx:1484`). Remove RulesSheet's nested ScrollView and duplicate close. Use `useAddBot` in TicTacToe.
  6. Drive the draw-offer banner from a protocol field instead of a toast regex.

---

### F — Media, Files & Documents — re-rating

Baseline: `ratings/F.md` at 18eb6d2. Current: HEAD f774ffa. Fix logs checked: `fixes/P4.md`, `fixes/H.md`. This is a static review. I read every screen file in full, or read its diff and then every changed or cited region in context (file-viewer: the diff plus each item's lines). I also read the changed helpers: `lib/mediaCacheGC.ts`, `lib/archive.ts`, `lib/shelfOpen.ts`, `lib/videoSeek.ts`, `lib/shelf.ts`, `lib/localDb.ts` (listAllAttachments), `components/status/GateChallenge.tsx`, `components/DocView.tsx`, `components/PdfView.tsx`, `components/chat/ViewerStack.tsx`, plus the reader and image-editor handoffs in `components/chat/MessageBubble.tsx:976-1003, :1600-1605` and `app/chat.tsx:2713-2723`.

Selftests re-run at HEAD, all exit 0: `lib/videoSeek` (11), `lib/shelfOpen` (13), `lib/archive`, `lib/permissionDeadEnd` (5, and the camera exemption is gone), `lib/a11yCoverage`, `lib/themeCoverage` (22), `lib/reader`. Nothing here is device-verified. Gesture, playback, ViewShot output and orientation fixes count only for what the code shows.

`app/slideshow.tsx` and `app/scanner.tsx` from the original batch no longer exist (`ls` fails). They are outside this batch's list and are not re-rated.

| Screen | Old | New | Δ |
|---|---|---|---|
| app/camera.tsx | 7.5 | 7.5 | 0 |
| app/media-viewer.tsx | 4.5 | 6 | +1.5 |
| app/media-gallery.tsx | 6 | 6 | 0 |
| app/image-editor.tsx | 4 | 5.5 | +1.5 |
| app/file-preview.tsx | 5 | 7 | +2 |
| app/file-viewer.tsx | 6.5 | 6.5 | 0 |
| app/video-player.tsx | 3.5 | 5.5 | +2 |
| app/reader.tsx | 7.5 | 8 | +0.5 |
| app/shelf.tsx | 6.5 | 8 | +1.5 |
| app/archive-viewer.tsx | 6.5 | 7.5 | +1 |
| app/docscanner.tsx | 5.5 | 6 | +0.5 |
| app/story-viewer.tsx | 6.5 | 7.5 | +1 |
| app/whiteboard.tsx | 4.5 | 5.5 | +1 |

---

#### `app/camera.tsx` — **7.5 → 7.5**
- **Scores now:** Function 8 · States 7 · UI 8 · A11y 8 · Security 7 · Code 7. Security went up from 6 because the permission dead end is fixed. The overall mean is 7.5, unchanged.
- **Original items:**
  - ✅ 1 Settings route out of a refused permission. The gate branches on `camPerm.canAskAgain`: "Allow camera" or "Open settings" via `Linking.openSettings()` (`app/camera.tsx:310-320`). AppState `active` re-reads the grant with `getCam()` (`:116-121`). A mic refusal that cannot ask again uses `permissionDenied` (`:167-170`). The exemption is removed from `lib/permissionDeadEnd.selftest.ts` (H #7), and that selftest passes.
  - ❌ 2 No confirm before discarding scanned pages. ✕ is `leave()` (`:354`), and the sheet scrim and "Add another page" only close the sheet (`:509-519`). There is no BackHandler or beforeRemove.
  - ❌ 3 The review sheet still has no page strip and no remove (`:505-560`). It shows only a count (`:514`).
  - ❌ 4 The 250 ms sleep is still there (`:198`).
  - ❌ 5 Raw `e?.message` is still shown (`:231`, `:256`).
- **Regressions:** none found.
- **Subscreens:** Permission gate 6 → 8 · Mode tabs 8.5 → 8.5 · Scan review sheet 7 → 7
- **Still needed for 10/10:**
  1. Guard leaving with `scanPages.length > 0`: confirm on ✕ (`app/camera.tsx:354`) and on hardware back / `beforeRemove`.
  2. Add a page strip with per-page remove to the review sheet (`:505-560`).
  3. Map ML Kit and PDF errors to user copy instead of `e.message` (`:231`, `:256`).
  4. Replace the 250 ms mode-switch sleep with waiting for the camera's ready/mode callback (`:198`).

#### `app/media-viewer.tsx` — **4.5 → 6**
- **Scores now:** Function 7 · States 6 · UI 4 · A11y 6 · Security 7 · Code 5
- **Original items:**
  - ✅ 1 The players are hoisted to module scope: `ImageViewer` `app/media-viewer.tsx:63`, `VideoPlayer` `:86`, `AudioPlayer` `:136`, `CodeViewer` `:179`. `source` is memoised (`:309-312`), so parent state changes no longer remount them.
  - ✅ 2 CodeViewer. It uses a dark `CODE` palette on a dark ScrollView (`:178`, `:209-220`). The download sends the bearer token, checks the status (`:190-195`), deletes the preview copy (`:201`) and shows an inline failure (`:219`).
  - ❌ 3 The video seek bar is still display-only Views (`:117-122`). The image still has tap-toggle zoom only, with no pinch or pan (`:67-75`), and the header still promises "zoom, pan" (`:2`).
  - ❌ 4 Hard-coded hex remains throughout: `:32`, `:160-170`, `:213-216`, `:463-488`, `:505-519`, `:576-604`. The audio, archive and generic cards are still light `#F9FAFB` on black (`:592`).
  - ◐ 5 Every header and card button now has a role and label (`:464`, `:467`, `:475`, `:484`, `:534-535`). The error text still has no Retry (`:541`).
  - ❌ 6 `Alert.alert('Error', e.message)` is still there (`:446`), as is the raw `e?.message` in share (`:419`). The helpers are still untyped (`:34`, `:45-46`).
- **Regressions:** the CodeViewer now sends the bearer token whenever `needsAuth` is set (`:192`), to whatever host `fileUri` names. That URI comes straight from route params (`:236`, `:297`), and `lib/pendingLink.ts:51-60` keeps the query string of `vaultchat://` links. The same unconditional pattern already existed for images/video (`:286`, `:310`) and Save (`:434-436`), so this widens an existing exposure rather than creating a new class. Compare `app/file-preview.tsx:170`, which restricts the token to `SERVER_URL`.
- **Subscreens:** ImageViewer 4 → 4.5 · VideoPlayer 4 → 5 · AudioPlayer 4.5 → 6 · CodeViewer 2.5 → 6.5 · ArchiveCard 5.5 → 6.5 · GenericViewer 5.5 → 6 · "Nothing to show" 7.5 → 7.5 · ProtectedMediaView wrapper 7.5 → 7.5
- **Still needed for 10/10:**
  1. Send the bearer token only when `fileUri` starts with `SERVER_URL`, as `app/file-preview.tsx:170` does (`:192`, `:286`, `:310`, `:434`).
  2. Make the video track seekable (`:117-122`). `lib/videoSeek.ts` already exists for this. Add pinch/pan to ImageViewer (`:67-75`).
  3. Move `ArchiveCard`/`GenericViewer` out of render (`:461`, `:473`). They are still new component types on every render.
  4. Use a dark-media token set instead of hex, and make the cards dark (`:32`, `:576-604`, inline styles `:463-488`).
  5. Give the error state a Retry (`:541`). Map `e.message` to user copy (`:419`, `:446`). Type `getFileType`/`formatSize`/`formatDur` (`:34`, `:45-46`).

#### `app/media-gallery.tsx` — **6 → 6**
- **Scores now:** Function 6 · States 6 · UI 7 · A11y 4 · Security 7 · Code 7. Security went up from 5. The mean is 6.17, which rounds to 6.
- **Original items:**
  - ✅ 1 View-once is excluded: `bucket()` skips `m.meta?.viewOnce` (`app/media-gallery.tsx:47-50`), and cached buckets are re-bucketed on paint (`:170-173`). This matches the `meta.viewOnce` shape used in `lib/localDb.ts:1104`.
  - ❌ 2 Video tiles still call `setViewer` (`:323`) and open in the image Modal (`:446-453`), so videos still cannot be played.
  - ❌ 3 There is no error or offline state. A catch with no cache keeps an empty list (`:219-221`), and the empty copy is "No photos shared yet" (`:429-433`). The page cap is not surfaced (`:38`, `:197`).
  - ❌ 4 Photo tiles (`:317`), file rows (`:330`) and link rows (`:341`) are unlabelled. Tabs have no role or state (`:393`), and the Back button has no role (`:384`).
  - ❌ 5 Unused `SW` (`:125`) and `#FFFFFF` (`:395`, `:476`) remain.
- **Regressions:** none found.
- **Subscreens:** Tabs 6 → 6 · Album grouping 6.5 → 6.5 · Full-screen photo Modal 4 → 4.5 (view-once no longer reaches it; video still can't play, `top: 54` still `:490`)
- **Still needed for 10/10:**
  1. Route video tiles to `/media-viewer` with `msgType: 'video'` (`app/media-gallery.tsx:323`).
  2. Add an error/offline state with Retry instead of the empty copy (`:219-221`, `:429-433`).
  3. Add roles, labels and selected state to tiles, rows, tabs, chips and Back (`:317`, `:330`, `:341`, `:384`, `:393`).
  4. Use safe-area insets for the Modal close button (`:490`). Add zoom and share to the photo Modal, or route it to media-viewer.
  5. Remove `SW` (`:125`). Replace `#FFFFFF` with a token (`:395`, `:476`).

#### `app/image-editor.tsx` — **4 → 5.5**
- **Scores now:** Function 5 · States 5 · UI 5 · A11y 6 · Security 6 · Code 5
- **Original items:**
  - ✅ 1 Draw colour and size are read from refs (`app/image-editor.tsx:96-99`, `:110`). Text drag uses the start position plus `g.dx`, with one responder per overlay held in a Map (`:218-243`).
  - ◐ 2 Brightness and contrast now reach the output: Done captures the ViewShot whenever they are non-zero (`:256-260`). Negative contrast is a grey wash (`:369`). Filters are still tint overlays, and "B&W" is still a 50% grey wash, not desaturation (`:186-194`). `applyFilter` is still effectively a no-op (`:179-183`). The approximation is documented with a `ponytail:` comment (`:362-366`).
  - ❌ 3 Crop is still centred and fixed-ratio only (`:164-165`), and "Free" still alerts "Choose a crop ratio first" (`:27`, `:145-148`).
  - ✅ 4 The editor leaves with `router.dismissTo` + `returnParams` (`:266-269`), and the caller passes `peerUid`/`peerName`/`returnTo` (`app/chat.tsx:2719-2722`).
  - ✅ 5 Done is disabled with busy state while processing (`:341-342`, `:247`), and Rotate is guarded (`:127`). Crop has no guard (`:144-149`).
  - ◐ 6 Tools, ratios, colours, sizes, filters and adjust steps have roles, labels and selected state (`:405-407`, `:431-432`, `:452-453`, `:463-464`, `:498-499`, `:509-510`, `:538-539`, `:559-560`, `:575-576`). The emoji glyphs are hidden from accessibility services (`:416`) but are still emoji (`:321-328`). The text input has no label (`:481-488`).
  - ❌ 7 `paddingTop: Platform.OS === 'ios' ? 56 : 40` is still used (`:602`), and the dead `rotation` state is still there (`:65`, `:136`).
- **Regressions:** none found. `setProcessing(false)` after `dismissTo` (`:273`) may run after unmount, which is harmless.
- **Subscreens:** Crop 3 → 3.5 · Draw 2.5 → 6 · Text 4 → 6.5 · Filter 3 → 4 · Adjust 2 → 5 · Processing overlay 6 → 6 (still `rgba(2,11,24,0.85)` `:648`) · Discard confirm 7 → 7 (still shown with no edits `:277-282`)
- **Still needed for 10/10:**
  1. Add a user-positioned crop rectangle and make "Free" work (`app/image-editor.tsx:144-176`, `:27`). Guard crop against re-entry.
  2. Apply real colour-matrix filters, brightness and contrast instead of washes (`:186-194`, `:356-372`; see the `ponytail:` note at `:362`).
  3. Draw strokes as connected paths instead of one View per segment (`:290-319`).
  4. Use safe-area insets for the top bar (`:602`). Theme the processing overlay (`:648`). Replace the emoji tool glyphs with Ionicons (`:321-328`).
  5. Label the text input (`:481`). Skip the discard prompt when nothing changed (`:277-282`). Remove `rotation` (`:65`, `:136`) and the no-op `applyFilter` (`:179-183`).

#### `app/file-preview.tsx` — **5 → 7**
- **Scores now:** Function 7 · States 8 · UI 7 · A11y 7 · Security 8 · Code 6
- **Original items:**
  - ✅ 1 Virtualised: a FlatList with no nested same-axis ScrollView (`app/file-preview.tsx:209-227`, `:291-293`). There is a 2 MB cap (`:18`, `:178-181`) and a too-large state that routes to `/file-viewer` (`:279-280`). Tokens are not memoised: `tokenize` runs in `renderItem` (`:221`).
  - ✅ 2 The bearer token goes only to `SERVER_URL` (`:170`). The status is checked (`:173`), and a `dead` cancel flag is set on unmount (`:156`, `:194`).
  - ✅ 3 There is an error state with Retry (`:265-285`).
  - ✅ 4 The `vt_preview_` copy is deleted in `finally` (`:169`, `:189`), and legacy `preview_` is swept (`lib/mediaCacheGC.ts:34`).
  - ◐ 5 Header buttons have role, label and state (`:239-250`). `tokenize`, `LANG_MAP` and `KEYWORDS` are still untyped (`:38`, `:51`, `:69`).
- **Regressions:** none found. The info bar shows "1 lines · 0.0 KB" during loading and failure (`:257-260`), which is cosmetic.
- **Subscreens:** none (unchanged).
- **Still needed for 10/10:**
  1. Type the tokenizer and maps (`app/file-preview.tsx:38`, `:51`, `:69`), and memoise tokens per line (`:221`).
  2. Wrap `shareFile` and `copyAll` in try/catch with user copy (`:197-204`).
  3. Hide or replace the info bar while loading or failed (`:257-260`). Replace `#4A9FFF22` and `#FFFFFF` with tokens (`:303`, `:315`).

#### `app/file-viewer.tsx` — **6.5 → 6.5**
- **Scores now:** Function 8 · States 8 · UI 5 · A11y 5 · Security 8 · Code 6. Security went up from 7. The mean is 6.67, which rounds to 6.5.
- **Original items:**
  - ❌ 1 The duplicate bottom "Open With..." bar still calls `handleShare` (`app/file-viewer.tsx:1350-1357`) next to the `openInDeviceApp` action bars.
  - ✅ 2 Temp copies are purged. Own downloads are `vt_view_`/`vt_doc_` and are deleted on unmount (`:403-412`, `:606`, `:636`). Hand-offs go to `vt_share_<ts>/` (`:414-418`, `:773`, `:820`) and are swept at boot and logout by `lib/mediaCacheGC.ts:30-43`, `:94`.
  - ❌ 3 The audio loader still has no auth, no unmount or stale guard, and still sets `staysActiveInBackground: true` (`:664-682`).
  - ❌ 4 The "Pinch to zoom" hint remains (`:975`), and there is still no pinch gesture.
  - ❌ 5 Both skip buttons are still "15s" (`:1215`, `:1233`).
  - ❌ 6 Fixed `Platform.OS` paddings remain (`:1377`, `:1398`, `:1517`), as do the `as any` casts (`:447`, `:498`, `:620`, `:649`). The file is now 1,539 lines.
  - ◐ 7 The filename regex is unified in `handoffPath` (`:417`). `handleShare` still swallows every error (`:827`).
- **Regressions:** none found.
- **Subscreens:** Image 5.5 → 5.5 · PDF/PdfView 7 → 7 · Office/DocView 8 → 8 · Text reader 8 → 8 · Audio 5.5 → 5.5 · Hand-off card 7 → 7 · Unknown type 5 → 5 · Error+Retry 7 → 7 · Loading 7 → 7 · Bottom "Open With..." bar 4 → 4
- **Still needed for 10/10:**
  1. Make the bottom bar call `openInDeviceApp`, or remove it (`app/file-viewer.tsx:1350-1357`).
  2. Audio: add auth headers, a `dead` guard and unload on late resolve, and drop `staysActiveInBackground` (`:664-682`).
  3. Give the skip buttons distinct labels and label the seek area (`:1215`, `:1233`). Add roles to Retry and Open (`renderDocument` Open button `:947-955`, onPress `:949`; also `:1017`).
  4. Remove the "Pinch to zoom" hint or implement it (`:975`).
  5. Make `handleShare` report failures (`:827`). Use insets instead of `Platform.OS` paddings (`:1377`, `:1398`, `:1517`).
  6. Split the renderers to shrink the 1,539-line file. Remove the `as any` casts (`:447`, `:498`, `:620`, `:649`).

#### `app/video-player.tsx` — **3.5 → 5.5**
- **Scores now:** Function 6 · States 6 · UI 5 · A11y 7 · Security 5 · Code 5
- **Original items:**
  - ✅ 1 Scrubbing: `seekToPosition` reads `durationRef` (`app/video-player.tsx:261-265`, refs updated `:229-230`). The PanResponder calls the stable callback and the latest hide timer via a ref, with terminate handling (`:351-372`). The maths is in `lib/videoSeek.ts` (selftest 11/11).
  - ✅ 2 `onError` and `status.error` set `loadError` (`:466`, `:225`), and an overlay offers Retry (remount via `key`) and Close (`:477-503`).
  - ✅ 3 An unmount cleanup restores `PORTRAIT_UP` (`:111-113`).
  - ✅ 4 The resume position is saved on pause and unmount only (`:98-108`). `resumeKey` falls back to `btoa(encodeURIComponent())` (`lib/videoSeek.ts:24-28`).
  - ◐ 5 Controls use a fixed `FG = '#FFFFFF'` (`:24`, `:682`), and every control has a role and label (`:536-628`). The seek bar is `adjustable` with increment and decrement (`:576-582`). The glyphs are still unicode text, not Ionicons (`:538`, `:544`, `:553`, `:560`, `:601`, `:626`).
  - ❌ 6 PiP is still fake. It mounts a second `<Video>` (`:385-393`), so playback restarts, and the mini ✕ stops the video and returns to the full player (`:404`). `Share.share({ url })` is still used for http (`:297-298`).
  - ❌ 7 `as any` `__getValue` (`:169`, `:185`), the unused `Dimensions` (`:7`) and the unused `SCREEN_W/H` in `useS` (`:41`) remain, and there is no ErrorBoundary (the default export is at `:47`).
- **Regressions:** none found. The PiP `<Video>` has no `onError` (`:385-393`), so a failure there spins with no exit. This is a gap, not new.
- **Subscreens:** Controls overlay 3.5 → 7 · PiP 2.5 → 3 (labelled `:396-406`; still restarts and still not real PiP) · "Nothing to play" 7 → 7 · Load-error overlay (new, `:477-503`) — 7.5
- **Still needed for 10/10:**
  1. Remove the fake PiP, or keep the same `<Video>` instance and make ✕ close the player (`app/video-player.tsx:381-411`).
  2. Wrap the screen in `ErrorBoundary` as the sibling viewers do.
  3. Use `expo-sharing` for http too (download first), not `Share.share({url})` (`:297-298`). Report share failures (`:303`).
  4. Replace the unicode glyph controls with Ionicons (`:538-626`). Use safe-area insets instead of `Platform.OS` paddings (`:709`, `:783`).
  5. Remove `__getValue` (track scale in a ref), the `Dimensions` import and the `useS` dimensions (`:7`, `:41`, `:169`, `:185`).

#### `app/reader.tsx` — **7.5 → 8**
- **Scores now:** Function 8 · States 8 · UI 8 · A11y 8 · Security 8 · Code 8
- **Original items:**
  - ✅ 1 It scrolls to the top on page change (`app/reader.tsx:74-75`, ref `:143`).
  - ✅ 2 `Seg` chips are `radio` with selected state (`:233`). Reset, Done and the scrim have role and label (`:175`, `:205`, `:208`).
  - n/a 3 `setReaderSettings` and `resetReaderSettings` cannot reject: they catch internally (`lib/readerSettings.ts:69-79`).
  - ◐ 4 There is now a "Nothing to read" state (`:133-140`). The unused `width` is still there (`:40`).
  - ✅ 5 The bubble passes `{chatId, id}` when the cached row is plaintext (`components/chat/MessageBubble.tsx:1000-1002`, `:1603-1605`). The Reader loads it via `getCachedMessagesByIds` (`app/reader.tsx:45-57`). The `text` param remains only as a fallback for unsent or still-encrypted rows (`MessageBubble.tsx:1002`).
- **Regressions:** none found. While the cache read is pending the body is blank, with no spinner (`:133`).
- **Subscreens:** Reader settings sheet 7 → 8.5 · Pages layout mode 6.5 → 8
- **Still needed for 10/10:**
  1. Add `accessibilityRole="button"` to the stepper −/+ (`app/reader.tsx:257`, `:259`).
  2. Show a spinner while `cached === null` (`:133`). Remove `width` (`:40`).
  3. Close the remaining plaintext-param fallback for self-decrypted rows by writing them to the cache first (`components/chat/MessageBubble.tsx:1002`, `:1605`).

#### `app/shelf.tsx` — **6.5 → 8**
- **Scores now:** Function 8 · States 8 · UI 8 · A11y 8 · Security 8 · Code 8
- **Original items:**
  - ✅ 1 Files open with `shelfOpenParams` (`app/shelf.tsx:110-115`), which carries `encrypted` and `isMine` (`lib/shelfOpen.ts:32-43`). `listAllAttachments` now returns `encrypted` and `viewOnce` (`lib/localDb.ts:1103-1104`).
  - ✅ 2 View-once rows are filtered out with `shelfListable` (`app/shelf.tsx:84`, `lib/shelfOpen.ts:26-28`).
  - ✅ 3 A failed cache read shows an error state with Retry (`app/shelf.tsx:90-93`, `:179-188`). Corrupt pins JSON is guarded (`:80`).
  - ✅ 4 Chips are `tab` with selected state and a count label (`:157-159`). Sort options are `radio` with selected state (`:169-171`). The row label carries name and size (`:208-210`), and the pin has selected state (`:221`).
- **Regressions:** none found.
- **Subscreens:** Kind chips + sort row 6 → 8.5
- **Still needed for 10/10:**
  1. Label the filter input (`app/shelf.tsx:132-139`), which has a placeholder only.
  2. Surface a failed pin write instead of `.catch(() => {})` (`:104`). A refocus failure with stale `files` is silent (`:179`).
  3. Note that view-once is filtered only at listing. A deep link straight to `/media-viewer` is governed by media-viewer (see that screen).

#### `app/archive-viewer.tsx` — **6.5 → 7.5**
- **Scores now:** Function 7 · States 8 · UI 8 · A11y 8 · Security 8 · Code 7
- **Original items:**
  - ✅ 1 Zip-bomb guard: a first `unzip` pass with a filter that records declared sizes and inflates nothing (`app/archive-viewer.tsx:95-98`), then `refuseDeclared` checks more than 256 MB declared or more than 20,000 entries (`:100-106`, `lib/archive.ts:142-150`).
  - ✅ 2 rar/7z/tar/gz/bz2/xz get an explicit "can't be opened here" state (`app/archive-viewer.tsx:54`, `:197-211`, `lib/archive.ts:154-160`). Its "Open in another app" lands on `/file-viewer` (`:207`). For these types that is the "Unknown type" card (`app/file-viewer.tsx:1245-1253`), which reaches the share sheet only through the bottom bar, so it is two steps.
  - ✅ 3 Entry errors appear as a dismissable banner above the list (`:150-153`, `:170-172`, `:225-233`), and load errors have Retry (`:214-222`).
  - ✅ 4 Downloads and extractions live in a per-visit `vt_arc_<ts>/` directory deleted on unmount (`:60-63`, `:79-82`, `:161`). The legacy `archive` dir is swept (`lib/mediaCacheGC.ts:35`).
  - ✅ 5 Row labels name folder or file and size, with busy state (`:248-252`). `Buffer` is imported (`:15`).
- **Regressions:** none found.
- **Subscreens:** Directory browser 7 → 8 · Error state 5 → 7.5 · Unsupported-format state (new, `:197-211`) — 7
- **Still needed for 10/10:**
  1. Inflate only the tapped entry (fflate `filter` per path) instead of decompressing every entry once the guard passes (`app/archive-viewer.tsx:108-110`). That is up to 256 MB held in JS (`lib/archive.ts:118`). Also cap the compressed size before the base64 read (`:88-89`).
  2. Make "Open in another app" go straight to the device hand-off rather than file-viewer's unknown-type card (`:207`; `app/file-viewer.tsx:1245-1253`).

#### `app/docscanner.tsx` — **5.5 → 6**
- **Scores now:** Function 7 · States 7 · UI 6 · A11y 6 · Security 5 · Code 6
- **Original items:**
  - ✅ 1 A run counter is bumped by Back/reset and unmount (`app/docscanner.tsx:80-81`, `:281`) and checked after each await. An abandoned PDF is deleted (`:136-137`, `:145`, `:158-161`, `:191`, `:205-208`).
  - ✅ 2 Delete is visible: a labelled trash button (`:367-369`) plus an a11y `delete` action on the row (`:346-349`).
  - ❌ 3 `pickPhoto('camera')` is still never called. Only `'gallery'` is used (`:110`, `:321`).
  - ❌ 4 Scans are still plaintext in `documentDirectory/VaultScans` (`:180`), and titles are in AsyncStorage (`:92`).
  - ❌ 5 It is still not merged with the camera SCAN pipeline.
  - ◐ 6 Type cards are `radio` with selected state, and the emoji is hidden (`:385-387`). The emoji is still in the title (`:303`).
- **Regressions:** none found.
- **Subscreens:** Step pick 6.5 → 7.5 · Step type 6 → 7 · Step processing 6 → 7.5 · Step preview 6.5 → 6.5 · Chat picker Modal 6.5 → 6.5 · Delete confirm 6 → 7
- **Still needed for 10/10:**
  1. Encrypt saved scans at rest, or document the limitation (`app/docscanner.tsx:180`, `:92`).
  2. Remove the dead camera branch of `pickPhoto` or wire it up (`:110`).
  3. Preview step: add roles to Share, Send and "Scan another", and a spinner on Send while `busy` (`:438-451`). The row's inner Send/Share are hidden inside the accessible row, and only Delete is exposed as an action (`:346-349`). Add Send and Share actions too.
  4. Chat picker: add a close button and roles on rows. Use insets for `paddingBottom: 28` (`:460-490`, `:528`).
  5. Merge with the camera SCAN to PDF path (`app/camera.tsx:249-258`, `lib/docs/pdf.ts`). Drop the emoji from the title (`:303`).

#### `app/story-viewer.tsx` — **6.5 → 7.5**
- **Scores now:** Function 8 · States 8 · UI 7 · A11y 7 · Security 8 · Code 6
- **Original items:**
  - ✅ 1 The tap zones are labelled "Previous story" and "Next story" (`app/story-viewer.tsx:495-510`). Segments are "Story i of n" with selected state (`:522-527`).
  - ✅ 2 The screen background is a fixed `#000` (`:629`), and the error text is white (`:654`). GateChallenge has a black stage (`components/status/GateChallenge.tsx:165`), its close button moved to the bottom (`:167`), and the input, Open and Unlock are labelled (`:121`, `:134`, `:148-150`).
  - ❌ 3 Video duration is still a fixed `VIDEO_DURATION_MS = 15_000` (`:56`).
  - ◐ 4 A viewers failure now shows inline copy with Retry (`:336-356`, `:578-584`). `topBar` and the caption still use fixed `top: 56` / `bottom: 40` (`:641`, `:651`).
  - ❌ 5 `(current as any).bgColor/.text` remains (`:426-427`).
- **Regressions:** none found. GateChallenge close at `bottom: 40` is not inset-aware (`GateChallenge.tsx:167`).
- **Subscreens:** GateChallenge 5 → 7.5 · Viewers sheet 5.5 → 7 (still no hardware-back handling; it is an in-tree overlay, not a Modal, `:572`) · Error/loading states 6 → 8 · Delete confirm 8 → 8 (raw `e?.message` `:374`)
- **Still needed for 10/10:**
  1. Drive video duration from the playback status (`app/story-viewer.tsx:56`).
  2. Use safe-area insets for the top bar, the caption and the gate close button (`:641`, `:651`; `GateChallenge.tsx:167`).
  3. Close the viewers sheet on hardware back (a Modal or BackHandler) (`:572`). Map the delete error to user copy (`:374`).
  4. Type `text`/`bgColor` on the story type instead of `as any` (`:426-427`, `:435`).

#### `app/whiteboard.tsx` — **4.5 → 5.5**
- **Scores now:** Function 4 · States 6 · UI 6 · A11y 7 · Security 6 · Code 4
- **Original items:**
  - ❌ 1 There is still no share in chat. `chatId` is never read, and Share opens the OS sheet (`app/whiteboard.tsx:97-110`), even though the header comment says "share in chat" (`:2`).
  - ❌ 2 It still renders one dot View per point (`:112-132`).
  - ✅ 3 Pen, eraser and clear, the colours and the brushes have roles, labels and selected state, with the emoji hidden (`:158-188`). Header Undo and Share are labelled (`:140-141`).
  - ◐ 4 A `beforeRemove` leave guard covers unshared strokes (`:84-95`), and failures show user copy (`:105`, `:108`). There is still no redo.
  - ❌ 5 `paths`/`currentPath` are still untyped `useState([])` (`:32-33`). `paddingBottom: 28` is fixed (`:199`).
- **Regressions:** none found.
- **Subscreens:** Toolbar 3 → 7.5 · Clear confirm 7 → 7 · Leave guard (new Alert, `:91-94`) — 7.5
- **Still needed for 10/10:**
  1. Return the PNG to the chat through the `capturedUri`/`returnParams` contract, as image-editor now does (`app/whiteboard.tsx:97-110`; `app/image-editor.tsx:266-269`).
  2. Render strokes as connected segments or an SVG path, and memoise committed paths (`:112-132`, `:150-151`).
  3. Type the path state (`:32-33`). Use insets for the toolbar (`:199`). Add redo.

---

### Shared components rendered by this batch (re-checked)
- `components/DocView.tsx` 8 → 8.5. "Show more rows" now has an explicit label (`:133`). Still needed: split sheets so the outer list can virtualise.
- `components/PdfView.tsx` 6.5 → 7. The cover text uses `c.textDim` (`:240`), and pages are labelled "Page n" (`:100`). There is still no zoom gesture, though the host claims one (`app/file-viewer.tsx:975`), and iOS still always falls back.
- `components/PdfThumbnailer.tsx` 6 → 6 (unchanged).
- `components/ProtectedMediaView.tsx` 7.5 → 7.5 (unchanged).
- `components/chat/ViewerStack.tsx` 6 → 7. Viewing-now sheet 5.5 → 7: the backdrop is labelled, the inner sheet is `accessible={false}`, and there is an explicit Close (`:53-61`). `paddingBottom: 28` is still fixed (`:94`).

---

### G1 — Family Circle — re-rating

| Screen | Old | New | Δ |
|---|---|---|---|
| `app/family.tsx` | 6 | 7 | +1 |
| `app/family-map.tsx` | 5.5 | 7 | +1.5 |
| `app/family-add.tsx` | 7 | 7.5 | +0.5 |
| `app/family-alerts.tsx` | 7.5 | 8 | +0.5 |
| `app/family-history.tsx` | 6 | 7.5 | +1.5 |
| `app/family-items.tsx` | 6 | 6.5 | +0.5 |
| `app/family-member.tsx` | 6.5 | 7 | +0.5 |
| `app/family-places.tsx` | 6.5 | 7.5 | +1 |
| `app/family-setup.tsx` | 6 | 7.5 | +1.5 |

**Method.** This is a static re-read against base `18eb6d2`, using `git diff 18eb6d2 HEAD`. The working tree is clean for these files.
- **Read in full:** all nine screens; the changed helpers `lib/family/circle.ts`, `lib/family/alerts.ts`, `lib/family/history.ts` + `historyOwners.selftest.ts` and `lib/items/api.ts`; the notification routing in `lib/push.ts:229-236` and `app/_layout.tsx:786-794`.
- **Untouched since base:** `components/family/*` has no diff, so the component findings from the original review still apply unchanged.
- **Checks I ran:**
  - `npx tsx lib/family/historyOwners.selftest.ts`: OK.
  - `lib/a11yCoverage.selftest.ts`: passes ("every icon-only button is labelled").
  - `lib/family/alerts.ts` self-check: OK.
  - `npx tsc --noEmit`: no errors in app/family*, lib/family or lib/items.
- **Not verified:** nothing was run on a device. Every layout, notification and navigation claim below is checked against the code only. Device behaviour is "not verifiable statically".

Cross-cutting notes, current state:
- **Notification taps are now routed, but only partly** (◐).
  - Foreground presses go to `/family-alerts` (`lib/push.ts:231-235`).
  - A cold start from a tapped alert does too (`app/_layout.tsx:792-794`).
  - A press while the app is only backgrounded goes to `notifee.onBackgroundEvent` in `lib/callBackground.ts:16`, which has no `family-alert` branch. The H log lists this as deferred.
- **No change:** the components still use RN `Text`, the map is light-only (`FamilyMap.tsx` unchanged), and no screen in the batch uses `lib/responsive`.
- **New finding that affects the privacy copy.** Presence uploads each point to `/chats/:id/locations` through `publishPoint` (`lib/family/presence.ts:426-434` → `lib/location/publisher.ts:104-106`). That body is plain `{ points: [{lat,lng,…}] }`. So the server receives family positions outside the sealed relay. This contradicts "Live locations are end-to-end encrypted" (`family-setup.tsx:69`) and the hub header "Positions stay E2EE end to end" (`family.tsx:7`). The original review did not raise it.

---

#### `app/family.tsx` — **6 → 7**
- **Scores now:** Function 8 · States 8 · UI 7 · A11y 6 · Security 8 · Code 4
- **Original items:**
  - ✅ **1. SOS before any permission prompt.**
    - `fireSos` now sends first, using the prompt-free `getLastKnownPositionAsync` (`:976-983`).
    - It then records the alert and calls `toggleShare(true)` (`:984-989`).
    - The alert tells the user honestly whether sharing is off (`:990-995`).
    - `toggleShare` returns a boolean (`:612`, `:662`, `:665`).
  - ✅ **2. Leave and delete report failure.**
    - `leaveCircle` rethrows unless the server answers 403/404 (`lib/family/circle.ts:95-97`).
    - `deleteCircle` counts failed removals and throws, keeping the circle (`circle.ts:113-128`).
    - `doLeave` and `doDelete` catch and alert (`family.tsx:1170-1171`, `:1181-1183`).
  - ✅ **3. Crash modal.** The "I'm OK" fill is solid `#15803D` with a label (`:2384-2387`). `onRequestClose` is a no-op (`:2362`).
  - ✅ **4. Hold-to-SOS with a screen reader.** It has a role, a hint, and `activate`/`longpress` actions that open a confirm and then `fireSos` (`:1821-1831`).
  - ◐ **5. Roles and labels.**
    - Done:
      - The quick tiles (`:1689`, `:1713`, `:1725`, `:1737`, `:1750`, `:1763`, `:1785`, `:1798`).
      - The section tiles (`:1669`).
      - All `mRow`s (`:2253-2349`).
      - Both Switches (`:1354`, `:2331`).
    - Still missing a role:
      - "New space" (`:1496`).
      - Status-card "View All" (`:1540`).
      - The map preview (`:1557`).
      - "+ Invite" (`:1960`).
      - Highlights "View All" (`:2087`).
      - The member row `Pressable` (`:1285`).
  - ❌ **6. Roster Retry.** A non-403/404 failure still only `console.warn`s (`:354-360`), and the card stays on "Loading members…" (`:1534`).
  - ❌ **7. Split the component.**
    - The file grew from 2465 to 2503 lines.
    - It still has 43 `as any`.
    - `currentPlan()` is still called four times per render (`:1372-1375`).
  - ❌ **8. Duplicated helpers.** `AVATAR_COLORS`/`colorFor` (`:82-83`) and `ago`/`dist` (`:94-101`) are still local copies.
- **Regressions:**
  - `<View accessibilityRole="button">` wraps the non-pressable High-speed alert row (`:2323`). It advertises a button that does nothing. Only the inner threshold chip and the Switch act.
  - After an SOS, up to three dialogs can stack. `toggleShare(true)` can raise "Location is turned off" (`:655-662`) or the background-location offer (`:664` → `:690`), followed straight away by the "SOS sent" alert (`:990`).
  - The SOS now sends the OS's cached fix with no age limit and no timestamp in the message (`:979-982`). That fix can be hours old and still reads as the current position.
- **Subscreens:**
  - Expanded map + roster sheet: 7 → 7. Unchanged: `maxHeight: 190` at `:1440`, and the map is light-only.
  - Space-type sections grid: 7 → 8. Role added at `:1669`.
  - Check-in sheet: 7 → 7.
    - Status tiles still have no role or selected state (`:2128-2140`).
    - The note still has no `maxLength` (`:2144`).
  - Announcement sheet: 8 → 8. The Post button still has no role (`:2192`).
  - Manage sheet: 6 → 7.
    - Fixed: roles, a labelled speed Switch, and `from: 'family'` on the setup row (`:2336`).
    - Remaining: two near-duplicate create rows (`:2265`, `:2336`), "Invite from contacts" is still ungated (`:2253`), and the new View role at `:2323`.
  - Crash-detected countdown: 5 → 8. AA fill and back no-op (`:2362`, `:2387`).
  - Member actions dialog: 6 → 6. Still long-press only (`:1287`), with no `accessibilityActions`.
- **Still needed for 10/10:**
  1. **Make the privacy copy match the code.** The header says "Positions stay E2EE end to end" (`:7`), but presence publishes plaintext points (`lib/family/presence.ts:426-434`). Fix the copy, or seal the points.
  2. **Add a roster error state with Retry.** Replace the endless "Loading members…" (`:354-360`, `:1534`). `components/spaces/LoadError.tsx` now exists and could be reused.
  3. **Make member management reachable without long-press.** Add `accessibilityRole="button"` and `accessibilityActions` (or a visible ⋯) to the member row (`:1285-1291`).
  4. **Finish the roles.**
     - Add a role to: `:1496`, `:1540`, `:1557`, `:1960`, `:2087`, the check-in tiles (with selected state, `:2128`), Send (`:2146`), I'm OK (`:2158`), Post (`:2192`), and the run, trip and driver cards (`:1855`, `:1884`, `:1895`, `:1929`).
     - Remove the role from the non-interactive View (`:2323`).
  5. **Tidy the SOS follow-ups.**
     - Bound the fix age (`getLastKnownPositionAsync({ maxAge })`), or add "as of HH:MM" to the message (`:979-982`).
     - Don't stack the permission alerts on top of "SOS sent" (`:989-995`).
  6. **Gate and deduplicate the manage rows.** Gate "Invite from contacts" on `canInvite` (`:2253`), and merge the two create rows (`:2265`, `:2336`).
  7. **Split the 2503-line component.** Candidates: the modals, `memberRow`, the distance block and the runs card. Compute `currentPlan()` once (`:1372-1375`), and cut the 43 `as any` casts.
  8. **Reuse shared helpers.** Use `formatMetres` instead of `dist` (`:101`), and share `colorFor`/`ago` with `family-member.tsx:39-52`.

---

#### `app/family-map.tsx` — **5.5 → 7**
- **Scores now:** Function 8 · States 7 · UI 7 · A11y 7 · Security 6 · Code 6
- **Original items:**
  - ◐ **1. Overlay collisions.**
    - The search bar is hidden while navigating (`:575`, `:830`).
    - The place chips are now a slot (`:582`, `:873`).
    - `topInset={slots.barsBottom}` is passed (`:825`).
    - The Routes and From-Home FABs hide while navigating or while the member sheet is open (`:971`, `:990`).
    - Remaining: the follow bar renders whenever `followId` is set (`:1066`), but its slot is only allocated when `!meetOpen` (`:570`, `:584`). With Meet Here open, it renders at `top: 0`. Visual result: not verifiable statically.
  - ✅ **2. `<Text onPress>` controls replaced.** A local `BarAction` (role, label, 14/8 hitSlop; `:1219-1232`) is used for END/LEAVE/JOIN, CLEAR, arrive-by, NAVIGATE, STOP NAV, STOP, Route and Follow (`:926-1166`). The clear control is its own labelled button (`:851-861`). The roster name text has a role (`:1137-1141`).
  - ◐ **3. Error states.**
    - Roster: a separate effect with `membersFailed` and RETRY (`:153-161`, `:1092-1097`).
    - `leaveTrip`/`joinTrip` are caught (`:699-705`).
    - Still uncaught: `Promise.all([getPlaces, getDefaultRef])` (`:250`).
  - ✅ **4. Confirm before a circle-wide trip** (`:672-684`). `endTrip` is now awaited inside try/catch (`:694-696`).
  - ❌ **5. Per-member routing egress.** It is unchanged (`:371-393`): every fresh member position goes to `fetchRoute` on each 250 m move.
  - ❌ **6. `thenEvent` and `mrCache`.**
    - `thenEvent` is still never passed (`:802-826` vs `NavigationLayer.tsx:44`).
    - The `mrCache` ref plus `mrVersion` state pairing remains (`:372-401`).
- **Regressions:** none found.
- **Subscreens:**
  - `FamilyMap` WebView engine: 7 → 7. Unchanged: light-only, `originWhitelist` `*`.
  - `MeetHereSheet`: 7 → 7.5. A trip now needs confirming at the screen level (`:675`). The component's own a11y and close-target issues remain.
  - `SelectedMemberSheet`: 7 → 8. The Routes FAB no longer overlaps it (`:971`).
  - `NavigationLayer`: 6 → 7. Fixed: topInset is passed, search is hidden, the FABs are hidden. Still open: `thenEvent`, and device verification.
  - Trip and Leave-now bars: 5 → 7.5. They use `BarAction`, and leave/join are caught (`:926-931`, `:949-959`, `:699-705`).
  - Route, turn and follow bars: 5 → 7. `BarAction` throughout (`:1037-1073`). The follow-bar slot issue is noted above.
  - Saved-place chips: 6 → 8. They are in the slot model (`:582`, `:872-873`).
  - Roster sheet: 6 → 7.5. Retry added (`:1092-1097`), and Route/Follow are real buttons (`:1153-1167`).
- **Still needed for 10/10:**
  1. **Cut the routing egress.** Either send one `/nav/matrix` call and draw shapes only on request, or disclose that every member's decrypted position goes to the routing server (`:371-393`).
  2. **Fix the follow bar.** Render it only when its slot exists (`followId && !meetOpen`; `:1066` vs `:570`).
  3. **Catch the places load** (`:250`).
  4. **Make the map theme-aware.** Use a dark basemap and a text alternative for markers (`components/family/FamilyMap.tsx:780`).
  5. **Fix the `MeetHereSheet` controls.** Add roles to the result rows and to Clear, and enlarge the close target (`MeetHereSheet.tsx:139`, `:159`, `:204-208`).
  6. **Deal with `thenEvent`.** Pass it or drop it (`NavigationLayer.tsx:44`). Collapse `mrCache`/`mrVersion` into one state map (`:372-401`).
  7. **Device-verify the slot model and nav overlay** (`openspec/changes/family-navigation/tasks.md:59-72`).

---

#### `app/family-add.tsx` — **7 → 7.5**
- **Scores now:** Function 8 · States 8 · UI 7 · A11y 8 · Security 6 · Code 8
- **Original items:**
  - ✅ **1. Rows are checkboxes.**
    - Each row has a checked/disabled state and a name label (`:163-165`).
    - The address-book row, the code row and the CTA have roles (`:210`, `:238`, `:246-247`).
  - ❌ **2. Bound the invite code.** `circleInviteCode` still mints `expiresInHours: 0, maxUses: 0` (`lib/family/circle.ts:57-60`). The share has no confirm (`:143-153`).
  - ❌ **3. Retry on the error bar.** It still only shows the message (`:216`).
  - ❌ **4. Shared space background.** It still uses `AuroraBackground` and `colors.bg` (`:189`, `:192`).
- **Regressions:** none.
- **Subscreens:** none.
- **Still needed for 10/10:**
  1. **Bound the code.** Use an expiring, limited-use invite code with a confirm before sharing (`circle.ts:58-59`, `family-add.tsx:143-149`).
  2. **Add a Retry to the error bar** (`:216`), and make it a polite live region.
  3. **Match the sibling family screens.** Use `SpaceGround`/`useSpaceGlass` (`:189`, `:192`).
  4. **Label the search input.** Give it an `accessibilityLabel`; it currently has only a placeholder (`:197-204`).

---

#### `app/family-alerts.tsx` — **7.5 → 8**
- **Scores now:** Function 8 · States 8 · UI 8 · A11y 8 · Security 8 · Code 9
- **Original items:**
  - ◐ **1. Route notification taps here.**
    - Foreground taps: `lib/push.ts:231-235`.
    - Cold start: `app/_layout.tsx:792-794`.
    - A press while the app is backgrounded is not handled: `lib/callBackground.ts:16` has no family-alert branch.
  - ✅ **2. Loading state.** `ready` plus a spinner before the empty copy (`:72-73`, `:137-139`).
  - ✅ **3. Rows readable to a screen reader.** Role, a label that includes "Unread.", and a hint (`:159-161`).
  - ✅ **4. System rows don't navigate.** `hasMember` disables them and gives them role `text` (`:154-162`). `'system'` is the actor id used in `lib/family/notify.ts:174`.
- **Regressions:** none. One minor edge: `loadAlerts` sets `loaded = true` before its await (`lib/family/alerts.ts:109-110`). If the hub's own load is still in flight, this screen's call returns early with the old list. `ready` can then flip before the store is read, so the empty-state flash is not fully closed.
- **Subscreens:**
  - Filter tabs: 8 → 8.
  - Clear-history confirm: 8 → 8. `clearCircleAlerts` is fire-and-forget (`:95`).
- **Still needed for 10/10:**
  1. **Route background taps.** Handle `family-alert` presses in `notifee.onBackgroundEvent` (`lib/callBackground.ts:16`) and open `/family-alerts` on resume.
  2. **Make `ready` wait for the store.** Have `loadAlerts` return the in-flight promise, not the early `alerts` (`lib/family/alerts.ts:108-119`).
  3. **Surface a failed clear.** Handle errors from `clearCircleAlerts` (`:95`).

---

#### `app/family-history.tsx` — **6 → 7.5**
- **Scores now:** Function 7 · States 8 · UI 8 · A11y 8 · Security 6 · Code 8
- **Original items:**
  - ✅ **1. No more merged tracks.** The circle-wide view shows one member at a time through `trackOwners` (`:144-148`; `lib/family/history.ts:241-250`). The picker is radio chips (`:245-259`), and stats, trips, path and trace use `samples` (`:151-181`). The selftest passes.
  - ✅ **2. Honest copy.** The header now states the `/nav/trace` upload (`:8-11`).
  - ❌ **3. Unknown permission still fails open.** `historyAccess(g) !== 'denied'` (`:107`). This is documented as deliberate (`:100-106`), but not changed.
  - ✅ **4. Focus loader handles failure.** It catches into `loadFailed` and shows a Retry (`:134-137`, `:223-233`).
  - ✅ **5. Trip rows and map are accessible.** Trip rows have a role, selected state and hint (`:309-315`). The map card has a summary label (`:261-265`).
  - ✅ **6. `formatMetres` reused** (`:40`).
- **Regressions:** none. One inconsistency: in the circle-wide view the timeline still lists every member's events (`:185`, `!userId || …`), while the picker shows one member's track.
- **Subscreens:**
  - Range tabs: 8 → 8.
  - Locked view: 8 → 8.
  - Trips list: 6 → 8.
  - **New** member picker (Tab, `:245-259`): 8. Radio role with selected state.
- **Still needed for 10/10:**
  1. **Follow the picker in the timeline.** Filter it by `shownId` (`:185`).
  2. **Decide unknown permissions.** Either treat `historyAccess === 'unknown'` as "fetch permissions first", or accept and record that it fails open (`:107`).
  3. **Make map-matching opt-in, or say so where it happens.** Today the disclosure is only a code comment (`:8-11`, `:161-172`).

---

#### `app/family-items.tsx` — **6 → 6.5**
- **Scores now:** Function 5 · States 7 · UI 6 · A11y 7 · Security 8 · Code 7
- **Original items:**
  - ✅ **1. The dead "Left-behind alerts" switch is removed.** A comment names the missing background scan (`:418-422`). `addItem` still writes `leftBehindAlerts: true` (`:217`), an unused flag.
  - ❌ **2. Other members' tags.** They are still never reported or listed. The sighting loop iterates only local `items` (`:191-197`), so "by family" (`:301`, `:308`) can only appear for the user's own tags heard on another device. The footer still promises member phones help find them (`:424-428`).
  - ✅ **3. No plaintext coordinates.** `reportSighting` always sends `lat:null, lng:null` (`lib/items/api.ts:68-78`). The call site sends only the place name (`:181-182`).
  - ◐ **4. Pairing panel and handlers.**
    - Done: `doPair` has a try/catch (`:214-222`), and `circleId` is in the deps (`:184`).
    - Still to do: pairing is still inline, not a Modal (`:385-416`); `doPair` has no busy guard; the remove handler's `removeItem` is unguarded (`:316-317`).
  - ✅ **5. Roles and labels.** Discovery cards have role and label (`:362-363`). Cancel and Save have roles (`:408`, `:411`). The Switch is gone.
- **Regressions:** none.
- **Subscreens:**
  - Nearby-devices list: 6 → 8.
  - Pairing panel: 5 → 6. It has roles and an error alert now, but is still inline with no busy guard.
  - Remove confirm: 7 → 7. The local removal is still uncaught (`:316-317`).
- **Still needed for 10/10:**
  1. **Make crowd-find real, or stop promising it.** Report sightings of shared tags this phone does not own, and list them. Otherwise rewrite the footer and the "by family" promise (`:191-197`, `:424-428`).
  2. **Move pairing into a `<Modal>` with `KeyboardSafe`** (`:385`). Add a busy guard to `doPair` (`:211`), and wrap `removeItem` in try/catch (`:316-317`).
  3. **Label the pairing name input** (`:388-394`), and drop the unused `leftBehindAlerts` write (`:217`).

---

#### `app/family-member.tsx` — **6.5 → 7**
- **Scores now:** Function 8 · States 7 · UI 7 · A11y 7 · Security 6 · Code 6
- **Original items:**
  - ✅ **1. `pull()` is wrapped.** A try/catch sets `pullFailed`, and a polite live-region notice shows (`:116-125`, `:362-366`).
  - ✅ **2. No Message/Call on your own row.** They are hidden when `userId === selfId` (`:421-422`).
  - ❌ **3. The `/nav/trace` POST is not throttled.** `trackKey` still changes with every sample, and the screen polls every 15 s (`:38`, `:211-229`).
  - ❌ **4. Unknown permission still allowed** (`:144`).
  - ❌ **5. Duplicated helpers.** They are still local (`:39-52`), and the guardian star is still unlabelled (`:376`).
- **Regressions:**
  - **A failed load now reads as a permission lock.** `mayViewHistory` starts `false` and is set only on a successful pull (`:77`, `:158`). If the first pull throws, `withheld` becomes true (`:189`). The screen then says "Location not shared with you" (`:379`) and shows the "This space does not share…" lock notice (`:407-416`) under the "Couldn't refresh" line. That states a false permission fact about the viewer.
  - In the same failure case, `selfId` stays null, so Message/Call reappear on your own row (`:421-422`).
- **Subscreens:**
  - Withheld/locked state: 8 → 7. It is now also shown for a load failure.
  - Relationship chips: 8 → 8.
  - Route-to-stale confirm: 8 → 8.
- **Still needed for 10/10:**
  1. **Keep failures and permissions apart.** Track "permission decided" separately from `mayViewHistory`, and show a load-error state rather than the lock notice when the pull fails (`:122`, `:189`, `:379`, `:407`). Resolve `selfId` independently of the pull (`:157`).
  2. **Throttle `/nav/trace`** (`:212-229`), for example once per N new samples or per minute.
  3. **Revisit the unknown-permission rule** (`:144`).
  4. **Share helpers and label the star.** Share `colorFor`/`ago`/`dist` with the hub (`:39-52`), and label the guardian star (`:376`).

---

#### `app/family-places.tsx` — **6.5 → 7.5**
- **Scores now:** Function 8 · States 8 · UI 8 · A11y 7 · Security 8 · Code 7
- **Original items:**
  - ◐ **1. Chips and rows.**
    - Done:
      - Radius chips (`:318`, `:455`), presets (`:471`) and lifetimes (`:517`) have role and selected state.
      - Day chips are checkboxes with full day names (`:495`).
      - Rows have a role, a label and a hint (`:391`).
      - Row Switches are labelled (`:414`).
    - Still missing a role: the edit-sheet Navigate, Unlock/Lock, "View live lock status", Save and Delete buttons (`:534-566`).
  - ✅ **2. Lifetime selection.** The `editLife` state marks the chosen chip within the edit (`:114`, `:514-518`). Reopening a timed zone shows no chip but does show "Stops on…" (`:525-529`).
  - ✅ **3. Persistence errors.** `persist` reverts, alerts and returns a boolean, and callers act only on success (`:144-155`, `:203`, `:220`, `:276-283`).
  - ✅ **4. Coordinate validation.** ±90/±180 range check (`:171-175`).
  - ✅ **5. Privacy copy.** The header notes the server geocoder (`:5-6`).
  - ✅ **6. Unused `Platform` import removed** (`:19-22`).
- **Regressions:** none. One minor issue: `remove` and `saveEdit` write the reference choice before `persist` (`:219`, `:272-275`), so a failed save leaves the ref changed.
- **Subscreens:**
  - Edit-place sheet: 6 → 8. All three original fixes are in. Its action buttons still lack roles.
  - Lock/unlock confirms: 8 → 8. `unlockLock` errors are still swallowed (`:257`).
  - Delete confirm: 8 → 8.
- **Still needed for 10/10:**
  1. **Roles on the edit-sheet buttons.** Add `accessibilityRole="button"` to them (`:534-566`), and labels to the inputs (`:301`, `:307`, `:441`, `:447`).
  2. **Order the reference write.** Update the reference only after `persist` succeeds (`:219`, `:272-275`). Surface failures from `armFamilyPlaceLock` and `unlockLock` (`:241`, `:257`).
  3. **Show existing lifetimes.** When reopening a timed zone, show its remaining lifetime as a chip state (`:514`).

---

#### `app/family-setup.tsx` — **6 → 7.5**
- **Scores now:** Function 7 · States 8 · UI 8 · A11y 9 · Security 6 · Code 7
- **Original items:**
  - ✅ **1. Created circles appear.**
    - `createCircle` creates with `{groupType:'family'}`, then calls `saveGroup` and `setActiveGroupId` (`lib/family/circle.ts:21-29`).
    - `joinCircle` calls `saveGroup` too (`circle.ts:35-55`).
    - Whether it shows in the hub on a device: not verifiable statically.
  - ✅ **2. Pending and already-member joins.** `JoinResult` carries both (`circle.ts:31`, `:37-41`). The screen says "Request sent" or "Already a member" (`:46-51`).
  - ✅ **3. No second hub.** The manage row passes `from: 'family'` (`family.tsx:2336`), and `done` uses `dismissTo` with `?groupId=` (`:25-29`). `dismissTo` behaviour on a device: not verifiable statically.
  - ◐ **4. Hero copy.** The routing-server caveat is added (`:69`). It still says "Live locations are end-to-end encrypted", while presence uploads plaintext points to `/chats/:id/locations` (`lib/family/presence.ts:426-434`; `lib/location/publisher.ts:104-106`).
  - ✅ **5. Roles and labels.** Create, Join and the other-group button have roles, labels and state (`:79`, `:87`, `:103`). Inputs are labelled (`:76`, `:100`). The `Platform` import is gone.
- **Regressions:** none.
- **Subscreens:** none (Alerts only).
- **Still needed for 10/10:**
  1. **Correct the E2EE claim** (`:69`), or seal the location-platform upload (`lib/family/presence.ts:434`).
  2. **Make the screen easier to find.** It is still reachable only from one manage-sheet row (`family.tsx:2336`). Offer it from the hub's zero-space path, or from group-create.
  3. **Device-verify** create → hub shows the circle, and the `dismissTo` return (`:27`).

---

### G2 — Location, Navigation & Safety — re-rating

Base 18eb6d2 → HEAD f774ffa. The working tree matches HEAD for every file in this batch: `git diff 18eb6d2` and `git diff 18eb6d2 HEAD` give identical stats.
Fix log: scratchpad/fixes/P5.md. Every claim in it was checked against the current code below.

| Screen | Old | New | Δ |
|---|---|---|---|
| `app/location.tsx` | 6.0 | 6.5 | +0.5 |
| `app/navigate.tsx` | 6.0 | 7.0 | +1.0 |
| `app/location-lock.tsx` | 5.5 | 6.5 | +1.0 |
| `app/lock-alert.tsx` | 6.0 | 6.5 | +0.5 |
| `app/lock-history.tsx` | 6.0 | 6.5 | +0.5 |
| `app/lock-settings.tsx` | 6.0 | 6.5 | +0.5 |
| `app/emergency-sos.tsx` | 4.5 | 6.5 | +2.0 |
| `app/trusted-contacts.tsx` | 6.0 | 7.0 | +1.0 |
| `app/aiguardian.tsx` | 7.0 | 7.5 | +0.5 |

Outside this batch: `app/location-sharing.tsx` and `app/current-location.tsx` (both in the original G2) no longer exist at HEAD. `git diff --stat 18eb6d2 HEAD` shows them deleted, 300 and 241 lines.

Evidence runs (read-only, at HEAD):
- `npx tsx lib/a11yCoverage.selftest.ts` → "every icon-only button is labelled"
- `lib/themeCoverage.selftest.ts` → "22 assertions passed, 20 documented exemptions"
- `lib/screenBackCoverage.selftest.ts` → "all screen-exit checks passed"
- `lib/responsiveCoverage.selftest.ts` → passed
- `lib/nav/navE2E.selftest.ts` → "navE2E: OK — 1540 assertions". It also prints an esbuild "Unexpected typeof" line from react-native/index.js.
- `lib/lock/lockHistoryUnits.selftest.ts` → OK
- `npx eslint` on the 9 screens → 0 errors, 1 warning (`navigate.tsx:92`, missing `params.name` dep)

Nothing here is device-verified. Every behaviour the fix log marks "needs device check" is scored only on what the code shows.

---

#### `app/location.tsx` — **6.0 → 6.5**
- **Scores now:** Function 7 · States 7 · UI 6 · A11y 7 · Security 7 · Code 6
- **Original items:**
  1. ✅ Double-tap guard on `startLive`: `startingRef`/`startingLive` plus a `watchRef` check (`location.tsx:83-86, 146-151`); the button is disabled and shows a spinner (`:313-318`). A watcher that resolves after unmount is removed and stop is emitted (`:196-199`).
  2. ✅ Copy now matches the behaviour: "stops if you leave this screen" (`:280, 322-325`). The behaviour itself is unchanged: unmount still calls `stopLive` (`:115`).
  3. ✅ Only the first update carries the address (`:181-185`); later fixes send none (`:193`).
  4. ❌ No GPS-error retry. The catch only alerts (`:109-110`), the address card keeps "Getting your location…" (`:62`), and LocationMap waits on "Waiting for a GPS fix…" (`components/LocationMap.tsx:197-203`).
  5. ✅ Duration chips are `radio` with `selected` (`:304-305`). Navigate here (`:265`), Stop (`:281`), Send (`:289`) and Start (`:314`) have roles. The denied face's "Open settings" and "Back" (`:220, 223`) still have no role.
  6. ◐ The `Platform` import is gone (`:20-23`). Still open: no `AuroraBackground` on the main face (only `:217`), the unused `back` style (`:337`), and `e: any` (`:129, 168, 200`).
  7. ✅ (n/a now) The duplicate `app/location-sharing.tsx` was deleted.
- **Regressions:** none functional. `beginLive` is a plain function re-created every render and captured through `startLive`'s `useCallback`, behind an `eslint-disable` (`:152-155`). The deps match what it reads, but the pattern is fragile.
- **Subscreens:**
  - Permission-denied state: 6 → 6. Still no re-check on AppState `active`, and its buttons have no roles (`:214-227`).
  - Live-sharing mode: 5 → 6. The copy is honest and the address is no longer stale, but the session still dies on leaving the screen (`:115`).
  - LocationMap: 8 → 8.5. "Try again" now has a role and label (`LocationMap.tsx:219`).
- **Still needed for 10/10:**
  1. Add a retry after a GPS failure (`location.tsx:109-110`), and a re-check of permission on AppState `active` for the denied face (`:214-227`).
  2. Move the live session into a service so it survives leaving the screen (`:115, 136-143`), or keep the current honest copy.
  3. Add roles to "Open settings" and "Back" on the denied face (`:220, 223`).
  4. Render `<AuroraBackground/>` on the main face (`:234`), delete the `back` style (`:337`), and replace `e: any` (`:129, 168, 200`).
  5. Replace the `beginLive` and `eslint-disable` arrangement with one `useCallback` (`:145-212`). Move the `liveCard` rgba colours to tokens (`:357`).

#### `app/navigate.tsx` — **6.0 → 7.0**
- **Scores now:** Function 8 · States 7 · UI 7 · A11y 6 · Security 7 · Code 6
- **Original items:**
  1. ✅ The chosen alternative is driven: `route: chosen` is passed (`navigate.tsx:138-139`), and the service uses it when given (`lib/nav/navigationService.ts:83-86, 275-277`). Needs a device check.
  2. ✅ The preview re-fetches on route options (`navigate.tsx:86`).
  3. ✅ "Custom" profile removed (`:24-29`), and a saved `custom` migrates to `standard` (`:60`).
  4. ✅ Suggestion race fixed with a `stale` flag (`:101-109`).
  5. ❌ Typed coordinates are still not range-checked (`:117-118`).
  6. ◐ `Chip` has a role and `selected` (`:153`); Find (`:234`), suggestions (`:239`), End (`:194`) and Start (`:319-320`) have roles. The NavBanner live region is not done: `components/nav/` is unchanged since base, and grep finds no `accessibilityLiveRegion` in NavBanner.tsx. The Location Lock entry row has no role (`:204`).
  7. ❌ Still hard-coded `#22C55E` (`:205-208`), suggestion keys by index (`:239`), and NavMap forced to light (`components/nav/NavMap.tsx:388`).
- **Regressions:** none. `JSON.stringify(s.routeOpts)` in the deps needs an `eslint-disable` (`:85-86`). It works, but a memoised key would be cleaner.
- **Subscreens:**
  - Setup mode: 6 → 7
  - Active navigation: 6 → 6.5 (End is labelled; the instruction is still duplicated in banner and sheet, `:181-183`)
  - Route alternative chips: 3 → 7 (driven end-to-end in code; not device-verified)
  - NavBanner: 6.5 → 6.5 (unchanged)
  - NavMap: 6.5 → 6.5 (unchanged: FABs have no role, light-only basemap, `RASTER_FALLBACK_URL = ''` at `lib/map/tileProvider.ts:56`)
- **Still needed for 10/10:**
  1. Range-check typed coordinates to ±90/±180 (`navigate.tsx:117-118`). `family-places` got this check in the same pass.
  2. Add `accessibilityLiveRegion="polite"` or an announcement to the NavBanner instruction (`components/nav/NavBanner.tsx:45`). Add `accessibilityRole` to the NavMap FAB and zoom buttons (`NavMap.tsx:431-447`).
  3. Pass the theme scheme to NavMap instead of `'light' as const` (`NavMap.tsx:388`), and show a notice when the Leaflet fallback has no basemap.
  4. Give the Location Lock entry a role and label (`navigate.tsx:204`). Replace `#22C55E` with `colors.success` (`:205-208`). Key suggestions by `lat,lng` (`:239`).
  5. Show the user a preview-route failure instead of failing silently (`:75`).

#### `app/location-lock.tsx` — **5.5 → 6.5**
- **Scores now:** Function 7 · States 6 · UI 7 · A11y 7 · Security 7 · Code 6
- **Original items:**
  1. ✅ The setup face sets `headerShown: true` (`location-lock.tsx:335`).
  2. ✅ The live "you" marker uses `lock.pos ?? myPos` (`:188-191`). `LockView.pos` is set on every accepted fix, on arm and on restore (`lib/lock/lockService.ts:59-61, 257, 321, 347`). Device check pending.
  3. ✅ `arm()` now catches failures and alerts "Could not lock" (`:164-168`).
  4. ✅ During grace the bar is a non-interactive `View` with an assertive live region and honest copy (`:226-231`). Only `alarming` renders the button (`:215-223`).
  5. ✅ Navigate-back failures now alert (`:178-182`). `/navigate` is still pushed before the result is known, so the alert lands over an empty setup screen.
  6. ❌ A denied permission on mount still returns silently (`:91-92`), and "Current location" still has no busy state (`:107-118`).
  7. ◐ `activeMapData` is memoised, so NavMap no longer gets a new object every second (`:188-191`). The 1 s ticker still re-renders the whole screen (`:101-105`).
  8. ◐ Chips (`:199`), modes (`:410`), saved places (`:372`), Current (`:339`), Drop-pin (`:343`), Find (`:360`), Test (`:463`) and History (`:476`) all have roles and state. Still open: `colors: any` (`:484`), the background-protection banner has no role (`:285`), the Lock button has no disabled or busy state (`:469-470`), and the custom-radius `TextInput` has no label (`:430-440`).
- **Regressions:** none.
- **Subscreens:**
  - Setup face: 5 → 7
  - Active face: 6 → 7
  - Background-protection Alert: 7 → 7
  - Battery Alert: 7 → 7
  - Unlock confirm: 8 → 8
  - NavMap: 6.5 → 6.5 (component unchanged)
- **Still needed for 10/10:**
  1. Show a "location permission needed" state with Open settings when permission is denied on mount (`:91-92`). Add a busy state to `useCurrent` (`:107-118`).
  2. Await `navigateBackToLock` before routing, or route to the lock screen on failure (`:178-182`).
  3. Move the ticker into a small `LockedFor` child so the whole screen doesn't re-render every second (`:101-105, 274`).
  4. Remaining a11y: background banner role (`:285`), Lock button `accessibilityState={{disabled, busy}}` (`:469`), label on the custom radius input (`:430`).
  5. Type `colors` as `Palette` (`:484`) and `icon` (`:36`). Move the alarm/grace/warning hex colours (`:219, 227, 234, 243, 304-311, 444-445`) into named tokens. Memoise the setup NavMap `data` literal (`:393`).
  6. Stop swallowing `restoreLock`, saved-places and mode-save failures with an empty catch (`:76, 87, 409`).

#### `app/lock-alert.tsx` — **6.0 → 6.5**
- **Scores now:** Function 7 · States 7 · UI 6 · A11y 6 · Security 7 · Code 7
- **Original items:**
  1. ✅ Copy per phase: grace, silenced, otherwise (`lock-alert.tsx:96-104`). It matches `alarmController.ts:146`.
  2. ✅ Navigate-back failures now alert (`:48-54`). `replace('/navigate')` still runs unconditionally.
  3. ◐ Roles on Done (`:67`), Stop Alarm (`:91`), NavBtns with labels (`:125`), and Back with `hitSlop` (`:114`). Two parts are still open:
     - `accessibilityLiveRegion="assertive"` sits on the static "ALERT!" text (`:79`). A live region announces changes, and this text never changes.
     - The flash still ignores reduced motion. `lib/useReducedMotion.ts` exists but is not used (`:34-42`).
  4. ❌ The palette is still hard-coded: `#7F1D1D`/`#DC2626` (`:46`), green safe colours (`:59, 61, 68`), `#DC2626` (`:92-93`), `#FECACA` (`:115, 137-141`). `icon: any` remains (`:121`).
- **Regressions:** none.
- **Subscreens:**
  - Alarm mode: 6 → 7
  - Safe mode: 7 → 7
- **Still needed for 10/10:**
  1. Gate the full-screen flash on `useReducedMotion()` (`:34-42`). This is a photosensitivity concern on a safety screen.
  2. Put the live region on the changing distance or phase text (`:84, 98`) rather than the static "ALERT!" (`:79`). Optionally call `AccessibilityInfo.announceForAccessibility` once when the screen mounts.
  3. Move the alarm palette into named constants or theme tokens (`:46, 59-68, 92, 115, 134-149`) and type `icon` (`:121`).
  4. Route only after `navigateBackToLock` resolves (`:51-53`).

#### `app/lock-history.tsx` — **6.0 → 6.5**
- **Scores now:** Function 7 · States 7 · UI 6 · A11y 6 · Security 7 · Code 7
- **Original items:**
  1. ✅ `load` state with a spinner, an error and Retry (`lock-history.tsx:60, 73-76, 194-209`). If a reload fails while sessions are already listed (after a filter change), the error is invisible, because `ListEmptyComponent` only renders for an empty list.
  2. ✅ Event distances go through `fmtDistance(e.distance, settings.units)` (`:246`). Pinned by `lib/lock/lockHistoryUnits.selftest.ts` (passes).
  3. ✅ Visible Delete control (`:276-280`). The card has role, `expanded`, hint and a `delete` accessibility action (`:211-218`). Chips have role and `selected` (`:117`).
  4. ❌ No pagination or "showing latest 100" notice (`lib/lock/lockStore.ts:188`).
  5. ◐ Clear-all, delete and note save now catch and alert (`:98, 108-109, 264-265`). The `max` is still recomputed inside the trend map (`:151`).
- **Regressions:** none. Pre-existing and still open: Save, Delete and the note `TextInput` are nested inside the accessible card `TouchableOpacity` (`:211-284`). On iOS an accessible parent groups its children, so VoiceOver may not reach the inner controls; the delete action covers only Delete. Not verifiable statically.
- **Subscreens:**
  - Export format Alert: 6 → 6 (still `catch {}`, `:89-90`)
  - Delete-all confirm: 7 → 8
  - Per-session delete: 5 → 8
  - Expanded timeline + note editor: 5 → 7 (no stale events, `:81`; save errors alert; no success feedback)
- **Still needed for 10/10:**
  1. Surface errors from the session-list reload even when the list is not empty, for example with a banner above the list (`:73-76`).
  2. Pull Save, Delete and the note input out of the accessible card, or set `accessible={false}` on the card and put the action on a header row (`:211-284`).
  3. Paginate, or say that only the latest 100 are shown (`lockStore.ts:188`).
  4. Alert on export failure (`:89-90`) and confirm a saved note (`:263-266`).
  5. Hoist `max` (`:151`). Move `EVENT_META` colours to tokens (`:37-45`). Type `icon: any` / `colors: any` (`:37, 291`).

#### `app/lock-settings.tsx` — **6.0 → 6.5**
- **Scores now:** Function 7 · States 5 · UI 7 · A11y 7 · Security 8 · Code 6
- **Original items:**
  1. ✅ The privacy copy names the routing engine, the search proxy and tiles.openfreemap.org (`lock-settings.tsx:222-228`). The spec now permits exactly these (`openspec/changes/location-lock/specs/location-lock/spec.md:146`).
  2. ✅ Background tracking shows off when no lock is active, with "(asked for when you lock)" (`:110-117`).
  3. ✅ Every Switch is labelled (`:55, 116, 191`), and Chips have role and `selected` (`:65`).
  4. ❌ Persistence failures are still swallowed with `.catch(() => {})` (`:43, 46, 118`). `as any` remains (`:56`), and so do the `'#999'` thumbs (`:58, 120, 194`).
  5. ✅ Version shown in About through `currentVersionName()` (`:220`).
- **Regressions:** none.
- **Subscreens:**
  - Custom sensitivity panel: 7 → 7.5
  - Repeat-interval chips: 7 → 7.5
  - Android battery-exemption row: 7 → 6.5. It has no `accessibilityRole` and errors are swallowed (`:124-131`). This was not called out before; it now stands out against the labelled rows around it.
- **Still needed for 10/10:**
  1. Tell the user when saving a setting, or enabling or disabling kill-safe, fails (`:43, 46, 118`). An alarm setting that silently doesn't stick is a safety gap.
  2. Give the battery-exemption row a role and label, and alert on failure (`:124-131`).
  3. Remove `as any` (`:56`) and use theme tokens for the thumbs (`:58, 120, 194`).
  4. Remove the emoji from the Test voice and Test vibration chip labels, or add `accessibilityLabel`s. These chips are actions, so `selected: false` (`:209-210`) is misleading.

#### `app/emergency-sos.tsx` — **4.5 → 6.5**
- **Scores now:** Function 7 · States 7 · UI 6 · A11y 7 · Security 6 · Code 6
- **Original items:**
  1. ✅ The `[sos-probe]` instrumentation is gone (grep finds no match). Whether the route opens on a device is not verifiable statically (fix log D1).
  2. ✅ The white→dark→white gradient is removed. Text uses `c.text`/`c.textDim` (`emergency-sos.tsx:423, 439, 448, 458, 467, 475, 487`), and amber text switches by scheme (`:434, 452`). `themeCoverage` passes.
  3. ✅ Header `paddingTop: 8` (`:421`). The screen is still in `INSET_SCREENS` (`app/_layout.tsx:213`).
  4. ✅ Shake detection uses `useFocusEffect`, keyed only on `shakeEnabled` (`:137-160`). It shares `startCountdown` through `shakeGate` (`:133, 151-154, 220`), and the duplicate trigger functions are gone. Device check pending.
  5. ◐ A load failure shows an error card with Retry (`:74, 112-124, 355-361`). But with no contacts loaded, `startCountdown` blocks the SOS with "No Contacts" (`:169-172`), although the server would send to all trusted contacts when no subset is given (`vaultchat-backend/routes/user.js:152-156`).
  6. ✅ Shows `res.contactsNotified` (`:209, 278`). The server sets `notified = recipients.length` whether or not any push token exists (`user.js:164-175`), so the number counts recipients, not delivered pushes.
  7. ✅ The SOS button has role, label, hint and activate/longpress actions (`:299-305`). The shake toggle is a `switch` with `checked` (`:328-330`), rows are `checkbox` with `checked` (`:375-377`), and the countdown is an assertive live region with a label (`:252-256`). Cancel, OK, Test and Retry have roles.
  8. ✅ `SOS_MESSAGE`/`TEST_MESSAGE` removed. State is typed `SosContact[]`/`SOSHistoryItem[]` (`:69, 84`). `countdownTimer` is still `useRef<any>` (`:89`).
- **Regressions (minor):**
  - Contacts now reload on every focus (`:127`), and each reload resets the selection to all contacts (`:119`). A deselection is lost after visiting any pushed screen, and the list blinks to a spinner on every return (`:113, 353`).
  - The shake gate is mutated during render (`:220`). It works, but it is an unusual pattern.
- **Subscreens:**
  - Default / SOS button: 4 → 7
  - Countdown: 6 → 7.5
  - Sending: 6 → 6
  - Sent: 5 → 7 (server count, and the no-location warning at `:280-284`)
  - Shake detection: 3 → 7 (focus-gated, one subscription; device check pending)
  - SOS contacts selector: 4 → 7 (checkbox semantics and error state; selection reset on refocus)
- **Still needed for 10/10:**
  1. Never block an SOS over the client selection. When contacts failed to load, or the list is empty but the server may have contacts, send with `contactIds` undefined and let the server fan out (`:169-172`; `user.js:152-156`).
  2. Keep the user's selection across focus reloads, and only replace the list once new data has loaded (`:113-123`).
  3. Have the server count actual push deliveries (`user.js:175`), or word the result as "N contacts alerted" only when tokens existed.
  4. Respect reduced motion for the pulse (`:100-109`). Make the back button at least 44pt or give it `hitSlop` (`:237, 422`).
  5. Move the hard-coded rgba borders and backgrounds to tokens (`:422, 431, 433, 440, 457, 470-473, 477, 484`). Type `countdownTimer` (`:89`). Surface a failed history load (`:128`).
  6. Confirm on a device that `/emergency-sos` opens (fix log D1). The deep link is `vaultchat://emergency-sos`.

#### `app/trusted-contacts.tsx` — **6.0 → 7.0**
- **Scores now:** Function 7 · States 7 · UI 7 · A11y 7 · Security 7 · Code 7
- **Original items:**
  1. ✅ Permanent entry points: the "Edit" link in SOS Contacts (`emergency-sos.tsx:342-351`), `app/notifications.tsx:166, 316`, and the privacy checklist route (`lib/privacyChecklist.ts:50`).
  2. ✅ The false new-device claim is gone (`trusted-contacts.tsx:3-5, 103-105, 176-178`). The new copy matches the server push, which adds a Maps link when coordinates exist (`vaultchat-backend/routes/user.js:168-171`).
  3. ✅ Remove is labelled with the name (`:128-129`), the online dot is labelled (`:124-127`), and Add (`:144`) and Add-confirm (`:164-165`) have roles. Cancel has no role (`:169`).
  4. ◐ All `@` are stripped (`:58`), but the format is still not validated. `lib/vaultIdLink.ts:10` already defines a `VAULT_ID_RE` (module-private, so it would need exporting) that could be reused.
- **Regressions:** none.
- **Subscreens:**
  - Add-by-VaultID form: 6 → 7
  - Remove confirm: 8 → 8
- **Still needed for 10/10:**
  1. Export the existing `VAULT_ID_RE` (`lib/vaultIdLink.ts:10`) and validate the VaultID against it before calling `addTrustedContact` (`trusted-contacts.tsx:57-59`), with inline feedback.
  2. Write the cache after add and remove (`:64, 79`), so a cold reopen doesn't briefly show stale contacts (`:51-52`).
  3. Add a role to Cancel (`:169`) and a label to the VaultID input (`:155-163`).
  4. Move the `removeBtn` rgba colours to danger tokens (`:201`).

#### `app/aiguardian.tsx` — **7.0 → 7.5**
- **Scores now:** Function 8 · States 7 · UI 8 · A11y 7 · Security 8 · Code 8
- **Original items:**
  1. ✅ `load()` catches internally (`aiguardian.tsx:47-52`), so focus and `finally` can no longer reject. A failed read is silent, and the last view stays.
  2. ✅ The ring has one label, "Risk N of 100, band" (`:96-99`). Run scan has role and busy/disabled state (`:109-110`). The log link has a role (`:172`).
  3. ❌ Severity colours are still hard-coded `#EF4444`/`#F59E0B` (`:126`).
- **Regressions:** none.
- **Subscreens:**
  - Scan-result Alert: 7 → 7
  - Checks list: 8 → 8
- **Still needed for 10/10:**
  1. Show a small "couldn't read the last scan" notice when `getCurrentSnapshot` fails, instead of keeping a stale view (`:51`).
  2. Move the severity colours into the view model next to `statusColor` (`:126`).
  3. Give the section titles `accessibilityRole="header"` (`:118, 138, 162`). Give the status pill a combined row label so it isn't read as a separate fragment (`:147-153`).

---

### H — Spaces (Operations) — re-rating

Base 18eb6d2 → HEAD (fixes in `fed4e6e` P6, plus root mount `a671cd9`). This is a static review only. Nothing here is device-verified or deployed. Ring/message delivery, map rendering, geocoding and every server-side behaviour are **not verifiable statically**.

Shared evidence:
- New `components/spaces/LoadError.tsx:14-43` is an error card with a 44pt "Try again" button (`:32-40`, `minHeight: 44` at `:51`) and `accessibilityRole="alert"` (`:23`). Most screens now render it instead of their empty state.
- The device agent is mounted app-wide (`app/_layout.tsx:44`, `:231`).
- Selftests run now, all passing: `lib/spaces/runPlan.selftest.ts`, `lib/spaces/deviceCommands.selftest.ts`, `lib/spaces/shift.selftest.ts`, `lib/spaces/runHeartbeat.selftest.ts`, `lib/a11yCoverage.selftest.ts`, `lib/themeCoverage.selftest.ts`, `lib/screenBackCoverage.selftest.ts`.
- Still true on most screens: `AuroraBackground` is mounted only in the loading branch. In the loaded views of attendance (`:144`), checkin (`:158`), devices (`:210`), incidents (`:127`), ops-map (`:212`), overview, pending (`:83`), roster (`:134`), run (`:196`) and visitors (`:139`) it is absent. Admin (`:150`), run-driver (`:409`), runs-admin (`:356`) and tasks do mount it.

| Screen | Old | New | Δ |
|---|---|---|---|
| app/space-admin.tsx | 6 | 7 | +1 |
| app/space-attendance.tsx | 5 | 5 | 0 |
| app/space-checkin.tsx | 5.5 | 6.5 | +1 |
| app/space-devices.tsx | 4.5 | 6 | +1.5 |
| app/space-incidents.tsx | 5.5 | 7 | +1.5 |
| app/space-ops-map.tsx | 5.5 | 6.5 | +1 |
| app/space-overview.tsx | 6 | 6.5 | +0.5 |
| app/space-pending.tsx | 5.5 | 7 | +1.5 |
| app/space-people.tsx | 6 | 7 | +1 |
| app/space-roster.tsx | 6 | 7 | +1 |
| app/space-run-driver.tsx | 5 | 6.5 | +1.5 |
| app/space-run.tsx | 6 | 6.5 | +0.5 |
| app/space-runs-admin.tsx | 4.5 | 6.5 | +2 |
| app/space-tasks.tsx | 6 | 7 | +1 |
| app/space-transport.tsx | 6.5 | 6.5 | 0 |
| app/space-visitors.tsx | 5.5 | 6.5 | +1 |
| app/space-leave.tsx | 6 | 6 (unchanged, skipped) | 0 |

---

#### `app/space-admin.tsx` — **6 → 7**
- **Scores now:** Function 8 · States 7 · UI 7 · A11y 7 · Security 7 · Code 6
- **Original items:**
  - ✅ 1. A failed load is reported by name with retry (`app/space-admin.tsx:105-111`, `:190-192`). Pull-to-refresh is added (`:153`). The empty tiles card is hidden on error (`:209`).
  - ✅ 2. Entry rows have `accessibilityRole="button"` and a label that includes the badge (`:233-234`). The SOS banner has a role and label (`:180-181`) and now forwards `perms` (`:179`).
  - ❌ 3. Still one `getRun` per run (`:116-119`), now run in parallel but still N+1. `getOpsSummary` is not used.
  - ◐ 4. Links and Shift entries are added (`:62-63`), backed by `components/spaces/SpaceLinksSheet.tsx` and `components/spaces/ShiftSheet.tsx`. Leave and Tasks entries are still missing from `ENTRIES` (`:55-71`). There is still no UI for duty state, leave allowance or device rename (fix log D1).
  - ❌ 5. `as any` is still used (`:179`, `:236`).
- **Regressions:**
  - If `getLinks` fails, the error goes to the console's own `loadError` (`:129`), which sits behind the full-screen links modal. The sheet then shows "No links yet." (`components/spaces/SpaceLinksSheet.tsx:284`), which is a false empty.
  - The next `load()` also clears that error (`:111`).
- **Subscreens:**
  - Emergency banner: 6 → 7. It now has a role and label, but still uses hard-coded `#fff` (`:183`, `:295`).
  - Derived run tiles: 6 → 7. Errors are now separate from "Nothing running yet" (`:209`).
  - Chat door: 8 → 8.
  - **New** Shift sheet (Modal, `components/spaces/ShiftSheet.tsx:65-101`): **6.5**. It validates input (`lib/spaces/shift.ts:360-382`) and handles the keyboard and busy state. However, it pre-fills only from what this device last saved (`:25-35`), because the server has no read for the shift. The Cancel button has no label (`:86`).
  - **New** Links sheet (full-screen Modal, `components/spaces/SpaceLinksSheet.tsx:216-304`): **7**. It has insets (`:218`), radio roles (`:261`), a confirmed remove (`:183-201`) and blocks self-links (`:273`). A failed link read shows as "No links yet." (see Regressions). The picker silently caps the list at 100 (`:166`).
- **Still needed for 10/10:**
  1. Keep link-load failures inside the sheet: pass an error or retry into `SpaceLinksSheet` instead of `setLinks([])` (`app/space-admin.tsx:129`).
  2. Add Leave and Tasks entries to `ENTRIES` (`:55-71`), plus editors for leave allowance and duty state (fix log D1).
  3. Replace the per-run `getRun` with one summary call (`:116-119`).
  4. Remove `as any` (`:179`, `:236`), and replace `#fff` with an on-danger token (`:183`, `:295`).
  5. Replace the device-local shift read with a server read once one exists (`lib/spaces/shift.ts:338-341`).

#### `app/space-attendance.tsx` — **5 → 5**
- **Scores now:** Function 5 · States 6 · UI 5 · A11y 3 · Security 7 · Code 5
- **Original items:**
  - ◐ 1. A shift can now be set (Admin → ShiftSheet). This screen falls back to the copy this device last saved (`app/space-attendance.tsx:79-82`, `lib/spaces/shift.ts:389-395`), so another admin's shift or a new device yields "No shift set" (`:159-167`). There is still no server read.
  - ◐ 2. An outer error card is added (`:112-115`, `:147`). Tracks are still fetched one member at a time inside a loop (`:93-94`), and each track failure is still caught to `[]` (`:94`).
  - ❌ 3. The zone is still `places[0]` (`:87`).
  - ❌ 4. No Aurora in the loaded view (`:144`). Rows have no role or expanded state (`:181-185`). Week dots are still colour only, with a weekday label but no state text (`:205-208`).
- **Regressions:** none.
- **Subscreens:** Per-member week disclosure: 5 → 5 (unchanged).
- **Still needed for 10/10:**
  1. Read the shift from the server once it is exposed (`lib/spaces/shift.ts:338-341`).
  2. Fetch tracks with `Promise.all` (`app/space-attendance.tsx:93-94`), and show members whose track failed as "could not load", not as no data.
  3. Add a zone picker (`:87`).
  4. Add `accessibilityRole="button"` and `accessibilityState={{expanded}}` to rows (`:181`), and a state label for each dot (`:206`).
  5. Mount Aurora in the loaded view and add pull-to-refresh (`:144`).

#### `app/space-checkin.tsx` — **5.5 → 6.5**
- **Scores now:** Function 7 · States 6 · UI 6 · A11y 6 · Security 7 · Code 6
- **Original items:**
  - ✅ 1. Labels now read "Reject/Approve leave for <name>" with 44pt targets (`app/space-checkin.tsx:231`, `:234`, `:325`).
  - ◐ 2. An error card replaces the false empty states (`:79-83`, `:161-166`, `:206`). There is no pull-to-refresh (`:158`).
  - ❌ 3. `today()` still uses `toISOString()`, which gives the UTC date (`:311`).
  - ✅ 4. Reject and Withdraw are confirmed (`:132-143`).
  - ❌ 5. The leave UI is still duplicated, with different kinds from `space-leave` (`:36-41`).
  - ◐ 6. Roles were added to Check in/out (`:183`, `:187`), Request (`:201`), the kind radios (`:283`) and the modal buttons (`:296`, `:299`). No Aurora in the loaded view (`:158`).
- **Regressions:** none.
- **Subscreens:** Request-leave modal: 5.5 → 6. It has radio roles now, but dates are still free text with UTC defaults, and the date inputs have no `accessibilityLabel` (`:291-292`).
- **Still needed for 10/10:**
  1. Build `today()` from local date parts and use a date picker (`:311`, `:291-292`).
  2. Replace the in-screen leave list with a link to `/space-leave` (`:197-242`).
  3. Add pull-to-refresh and Aurora to the loaded view (`:158`).
  4. Give "Request" and "Withdraw" 44pt targets (`:201`, `:222`), and label the date inputs (`:291-292`).

#### `app/space-devices.tsx` — **4.5 → 6**
- **Scores now:** Function 6 · States 6 · UI 6 · A11y 6 · Security 7 · Code 6
- **Original items:**
  - ◐ 1. A device-side agent now exists.
    - It sends a heartbeat, polls commands, and acks delivered → executed for `ring` and `message`. Every other action is acked as failed (`lib/spaces/deviceAgent.ts:63-113`, `lib/spaces/deviceCommands.ts:169-183`).
    - It is mounted at the root (`app/_layout.tsx:231`), and the server's ack and heartbeat routes are wired (`lib/spaces/api.ts:345-356`).
    - It works only in the foreground (`lib/spaces/deviceAgent.ts:16-18`), and only on a phone that bound itself (`app/space-devices.tsx:127-129`, `:324-340`).
    - Lock, photo and wipe are still not implemented. They are now shown disabled with "Needs device admin — not available yet" (`:59-65`, `:341-358`).
    - Ring and message behaviour on a device is **not verifiable statically**.
  - n/a 2. Lock and Capture photo can no longer be sent (`supported` is unset, so they are disabled at `:346`). Wipe is also unsupported, so its confirmation (`:182-193`) cannot currently be reached.
  - ◐ 3. The modal now uses safe-area insets (`:289`, `:296`) and has an opaque ground (`:288`). No Aurora in the loaded view (`:210`).
  - ◐ 4. Archive is added via `updateDevice` with a destructive confirmation (`:144-163`, `:379-387`). There is no rename.
  - ✅ 5. Device rows (`:245-246`), action rows (`:347-349`) and kind chips (`:420`) have roles and state.
- **Regressions:**
  - The copy now mixes "VaultChat" (`:173`, `:335`, `:460`) with the older "crazzychat" (`:233`, `:315`, `:436`).
  - A failed history or commands fetch shows "Nothing recorded yet." (`:109-110`, `:392`).
- **Subscreens:**
  - Device detail: 4 → 6. It has insets, an opaque ground and an honest supported/unsupported split. The Close button has no 44pt target (`:290`).
  - Add-device modal: 6.5 → 7. It has radio state and a "this phone" checkbox (`:420`, `:429`). Cancel and Add have no role (`:441`, `:444`).
  - Show-a-message modal: 4 → 6. Messages are now delivered by the agent (`lib/spaces/deviceAgent.ts:79-82`). Cancel and Send have no role, and Send has no busy indicator (`:464-471`).
- **Still needed for 10/10:**
  1. Confirm ring and message delivery on a real device, and consider a background fetch so a phone in a pocket collects commands (`lib/spaces/deviceAgent.ts:16-18`).
  2. Show an error, not "Nothing recorded yet", when the detail fetches fail (`app/space-devices.tsx:109-110`, `:392`).
  3. Add rename via `updateDevice` (`:154` already uses it for archive).
  4. Add roles to the modal buttons (`:441`, `:444`, `:464`, `:467`) and a 44pt Close target (`:290`). Unify the product name (`:233`, `:315`, `:436`). Mount Aurora in the loaded view (`:210`).

#### `app/space-incidents.tsx` — **5.5 → 7**
- **Scores now:** Function 7 · States 8 · UI 6 · A11y 7 · Security 7 · Code 7
- **Original items:**
  - ✅ 1. Acknowledge and Resolve are gated on `view_space_ops` (`app/space-incidents.tsx:50`, `:177`). Tiles pass `perms` (`app/family.tsx:1666`).
  - ✅ 2. Resolve is confirmed (`:105-111`).
  - ✅ 3. Error card with retry (`:133-136`) and pull-to-refresh (`:129`).
  - ❌ 4. `Incident.mediaRef` is still not rendered anywhere in the file.
  - ◐ 5. Role and label on the actions (`:184-185`, `:194-195`). No Aurora in the loaded view (`:127`).
- **Regressions:** none.
- **Subscreens:** none.
- **Still needed for 10/10:**
  1. Render incident media (`Incident.mediaRef`), as the spec requires (`openspec/changes/spaces-operations/specs/space-ops-comms/spec.md:40-47`).
  2. Make the action buttons at least 44pt tall (`btn` uses `paddingVertical: 11`, `:238`) and mount Aurora in the loaded view (`:127`).
  3. Make the Resolve confirmation destructive-styled or explain that it is irreversible (`:110`).

#### `app/space-ops-map.tsx` — **5.5 → 6.5**
- **Scores now:** Function 7 · States 7 · UI 5 · A11y 6 · Security 7 · Code 6
- **Original items:**
  - ❌ 1. `setInstruction('')` still runs before failures are reported, and there is no "retry the rest" (`app/space-ops-map.tsx:181-186`).
  - ✅ 2. A visible chevron button (`:347-352`, 44pt at `:380`) and an "Open run" `accessibilityActions` entry (`:325-326`). The chevron is nested inside an accessible parent touchable, so it may not be separately focusable for a screen reader. The action covers that case.
  - ❌ 3. The composer is still not in `KeyboardSafe` (`:270-302`).
  - ✅ 4. The emergency toggle is a `switch` with checked state (`:253-255`). Rows have a role and selected state (`:321-322`).
  - ❌ 5. `#F59E0B18` is still hard-coded (`:386`). No Aurora in the loaded view (`:212`).
  - ❌ 6. Subscriptions are still awaited one after another (`:94-108`).
- **Regressions:** none. The error card was added (`:68-71`, `:304-307`).
- **Subscreens:**
  - FamilyMap: 6 → 6.
  - Emergency mode: 5.5 → 6. It has a role and state now, but there is still no confirmation before an all-runs send (`:165-197`).
  - Instruction composer: 5 → 5. It is unchanged, and its TextInput has no `accessibilityLabel` (`:278-285`).
- **Still needed for 10/10:**
  1. On partial failure, keep the text and the failed run ids, and offer "Retry the rest" (`:177-186`).
  2. Wrap the composer in `KeyboardSafe` (`:270`), and confirm before an emergency broadcast (`:170`).
  3. Subscribe to runs in parallel (`:94-108`).
  4. Replace `#F59E0B18` with `c.warning + '18'` (`:386`), mount Aurora (`:212`), and label the input (`:278`).

#### `app/space-overview.tsx` — **6 → 6.5**
- **Scores now:** Function 7 · States 7 · UI 6 · A11y 5 · Security 7 · Code 6
- **Original items:**
  - ◐ 1. `go()` now passes `canManage` (`app/space-overview.tsx:110-111`). The shortcuts (Runs, Roster, Visitors) and the "Create Task" action are still drawn for everyone (`:395-408`, `:387`).
  - ❌ 2. `isSchool` still uses exact string equality (`:79-82`).
  - ✅ 3. `LoadError` with retry (`:139-141`).
  - ◐ 4. `accessibilityRole="button"` is on every touchable (for example `:146`, `:231`, `:330`, `:407`, `:469`). Donut still has no `accessibilityLabel` (`components/spaces/Donut.tsx:53-61`).
  - ❌ 5. Metric, Legend, Chip and Action still rebuild `styles(c)` on every render (`:431`, `:444`, `:455`, `:467`). No Aurora in the loaded view.
- **Regressions:** none.
- **Subscreens:**
  - School tiles: 6 → 6.
  - Business dashboard: 6 → 6.5 (roles added).
  - Donut: 5 → 5.
- **Still needed for 10/10:**
  1. Gate the shortcut rows and "Create Task" on `perms` (`:395-408`, `:387`).
  2. Use `familyOf()` for `isSchool` (`:79-82`).
  3. Give Donut a label built from its segments (`components/spaces/Donut.tsx:53`).
  4. Hoist the styles into a memoized value (`:431-467`) and mount Aurora in the loaded view.

#### `app/space-pending.tsx` — **5.5 → 7**
- **Scores now:** Function 8 · States 8 · UI 6 · A11y 6 · Security 7 · Code 6
- **Original items:**
  - ✅ 1. An error card with retry replaces "Nobody is waiting" (`app/space-pending.tsx:47-51`, `:90-93`).
  - ✅ 2. A 30s re-render while focused (`:36-41`). "Overdue" can now fire, because runs-admin sets `plannedAt` (`app/space-runs-admin.tsx:223`).
  - ◐ 3. The chat target is passed (`:88`). No Aurora in the loaded view (`:83`).
  - ◐ 4. The run header row has a role and label (`:107-108`). It is still a ScrollView, not a SectionList (`:83-144`).
- **Regressions:** none.
- **Subscreens:** none.
- **Still needed for 10/10:**
  1. Use a SectionList for long manifests (`:102-144`).
  2. Give the run header row a 44pt minimum height (`:104-105`, `rowBetween` at `:162`) and mount Aurora (`:83`).
  3. After a failed refresh, mark the list as possibly stale (rows stay under the error card, `:90-102`).

#### `app/space-people.tsx` — **6 → 7**
- **Scores now:** Function 7 · States 8 · UI 6 · A11y 6 · Security 8 · Code 6
- **Original items:**
  - ✅ 1. Error card with retry (`app/space-people.tsx:69-75`, `:190-192`). The empty copy depends on the query (`:193-195`).
  - ✅ 2. Rows that cannot be edited are disabled. Editable rows get a role and hint, and every row gets a label (`:206-209`). Role options are radios with checked state (`:289-291`).
  - ❌ 3. `PermissionMatrix` still uses `useTheme()` (`components/spaces/PermissionMatrix.tsx:62`).
  - ❌ 4. It is still a ScrollView `map` (`:186-236`), and the sheet still has no bottom inset (`:417`).
- **Regressions:** none.
- **Subscreens:**
  - Role picker sheet: 7 → 7.5.
  - PermissionMatrix: 7 → 7.
- **Still needed for 10/10:**
  1. Pass the space palette into `PermissionMatrix` (`components/spaces/PermissionMatrix.tsx:62`).
  2. Switch to FlatList (`:186`) and add a safe-area bottom inset to the sheet (`:417`).
  3. Add an `accessibilityLabel` to the search input (`:178-184`).

#### `app/space-roster.tsx` — **6 → 7**
- **Scores now:** Function 7 · States 8 · UI 6 · A11y 6 · Security 7 · Code 7
- **Original items:**
  - ✅ 1. Links can be managed through `SpaceLinksSheet` (`app/space-roster.tsx:155-167`, `:259-262`).
  - ✅ 2. `canManage` is also derived from `perms` (`:42-43`).
  - ✅ 3. Error card (`:152-154`) and pull-to-refresh (`:150`).
  - ❌ 4. `headerRight` still drops the chat door (`:135-145`). `#F59E0B18` is still used (`:278`). No Aurora in the loaded view (`:134`).
- **Regressions:** A failed `getLinks` is caught to `[]` (`:63`), so the new links sheet shows "No links yet." for that case.
- **Subscreens:**
  - Add-to-roster modal: 6.5 → 6.5. It is unchanged. Cancel and Add have no roles (`:242`, `:245`), and `externalRef`/`kind` are not offered (`:88`).
  - **New** Links sheet: **7** (see the admin section).
- **Still needed for 10/10:**
  1. Surface a link-read failure instead of `[]` (`:63`).
  2. Keep the chat door alongside `headerRight` (`:137-145`). Replace `#F59E0B18` with a token (`:278`). Mount Aurora (`:134`).
  3. Make the archive button 44pt and name the person in its label (`:209`). Add roles to the modal buttons (`:242`, `:245`).
  4. Offer `externalRef` and `kind` when adding (`:88`).

#### `app/space-run-driver.tsx` — **5 → 6.5**
- **Scores now:** Function 6 · States 7 · UI 6 · A11y 6 · Security 7 · Code 6
- **Original items:**
  - ✅ 1. `driverView` lists unassigned and orphaned riders at the first stop, and everyone when a run has no stops (`lib/spaces/runs.ts` `driverView`; `app/space-run-driver.tsx:234-235`, `:457-465`). `runPlan.selftest` passes.
  - ◐ 2. Detections are now sent as sealed famEvent `system` messages (`:174-186`), which `parseFamEvent` accepts (`lib/family/alerts.ts` `FAM_EVENT_KINDS`). They go to every space member's inbox rather than only ops roles, and they create no server record.
  - ◐ 3. The "Call guardian" button still opens an explanatory Alert with a `ponytail:` note (`:284-295`). The button is still drawn on every pending rider (`:506-508`) and leads nowhere actionable. This is blocked on the backend (fix log).
  - ✅ 4. A "Location is off" notice when foreground permission is not granted (`:76`, `:147`, `:445-453`).
  - ◐ 5. Retry on an unavailable run (`:400-402`). SOS is still not queued or retried (`:327-332`).
  - ◐ 6. Roles were added to Start/Finish (`:423-424`), Arrived (`:480-481`), mark buttons (`:513`, `:522`) and the incident bar (`:551`). The floating bar still uses a fixed `bottom: 20` with no safe-area inset (`:685`).
- **Regressions:** none found.
- **Subscreens:**
  - Handover code modal: 5 → 6.5. Confirm is disabled until a code is entered (`:578-582`). The input has no label (`:563-572`).
  - Report-a-problem sheet: 5 → 5. It is still category only, with no note or photo (`:342`), and no bottom inset (`:703`).
  - Panic confirmation: 6 → 6. There is still no queue or retry (`:329-332`).
- **Still needed for 10/10:**
  1. Once `runGet` returns guardians, wire "Call guardian" (`:284-295`). Until then, hide the button (`:506`).
  2. Queue and retry the SOS incident (`:327-332`), and add a note/photo to incidents (`:342`).
  3. Add safe-area insets to the floating bar and the sheet (`:685`, `:703`). Make the call icon 44pt (`iconBtn` `padding: 10`, `:670`).
  4. Scope detection alerts to ops roles if the spec requires it (`:183`).

#### `app/space-run.tsx` — **6 → 6.5**
- **Scores now:** Function 6 · States 7 · UI 7 · A11y 5 · Security 8 · Code 7
- **Original items:**
  - ❌ 1. There is still no map and no driver name (fix log D3). The transport entry was relabelled to match (`app/space-transport.tsx:281-292`).
  - ✅ 2. Polls every 30s while started and focused (`app/space-run.tsx:47`, `:116-120`), which also moves the arrival window. Pull-to-refresh (`:199`).
  - ✅ 3. Error card with retry on "not available" (`:181-190`) and on refresh (`:204-206`).
  - ✅ 4. Uses warning tokens (`colors.warning` in RiderCard and `c.warning + '18'` in the styles). The chat target is passed (`:201`).
- **Regressions:** none.
- **Subscreens:**
  - RiderCard: 6 → 7. The window refreshes with each 30s poll.
  - "What happened" timeline: 6.5 → 7. It now has a role and expanded state (`:293-297`). It is still disabled after opening (`:294`), and a failed fetch shows "Nothing recorded yet." (`:149-150`, `:303`).
- **Still needed for 10/10:**
  1. Render the vehicle on a map and show the driver name (`openspec/changes/spaces-operations/specs/space-runs/spec.md:75-77`).
  2. Show an error with retry in the timeline instead of an Alert plus an empty list (`:147-151`, `:303`), and allow collapsing it (`:294`).
  3. Mount Aurora in the loaded view (`:196`).

#### `app/space-runs-admin.tsx` — **4.5 → 6.5**
- **Scores now:** Function 7 · States 7 · UI 7 · A11y 6 · Security 7 · Code 6
- **Original items:**
  - ✅ 1. Per-rider stop picker (`app/space-runs-admin.tsx:561-572`, `:638-664`).
  - ✅ 2. Stops carry label, lat/lng (geocode, "lat, lng" or current location) and `plannedAt` (`:194-228`, `lib/spaces/runPlan.ts:20-51`). Riders are remapped after the server re-issues stop ids (`:144-167`, `lib/spaces/runPlan.ts:60-69`). The selftest passes.
  - ✅ 3. Rows are disabled while busy (`:479-482`, `:551-553`, `:507`, `:518`, `:522`, `:528`).
  - ✅ 4. Error card instead of "No runs yet" (`:85-100`, `:369-372`).
  - ✅ 5. Confirmations for a mid-run driver change (`:308-316`), stop removal (`:240-257`) and a mid-run stop edit (`:170-177`). Move-up reordering (`:259-264`).
  - ◐ 6. Insets (`:457`, `:470`), an opaque modal (`:456`), no `as any`, and radio/checkbox roles (`:481`, `:552`, `:650`). Several targets are still below 44pt: `iconHit` `minWidth: 36` (`:698`), `riderToggle`/`stopChip` `minHeight: 36` (`:699`, `:701`), and the Close button (`:458`).
- **Regressions / new risks:**
  - `plannedAt` is pinned to the run's `scheduledAt` day, or to the day the stop is saved when there is none (`:217`, `:223`). The create form cannot set `scheduledAt` (`:118-120`). As a result, planned times saved the day before a run land on the wrong day, and "overdue" or `isDelayed` can fire wrongly. Whether runs are one-off or recur is **not verifiable statically**.
- **Subscreens:**
  - New-run modal: 6 → 6.5. Labels and radios were added (`:415`, `:420`, `:427-428`). It still cannot set a schedule or `requireCode` (`:118-120`).
  - Edit-run modal: 3.5 → 7.
  - **New** Stop form (Modal, `:589-636`): **7**. It validates time and place, and handles location permission through `permissionDenied` (`:183-185`). The time is typed rather than picked.
  - **New** Rider stop picker (Modal, `:639-664`): **7.5**.
- **Still needed for 10/10:**
  1. Let the create form set `scheduledAt` and `requireCode`, and anchor `plannedAt` to the run's day (`:118-120`, `:217`).
  2. Raise hit targets to 44pt (`:458`, `:698-701`).
  3. Add pull-to-refresh (`:368`) and an error state for `openRun` instead of an Alert (`:108-110`).
  4. Split the 727-line component (the edit modal and stop form could become their own components) and add a time picker (`:610-615`).

#### `app/space-tasks.tsx` — **6 → 7**
- **Scores now:** Function 7 · States 7 · UI 6 · A11y 7 · Security 7 · Code 7
- **Original items:**
  - ✅ 1. Assignee chips and due chips are sent to `createWorkTask` (`app/space-tasks.tsx` diff: `DUE`/`dueAtFor`, `assigneeId`/`dueAt` in submit). The member list loads silently, so if it fails there is no assignee choice and no message.
  - ✅ 2. Task rows are checkboxes with state and a label. Priority, due and assignee chips are radios.
  - ❌ 3. Overview's "Create Task" is still not gated (`app/space-overview.tsx:387`).
  - ❌ 4. The FAB and sheet have no safe-area insets (`fab` at `:367`, `sheet` at `:374`). The comment still says a plain member is "not an error state" while the code sets `err` (`:101-103`).
- **Regressions:** none.
- **Subscreens:**
  - Tabs: 6.5 → 6.5.
  - New-task sheet: 5 → 6.5.
- **Still needed for 10/10:**
  1. Gate "Create Task" on Overview (`app/space-overview.tsx:387`).
  2. Add safe-area insets to the FAB and sheet (`:367`, `:374`). Make the comment and code agree (`:101-103`).
  3. Show a hint when the member list fails to load. Offer a custom due date beyond the four presets.

#### `app/space-transport.tsx` — **6.5 → 6.5**
- **Scores now:** Function 6 · States 7 · UI 7 · A11y 6 · Security 8 · Code 6
- **Original items:**
  - ❌ 1. `cancelled` still falls through to "Waiting to be picked up" (`app/space-transport.tsx:53-61`).
  - ✅ 2. Relabelled "Track bus/vehicle" with a navigate icon and a label (`:281-292`).
  - ❌ 3. Still N+1 `getRun` (`:140-147`).
  - ◐ 4. Roles and labels on Track, Driver and Try again (`:187`, `:288`, `:299-300`). `peerName: 'Driver'` is still a literal (`:113`), and `as any` remains (`:112`, `:208`, `:285`).
- **Regressions:** none.
- **Subscreens:** none.
- **Still needed for 10/10:**
  1. Map `cancelled` in `riderWords` (`:53-61`).
  2. Replace the per-run `getRun` with one scoped call (`:140-147`).
  3. Pass the driver's name (`:113`) and remove `as any` (`:112`, `:208`, `:285`).

#### `app/space-visitors.tsx` — **5.5 → 6.5**
- **Scores now:** Function 6 · States 7 · UI 6 · A11y 6 · Security 6 · Code 7
- **Original items:**
  - ✅ 1. Host chips, defaulting to the issuer; `hostId` is sent (`app/space-visitors.tsx:48`, `:92`, `:229-245`).
  - ❌ 2. QR wording remains (`:156`). The code is still shown only in an Alert, with no Share or Copy (`:96-99`).
  - ❌ 3. There is still no per-row "Sign out" (`:173-198`).
  - ◐ 4. Error card and pull-to-refresh (`:160-163`, `:153`). Overview's Visitors shortcut is still ungated (`app/space-overview.tsx:401`, `:404`).
  - ◐ 5. Roles on the admit row (`:155`), hour chips (`:221-222`) and modal buttons (`:247-288`). Active codes are still shown in plain text (`:195`).
- **Regressions:** none. The member list is re-fetched on every load and refresh (`:68`), which is minor.
- **Subscreens:**
  - Issue-pass modal: 6 → 7. Host selection and roles were added. The name input has no label (`:213-216`).
  - Redeem modal: 5.5 → 6. Roles were added. It is still typed only, and the input has no label (`:269-273`).
- **Still needed for 10/10:**
  1. Add a per-row "Sign out" for visitors on site (`:173-198`).
  2. Add Share/Copy for a new code (`:96-99`), and either add QR scanning or drop the QR icon (`:156`).
  3. Mask active codes in the list (`:195`). Gate overview's Visitors shortcut on `manage_roster` (`app/space-overview.tsx:401`, `:404`).
  4. Keep the chat door with `headerRight` (`:140-148`). Label the inputs (`:213`, `:269`). Mount Aurora (`:139`).

---

### I1 — Finance — re-rating

Base 18eb6d2 → HEAD (fix commit 1112fae "screen audit P7"). Static review only. Nothing here is device-verified. iOS date-picker behaviour, notification scheduling and share-then-delete timing are **not verifiable statically**.

| Screen | Old | New | Δ |
|---|---|---|---|
| `app/finance/index.tsx` | 6.5 | 7.5 | +1 |
| `app/finance/calendar.tsx` | 6.5 | 7 | +0.5 |
| `app/finance/chitti/index.tsx` (file unchanged, shared `ErrorState` changed) | 7 | 7 | 0 |
| `app/finance/chitti/new.tsx` | 7 | 7 | 0 |
| `app/finance/chitti/[id].tsx` | 5 | 6 | +1 |
| `app/finance/customer.tsx` | 6 | 6.5 | +0.5 |
| `app/finance/emi.tsx` | 7.5 | 8 | +0.5 |
| `app/finance/interest.tsx` | 7 | 7 | 0 |
| `app/finance/io.tsx` | 6.5 | 7.5 | +1 |
| `app/finance/ledger/index.tsx` (file unchanged, shared `ErrorState` changed) | 7 | 7 | 0 |
| `app/finance/ledger/new.tsx` | 6.5 | 7 | +0.5 |
| `app/finance/ledger/[id].tsx` | 6.5 | 7 | +0.5 |
| `app/finance/ledger/edit.tsx` | 6 | 7 | +1 |
| `app/finance/ledger/update.tsx` | 6.5 | 7.5 | +1 |
| `app/finance/reminders.tsx` | 6 | 7 | +1 |
| `app/finance/reports.tsx` | 6 | 6.5 | +0.5 |
| `app/finance/saved.tsx` (file unchanged, shared `ErrorState` changed) | 6.5 | 6.5 | 0 |
| `app/finance/search.tsx` | 6 | 6.5 | +0.5 |
| `app/finance/_layout.tsx`, `app/interest-calculator.tsx`, `app/split.tsx` | 8 / 7 / 7 | unchanged | 0 (no diff since 18eb6d2; not in this re-rate scope) |

### Shared changes (verified against the code)
- **X1 (Field labels) — ✅ fixed.** `Field` now takes `label` and uses `accessibilityLabel={label ?? rest.placeholder}` (`components/finance/ui.tsx:118-120`, `:137`). `grep '<Field' app/finance | grep -v label=` returns nothing. Every field also keeps a visible `<Label>` above it, so a screen reader may read the name twice. That is minor and not a regression.
- **X2 (Android-only date picker) — ✅ in code.** The new `useDatePicker` (`components/finance/useDatePicker.tsx:28-51`) uses the native dialog on Android, chaining date then time. On iOS it shows an inline `DateTimePicker` in a `Modal` with Cancel and Done (`:54-74`). No `DateTimePickerAndroid` is left in `app/finance`. iOS behaviour is not verifiable statically. Small debts: the scrim colour is hard-coded `rgba(0,0,0,0.4)` (`:81`), and `DateField`'s label is the generic "Date X. Change date" (`ui.tsx:158`), so Start and End fields sound the same.
- **ErrorState — ✅ improved.** Only the message is grouped, with `accessibilityRole="alert"`. The "Try again" button is now a separate, reachable element (`ui.tsx:481-492`). This also helps `chitti/index`, `ledger/index` and `saved`, which render `ErrorState` (`chitti/index.tsx:72`, `ledger/index.tsx:106`, `saved.tsx:85`). None of those three uses `Field`. The gain is too small to move any of their integer dimension scores, so they keep their original scores.
- **X3 (overdue / group status never written) — ❌ still open.** `setGroupStatus` and `setLedgerStatus` still have no callers in `app/`, `components/` or `lib/` (grep).
- **X5 — ❌ still open.** `lib/themeCoverage.selftest.ts:43` still exempts `app/finance/`.
- Checks I ran: `npx tsx` on `components/finance/{ledgerCsv,chittiNumber,notifyIds}.selftest.ts`, `utils/financeAmount.selftest.ts`, `utils/financeGuards.selftest.ts`, `lib/financeBtnLatch.selftest.ts`, `lib/a11yCoverage.selftest.ts` and `lib/themeCoverage.selftest.ts` all print "passed". `npx eslint app/finance components/finance` gives 0 errors and 1 warning: unused `Ionicons` at `app/finance/customer.tsx:8`.

---

#### `app/finance/index.tsx` — **6.5 → 7.5**
- **Scores now:** Function 6 · States 8 · UI 8 · A11y 8 · Security 7 · Code 7
- **Original items:**
  - ✅ The "THIS MONTH" label was wrong. It now reads "TOTAL OVERVIEW · ALL TIME", which is what the code sums (`:125`).
  - ✅ Added `.catch(fail)` plus loading and error-with-retry states via `useLoadStatus` (`:49-80`, `:117-123`).
  - ❌ Interest is still always simple and assumes 1 year when there is no end date (`:62-64`). There is no shared `ledgerInterest()`.
  - ❌ The "Overdue" tile is still 0 for app-created data (`:73`, `:152`; X3).
  - ❌ `router.push(path as any)` is still there (`:84`).
- **Regressions:** none.
- **Subscreens:** none.
- **Still needed for 10/10:**
  1. Write one shared interest helper that respects `interest_type === 'compound'` and use it here, in Reports and in the ledger detail screen (`:62-64` vs `ledger/[id].tsx:18-25`).
  2. Derive overdue as `end_date < now && remaining > 0`, or write the status (`:73`).
  3. Use typed hrefs instead of `as any` (`:84`).
  4. Bring hero colours under theme tokens and coverage (`:207-214`; X5).

#### `app/finance/calendar.tsx` — **6.5 → 7**
- **Scores now:** Function 5 · States 7 · UI 8 · A11y 7 · Security 8 · Code 7
- **Original items:**
  - ❌ A chitti group still produces a single auction at `start_date + 30d` (`:41`).
  - ❌ Recurring reminders are still shown only on `next_at` (`:40`).
  - ✅ Catch plus loading and error states (`:33-45`, `:79-82`).
  - ◐ Sort now works on a copy (`:72`), but index keys remain (`:92`, `:98`, `:112`).
- **Regressions:** none. Minor: during loading or error the grid still renders and the day panel says "Nothing due" (`:109-110`). The error message does warn that events may be missing (`:81`).
- **Subscreens:** Selected-day events panel — 6 → 6 (still read-only rows with no tap-through, `:111-119`).
- **Still needed for 10/10:**
  1. Generate one auction per month for `g.duration` (`:41`).
  2. Expand daily, weekly and monthly reminders into the visible month (`:40`).
  3. Keep a ref id on `Ev` (`:17`) and navigate on press (`:112`).
  4. Hide the "Nothing due" empty state unless `status === 'ready'` (`:109`). Use stable keys (`:92`, `:112`).

#### `app/finance/chitti/index.tsx` — **7 → 7** (file unchanged)
- Uses the improved shared `ErrorState` (`:72`), so "Try again" is now reachable on iOS. No `Field` usage. Every original item still stands: no card or FAB role (`:76-77`, `:89`), a sequential `listCollections` loop, and no FlatList.
- **Subscreens:** Active / Closed / Draft segment — 6 → 6 (X3 still open).

#### `app/finance/chitti/new.tsx` — **7 → 7**
- **Scores now:** Function 8 · States 6 · UI 7 · A11y 7 · Security 7 · Code 8
- **Original items:**
  - ❌ Members and Duration of `0.4` still pass `!(mem > 0)` (`:36-37`) and are rounded to 0 (`:41`).
  - ✅ Every field has a distinct spoken label (`:55-75`).
  - ❌ No warning when `installment × members ≠ chit_value` (`:33-37`).
  - ✅ iOS date path via `useDatePicker` (`:20`, `:51`, `:78`). The unused `Platform` import is gone (`:6`).
- **Regressions:** none.
- **Subscreens:**
  - Start-date picker — 5 → 7 (iOS path in code; needs a device check).
  - Status segment — 7 → 7 (Draft and Closed are still permanent; X3).
- **Still needed for 10/10:**
  1. Require whole numbers ≥ 1 for members and duration before rounding (`:36-41`).
  2. Warn on an installment × members / chit value mismatch (`:33-37`).
  3. Let a group's status change later by wiring `setGroupStatus` (X3).

#### `app/finance/chitti/[id].tsx` — **5 → 6**
- **Scores now:** Function 7 · States 6 · UI 6 · A11y 5 · Security 6 · Code 5
- **Original items:**
  - ✅ Load, error and not-found states. The four reads are now one `Promise.all(...).catch(fail)` (`:57-67`, `:79-88`).
  - ✅ Member numbers use `nextMemberNumber` (max + 1) (`:117`; `components/finance/chittiNumber.ts:6-10`, selftest passes). Members are capped at `g.members` (`:110-112`).
  - ❌ No role, label or state on the add row (`:222`), member rows (`:228`), month chips (`:254`, `:283`), dues rows (`:263`) or winner chips (`:291`).
  - ❌ No `KeyboardSafe`. The body is a plain `ScrollView` (`:183`).
  - ❌ "Pending" still includes overdue members (`:197`).
  - ❌ Next auction still uses 30-day months and the tab month (`:163`).
  - ❌ The file is still monolithic (411 lines) and the month-chip row is duplicated (`:252-258` vs `:281-287`).
- **Regressions:** none.
- **Subscreens:**
  - Members tab — 5 → 5 (rows still have no role or label).
  - Member add/edit form — 5 → 7: try/catch (`:113-119`), max + 1 numbering and the cap are done. It still has no keyboard avoidance.
  - Dues tab — 4 → 4: `cycleStatus` has no try/catch or tap guard (`:124-129`), and rows and chips have no role or state.
  - Auctions tab — 5 → 5: fields are now labelled (`:297-298`). There is still no bid ≤ chit value or commission ≤ bid check (`:138-141`), `recordAuction` has no try/catch (`:143`), there is no confirmation before replacing a month's auction, and winner chips have no role (`:291`).
  - History tab — 7 → 7 (load error still swallowed, `:65`).
  - Delete-group Alert — 7 → 7 (`deleteGroup(...).then(router.back)` still has no catch, `:160`).
  - Remove-member Alert — 7 → 7 (`deleteMember(...).then(reload)` has no catch, `:242`).
  - Delete-auction Alert — 6 → 6 (still no timeline entry; no catch, `:334`).
- **Still needed for 10/10:**
  1. Add roles, labels and selected or radio states to the add row, member rows, dues rows, month chips and winner chips (`:222`, `:228`, `:254`, `:263`, `:283`, `:291`).
  2. Wrap `cycleStatus`, `submitAuction`, `deleteGroup`, `deleteMember` and `deleteAuction` in try/catch, and guard dues taps against double taps (`:124-129`, `:143`, `:160`, `:242`, `:334`).
  3. Add bid and commission bounds, and confirm before re-recording a month (`:138-143`).
  4. Wrap the body in `KeyboardSafe` (`:183`).
  5. Show overdue separately from pending (`:197`). Use calendar months for the next auction (`:163`).
  6. Split the tabs into components and deduplicate the month-chip row (`:252-287`).

#### `app/finance/customer.tsx` — **6 → 6.5**
- **Scores now:** Function 6 · States 7 · UI 8 · A11y 5 · Security 7 · Code 7
- **Original items:**
  - ✅ `useLoadStatus`. The empty state now shows only when the load is ready (`:28-36`, `:79-85`).
  - ❌ Customers are still matched by name only. `mobile` is never read from params (`:23`, `:33`).
  - ❌ "Outstanding" still counts lent rows only (`:44`).
  - ❌ Cards have no role or label (`:90`).
- **Regressions:** minor. If `name` is missing, `reload` returns before `begin()` and the initial `'loading'` status never resolves (`:30`, `useLoad.ts:17`), so the spinner shows forever. The only entry point always passes a name (`ledger/[id].tsx:99`). The hero and tiles also show ₹0 while loading (`:61-76`).
- **Subscreens:** none.
- **Still needed for 10/10:**
  1. Match on mobile when present (`:23`, `:33`).
  2. Show both what you are owed and what you owe (`:44`).
  3. Give cards a role and label (`:90`).
  4. Call `fail()` or show a not-found state when `name` is absent (`:30`). Gate hero and tiles on `ready`. Remove the unused `Ionicons` import (`:8`).

#### `app/finance/emi.tsx` — **7.5 → 8**
- **Scores now:** Function 8 · States 8 · UI 8 · A11y 8 · Security 8 · Code 8
- **Original items:**
  - ✅ The PDF now exports the full schedule (`:69-71`), so the "full schedule in the PDF" note (`:143`) is true.
  - ✅ Tenure is capped at 600 months (`:17`, `:48`).
  - ✅ Field labels (`:88`, `:91`, `:98`).
  - ❌ "Loan type" still changes only the PDF label (`:62`).
- **Regressions:** none.
- **Subscreens:**
  - Amortization schedule — 7 → 8.
  - PDF share — 7 → 8. The PDF file is still left in the cache by `sharePdf` (`utils/financeIO.ts:13-19`).
- **Still needed for 10/10:**
  1. Drop "Loan type" or use it for preset rates (`:62`, `:82-84`).
  2. Delete the PDF from the cache after sharing, as `io.tsx:29-31` now does.
  3. Use a theme token for the hard-coded `#6D3FA8` and hero colours (`:69`, `:178-179`).

#### `app/finance/interest.tsx` — **7 → 7**
- **Scores now:** Function 7 · States 7 · UI 7 · A11y 7 · Security 8 · Code 7
- **Original items:**
  - ✅ The result now snapshots type, principal, rate, rateMode and period, and the PDF reads from `res` (`:33-36`, `:82`, `:105-112`).
  - ❌ A 0% rate is still refused (`:47`).
  - ❌ History still stores `rate` with no `rateMode` or `period` (`:86`).
  - ◐ The iOS date path and `Platform` removal are done (`:37`, `:41`, `:122`). Negative duration parts are still accepted as long as the total is positive (`:62-67`).
- **Regressions:** none.
- **Subscreens:**
  - Dates / Duration mode — 7 → 7.
  - Date picker — 5 → 7 (iOS path in code; From and To share a generic `DateField` label).
  - Result and Share PDF — 5 → 8.
- **Still needed for 10/10:**
  1. Allow a 0% rate (`:47`).
  2. Persist `rate_mode` and `period` in history (`:86`) so Saved shows units.
  3. Reject negative duration parts (`:62-67`).
  4. Give the two date fields distinct spoken names (From vs To) (`:151`, `:153`; `ui.tsx:158`).

#### `app/finance/io.tsx` — **6.5 → 7.5**
- **Scores now:** Function 8 · States 7 · UI 8 · A11y 7 · Security 6 · Code 8
- **Original items:**
  - ◐ Security:
    - CSV formula injection is neutralised (`components/finance/ledgerCsv.ts:30-39`, removed again on import at `:89-92`).
    - Every export and the picked file are deleted from the cache after use (`:29-31`, `:55-57`, `:66`, `:97-99`, `:117`).
    - The backup JSON is still plaintext (`:66`).
  - ✅ Import and restore now show a preview and require confirmation (`:126-133`, `:141-152`). The restore runs in one transaction (`db/financeBackup.ts`, `d.withTransactionAsync`). Per-row validation is still only the outer shape check, `isRestorable` (`:122`).
  - ✅ Rows with an unreadable principal are counted (`ledgerCsv.ts:135`). The CSV is parsed as a whole file (`ledgerCsv.ts:60-85`).
  - ✅ StartDate and EndDate columns (`ledgerCsv.ts:23-26`, `:141-145`). Re-import is de-duplicated (`:146-148`). The selftest passes.
  - ◐ A 20 MB size check was added (`:25`, `:113`). The picker type is still `['*/*']` (`:110`), and an unknown `size` passes as 0.
- **Regressions:** none in code. Deleting right after `Sharing.shareAsync` resolves (`:55-57`) is safe only if the receiving app has already read the file. That is not verifiable statically.
- **Subscreens:**
  - Ledger / Lucky Draw spreadsheet mode — 6 → 8.
  - Full Backup mode — 6 → 7 (transaction and confirmation; rows still not validated; plaintext).
  - CSV import flow — 5 → 8. Inserts run one by one with no transaction (`:154`), so a mid-import failure leaves a partial import, and "Import failed" does not say how many rows were added.
- **Still needed for 10/10:**
  1. Encrypt the JSON backup, or warn clearly that it is plaintext (`:66`, `:183`).
  2. Validate each backup row (object with a string `id`) before `INSERT OR REPLACE` (`db/financeBackup.ts`).
  3. Wrap the CSV import in a transaction, or report partial counts on failure (`:154-157`).
  4. Restrict the picker MIME types to CSV or JSON, and reject an unknown size (`:110`, `:113`).
  5. Validate the imported mobile with `normalizeMobile` (`ledgerCsv.ts:153`).

#### `app/finance/ledger/index.tsx` — **7 → 7** (file unchanged)
- Uses the improved `ErrorState` (`:106`). No `Field` usage. Every original item still stands: no card role or delete accessibility action, the FAB and UNDO have no roles, delete failures are swallowed, and there is no FlatList.
- **Subscreens:**
  - All / Lent / Borrowed filter — 8 → 8.
  - Undo snackbar — 6 → 6.

#### `app/finance/ledger/new.tsx` — **6.5 → 7**
- **Scores now:** Function 8 · States 6 · UI 7 · A11y 7 · Security 6 · Code 8
- **Original items:**
  - ❌ Mobile is still stored without validation (`:54`).
  - ❌ `end < start` is still accepted (`:40-57`).
  - ✅ X1 labels (`:76`, `:79`, `:82`, `:91`, `:105`), the iOS date path (`:21`, `:37`, `:67`) and the `Platform` removal (`:6`).
- **Regressions:** none.
- **Subscreens:** Start/End date pickers — 5 → 6 (iOS path; still no `end ≥ start` check, End cannot be cleared, and both fields use the same generic spoken label).
- **Still needed for 10/10:**
  1. Validate mobile with `normalizeMobile` (`:54`; `db/chitti.ts`).
  2. Reject `end < start` (`:40-57`).
  3. Give Start and End date fields distinct labels, and add a way to clear End (`:100`, `:102`).

#### `app/finance/ledger/[id].tsx` — **6.5 → 7**
- **Scores now:** Function 7 · States 7 · UI 8 · A11y 5 · Security 7 · Code 7
- **Original items:**
  - ✅ Loading, error and not-found states (`:36-54`).
  - ❌ The 1-year assumption and the "P + I" projection label are unchanged (`:20`, `:107`).
  - ❌ `Action` (`:171`) and the contact row (`:98`) still have no role or label.
  - ❌ Creating a reminder still writes no timeline row. The only `addTimeline` calls are in `db/ledger.ts` and `db/chitti.ts`, and none uses `'reminder'` (grep).
- **Regressions:** none.
- **Subscreens:**
  - Delete confirmation — 6 → 8 (failure is now alerted, `:78-81`).
  - PDF share — 7 → 7 (the PDF stays in the cache).
  - Timeline — 6 → 6.
- **Still needed for 10/10:**
  1. Add roles and labels to `Action` (`:171`) and the contact row (`:98`).
  2. Compute interest to today, or label the hero as a projection (`:18-25`, `:107`).
  3. Write a `'reminder'` timeline row when a reminder is created for a ledger (`reminders.tsx:59-64`).
  4. Delete the shared PDF from the cache.

#### `app/finance/ledger/edit.tsx` — **6 → 7**
- **Scores now:** Function 8 · States 7 · UI 7 · A11y 7 · Security 6 · Code 7
- **Original items:**
  - ✅ Loading, error-with-retry and not-found states (`:35-41`, `:76-85`).
  - ❌ There is still no shared `LedgerForm`. The form is still a copy of `new.tsx` (`:93-112` vs `new.tsx:75-105`).
  - ◐ X1 labels and the `Platform` removal are done (`:94-112`, `:6`). Mobile and `end ≥ start` are still not validated (`:55-73`).
- **Regressions:** none.
- **Subscreens:** Start/End date pickers — 5 → 6 (iOS path; no `end ≥ start` check).
- **Still needed for 10/10:**
  1. Validate mobile and `end ≥ start` (`:55-73`).
  2. Extract a shared `LedgerForm` for new and edit.
  3. Give the date fields distinct spoken labels (`:108`, `:110`).

#### `app/finance/ledger/update.tsx` — **6.5 → 7.5**
- **Scores now:** Function 8 · States 7 · UI 8 · A11y 7 · Security 6 · Code 8
- **Original items:**
  - ✅ Loading, error and not-found states (`:27-52`).
  - ❌ No warning when received is more than remaining, or when remaining is raised (`:54-57`).
  - ✅ X1 labels (`:77`, `:80`, `:83`).
  - ✅ `Platform` removed (`:7`).
- **Regressions:** none.
- **Subscreens:** none.
- **Still needed for 10/10:**
  1. Confirm when `rec > e.remaining`, or when the edited remaining is above `e.remaining` (`:54-57`).

#### `app/finance/reminders.tsx` — **6 → 7**
- **Scores now:** Function 6 · States 7 · UI 7 · A11y 7 · Security 7 · Code 7
- **Original items:**
  - ✅ Snooze keeps the recurrence and adds a one-off. The ids are stored comma-joined, and `cancel` clears all of them (`:74-87`; `components/finance/notifyIds.ts:12-26`, selftest passes; `notify.ts` `cancel`). Needs a device check.
  - ✅ The user is warned and the row is marked when nothing was scheduled (`:46-52`, `:65`, `:84`, `:143`).
  - ❌ `next_at` is still never advanced for recurring reminders.
  - ✅ try/catch on add, done, snooze and delete, and delete is confirmed (`:54-94`).
  - ❌ "Yearly" is still missing from the segment (`:114`). The monthly trigger on days 29–31 is unchanged (`notify.ts:32`).
  - ◐ The "When" button now has a role and label (`:118-119`). The header toggle still has no `accessibilityRole` (`:103`), and the form is still not in `KeyboardSafe` (`:107`).
- **Regressions:** minor, new code. Snoozing a recurring reminder whose recurrence never scheduled (`notif_id` null) stores `",<snoozeId>"` (`notifyIds.ts:119-120`). After that, the "Not scheduled" warning (`:143`) disappears, even though the recurrence still will not fire.
- **Subscreens:**
  - Add-reminder form — 5 → 6 ("When" is labelled; no `KeyboardSafe`; a time in the past is still accepted, `:54-58`).
  - Date then time picker — 5 → 7 (`'datetime'` via `useDatePicker`, `:44`; iOS needs a device check).
  - Notification permission handling — 4 → 7.
- **Still needed for 10/10:**
  1. Advance `next_at` for recurring reminders, so Calendar and Dashboard "due today" stay correct.
  2. Reject past times for `once` (`:54-58`).
  3. Add "Yearly" (`:114`) and handle days 29–31 (`notify.ts:32`).
  4. Add `accessibilityRole="button"` to the header toggle (`:103`). Wrap the form in `KeyboardSafe` (`:107`).
  5. Treat a missing recurrence id as unscheduled even after a snooze (`notifyIds.ts:119-120`, `:143`).

#### `app/finance/reports.tsx` — **6 → 6.5**
- **Scores now:** Function 5 · States 6 · UI 8 · A11y 7 · Security 7 · Code 7
- **Original items:**
  - ◐ Catch, loading and error states are done (`:41-72`, `:108-112`). There is no empty state for a period with no ledgers. The tiles just show ₹0, and only the Excel export is guarded (`:95`).
  - ❌ Interest is still always simple (`:54`).
  - ✅ "Outstanding" uses `sumRupees` (`:76`, `:83`, `:125`).
  - ❌ "Overdue loans" is still 0 for app data (`:64`, `:127`; X3).
- **Regressions:** none. Switching period can let an older, slower load overwrite a newer one, because `reload` (`:43-71`) has no sequence guard. This was already true before the fix.
- **Subscreens:**
  - Month / Year / All Time segment — 6 → 6 (still filters on `created_at`, `:49`).
  - PDF / Excel export — 6 → 7 (empty Excel refused, `:95`; files left in the cache).
- **Still needed for 10/10:**
  1. Use the shared interest helper with compound support (`:52-54`).
  2. Decide period membership by activity (updates and repayments), not `created_at` (`:49`).
  3. Derive overdue (`:64`).
  4. Add an empty state for a period with no ledgers (`:112-136`). Add a request-sequence guard in `reload`.

#### `app/finance/saved.tsx` — **6.5 → 6.5** (file unchanged)
- Uses the improved `ErrorState` (`:85`). No `Field` usage. Every original item still stands: interest rows cannot be viewed or deleted, the rate has no unit, cards have no roles, and there is no FlatList.
- **Subscreens:** segment — 7 → 7.

#### `app/finance/search.tsx` — **6 → 6.5**
- **Scores now:** Function 5 · States 7 · UI 7 · A11y 6 · Security 8 · Code 7
- **Original items:**
  - ❌ An amount query still matches every principal ≥ the amount (`:50`) and every chit value ≥ the amount (`:59`).
  - ✅ Error state with retry instead of "No matches" (`:27-33`, `:80-83`).
  - ◐ The `TextInput` now has a label (`:73`). Result cards still have no role (`:89`, `:106`).
  - ❌ Chitti member names and phones are not searched (`:56-60`). The search bar is not capped to `contentMax` (`:124` vs `:126`).
- **Regressions:** none. There is still no loading state, so typing before the first load returns can briefly show "No matches" (`:63`, `:83`).
- **Subscreens:** none.
- **Still needed for 10/10:**
  1. Use exact or near amount matching (`:50`, `:59`).
  2. Add roles and labels to result cards (`:89`, `:106`).
  3. Search chitti members' names and phones (`:56-60`). Cap the search bar width (`:124`).
  4. Add a loading state before the first read completes.

---

### I2 — Shop Book & Admin Web Pages — re-rating

Base 18eb6d2 → HEAD f774ffa. Fix log: `scratchpad/fixes/P7.md`. I checked every claim against the current code and `git diff 18eb6d2 HEAD`. Status is **written only**: nothing in this batch is deployed or device/browser-verified.

| Screen | Old | New | Δ |
|---|---|---|---|
| `app/shop-book.tsx` | 5.5 | **6.5** | +1.0 |
| `admin/index.html` | 6.5 | **7.0** | +0.5 |
| `admin/logs.html` | 6.5 | **7.0** | +0.5 |
| `admin/shopbook.html` | 5.5 | **7.0** | +1.5 |

**Evidence runs (read-only):**
- `npx tsx utils/shopbook.selftest.ts`: all checks passed, including the new "the screen keys its cart by the open shop" and "no single shared cart state is left".
- `lib/a11yCoverage.selftest.ts`: unlabelled 0 (budget 0).
- `lib/themeCoverage.selftest.ts`: 22 passed.
- `services/khataWalkin.selftest.ts`: all passed.
- `npx eslint app/shop-book.tsx`: 0 errors and 2 warnings. Both were already there: the unused `Platform` at `:16` and an expression statement at `:298`.
- Admin pages: I recomputed each CSP hash with the documented one-liner. All three match the `<meta>` (`admin/index.html:9`, `admin/logs.html:9`, `admin/shopbook.html:9`). No page has inline `on*=` handlers or `javascript:` URLs.
- CSP enforcement, layout and runtime behaviour need a browser and are not verifiable statically.

---

#### `app/shop-book.tsx` — **5.5 → 6.5**
- **Scores now:** Function 8 · States 6.5 · UI 6.5 · A11y 5.5 · Security 7 · Code 4 (mean 6.25, rounded to 6.5)
- **Original items:**
  1. ✅ **Cross-shop cart.** Carts are now keyed by shop: `carts` (`app/shop-book.tsx:277`), the shop's own cart read via `cartFor(carts, selShop.id)` (`:320`), updates written with `withShopCart` (`:321`), and only the placed shop's cart cleared (`:323-326`). Helpers: `utils/shopbook.ts:334-347`. Every `setCart` caller passes an array, never an updater function (`:843`, `:847`, `:860`, `:898`, `:1056-1057`), so the wrapper is safe.
  2. ✅ **OwnerPlans and the Pro gate.**
     - The PRO badge now comes from `SB.entitledPlan()` (`:1800`, `services/shopBookService.ts:958-960`). The backend's basic report returns the entitled plan (`vaultchat-backend-go/internal/routes/shopbook.go:3271`).
     - The Reports lock now follows the server's 403 `upgrade` (`:2095-2102`, `services/shopBookService.ts:962-964`; backend `shopbook.go:3254`).
     - The self-upgrade button is gone (`:2072`). Downgrade asks for confirmation (`:2038-2050`), and the server really cancels the entitlement (`shopbook.go:3202-3204`).
     - Still open: there is no in-app upgrade path (blocked on the backend, per the fix log), and the hint offers no way to contact support.
  3. ◐ **Silent `catch {}` blocks.** About 23 loaders now show `ErrorState` with a retry (e.g. `:1216`, `:1401`, `:1634`, `:1954`, `:2145`, `:2441`, `:2561`, `:2741`, `:3113`, `:3230`, `:3294`, `:3817`, `:3983`, `:4358`, `:4765`, `:4870`).
     - BillScreen no longer spins forever (`:3479-3487`). InvoiceView no longer goes blank (`:4847-4853`, `:4870`).
     - Still silent: favourites (`:285`, `:433`), coupons/ratings (`:683-684`), loyalty/ledgers (`:1668-1669`), lists (`:1664`), stock history (`:3690`), countries (`:4525`), and the initial unread count (`:196`).
  4. ✅ **Verification upload.** Each document kind has an Upload/Replace button with type and size checks, a busy state and a11y labels (`:3329-3346`, `:3415-3421`). It runs presign → PUT → save (`services/shopBookService.ts:240-257`), and the copy was corrected (`:3426`). The PUT and picker need a device check.
  5. ◐ **Reject reason and Repeat order.**
     - ❌ The owner's "other" free text is still dropped (`:2528`). Blocked: the backend accepts only reason codes, per the fix log.
     - ❌ Repeat order still has no `productId` and no idempotency key (`:1356-1361`).
  6. ◐ **Confirmations and delete error handling.**
     - ✅ Delete Product confirms (`:2812-2823`). Downgrade confirms (`:2038`). Coupon and supplier deletes catch errors (`:2247-2251`, `:2328-2332`).
     - ❌ `addList`/`removeList` still have no try/catch (`:1673-1679`).
  7. ◐ **Currency.** ✅ `LedgerRow` now gets the currency (`:1620`, `:4339`). ❌ Hard-coded ₹ remains at `:1703` (`formatINR`), `:1706`, `:2058`, `:2068`, `:2267`, `:2271`, `:2273`, `:4124`, `:4211`, `:4429`, `:4454`.
  8. ◐ **A11y.**
     - ✅ The bell is labelled (`:220-221`). SubHeader's right button now requires a label (`:4959`, `:4970-4971`). Upload and view buttons are labelled (`:3410`, `:3416`).
     - ❌ Still unlabelled or missing role/state: qty steppers and inputs (`:944`, `:949`, `:959`, `:1124-1126`), search inputs (`:464`, `:610`, `:914`), Switch (`:5037`), Field input (`:5027`), TabBar (`:4948`), mode toggle (`:228`), Chip (`:4982`), filter chips (`:619`, `:2129`, `:2429`), star rating (`:1589`).
     - ❌ The scanner is not tightened (`lib/a11yCoverage.selftest.ts:173-175`).
  9. ❌ **ShopSettings.** It still prompts for location on mount (`:4585-4588`). Times are free text (`:4641-4650`), and `prepMins` is an unchecked `num(prep)` (`:4606`).
  10. ❌ **Theming and safe area.** The TabBar keeps a fixed `paddingBottom: 20` (`:5395`). The amber/blue literals remain (`:5288-5293`, `:5408`).
  11. ❌ **Code cleanup.**
      - The file grew to 5,509 lines.
      - Unused `Platform` (`:16`) and unused `deliveryBadge` (`:5408-5409`) remain.
      - `Bars` is still declared inside render (`:2105`).
      - `key={i}` remains (`:756`, `:3045`, `:3864`, `:4116`, `:4415`, `:5169`), as do the `as any` casts (`:104`, `:956`, `:3591`).
      - The stale "keyed on the scheme" comment is still there (`:5490`, which contradicts `:183-187`).
- **Regressions:**
  - **Wrong verification status on load failure.** If VerificationScreen fails to load, the ErrorState shows (`:3382`), but the default `'unverified'` panel and "Submit for verification" button still render under it (`:3309`, `:3383-3434`). A verified shop would read "Not verified".
  - **Extra report fetch.** `entitledPlan()` computes the whole basic report just to read `plan` (`services/shopBookService.ts:958-960`). It runs on every owner load and on every return from Purchases or Verification (`:1800`, `:1834`, `:1837`). On a flaky connection it falls back to Free, so a paying shop briefly shows "Upgrade to Pro 🔒" (`:2017-2025`). Pro features stay server-gated, so this is cosmetic.
  - **More duplication.** The same 4-line load/err/retry block is now repeated about 23 times (e.g. `:1183-1188`, `:2220-2225`, `:3135-3140`). A shared hook would remove it.
- **Subscreens:**
  - Customer › FindShops — 6.5 → 6.5 (unchanged; search unlabelled `:464`, Chip has no state `:4982`)
  - Customer › ProductSearch — 5 → 6 (error state with retry `:627`; still fresh fix only `:572`; sort chips have no state `:619`)
  - Customer › ShopFlow details — 6 → 6 (cart icon labelled `:691`; `key={i}` `:756`; silent coupons/ratings `:683-684`)
  - Customer › Catalog + type-any + voice — 6 → 6.5 (error state `:920`; steppers unlabelled `:944-961`; garbage qty → 1 `:1012`)
  - Customer › CartView — 5 → 7 (cart scoped per shop `:320-326`; steppers unlabelled `:1124-1126`)
  - Customer › MyOrders — 5.5 → 7 (error state `:1216`)
  - Customer › OrderTrack — 6 → 6.5 (error state `:1401`; `decide` unguarded `:1324`; repeat has no productId/key `:1356-1361`)
  - ReasonModal (shared) — 6.5 → 6.5 (chips have no state `:4817`; owner "other" text still dropped `:2528`)
  - Customer › InvoiceView — 5.5 → 7 (ErrorState + retry `:4870`; share labelled `:4867`; backslash still not stripped from the filename `:4859`)
  - Customer › ReturnRequest — 7 → 7 (qty inputs unlabelled `:2937-2940`)
  - Customer › CustomerLedgerView — 5 → 7 (error state `:1634`; currency passed `:1620`)
  - Customer › CustomerProfile — 5 → 5 (unchanged: `:1673-1679`, `:1703`, `:1706`, `:1728`)
  - NotificationCenter — 4.5 → 5.5 (error state `:4765`, labelled header button `:4762`, mark-all failure reported `:4756`; still ScrollView map `:4767`, rows not tappable)
  - Owner › load-failure state — 8 → 8 (still EmptyState + hand-rolled button, not ErrorState `:1814-1817`)
  - Owner › ShopSettings / Create shop — 6 → 6 (unchanged; on-mount prompt `:4585-4588`)
  - Owner › OwnerDashboard — 6 → 7 (error state `:1954-1955`; PRO comes from the entitlement; nested touchable `:1915`/`:1932`)
  - Owner › Shop QR — 7 → 7 (unchanged `:1894-1909`)
  - Owner › OwnerPlans — 3.5 → 6 (honest copy and confirmed downgrade `:2038-2072`; no contact action, ₹499 hard-coded `:2068`)
  - Owner › OwnerReports — 5 → 6.5 (server-driven lock `:2095-2102`, error state `:2145`; `Bars` in render `:2105`; name keys `:2173`, `:2195`)
  - Owner › OwnerCoupons — 6 → 6.5 (error state and delete catch `:2247-2251`; percent >100 accepted `:2228`; ₹ labels `:2267-2273`)
  - Owner › OwnerSuppliers — 6 → 7 (error state `:2356`, delete catch `:2328-2332`)
  - Owner › PurchasesScreen + Record step — 5.5 → 6 (error state `:3113`; cost unvalidated `:3007`; `key={i}` `:3045`)
  - Owner › ReturnsScreen + Decline modal — 6.5 → 7 (error state `:3230`; empty decline is still a silent no-op `:3212-3213`)
  - Owner › AuditScreen — 6 → 7 (error state `:3294`)
  - Owner › VerificationScreen — 4 → 7 (upload built `:3329-3346`; misleading default state on load error `:3383-3434`; docs open in the external browser `:3364`; device check pending)
  - Owner › OwnerOrders — 6.5 → 7 (error state `:2441`; filter chips have no state `:2429`)
  - Owner › OwnerOrderDetail — 5.5 → 6 (error state `:2561`; reject text dropped `:2528`; `setAvail` unguarded `:2471`)
  - Owner › Suggest-alternative — 6.5 → 6.5 (placeholder-only inputs `:2544-2547`)
  - Owner › BillScreen — 5.5 → 7 (error vs loading split with retry `:3479-3487`)
  - Owner › Bill "Add an item" — 7 → 7 (placeholder-only inputs `:3502-3507`)
  - Owner › OwnerProducts — 6.5 → 7 (error state `:2741`; seeding refused while the catalog is unloaded `:2686`)
  - Owner › ProductEditor — 5.5 → 7 (delete confirmed `:2812-2823`; Switch `:5037` and Field input `:5027` unlabelled)
  - Owner › BulkAdd — 6 → 6 (unchanged; `key={i}` `:3864`; unparsed lines not counted)
  - Owner › StockScreen + item detail — 6.5 → 7 (error state `:3817`; history failure silent `:3690`)
  - Owner › OwnerKhata (+ Add customer) — 6.5 → 7 (error state `:3983`)
  - Owner › CounterSale — 6 → 6 (unchanged; "₹ each" `:4124`, `key={i}` `:4116`, share sheet `:4088-4097`)
  - Owner › KhataDetail (+ credit-limit) — 6.5 → 7 (currency passed `:4339`, error state `:4358`; ₹ hard-coded `:4211`, `:4429`, `:4454`)
- **Still needed for 10/10:**
  1. **Reject reason.** Stop collecting free text the server drops. Either add the backend `note` field (handoff in P7) and send it (`app/shop-book.tsx:2528`), or hide the text box for the owner reject and say so (`:4797`, `:4824-4826`).
  2. **Repeat order.** Send `productId` and a `clientKey()` idempotency key (`:1356-1361`).
  3. **Remaining silent failures.**
     - Wrap `addList`/`removeList` (`:1673-1679`).
     - Surface the loyalty/ledgers, coupons/ratings, stock-history and countries failures (`:1668-1669`, `:683-684`, `:3690`, `:4525`).
     - In VerificationScreen, hide the state panel and the Submit button when the load fails (`:3382-3434`).
  4. **Busy guards.** Guard `decide` (`:1324`) and `setAvail` (`:2471`). Disable "Decline return" until the note is non-empty (`:3212-3213`).
  5. **Input validation.**
     - Gate `tQty` with `isNum` (`:1012`).
     - Range-check coupon percent ≤100 (`:2228`).
     - Gate purchase cost with `isBlankOrNonNegative` (`:3007`).
     - Validate HH:MM times and prep minutes (`:4606`, `:4641-4650`).
     - Drop the on-mount location prompt (`:4585-4588`).
  6. **OwnerPlans and currency.**
     - Give OwnerPlans a real contact or purchase action (`:2072`) and drop the hard-coded ₹499 (`:2068`).
     - Replace the remaining hard-coded ₹ (`:1703`, `:1706`, `:2058`, `:2267`, `:2271`, `:2273`, `:4124`, `:4211`, `:4429`, `:4454`).
  7. **A11y.**
     - Label the qty steppers and inputs (`:944-961`, `:1124-1126`, `:2937`), search inputs (`:464`, `:610`, `:914`), Field (`:5027`) and Switch (`:5037`).
     - Add role and selected state to TabBar (`:4948`), the mode toggle (`:228`), Chip (`:4982`), filter chips (`:619`, `:2129`, `:2429`), ReasonModal chips (`:4817`) and stars (`:1589`).
     - Tighten `lib/a11yCoverage.selftest.ts:173-175`.
  8. **NotificationCenter.** Use a FlatList with tappable rows that open `data.orderId` (`:4767-4776`).
  9. **Safe area and theming.** Use safe-area insets on the TabBar (`:5395`). Theme the amber/blue literals (`:5288-5293`).
  10. **Code health.**
      - Split the 5,509-line file.
      - Extract the repeated load/err/retry block into one hook.
      - Have `/my-shop` return the entitled plan rather than computing the basic report (`services/shopBookService.ts:958-960`).
      - Remove `Platform` (`:16`) and `deliveryBadge` (`:5408-5409`). Hoist `Bars` (`:2105`).
      - Replace `key={i}` (`:756`, `:3045`, `:3864`, `:4116`, `:4415`, `:5169`) and the `as any` casts (`:104`, `:956`, `:3591`). Fix the stale comment (`:5490`).
  11. **Device-verify** the document upload (picker plus presigned PUT, `services/shopBookService.ts:246-257`) and the entitled-plan display.

---

#### `admin/index.html` — **6.5 → 7.0**
- **Scores now:** Function 8 · States 7.5 · UI 7 · A11y 5.5 · Security 7.5 · Code 7 (mean 7.08)
- **Original items:**
  1. ✅ **Dashboard timer.** `startDashTimer()` runs on every `enterApp()` (`admin/index.html:315`, `:321-327`). Logout clears it (`:286`).
  2. ✅ **Broadcast.** It asks `confirm()` with the type and text (`:452`), disables the button while sending (`:448`, `:453`, `:457`), and renders the result with `textContent` (`:455-456`).
  3. ◐ **CSP, fonts and https.**
     - ✅ CSP with a SHA-256-pinned script (`:9`). The Server URL must be https, with localhost allowed (`:269-271`).
     - ❌ Google Fonts are still loaded from Google (`:13-15`). `style-src 'unsafe-inline'` remains (`:9`). `frame-ancestors` needs a server header, which is not verifiable statically.
  4. ◐ **A11y.**
     - ✅ Labels are associated (`:121`, `:125`, `:191`, `:194`). Search, limit and API path have aria-labels (`:154`, `:170`, `:217`). The login button is disabled while verifying (`:273`, `:280`).
     - ❌ Tabs still have no `role="tablist"`/`role="tab"`/`aria-selected` (`:296-305`).
     - ❌ The status pill and log are not `aria-live` (`:137`, `:210`).
     - ❌ `outline:none` remains, and the focus selector bug is still there (`:30-31`, `select` without `:focus`).
     - ❌ `--faint` contrast is unchanged (`:20`).
  5. ❌ **Theme and links.** It is still dark-only (`:11`), and there is no link to `logs.html` or `shopbook.html`.
- **Regressions:** none found. The hash-pinned script means any future edit must recompute the hash (documented at `:5-8`).
- **Subscreens:**
  - Login — 6 → 7.5 (`:121-128`, `:263-281`)
  - Dashboard — 6.5 → 7.5 (`:315-327`)
  - Users — 7 → 7.5 (`:154`)
  - Messages — 7 → 7.5 (`:170`)
  - Sessions — 7.5 → 7.5 (errors still use `alert` `:442`)
  - Broadcast — 5 → 7.5 (`:447-458`; result not `aria-live` `:198`)
  - Live Log — 7.5 → 7.5 (no `role="log"` `:210`)
  - API Explorer — 7 → 7.5 (`:217`)
- **Still needed for 10/10:**
  1. **Tabs.** Use `role="tablist"`/`role="tab"`/`aria-selected` (`admin/index.html:296-305`). Make `#statusPill`, `#bcResult` and `#logWrap` live regions (`:137`, `:198`, `:210`).
  2. **Focus and contrast.** Restore a visible `:focus-visible` style and fix `select` → `select:focus` (`:30-31`). Raise the `--faint` contrast (`:20`).
  3. **Third-party resources.** Self-host the fonts and remove them from the CSP (`:9`, `:13-15`). Send `frame-ancestors 'none'` as a response header (`:8`).
  4. **Navigation.** Link `logs.html` and `shopbook.html` from the topbar (`:136-140`; `admin/LOGS_DEPLOY.md:53-54`).
  5. **Sessions errors.** Show revoke errors inline instead of `alert` (`:442`).
  6. **Theme.** Honour light mode or `color-scheme: light dark` (`:11`, `:17-23`).

---

#### `admin/logs.html` — **6.5 → 7.0**
- **Scores now:** Function 7.5 · States 6.5 · UI 6.5 · A11y 5.5 · Security 8 · Code 7 (mean 6.83)
- **Original items:**
  1. ✅ **Token storage.** The token is kept in `sessionStorage` (`admin/logs.html:137`, `:251`). A legacy `localStorage` copy is removed (`:136`). There is a "forget token" button (`:77`, `:252-256`).
  2. ◐ **CSP and linking.** ✅ CSP with `connect-src 'self'` (`:9`). ❌ The page is still not linked from `admin/index.html`, so it remains UNWIRED.
  3. ✅ **Responsive layout.** A ≤700px media query stacks the nav (`:62-68`). It needs a browser check.
  4. ◐ **A11y.** ✅ aria-labels on token, selects and filter (`:76-90`), nav `aria-label` (`:98`), `aria-current` (`:161`). ❌ No `role="log"`/`aria-live` on `#log` (`:100`). The back link's only name is "←" (`:74`).
  5. ❌ **Polling.** There is no in-flight guard: the interval loop (`:242`) and the retry loop (`:274`) can overlap. The full `innerHTML` is rebuilt each refresh (`:189`). `api()` still parses JSON without checking `r.ok` (`:195-201`).
- **Regressions:** minor. "Forget token" leaves both polling timers running (`:242`, `:274`), so the page keeps calling `/logapi/sources` with an empty token, and the "unauthorized" status overwrites "token cleared" (`:213`).
- **Subscreens:**
  - Token/setup overlay — 6.5 → 7.5 (`:76-77`, `:102-109`, `:252-256`)
  - Source navigator — 6.5 → 7 (`:98`, `:161`, `:64-65`)
  - Log view + filter/highlight/download — 7 → 7 (`:174-193`; no in-flight guard)
- **Still needed for 10/10:**
  1. **Polling.** Add an in-flight flag to `load()` and `loadSources()` (`admin/logs.html:210-237`). Stop the timers on "forget token" (`:252-256`). Check `r.ok` in `api()` (`:195-201`).
  2. **Linking.** Link this page from `admin/index.html` (`admin/LOGS_DEPLOY.md:53-54`).
  3. **Live region.** Add `role="log" aria-live="polite"` to `#log` (`:100`). Give the back link a real name (`:74`).
  4. **Rendering.** Append only new lines instead of rebuilding `innerHTML` on every tick (`:179-189`).
  5. **Browser check.** Verify the ≤700px layout and the CSP in a browser (`:9`, `:62-68`).

---

#### `admin/shopbook.html` — **5.5 → 7.0**
- **Scores now:** Function 7.5 · States 7.5 · UI 6 · A11y 6.5 · Security 8 · Code 7 (mean 7.08)
- **Original items:**
  1. ✅ **Error handling.** Every loader goes through `section()`, which shows the error in place plus a toast and sets `aria-busy`/"Loading…" (`admin/shopbook.html:146-153`). Connect uses `Promise.allSettled` (`:167-170`). Documents have their own catch (`:340`).
  2. ✅ **Inline handlers and escaping.**
     - Inline handlers were replaced by `data-act` plus one delegated listener (`:502-524`). Ids are URL-encoded (`:217`, `:312`, `:395`, `:444`).
     - Numbers go through `num()` (`:127`, `:177-181`, `:285`, `:368`, `:413`, `:459`, `:479`).
     - CSP with a hashed script (`:9`).
  3. ✅ **Confirmations.** Approve, Approve+Verified and badge changes (`:210-216`), mark Verified (`:308`), Approve move with from→to (`:389-392`), and entitlements (`:441-442`) all confirm. Expiry is validated as a date and must not be in the past (`:430-437`).
  4. ◐ **Filters.** ✅ Reloads keep the current filter (`:132`, `:218`, `:313`, `:396`). ◐ Returns still ignore the shop id. That is blocked on the backend, but the page now says so (`:469-474`).
  5. ✅ **A11y.** Visually hidden labels for base, key and shop filter (`:41`, `:55-58`, `:107`). The JSON textareas have aria-labels (`:235`, `:246`, `:257`). The toast is `role="status" aria-live` with a 5 s display (`:116`, `:129`). The `<a><button>` nesting is gone, and only https links are offered (`:334-335`).
  6. ❌ **Discoverability.** The page is still not linked from `admin/index.html` and not mentioned in any deploy doc (grep: no `shopbook.html` reference), so it stays UNWIRED.
- **Regressions:** none found.
- **Subscreens:**
  - Connect bar — 6 → 7.5 (`:54-60`, `:155-160`)
  - Platform stats — 6 → 7.5 (`:174-182`)
  - Shop approvals — 5.5 → 7.5 (`:186-225`)
  - Verification queue + Documents — 6 → 7.5 (`:275-353`)
  - Location changes — 6 → 7.5 (`:358-398`)
  - Subscriptions / entitlements — 5.5 → 7.5 (`:401-448`; still a chain of `prompt()`s, not a form)
  - Country tax engine — 5 → 5.5 (labelled `:235`; still only `JSON.parse` before POST `:265`)
  - Categories & starter catalogs — 5 → 5.5 (`:251-261`, `:263-270`)
  - Support windows — 5 → 6.5 (errors handled; returns-filter gap disclosed `:469-474`)
- **Still needed for 10/10:**
  1. **Discoverability.** Link the page from `admin/index.html`, or document its deployment the way `admin/LOGS_DEPLOY.md` does for logs.
  2. **JSON validation.** Schema-check the country and category JSON before POST: required keys, types, `code` format (`admin/shopbook.html:263-266`).
  3. **Double-submit.** Disable action buttons while their request is in flight (approve, verify, review, decide, entitlement: `:217`, `:312`, `:350`, `:395`, `:444`).
  4. **Entitlement form.** Replace the `prompt()` chain with a small form using a date input (`:430-439`).
  5. **Returns filter.** Apply the shop filter once `sbAdminReturns` accepts `?shopId=` (`:469-474`; backend handoff in P7).
  6. **Focus.** Add a visible focus style for inputs and selects; `outline:none` with no `select:focus` (`:24-25`). Consider a light theme (`:11`).

---

### J — Settings, Privacy & Vault — re-rating

Base 18eb6d2 → HEAD (f774ffa). Static, read-only review. Fix logs P1, P2 and H were treated as claims and checked against the current code. Nothing here is device-verified, and no claim depends on device behaviour unless it is marked "not verifiable statically".

| Screen | Old | New | Δ |
|---|---|---|---|
| app/settings.tsx | 6.5 | 8.0 | +1.5 |
| app/privacy-dashboard.tsx | 4.5 | 8.0 | +3.5 |
| app/ghost-mode.tsx | 6.0 | 8.0 | +2.0 |
| app/last-seen-privacy.tsx | 7.0 | 7.5 | +0.5 |
| app/status-privacy.tsx | 6.5 | 7.0 | +0.5 |
| app/login-history.tsx | 7.5 | 8.0 | +0.5 |
| app/vault.tsx | 3.5 | 6.0 | +2.5 |
| app/vault-features.tsx | 3.5 | 6.0 | +2.5 |
| app/vaultbeam-settings.tsx | 5.5 | 6.5 | +1.0 |
| app/encrypted-notes.tsx | 5.0 | 6.0 | +1.0 |
| app/d2de-status.tsx | 5.0 | 7.0 | +2.0 |

Out of this batch: vaultdrop (deleted in P1), vaultcheck and filevault.

Selftests I ran with `npx tsx` (each printed its pass line):
- privacyChecklist (5)
- localCache.sealed (4)
- services/security/pinFormat
- a11yCoverage
- themeCoverage (22 assertions, 20 exemptions)
- orphanRoutes (50)
- resumeLockPolicy
- responsiveCoverage

---

#### `app/settings.tsx` — **6.5 → 8.0**
- **Scores now:** Function 8.5 · States 8 · UI 7.5 · A11y 8 · Security 8 · Code 7
- **Original items:**
  1. ✅ Load failure. Settings, blocks and profile now load independently (`app/settings.tsx:93-116`). A full-screen error has Back and Try again (`:230-250`), and blocked users have their own inline error with retry (`:493-499`).
  2. ✅ Roles and labels are on LinkRow (`:549-550`), the profile card (`:270-271`), Delete (`:484-485`), the media row (`:302`) and the pref rows (`:369`, `:383`). The Switches are labelled (`:328`, `:633`).
  3. ✅ The export JSON is deleted after sharing (`:189-196`). ◐ When sharing is unavailable, the file still stays in the cache: `:198` shows the path and nothing deletes it.
  4. ◐ `savePref` now has an in-flight guard and the rows are disabled while it runs (`:138-147`, `:369`, `:383`). Not awaiting `setAutoDownload`, `setSaveToGallery` and `setUsageCounterEnabled` is harmless, because they cannot reject: each catches its own storage error (`lib/mediaPrefs.ts:26-29`, `lib/galleryExport.ts:66-69`, `lib/usageCounter.ts:92-98`). The fixer's "not reproduced" claim holds. Persistence failures are still silent.
  5. ✅ The d2de subtitle now reads "Which encryption layers this build uses" (`:477`).
  6. ✅ `#374151` became `colors.border` (`:331`, `:636`). Dead styles `backTxt`/`dataBtn`/`dataBtnTxt`/`dataHint` are gone (`:644-701`). ◐ `thumbColor` `#FFFFFF`/`#fff` remain (`:332`, `:637`).
  7. ❌ Duplicate privacy toggles are still here (`:341-368`), in `app/last-seen-privacy.tsx:30-35`, and as last-seen/photo chips in `app/privacy-dashboard.tsx:260-261`.
- **Regressions:** none found.
- **Subscreens:**
  - Picker Sheet — 7 → 8.5. `SheetAction.selected` shows a checkmark and sets `accessibilityState.selected` (`components/ui/Sheet.tsx:24-25`, `:78`, `:86`). All three pickers pass it (`app/settings.tsx:306-308`, `:372-374`, `:387-390`).
  - Appearance segmented control — 6 → 7.5. It has the radio role and selected/checked state (`:583-585`). Still open: the hard-coded `#FFFFFF` (`:587-588`) and the "Light mode is rolling out screen by screen." copy (`:594`).
  - Blocked users — 6.5 → 8.5. The Unblock button is named (`:519-520`), and there is an inline error with retry (`:493-499`).
- **Still needed for 10/10:**
  1. Give one screen ownership of last seen, read receipts, profile photo and discoverable. They are edited in three places: `:341-368`, `app/last-seen-privacy.tsx:30-35` and `app/privacy-dashboard.tsx:260-261`.
  2. The QR button is a touchable nested inside the profile-card touchable, and the card now carries a role and label (`:270-286`). On iOS an accessible parent hides its children from VoiceOver, so the QR button is probably unreachable (not verifiable statically). Make them siblings.
  3. Delete or update the stale "Light mode is rolling out screen by screen." hint (`:594`). Tokenise `#FFFFFF`/`#fff` (`:332`, `:587-588`, `:637`, `:659`, `:681`).
  4. Remove the unused `brandAlpha` import (`:40`) and the `(FileSystem as any)` casts (`:187-195`).
  5. Delete the export file in the no-sharing branch, or do not write it there (`:197-199`).

#### `app/privacy-dashboard.tsx` — **4.5 → 8.0**
- **Scores now:** Function 8 · States 8 · UI 8 · A11y 8 · Security 8 · Code 8
- **Original items:**
  1. ✅ The placebo toggles are gone. The checklist is built from real facts (`app/privacy-dashboard.tsx:62-77`): `E2EE_ENABLED`, `isMfaEnabled`, `hasPIN` → `pinStore.hasPin` (`app/(constants)/authService.ts:196-198`), trusted contacts and server settings. Rows open the real setting (`lib/privacyChecklist.ts:43-56`; `app/privacy-dashboard.tsx:189-201`).
  2. ✅ The "My Contacts" chip is gone; only Everyone and Nobody remain (`:207-210`).
  3. ✅ `updateSettings` failures roll back and alert, and saves are serialised (`:104-121`).
  4. ✅ The ring renders only after load; a spinner shows before that (`:247-248`). A load failure shows an error view with retry (`:239-246`).
  5. ✅ E2E reads `E2EE_ENABLED` (`:68`). The selftest asserts the key binding (`lib/privacyChecklist.selftest.ts`).
  6. ✅ `#F59E0B`/`#FFF` are gone. The Blocked row has a role and label (`:266-271`). Chips have `minHeight: 44` (`:396-405`).
- **Regressions:** none. The old push to `/blocked`, a lock-out screen, is replaced by `dismissTo('/settings')` (`:99-102`, `:263-268`).
- **Subscreens:**
  - Score ring — 4 → 8. It is derived from facts and has an accessible label (`:135`).
  - Checks list — 3 → 8.5.
  - Who can see (privacy controls) — 4 → 8.
  - Improve your score — 4 → 8.5. Each suggestion is actionable and routed (`:284-303`).
- **Still needed for 10/10:**
  1. "Screenshot blocking" is inferred from `Platform.OS === 'android'` (`:71`), not from `setSecure`'s result. `setSecure` refuses in dev builds (`app/chat.tsx:1868-1873` comment), and `app/chat.tsx:1873` lowers the flag per chat. Report the actual guard state.
  2. One failing source fails the whole screen. If `listTrustedContacts()` or `isMfaEnabled()` throws, the user also loses the server-backed controls (`:62-64`). Degrade per row instead.
  3. The last-seen chips duplicate controls in Settings and last-seen-privacy (`:260`).
  4. Add `hitSlop` to the back button (`:313`). Check `colors.text` on `colors.primary` contrast for the "on" check icon (`:168-169`); not verifiable statically.

#### `app/ghost-mode.tsx` — **6.0 → 8.0**
- **Scores now:** Function 8 · States 8 · UI 8 · A11y 8 · Security 8 · Code 7.5
- **Original items:**
  1. ✅ The list refetches on focus with a sequence guard (`app/ghost-mode.tsx:73-95`).
  2. ✅ The list shows an error view with retry when nothing is cached (`:106-116`, `:176-187`). The editor has an error view with retry, and its header with Back is always present (`:264-283`).
  3. ✅ Rows are labelled with name plus summary (`:146-147`), the Switches are labelled (`:358`), and titles wrap (`:351`).
  4. ✅ AppText is used (`:46`), AuroraBackground is on both views (`:109`, `:120`, `:276`, `:289`), and `#374151` became `colors.border` (`:361`).
  5. ✅ The cache is sealed-or-nothing (`:34-36`; `lib/localCache.ts:52-72`). Plaintext legacy entries are deleted on read (`:64-66`).
  6. ✅ The dead `backTxt`/`rowChev` styles are removed.
- **Regressions:** with `VAULT_CACHE_ENCRYPTED = false` (`constants/flags.ts:95`), the offline first paint is gone. This is a deliberate `ponytail:` trade-off (`lib/localCache.ts:47-49`).
- **Subscreens:**
  - List view — 6 → 8.
  - Per-target editor — 6 → 8.
- **Still needed for 10/10:**
  1. When a refresh fails with rows already shown, the error is set (`:89`) but rendered only when `rows === null` (`:111`). Show a "showing saved list" notice.
  2. Remove the unused `colors`, `S` and `router` in `GhostModeScreen` (`:54-56`).
  3. Add an in-flight guard on Clear (`:251-258`). Tokenise `#fff` (`:362`, `:387`).

#### `app/last-seen-privacy.tsx` — **7.0 → 7.5**
- **Scores now:** Function 8 · States 8 · UI 8 · A11y 8 · Security 7 · Code 7
- **Original items:**
  1. ✅ There is an error view with Try again and an unmount guard (`app/last-seen-privacy.tsx:46-53`, `:85-96`).
  2. ✅ Each Switch has `accessibilityLabel={row.title}` (`:115`), and the title can wrap with `flexShrink: 1` (`:146`).
  3. ✅ The spacer is 40, matching the back button (`:81`).
  4. ❌ The controls are still duplicated with Settings (`app/settings.tsx:341-368`).
- **Regressions:** none.
- **Still needed for 10/10:**
  1. Different rows can save concurrently: only the row being saved is disabled (`:118`). A failed save rolls back to `prev` (`:57`, `:63`), and that snapshot can wipe another row's successful change. Serialise saves, or roll back only the key that failed.
  2. Consolidate with Settings (see Settings item 1).
  3. Type `icon` (`:30`, `any`), and give the header title `accessibilityRole="header"` (`:80`).

#### `app/status-privacy.tsx` — **6.5 → 7.0**
- **Scores now:** Function 7 · States 6 · UI 8 · A11y 7.5 · Security 6 · Code 7.5
- **Original items:**
  1. ◐ The screen now shows an error view and blocks edits on a failed load (`app/status-privacy.tsx:46-69`, `:102-109`). But `getStatusPrivacy` swallows its own error and returns `{ mode: 'contacts', userIds: [] }` (`lib/chatService.ts:1828-1831`). A `/stories/privacy` failure therefore still looks like a successful load of the default, and the next tap PUTs over the real server list (`:73-82`). Only a `listChats` failure reaches the new error path.
  2. ✅ Saves go through one serialised `commit` with rollback, outside the updater (`:73-89`).
  3. ✅ `ListEmptyComponent` added (`:140-144`).
  4. ✅ Cancel and mounted guards added (`:43-44`, `:47-68`).
- **Regressions:** none introduced. Found during this review, pre-existing: switching between "except" and "only" carries the selection across. `pickMode` commits the current `selected` under the new mode (`:84`), so people the user had excluded immediately become the only people who can see their status.
- **Subscreens:**
  - Contact selector — 6 → 7.5. Rows are labelled with checkbox state and disabled while saving (`:148-156`), and there is an empty state.
- **Still needed for 10/10:**
  1. Make `getStatusPrivacy` throw, or return a failure marker, instead of a default (`lib/chatService.ts:1829-1830`), so the screen's error path covers it.
  2. On a mode switch to except/only, start from an empty selection or ask for confirmation, instead of reusing the other mode's list (`:84`).
  3. Show progress while saving; right now rows are only disabled (`:122`, `:152`). Give mode rows an explicit label (`:117-125`).

#### `app/login-history.tsx` — **7.5 → 8.0**
- **Scores now:** Function 8 · States 8 · UI 8 · A11y 8.5 · Security 8 · Code 8
- **Original items:**
  1. ✅ A `revoking` guard covers both actions, the rows and the footer (`app/login-history.tsx:54`, `:89-134`, `:183`, `:203`).
  2. ✅ The error is set through a ref check and no longer inside the updater, and a mounted guard is added (`:55-71`).
  3. ✅ The cache is sealed-or-nothing (`:26-28`).
  4. ✅ There is a Try again button next to the error (`:157-164`).
- **Regressions:** offline first paint is lost while `VAULT_CACHE_ENCRYPTED` is off (same trade-off as ghost-mode).
- **Still needed for 10/10:**
  1. The loading state has no header or Back (`:136-143`).
  2. A cold-load error also renders "0 signed-in devices. Tap any other device…" (`:157-177`). Hide the intro when `error` is set and the list is empty.
  3. Remove the dead `backTxt` style (`:251`). Label the footer button (`:203`).

#### `app/vault.tsx` — **3.5 → 6.0**
- **Scores now:** Function 7 · States 6 · UI 5 · A11y 7 · Security 7 · Code 5
- **Original items:**
  1. ✅ PIN length now accepts 4–8 digits with a ✓ submit (`app/vault.tsx:106-125`, `:155-163`; `services/security/pinFormat.ts`, selftest passes). There is a no-PIN path to `/backup-pin` (`:127-146`) and a backoff message (`:116-120`).
  2. ✅ A random DEK is wrapped under the PIN (`lib/vaultCrypto.ts:101-141`; `lib/vaultKeyStore.ts:34-53`). `app/backup-pin.tsx:91-95` re-wraps before saving the new PIN and rolls back on failure.
  3. ✅ The wrap uses a per-install random salt (`lib/vaultCrypto.ts:105-112`). ◐ When `keys` is null, new files fall back to v1 with the constant salt (`lib/vaultCrypto.ts:131`, `:16`).
  4. ✅ The decrypted copy goes under `vault-open/` with `safeName` and is deleted after sharing; the folder is wiped on mount and unmount (`:64-70`, `:197-201`, `:357-384`).
  5. ◐ `clearVaultKeyCache` runs on unmount (`:200`). There is still no re-lock on background, and `vaultPin`/`vaultKeys` stay in React state while the screen is mounted (`:185-189`). This was deferred: P2 D2.
  6. ✅ The false backup claims are gone. The feature is now "Export file list" and its copy is honest (`:3-10`, `:618-656`).
  7. ❌ Whole files are still read as base64 into JS memory (`:255-260`, `:349-362`). Deferred: P2 D3.
  8. ◐ A11y is mostly done: keypad keys (`components/PinPad.tsx:64-87`), export (`:469-474`), rows (`:564-565`), delete (`:588-589`), tabs with role and state (`:515-517`), and the `TextInput` import is gone. Still open: emoji and hard-coded colours (`:56-61`, `:678`, `:772`, `:792`) and dead styles `back`, `backupLabel`, `backupInput`, `fabText` (`:695`, `:811-817`, `:788`).
- **Regressions:** none introduced. The `keyNotice` (`:499-503`) says the PIN "was reset" even when keys are null because SecureStore could not be read or written (`lib/vaultKeyStore.ts:36`, `:39`; the throw is caught at `app/vault.tsx:205`). That message is misleading.
- **Subscreens:**
  - PIN gate — 2 → 7.5. It works for every valid PIN length and handles no-PIN and backoff. The 🔒/🔐 emoji are not hidden from screen readers (`:131`, `:151`, `:168-170`).
  - File tabs and list — 5 → 6.5. Roles and labels added, loading text is correct, delete errors are shown. The FAB race remains (see below).
  - Export file list modal — 2 → 7. The copy is honest and the file is deleted after sharing (`:415-441`). "Last export" is recorded before the share completes (`:425-426`).
- **Still needed for 10/10:**
  1. Data-loss risk, pre-existing: `loadManifest` swallows errors and leaves `files = []` (`:227-232`). The next add then writes a one-entry manifest over the real one (`:277-278`) and orphans every earlier `.enc` file. Block writes when the manifest read fails, as encrypted-notes now does.
  2. The FAB stays active while loading (`:600`). Two adds in flight both build their manifest from a stale `files` closure (`:277`) and one entry is lost. Disable the FAB while `loading`, and build the update from functional state.
  3. Re-lock when the app goes to background, without breaking the system pickers (`:185-209`; P2 D2). Stream large files (`:255`).
  4. Tokenise the tab colours, `#FF4D6D`, `rgba(34,197,94,0.14)`, `#00000088` and `#FFFFFF` (`:56-61`, `:678`, `:772`, `:792`, `:601`). Replace the emoji icons. Remove the dead styles (`:695`, `:788`, `:811-817`).
  5. A11y: add hitSlop or size to the back button (`:462`, a 26px icon with no padding) and enlarge the delete target (`:777`, `padding: 4`). Hide the decorative emoji.
  6. Word the `keyNotice` correctly when the cause is a storage error rather than a PIN reset (`:499-503`).

#### `app/vault-features.tsx` — **3.5 → 6.0**
- **Scores now:** Function 8 · States 6 · UI 5 · A11y 5.5 · Security 7 · Code 5
- **Original items:**
  1. ✅ The placebo settings are gone (`app/vault-features.tsx:13-17`). `lockTimer` is real: it is read by `services/lockService.getLockTimeoutMs` (`services/lockService.ts:32-34`), which `components/ResumeLock.tsx:19-37` uses, mounted at `app/_layout.tsx:912`. The Settings subtitle is fixed (`app/settings.tsx:418`).
  2. ✅ The Export rows are replaced by a Vault link with honest copy (`:348-364`).
  3. ◐ `saveSetting` reverts and alerts on failure (`:117-128`). ❌ `loadSettings` still swallows errors (`:114`). The expiry label still does not tick or auto-clear (`:201-209`, `:255`).
  4. ◐ Modal options have the radio role and checked state (`:387-388`), and the picker row is labelled (`:311-312`). ❌ The back button has no hitSlop (`:220`). Copy, Share, Revoke and Generate have no roles (`:258-292`).
  5. ❌ Hard-coded colours remain (`:319`, `:344`, `:362`, `:468-471`, `:494`, `:529`, `:553`). Dead styles remain and have grown: `back`, `pickerChevron`, `infoBanner*`, `toggle*`, `exportChevron`, and the modal `subtitle`/`checkmark`/`inputLabel`/`pinInput`/`btnRow`/`cancel*`/`confirm*` (`:429`, `:490-513`, `:525`, `:543-577`).
- **Regressions:** none, apart from more dead styles left behind by the deletions (above).
- **Subscreens:**
  - Temp Chat Code — 7 → 7 (unchanged).
  - Disappearing timer picker — 2 → n/a (removed).
  - Auto screen lock picker — 2 → 7.5. Wired, with radio state and save rollback. A note appears when MFA is off (`:322-326`).
  - Privacy section — 2 → 8. Only the real Notifications link remains (`:333-345`).
  - Export section — 3 → n/a, replaced by the Vault row — 7.5.
- **Still needed for 10/10:**
  1. Tick the expiry countdown and clear the code when it expires (`:201-209`, `:254-256`).
  2. Add roles and labels to Copy, Share, Revoke and Generate (`:258-292`). Add hitSlop to the back button (`:220`). Hide the decorative emoji (`:227`, `:239`, `:299`).
  3. Remove the dead styles listed above, and type `value` in `saveSetting` (`:117`, `any`).
  4. Tokenise `#9CA3AF`, `#FF4D6D`, the rgba values and `#00000088` (listed above).
  5. Handle the `loadSettings` failure (`:114`) and `copyAndAutoClear` rejection (`:152-157`).

#### `app/vaultbeam-settings.tsx` — **5.5 → 6.5**
- **Scores now:** Function 5 · States 7 · UI 6.5 · A11y 8 · Security 7 · Code 6
- **Original items:**
  1. ✅ The roaming toggle is removed, with the reason given (`app/vaultbeam-settings.tsx:74-76`).
  2. ✅ The double inset is fixed with `paddingTop: 4`; the route is in INSET_SCREENS (`:138-141`; `app/_layout.tsx:222`).
  3. ✅ `Radio` has the radio role with selected/checked state and a label (`:113-114`), and the Switches are labelled (`:131`).
  4. ◐ The Switch now has a `false` track colour (`:131`). ❌ `colors as any` and `any` props remain (`:31`, `:102-124`).
  5. ✅ Persistence failures are surfaced: `saveSettings` rejects (`lib/vaultBeamSettings.ts:103-108`), and the screen shows a polite live-region notice (`:25-29`, `:54-59`).
- **Regressions:** none.
- **Subscreens:**
  - Auto-download options — 4 → 5.5. Every visible control is read by `lib/vaultBeamAutoDownload.ts:51-83`, but the feature is still off (`VB_AUTODOWNLOAD`, disclosed at `:47-52`).
- **Still needed for 10/10:**
  1. The feature itself is disabled by flag (`:47-52`). Function stays capped until it ships.
  2. "Mobile data only" combined with "Only on unmetered networks" can never download, because cellular counts as expensive (`lib/vaultBeamAutoDownload.ts:67`, `:72`). Disable or explain the contradiction.
  3. Type the palette and props instead of using `any` (`:31`, `:102-124`). Use theme tokens instead of `BRAND_ACCENT` (`:119`, `:131`).

#### `app/encrypted-notes.tsx` — **5.0 → 6.0** (mean 5.75)
- **Scores now:** Function 7 · States 6.5 · UI 5 · A11y 5 · Security 7 · Code 4
- **Original items:**
  1. ✅ Data loss after a failed load is blocked. `loadState` and `loadOk` gate `saveNotes` (`app/encrypted-notes.tsx:194-278`), and a banner opens Backup (`:727-734`). `getDEK(create=false)` on decrypt paths means no new key is minted silently on read (`lib/notesCrypto.ts:23-36`, `:68`, `:101`). ◐ See regression 1: the attachment path can still mint one.
  2. ❌ The AppState listener still closes the editor on any non-active state (`:140-151`). That discards drafts, and possibly mid-attach on Android (not verifiable statically). Deferred: P2 D6.
  3. ✅ Removing an attachment takes effect on Save (`:368-373`, `:429-432`), and Cancel deletes newly added attachments (`:375-381`; `onRequestClose` at `:815`). ❌ There is no confirmation before Cancel discards edits (`:819`).
  4. ✅ "Delete Forever" is confirmed (`:469-479`). `saveNote` has an in-flight ref and try/catch (`:407-444`), and the Replace branches have try/catch (`:588-593`, `:623-629`).
  5. ❌ The gate is still UI-only. `loadNotes` runs at mount before the PIN (`:210`), and `notes` are not cleared on re-lock (`:141-148`).
  6. ◐ PinPad keys are labelled (`components/PinPad.tsx:64-87`) and Cancel has a role (`:693`). ❌ Still unlabelled or without roles: back (`:708`, label but no role), the 🔑 generator (`:740`), category chips (`:747`, `:751`), the markdown toolbar (`:865`), colour dots (`:913`), tag chips (`:922`), and the Sensitive, PIN Lock and Reminder toggle rows, which have no switch role (`:931-951`).
  7. ❌ The 56/44 header padding is still hard-coded (`:1169`, `:1215`, read via the style block). RN `Text` is still used (`:21`). Hex colours remain: `#555` placeholders (`:739`, `:834`, `:873`, `:916`, `:1093`, `:1098`), `#ff6b6b` (`:1052`), `#EF4444` (`:902`, `:948`), `#FFF`/`#fff` (`:811`, `:998`).
  8. ❌ It is still one component, now 1271 lines. The reminder picker is still Android-only (`:500-518`, `DateTimePickerAndroid`).
- **Regressions:**
  1. With `loadState === 'failed'`, the editor and its Attach button stay usable (FAB `:810`, attach `:887`). `addAttachment` → `encryptBytesToString` → `getDEK()` with `create=true` (`lib/notesCrypto.ts:83-84`) mints and stores a stand-in DEK. "Recover key from backup" then reports `occupied` and needs the destructive Replace (`:617-631`). Block the editor and attachments while the load has failed.
  2. The Save button reports `accessibilityState.disabled` when `loadState !== 'ok'` but stays pressable (`:827`). The state does not match the behaviour.
- **Subscreens:**
  - PIN gate — 6 → 7.
  - Notes list, search and categories — 6 → 6.
  - Note editor — 4 → 6.
  - Markdown preview — 7 → 7.
  - Password generator — 7 → 7 (still no `onRequestClose`, `:971`).
  - Image viewer — 6 → 6.
  - Secure Trash — 5 → 7 (confirm, `onRequestClose`, labelled Delete Forever; Restore has no role, `:1023`).
  - Locked-note challenge — 7 → 7.5 (labelled keypad; `#ff6b6b` with no live region, `:1052`).
  - Backup & restore — 6 → 7 (Replace has try/catch; blocked on a failed load). "Change passphrase" still re-wraps without checking the old one (`:1107-1112` → `:528-544`).
- **Still needed for 10/10:**
  1. Block the editor and attachments while `loadState === 'failed'` (regression 1).
  2. Load notes only after the gate opens, and clear `notes` on re-lock (`:210`, `:141-148`).
  3. Keep the draft when the app backgrounds, or ignore transitions caused by system pickers (`:141-148`). Confirm before Cancel discards edits (`:819`).
  4. Require the current passphrase before "Change passphrase" (`:1107-1112`).
  5. A11y: add roles and labels to the controls listed in item 6, give the toggle rows switch role and state, and give the trash cards an accessible action instead of long-press only (`:767`).
  6. Use `HEADER_TOP`, `AppText`, and tokens for the hex values listed in item 7.
  7. Split the component into gate, list, editor and backup. Provide an iOS reminder picker or hide the row off-Android (`:500`). Add `onRequestClose` to the password generator (`:971`). Delete the exported `.vcnotes` file after sharing (`:557-563`).

#### `app/d2de-status.tsx` — **5.0 → 7.0**
- **Scores now:** Function 6 · States 8 · UI 7.5 · A11y 6.5 · Security 7 · Code 8
- **Original items:**
  1. ✅ The key is now `'Secure Keystore'`, matching the service (`app/d2de-status.tsx:22`; `services/d2deService.ts:58`).
  2. ✅ The Firestore, "non-exportable even with root", competitor and roadmap copy is gone (`:17-23`, `:77-82`).
  3. ✅ The screen is retitled as a build readout, with "in this build" and ON/OFF wording (`:1-4`, `:38`, `:46`, `:52-57`). The Settings subtitle matches (`app/settings.tsx:477`).
  4. ✅ It uses `colors.success`, `colors.border` and `accentOn` (`:49`, `:62-67`, `:94`).
- **Regressions:** none.
- **Still needed for 10/10:**
  1. The safety-number advice is plain text (`:77-82`). Link it to the contact-info and safety-number screen.
  2. A11y: mark the score bar as decorative or give it a label (`:47-51`). Group each layer card into one accessible element ("TLS 1.3, ON, …"), and give the score card a header role.
  3. "TLS 1.3" and "keys kept in the OS secure storage" (`:18`, `:22`) are claims this screen cannot check: not verifiable statically. Word them as build intent, or verify them at runtime.

---

## Appendix B — Round 2 re-rating (36 screens)

### X1 — Root/auth, tabs & links, chat, chat tools, media — round-2 re-rating

This is a static, read-only review from round-1 base `29b9634` to `HEAD` (`26b8d60`), using the same rubric (`RUBRIC.md`) and output format (`RERATE.md`).
- **Baselines:** the "New" scores in `rerate/{A,B,C1,C2,F}.md`.
- **Fix claims checked against the code:** `fixes/R1.md` and `fixes/R2.md`, plus the lead's handoffs (alerts verdict hold, `lib/push.ts` family-alert opener, the index verdict skip, chat Star/Remind, file-preview `isOwnServerUrl`, `lib/onboarding.ts` `recoverMpin`, and the chatLockFactors/orphanRoutes selftests). R3–R5 touch none of these screens.
- **What I read:** every changed hunk, every cited region in context, and the changed helpers: `lib/pendingLink.ts`, `lib/securityVerdict.ts`, `lib/launchGate.ts`, `lib/authNav.ts`, `components/ResumeLock.tsx`, `lib/push.ts`, `lib/onboarding.ts`, `lib/callLog.ts`, `lib/serverOrigin.ts`, `lib/wallpaperFile.ts`, `lib/bookmarkBodies.ts`, `lib/chatExportFormat.ts`, `lib/localDb.ts:399-412,1112-1122`.

**Evidence I ran myself.** Nothing was device-tested or deployed.
- These `npx tsx` selftests all exited 0: pendingLink, securityVerdict, launchVeil, orphanRoutes (51), chatLockFactors (now passes, so the handoff landed), chatLockReceipts, serverOrigin, wallpaperFile, callHistory, bookmarkBodies, a11yCoverage, themeCoverage (22/20), screenBackCoverage, chatExportFormat, resumeLockPolicy and startupColdPath.
- `npx eslint` on the 14 screens gave 0 errors and these warnings:
  - `_layout.tsx`: 1 (the deps warning on the gate effect, `:308`).
  - `chat.tsx`: 34. The `1512` mention-deps warning is gone.
  - `media-viewer.tsx`: 5.

**Rounding.** Each overall score is the mean of the six dimensions, rounded to the nearest 0.5. Ties round up, the same convention as round-1 C2. Four screens land exactly on a tie (app-lock, i/[token], message-reminder, file-preview), so each of them is at most 0.5 above the other way of rounding.

| Screen | Old | New | Δ |
|---|---|---|---|
| `app/_layout.tsx` (root shell) | 7 | 7 | 0 |
| `app/index.tsx` | 7.5 | 7.5 | 0 |
| `app/app-lock.tsx` | 7 | 7.5 | +0.5 |
| `app/blocked.tsx` | 7 | 7.5 | +0.5 |
| `app/(tabs)/alerts.tsx` | 7.5 | 7.5 | 0 |
| `app/(tabs)/calls.tsx` | 7.5 | 7.5 | 0 |
| `app/i/[token].tsx` | 6.5 | 7 | +0.5 |
| `app/chat.tsx` | 7.5 | 7.5 | 0 |
| `app/bookmarks.tsx` | 7.5 | 7.5 | 0 |
| `app/chat-export.tsx` | 6 (UNWIRED) | 7 | +1 |
| `app/chat-wallpaper.tsx` | 7 | 7 | 0 |
| `app/message-reminder.tsx` | 7 | 7.5 | +0.5 |
| `app/media-viewer.tsx` | 6 | 6 | 0 |
| `app/file-preview.tsx` | 7 | 7.5 | +0.5 |

---

#### `app/_layout.tsx` — **7 → 7**
- **Scores now:** Function 6.5 · States 8 · UI 7 · A11y 7 · Security 8 · Code 4.5 (avg 6.83)
- **Round-1 "still needed" items:**
  1. Tap and verdict ordering against the launch gate:
     - ✅ Verdict ordering: `holdSecurityVerdict(report); await launchAllowed; router.replace('/blocked')` (`app/_layout.tsx:393-397`). The veil also latches on `/blocked` (`:331`).
     - ✅ Tap ordering: every notification tap goes through `openLink` → `openWhenUnlocked` (`:437-440`, `lib/pendingLink.ts:144-153`). This covers the native intent (`:702`, `:707`), the cold family alert (`:827`), `attachTapHandler` (`:850-868`), and the foreground family-alert tap via the new 5th parameter (`lib/push.ts:216`, `:235-238`).
     - ◐ What is still open:
       - Call routes are deliberately ungated (R1 P1).
       - The allowed cold path still loses a tap: `openWhenUnlocked` opens on `/` (`lib/pendingLink.ts:151`), and `app/index.tsx:51` then `replace`s the top entry.
       - Deep links that expo-router itself opens are not refused while `/blocked` stands.
  2. ◐ Resume ordering is designed in: `ResumeLock` publishes each decision before acting on it (`components/ResumeLock.tsx:45-55`), and app-lock replays held taps (`app/app-lock.tsx:41-49`). The `router.back()`-then-`push` ordering is not verifiable statically.
  3. ❌ The resume lock is still MFA-only (`components/ResumeLock.tsx:31`).
  4. ◐ The file is not split (1117 lines, up from 1081). `as any` went from 13 to 8, because the taps now share `openLink`.
  5. ❌ The ErrorBoundary remount and copy are unchanged (no diff). The same holds for item 6, UpdateGate/TermsGate.
- **Regressions (introduced in round 2):**
  - **Notification taps never open after a locked or signed-out cold start (high).** `launchAllowed` is a once-per-process promise (`lib/launchGate.ts:52`). It resolves `false` on the `/onboard` and `/app-lock` branches and on the catch (`app/_layout.tsx:284`, `:289`, `:303`). `openWhenUnlocked` opens only when `allowed` is true and stashes otherwise (`lib/pendingLink.ts:150-152`). So:
    - For every MFA user, every sealed-session user, and anyone who signed in during this launch, all later chat, games, family-alert and membership taps are stashed and never opened.
    - An MFA user gets them only at the next resume relock (`app/app-lock.tsx:47-48`), possibly much later and for a stale tap.
    - A sealed-only user (no ResumeLock) and a fresh sign-in never get them.
    - The selftest only covers `Promise.resolve(true|false)` against a fixed path (`lib/pendingLink.selftest.ts:129-161`), never "locked at launch, unlocked since".
    - Fix: pass a live "unlocked" signal instead of the launch promise. Either flip a module flag in `resetTo` or `enter()`, or treat `allowed === false` as open once `currentPath()` is no longer a lock or auth route.
  - The root now re-renders on every global search-param change (`useGlobalSearchParams`, `:240-242`), only to compute `launchHref`, which is read once. This is minor.
- **Subscreens:**
  - Launch veil — 8 → 8. The `/blocked` latch is added (`:331`).
  - ResumeLock — 7 → 7.5. The decision is published before the push (`components/ResumeLock.tsx:45-55`), and a stale decision is cleared on lock routes (`:41-43`). It is still MFA-only.
  - UpdateGate — 6.5 → 6.5.
  - TermsGate — 7.5 → 7.5.
  - ErrorBoundary — 7 → 7.
  - UsageCounter — 8.5 → 8.5.
  - CallBar — 7 → 7.
- **Still needed for 10/10:**
  1. Fix the stashed-forever tap regression above (`lib/pendingLink.ts:150-152`, `app/_layout.tsx:437-440`). Add a selftest for "launch false, then unlocked, then tap opens".
  2. Stop `app/index.tsx:49-51` from overwriting a cold-start tap. Hold taps while the path is `/`, and have index replay `consumeLaunchLink()` instead of always going to `/(tabs)/chats`.
  3. Extend ResumeLock to sealed-session users (`components/ResumeLock.tsx:31`).
  4. Split call routing, notification ingest and boot work into hooks, and drop the 8 remaining `as any`.
  5. ErrorBoundary remount and copy. UpdateGate fallback and recheck. TermsGate polling and ScrollView. These are unchanged from round 1.

#### `app/index.tsx` — **7.5 → 7.5**
- **Scores now:** Function 8 · States 7 · UI 6 · A11y 7 · Security 8 · Code 8
- **Round-1 items:** ❌ The header comment is still stale (`app/index.tsx:1-8`). ❌ There is still no retry or exit if a replace throws (`:52-57`). ❌ The colour literal remains (`:100`).
- **Lead handoff:** ✅ `if (securityVerdict()) return;` after the gate (`:47`). Either order now ends on `/blocked`, because the layout's replace runs after `launchAllowed` (`app/_layout.tsx:396-397`).
- **Regressions:** none.
- **Subscreens:** Fallback splash — 7 → 7.
- **Still needed for 10/10:**
  1. Replay a held tap or link instead of always going to `/(tabs)/chats` (`:51`; see root #2).
  2. Fix the stale header (`:1-8`).
  3. Give the splash fallback a way out when routing throws (`:52-57`).
  4. Take the splash colour from a shared constant (`:100`).

#### `app/app-lock.tsx` — **7 → 7.5**
- **Scores now:** Function 8 · States 7.5 · UI 7 · A11y 7 · Security 7 · Code 7 (avg 7.25, tie rounded up)
- **Round-1 items:**
  1. ✅ Back is consumed only while this screen is focused (`useFocusEffect`, `app/app-lock.tsx:64-67`), so hardware Back works on `/mpin-recover` again.
  2. ❌ The sealed-PIN `TextInput` is still unlabelled (`:148-159`).
  3. ❌ `tryBiometric` still has no unmount guard (`:78-81`). MPIN errors still pass through raw (`:131`).
  4. ◐ Resume routing replays held taps after unlock (`:41-49`). The lock is still MFA-only.
- **Also fixed:** an MPIN unlock and a recovery no longer overwrite the cached profile with `{id}` (`lib/onboarding.ts:173-174`, `:220-222`). This also closes R1 P4.
- **Regressions:** none in this file. However, `enter()` is where the root's stashed taps come back (`:47-48`), so with the root regression an MFA user can be sent to a long-stale tap here after a relock. The `router.back()` then `router.push()` ordering is not verifiable statically.
- **Subscreens:**
  - Sealed PIN — 7 → 7.
  - Biometric — 7 → 7.
  - MPIN mode — 7.5 → 8. Forgot MPIN now navigates and returns correctly, and the profile is kept.
  - Forgotten PIN Alert — 7 → 7.
- **Still needed for 10/10:**
  1. Label the sealed-PIN input (`:148`) and `MpinInput`.
  2. Add an unmount guard to `tryBiometric` (`:78-81`). Map offline errors in MPIN mode (`:131`).
  3. Make sure only fresh holds are replayed (root regression), and cover sealed-session users on resume.

#### `app/blocked.tsx` — **7 → 7.5**
- **Scores now:** Function 8 · States 7 · UI 7 · A11y 7 · Security 8.5 · Code 7.5
- **Round-1 items:**
  1. ✅ The verdict is no longer taken from route params. The screen reads `useState(securityVerdict)` (`app/blocked.tsx:133-138`). Only `restrict`/`wipe` are held (`lib/securityVerdict.ts:24-27`), and a crafted `?level=wipe` gets the neutral view (`:163-180`). `lib/securityVerdict.selftest.ts` passes.
     - ◐ Taps are held while `/blocked` is up, because it is in `LOCK_OR_AUTH` (`lib/pendingLink.ts:128`).
     - Call routes are not held, and neither are links opened by expo-router itself, so "refuse other navigation" is only partly done.
  2. ✅ The verdict is ordered after the launch gate (`app/_layout.tsx:396-397`). Both scan callers hold the verdict first: the launch scan (`:393`) and the alerts tab (`app/(tabs)/alerts.tsx:120`).
  3. ❌ Literal colours remain: `#FFFFFF` and the rgba values (`:308`, `:320`, `:356`, `:427`).
- **Regressions:** none.
- **Subscreens:**
  - Contact Support Alert — 7.5 → 7.5.
  - "Nothing is blocked" — 8 → 8.5. It is now also the safe landing for crafted links.
- **Still needed for 10/10:**
  1. Refuse non-call navigation while a verdict is held, including deep links (root layout).
  2. Tokenise `:308`, `:320`, `:356` and `:427`.

#### `app/(tabs)/alerts.tsx` — **7.5 → 7.5**
- **Scores now:** Function 9 · States 7 · UI 7 · A11y 6 · Security 8 · Code 8
- **Lead handoff:** ✅ `holdSecurityVerdict(report)` runs before the `/blocked` replace (`app/(tabs)/alerts.tsx:120-121`). Without it, round 2 would have regressed a real scan verdict to the neutral view.
- **Round-1 items:**
  - ❌ `refreshing={false}` is unchanged (`:237`).
  - ❌ The background sync has no `alive` guard (`:99-103`).
  - ❌ Rows have no role or expanded state (`:154-158`).
  - ❌ `SEV_COLOR` is hex (`:29-35`), and so is the `bannerBad` rgba (`:277`).
- **Regressions:** none. The replace still passes `threats`/`level` params that `/blocked` now ignores (`:121`). This is dead data, not a fault.
- **Subscreens:**
  - Expanded event details — 6 → 6.
  - Scan confirmation — 8 → 8.
- **Still needed for 10/10:**
  1. Real `refreshing` state, and an error bar when a list is already shown (`:237`).
  2. An `alive` guard (`:99-103`).
  3. Row role and expanded state (`:154-158`).
  4. Theme tokens for `SEV_COLOR` and `bannerBad` (`:29-35`, `:277`).
  5. Drop the unused params (`:121`).

#### `app/(tabs)/calls.tsx` — **7.5 → 7.5**
- **Scores now:** Function 8 · States 8 · UI 7 · A11y 8 · Security 8 · Code 7 (avg 7.67)
- **Round-1 items:**
  1. ✅ Write failures are reported:
     - `removeCallLog`, `clearCallLog` and `hideServerCalls` now reject (`lib/callLog.ts:87-96`, `:121-130`).
     - Rows are dropped only after the writes succeed, with an Alert otherwise (`app/(tabs)/calls.tsx:149-158`, `:187-197`).
     - An unreadable store is no longer rewritten as empty, because the throwing readers are used (`lib/callLog.ts:61-64`, `:112-115`). `addCallLog` also uses one (`:74`).
     - The `callHistory` selftest passes.
  2. ❌ A failed server merge is still silent (`calls.tsx:109-111`).
  3. ❌ The info backdrop is still the parent of the sheet, and there is no Close button.
  4. ◐ The header comment is fixed (`:6-7`). `DirArrow` is still declared in render (`:201`), and `renderItem` is not memoised (`:210`).
  5. ❌ Sheet rows are still keyed by index (outside this screen).
- **Regressions:** minor. In a mixed group, `removeCallLog` can succeed and `hideServerCalls` then fail (`:151-152`). The local rows are then already deleted while the row stays on screen with "The call is still in your call history" (`:155`), which is only partly true.
- **Subscreens:**
  - Call actions sheet — 8 → 8.
  - Call info modal — 8 → 8.
  - Remove/Clear confirmations — 8 → 9. Failures are now surfaced.
- **Still needed for 10/10:**
  1. A notice when the merge fails (`:109-111`).
  2. Make the backdrop a sibling of the sheet, and add a Close button.
  3. Hoist `DirArrow` (`:201`), wrap `renderItem` in `useCallback` (`:210`), and key Sheet rows by label.
  4. Accurate copy for a partial remove (`:155`).

#### `app/i/[token].tsx` — **6.5 → 7**
- **Scores now:** Function 4 · States 7.5 · UI 7 · A11y 7 · Security 7 · Code 8 (avg 6.75, tie rounded up)
- **Round-1 items:**
  1. ✅ Cancel is effective. `cancelledRef` is set on Cancel and on unmount (`app/i/[token].tsx:35`, `:89`), and the result or error is ignored after that (`:44`, `:48`). The hint states honestly that a join the server already accepted still completes (`:92`).
  2. ❌ The legacy route is not retired. Function stays 4: nothing in the app produces these tokens, per round 1.
  3. ❌ The unverifiable `https://vaultchat.app/i/` claim is still in the header (`:4`).
  4. ❌ `colors.primary + '1a'` and `colors.danger + '1a'` are still built by hex concatenation (`:70`, `:99`), and the `StyleSheet` is static (`:117-125`).
- **Regressions:** none.
- **Subscreens:**
  - Error state with retry — 7 → 7.
  - Redeeming phase — the Cancel fault is fixed.
- **Still needed for 10/10:**
  1. Retire the route, or give it a producer.
  2. Drop the header URL claim (`:4`).
  3. Use `makeStyles` and alpha helpers (`:70`, `:99`, `:117-125`).

#### `app/chat.tsx` — **7.5 → 7.5**
- **Scores now:** Function 8.5 · States 9 · UI 7 · A11y 8 · Security 8.5 · Code 5 (avg 7.67)
- **Round-1 items:**
  1. Invisible Ink and view-once copies:
     - ✅ The pinned bar no longer shows ink text. It reads "Invisible Ink message" in both the text and the label (`app/chat.tsx:3808`), and it renders only while the chat is open (`:3798`).
     - ✅ Star stores no snapshot for view-once or ink messages (`:1666`, `:1691`).
     - ✅ Remind passes "Protected message" instead of the text (`:1696`).
     - ◐ Remind is still offered for these messages. The Reminders list then re-reads the text from the local cache with no `meta.invisibleInk`/`viewOnce` check (`app/message-reminder.tsx:90-95`, `lib/localDb.ts:399-406`), so ink text still shows in plain view there.
  2. Lock gate:
     - ✅ The backoff message: "Too many attempts. Try again in N s." (`:3303-3309`). The chatLockFactors selftest passes.
     - ✅ The message list is hidden from assistive tech while locked (`:3852-3853`), and the veil has `accessibilityViewIsModal` (`:4611`).
     - ◐ On Android, the veil's siblings (the reply/edit bars and the composer draft) are not hidden (R2 Partial #2). This needs a device check.
  3. ◐ The stale `chat` closure is fixed: `chat?.type` is in the deps (`:1512`), and eslint no longer flags it. Mentions are still first-name only and ASCII-only.
  4. ❌ GIF and Forward still bypass the outbox (`:2743`, `:2303`).
  5. ❌ Search still opens the inline bar (`:2028-2030`).
  6. Groups and embedded mode:
     - ❌ Groups still have no Clear or Leave; only `if (peer)` gets them (`:2131`).
     - ✅ Embedded mode no longer pops the split screen: `if (!embedded) router.back()` (`:2222`, `:2241`).
  7. ❌ The notification-sound picker still has no `selected` mark (`:1942-1955`).
  8. ❌ Theme: the live-location rgba (`:3777`), the view-once badge at `top: 100` (`:4466`), and the `chatStyles.ts` palettes are unchanged.
  9. ❌ A11y: there is still no bubble summary label. The Info, photo and attach modals have no modal flag (`:4292`, `:4334`, `:4372`).
  10. ❌ Code: 4674 lines, and `as any` went from 45 to 46 (the export push). Seven hook-deps warnings remain (`:560`, `:1659`, `:1810`, `:1902`, `:2250`, `:2408`, `:2687`).
  11. ❌ Message Info and multi-select are unchanged.
- **New wiring:** ✅ "Export chat" is in the ⋮ menu (`:2033-2041`), and `lib/orphanRoutes.selftest.ts:90` asserts it.
- **Regressions:**
  - The new Export entry makes view-once and Invisible Ink text exportable to a plain file. `exportBody` has no `meta` check (`lib/chatExportFormat.ts:14-28`), and `app/chat-export.tsx:104` prints every hydrated message, whereas Forward and Copy refuse these messages (`app/chat.tsx:1681`). Before this change the screen was unreachable in-app.
  - `as any` went up by 1 (`:2037`).
- **Subscreens that changed** (all others keep their round-1 C1 score):
  - Message thread — 7.5 → 8. It is hidden from assistive tech under the veil.
  - Overflow menu and pickers — 8 → 8. Export was added; the sound picker still has no mark.
  - Pinned-message bar — 7 → 8.5. The ink leak is closed, and the bar is hidden while locked.
  - Memory Bubble — 6.5 → 7. It is hidden while locked (`:3749`).
  - @mention picker — 6 → 7. The closure is fixed.
  - Long-press MessageActionSheet — 8 → 8.5. Star and Remind are protected; Remind is still offered.
  - Per-chat lock gate — 7.5 → 8.5. Backoff copy, input clear, and assistive-tech hiding.
  - Embedded split-pane mode — 7 → 8.
- **Still needed for 10/10:**
  1. Exclude view-once and ink messages from exports, or render them as `[Protected message]` (`lib/chatExportFormat.ts:14`, `app/chat-export.tsx:104`). Hide Remind for these messages, or have the Reminders list honour `meta` (`app/message-reminder.tsx:90-95`).
  2. Hide the composer and reply/edit bars from assistive tech while the chat is locked on Android (`:4611` covers iOS only).
  3. Route GIF and Forward through the outbox (`:2743`, `:2303`).
  4. Search: route to `/in-chat-search`, or add prev/next (`:2028-2030`).
  5. Groups: Clear chat and Leave group (`:2131`).
  6. Mark the current notification sound (`:1946`).
  7. Tokenise `:3777`, the `chatStyles.ts` palettes and the ConnectionBanner dark contrast. Inset the view-once badge (`:4466`).
  8. A11y: a bubble summary label, and modal flags on `:4292`, `:4334` and `:4372`.
  9. Split the 4674-line file. Cut the 46 `as any` and the seven deps warnings.

#### `app/bookmarks.tsx` — **7.5 → 7.5**
- **Scores now:** Function 8 · States 7.5 · UI 7.5 · A11y 7.5 · Security 8 · Code 7.5 (avg 7.67)
- **Round-1 items:**
  1. ✅ Locked chats show "🔒 Locked chat". There is one `isChatLocked` per distinct chat, and an error fails closed (`app/bookmarks.tsx:46-57`). Bodies are never read for locked chats. The cached paint path also goes through `withBodies` (`:83`).
  2. ◐ Refresh: the empty `ScrollView` still has no `RefreshControl` (`:163`; only the list has one, at `:175`). A failed refresh with a cache is still silent (`:97-99`).
  3. ❌ Dead code remains: the `'(deleted chat)'` fallback (`:194`), `as any` (`:120`) and `backTxt` (`:242`).
- **Also:** new Stars of view-once or ink messages store no snapshot (`app/chat.tsx:1691`).
- **Regressions:** none.
- **Still needed for 10/10:**
  1. Bookmarks of ink or view-once messages made before this fix still show their sealed snapshot, because `withBodies` does not check `meta` (`:53-60`). Purge or hide those.
  2. Pull-to-refresh on the empty state, and a "showing saved copy" hint (`:97-99`, `:163`).
  3. Remove the dead code (`:120`, `:194`, `:242`).

#### `app/chat-export.tsx` — **6 → 7** (now wired)
- **Scores now:** Function 7.5 · States 7.5 · UI 6 · A11y 7.5 · Security 6.5 · Code 6.5 (avg 6.92)
- **Round-1 items:**
  1. ✅ Wired from the chat ⋮ menu for 1:1 and group chats (`app/chat.tsx:2033-2041`). The orphanRoutes selftest asserts it (`lib/orphanRoutes.selftest.ts:90`).
  2. Lock PIN prompt:
     - ✅ The backoff copy: `pinRetryAfterMs`, giving "Too many attempts. Try again in N s.", or "Incorrect PIN." otherwise. The input is cleared, and the error is a live region (`app/chat-export.tsx:133-139`, `:338`).
     - ❌ There is still no digit filter, and `maxLength={12}` (`:330-333`).
  3. ❌ The truncation warning still shows after the share sheet (`:212-214`).
  4. ❌ `'#00000099'`, `'#FFFFFF'` and `BRAND_ACCENT` remain in RN styles (`:374`, `:344`, `:380`).
- **Regressions:** now that the screen is reachable, view-once and Invisible Ink text are exported in plain text. `exportBody` (`lib/chatExportFormat.ts:14-28`) and `bodyOf` (`:104`) never consult `meta`. This bypasses the in-place-only rule that Forward and Copy enforce (`app/chat.tsx:1681`). Whether a viewed view-once body is still present after hydration is not verifiable statically.
- **Subscreens:** Chat-lock PIN modal — 6.5 → 7.5.
- **Still needed for 10/10:**
  1. Render protected messages as `[Protected message]` in `exportBody`, and add a selftest case.
  2. Warn about truncation before sharing (`:212-214`).
  3. Digits only, with `maxLength={8}` (`:330-333`).
  4. Tokens instead of `:344`, `:374` and `:380`.

#### `app/chat-wallpaper.tsx` — **7 → 7**
- **Scores now:** Function 7.5 · States 6.5 · UI 7.5 · A11y 7.5 · Security 7.5 · Code 6 (avg 7.08)
- **Round-1 items:**
  1. ❌ `PreviewBg` is still an inline component (`app/chat-wallpaper.tsx:141-155`).
  2. ✅ The replaced copy is deleted after the new choice is stored (`:107-111`), and a fresh copy is deleted if storing fails (`:117-118`). The rule is pure and tested (`lib/wallpaperFile.ts:13-28`, selftest passes). Each storage key loads only its own value (`:83-89`), so one key never deletes a file that another key references.
  3. ❌ The save model is unchanged: back discards with no prompt (`:162`), and Reset only changes the selection (`:123`).
  4. ❌ There is still no `saving` guard (`:92`). A double tap still copies twice, and the two saves can read the same `prevRaw` (`:106`), leaving one copy orphaned. `launchImageLibraryAsync` is still not in a try/catch (`:131-134`).
  5. ❌ Colour tiles still announce hex codes.
- **Regressions:** none.
- **Subscreens:**
  - Colors — 7.5 → 7.5.
  - Gradients — 7.5 → 7.5.
  - My photo — 7 → 7.5. The leak is fixed.
- **Still needed for 10/10:**
  1. Hoist `PreviewBg` (`:141`).
  2. Add a `saving` guard (`:92`), and a try/catch around the picker (`:131`).
  3. One save model: prompt on back with unsaved changes (`:162`).
  4. Human-readable colour names.

#### `app/message-reminder.tsx` — **7 → 7.5**
- **Scores now:** Function 7.5 · States 7 · UI 7.5 · A11y 7 · Security 7.5 · Code 7 (avg 7.25, tie rounded up)
- **Round-1 items:**
  1. ✅ Locked chats show "🔒 Locked chat". There is one `isChatLocked` per chat, and an error fails closed (`app/message-reminder.tsx:252-261`).
  2. ❌ The copy is still wrong: "⏰ Remind me about this" (`:311`) and "Settings → Reminders" (`:234`).
  3. ❌ A storage failure still reads as "No reminders" (`:85`). The cancel path's `saveReminders` is still uncaught (`:286`).
  4. ❌ `as any` (`:167`) and `backTxt` (`:353`) remain.
- **Also:** the composer now receives "Protected message" for view-once and ink messages (`app/chat.tsx:1696`).
- **Regressions:** none new. One pre-existing gap: `cachedText` shows any readable cached text, including Invisible Ink and view-once text, because it never checks `m.meta` (`:90-95`).
- **Subscreens:**
  - Composer — 7.5 → 7.5.
  - Reminders list — 7 → 7.5.
- **Still needed for 10/10:**
  1. In `cachedText`, return null or "Protected message" when `m.meta?.invisibleInk || m.meta?.viewOnce` (`:90-95`).
  2. Fix the copy (`:234`, `:311`).
  3. Surface load and cancel storage errors (`:85`, `:286`).
  4. Remove `as any` and `backTxt` (`:167`, `:353`).

#### `app/media-viewer.tsx` — **6 → 6**
- **Scores now:** Function 7 · States 6 · UI 4 · A11y 6 · Security 8 · Code 5
- **Round-1 items:**
  1. ✅ The bearer token now goes only to our own server, via `isOwnServerUrl`, for the CodeViewer (`app/media-viewer.tsx:194`), for the player `source` (`:311`), and for Save (`:438`).
     - `isOwnServerUrl` rejects lookalike hosts, `@` userinfo, other ports and http downgrades (`lib/serverOrigin.ts:12-18`), and its selftest passes.
     - `attachmentUrl` builds on the same `SERVER_URL` (`lib/chatService.ts:3081-3082`), so our own media still gets auth. That media actually loads is not verifiable statically.
  2. ❌ There is no seekable track and no pinch or pan. The header still promises "zoom, pan" (`:2`).
  3. ❌ `ArchiveCard` and `GenericViewer` are still defined in render (`:465`, `:477`).
  4. ❌ 43 hex literals remain.
  5. ❌ There is no Retry. `Alert.alert('Error', e.message)` remains (`:450`), as does the raw `e?.message` (`:423`).
- **Regressions:** none.
- **Subscreens:**
  - CodeViewer — 6.5 → 7.
  - ImageViewer — 4.5.
  - VideoPlayer — 5.
  - AudioPlayer — 6.
  - ArchiveCard — 6.5.
  - GenericViewer — 6.
  - "Nothing to show" — 7.5.
  - ProtectedMediaView — 7.5.
- **Still needed for 10/10:**
  1. A seekable video track (`lib/videoSeek.ts`) and pinch/pan, or drop the header claim (`:2`).
  2. Hoist `ArchiveCard` and `GenericViewer` (`:465`, `:477`).
  3. Dark-media tokens instead of hex.
  4. Retry on error, user-facing copy instead of `e.message` (`:423`, `:450`), and typed helpers.

#### `app/file-preview.tsx` — **7 → 7.5**
- **Scores now:** Function 7 · States 8 · UI 7 · A11y 7 · Security 8.5 · Code 6 (avg 7.25, tie rounded up)
- **Lead handoff:** ✅ `isOwnServerUrl(fileUri)` replaces `startsWith(SERVER_URL)` (`app/file-preview.tsx:170`). This closes a token leak to `https://api.corefinite.com.evil.net` or `…@evil.net` from a crafted link.
- **Round-1 items:**
  1. ❌ The tokenizer and maps are still untyped (`:38`, `:51`), and tokens are not memoised.
  2. ❌ `shareFile` and `copyAll` still have no try/catch (`:197-204`).
  3. ❌ The info bar still shows during load and failure. `#4A9FFF22` and `#FFFFFF` remain (`:303`, `:315`).
- **Regressions:** none.
- **Subscreens:** none.
- **Still needed for 10/10:** the same three items, in that order.

---

### X2 — Round-2 re-rating (vault/privacy, storage/live, shop-book/logs, finance, spaces)

Base 29b9634 → HEAD (26b8d60; round-2 commits R5 2309d6e, R3 0055415, R4, R1, R2). Fix claims checked: `fixes/R3.md` and `fixes/R5.md`, plus the lead's handoff to `reminders.tsx`. This is a static, read-only review. Everything here is **written only**: nothing is deployed or device-verified. Where a fix log says "needs device check", the item counts only for what the code shows.

| Screen | Old | New | Δ |
|---|---|---|---|
| app/vault.tsx | 6.0 | 6.5 | +0.5 |
| app/encrypted-notes.tsx | 6.0 | 6.0 | 0 |
| app/status-privacy.tsx | 7.0 | 7.5 | +0.5 |
| app/storage-manager.tsx | 7.0 | 7.0 | 0 |
| app/live-view.tsx | 6.5 | 7.0 | +0.5 |
| app/shop-book.tsx | 6.5 | 6.5 | 0 |
| admin/logs.html | 7.0 | 7.0 | 0 |
| app/finance/customer.tsx | 6.5 | 6.5 | 0 |
| app/finance/reminders.tsx | 7.0 | 7.0 | 0 |
| app/space-admin.tsx | 7.0 | 7.0 | 0 |
| app/space-devices.tsx | 6.0 | 6.5 | +0.5 |
| app/space-roster.tsx | 7.0 | 7.0 | 0 |
| app/space-runs-admin.tsx | 6.5 | 7.0 | +0.5 |

**Checks I ran (all read-only):**
- `npx tsx` selftests, each passing: `lib/vaultManifestParse.selftest.ts`, `lib/statusPrivacySelection.selftest.ts`, `components/finance/notifyIds.selftest.ts`, `lib/spaces/runPlan.selftest.ts`, `lib/notesVault.selftest.ts`, `utils/shopbook.selftest.ts`, `lib/a11yCoverage.selftest.ts` (exit 0) and `lib/themeCoverage.selftest.ts` (22 assertions).
- `npx eslint` on the 11 changed `.tsx` screens, `SpaceLinksSheet.tsx` and `lib/notesCrypto.ts`: 0 errors and 7 warnings. All 7 were already there: exhaustive-deps in `encrypted-notes.tsx:210`, `:296`, `live-view.tsx:475`, `:637` and `storage-manager.tsx:120`, plus unused `Platform` in `live-view.tsx:17` and `storage-manager.tsx:15`.
- `admin/logs.html`: I recomputed the CSP hash with the page's own one-liner. It gives `K1cdc/PRnVAqfP+0IrnK3+SqisG9gkRhrSujfJlRQiA=`, which matches the meta at `:9`.
- I did not run `tsc`, `npm test` or `npm run lint` for the whole repo.

---

#### `app/vault.tsx` — **6.0 → 6.5** (mean 6.58)
- **Scores now:** Function 7.5 · States 7.5 · UI 5 · A11y 7 · Security 7.5 · Code 5
- **Original items:**
  1. ✅ Manifest data loss is fixed.
     - `parseVaultManifest` throws on an unreadable or non-array manifest and treats null as empty (`lib/vaultManifestParse.ts:6-11`).
     - `manifestState` decides the flow (`app/vault.tsx:197`, `:234-244`), and `saveManifest` refuses unless it is `'ok'` (`:246-247`).
     - A failed read shows an alert-role message and a 44pt Retry in place of the list (`:562-582`, `:841`).
     - Add and delete are blocked until a good read (`:308`, `:413`, FAB `:645-652`).
     - If the manifest write fails, the new `.enc` file is deleted (`:291-296`).
  2. ✅ The FAB race is fixed. The FAB is disabled while loading or while the manifest is not ok, with state (`:648-650`). The `adding` ref makes add single-flight across the picker phase (`:308-310`). Add and delete build on `filesRef.current` (`:292`, `:424`), and `filesRef` is updated on every save (`:249`). Concurrency still needs a device check.
  3. ❌ No re-lock when the app goes to background. Only the unmount clears the keys (`:205-208`). Whole files are still read as base64 (`:269`, `:373`).
  4. ❌ The hard-coded colours remain: `#FF4D6D` (`:730`), `rgba(34,197,94,0.14)` (`:824`), `#00000088` (`:847`) and `#FFFFFF` (`:653`, `:842`). The emoji icons remain (`:57-60`, `:543`, `:636`). So do the dead styles `back`, `fabText`, `backupLabel` and `backupInput` (`:747`, `:843`, `:866-867`).
  5. ❌ The back button has no hitSlop or padding (`:486`), and the delete target is still `padding: 4` (`:829`).
  6. ❌ `keyNotice` still says the PIN "was reset", even when the cause is a SecureStore failure (`:523-527`).
- **Regressions:** none. The new Retry text adds one more `#FFFFFF` literal (`:842`), the same pattern as the existing `setBtnText`.
- **Subscreens:**
  - PIN gate — 7.5 → 7.5 (unchanged).
  - File tabs and list — 6.5 → 7.5 (manifest gate, error with retry, FAB race closed).
  - Export file list modal — 7 → 7. It is not gated on the manifest state: after a failed read it shares an empty list and records "Last export" (`:687-688`, `:445-450`).
- **Still needed for 10/10:**
  1. Disable "Export file list" unless `manifestState === 'ok'` (`:495`, `:687-688`). Record "Last export" only after the share returns (`:449`).
  2. Delete: write the manifest before deleting the `.enc` file, or restore the entry if the save fails. Today a failed save leaves an entry pointing at a deleted file (`:423-424`).
  3. Re-lock on background without breaking the system pickers (`:205-208`). Stream large files instead of reading them as base64 (`:269`, `:373`).
  4. Tokenise the colours and replace the emoji (`:57-60`, `:653`, `:730`, `:824`, `:842`, `:847`). Remove the dead styles (`:747`, `:843`, `:866-867`).
  5. Add hitSlop to back (`:486`) and enlarge delete (`:829`).
  6. Reword `keyNotice` when the cause is a storage error (`:523-527`).

#### `app/encrypted-notes.tsx` — **6.0 → 6.0** (mean 5.92)
- **Scores now:** Function 7 · States 7 · UI 5 · A11y 5 · Security 7.5 · Code 4
- **Original items / round-1 regressions:**
  1. ✅ Regression 1 (stand-in DEK). This is fixed in two layers:
     - On screen: `openEditor` refuses unless `loadOk` (`app/encrypted-notes.tsx:298-304`), and `addAttachmentMenu` returns early (`:367`). The FAB is disabled with role and state (`:817-825`), and Attach is disabled and labelled (`:902`).
     - In the library: `notesCrypto` sets `storeUnreadable` when a sealed blob fails to open (`lib/notesCrypto.ts:75`, `:82`). `getDEK(create=true)` then throws instead of minting a key (`:33`). The flag clears on a successful decrypt or an import (`:79`, `:143`).
     - Callers checked: `exportDEKHex` in `lib/notesVault.ts:54`, `:84`, `:102` and `:121` now throws while the flag is set, which is the intended outcome. Needs a device check, per the fix log.
  2. ✅ Regression 2. Save is now really `disabled` when not ok (`:842`).
  3. ❌ The AppState listener still closes the editor on any non-active state, which discards drafts (`:140-151`). There is still no confirmation before Cancel discards edits (`:835`).
  4. ❌ Notes still load at mount, before the PIN (`:210`), and `notes` are not cleared on re-lock (`:141-148`).
  5. ❌ "Change passphrase" still does not check the old passphrase (`:1125`).
  6. ◐ A11y: the FAB and Attach are done (`:820-822`, `:902`). The rest of the original list is still open: the generator, chips, the toolbar, colour dots, toggle rows, and the trash cards, which are long-press only (`:774`).
  7. ❌ Hex values remain: `#555` (`:746`, `:849`, `:888`, `:931`, `:1108`, `:1113`), `#EF4444` (`:917`, `:963`), `#ff6b6b` (`:1067`), `#FFF`/`#fff` (`:826`, `:1013`, `:1248`). The reminder picker is still Android-only (`:28`, `:509-514`). The file is 1286 lines long. The exported `.vcnotes` file is not deleted after sharing (`:564-567`).
- **Regressions:** none found. `storeUnreadable` is module state, but it is set only by `decryptNotes`, whose only caller is this screen (`:216`).
- **Subscreens:**
  - Note editor — 6 → 6.5 (blocked on a failed load; Save and Attach states are now honest).
  - Backup & restore — 7 → 7.5 (no replacement key can be minted while the store is unreadable).
  - All others are unchanged: PIN gate 7, list 6, preview 7, generator 7, image viewer 6, trash 7, locked-note challenge 7.5.
- **Still needed for 10/10:**
  1. Load notes only after the gate opens, and clear them on re-lock (`:210`, `:141-148`).
  2. Keep the draft across background transitions caused by system pickers, and confirm before Cancel (`:140-151`, `:835`).
  3. Require the current passphrase for "Change passphrase" (`:1125`).
  4. Add roles and labels to the remaining controls. Give the toggle rows a switch role, and give the trash cards an accessible action (`:774`).
  5. Tokenise the hex values in item 7. Use `AppText`.
  6. Split the component. Provide an iOS reminder picker (`:509`). Delete the `.vcnotes` export after sharing (`:564-567`).

#### `app/status-privacy.tsx` — **7.0 → 7.5** (mean 7.67)
- **Scores now:** Function 7.5 · States 7.5 · UI 8 · A11y 7.5 · Security 8 · Code 7.5
- **Original items:**
  1. ✅ `getStatusPrivacy` now throws on a request failure and on an unexpected `mode`, and normalises `userIds` (`lib/chatService.ts:1830-1836`). Its only caller is `app/status-privacy.tsx:53`, inside the try/catch, so a failure now reaches the error view with retry (`:65-66`, `:105-112`).
  2. ✅ A mode switch starts from an empty selection (`:87`; `lib/statusPrivacySelection.ts:11-13`; selftest passes). Saves go through `privacyUserIds` (`:78`). In "only" mode with nobody picked, a polite live-region note says nobody can see the status (`:141-145`).
  3. ❌ There is still no progress indicator while saving; rows are only disabled (`:125`, `:160`). Mode rows have no explicit `accessibilityLabel` (`:120-128`).
- **Regressions:** none. One trade-off to note: the server keeps one list, so switching away from "except" and back clears the exclusions. The user has to pick again. This is intended and documented (`lib/statusPrivacySelection.ts:1-6`).
- **Subscreens:** Contact selector — 7.5 → 7.5.
- **Still needed for 10/10:**
  1. Show save progress, for example a busy state on the row or a header spinner (`:125`, `:160`).
  2. Give mode rows a label that joins the label and the sub-text (`:120-128`).
  3. When switching from a mode that has a list, confirm before clearing it (`:87`), because the user loses their exclusions silently.

#### `app/storage-manager.tsx` — **7.0 → 7.0** (mean 7.17)
- **Scores now:** Function 8 · States 8 · UI 6.5 · A11y 6.5 · Security 8 · Code 6
- **Original items:**
  1. ✅ `walk()` now rethrows a read error, unless the directory does not exist (`app/storage-manager.tsx:65-71`). That makes `loadFailed` and its retry reachable (`:163`, `:305-312`). The total shows "—" on failure (`:286`). Delete-old now reaches its error alert (`:240-241`).
  2. ❌ `walk` still duplicates the cache manager. `info: any` (`:74`) and the `as any` casts (`:313`, `:331`, `:365`) remain.
  3. ❌ Delete-old still reports no count (`:239`).
  4. ❌ `#FF9F43` remains (`:156`). The full-screen loading state still has no back control (`:252-259`).
  5. ❌ Category rows still have no accessible label (`:309-319`).
- **Regressions:** none. A minor risk, not verifiable statically: a single unreadable subdirectory now fails the whole measurement (`:70`), where before it was skipped. A retry after a failure also leaves the previous `chatStores` on screen (`:132-141` only run on success).
- **Subscreens:**
  - Destructive confirmations — 8 → 8.
  - Load-failed state — 6.5 → 7.5 (now reachable).
- **Still needed for 10/10:**
  1. Reuse `services/cache/cacheManager` instead of `walk` (`:58-97`). Type `info` and drop the `as any` casts.
  2. Return and show the number of files that delete-old removes (`:239`).
  3. Use a token for `#FF9F43` (`:156`). Add a back control to the loading state (`:252-259`).
  4. Label the category rows (`:309-319`). Clear `chatStores` when a load fails.

#### `app/live-view.tsx` — **6.5 → 7.0** (mean 6.75)
- **Scores now:** Function 8 · States 7.5 · UI 7 · A11y 6.5 · Security 7 · Code 4.5
- **Round-1 regressions:**
  1. ✅ Re-entry guard. A `leaving` ref guards both `stop` and `leaveAsViewer` (`app/live-view.tsx:693`, `:696-697`, `:737-738`). I checked the fix log's "none can throw" claim: `endBroadcast` swallows its errors (`lib/broadcast.ts:132-136`), `s.leave()` is caught (`:718`), and `api` has a timeout (`lib/api.ts:346`). So the ref cannot strand the screen.
  2. ✅ Hardware back. It closes the poll composer, then the invite panel, then the chat (only while `stageReady`), and otherwise calls `exitScreen` (`:857-868`). Needs an Android device check.
- **Original items still open:**
  - ❌ The screen is a 2047-line single component with duplicated teardown (`:695-750`).
  - ❌ The chat issues remain: length-based unread (`:842`, `:1532-1534`), the draft cleared before the send (`:642`), and no auto-scroll.
  - ❌ Poll and composer roles are missing.
  - ❌ `__getValue` is still used (`:1063`, `:1077-1078`).
  - ❌ The passcode is still in route params (`:56-59`).
  - ❌ No end-on-unmount (server sweep, not verifiable statically).
- **Regressions:** none.
- **Subscreens:**
  - Waiting / Failed / Ended — 7.5 → 8.
  - Live chat — 6.5 → 6.5.
  - Poll composer — 6 → 6.5 (back now closes it).
  - Invite panel — 7.5 → 7.5.
  - Unchanged: top chrome 8, poll card 6.5, host media 8, PiP 6.5, stage strip 6.
- **Still needed for 10/10:**
  1. Split the screen and merge the teardown paths (`:695-750`).
  2. Chat: compute unread from ids (`:842`), restore the draft on a failed send (`:642`), and auto-scroll.
  3. Add roles and labels to the poll options and composer. Add a non-gesture way to show the chrome.
  4. Replace `__getValue` (`:1063`, `:1077`). Move the passcode out of params (`:59`). Confirm the server sweep or end on unmount.

#### `app/shop-book.tsx` — **6.5 → 6.5** (mean 6.25)
- **Scores now:** Function 8 · States 6.5 · UI 6.5 · A11y 5.5 · Security 7 · Code 4
- **Round-1 regressions:**
  1. ✅ VerificationScreen no longer shows "Not verified" on a failed load. `loaded` is set only after a successful `shopDocuments()` (`app/shop-book.tsx:3323`). The panel, documents and Submit render only when it is set (`:3387-3441`). A spinner shows on the first load (`:3386`), and Submit gained role, label and state (`:3436`). After a successful load, a failed refresh keeps the last good data under the ErrorState, which is acceptable.
  2. ❌ The extra report fetch for `entitledPlan` was not addressed (`services/shopBookService.ts:958-960`).
  3. ❌ The load/err/retry block is still duplicated about 23 times.
- **Original items:** all items from round 1 that were not touched (reject text, repeat order, silent catches, ₹, a11y, ShopSettings, TabBar safe area, file size) are unchanged. The diff touches only VerificationScreen.
- **Regressions:** none.
- **Subscreens:** Owner › VerificationScreen — 7 → 7.5. All others are unchanged from round 1.
- **Still needed for 10/10:** the round-1 list (`rerate/I2.md` items 1-11) still applies, except the VerificationScreen part of item 3.

#### `admin/logs.html` — **7.0 → 7.0** (mean 6.92)
- **Scores now:** Function 7.5 · States 7 · UI 6.5 · A11y 5.5 · Security 8 · Code 7
- **Round-1 regression:**
  - ✅ "Forget token" now stops both timers (`admin/logs.html:259-262`, `:272`). Timers start only with a token (`:252-258`, `:270`, `:292`). A response that arrives after forget is dropped (`:216`, `:234`). The CSP hash matches (`:9`), and I recomputed it myself. Browser behaviour is not verifiable statically.
  - ◐ If an in-flight request *rejects* after forget, the catch still writes "no connection" over "token cleared" (`:224`, `:240`).
- **Original items:**
  - ❌ No in-flight guard: `load()` from the timer and from the retry can overlap.
  - ❌ `api()` does not check `r.ok` (`:198-204`).
  - ❌ The page is not linked from `admin/index.html` (grep: no "logs.html" link).
  - ❌ `#log` has no `role="log"` (`:100`), and the back link's only name is "←" (`:74`).
  - ❌ Each refresh rebuilds `innerHTML` in full.
- **Regressions:** none.
- **Subscreens:**
  - Token overlay — 7.5 → 8.
  - Source nav — 7 → 7.
  - Log view — 7 → 7.
- **Still needed for 10/10:**
  1. Add an in-flight flag to `load()`/`loadSources()` (`:213-242`). Check `r.ok` (`:198-204`). Skip the catch's status write when no token is set (`:224`, `:240`).
  2. Link the page from `admin/index.html`.
  3. Add `role="log" aria-live="polite"` to `#log` (`:100`) and give the back link a name (`:74`).
  4. Render new lines incrementally. Run a browser check of the layout and CSP.

#### `app/finance/customer.tsx` — **6.5 → 6.5** (mean 6.5)
- **Scores now:** Function 6 · States 7 · UI 8 · A11y 5 · Security 7 · Code 7
- **Round-1 regression:** ✅ A missing or blank `name` now renders "Customer not found" instead of a spinner that never stops (`app/finance/customer.tsx:48-59`). All hooks run before the early return (`:19-46`), so the rules of hooks hold. The unused `Ionicons` import is gone (`:5-16`).
- **Original items:**
  - ❌ Customers are still matched by name only (`:22`, `:32`).
  - ❌ "Outstanding" still counts lent rows only (`:43`, `:85`).
  - ❌ Cards still have no role or label (`:102-103`).
  - ❌ The hero and tiles still show ₹0 while loading (`:73-88`).
- **Regressions:** none.
- **Subscreens:** none.
- **Still needed for 10/10:**
  1. Match on `mobile` when it is present (`:22`, `:32`).
  2. Show both what the user is owed and what they owe (`:43`).
  3. Give cards a role and label (`:102`).
  4. Gate the hero and tiles on `status === 'ready'` (`:73-88`).

#### `app/finance/reminders.tsx` — **7.0 → 7.0** (mean 6.83)
- **Scores now:** Function 6 · States 7 · UI 7 · A11y 6.5 · Security 7 · Code 7.5
- **Round-1 regression:** ✅ The handoff landed. The warning uses `isUnscheduled(r.freq, r.notif_id)` (`app/finance/reminders.tsx:20`, `:144`; `components/finance/notifyIds.ts:28-36`; selftest passes). A recurring reminder with an empty recurrence slot stays flagged after a snooze. ❌ The optional `onSnooze` warning (fix log R3 handoff) was not added: `:85` still warns only when `!snoozeId`.
- **Original items:**
  - ❌ `next_at` is never advanced for recurring reminders.
  - ❌ A past time is accepted for `once` (`:55-58`).
  - ❌ "Yearly" is missing from the segment (`:114`), and days 29–31 are unhandled (`notify.ts:32`).
  - ❌ The header toggle has no `accessibilityRole` (`:104`), and the form is not in `KeyboardSafe` (`:110`).
- **Regressions:** none.
- **Calibration:** Round 1 scored A11y 7. With the header toggle still roleless I put it at 6.5, and I raised Code to 7.5 for the pure, tested `isUnscheduled`. The overall score is unchanged.
- **Subscreens:**
  - Add form — 6 → 6.
  - Picker — 7 → 7.
  - Permission handling — 7 → 7.5 (the flag is now correct after a snooze).
- **Still needed for 10/10:**
  1. Advance `next_at` for recurring reminders.
  2. Reject past `once` times (`:55-58`).
  3. Add "Yearly" (`:114`) and handle days 29–31.
  4. Add a role to the header toggle (`:104`) and use `KeyboardSafe` (`:110`).
  5. Warn on snooze when `isUnscheduled(r.freq, ids.keep)` (`:85`).

#### `app/space-admin.tsx` — **7.0 → 7.0** (mean 7.0)
- **Scores now:** Function 8 · States 7 · UI 7 · A11y 7 · Security 7 · Code 6
- **Round-1 regression:** ✅ Link-load failures now stay inside the sheet:
  - `loadLinks` sets its own `linksError` and no longer touches the console's `loadError` (`app/space-admin.tsx:96`, `:128-134`).
  - The sheet renders a `LoadError` with retry in place of the list (`components/spaces/SpaceLinksSheet.tsx:38`, `:173-193`, passed at `app/space-admin.tsx:278-281`).
  - Residual: while the fetch is in flight, the sheet shows the previous `links` (initially `[]`, so "No links yet."), with no loading indicator (`:135-138`).
- **Original items:**
  - ❌ N+1 `getRun` (`:118-121`).
  - ❌ No Leave or Tasks entries (`:55-71`).
  - ❌ `as any` (`:183`, `:240`).
  - ❌ `#fff` (`:187`, `:299`).
  - ❌ Shift is still read only from the device.
- **Regressions:** none.
- **Subscreens:**
  - Links sheet — 7 → 7.5.
  - Shift sheet — 6.5 → 6.5.
  - Emergency banner — 7 → 7.
  - Run tiles — 7 → 7.
  - Chat door — 8 → 8.
- **Still needed for 10/10:**
  1. Show a loading state in the links sheet until the first fetch settles (`:135-138`).
  2. Add Leave and Tasks entries (`:55-71`).
  3. Replace the per-run `getRun` with one summary call (`:118-121`).
  4. Remove the `as any` casts (`:183`, `:240`). Add an on-danger token for `#fff` (`:187`, `:299`).
  5. Read the shift from the server once a route exists.

#### `app/space-devices.tsx` — **6.0 → 6.5** (mean 6.25)
- **Scores now:** Function 6 · States 6.5 · UI 6 · A11y 6 · Security 7 · Code 6
- **Round-1 regressions:**
  1. ✅ `openDevice` records which fetch failed and sets `detailError` (`app/space-devices.tsx:90`, `:105-117`). The sheet shows a `LoadError` with retry above HISTORY, and "Nothing recorded yet." is hidden while the error is set (`:392-399`). The requests list is hidden when empty (`:365`), so a commands failure is shown only by the error card. That is acceptable.
  2. ✅ The product name is unified to "crazzychat" (`:176`, `:236`, `:318`, `:338`, `:352`, `:443`, `:467`). The fix log says app.json uses this name; I did not open app.json.
- **Original items:**
  - ❌ The agent works only in the foreground; device behaviour is not verifiable statically.
  - ❌ No rename.
  - ❌ Modal Cancel, Add and Send buttons have no role (`:448`, `:451-452`, `:471`, `:474-476`). Send has no busy indicator.
  - ❌ No Aurora in the loaded view: it is mounted only in the loading branch (`:205`).
  - ◐ The Close button is labelled but has no 44pt target (`:293`).
- **Regressions:** none. Pre-existing: rapidly opening device A then device B can let A's late responses overwrite B's detail, because there is no stale-request guard (`:105-116`).
- **Subscreens:**
  - Device detail — 6 → 6.5.
  - Add-device modal — 7 → 7.
  - Show-a-message modal — 6 → 6.
- **Still needed for 10/10:**
  1. Device-verify ring and message delivery, and consider a background fetch (`lib/spaces/deviceAgent.ts:16-18`).
  2. Add rename via `updateDevice`.
  3. Add roles to the modal buttons (`:448`, `:451`, `:471`, `:474`). Add a busy state on Send and a 44pt Close (`:293`).
  4. Add a stale-response guard in `openDevice` (`:105-116`). Mount Aurora in the loaded view.

#### `app/space-roster.tsx` — **7.0 → 7.0** (mean 6.83)
- **Scores now:** Function 7 · States 8 · UI 6 · A11y 6 · Security 7 · Code 7
- **Round-1 regression:** ✅ A `getLinks` failure is recorded as `linksError` while the roster still loads (`app/space-roster.tsx:47`, `:60-75`). It is passed to the sheet, and retry re-runs `load` (`:268`).
- **Original items:**
  - ❌ `headerRight` still replaces the chat door (`:145`).
  - ❌ `#F59E0B18` (`:285`).
  - ❌ No Aurora in the loaded view: it is mounted only in the loading branch (`:133`).
  - ❌ Archive is `padding: 8` with the generic label "Archive this person" (`:216`).
  - ❌ The modal Cancel and Add buttons have no role (`:250`, `:253-256`).
  - ❌ No `externalRef` or `kind` on add.
- **Regressions:** none.
- **Subscreens:**
  - Links sheet — 7 → 7.5.
  - Add-to-roster modal — 6.5 → 6.5.
- **Still needed for 10/10:**
  1. Keep the chat door with `headerRight` (`:145`). Tokenise `#F59E0B18` (`:285`). Mount Aurora.
  2. Make Archive a 44pt target whose label names the person (`:216`). Add roles to the modal buttons (`:250`, `:253`).
  3. Offer `externalRef` and `kind` on add.

#### `app/space-runs-admin.tsx` — **6.5 → 7.0** (mean 6.75)
- **Scores now:** Function 7.5 · States 7 · UI 7 · A11y 6 · Security 7 · Code 6
- **Round-1 regression:** ✅ `plannedAt` is no longer pinned to the save day.
  - `stopDay` uses the run's `scheduledAt`, otherwise a typed day, otherwise null. It never uses "today" (`lib/spaces/runPlan.ts:63-66`). `parseDay` rejects impossible dates (`:36-44`). The selftest passes.
  - The screen refuses a time that has no day, before any geocoding (`app/space-runs-admin.tsx:203-207`). It shows a labelled "Day of the run" field only when a time is typed and the run has no schedule (`:623-630`). The field is pre-filled from this stop, a sibling stop, or `startedAt` (`:241-243`). The `Date.now()` fallback is gone (`:227`, `plannedAt: … base == null ? null`).
  - Residual (fix log 4b): stops saved earlier under the old fallback are not migrated.
- **Original items:**
  - ❌ The create form still cannot set `scheduledAt` or `requireCode` (fix log 4a).
  - ❌ Hit targets: `iconHit` `minWidth: 36` (`:713`), `riderToggle` and `stopChip` `minHeight: 36` (`:714`, `:716`).
  - ❌ No pull-to-refresh, and `openRun` errors go to an Alert.
  - ❌ 742 lines. The time and the new day are typed as text, with no picker (`:620-630`).
- **Regressions:** none. The extra day field adds typing for unscheduled runs, but it replaces silent wrong-day data.
- **Subscreens:**
  - Stop form — 7 → 7.5.
  - Rider stop picker — 7.5 → 7.5.
  - New-run modal — 6.5 → 6.5.
  - Edit-run modal — 7 → 7.
- **Still needed for 10/10:**
  1. Let the create form set `scheduledAt` and `requireCode`, so the day field is rarely needed.
  2. Raise the targets to 44pt (`:713-716`).
  3. Add pull-to-refresh, and an inline error for `openRun`.
  4. Use date and time pickers instead of typed text (`:620-630`). Split the component.

---

### X3 — Family, SOS, Location Lock, Communities, Group Calendar — re-rating (round 2)

Base `29b9634` (round-1 re-rating) → `HEAD` (`26b8d60`). Baselines: `rerate/G1.md` (family, family-member, family-setup), `rerate/G2.md` (emergency-sos, location-lock, lock-alert, lock-history), `rerate/D.md` (communities, group-calendar). Fix log: `fixes/R4.md` (it covers every file here). R1, R2, R3 and R5 do not touch these screens. The one exception is the R1 handoff that routes family-alert taps, which was checked as a cross-cutting item. All fix claims were checked against `git diff 29b9634 HEAD` and the current files.

| Screen | Old | New | Δ |
|---|---|---|---|
| `app/family.tsx` | 7 | 7 | 0 |
| `app/family-member.tsx` | 7 | 7 | 0 |
| `app/family-setup.tsx` | 7.5 | 8 | +0.5 |
| `app/emergency-sos.tsx` | 6.5 | 7 | +0.5 |
| `app/location-lock.tsx` | 6.5 | 7 | +0.5 |
| `app/lock-alert.tsx` | 6.5 | 7 | +0.5 |
| `app/lock-history.tsx` | 6.5 | 7 | +0.5 |
| `app/communities.tsx` | 6.5 | 6.5 | 0 |
| `app/group-calendar.tsx` | 7 | 7 | 0 |

**Checks run (read-only, at HEAD):**
- `npx tsc --noEmit -p .` exits 0.
- `npx eslint` on the 11 changed files: 0 errors and 8 warnings. These are the same warnings R4 reports as already present (`family.tsx:305,367,614,817,922,1062`; `family-member.tsx:233,264`).
- Selftests, all exit 0:
  - `lib/groups/eventReminderPrivacy.selftest.ts` (new)
  - `lib/groups/calendar.ts` self-check
  - `lib/groups/groupScreenFixes`
  - `lib/lock/lockHistoryUnits`
  - `lib/family/historyOwners`
  - `lib/locationEgress`
  - `lib/a11yCoverage`
  - `lib/themeCoverage` (22 assertions passed)
  - `lib/orphanRoutes` (51 assertions)

**Not verified:** nothing is device-verified or deployed. Live regions, `getLastKnownPositionAsync({maxAge})` on OEM ROMs, the single SOS dialog on Android and lock-screen reminder text all need a device and are scored only on what the code shows.

**Cross-cutting (family alert taps):**
- Foreground notifee presses now go through the lock-aware opener (`lib/push.ts:234-238` → `app/_layout.tsx:868`).
- Cold start does too (`app/_layout.tsx:827`).
- A press while the app is only backgrounded still has no `family-alert` branch (`lib/callBackground.ts:35-73`). This is unchanged from round 1.

**Server checks used for scoring:**
- The SOS endpoint treats a missing or empty `contactIds` as "all trusted contacts" (`vaultchat-backend-go/internal/routes/user.go:583-620`).
- Location reads are members-only (`spaces_locations.go:75-77, 345, 396`).
- Creating a community group checks only community membership (`communities.go:203-212`).

---

#### `app/family.tsx` — **7 → 7**
- **Scores now:** Function 8 · States 8 · UI 7 · A11y 6.5 · Security 8.5 · Code 4 (mean 7.0)
- **Round-1 regressions:**
  - ✅ **Stale SOS fix.**
    - The SOS message now uses `getLastKnownPositionAsync({ maxAge: SOS_FIX_MAX_AGE_MS })` and also checks `c.timestamp` against the 5-minute limit (`:86`, `:991-993`).
    - Otherwise it says "(location unavailable)" (`:989`), and live sharing supplies the real position.
  - ✅ **Dialog stack.**
    - `toggleShare(v, quiet)` (`:622`) skips the background prompt, "Location is turned off" and `offerBackground` when `quiet` is set (`:638`, `:665`, `:674`).
    - The SOS path passes `quiet` (`:1003`).
    - It then shows one "SOS sent" dialog with one relevant fix: "Open settings" if sharing failed, or "Keep sharing when locked" if background location is missing (`:1008-1025`). That dialog has at most 3 buttons, so it fits Android's limit.
    - `bgAsked` is latched so the offer is not repeated (`:1009`).
  - ✅ **Button role on a non-pressable row.** `<View accessibilityRole="button">` on the High-speed row is gone (`:2353`).
- **Round-1 "Still needed" items:**
  1. ✅ **Privacy copy.**
     - The header comment now describes the plain upload to the space location store (`:7-10`).
     - The Places comment (`:271-272`) and the speed comment (`:2350-2352`) are corrected.
     - Grep finds no remaining E2EE location claim in `app/family*.tsx` or `components/family/`. The user-facing copy lives in family-setup (see below).
  2. ❌ **Roster Retry.** A non-403/404 failure still only `console.warn`s (`:364`), and the card stays on "Loading members…" (`:1564`).
  3. ❌ **Member row is long-press only.** It still has no role or `accessibilityActions` (`:1317`).
  4. ◐ **Roles.** The bad View role is gone. Still missing a role: "New space" (`:1531`), the two "View All" links (`:1582`, `:2118`), "+ Invite" (`:1991`), the check-in tiles, Send, I'm OK and Post.
  5. ✅ **SOS follow-ups.** See the regressions above.
  6. ❌ **Manage rows.** "Invite from contacts" is still ungated (`:2284`).
  7. ❌ **Size.** The file is 2533 lines (up from 2503), with 43 `as any`. `currentPlan()` is still called four times per render (`:1402-1405`).
  8. ❌ **Local helper copies.** `AVATAR_COLORS`/`colorFor` are still local (`:87-88`).
- **Regressions:** none introduced. There is one nit: the "Keep sharing when locked" handler duplicates `offerBackground`'s Allow body (`:1014` vs `:706-707`).
- **Subscreens:**
  - Expanded map + roster: 7 → 7
  - Sections grid: 8 → 8
  - Check-in sheet: 7 → 7
  - Announcement sheet: 8 → 8
  - Manage sheet: 7 → 7.5 (the bogus role is gone)
  - Crash countdown: 8 → 8
  - Member actions: 6 → 6
  - SOS outcome dialog (new subscreen): 8. It is one dialog, honest about sharing state, and offers one fix.
- **Still needed for 10/10:**
  1. Add a roster error state with Retry in place of the endless "Loading members…" (`:364`, `:1564`). `components/spaces/LoadError.tsx` could be reused.
  2. Make member management reachable without long-press: add a role plus `accessibilityActions`, or a visible ⋯ (`:1317`).
  3. Add the remaining roles (`:1531`, `:1582`, `:1991`, `:2118`, the check-in tiles with selected state, Send, I'm OK, Post, and the run, trip and driver cards).
  4. Gate "Invite from contacts" on `canInvite` (`:2284`) and merge the two create rows.
  5. Split the 2533-line component. Compute `currentPlan()` once (`:1402-1405`), cut the 43 `as any`, and pull the duplicated background-permission flow into one helper (`:706-707`, `:1014`).
  6. Share `colorFor`/`ago`/`dist` with `family-member.tsx:40-52`.

#### `app/family-member.tsx` — **7 → 7**
- **Scores now:** Function 8 · States 8 · UI 7 · A11y 7 · Security 6.5 · Code 6 (mean 7.08)
- **Round-1 regressions:**
  - ✅ **A failed load read as a permission lock.**
    - Access is now three states, `'unknown' | 'allowed' | 'denied'`, starting at `'unknown'` (`:79-80`).
    - `withheld` requires `'denied'` (`:199`). `unknown` is `'unknown' && pullFailed` (`:201`).
    - The status line reads "Location not loaded" (`:398`), and a notice with Retry replaces the lock notice (`:426-436`).
    - Route and Follow show a "Not loaded" alert (`:317`, and their guards).
    - Today, diagnostics and Safe Zones are hidden while unknown (`:502`), so "0 m" and "no places" are not stated as fact.
    - `lib/locationEgress` still passes.
  - ✅ **Message/Call on your own row.**
    - `selfId` is resolved in its own effect (`:119-125`).
    - The actions are hidden while it is `undefined` (`:451-452`).
- **Round-1 "Still needed" items:**
  1. ✅ Failures are kept apart from permissions (above).
  2. ❌ **`/nav/trace` is not throttled.** `trackKey` still changes with every new sample (`:224-241`).
  3. ❌ **Unknown permission is still allowed** (`:155`).
  4. ❌ **Helpers and the star.** The helpers are still local (`:40-52`), and the guardian star is still unlabelled (`:394`).
- **New minor issues:**
  - If `getCurrentUserAsync` fails, `selfId` becomes `null` (`:122-123`), and Message/Call reappear on your own row (`:451-452`). Hiding them only while `undefined` covers loading but not lookup failure.
  - `getCurrentUserAsync` is now called twice per screen, once in the effect (`:122`) and once in every pull (`:141`).
  - Retry (`:432`) has no busy state.
- **Subscreens:**
  - Withheld/locked state: 7 → 8 (it now means denied only)
  - Load-failed notice (new): 7.5
  - Relationship chips: 8 → 8
  - Route-to-stale confirm: 8 → 8
- **Still needed for 10/10:**
  1. Throttle `/nav/trace`, for example once per N new samples or per minute (`:224-241`).
  2. Revisit treating unknown permission as allowed (`:155`).
  3. Treat a failed self lookup as "hide Message/Call", or reuse the pull's `me` (`:122`, `:141`, `:451-452`).
  4. Share `colorFor`/`ago`/`dist` with the hub (`:40-52`), and label the guardian star (`:394`).
  5. Add a busy state to Retry (`:432`).

#### `app/family-setup.tsx` — **7.5 → 8**
- **Scores now:** Function 7 · States 8 · UI 8 · A11y 9 · Security 7.5 · Code 7 (mean 7.75, rounded half up)
- **Round-1 "Still needed" items:**
  1. ✅ **E2EE claim corrected.**
     - The hero now says live updates between phones are E2EE, that each shared position is also stored on the server for last-known spots and history, and that the server only shows it to circle members (`:69`).
     - This matches the code: `onFix` → `publishPoint` (`lib/family/presence.ts:426-434`) → plain POST (`lib/location/publisher.ts:104-106`). The server's members-only read gate (`spaces_locations.go:75-77`) matches it too.
     - The transport is unchanged, so positions remain plaintext at rest on the server. That is now disclosed rather than hidden.
  2. ❌ **Still reachable only from the hub's manage row** (`family.tsx` "Create or join another" row) and the deep link.
  3. ❌ **Device verification** of create → hub and of the `dismissTo` return (`:27`) is still pending.
- **Regressions:** none.
- **Subscreens:** none (Alerts only).
- **Still needed for 10/10:**
  1. Seal the location-store upload, or let users opt out of server retention. Today it is disclosed but not avoidable (`lib/family/presence.ts:426-434`).
  2. Offer setup from the hub's zero-space path or from group-create.
  3. Add `maxLength` to the circle-name input (`:75-77`).
  4. Device-verify create → hub and the `dismissTo` return (`:27`).

---

#### `app/emergency-sos.tsx` — **6.5 → 7**
- **Scores now:** Function 8 · States 8 · UI 6 · A11y 7 · Security 7 · Code 6 (mean 7.0)
- **Round-1 "Still needed" items:**
  1. ✅ **SOS is never blocked by a failed client load.**
     - `everLoaded` (`:78`) gates `recipients()` (`:186-191`). Before any successful load it returns `ids: undefined`, so the server alerts all trusted contacts. This was verified in `user.go:583-620`, and `sendSOS` omits the undefined key (`lib/chatService.ts:1340-1343`).
     - An empty `[]` is never sent. A loaded empty list gives "No trusted contacts" with a Set up button (`:195-199`). A loaded list with nothing selected is blocked (`:201-203`).
     - The countdown says who will be alerted (`:291-295`), and the error card says "An SOS still goes to all of them" (`:400`).
  2. ✅ **Selection kept across focus reloads.**
     - `knownIds` merges the selection: a deselected contact stays deselected, a new contact starts selected, and a removed contact is dropped (`:80`, `:129-132`).
     - The spinner and error card show only before the first load. A failed refresh keeps the list and shows a polite notice (`:395`, `:415-419`).
     - Rows are disabled during the countdown and send, because recipients are fixed when the countdown starts (`:426-430`, `sendTo` passed into `triggerSOS`).
  3. ✅ **Honest result wording.** It now reads "Alerting N trusted contact(s)", zero has its own copy (`:317-320`), and history says "N alerted" (`:459`). The server still counts recipients rather than deliveries, and the wording now matches that.
  4. ❌ **Reduced motion and Back target.** The pulse ignores reduced motion (`:108-117`). Back is 40×40 with no `hitSlop` (`:271`, `:475`).
  5. ❌ **Tokens, types and history load.** The rgba borders and backgrounds are still hard-coded (`:475, 484, 486, 494, 511, 524-531, 539`). `countdownTimer` is still `useRef<any>` (`:97`). A failed history load is still silent (`:141`, `:247`).
  6. ❌ **Device check** that `/emergency-sos` opens is still pending.
- **Regressions:** none found. One nit: when a refresh fails and the last good list was empty, the empty card shows without the "couldn't refresh" line (`:395-419`).
- **Subscreens:**
  - Default / SOS button: 7 → 7.5
  - Countdown: 7.5 → 8 (recipient line)
  - Sending: 6 → 6.5
  - Sent: 7 → 7.5
  - Shake detection: 7 → 7
  - Contacts selector: 7 → 8
- **Still needed for 10/10:**
  1. Gate the pulse on `useReducedMotion()` (`:108-117`), and give Back `hitSlop` (`:271`).
  2. Surface a failed SOS-history load (`:141`, `:247`).
  3. Move the rgba literals to tokens (`:475-539`), and type `countdownTimer` (`:97`).
  4. Have the server count actual push deliveries (`user.go` `notified`) if "alerted" should mean "reached".
  5. Device-verify that `/emergency-sos` opens, and the shake flow.

#### `app/location-lock.tsx` — **6.5 → 7**
- **Scores now:** Function 7.5 · States 6.5 · UI 7 · A11y 7 · Security 7 · Code 6 (mean 6.83)
- **Round-1 "Still needed" items:**
  1. ❌ **Permission denied on mount.** It still returns silently (`:94`), and "Current location" still has no busy state (`:108-119`).
  2. ✅ **Route before navigate.**
     - `navBack` awaits `navigateBackToLock` and pushes `/navigate` only on success. It alerts otherwise (`:182-191`).
     - A `planning` guard blocks double taps (`:70`, `:183`), and a spinner with a label shows (`:308`).
  3. ❌ **Ticker re-renders.** The 1 s ticker still re-renders the whole screen (`:102-106`).
  4. ❌ **A11y gaps.** The banner role, the Lock button disabled/busy state, and the custom-radius input label are unchanged.
  5. ❌ **Types.** `colors: any` remains (`:494`).
  6. ❌ **Swallowed failures.** `restoreLock`, saved places and mode-save still fail silently (`:78`, `:89`, `:419`).
- **Regressions:** none. One nit: while planning, the chosen chip is shown with `active`, which the Chip announces as "selected" (`:305-307`). A busy state would be more accurate.
- **Subscreens:**
  - Active face: 7 → 7.5
  - Setup face: 7 → 7
  - Background-protection Alert: 7 → 7
  - Battery Alert: 7 → 7
  - Unlock confirm: 8 → 8
  - NavMap: 6.5 → 6.5
- **Still needed for 10/10:**
  1. Show a "permission needed" state with Open settings when permission is denied on mount (`:94`). Add a busy state to `useCurrent` (`:108-119`).
  2. Move the ticker into a `LockedFor` child (`:102-106`).
  3. Remaining a11y: the banner role, `accessibilityState` on the Lock button (`:480`), a label on the radius input, and busy rather than selected on the planning chip (`:305-307`).
  4. Type `colors`/`icon`, and move the alarm hex colours into tokens.
  5. Stop swallowing failures (`:78`, `:89`, `:419`).

#### `app/lock-alert.tsx` — **6.5 → 7**
- **Scores now:** Function 7.5 · States 7.5 · UI 6 · A11y 6.5 · Security 7 · Code 7 (mean 6.92)
- **Round-1 "Still needed" items:**
  1. ❌ **Reduced motion.** The full-screen red flash is still not gated on `useReducedMotion()` (`:34-44`).
  2. ✅ **Live region.**
     - It was removed from the static "ALERT!" (`:87`).
     - The phase line is always mounted and carries `accessibilityLiveRegion="assertive"` (`:102-110`). It has new copy for the alarming phase.
     - Stop Alarm renders below it (`:111-116`).
  3. ❌ **Palette.** It is still hard-coded (`:48`, `#DC2626`/`#FECACA` throughout), and `icon: any` remains in NavBtn (`:132`).
  4. ✅ **Route before replace.**
     - `navBack` awaits planning and replaces only on success (`:50-62`).
     - A `planning` guard and per-button busy spinner are in place, with `accessibilityState.busy` (`:28`, `:120-122`, `:136-137`).
- **Regressions:** none. Nit: the other two NavBtns are not disabled during planning. The guard is in `navBack` only (`:54`).
- **Subscreens:**
  - Alarm mode: 7 → 7.5
  - Safe mode: 7 → 7
- **Still needed for 10/10:**
  1. Gate the flash on `useReducedMotion()` (`:34-44`). This is a photosensitivity concern.
  2. Move the alarm palette into named tokens, and type `icon` (`:48`, `:132`, styles).
  3. Disable the sibling NavBtns while planning (`:120-122`).

#### `app/lock-history.tsx` — **6.5 → 7**
- **Scores now:** Function 7 · States 8 · UI 6 · A11y 6 · Security 7 · Code 7 (mean 6.83)
- **Round-1 "Still needed" items:**
  1. ✅ **Reload errors surfaced.**
     - `refresh()` reports every reload into `load` (`:74-77`): focus, filter change, delete, delete-all (`:100`, `:111`) and note save (`:277`).
     - A polite banner with Retry shows when `load==='error'` and sessions are listed (`:183-192`).
  2. ❌ **Nested accessible controls.** Save, Delete and the note input are still nested in the accessible card.
  3. ❌ **No pagination** or "latest 100" notice (`lib/lock/lockStore.ts`).
  4. ❌ **Export and note save.** Export failure is still `catch {}` (`:89-90`), and there is no confirmation for a saved note.
  5. ❌ **Code tidy-up.** `max` is still computed inside the map (`:152`). `EVENT_META` colours and `icon: any` remain (`:37`, `:302`).
- **Regressions:** none. Nit: Retry from the banner sets `'loading'`, which hides the banner with no spinner while the list is shown (`:77`, `:185`).
- **Subscreens:**
  - Export Alert: 6 → 6
  - Delete-all confirm: 8 → 8.5 (its reload failure is now visible)
  - Per-session delete: 8 → 8.5
  - Timeline + note editor: 7 → 7
- **Still needed for 10/10:**
  1. Un-nest the controls from the accessible card (`:211-290`).
  2. Paginate, or show a "latest 100" notice.
  3. Alert on export failure (`:89-90`), and confirm a saved note.
  4. Show progress on banner Retry (`:77`).
  5. Hoist `max` (`:152`), and tokenise and type `EVENT_META` (`:37`).

---

#### `app/communities.tsx` — **6.5 → 6.5**
- **Scores now:** Function 6.5 · States 7 · UI 7 · A11y 7 · Security 6 · Code 6.5 (mean 6.67)
- **Round-1 "Still needed" items:**
  1. ✅ **Who may create groups.**
     - "New group" now shows for every member (`:135-142`). The comment correctly says the server checks only membership.
     - Verified in `communities.go:203-212`: membership of any chat in the community, otherwise 403.
     - Client and server now agree. The server rule itself is unchanged.
  2. ❌ **No management features.** There is still no leave, edit, delete or add-existing-group.
  3. ❌ **`openCommunity` cache read.** It still reads the cache outside the try and has no stale-response guard (`:62-75`).
  4. ❌ **Modal inputs** still have no `accessibilityLabel` (`:209`, `:211`).
  5. ❌ **Error-bar retry** still shows no progress.
- **Regressions:** none.
- **Subscreens:**
  - Community detail: 6.5 → 7
  - Name modal: 7 → 7
- **Still needed for 10/10:**
  1. Add leave, edit, delete and add-existing-group.
  2. Move the cache read inside the try, and add a request-sequence guard (`:62-75`).
  3. Label the modal inputs (`:209`, `:211`).
  4. Show progress on the error-bar retry.

#### `app/group-calendar.tsx` — **7 → 7**
- **Scores now:** Function 7 · States 7 · UI 7 · A11y 6.5 · Security 7.5 · Code 7.5 (mean 7.08)
- **What changed:** the screen has no diff. The change is in `lib/groups/calendar.ts` and `lib/groups/taskReminders.ts`.
- **Round-1 regression:** ◐ lock-screen event titles.
  - `eventReminderTitle()` shows the title only for your own event while the `privacyPrefs` preview is `'name'`. Every other case gets `GENERIC_EVENT_REMINDER` (`lib/groups/calendar.ts:208-222`).
  - `eventReminderItems` carries `createdBy` (`calendar.ts:201`).
  - `syncEventReminders` reads `getNotifPreview()` and rewrites titles before reconciling (`taskReminders.ts:104-109`). The reconciler re-books on a title change; this is pinned by `eventReminderPrivacy.selftest.ts`, which passes.
  - **Partial:** a preference change rewrites booked reminders only on the next `syncEventReminders` call. The only caller is `group-calendar.tsx:86`, which runs on focus, add and delete. So reminders already booked keep the old text until the user next opens that group's calendar. The R4 claim that "changing the preference also re-books reminders" holds only with that caveat.
  - Under `'hidden'`, reminders still fire with generic text. This was a deliberate choice (R4 6').
- **Round-1 "Still needed" items:** all unchanged.
  - No date/time picker (`:44-50`).
  - No edit flow.
  - Delete is long-press only, and rows have no role (`:265-274`).
  - There is no `createdBy` check before delete (`:191-211`).
  - Decrypt failures are dropped (`:65`).
  - There is no refresh-failed indicator (`:127`).
- **Regressions:** none.
- **Subscreens:** New-event sheet: 7 → 7.
- **Still needed for 10/10:**
  1. Replace the presets with a real date/time picker (`:44-50`).
  2. Add an edit flow.
  3. Add a visible delete control and row `accessibilityRole` (`:265-274`).
  4. Check `createdBy` before offering delete (`:191-211`).
  5. Surface undecryptable events (`:65`).
  6. Show a refresh-failed indicator (`:127`, `:242`).
  7. Re-sync event reminders when the tray-privacy preference changes, for example from `setNotifPreview` (`lib/privacyPrefs.ts:87`), so already-booked titles are rewritten straight away.

---

