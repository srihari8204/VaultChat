# VaultChat — Fix Status and Updated Ratings

_Updated 2026-10-04 · branch `ccr-9258b8b7-m4748a` · baseline `18eb6d2` (the rating in `2026-10-04_screen_ratings.md`) · round 3 from `b8c8bd2` to `a72296b`_

This file tracks what the remediation plan (`2026-10-04_screen_remediation_plan.md`) has fixed and the updated rating of every screen.

**Status of all fixes below:** written and committed, with typecheck, lint and tests passing. Nothing has been deployed or tried on a phone yet. The backend changes from round 3 are written and tested against a scratch database only; they are **not deployed** (§4). Items marked 📱 need a device check before they count as verified.

## 1. Summary

| | Before (baseline) | After round 2 | Now (round 3) |
|---|---|---|---|
| Screens rated | 193 | 174 remain (19 mock/legacy/unwired routes deleted) | 174 remain; all 174 re-rated in round 3 |
| Mean score, all 193 screens | 6.0 | — | — |
| Mean score, the 174 that remain | 6.2 | 7.1 | **7.8** (7.83) |
| Screens improved / unchanged / worse, against the baseline | — | 132 / 42 / 0 | **173 / 1 / 0** (the one unchanged screen is `app/onboard.tsx`, 7.5) |
| Screens at 8 or above | 7 | 28 | **98** |
| Screens below 5 | 32 | 2 (the `group-chat` and `creator-channels` redirect shims) | **0** |
| Highest score | 8 | 8 | 10 (`creator-channels`, rated as a redirect; `group-chat` redirect 9.5). Highest real screen: 8.5, 22 screens |
| `tsc --noEmit` | 0 errors | 0 errors | 0 errors |
| `expo lint` | 0 errors, 267 warnings | 0 errors, 158 warnings | 0 errors, 55 warnings |
| `npm test` | 351/355 | 386/390 | 413/417 |
| `openspec validate --all --strict` | 48/50 | 49/51 | 49/51 (the same two changes fail, for having no deltas) |

The four `npm test` failures are the same in every column. All four are environmental: `lib/call/minimize`, `lib/layoutMetrics` and `services/securityEmulatorFlag` need the generated `android/` folder, and `utils/moneySeam` needs Node 24.

Against the previous score, round 3 raised 159 screens, left 15 the same and lowered none. Score spread now: 13 screens at 7, 63 at 7.5, 74 at 8, 22 at 8.5, and the two redirect shims at 9.5 and 10.

**How the new ratings were produced.** Reviewers who had not written any of the fixes re-scored screens with the original six-dimension rubric. They checked each fixer's claims against the code and reported regressions. Three re-rating rounds ran:
- **Round 1:** 147 screens, after the first fix round.
- **Round 2:** 36 screens, after a second round that fixed the regressions round 1 found.
- **Round 3:** all 174 remaining screens, in 13 batches (A, B, C1, C2, D, E+K, F, G1, G2, H, I1, I2, J), after a third fix round that worked through every screen's "Still needed for 10/10" list. The batches reviewed `HEAD` at `c28d1b2` or `5d7c50b`.

**Fixed after re-rating, not re-scored.** The round-3 re-raters found regressions and gaps (§3). Eight later commits fixed some of them: `5d7c50b`, `21ec13e`, `7c2bd24`, `9a3460e`, `815c7a5`, `298f739`, `d7f4e51` and `a72296b`. No reviewer has scored those changes, so the affected screens keep their round-3 score and are marked "fixed after re-rating" in §7. Their scores were not raised.

Every score cites `path:line`; the evidence is in the appendices (Appendix C for round 3).

**Why no real screen reaches 10** (only a redirect shim does). Scores stop below 10 for these reasons:
- Some fixes still need a device check.
- Some fixes depend on backend changes that are written but not deployed, or not written yet (§4).
- Several large files are still unsplit, for example `app/_layout.tsx`, `app/live-view.tsx`, `app/file-viewer.tsx`, `app/family.tsx`, `app/encrypted-notes.tsx`, `components/chat/MessageBubble.tsx` and the Rummy board.
- Route casts (`as any`) remain where `typedRoutes` needs generated types this checkout lacks.
- The palette has no on-primary, on-danger or warning token, so some fixed colours stay as named constants.

Each screen's remaining "Still needed for 10/10" list is in Appendix C.

## 2. What was fixed

Fixes were written by 9 parallel packages in round 1, an integration pass, 5 packages in round 2, and 16 packages plus integration and follow-up commits in round 3.

### Rounds 1 and 2

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

### Round 3

Every package worked through its screens' latest "Still needed for 10/10" list and ran the plan's Phase 3 sweep per file: screen-reader roles, labels and state on every touchable, theme tokens in place of hard-coded colours, errors instead of false empty states, and confirmations before destructive actions. The re-raters checked each claim below against the code (Appendix C).

| Area | Main fixes (round 3) |
|---|---|
| **Launch, auth & lock** (Z-A) | A family-alert tapped while the app is in the background now routes, through the lock-aware opener, with cold-start de-duplication. The resume relock now also covers Device-PIN users, and the lock screen has a PIN mode. A tap on an allowed cold start is no longer overwritten by the launch redirect. Deep links are refused while a security verdict is held. Permissions asks per row, with Settings for permanent refusals, and never asks for background location in "Allow all". Error boundary retry remounts; the update gate has a store fallback; the terms gate makes no network calls while signed out. Shared `isWeakPin`, a time-zone-safe date of birth, labelled MPIN and phone inputs, and mapped offline errors. |
| **Main tabs, contacts & links** (Z-B) | Alerts, Calls, Status, Profile, Contacts, Contact info, QR and Invite links show errors with retry instead of empty states. Calls says when the server merge failed and reports partial removals honestly. Profile edits can be cancelled, and OTP can be resent. New chat defaults to your own dialling code. Search highlights matches and says when results are offline. `/add` validates the VaultID before any request. `/join` can be cancelled and shows the group name, size and approval rule before joining when the server supports it (`b4ccd9c`). Shared `tint()` replaces hex-string colour concatenation. |
| **Chat conversation** (Z-C1) | `app/chat.tsx` is split from 4,674 lines into focused components and hooks under `components/chat/` (now 2,500 lines), with the re-rater finding no behaviour lost. Remind is hidden for protected messages. Groups get Clear chat and Leave group. In-chat search has previous/next with an "N of M" count. The bubble has a summary label that never speaks hidden ink text. Banner colours come from tokens, and the offline strip passes contrast. Hook-dependency warnings in chat.tsx went from 34 to 0. |
| **Chat tools, backup & import** (Z-C2) | Hidden chats: the list re-locks in the background, the PIN counter survives leaving the screen, and it filters on `hidden`. Scheduled messages prune their sealed copies once delivered. Create poll and chat wallpaper ask before discarding. Chat themes can follow the all-chats choice. Broadcast pages older posts. Backup to E2EE asks you to re-type parts of the recovery key. Chat backup offers "Open chats" after a restore instead of "restart the app". |
| **Groups & communities** (Z-D) | Notes and tasks share one reader that pages at the server's real 200-message cap and shows unreadable entries and failed refreshes. Group calendar has a date/time picker, an edit flow, a visible delete gated like the server, and rewrites booked reminder titles when lock-screen previews are hidden. Group calls start 1:1 calls in a direct chat. Group insights uses the shared history gate. Group join tells invited users where to answer. The `group-chat` and `creator-channels` shims are now plain `<Redirect>`s. |
| **Calls, live & network** (Z-E) | Call invites report their outcome. The 1:1 encryption badge is derived, not hard-coded. "Beauty" is renamed to an honest "Tint" (see §5). A failed incoming-call decline is retried and reported. Live has error and refresh states, and the host passcode no longer travels in route params. Live view keeps a failed chat draft, scrolls the chat and offers non-gesture controls. Call reliability reads the battery exemption back and persists "I've done this". |
| **Media, files & documents** (Z-F) | Doc Scanner stores scans encrypted (AES-256-GCM per file, device-bound key) and migrates old plaintext scans. Image editor: free, movable crop and a real colour-matrix filter (📱 capture). Whiteboard draws SVG paths, has undo/redo and can send to the chat. Media gallery opens photos and videos in the media viewer, which gains a seek bar and pinch zoom. Archive viewer inflates only the tapped entry, with size caps. The fake picture-in-picture in the video player is removed. The login token goes only to the app's own server in every viewer. |
| **Family Circle** (Z-G1) | The live map makes one coarse routing-matrix call (positions rounded to about 110 m) instead of sending every member's exact position (see §5). Invite codes are single-use and expire in 24 h (see §5). "Find my things" reports family members' tags it hears. Member management works without long-press. An unknown history permission is asked of the server, not assumed. |
| **Location, navigation & safety** (Z-G2) | Location retries a failed GPS fix and re-checks permission on return from Settings. Typed coordinates are range-checked. Lock settings save failures surface at the root cause. Location Lock, Lock alert, Lock history, SOS, Trusted contacts and AI Guardian surface load failures. Alarm colours are a named fixed palette, and the flash respects Reduce Motion. |
| **Spaces** (Z-H) | Attendance reads one track, picks the work zone properly and reads the shift from the server, with a device fallback. Runs admin sets the time and handover code at creation and keeps stop ids. The run driver can call a guardian. Visitors can sign out per row, and codes are masked. Leave uses date pickers, local dates, Withdraw and an allowance editor. The family alerts store shares one in-flight read and reports a failed clear. |
| **Finance** (Z-I1) | Ledger and chitti statuses now change on their own (overdue, completed, closed), and compound interest is honoured in one shared rule set. Recurring reminders advance, and Yearly is offered. Search matches amounts exactly and searches Lucky Draw members. Customer matches on mobile. The calendar shows one auction per month and taps through. The full backup is sealed with a password; old plain backups still restore. CSV import runs in one transaction. |
| **Shop Book & admin** (Z-I2) | `app/shop-book.tsx` is split from about 5,800 lines into a 344-line shell plus `components/shopbook/*`, with the re-rater finding all 72 declarations present. Repeat orders keep their product ids and idempotency key. The "other" reject note and Request Pro are wired to the new endpoints. Every touchable has a role. Currency follows the shop. Admin pages: tabs, live regions, focus styles, linked navigation, JSON validation and double-submit guards, with CSP hashes recomputed. |
| **Settings, privacy & vault** (Z-J) | The four server privacy settings have one owner screen (Last seen & privacy). The Vault and Encrypted notes re-lock in the background; notes seal an unsaved draft first. The privacy dashboard degrades per fact instead of failing whole. Status privacy confirms before a mode switch clears a list. VaultCheck has retry and a timeout. |
| **Utilities, comfort & games** (Z-K) | Notifications and the Security Hub share one safety nav bar. The dashboard rows link to where each setting is changed. Storage manager skips unreadable folders and counts what it deletes. Offline mode says what a retry did and lists chats with failed messages. Vision Comfort and Eye Check ask before discarding. Games: quick-match cancel race fixed, piece names for screen readers, Start-disabled reasons, overlays close with Back. |
| **Backend** (Z-BE, `3353236`) | Written in `vaultchat-backend-go`, **not deployed**: the server checks the MPIN on account delete; the Shop Book reject note (migration 140) and Request Pro (migration 141); the admin returns `shopId` filter; guardians for the run's driver; a shift read; in-place stop updates; and a join preview. Tested against a scratch PostgreSQL 16 database. |
| **Cross-cutting** | New `lib/uiDebtRatchet` selftest (`b31ab90`): per file under `app/` and `components/`, the count of touchables without a role and of hex colour literals may only go down. It now reports 37 and 954. |

The per-item logs, with evidence for each claim, were kept in the working session (`fixes/P1–P9, H, R1–R5` for rounds 1–2; `fixes/ZA–ZK, ZBE, ZC1b, ZR, ZS` for round 3). The re-ratings in the appendices verify those claims against the code.

## 3. Regressions found and fixed

### Rounds 1 and 2

The independent re-raters found problems that the fixes had introduced or left behind. All of the following are fixed:
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

### Round 3 — fixed after re-rating (not re-scored)

The round-3 re-raters reported these regressions, plus older problems they found for the first time. Each was fixed in a later commit; no reviewer has re-scored the fix.

| Found by | Problem | Fixed in |
|---|---|---|
| A | **High.** `delete-account` dropped the phone-side MPIN check, while the deployed server still ignores `mpin`, so any 6 digits would delete the account. | `815c7a5`: the MPIN pre-check is restored before the delete; `mpin` is still sent for the new server. |
| B | The status lock answer was hidden with no way to check it; a typo would lock out every viewer for good. | `5d7c50b`: Show/Hide answer toggle. |
| C1 | Unrevealed Invisible Ink text appeared in the reply bar, the quoted reply, the Memory banner and the in-chat search count (older than round 3). TalkBack could still reach the header and banners under the chat-lock veil. On iOS, modal sheets sat inside an accessible backdrop. "1 matches". | `7c2bd24`: one protected-text helper; the whole chat above the veil is hidden from screen readers while locked; backdrops are siblings of the sheets. |
| C2 | A damaged reminders list blocked every new reminder with no way out. | `815c7a5`: "Clear reminders" after a confirm. |
| C2 | In-chat search results could include view-once and Invisible Ink text; scheduled-message previews ignored chat locks; a per-chat wallpaper ignored the all-chats wallpaper; a failed "Turn off" of encrypted backup left the screen saying On (all older than round 3). | `815c7a5`. |
| E+K | Call reliability turned "can't tell" into a positive "Done". Live join folded server errors into "invalid link"; call invites reported a rate-limited ring as "Calling X"; cache-cleanup setting failures were swallowed (handoffs that had not landed). The dashboard did not refresh after you changed a linked setting. | `9a3460e`: tri-state battery card (`readBatteryExemption` in `lib/batteryOptimization.ts`); `'network'` reason; `rate_limited` invite outcome; setters reject; reload on focus. |
| F | Doc Scanner could lose a scan's key: the migration deleted the plaintext before the sealed list was saved, and a failed save still said "PDF ready". Media viewer hid its play and seek controls from screen readers and spun forever without a token. Image editor dropped edits on hardware back. Story viewer had no accessible pause. Video player awaits were uncaught. | `815c7a5`. Image-editor capture is now cropped but still screen-resolution (partial); story-viewer reduce-motion is deferred. |
| G1 | The family hub sent full-precision positions to the routing matrix; family-setup's pending-join exit could dead-end. | `21ec13e`. |
| G2 | Location Lock's failed-save alert said the previous mode was still in use, although the new mode was already applied. | `21ec13e`. |
| H | The runs-admin handover-code option said "at drop-off" although drivers are asked on boarding too; a stale "not a map" comment in transport. | `298f739`. |
| I1 | **Yearly finance reminders fired a month late** (1-based month in the OS trigger). Stale chitti comment. | `298f739`. |
| I1 | Two overlapping reads could each add an automatic status history row. | `a72296b`: the timeline entry is written only when the guarded update changed a row. |
| I2 | Shop Book chips printed glyph names ("cash-outline CASH"); white on the dark-theme green fill was about 1.9:1; orphan comments after the split. | `298f739`: icons render; `greenFill` token at 5.3:1. |
| I2 | Khata "Share bill/receipt" was unreachable by screen readers inside the grouped row. | `d7f4e51`: offered as an accessibility action on the row (📱). |
| J | VaultCheck's timeout claimed the analysis stopped, and its elapsed counter spoke every second. The vault-features lock picker and the vault export sheet wrapped their options in the backdrop. A stale filevault comment. | `298f739`. |

### Round 3 — reported and still open

- **Root** (`app/_layout.tsx`): one new `as any` (9 in the file). Trivial.
- **Profile:** sign-out tears down push and the socket before `logoutUser()` succeeds. Minor.
- **Search:** the snippet is highlighted against the live query, not the query that produced the hits. Cosmetic.
- **GatePicker:** `makeS(c)` takes the palette but never reads it. Minor.
- **Group calendar:** the iOS picker is a modal inside the composer modal (📱). The shared `components/finance/useDatePicker` draws its iOS sheet with the finance palette on group and space screens (also H).
- **Space devices:** the new rename modal is a sibling of an open full-screen modal and may not present on iOS (📱).
- **Video call:** `lib/call/callControls.selftest.ts` still asserts "Beauty is gone", while the button exists as "Tint" (see §5).
- **File preview:** the whole file (up to 2 MB) is tokenised up front instead of per row.
- **Media viewer:** the Z-F log overstated the hex cleanup (15 literals remain, not 5). Not a code regression.
- **FamilyMap:** the `memberRoutes` path is now dead code. Family setup's "Family Circle" copy reads oddly for users from other space types.
- **AI Guardian:** its `ponytail:` comment says `STATUS_META` is not exported; it is, so the hard-coded severity colours can go.
- **Privacy dashboard:** the screenshot-blocking fact is still a platform guess in Android release builds (`lib/screenGuard.ts:132` returns `native || Platform.OS === 'android'`).
- **Calls:** a 409 "call ended" invite still reads "Calling X" (`ringCallGroup` in `lib/callSession.ts` returns null on that 409, so the socket fallback reports the target count).
- **Chat:** the bubble is one accessible element with no role, so its nested controls may be unreachable on iOS (📱). The lock error has no live region, "Back to chats" and Leave group replace or strand an embedded pane, and the composer input has no label.

## 4. Blocked — needs a backend or ops change (not deployable from here)

**Written, waiting for deploy.** Deploys are file copies. In this order (from `fixes/ZBE.md`):
1. Apply migrations `140_shopbook_reject_note.sql` and `141_shopbook_pro_request.sql` (`vaultchat-backend/migrations/`). The new Go code reads their columns, so deploying it first makes the order view and the admin subscriptions list fail.
2. Copy the 9 modified Go files (`internal/redisx/redisx.go`, `internal/routes/{auth,user,shopbook,shopbook_admin2,shopbook_return,spaces_runs,spaces_ops,chats}.go`) and rebuild `go-api` (and `maps-api`, the same image).
3. Then remove the `ponytail:` MPIN pre-check in `app/delete-account.tsx`, so a delete does not spend two attempts.

| Item | State |
|---|---|
| Delete account | Server MPIN check written (`user.go`). Until it is deployed, only the phone checks the MPIN. |
| Shop Book "other" reject note | Server field written (migration 140). Until then the server ignores the note. |
| Shop Book Request Pro | Endpoint written (migration 141). Until then the button reports "Could not send the request". `/shopbook/my-shop` does not yet return `proRequestedAt` or the entitled plan. |
| Admin returns filter | `?shopId=` written. Until then the page shows its "not filtered" warning. |
| Spaces "Call guardian", shift read, in-place stops | Written. Until then the app falls back: the honest guardian alert, the device copy of the shift, and re-mapping riders after a stop save. |
| `/join` preview | Written. Until then the join screen shows its generic confirmation. |
| Live broadcast reapers | In backend source (`golive_reaper.go`, `broadcast_reaper.go`); deployment not confirmed. live-view relies on them instead of ending on unmount. |

**Not written yet.**

| Item | What is needed |
|---|---|
| Shared https links | Host `assetlinks.json` on `vaultchat.app`, then set `autoVerify: true`. iOS also needs Associated Domains (`apple-app-site-association`). |
| Sign-in and MPIN recovery | A possession factor (OTP) before MPIN sign-in on a new device and before recovery answers; `/auth/lookup` should stop returning `userId` unauthenticated. |
| Hidden chats | A per-user attempt limit on `POST /user/pin/verify`. |
| Chat | `notifSound` on `GET /chats/:id` (to mark the current sound); per-member read/delivered times for Message Info. |
| Broadcast channels | Leave, admin post delete, and `channelId` on `channel_post`. |
| Groups | One approval queue for invite-link joins and invitations; structured 409 codes on membership requests; communities leave/edit/delete/attach; `updated_by` on group events. |
| Spaces | Runs with riders in one call (removes the per-run reads in admin, ops map and transport); the shift readable by plain members. |
| SOS | Count actual push deliveries if "alerted" should mean "reached". |
| Network test | An app-owned speed endpoint instead of Cloudflare. |
| Games | A draw-offer field in the chess protocol (the games server is not ours). |
| Family location | A design for sealing the location-store upload, or an opt-out of server retention. |
| Admin site | Copy `admin/shopbook.html` next to `index.html` (`admin/LOGS_DEPLOY.md`); `frame-ancestors` header and self-hosted fonts. |

## 5. Decisions for you

- **Legacy call code (~1,170 lines).** It never runs while `CALL_ENGINE_V2` is on. `constants/flags.ts` keeps it as the rollback until the hardware test pass in `CALLS_README.md` has been done, so it was not deleted.
- **Video-call "Tint" (was "Beauty").** It is a local preview tint, now named honestly. `lib/call/callControls.selftest.ts` still claims the button is gone, as requested. Remove the button, or update the test to say it was renamed.
- **Calendar reminders under the "hidden" notification preview.** They fire with generic text instead of being dropped. Hiding previews now rewrites booked titles at once; showing them again waits for the next sync.
- **Sealed caches.** The ghost-mode list and the session IPs go only to the encrypted cache. While `VAULT_CACHE_ENCRYPTED` is off, those two screens have nothing to show offline. The new contact-match cache follows the same rule.
- **Deleted screens that worked.** `voice-speed`, `voice-transcribe` and `slideshow` worked but had no entry point. They were deleted per the plan; restore them from git and wire them in if you want them.
- **Two group-creation flows.** "New group" uses invites with consent. The Family-Space `group-create` flow is unchanged; both headers now document the split.
- **Mini-app to-dos (`vc_miniapp_todos`).** They stay on the device and are not in the sign-out purge. They are sealed with the cache key that sign-out drops. Add the key to the purge if you want it removed.
- **Family live map.** Connectors now show road distance and time from one coarse routing call, instead of drawing every member's road route by default. This overrides the earlier "always-on road routes" choice, for privacy. One member's route is still a tap away.
- **Family invite codes.** Each shared code works once and expires after 24 h, so inviting three people means sharing three times.
- **Doc Scanner and camera scan.** Two scan-to-PDF paths remain (the camera review sheet and Doc Scanner). Merge them, or keep both.
- **Perf debug.** It is still reachable by long-press on the profile version line. It shows only the owner's device telemetry. Gate it behind a diagnostics flag if you prefer.
- **Resume relock for Device-PIN users.** It now applies to everyone with a Device PIN, including users who set one only for the Vault, using the default 5-minute Auto Screen Lock.
- **Finance lock.** Finance has no lock of its own on top of the app lock, and its data is plain SQLite on the device.

## 6. Still open (known, not done)

- The open round-3 regressions in §3.
- **Large files and casts:** `app/_layout.tsx` (9 `as any`), `app/live-view.tsx`, `app/file-viewer.tsx`, `app/family.tsx`, `app/encrypted-notes.tsx`, `app/import-chats.tsx`, `components/chat/MessageBubble.tsx` and the games boards are not split. Route casts remain where `typedRoutes` needs generated types.
- **Palette tokens:** add `onPrimary`, `onDanger` and `warning`, so the named white and amber constants across chat, notifications, comfort, spaces and storage screens can move onto tokens.
- **Accessibility:** the uiDebtRatchet holds the line, but 37 touchables still have no role and the Chess, Ludo and Rummy boards have had no full screen-reader pass.
- **Chat:** GIF and Forward still post directly instead of through the outbox (`lib/messageQueue.ts` has no typed enqueue).
- **Chat tools:** `useDatePicker` still lives in `components/finance`; protected bookmark snapshots are hidden but not purged (`lib/chatService` has no snapshot delete); backup-e2ee cannot change its password or switch to a key while on, because `enableE2EEBackup` still deletes the secret when an upload fails.
- **Media:** image-editor output is cropped but still screen-resolution; story viewer does not respect Reduce Motion; PdfView has no zoom gesture.
- Every remaining per-screen gap is listed under "Still needed for 10/10" in Appendix C.

## 7. Updated scorecard — all 193 screens

**Before** is the baseline review. **Round 1** is the first re-rating. **Before round 3** is the score going into round 3 (round 2 where a screen was re-rated again, otherwise round 1, otherwise unchanged). **Round 3** is this round's independent score. **Now** is the latest score: round 3 for every remaining screen. **Δ** is Now − Before. "Fixed after re-rating" names the later commits that changed the screen; those changes are not reflected in the score.

| Area | Screen | Before | Round 1 | Before round 3 | Round 3 | Now | Δ | Status |
|---|---|---|---|---|---|---|---|---|
| Launch, auth & lock | `app/(tabs)/_layout.tsx` | 7.5 | 7.5 | 7.5 | 8 | **8** | +0.5 | re-rated |
| Launch, auth & lock | `app/_layout.tsx` | 6.5 | 7 | 7 | 7.5 | **7.5** | +1 | re-rated |
| Launch, auth & lock | `app/app-lock.tsx` | 6 | 7 | 7.5 | 7.5 | **7.5** | +1.5 | re-rated |
| Launch, auth & lock | `app/backup-pin.tsx` | 4.5 | 7 | 7 | 8 | **8** | +3.5 | re-rated |
| Launch, auth & lock | `app/biometric-setup.tsx` | 3.5 | — | — | — | **—** |  | deleted |
| Launch, auth & lock | `app/blocked.tsx` | 6.5 | 7 | 7.5 | 8 | **8** | +1.5 | re-rated |
| Launch, auth & lock | `app/delete-account.tsx` | 7.5 | 8 | 8 | 8 | **8** | +0.5 | re-rated; fixed after re-rating, not re-scored (`815c7a5`) |
| Launch, auth & lock | `app/email-verify.tsx` | 7.5 | — | 7.5 | 8 | **8** | +0.5 | re-rated |
| Launch, auth & lock | `app/index.tsx` | 7 | 7.5 | 7.5 | 8 | **8** | +1 | re-rated |
| Launch, auth & lock | `app/lock.tsx` | 2.5 | — | — | — | **—** |  | deleted |
| Launch, auth & lock | `app/mpin-entry.tsx` | 7.5 | 8 | 8 | 8 | **8** | +0.5 | re-rated |
| Launch, auth & lock | `app/mpin-recover.tsx` | 7 | 7 | 7 | 7.5 | **7.5** | +0.5 | re-rated |
| Launch, auth & lock | `app/onboard-mpin.tsx` | 8 | — | 8 | 8.5 | **8.5** | +0.5 | re-rated |
| Launch, auth & lock | `app/onboard-profile.tsx` | 6.5 | — | 6.5 | 8 | **8** | +1.5 | re-rated |
| Launch, auth & lock | `app/onboard-security.tsx` | 7.5 | — | 7.5 | 8 | **8** | +0.5 | re-rated |
| Launch, auth & lock | `app/onboard-success.tsx` | 7.5 | — | 7.5 | 8 | **8** | +0.5 | re-rated |
| Launch, auth & lock | `app/onboard.tsx` | 7.5 | — | 7.5 | 7.5 | **7.5** | 0 | re-rated |
| Launch, auth & lock | `app/permissions.tsx` | 6.5 | 6.5 | 6.5 | 8 | **8** | +1.5 | re-rated |
| Launch, auth & lock | `app/restore-backup.tsx` | 6.5 | 7 | 7 | 8 | **8** | +1.5 | re-rated |
| Launch, auth & lock | `app/security-questions.tsx` | 3.5 | — | — | — | **—** |  | deleted |
| Launch, auth & lock | `app/setup-complete.tsx` | 4.5 | — | — | — | **—** |  | deleted |
| Tabs, contacts & links | `app/(tabs)/alerts.tsx` | 6.5 | 7.5 | 7.5 | 8.5 | **8.5** | +2 | re-rated |
| Tabs, contacts & links | `app/(tabs)/calls.tsx` | 6.5 | 7.5 | 7.5 | 8.5 | **8.5** | +2 | re-rated |
| Tabs, contacts & links | `app/(tabs)/chats.tsx` | 7 | 7.5 | 7.5 | 8 | **8** | +1 | re-rated |
| Tabs, contacts & links | `app/(tabs)/mini.tsx` | 8 | — | 8 | 8.5 | **8.5** | +0.5 | re-rated |
| Tabs, contacts & links | `app/(tabs)/profile.tsx` | 6.5 | 7 | 7 | 8 | **8** | +1.5 | re-rated |
| Tabs, contacts & links | `app/(tabs)/status.tsx` | 6.5 | 6.5 | 6.5 | 8 | **8** | +1.5 | re-rated; fixed after re-rating, not re-scored (`5d7c50b`) |
| Tabs, contacts & links | `app/add/[...segments].tsx` | 6.5 | 8 | 8 | 8.5 | **8.5** | +2 | re-rated |
| Tabs, contacts & links | `app/contact-info.tsx` | 6.5 | 7 | 7 | 8 | **8** | +1.5 | re-rated |
| Tabs, contacts & links | `app/contact.tsx` | 3 | — | — | — | **—** |  | deleted |
| Tabs, contacts & links | `app/contacts.tsx` | 6.5 | 7 | 7 | 8 | **8** | +1.5 | re-rated |
| Tabs, contacts & links | `app/i/[token].tsx` | 6 | 6.5 | 7 | 7.5 | **7.5** | +1.5 | re-rated |
| Tabs, contacts & links | `app/invite-link.tsx` | 7 | 7.5 | 7.5 | 8 | **8** | +1 | re-rated |
| Tabs, contacts & links | `app/join/[code].tsx` | 7 | 8 | 8 | 8.5 | **8.5** | +1.5 | re-rated |
| Tabs, contacts & links | `app/msgrequests.tsx` | 4 | — | — | — | **—** |  | deleted |
| Tabs, contacts & links | `app/new-chat.tsx` | 6.5 | 7.5 | 7.5 | 8 | **8** | +1.5 | re-rated |
| Tabs, contacts & links | `app/qr-contact.tsx` | 6.5 | 7 | 7 | 8 | **8** | +1.5 | re-rated |
| Tabs, contacts & links | `app/search.tsx` | 7.5 | 8 | 8 | 8.5 | **8.5** | +1 | re-rated |
| Tabs, contacts & links | `app/sync-contact.tsx` | 5.5 | — | — | — | **—** |  | deleted |
| Tabs, contacts & links | `app/verify-contact.tsx` | 7.5 | 8 | 8 | 8.5 | **8.5** | +1 | re-rated |
| Chat conversation | `app/chat.tsx` | 6 | 7.5 | 7.5 | 8 | **8** | +2 | re-rated; fixed after re-rating, not re-scored (`7c2bd24`) |
| Chat tools & backup | `app/app-lock-chats.tsx` | 3.5 | 7.5 | 7.5 | 8 | **8** | +4.5 | re-rated |
| Chat tools & backup | `app/backup-e2ee.tsx` | 6 | 7.5 | 7.5 | 8 | **8** | +2 | re-rated; fixed after re-rating, not re-scored (`815c7a5`) |
| Chat tools & backup | `app/bookmarks.tsx` | 5.5 | 7.5 | 7.5 | 8 | **8** | +2.5 | re-rated |
| Chat tools & backup | `app/broadcast.tsx` | 5.5 | 7 | 7 | 7.5 | **7.5** | +2 | re-rated |
| Chat tools & backup | `app/chat-backup.tsx` | 6 | 7 | 7 | 7.5 | **7.5** | +1.5 | re-rated |
| Chat tools & backup | `app/chat-code.tsx` | 7 | 8 | 8 | 8 | **8** | +1 | re-rated |
| Chat tools & backup | `app/chat-export.tsx` | 5.5 | 6 | 7 | 7.5 | **7.5** | +2 | re-rated |
| Chat tools & backup | `app/chat-themes.tsx` | 6 | 7.5 | 7.5 | 8 | **8** | +2 | re-rated |
| Chat tools & backup | `app/chat-wallpaper.tsx` | 5.5 | 7 | 7 | 7.5 | **7.5** | +2 | re-rated; fixed after re-rating, not re-scored (`815c7a5`) |
| Chat tools & backup | `app/create-poll.tsx` | 7 | 8 | 8 | 8 | **8** | +1 | re-rated |
| Chat tools & backup | `app/hidden-chats.tsx` | 5.5 | — | 5.5 | 7.5 | **7.5** | +2 | re-rated |
| Chat tools & backup | `app/import-chats.tsx` | 6.5 | 7.5 | 7.5 | 7.5 | **7.5** | +1 | re-rated |
| Chat tools & backup | `app/in-chat-search.tsx` | 7 | 8 | 8 | 8 | **8** | +1 | re-rated; fixed after re-rating, not re-scored (`815c7a5`) |
| Chat tools & backup | `app/message-reminder.tsx` | 5.5 | 7 | 7.5 | 8 | **8** | +2.5 | re-rated; fixed after re-rating, not re-scored (`815c7a5`) |
| Chat tools & backup | `app/receipt-control.tsx` | 6.5 | 7 | 7 | 7.5 | **7.5** | +1 | re-rated |
| Chat tools & backup | `app/schedule-message.tsx` | 6.5 | 8 | 8 | 8 | **8** | +1.5 | re-rated |
| Chat tools & backup | `app/scheduled.tsx` | 6 | 7 | 7 | 7.5 | **7.5** | +1.5 | re-rated; fixed after re-rating, not re-scored (`815c7a5`) |
| Chat tools & backup | `app/stickers.tsx` | 4.5 | — | — | — | **—** |  | deleted |
| Groups & communities | `app/communities.tsx` | 5.5 | 6.5 | 6.5 | 7 | **7** | +1.5 | re-rated |
| Groups & communities | `app/create-group.tsx` | 6 | 7 | 7 | 8 | **8** | +2 | re-rated |
| Groups & communities | `app/creator-channels.tsx` | 3.5 | 4.5 | 4.5 | 10 | **10** | +6.5 | re-rated |
| Groups & communities | `app/group-admin.tsx` | 5.5 | 6 | 6 | 7.5 | **7.5** | +2 | re-rated |
| Groups & communities | `app/group-calendar.tsx` | 6 | 7 | 7 | 8 | **8** | +2 | re-rated |
| Groups & communities | `app/group-calls.tsx` | 5.5 | 7 | 7 | 8 | **8** | +2.5 | re-rated |
| Groups & communities | `app/group-chat.tsx` | 4 | — | 4 | 9.5 | **9.5** | +5.5 | re-rated |
| Groups & communities | `app/group-create.tsx` | 7 | — | 7 | 8 | **8** | +1 | re-rated |
| Groups & communities | `app/group-info.tsx` | 6 | 7 | 7 | 7.5 | **7.5** | +1.5 | re-rated |
| Groups & communities | `app/group-insights.tsx` | 6.5 | 6.5 | 6.5 | 7.5 | **7.5** | +1 | re-rated |
| Groups & communities | `app/group-invitations.tsx` | 7 | — | 7 | 8 | **8** | +1 | re-rated |
| Groups & communities | `app/group-invites.tsx` | 7 | 7 | 7 | 8 | **8** | +1 | re-rated |
| Groups & communities | `app/group-join.tsx` | 7 | — | 7 | 8 | **8** | +1 | re-rated |
| Groups & communities | `app/group-members.tsx` | 7 | 7.5 | 7.5 | 8 | **8** | +1 | re-rated |
| Groups & communities | `app/group-notes.tsx` | 6 | 7 | 7 | 7.5 | **7.5** | +1.5 | re-rated |
| Groups & communities | `app/group-privacy.tsx` | 6.5 | 7.5 | 7.5 | 8 | **8** | +1.5 | re-rated |
| Groups & communities | `app/group-tasks.tsx` | 6.5 | 7.5 | 7.5 | 8 | **8** | +1.5 | re-rated |
| Groups & communities | `app/group-trip.tsx` | 6.5 | 7.5 | 7.5 | 8 | **8** | +1.5 | re-rated |
| Calls, live & voice | `app/call-recording.tsx` | 3.5 | — | — | — | **—** |  | deleted |
| Calls, live & voice | `app/call-reliability.tsx` | 6.5 | — | 6.5 | 7.5 | **7.5** | +1 | re-rated; fixed after re-rating, not re-scored (`9a3460e`) |
| Calls, live & voice | `app/group-call-active.tsx` | 6.5 | 7 | 7 | 7.5 | **7.5** | +1 | re-rated; fixed after re-rating, not re-scored (`9a3460e`) |
| Calls, live & voice | `app/incoming-call.tsx` | 6.5 | 7.5 | 7.5 | 8 | **8** | +1.5 | re-rated |
| Calls, live & voice | `app/live-view.tsx` | 6.5 | 6.5 | 7 | 7.5 | **7.5** | +1 | re-rated |
| Calls, live & voice | `app/live.tsx` | 7 | — | 7 | 8 | **8** | +1 | re-rated |
| Calls, live & voice | `app/live/join/[code].tsx` | 7 | — | 7 | 8 | **8** | +1 | re-rated; fixed after re-rating, not re-scored (`9a3460e`) |
| Calls, live & voice | `app/network-test.tsx` | 5 | 7 | 7 | 7.5 | **7.5** | +2.5 | re-rated |
| Calls, live & voice | `app/videocall.tsx` | 6.5 | 6.5 | 6.5 | 7 | **7** | +0.5 | re-rated; fixed after re-rating, not re-scored (`9a3460e`) |
| Calls, live & voice | `app/voice-effects.tsx` | 4 | — | — | — | **—** |  | deleted |
| Calls, live & voice | `app/voice-speed.tsx` | 4.5 | — | — | — | **—** |  | deleted |
| Calls, live & voice | `app/voice-transcribe.tsx` | 6 | — | — | — | **—** |  | deleted |
| Calls, live & voice | `app/voicecall.tsx` | 6.5 | 7 | 7 | 7.5 | **7.5** | +1 | re-rated; fixed after re-rating, not re-scored (`9a3460e`) |
| Media & files | `app/archive-viewer.tsx` | 6.5 | 7.5 | 7.5 | 8 | **8** | +1.5 | re-rated |
| Media & files | `app/camera.tsx` | 7.5 | 7.5 | 7.5 | 8 | **8** | +0.5 | re-rated |
| Media & files | `app/docscanner.tsx` | 5.5 | 6 | 6 | 7 | **7** | +1.5 | re-rated; fixed after re-rating, not re-scored (`815c7a5`) |
| Media & files | `app/file-preview.tsx` | 5 | 7 | 7.5 | 8 | **8** | +3 | re-rated |
| Media & files | `app/file-viewer.tsx` | 6.5 | 6.5 | 6.5 | 7.5 | **7.5** | +1 | re-rated |
| Media & files | `app/image-editor.tsx` | 4 | 5.5 | 5.5 | 7 | **7** | +3 | re-rated; fixed after re-rating, not re-scored (`815c7a5`) |
| Media & files | `app/media-gallery.tsx` | 6 | 6 | 6 | 7.5 | **7.5** | +1.5 | re-rated |
| Media & files | `app/media-viewer.tsx` | 4.5 | 6 | 6 | 7 | **7** | +2.5 | re-rated; fixed after re-rating, not re-scored (`815c7a5`) |
| Media & files | `app/reader.tsx` | 7.5 | 8 | 8 | 8 | **8** | +0.5 | re-rated |
| Media & files | `app/scanner.tsx` | 2 | — | — | — | **—** |  | deleted |
| Media & files | `app/shelf.tsx` | 6.5 | 8 | 8 | 8 | **8** | +1.5 | re-rated |
| Media & files | `app/slideshow.tsx` | 4.5 | — | — | — | **—** |  | deleted |
| Media & files | `app/story-viewer.tsx` | 6.5 | 7.5 | 7.5 | 7.5 | **7.5** | +1 | re-rated; fixed after re-rating, not re-scored (`815c7a5`) |
| Media & files | `app/video-player.tsx` | 3.5 | 5.5 | 5.5 | 7 | **7** | +3.5 | re-rated; fixed after re-rating, not re-scored (`815c7a5`) |
| Media & files | `app/whiteboard.tsx` | 4.5 | 5.5 | 5.5 | 7.5 | **7.5** | +3 | re-rated |
| Family Circle | `app/family-add.tsx` | 7 | 7.5 | 7.5 | 8 | **8** | +1 | re-rated |
| Family Circle | `app/family-alerts.tsx` | 7.5 | 8 | 8 | 8.5 | **8.5** | +1 | re-rated |
| Family Circle | `app/family-history.tsx` | 6 | 7.5 | 7.5 | 8 | **8** | +2 | re-rated |
| Family Circle | `app/family-items.tsx` | 6 | 6.5 | 6.5 | 7.5 | **7.5** | +1.5 | re-rated |
| Family Circle | `app/family-map.tsx` | 5.5 | 7 | 7 | 7.5 | **7.5** | +2 | re-rated |
| Family Circle | `app/family-member.tsx` | 6.5 | 7 | 7 | 7.5 | **7.5** | +1 | re-rated |
| Family Circle | `app/family-places.tsx` | 6.5 | 7.5 | 7.5 | 8 | **8** | +1.5 | re-rated |
| Family Circle | `app/family-setup.tsx` | 6 | 7.5 | 8 | 8 | **8** | +2 | re-rated; fixed after re-rating, not re-scored (`21ec13e`) |
| Family Circle | `app/family.tsx` | 6 | 7 | 7 | 7.5 | **7.5** | +1.5 | re-rated; fixed after re-rating, not re-scored (`21ec13e`) |
| Location & safety | `app/aiguardian.tsx` | 7 | 7.5 | 7.5 | 8 | **8** | +1 | re-rated |
| Location & safety | `app/current-location.tsx` | 4.5 | — | — | — | **—** |  | deleted |
| Location & safety | `app/emergency-sos.tsx` | 4.5 | 6.5 | 7 | 7.5 | **7.5** | +3 | re-rated |
| Location & safety | `app/location-lock.tsx` | 5.5 | 6.5 | 7 | 7.5 | **7.5** | +2 | re-rated; fixed after re-rating, not re-scored (`21ec13e`) |
| Location & safety | `app/location-sharing.tsx` | 4.5 | — | — | — | **—** |  | deleted |
| Location & safety | `app/location.tsx` | 6 | 6.5 | 6.5 | 7.5 | **7.5** | +1.5 | re-rated |
| Location & safety | `app/lock-alert.tsx` | 6 | 6.5 | 7 | 7.5 | **7.5** | +1.5 | re-rated |
| Location & safety | `app/lock-history.tsx` | 6 | 6.5 | 7 | 7.5 | **7.5** | +1.5 | re-rated |
| Location & safety | `app/lock-settings.tsx` | 6 | 6.5 | 6.5 | 7.5 | **7.5** | +1.5 | re-rated |
| Location & safety | `app/navigate.tsx` | 6 | 7 | 7 | 7.5 | **7.5** | +1.5 | re-rated |
| Location & safety | `app/trusted-contacts.tsx` | 6 | 7 | 7 | 7.5 | **7.5** | +1.5 | re-rated |
| Spaces | `app/space-admin.tsx` | 6 | 7 | 7 | 7.5 | **7.5** | +1.5 | re-rated |
| Spaces | `app/space-attendance.tsx` | 5 | 5 | 5 | 7 | **7** | +2 | re-rated |
| Spaces | `app/space-checkin.tsx` | 5.5 | 6.5 | 6.5 | 7.5 | **7.5** | +2 | re-rated |
| Spaces | `app/space-devices.tsx` | 4.5 | 6 | 6.5 | 7 | **7** | +2.5 | re-rated |
| Spaces | `app/space-incidents.tsx` | 5.5 | 7 | 7 | 7.5 | **7.5** | +2 | re-rated |
| Spaces | `app/space-leave.tsx` | 6 | 6 | 6 | 7.5 | **7.5** | +1.5 | re-rated |
| Spaces | `app/space-ops-map.tsx` | 5.5 | 6.5 | 6.5 | 7 | **7** | +1.5 | re-rated |
| Spaces | `app/space-overview.tsx` | 6 | 6.5 | 6.5 | 7.5 | **7.5** | +1.5 | re-rated |
| Spaces | `app/space-pending.tsx` | 5.5 | 7 | 7 | 7.5 | **7.5** | +2 | re-rated |
| Spaces | `app/space-people.tsx` | 6 | 7 | 7 | 7.5 | **7.5** | +1.5 | re-rated |
| Spaces | `app/space-roster.tsx` | 6 | 7 | 7 | 7.5 | **7.5** | +1.5 | re-rated |
| Spaces | `app/space-run-driver.tsx` | 5 | 6.5 | 6.5 | 7 | **7** | +2 | re-rated |
| Spaces | `app/space-run.tsx` | 6 | 6.5 | 6.5 | 7.5 | **7.5** | +1.5 | re-rated |
| Spaces | `app/space-runs-admin.tsx` | 4.5 | 6.5 | 7 | 7 | **7** | +2.5 | re-rated; fixed after re-rating, not re-scored (`298f739`) |
| Spaces | `app/space-tasks.tsx` | 6 | 7 | 7 | 7.5 | **7.5** | +1.5 | re-rated |
| Spaces | `app/space-transport.tsx` | 6.5 | 6.5 | 6.5 | 7 | **7** | +0.5 | re-rated; fixed after re-rating, not re-scored (`298f739`) |
| Spaces | `app/space-visitors.tsx` | 5.5 | 6.5 | 6.5 | 7.5 | **7.5** | +2 | re-rated |
| Finance | `app/finance/_layout.tsx` | 8 | — | 8 | 8.5 | **8.5** | +0.5 | re-rated |
| Finance | `app/finance/calendar.tsx` | 6.5 | 7 | 7 | 8 | **8** | +1.5 | re-rated |
| Finance | `app/finance/chitti/[id].tsx` | 5 | 6 | 6 | 7.5 | **7.5** | +2.5 | re-rated; fixed after re-rating, not re-scored (`298f739`, `a72296b`) |
| Finance | `app/finance/chitti/index.tsx` | 7 | 7 | 7 | 8 | **8** | +1 | re-rated; fixed after re-rating, not re-scored (`a72296b`) |
| Finance | `app/finance/chitti/new.tsx` | 7 | 7 | 7 | 8 | **8** | +1 | re-rated |
| Finance | `app/finance/customer.tsx` | 6 | 6.5 | 6.5 | 8 | **8** | +2 | re-rated |
| Finance | `app/finance/emi.tsx` | 7.5 | 8 | 8 | 8 | **8** | +0.5 | re-rated |
| Finance | `app/finance/index.tsx` | 6.5 | 7.5 | 7.5 | 8 | **8** | +1.5 | re-rated |
| Finance | `app/finance/interest.tsx` | 7 | 7 | 7 | 7.5 | **7.5** | +0.5 | re-rated |
| Finance | `app/finance/io.tsx` | 6.5 | 7.5 | 7.5 | 8 | **8** | +1.5 | re-rated |
| Finance | `app/finance/ledger/[id].tsx` | 6.5 | 7 | 7 | 8 | **8** | +1.5 | re-rated; fixed after re-rating, not re-scored (`a72296b`) |
| Finance | `app/finance/ledger/edit.tsx` | 6 | 7 | 7 | 7.5 | **7.5** | +1.5 | re-rated |
| Finance | `app/finance/ledger/index.tsx` | 7 | 7 | 7 | 7.5 | **7.5** | +0.5 | re-rated; fixed after re-rating, not re-scored (`a72296b`) |
| Finance | `app/finance/ledger/new.tsx` | 6.5 | 7 | 7 | 8 | **8** | +1.5 | re-rated |
| Finance | `app/finance/ledger/update.tsx` | 6.5 | 7.5 | 7.5 | 8 | **8** | +1.5 | re-rated |
| Finance | `app/finance/reminders.tsx` | 6 | 7 | 7 | 7.5 | **7.5** | +1.5 | re-rated; fixed after re-rating, not re-scored (`298f739`) |
| Finance | `app/finance/reports.tsx` | 6 | 6.5 | 6.5 | 7.5 | **7.5** | +1.5 | re-rated |
| Finance | `app/finance/saved.tsx` | 6.5 | 6.5 | 6.5 | 8 | **8** | +1.5 | re-rated |
| Finance | `app/finance/search.tsx` | 6 | 6.5 | 6.5 | 8 | **8** | +2 | re-rated |
| Finance | `app/interest-calculator.tsx` | 7 | — | 7 | 7.5 | **7.5** | +0.5 | re-rated |
| Finance | `app/split.tsx` | 7 | — | 7 | 8 | **8** | +1 | re-rated |
| Shop Book & admin | `admin/index.html` | 6.5 | 7 | 7 | 7.5 | **7.5** | +1 | re-rated |
| Shop Book & admin | `admin/logs.html` | 6.5 | 7 | 7 | 8 | **8** | +1.5 | re-rated |
| Shop Book & admin | `admin/shopbook.html` | 5.5 | 7 | 7 | 7.5 | **7.5** | +2 | re-rated |
| Shop Book & admin | `app/shop-book.tsx` | 5.5 | 6.5 | 6.5 | 7.5 | **7.5** | +2 | re-rated; fixed after re-rating, not re-scored (`298f739`, `d7f4e51`) |
| Settings, privacy & vault | `app/d2de-status.tsx` | 5 | 7 | 7 | 8 | **8** | +3 | re-rated |
| Settings, privacy & vault | `app/encrypted-notes.tsx` | 5 | 6 | 6 | 7 | **7** | +2 | re-rated |
| Settings, privacy & vault | `app/filevault.tsx` | 8 | — | 8 | 8.5 | **8.5** | +0.5 | re-rated; fixed after re-rating, not re-scored (`298f739`) |
| Settings, privacy & vault | `app/ghost-mode.tsx` | 6 | 8 | 8 | 8.5 | **8.5** | +2.5 | re-rated |
| Settings, privacy & vault | `app/last-seen-privacy.tsx` | 7 | 7.5 | 7.5 | 8.5 | **8.5** | +1.5 | re-rated |
| Settings, privacy & vault | `app/login-history.tsx` | 7.5 | 8 | 8 | 8.5 | **8.5** | +1 | re-rated |
| Settings, privacy & vault | `app/privacy-dashboard.tsx` | 4.5 | 8 | 8 | 8.5 | **8.5** | +4 | re-rated |
| Settings, privacy & vault | `app/settings.tsx` | 6.5 | 8 | 8 | 8.5 | **8.5** | +2 | re-rated |
| Settings, privacy & vault | `app/status-privacy.tsx` | 6.5 | 7 | 7.5 | 8.5 | **8.5** | +2 | re-rated |
| Settings, privacy & vault | `app/vault-features.tsx` | 3.5 | 6 | 6 | 8 | **8** | +4.5 | re-rated; fixed after re-rating, not re-scored (`298f739`) |
| Settings, privacy & vault | `app/vault.tsx` | 3.5 | 6 | 6.5 | 7.5 | **7.5** | +4 | re-rated; fixed after re-rating, not re-scored (`298f739`) |
| Settings, privacy & vault | `app/vaultbeam-settings.tsx` | 5.5 | 6.5 | 6.5 | 7.5 | **7.5** | +2 | re-rated |
| Settings, privacy & vault | `app/vaultcheck.tsx` | 7 | — | 7 | 8 | **8** | +1 | re-rated; fixed after re-rating, not re-scored (`298f739`) |
| Settings, privacy & vault | `app/vaultdrop.tsx` | 2.5 | — | — | — | **—** |  | deleted |
| Utilities & games | `app/cache-cleanup.tsx` | 7.5 | 8 | 8 | 8.5 | **8.5** | +1 | re-rated; fixed after re-rating, not re-scored (`9a3460e`) |
| Utilities & games | `app/dashboard.tsx` | 6.5 | 7 | 7 | 7.5 | **7.5** | +1 | re-rated; fixed after re-rating, not re-scored (`9a3460e`) |
| Utilities & games | `app/email-bridge.tsx` | 2.5 | — | — | — | **—** |  | deleted |
| Utilities & games | `app/eye-check.tsx` | 8 | — | 8 | 8.5 | **8.5** | +0.5 | re-rated |
| Utilities & games | `app/games.tsx` | 7.5 | 7.5 | 7.5 | 8 | **8** | +0.5 | re-rated |
| Utilities & games | `app/meeting-scheduler.tsx` | 4 | — | — | — | **—** |  | deleted |
| Utilities & games | `app/notification-sounds.tsx` | 6.5 | 7.5 | 7.5 | 8 | **8** | +1.5 | re-rated |
| Utilities & games | `app/notifications.tsx` | 6 | 7 | 7 | 7.5 | **7.5** | +1.5 | re-rated |
| Utilities & games | `app/offline-mode.tsx` | 3 | 8 | 8 | 8.5 | **8.5** | +5.5 | re-rated |
| Utilities & games | `app/perf-debug.tsx` | 8 | — | 8 | 8.5 | **8.5** | +0.5 | re-rated |
| Utilities & games | `app/storage-manager.tsx` | 6 | 7 | 7 | 8 | **8** | +2 | re-rated |
| Utilities & games | `app/vision-comfort.tsx` | 8 | — | 8 | 8.5 | **8.5** | +0.5 | re-rated |


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

## Appendix C — Round 3 re-rating (174 screens)

The 13 round-3 batch reports, as the re-raters wrote them; only the heading levels are normalised. They score the code at `c28d1b2` or `5d7c50b`. Fixes made after that (§3) are not reflected here.

### A — Launch, auth & lock — round-3 re-rating

This is an independent, static, read-only review of `b8c8bd2` → `HEAD` (`c28d1b2`). It uses the same rubric (`RUBRIC.md`) and format (`RERATE.md`).

**Baselines and open items.** The "Old" scores are the ones given in the task. The open items come from the latest list for each screen:
- `rerate2/X1.md`: root, index, app-lock, blocked.
- `rerate/A.md`: tabs, mpin-entry, mpin-recover, restore-backup, delete-account, permissions, backup-pin.
- The original section A of `2026-10-04_screen_ratings.md`: onboard, email-verify, onboard-profile, onboard-security, onboard-mpin, onboard-success, and the shared auth components.

**What I read.** The fixer's claims in `fixes/ZA.md` were checked against the code. I read:
- every changed hunk in the 17 screens;
- the changed helpers: `lib/pendingLink.ts`, `lib/callBackground.ts`, `lib/resumeLockPolicy.ts`, `components/{ResumeLock,ErrorBoundary,UpdateGate,TermsGate,PinPad}.tsx`, `components/auth/{MpinInput,PhoneField,SecurityQuestionRow}.tsx`, `components/ui/Sheet.tsx`, `lib/{weakPin,onboardDate}.ts`, `lib/onboarding.ts` (`isOfflineError`) and `lib/chatService.ts` `deleteAccount`;
- the server's delete handler at `b8c8bd2` and at HEAD.

**Checks I ran myself.** Nothing was device-tested. The backend round-3 changes are committed but **not deployed**.
- `npx tsc --noEmit -p .`: 0 errors.
- `npx eslint` on all batch files and helpers: 0 errors and 1 warning. The warning is the existing gate-effect deps warning at `app/_layout.tsx:304`.
- These `npx tsx` selftests exited 0: pendingLink, resumeLockPolicy, weakPin (new), onboardDate (new), orphanRoutes (51), a11yCoverage, themeCoverage (22/20), screenBackCoverage, startupColdPath, launchVeil, onboardNav, securityVerdict, termsNegotiation, confirmIdentity, pinFormat and uiDebtRatchet. In the ratchet baseline, every batch-A file has 0 touchables without a role.

**Rounding.** Each overall score is the mean of the six dimensions, rounded to the nearest 0.5. Ties round up, the convention used in X1. Three screens land exactly on a tie at a mean of 7.75: tabs, email-verify and onboard-profile. Each of them is at most 0.5 above the other way of rounding.

| Screen | Old | New | Δ |
|---|---|---|---|
| `app/_layout.tsx` (root shell) | 7.0 | 7.5 | +0.5 |
| `app/index.tsx` | 7.5 | 8.0 | +0.5 |
| `app/(tabs)/_layout.tsx` | 7.5 | 8.0 | +0.5 (tie) |
| `app/onboard.tsx` | 7.5 | 7.5 | 0 |
| `app/email-verify.tsx` | 7.5 | 8.0 | +0.5 (tie) |
| `app/onboard-profile.tsx` | 6.5 | 8.0 | +1.5 (tie) |
| `app/onboard-security.tsx` | 7.5 | 8.0 | +0.5 |
| `app/onboard-mpin.tsx` | 8.0 | 8.5 | +0.5 |
| `app/onboard-success.tsx` | 7.5 | 8.0 | +0.5 |
| `app/mpin-entry.tsx` | 8.0 | 8.0 | 0 |
| `app/mpin-recover.tsx` | 7.0 | 7.5 | +0.5 |
| `app/app-lock.tsx` | 7.5 | 7.5 | 0 |
| `app/restore-backup.tsx` | 7.0 | 8.0 | +1.0 |
| `app/delete-account.tsx` | 8.0 | 8.0 | 0 (**security regression, see below**) |
| `app/blocked.tsx` | 7.5 | 8.0 | +0.5 |
| `app/permissions.tsx` | 6.5 | 8.0 | +1.5 |
| `app/backup-pin.tsx` | 7.0 | 8.0 | +1.0 |

**Round-3 regressions in this batch:**
1. **delete-account (high):** account deletion currently has no re-authentication at all. See that section.
2. **Root (trivial):** one new `as any` (`app/_layout.tsx:339`). ZA said there were "no new casts".

The chat.tsx and shop-book.tsx splits touch no batch-A file.

---

#### `app/_layout.tsx` — **7.0 → 7.5**
- **Scores now:** Function 7.5 · States 8.5 · UI 7.5 · A11y 7.5 · Security 8.5 · Code 4.5 (mean 7.33)
- **Original items (X1):**
  1. ✅ **Stashed-forever tap (X1 regression).** `openWhenUnlocked` now decides by the current route (`lib/pendingLink.ts:164-169`). Once the user is off a lock or auth route, a `launch === false` no longer holds taps. The pendingLink selftest passes.
  2. ✅ **Cold-start tap lost to index's replace.**
     - A tap on `/` is held until `markLaunchRouted()` (`lib/pendingLink.ts:145-146,166-167`).
     - index replays it after its replace (`app/index.tsx:60-63`).
     - Background family-alert presses now route through `deliverTap` → `onDeliveredTap(openHref)` (`lib/callBackground.ts:46-51`, `app/_layout.tsx:444-452`), with 10 s de-duplication against `getInitialNotification` (`lib/pendingLink.ts:181-201`, `app/_layout.tsx:840-842`).
  3. ✅ **Resume lock was MFA-only.** It now uses `lockAppliesTo({signedIn, mfaOn, hasDevicePin})` (`components/ResumeLock.tsx:35-41`, `lib/resumeLockPolicy.ts:41-43`). app-lock has a `pin` mode (`app/app-lock.tsx:89,104-118`).
  4. ❌ **File split and `as any`.** The file is now 1132 lines and has 9 `as any` (`:282,287,301,339,404,446,482,799,804`). ZA deferred this (D1).
  5. ✅ **ErrorBoundary.** A key bump now remounts the subtree (`components/ErrorBoundary.tsx:46,55`), and the copy matches the button (`:41`).
     ✅ **UpdateGate.**
     - It has a Play Store fallback, or a "open your app store" note (`components/UpdateGate.tsx:33-39,71-75,90-94`).
     - It re-checks on AppState change, throttled to 1 h (`:61-67`).
     - The advise bar is inset (`:105`), the dead `UpdateSpinner` is removed, and the header role and hidden icon are added (`:80-81`).
     ✅ **TermsGate.** While signed out it no longer makes network calls, only a local `hasSession()` check (`components/TermsGate.tsx:65-69`). It also has a ScrollView (`:128,170`), a header role, a live error and busy state (`:133,153,160`).
  6. ✅ **Deep links over a held verdict.** A non-call route is replaced back to `/blocked` while `securityVerdict()` holds (`app/_layout.tsx:336-340`).
- **Regressions:** one new `as any` (`:339`). ZA claimed none.
- **Subscreens:**
  - Launch veil — 8 → 8.
  - ResumeLock — 7.5 → 8.5. It now covers Device-PIN users, and the policy is pure and tested. Ordering is still 📱.
  - UpdateGate — 6.5 → 8.
  - TermsGate — 7.5 → 8.5.
  - ErrorBoundary — 7 → 8.
  - UsageCounter — 8.5 → 8.5.
  - CallBar — 7 → 7. No change.
- **Still needed for 10/10:**
  1. Split the call routing, notification ingest and boot work (`app/_layout.tsx:416-900`) into hooks, and drop the 9 `as any` (cited above).
  2. Verify resume ordering on a device. `enter()` does `router.back()`, then a `push` of the held tap (`app/app-lock.tsx:49-57`). The verdict guard (`app/_layout.tsx:336-340`) runs only when `pathname` changes. Not verifiable statically.
  3. UpdateGate strings are English-only (`components/UpdateGate.tsx:81-94`), while TermsGate uses `t()`. iOS has no store URL fallback (`:34`).
  4. `useGlobalSearchParams()` re-renders the root on every param change, only to compute `launchHref` (`app/_layout.tsx:236-238`).
  5. Signed-out TermsGate still wakes every ≤30 s, forever, for a local check (`components/TermsGate.tsx:61-69`). Subscribing to sign-in would remove the timer.

#### `app/index.tsx` — **7.5 → 8.0**
- **Scores now:** Function 8.5 · States 8.5 · UI 7 · A11y 7.5 · Security 8 · Code 8.5 (mean 8.0)
- **Original items:**
  - ✅ A held tap is replayed over Chats (`app/index.tsx:60-63`). On the restore branch it is left for `resetTo` (`:48-51`).
  - ✅ The header comment is rewritten (`:1-7`).
  - ✅ A throw now shows "Try again" (`:64-69,108-117`), and a failed restore check skips the offer (`:48`).
  - ✅ The splash colour is now the `BRAND_NIGHT` constant (`:125`, `constants/theme.ts:158`).
- **Regressions:** none.
- **Subscreens:** Fallback splash — 7 → 8. It now has a retry.
- **Still needed for 10/10:**
  1. `route` has no in-flight guard. A double tap on Retry runs two replaces and two pushes (`app/index.tsx:22-23,111`).
  2. While waiting on `launchAllowed`, the fallback shows only the logo, with no progress indication (`:99-107`). This matters if the native splash has already hidden.
  3. Verify the held-tap → replace → push sequence on a device 📱.

#### `app/(tabs)/_layout.tsx` — **7.5 → 8.0** (mean 7.75, tie)
- **Scores now:** Function 8 · States 8 · UI 8 · A11y 7 · Security 8 (n/a) · Code 7.5
- **Original items:**
  - ✅ `useStyles` and `useUnreadTotal` now run once in `TabLayout` (`app/(tabs)/_layout.tsx:103,107`) and are passed to the icons (`:29,49,127-147`).
  - ❌ Labels are still capped at `maxFontSizeMultiplier={1.2}` (`:44,87`). This is a handoff (D4).
  - ❌ Gradient and shadow hex values remain (`:37,175`). This is a handoff to `constants/theme.ts`, still undone.
- **Regressions:** none.
- **Subscreens:** Mini Apps center button — 7 → 7.
- **Still needed for 10/10:**
  1. Raise the cap in `constants/layoutMath.visionTabBarGrowth` and the label `maxFontSizeMultiplier` together (`:44,87`).
  2. Move the `['#9D82F5','#6036BB']`, `['#9471ED','#5830AC']` and `#05030D` values into theme tokens (`:37,175`).

#### `app/onboard.tsx` — **7.5 → 7.5**
- **Scores now:** Function 8 · States 8 · UI 8 · A11y 8 · Security 6 · Code 8 (mean 7.67)
- **Original items:**
  1. ❌ There is still no possession factor before `/mpin-entry`: `lookupUser` returns `userId` unauthenticated (`app/onboard.tsx:49-51`, `lib/onboarding.ts:146-147`). It is blocked on the backend (ZA D2).
  2. ✅ The phone input is labelled "Mobile number, <country>" with tel autofill (`components/auth/PhoneField.tsx:92-94`). The duplicate caption is hidden (`app/onboard.tsx:82`).
  3. ✅ A synchronous `inFlight` latch is added (`:38,44-45,65`).
- **Regressions:** none.
- **Subscreens:** Country picker — 6.5 → 8. It is now the shared `Sheet`, with roles, `selected`, a scrim and the safe-area inset (`components/auth/PhoneField.tsx:100-111`, `components/ui/Sheet.tsx:65-90`). Each row label starts with the flag emoji, so a screen reader reads "flag: India…" (`PhoneField.tsx:104`).
- **Still needed for 10/10:**
  1. Add OTP or device binding before MPIN sign-in, and stop `/auth/lookup` returning `userId` unauthenticated (`lib/onboarding.ts:146-147`). This needs the backend.
  2. Keep the flag emoji out of the country row's spoken label (`components/auth/PhoneField.tsx:104`). That needs an `accessibilityLabel` field on `SheetAction`.

#### `app/email-verify.tsx` — **7.5 → 8.0** (mean 7.75, tie)
- **Scores now:** Function 8 · States 8.5 · UI 8 · A11y 8 · Security 7 · Code 7
- **Original items:**
  - ✅ An empty store now does `router.replace('/onboard')` and renders only the sky (`app/email-verify.tsx:119-123`).
  - ❌ The route is not renamed. This was a decision (ZA D5), and the header still asks for it.
  - ✅ MpinInput is labelled "Verification code" and announces "n of 6" (`:152`, `components/auth/MpinInput.tsx:61-70,92`).
- **Regressions:** none.
- **Subscreens:** "Didn't get the code?" Sheet — 8 → 8.
- **Still needed for 10/10:**
  1. Rename the route as the file header asks, together with `lib/onboardNav.selftest.ts`.
  2. Give the title a header role (`app/email-verify.tsx:140`).

#### `app/onboard-profile.tsx` — **6.5 → 8.0** (mean 7.75, tie)
- **Scores now:** Function 8 · States 7.5 · UI 8 · A11y 8 · Security 7 · Code 8
- **Original items:**
  - ✅ The DOB round-trip now uses `fromLocalIsoDate`/`toLocalIsoDate` (`app/onboard-profile.tsx:57,102`, `lib/onboardDate.ts:11-21`), tested across 4 time zones.
  - ✅ Every input is labelled (`:151,164,171,175,211`), and the DOB trigger has a role, label and hint (`:179-186`).
  - ✅ `pickFrom` now has a try/catch with an inline message (`:64-81,144`).
  - ✅ The comment is fixed (`:13-15`).
- **Regressions:** none.
- **Subscreens:**
  - Photo source Sheet — 8 → 8.5. It now has an error path.
  - DOB picker — 6 → 8.
- **Still needed for 10/10:**
  1. Say why Next is off when the first name or DOB is missing. Only the email and age-13 rules have messages (`:94-95,165,192`).
  2. `setPhotoErr` can fire after unmount (`:79`). Add an alive guard.

#### `app/onboard-security.tsx` — **7.5 → 8.0**
- **Scores now:** Function 8 · States 8 · UI 8 · A11y 8.5 · Security 7 · Code 8.5 (mean 8.0)
- **Original items:**
  - ✅ A per-row "Use at least 2 characters" live hint is added (`components/auth/SecurityQuestionRow.tsx:64-66`). It uses the shared `MIN_ANSWER` (`:16`, `app/onboard-security.tsx:36`).
  - ✅ Answers are labelled "Answer to: …" (`SecurityQuestionRow.tsx:60-61`).
  - ✅ The picker is now the shared `Sheet` with `selected` (`:68-77`).
- **Regressions:** none.
- **Subscreens:** Question picker — 6.5 → 8.
- **Still needed for 10/10:**
  1. A row with no question picked gives no reason for the disabled Next. The hint only appears once an answer is started (`SecurityQuestionRow.tsx:64`).

#### `app/onboard-mpin.tsx` — **8.0 → 8.5**
- **Scores now:** Function 9 · States 8.5 · UI 8 · A11y 8 · Security 8.5 · Code 8 (mean 8.33)
- **Original items:**
  - ✅ It uses the shared `isWeakPin` (`app/onboard-mpin.tsx:18,56`, `lib/weakPin.ts:14-21`).
  - ✅ A missing phone or phoneTicket now shows "Sign-up expired" → `resetTo('/onboard')` (`:81-89`).
  - ✅ MpinInput is labelled "New MPIN" / "Confirm new MPIN" (`:142-143`).
- **Regressions:** none.
- **Subscreens:**
  - Create step — 8 → 8.5.
  - Confirm step — 7.5 → 8.5. The mismatch copy now names the step (`:61`).
- **Still needed for 10/10:**
  1. Check on a device how TalkBack/VoiceOver handle typing into the labelled hidden input 📱 (`components/auth/MpinInput.tsx:61-92`).

#### `app/onboard-success.tsx` — **7.5 → 8.0**
- **Scores now:** Function 8 · States 8.5 · UI 8 · A11y 8 · Security 8 · Code 8 (mean 8.08)
- **Original items:**
  - ✅ A failing `enableMfa` now shows a non-blocking notice (`app/onboard-success.tsx:68-77`).
  - ✅ Import has a role, hint, state and a 44 pt target (`:155-163,201`).
  - ✅ An unmount cleanup clears `mpin` (`:47`).
- **Regressions:** none.
- **Subscreens:** "Could not continue" Alert — 7.5 → 8. MFA failures no longer land there.
- **Still needed for 10/10:**
  1. `finish` guards on `busy` state, not a ref, so two taps in one frame can run `verifyMpinRemote` twice (`:54`).
  2. The body is a plain `View` (`:113`). Whether it clips at large font scale is not verifiable statically.

#### `app/mpin-entry.tsx` — **8.0 → 8.0**
- **Scores now:** Function 9 · States 8.5 · UI 8 · A11y 8 · Security 6 · Code 9 (mean 8.08)
- **Original items:**
  - ❌ There is still no possession factor (`app/mpin-entry.tsx:48`). This is a backend handoff.
  - ✅ MpinInput is labelled (default "MPIN") and the title is a header (`:77`).
  - ✅ "Forgot MPIN?" is guarded like `submit`, with a hint and a 44 pt target (`:93-103,118`).
- **Regressions:** none. The guard sets an error and then navigates at once, so the message is effectively unseen (`:96`).
- **Still needed for 10/10:**
  1. Add OTP or device binding before `verifyMpinRemote` on a new device (`:48`). This needs the backend.

#### `app/mpin-recover.tsx` — **7.0 → 7.5**
- **Scores now:** Function 9 · States 7 · UI 8 · A11y 8 · Security 6.5 · Code 7.5 (mean 7.67)
- **Original items:**
  - ❌ Recovery is still knowledge-only (`app/mpin-recover.tsx:74`). This is a backend handoff. It is also the way past app-lock (`app/app-lock.tsx:138-141`).
  - ✅ Answers are trimmed (`:71-73`). Onboarding also saves them trimmed (`app/onboard-security.tsx:41`), so the two match.
  - ✅ It uses the shared `isWeakPin` (`:81`), with no DOB, which is not known here.
  - ✅ Answers are labelled (`:138`), MpinInput is labelled (`:175-176`), and there is a header role (`:121`).
- **Regressions:** none.
- **Subscreens:**
  - Answer phase — 7 → 8.
  - New/confirm MPIN phase — 6.5 → 7.5.
- **Still needed for 10/10:**
  1. Add an OTP step before `verifyRecoveryAnswers` (`:74`). This needs the backend.
  2. The mismatch copy is still "PINs don't match." (`:83`). Name the step, as onboard-mpin now does.
  3. The question-load failure uses `Alert` + `router.back()` (`:56-59`). Offer an inline retry instead.

#### `app/app-lock.tsx` — **7.5 → 7.5**
- **Scores now:** Function 8.5 · States 8 · UI 7 · A11y 7.5 · Security 7.5 · Code 7 (mean 7.58)
- **Original items (X1):**
  1. ✅ The sealed-PIN input is labelled "Device PIN" with a hint (`app/app-lock.tsx:190-191`). MpinInput is labelled by default.
  2. ✅ An `alive` ref guards `tryBiometric`, the mode decision and `setBusy` (`:39-40,87,97,117,163`). Offline MPIN errors are mapped (`:160-162`).
  3. ◐ Device-PIN users are now covered: there is a `pin` mode using `verifyPin` with backoff copy (`:104-118`) and "Use device PIN" / "Use MPIN instead" (`:205-210,225-229,242-246`). Replay of held taps is still 📱 (`:49-57`).
- **Regressions:** none.
- **Subscreens:**
  - Sealed PIN — 7 → 8.
  - Device-PIN mode (new) — 8.
  - Biometric — 7 → 7.5.
  - MPIN mode — 8 → 8.5.
  - Forgotten PIN Alert — 7 → 7. In `pin` mode it offers only the destructive sign-in, although MPIN can unlock (`:123-134`).
- **Still needed for 10/10:**
  1. Give the title a header role (`:173`). Give the 14 pt alt links (`:208,212,222,226,239,243,247`) 44 pt targets or `hitSlop`.
  2. In `pin` mode, mention "Use MPIN instead" in the Forgotten PIN Alert before the destructive option (`:123-134`).
  3. `submitSeal` and `submitMpin` call `setError` without the alive check (`:112-116,160`).
  4. Recovery from the lock is knowledge-only until an OTP lands (`:138-141`).

#### `app/restore-backup.tsx` — **7.0 → 8.0**
- **Scores now:** Function 9 · States 8.5 · UI 7.5 · A11y 8 · Security 7 · Code 8 (mean 8.0)
- **Original items:**
  - ✅ Roles and `disabled`/`busy` state are on all buttons (`app/restore-backup.tsx:119,153,165-166,178-179,197-198`).
  - ✅ `unavailable` now shows "Couldn't check" with Try again (`:64-72,137-138,152-156`, `lib/cloudBackup.ts:386`).
  - ✅ Restore errors are mapped (`:95-101`).
  - ✅ `S` is typed (`:214`).
  - n/a `markRestorePromptSeen` never rejects (`lib/restoreGate.ts:28-30`). The ZA "not reproduced" note is confirmed.
- **Regressions:** none.
- **Subscreens:** "Chats restored" — 6.5 → 8.
- **Still needed for 10/10:**
  1. Skipping after a FAILED lookup still marks the prompt seen (`:76-77,192-194`), so a user who was offline is never offered the restore again. Mark it only when `meta` is a real answer.
  2. `run` has no unmount guard (`:83-105`).

#### `app/delete-account.tsx` — **8.0 → 8.0** (Security down)
- **Scores now:** Function 9 · States 8.5 · UI 8 · A11y 8.5 · Security 5 · Code 8.5 (mean 7.92)
- **Original items:**
  - ◐ The server MPIN contract is implemented on the client: `deleteAccount(mpin, reason?)` (`lib/chatService.ts:2004-2006`, `app/delete-account.tsx:108`). The server check is written (`vaultchat-backend-go/internal/routes/user.go:1694-1719`) but **not deployed**.
  - ✅ No more stripped cached profile: the `verifyMpinRemote` pre-check is gone.
  - ✅ The delete failure is mapped inline (`:121-139`), with no raw `e.message`.
- **Regressions (round 3, high):**
  - The client pre-check (`verifyMpinRemote`) was removed. The deployed server at `b8c8bd2` reads only `reason` and ignores `mpin` (`git show b8c8bd2:…/routes/user.go:1692-1695`).
  - **Against today's server, any 6 digits now delete the account.** The screen still promises "It proves this is you before anything is erased" (`app/delete-account.tsx:233`).
  - ZA logged the deploy ordering as a handoff, but the client shipped first.
- **Subscreens:** Final "Delete account?" Alert — 7 → 7.
- **Still needed for 10/10:**
  1. Deploy the MPIN-checking server before or with this client. Otherwise restore a client-side check until it is live (`app/delete-account.tsx:104-108`).
  2. The mapping treats any 403 as a wrong MPIN and any 400 as a missing MPIN (`:124,135`). Key on `e.body.error.code` only.

#### `app/blocked.tsx` — **7.5 → 8.0**
- **Scores now:** Function 8 · States 7 · UI 8 · A11y 7.5 · Security 9 · Code 7.5 (mean 7.83)
- **Original items (X1):**
  - ✅ Non-call navigation is refused while a verdict is held, including links that expo-router opens itself (`app/_layout.tsx:336-340`). Call routes stay exempt by design.
  - ✅ The rgba values now use `tint(c.danger|c.success, a)` (`app/blocked.tsx:322,358,429`). The `#FFFFFF` on the danger bar is commented (`:309-310`), and the bar has a header role (`:196`).
- **Regressions:** none.
- **Subscreens:**
  - Contact Support Alert — 7.5 → 7.5.
  - "Nothing is blocked" — 8.5 → 8.5.
- **Still needed for 10/10:**
  1. A `restrict` verdict has no in-app "Check again". The copy tells the user to clear the indicator and reopen the app (`:153-157,238-240`). Add a re-scan that clears the verdict.
  2. Raw threat detail is shown to everyone (`:228-230`). Consider putting it behind a disclosure.

#### `app/permissions.tsx` — **6.5 → 8.0**
- **Scores now:** Function 8.5 · States 7.5 · UI 7.5 · A11y 8 · Security 8 · Code 7.5 (mean 7.83)
- **Original items:**
  1. ✅ Each row now makes its own request with its reason (`app/permissions.tsx:111-115,156-166`). A `canAskAgain === false` refusal leads to `permissionDenied` (`:105-107`). "Allow all missing" skips background location (`:117-129`).
  2. ✅ Each row has a label and `checked`/`busy`/`disabled` state (`:162-165`). The FSI row is labelled (`:188-190`), there is a Back control (`:137-145`), and the title has a header role (`:148`).
  3. ✅ The dead onboarding branches are gone. `done()` goes back to Settings, which now passes `?from=settings` (`:57-58`, `app/settings.tsx:399`).
  4. ✅ Colours are now `tint()`, `c.primary` and `c.success`. The amber FSI row is fixed and commented (`:240-246`).
  5. ❌ The stale `screenBackCoverage` exemption remains (`lib/screenBackCoverage.selftest.ts:48-49`). This is a handoff, not done.
- **Regressions:** none.
- **Subscreens:** Full-screen-intent row — 6.5 → 8.
- **Still needed for 10/10:**
  1. `readGranted` uses one try around six getters, so an early throw leaves the later rows "not allowed" (`:75-83`). It also has no unmount guard (`:84`).
  2. Drop the stale ALLOWED entry (`lib/screenBackCoverage.selftest.ts:48-49`).
  3. Add a warning token for the amber row (`:244-246`).

#### `app/backup-pin.tsx` — **7.0 → 8.0**
- **Scores now:** Function 8 · States 8 · UI 7.5 · A11y 8 · Security 7.5 · Code 8 (mean 7.83)
- **Original items:**
  1. ✅ `checkCurrent` has a catch with "Couldn't check your PIN" (`app/backup-pin.tsx:65-67`). The Haptics call is gone along with the bespoke keypad.
  2. ✅ It reuses `components/PinPad` (`:134-153`), with a labelled submit and Delete (`components/PinPad.tsx:70-84`), and the shared `isWeakPin` (`:87`).
  3. ◐ "Forgotten your current PIN?" explains that the PIN can't be reset (`:78-82,155-158`). The way out it describes, "lock the app", has no direct action. It is only reachable through the relock timeout or a cold start.
  4. ✅ `tint(AUTH.accent)` replaces the literals (`:174`), and the emoji is hidden (`:126`).
- **Regressions:** none.
- **Subscreens:**
  - Current PIN stage — 7 → 8.
  - Set PIN — 7 → 8.
  - Confirm PIN — 7 → 8.
- **Still needed for 10/10:**
  1. Give the forgotten-PIN path a real action, such as "Lock now", which opens `/app-lock` so its sign-in-again path is reachable (`:78-82`).
  2. PinPad draws with the app palette over an AuthSky screen (`components/PinPad.tsx:33`, `app/backup-pin.tsx:119`). Whether the two match is not verifiable statically.

---

**Product change to note (not a regression):** the resume relock now applies to every Device-PIN holder, using the default 5-minute Auto Screen Lock (ZA "Decisions"). That includes users who set a PIN only for the Vault (`components/ResumeLock.tsx:35-41`).

---

### B — Main tabs, contacts & links — re-rating (round 3)

This is a static, read-only review from `b8c8bd2` to HEAD (`c28d1b2`), using the same rubric (`RUBRIC.md`) and format (`RERATE.md`).
- **Baselines.** The "Old" scores are the ones given in the task. The open items come from:
  - `rerate2/X1.md` for alerts, calls and i/[token].
  - `rerate/B.md` for the other 12 screens.
  - The original section in `2026-10-04_screen_ratings.md:792-803` for mini.tsx.
- **What I read.** Every screen in full at HEAD, plus its `git diff b8c8bd2 HEAD`, plus these helpers: `components/status/GatePicker.tsx`, `lib/tintColor.ts`, `lib/dialCodeOf.ts`, `lib/searchSnippet.ts`, `lib/vaultIdLink.ts`, `components/ui/Sheet.tsx` (diff), `lib/chatService.ts` (`previewInvite` at 2202-2208), `lib/localCache.ts:52-72`, `app/media-gallery.tsx:130-136`, the `app/(tabs)/_layout.tsx` diff, and `app.json:51-76`.
- **Fix claims.** I checked every claim in `fixes/ZB.md` against the code, plus the lead's join preview (commit `b4ccd9c`). The backend `GET /chats/join/:code/preview` (`fixes/ZBE.md` row 5) is written but **not deployed**. So the join preview counts only for how it degrades against today's server.

**Evidence I ran.** Nothing was device-tested or deployed.
- `npx tsc --noEmit -p .` exited 0 with no output, so the 4 errors noted in ZB.md are gone.
- `npx eslint` on all 16 screens plus `GatePicker.tsx` and `media-gallery.tsx` gave 0 errors and 0 warnings. In round 2 these screens had 24 warnings.
- These `npx tsx` selftests all exited 0:
  - a11yCoverage (0 unlabelled, budget 0)
  - themeCoverage (22 passed, 20 exemptions)
  - screenBackCoverage
  - responsiveCoverage
  - orphanRoutes (51)
  - silentFailure (all checks pass; the ZB handoff for checks 8 and 10 landed, `lib/silentFailure.selftest.ts:91-98`)
  - vaultIdLink
  - callHistory
  - tintColor
  - dialCodeOf
  - searchSnippet
  - keyboardAvoidance
  - rowOverflow
  - pendingLink
  - `lib/status/gateWiring`
  - uiDebtRatchet ("no file got worse")

**ZB handoffs that landed:**
- Sheet rows are keyed by label (`components/ui/Sheet.tsx:75-79`).
- media-gallery reads `tab` (`app/media-gallery.tsx:130-136`).
- The silentFailure regexes were updated.

**ZB handoffs not landed:**
- `vc_miniapp_todos` is still absent from the sign-out purge (grep finds it only in `mini.tsx:62` and `lib/retiredKeys.ts:46`).
- Verified App Links are still off. `app.json:66` has `autoVerify: false` for `/add/` and `/join/`, and there is no `associatedDomains`.

**Rounding.** Each overall score is the mean of the six dimensions, rounded to the nearest 0.5.

| Screen | Old | New | Δ |
|---|---|---|---|
| `app/(tabs)/chats.tsx` | 7.5 | 8 | +0.5 |
| `app/(tabs)/status.tsx` | 6.5 | 8 | +1.5 |
| `app/(tabs)/calls.tsx` | 7.5 | 8.5 | +1 |
| `app/(tabs)/mini.tsx` | 8.0 | 8.5 | +0.5 |
| `app/(tabs)/profile.tsx` | 7.0 | 8 | +1 |
| `app/(tabs)/alerts.tsx` | 7.5 | 8.5 | +1 |
| `app/new-chat.tsx` | 7.5 | 8 | +0.5 |
| `app/search.tsx` | 8.0 | 8.5 | +0.5 |
| `app/contacts.tsx` | 7.0 | 8 | +1 |
| `app/contact-info.tsx` | 7.0 | 8 | +1 |
| `app/qr-contact.tsx` | 7.0 | 8 | +1 |
| `app/verify-contact.tsx` | 8.0 | 8.5 | +0.5 |
| `app/add/[...segments].tsx` | 8.0 | 8.5 | +0.5 |
| `app/join/[code].tsx` | 8.0 | 8.5 | +0.5 |
| `app/i/[token].tsx` | 7.0 | 7.5 | +0.5 |
| `app/invite-link.tsx` | 7.5 | 8 | +0.5 |

**Cross-cutting (not scored).** The `https://vaultchat.app/add|join` links are still unverified (`app.json:66-76`, `autoVerify: false`, and no iOS `associatedDomains`). Whether tapping one opens the app is **not verifiable statically**. This caps Security and Function for qr-contact, add, join and invite-link.

---

#### `app/(tabs)/chats.tsx` — **7.5 → 8**
- **Scores now:** Function 8.5 · States 8.5 · UI 7.5 · A11y 8.5 · Security 8 · Code 6.5 (mean 7.92)
- **Original items (rerate/B):**
  1. ✅ Dead styles are removed: `headerBtnTxt`, `avatar*`, `presenceDot`, `rowPin`, `rowMuted`, `actionIcon`, `fabTxt` (diff, makeStyles 1072-1163). The comment now reads "Temporary-chat sheet" (1146). `avatarLetter` is gone (eslint 0 warnings).
  2. ◐ Colours:
     - The read tick uses `colors.accentOn` (1029). The error bar uses `tint(c.danger)` (1098).
     - The scrims and name bar stay `rgba(0,0,0,…)`, documented (1076-1079, 1085, 1147).
     - RN `Text` is kept on purpose (comment 12-14): the styles already multiply by `v.textScale` (for example 1074). This is not reproduced as a fault.
     - Remaining hex: 10 `#fff`/`#FFFFFF` on accent or danger fills (766, 923, 926, 938, 974, 1084, 1086, 1104, 1156, 1160).
  3. ✅ The Archive swipe uses `colors.text` on `surfaceSolid` (932-935). Actual contrast is **not verifiable statically**.
  4. ✅ Avatar popup:
     - A 60 s story-user cache and an in-flight guard (421-442).
     - Roles and labels on Message, Audio, Video and Info (825-839).
     - `accessibilityViewIsModal` on both sheets (787, 815). The backdrops are labelled (786, 806).
     - Still no visible pending state on the first tap while `listStoriesFeed()` runs (430).
  5. ✅ `Promise.allSettled` in bulk run and bulk delete (506-507, 532-533). Failures are still counted and reported after `await fetchList()` (509-510). Folder counts are memoised (568-577).
  6. ❌ There are still 19 `as any` (grep count). The deferral is documented in ZB.md "Partially fixed" row 4. `formatRelative` stays local; ZB argues this is intentional (different format from status), and I accept that.
- **Regressions:** none found.
  - The header bulk buttons are 40dp + `hitSlop={4}` (1075, 624-628), which meets 44 in effect.
  - Selecting through the avatar in select mode is labelled "Select <title>" and does toggle (747, 962).
- **Subscreens:**
  - Temporary-chat sheet — 7.5 → 8. It is now modal for screen readers (787), and items are 44dp (1152).
  - Avatar photo popup — 7 → 8.
  - Selection / bulk mode — 7.5 → 8.5.
  - Folder chips — 8 → 8.5.
  - Swipe actions — 7.5 → 8. The Archive ink is fixed; contrast still needs a device check.
- **Still needed for 10/10:**
  1. Remove the 19 `as any` route casts once `.expo/types` is generated (e.g. 600, 673, 829-839).
  2. `ChatRow` is `memo` (around 870), but `renderItem` passes eight fresh inline closures per render (746-752). Pass stable `useCallback` handlers keyed by id, or the memo is defeated on every list update.
  3. Show a pressed or loading state on the first avatar tap while the story feed loads (430).
  4. Move the remaining `#fff` inks onto an "on-accent" token (1104, 1156, 1160, 923-938).
  5. The file is 1,163 lines. Split `ChatRow` and the two Modals into `components/` (the chat.tsx split is the pattern).

#### `app/(tabs)/status.tsx` — **6.5 → 8**
- **Scores now:** Function 7.5 · States 8.5 · UI 7.5 · A11y 8 · Security 8.5 · Code 7 (mean 7.83)
- **Original items (rerate/B):**
  1. ✅ Accessibility:
     - Rows have a composed label and a mute accessibility action (384-390). My-status has a label and hint (577-579).
     - Swatches are `radio` with colour names and checked state (439-441). Emoji are "Insert 😀" (468, 478). Thumbnails read "Photo i of n" with selected state (519-520).
     - The header buttons have role and state (416-424). The inputs are labelled (456, 547).
  2. ✅ `closeTextComposer` and `closePreview` confirm before discarding (235-253). Both are wired to Android back through `onRequestClose` (429, 495).
  3. ✅ Dead styles removed. ◐ The font-scaling item is not reproduced: `AppText` (21) already applies the comfort scale, and the TextInputs use `m.textScale` (649, 668).
  4. ✅ GatePicker:
     - Radio roles and checked state (`GatePicker.tsx:61-63`, `105-107`), with radiogroups (82, 97).
     - The answer field has `secureTextEntry`, `autoCorrect={false}`, `autoComplete="off"` and `spellCheck={false}` (144-147).
     - `Opt` is hoisted (47). The error ink is `AuroraDark.danger` (42).
  5. ✅ The TODO is resolved in a comment (570-572). The icon goes straight to `/status-privacy` (416). The imports are at the top (20-60).
  6. ✅ Mutes are documented as device-local (75-77), and the dialog says "on this device" (124).
- **Regressions:**
  1. **GatePicker answer is now hidden with no reveal toggle** (`GatePicker.tsx:144`). The copy says the answer "can't recover this later, and neither can we" (155-157), and there is no confirm field. A typo the poster cannot see locks out every viewer for good. The poster still sees their own story through the local key (status.tsx:303-307). Add a show/hide toggle.
  2. Minor: `GatePicker.makeS(c)` takes the palette but never reads it (`GatePicker.tsx:76-77`, `170-183`). That is a dead `useColors()` subscription.
- **Subscreens:**
  - Text status composer — 6.5 → 8.
  - Media preview + caption editor — 7.5 → 8. Whether the video frame renders (`Image` on a video URI, 509-511) is **not verifiable statically**.
  - GatePicker — 7 → 8. The reveal toggle above is the open item.
  - Emoji panel — 6 → 8.
  - Status options menu — 6 → n/a. It was removed and replaced by a direct route (416).
  - StoryRing — 8 → 8 (unchanged).
- **Still needed for 10/10:**
  1. Add a show/hide toggle (or a confirm field) for the question answer (`GatePicker.tsx:134-149`).
  2. Video preview: render a poster frame (e.g. `expo-video-thumbnails`) instead of `Image` on a video URI (509-511). Needs a device check.
  3. `onRefresh` and `load` set state with no unmount guard (132-141, 158-162). `cancel` covers only the focus effect (146-155).
  4. GatePicker still uses RN `Text` at fixed sizes (`GatePicker.tsx:17`, `174-182`), so it does not follow the comfort scale the rest of the screen gets from AppText.
  5. Hoist `statusRow` into a memoised component (379-402). The file is 688 lines; split out the two composer Modals (429-555).

#### `app/(tabs)/calls.tsx` — **7.5 → 8.5**
- **Scores now:** Function 9 · States 9 · UI 8 · A11y 9 · Security 8 · Code 8.5 (mean 8.58)
- **Original items (X1):**
  1. ✅ A failed merge sets `syncFailed` (130), which shows a tappable notice with retry through `syncTry` (286-291, 94-95, 134).
  2. ✅ The backdrop is a sibling `Pressable` (320), and the sheet is a `View` with `accessibilityViewIsModal` (321). There is an X Close button (328-330).
  3. ✅ `DirArrow` is hoisted (57-68). `renderItem` is a `useCallback` (234-272). Sheet rows are keyed by label (`components/ui/Sheet.tsx:79`).
  4. ✅ Partial-remove copy: local, then server. If only the hide fails, the local rows drop and "Partly removed" explains (171-188). Clear uses `allSettled` and drops exactly the half that was written (217-229). callHistory selftest passes.
- **Regressions:** none found.
- **Subscreens:**
  - Call actions sheet — 8 → 8.5.
  - Call info modal — 8 → 9.
  - Remove/Clear confirmations — 9 → 9.
- **Still needed for 10/10:**
  1. The inner `getCallLog().then(...).catch(() => {})` in the merge (126-128) is still silent. A local-read failure there leaves the unmerged list with no notice.
  2. Three `as any` route casts (156, 162, 311). The FAB icon is `#fff` (312).
  3. The `eslint-disable` for `syncTry` (132-134) could go if `syncTry` is read inside the callback.

#### `app/(tabs)/mini.tsx` — **8.0 → 8.5**
- **Scores now:** Function 8.5 · States 8 · UI 8.5 · A11y 9 · Security 8.5 · Code 8.5 (mean 8.5)
- **Original items (ratings.md:802-805):**
  1. ✅ The "Coming Soon" branches and the Soon badge are removed (87-88). The `Alert` import and the `comingSoon` style are gone.
  2. ✅ The back button is 44×44 (174-176) with role and label (99).
  3. ✅ `Stack.Screen` is removed (diff). The title has a header role (105).
  4. ◐ `vc_miniapp_todos`: a decision is recorded (62-68), but the comment itself says removal "belongs in purgeAccountData()", and that has not happened (grep finds it only in `mini.tsx:62` and `lib/retiredKeys.ts:46`). It is sealed with the cache DEK, so it is unreadable after sign-out per the comment; I did not verify that.
- **Regressions:** none.
- **Subscreens:** none.
- **Still needed for 10/10:**
  1. Back is a bare `router.back()` (99). On a deep link straight to the Mini tab there is no history, and the tab bar is hidden here (`_layout.tsx` `display:'none'`). Use profile's fallback, `canGoBack() ? back() : replace('/(tabs)/chats')` (`profile.tsx:310`).
  2. Add `vc_miniapp_todos` to the sign-out purge, or state in the purge list why it is exempt (62-68).
  3. `makeStyles` takes `m` (148) but never reads it. The tile and back sizes are fixed (174-176, 212). Either scale them by `m.controlScale` or drop the parameter.
  4. One `as any` on the tile route (88). The stale "PDF page 12" comments (35-38, 111, 204) describe a 3×3 grid that is now 10 tiles.

#### `app/(tabs)/profile.tsx` — **7.0 → 8**
- **Scores now:** Function 8.5 · States 8 · UI 7.5 · A11y 8.5 · Security 8 · Code 7 (mean 7.92)
- **Original items (rerate/B):**
  1. ✅ Content is wrapped in `KeyboardSafe keyboardOnly` with `keyboardShouldPersistTaps` (299-300). The real keyboard behaviour is **not verifiable statically**.
  2. ✅ `logoutUser()` is try/caught with an alert, and there is no navigation on failure (256-261).
  3. ✅ Each editing row has a Cancel X (534-539). `cancelEdit` restores the value, and for the phone row it also resets the OTP step (281-286). A failed save keeps the editor open (122-145). "Resend code" has a 30 s countdown (207-213, 451-456).
  4. ✅ Roles on back, settings, verify, Verify/Cancel, the action rows and copy/QR (309-321, 426-427, 442-447, 473, 478, 372, 375). The OTP input has `oneTimeCode`/`sms-otp` (439). The version footer has an accessibility action (488-490).
  5. ✅ The empty effect is gone. The header line is rewritten (1-4). `KeyboardTypeOptions` is used (11, 510).
- **Regressions:** minor. On sign-out, `unregisterPushToken()` and `disconnectSocket()` run before `logoutUser()` (254-257). If logout now fails and the screen stays signed in, push and the socket have already been torn down. Whether they reconnect on their own is **not verifiable statically**.
- **Subscreens:**
  - Inline edit rows — 7 → 8.5.
  - Phone OTP step — 7 → 8.5.
  - Sign-out confirmation — 8 → 8. See the regression above.
- **Still needed for 10/10:**
  1. Run the push and socket teardown only after `logoutUser()` succeeds, or restore them on failure (254-261).
  2. A profile load failure with no cache shows only an Alert (110), then an empty profile with no retry. Add an inline error with Retry, or pull-to-refresh.
  3. Switching rows (`onEdit` on another row, 385/391/397) leaves the previous row's unsaved text in place, showing as if saved. Revert it, as `cancelEdit` does.
  4. "Verify this number via SMS" shows even when `phone` equals the account's already-verified number (425). Hide it in that case.
  5. Move the inline styles (358-376, 495) into `makeStyles`. Tokenise `#fff` on primary (570, 603). Six `as any`.

#### `app/(tabs)/alerts.tsx` — **7.5 → 8.5**
- **Scores now:** Function 9 · States 9 · UI 8 · A11y 9 · Security 8 · Code 8 (mean 8.5)
- **Original items (X1):**
  1. ✅ There is real `refreshing` state (86, 122-126, 273). A tappable retry banner appears when `error && events.length` (251-262).
  2. ✅ An `alive` ref is checked in `load()` and in the background sync (87-89, 100, 104-106, 113).
  3. ✅ Rows have `role=button`, a composed label, a hint and `accessibilityState.expanded` (177-180).
  4. ✅ `sevColor()` uses palette danger/success plus light/dark ink (30-42). The banner uses `tint(c.danger)` (313), and the icon disc uses `tint()` (182).
  5. ✅ `router.replace('/blocked')` with no params (139-140).
- **Regressions:** none.
- **Subscreens:**
  - Expanded event details — 6 → 8.5.
  - Scan confirmation — 8 → 8.
- **Still needed for 10/10:**
  1. `SEV_INK` is still a screen-local hex table (33-37). Move it into the palette, where themeCoverage can see it. The scan button ink is `#fff` (230-231, 309).
  2. A background `syncAuditChain` failure is swallowed (116). A one-line "backup sync failed" in the banner would make it visible.
  3. `catch (e: any)` (103, 149) and `'/blocked' as any` (140).

#### `app/new-chat.tsx` — **7.5 → 8**
- **Scores now:** Function 8 · States 8.5 · UI 8 · A11y 8.5 · Security 8 · Code 8 (mean 8.17)
- **Original items (rerate/B):**
  1. ✅ The dial code comes from `dialCodeOf(u?.phone)` (93-102; `lib/dialCodeOf.ts:10-16`). A code the user already picked is never overwritten (`dialTouched`, 95, 213). The selftest passes.
  2. ✅ `ActionRow` is hoisted (27-38), and "New contact" has `expanded` state (209).
  3. ✅ Back is 44dp (260). The retry passes a mounted guard (134-135, 225). Clear-search has role and hitSlop (194).
  4. ❌ Phone-number search (optional). Not done: the summary carries no peer phone (ZB.md deferred row 6).
- **Regressions:** none.
- **Subscreens:** New contact by phone — 7.5 → 8.5.
- **Still needed for 10/10:**
  1. Optional phone-number search once `ChatSummary` carries a peer phone (142-145).
  2. In the offline branch, `setListError(true)` runs before the `isCancelled()` check (113-119). Move it after.
  3. Four `as any` (78, 207-208, 222). `#fff` on primary (34, 216, 277).

#### `app/search.tsx` — **8.0 → 8.5**
- **Scores now:** Function 8.5 · States 8.5 · UI 8.5 · A11y 8.5 · Security 9 · Code 8.5 (mean 8.58)
- **Original items (rerate/B):**
  1. ✅ Offline chat names and a failed message search each show a notice (43-46, 57-61, 78, 127-134). The empty title adapts (140-141).
  2. ✅ `searchSnippet` trims the lead-in and the match renders bold (168, 176-178, 201). The selftest passes.
  3. ✅ `Section` is a discriminated union (31-33), with a typed `SectionList` and keyExtractor (144-148).
- **Regressions:** minor. The snippet is computed against the live `query` (168), but the hits come from the query of 220 ms earlier (75-79). While typing, a hit can render unhighlighted (`searchSnippet` falls back to everything in `before`, `lib/searchSnippet.ts:14`). Cosmetic only.
- **Subscreens:** none.
- **Still needed for 10/10:**
  1. Store the query with the hits and highlight against that (76-77, 168).
  2. The message-search failure notice says "Try again" but offers no retry control (131). Make it tappable.
  3. `debounce` is `useRef<any>` (48).

#### `app/contacts.tsx` — **7.0 → 8**
- **Scores now:** Function 8.5 · States 8 · UI 8.5 · A11y 8.5 · Security 7.5 · Code 8 (mean 8.17)
- **Original items (rerate/B):**
  1. ✅ The last complete scan is cached for 24 h with `writeSealedCache` (76-78, 203-208). It is read only while the permission is still granted (220-236). Refresh rescans (335). A "Checked <time>" line shows (341-345). `writeSealedCache` stores sealed data or nothing (`lib/localCache.ts:52-58`). Real-device timing is **not verifiable statically**.
  2. ◐ The header now documents the server HMAC pepper and the daily quota (14-21). The wire value is still unsalted SHA-256 (141); the pepper is server-side and not verifiable from this repo's client.
  3. ✅ `avatarInviteTxt: c.text` (421-422) and `tint(c.danger)` (411).
  4. ✅ A `SectionList` with a typed union (80-82, 376-390). Back and refresh are 44dp (400, 402). Refresh shows a spinner with busy state (335-338). The decorative 📇 is hidden (360).
- **Regressions:** none.
- **Subscreens:**
  - Scanning progress — 8 → 8.
  - Permission-denied state — 7.5 → 8.
  - Call-mode Voice/Video picker — 7 → 7 (unchanged Alert, 259-265).
- **Still needed for 10/10:**
  1. Move to a keyed or OPRF lookup so the wire value is not an unsalted hash of a small space (141). Until then, the pepper must be confirmed deployed.
  2. `scan()` sets state with no unmount guard (111-215), and it can run for minutes on a large address book.
  3. The error bar is not tappable (369-373), and its copy says "Tap refresh". Make the bar itself the retry.
  4. Two `as any` (248, 250).

#### `app/contact-info.tsx` — **7.0 → 8**
- **Scores now:** Function 8.5 · States 8 · UI 8 · A11y 8.5 · Security 8.5 · Code 7.5 (mean 8.17)
- **Original items (rerate/B):**
  1. ✅ File rows open `/media-gallery` with `tab: 'files'`, with role, label and chevron (340-348). The handoff landed (`app/media-gallery.tsx:130-136`).
  2. ✅ Roles:
     - `ActionButton` is hoisted with role and label (69-84).
     - Back (261), See All with hitSlop (321-322), group rows (381-383).
     - The encryption card has role and disabled state (394-400). The Ghost card is labelled, with 👻 hidden (417-424).
     - The danger buttons have roles (434, 439). The name is a header (274).
  3. ✅ Report first: on failure, "Report not sent" and nothing changes (236-241). Then block: on failure, "Reported, but not blocked" (242-249).
  4. ✅ Dead styles, `Dimensions` and `initials` are removed. `tint()` is used throughout (471-480). `classify` is hoisted (55-67). The effect falls back to the cached snapshot, so its deps are complete (152-157, 191).
  5. ✅ When there is no cache, a load failure shows a `loadFailed` row with retry (114-115, 185, 308-314).
- **Regressions:** none.
- **Subscreens:** Block / Unblock / Report dialogs — 7 → 8.5.
- **Still needed for 10/10:**
  1. When a cached snapshot was painted, a failed refresh is silent (183-185). The user sees stale media and links with no "offline" cue. `getCommonGroups` failures are also silent (119).
  2. File rows land on the gallery's Files tab, not the file itself (342). Pass the message id so the file opens directly.
  3. Nine `as any` (for example 157, 280-282, 321, 342, 382, 398, 420). `Promise<any>[]` (146). Inline styles (292-293, 424).
  4. The Switch thumb is `#fff` (295).

#### `app/qr-contact.tsx` — **7.0 → 8**
- **Scores now:** Function 7.5 · States 8 · UI 7.5 · A11y 8 · Security 8 · Code 8.5 (mean 7.92)
- **Original items (rerate/B):**
  1. ✅ A `getMyProfile` failure shows an error state with Try again (34-36, 41-56, 131-138).
  2. ❌ Verified App Links and iOS Associated Domains: still `autoVerify: false` (`app.json:66`), and no `associatedDomains`. The shared link is `https://vaultchat.app/add/…` (64).
  3. ✅ `AppText` (18). Back is 44dp (200) and the tabs are 44dp (203). Cancel uses `style: 'cancel'` (82). The title is a header (112).
- **Regressions:** none.
- **Subscreens:**
  - My QR tab — 7 → 8.
  - Scan tab — 7.5 → 7.5.
  - "Contact found" confirmation — 7 → 7. It is still an `Alert` (81-95), while `/add` uses an in-screen confirm.
- **Still needed for 10/10:**
  1. Verified links plus iOS domains (`app.json:62-77`), which need hosted `assetlinks.json` and AASA.
  2. The tab container has no `accessibilityRole="tablist"` (116).
  3. A network error from `resolveVaultId` is titled "Not found" (96-98). Distinguish a 404 from offline, as `add/[...segments].tsx:67-69` does.
  4. Tab text `#FFFFFF` (206).

#### `app/verify-contact.tsx` — **8.0 → 8.5**
- **Scores now:** Function 8.5 · States 8.5 · UI 8 · A11y 8.5 · Security 8 · Code 9 (mean 8.42)
- **Original items (rerate/B):**
  1. ◐ Copy uses `copyAndAutoClear` with a toast or alert (86-95, 131-134), and the explanation mentions it (137-142). There is no QR-scan comparison.
  2. ✅ `AppText` (21).
  3. ✅ `retryable: false` for "Missing account or contact" (26, 51, 117).
- **Regressions:** none. The copy says to paste into "a chat you already trust" (139). Pasting into the very chat being verified proves nothing; the wording could say "a different channel".
- **Subscreens:** none.
- **Still needed for 10/10:**
  1. QR-scan comparison of the safety number (127-135).
  2. Change "a chat you already trust" to "a different app or channel" (139).
  3. `load()` has no unmount guard (46-67). `#fff` on primary (154-162).

#### `app/add/[...segments].tsx` — **8.0 → 8.5**
- **Scores now:** Function 8 · States 8.5 · UI 8 · A11y 8.5 · Security 8.5 · Code 8.5 (mean 8.33)
- **Original items (rerate/B):**
  1. ✅ `isVaultId()` runs before any request (20, 54-56; `lib/vaultIdLink.ts:12-15`). The selftest passes.
  2. ❌ Verified https entry: unchanged (`app.json:66-72`).
  3. ✅ 🔗 is hidden (98). The resolving text is a polite live region (132).
- **Regressions:** none.
- **Subscreens:** none.
- **Still needed for 10/10:**
  1. Verified App Links and iOS domains (`app.json:62-77`).
  2. Cancel during resolving navigates away (133), but `resolve()` keeps setting state afterwards (52-71). Add an alive ref.
  3. The resolving label shows the link's own name hint (50, 132), which anyone can craft. Show only `@vaultId` until the server name arrives.

#### `app/join/[code].tsx` — **8.0 → 8.5**
- **Scores now:** Function 8.5 · States 8.5 · UI 8 · A11y 8.5 · Security 8 · Code 9 (mean 8.42)
- **Original items (rerate/B):**
  1. ◐ Group name before joining (lead-wired):
     - `previewInvite()` calls `GET /chats/join/:code/preview` (`lib/chatService.ts:2202-2208`). The confirm reads "Join <name>?" with the member count and an approval note (40, 65-76, 88-96).
     - A 410 turns into a non-retryable error (73). Any other failure, including today's undeployed server, keeps the generic confirm (72).
     - `api()` attaches `err.status` (`lib/api.ts:613`).
     - The backend is **not deployed**, so today the user still consents without the name. Function counts only the graceful fallback.
  2. ✅ The "joining" phase has an exit: Cancel with `cancelledRef`, also set on unmount (41-44, 53, 59, 115-118), and an honest hint (116).
  3. ✅ No Try again for a missing code (48, 67, 138). Every phase title has a header role (88, 113, 125, 136). The ghost buttons are 44dp (168).
  4. ❌ Verified links plus iOS domains are unchanged (`app.json:66-77`).
- **Regressions:** none. The header comment is updated (10-14).
- **Subscreens:**
  - Join confirmation — 7 → 8.5. It degrades to the generic copy until the backend ships.
  - Joining — n/a → 8.
  - Pending-approval — 8 → 8.
  - Error with retry — 8 → 8.5.
- **Still needed for 10/10:**
  1. Deploy the preview endpoint, then confirm on a device that the name shows (65-76).
  2. Join is tappable before the preview settles (101). A user can consent to "this group" a moment before the name would have appeared. Show a small loading line, or hold the CTA briefly.
  3. A 410 from POST `/chats/join` (an expired or revoked code) still gets `retry: true` (60). Match the preview's 410 handling.
  4. Verified links plus iOS domains.

#### `app/i/[token].tsx` — **7.0 → 7.5**
- **Scores now:** Function 5 · States 7.5 · UI 8 · A11y 8 · Security 7.5 · Code 8.5 (mean 7.42)
- **Original items (X1):**
  1. ◐ Retire or produce. There is a documented decision to keep the route (3-7): the server still redeems, and links already in people's messages keep working. Still, nothing in the app produces tokens (`grep redeemInvitation` finds only `lib/chatService.ts:2443`). Function rises from 4 to 5 because the legacy-only status is now stated honestly.
  2. ✅ The header no longer claims `https://vaultchat.app/i/`. It says the route is scheme-only and the https form opens in the browser (3-7).
  3. ✅ `makeStyles(colors)` plus `tint()` (34, 123-135). Links are 44dp (132).
- **Regressions:** none.
- **Subscreens:** Error state with retry — 7 → 7. It still offers Try again for a missing token (45, 65, 110) and for an expired invitation.
- **Still needed for 10/10:**
  1. Set a retirement date for the route, or add a producer (header 3-7).
  2. Hide Try again when the token is missing or the server says it is expired (45, 65, 110-113). join/[code] already does this (`app/join/[code].tsx:138`).
  3. The confirm shows no group name (79-82). A token-bound preview would match join.
  4. It is the only link screen without `AuroraBackground` (71 vs `join/[code].tsx:82`). The button ink is `#fff` (111, 131).

#### `app/invite-link.tsx` — **7.5 → 8**
- **Scores now:** Function 8 · States 8.5 · UI 8 · A11y 8.5 · Security 8 · Code 8 (mean 8.17)
- **Original items (rerate/B):**
  1. ❌ Verified links for `JOIN_BASE` (21): `app.json:66-77` is unchanged.
  2. ✅ `AppText` (18). Link and create buttons have `minHeight: 44` (240, 246), and the row wraps (245). Back is 44 (230).
  3. ✅ A `RefreshControl` (56-60, 172). `activeCount` excludes expired links (112, 123, 165).
  4. ✅ `tint(c.danger)` for the error bar (236). The scrim stays black, documented (249-250). Copy is try/caught (91-98). Link buttons are labelled (183-195).
- **Regressions:** none.
- **Subscreens:**
  - Invite QR modal — 8 → 8.5.
  - Revoke confirmation — 8 → 8.
  - Permanent-link confirmation — 8 → 8.
- **Still needed for 10/10:**
  1. Verified links plus iOS domains (`app.json:62-77`).
  2. Expired links still offer Copy, Share and QR (181). Hide those for `isExpired(item)`, as is done for revoked links. The "ACTIVE LINKS (n)" list also shows revoked and expired rows (165-170). Split it, or relabel it "Links".
  3. `Share.share` is not try/caught (88-89). Revoke rolls back to the `links` captured at the tap (104-107) rather than undoing only that row.
  4. The row button labels ("Copy link", "Share link") do not say which link (183-195), which matters when several are listed.

---

### C1 — Chat conversation screen (round 3) — re-rating

Base b8c8bd2 → HEAD c28d1b2. Round 3 touched the chat in two commits: 4741b9c (Z-C1 fixes and the split) and 4ee0369 (the Whiteboard params in the attach menu, and the ViewerStack bottom inset). Old score: 7.5. Open items came from `rerate2/X1.md` (the `app/chat.tsx` section). The fix claims I checked are in `fixes/ZC1.md`.

**What I read:**
- All of current `app/chat.tsx` (2,490 lines).
- Every moved file in full: `ChatHeader`, `InChatSearchBar`, `ChatBanners`, `MessageRow`, `ComposerBars`, `Composer`, `ChatModals`, `MediaCaptionPreview`, `ChatLockGate`, `useChatMenu`, `useMessageActions`, `useMessagePaging`, `useVoiceRecording`, `useTiltReveal`, `useMediaStaging`, `bubbleA11yLabel(.selftest)`.
- The round-3 diffs of `MessageBubble.tsx`, `chatStyles.ts`, `ViewerStack.tsx`, `GifPicker.tsx`, `ConnectionBanner.tsx`, `NetworkBanner.tsx`, `LinkPreview.tsx` and `VaultBeamBubble.tsx`.
- `MessageActionSheet.tsx:55-100`.

**Checks I ran (read-only), all exit 0:**
- `npx tsc --noEmit -p .`: 0 errors.
- `npx eslint app/chat.tsx components/chat/ components/GifPicker.tsx components/MessageActionSheet.tsx components/ConnectionBanner.tsx`: 0 errors and 7 warnings, all in `MessageBubble.tsx` (270, 271, 587, 695, 821, 1190, 1299). `app/chat.tsx` has 0 warnings, down from 34.
- `npx tsx` selftests: bubbleA11yLabel, a11yCoverage, themeCoverage (22 passed, 20 exemptions), chatLockReceipts, chatLockFactors, inChatSearchCount, forwardPolicy, editWindow, chatCode, chatTimeline, outboxRecovery, orphanRoutes (51), screenBackCoverage, silentFailure (now all pass, including #17), responsiveLayout (28), keyboardAvoidance, rowOverflow, chatExportFormat.

Nothing here is device-verified or deployed.

#### Did the split preserve behaviour?
I checked the old and new code side by side (`git show b8c8bd2:app/chat.tsx` against the new files). **I found no regressions from the split.**
- **Pure moves.** I ran `diff -w` on the moved blocks:
  - Paging: old `2794-3215` against `useMessagePaging.ts:62-479`. The only differences are added stable refs and setters in the dependency arrays.
  - Media staging: old `2424-2582` against `useMediaStaging.ts:34-168`. Identical.
  - Header: old JSX against `ChatHeader.tsx:88-202`. The only difference is that `accessibilityRole="button"` was added to the call buttons and the ⋮ button.
  - Composer bars: old JSX against `ComposerBars.tsx`. Only the props were renamed, and roles were added to the link-preview close and reply cancel.
  - By eye: `MessageRow`, `ChatModals` (Info, Photo, Attach, Forward), `ChatLockGate`, `ChatBanners`, `Composer`, `useMessageActions` and `useVoiceRecording`/`useTiltReveal` all match their old blocks except for the intended a11y and theme edits.
- **Handlers.** No handler was lost:
  - Every `router.push` target from the old file is still there. The two `/voicecall` and two `/videocall` pushes from the photo popup are now one push (`app/chat.tsx:2429`).
  - The socket, queue and outbox subscriptions stayed in the screen and are unchanged (`app/chat.tsx:887-968`, `971-1280`).
  - `messagesRef` is still assigned (`useMessagePaging.ts:236`).
  - `titleRef` is assigned during render (`app/chat.tsx:2082`).
- **Accessibility props.** The counts went up: labels 45→54, roles 30→53, states 2→8, `accessibilityViewIsModal` 1→6.
- **Lock gating.** Every gate is still in place:
  - Read receipts: `app/chat.tsx:1309`, `1323`, `1354`.
  - Viewer presence: `:542`.
  - Notification clear: `:649`.
  - Memory banner: `:2248` → `ChatBanners.tsx:148`.
  - Pinned bar: `:2252`.
  - List hidden from assistive tech: `:2281-2282`.
  - The veil itself: `ChatLockGate.tsx:36-38`.
  - The composer area is now hidden too (`app/chat.tsx:2363-2366`).
- **Effect order.** Order is preserved at the points that matter. The hooks are called where their code used to sit: voice, tilt and staging at `:1793-1804`, paging at `:1949`, ahead of the outbox-adopt, wallpaper and lock focus effects (`:1971`, `:1997`, `:2023`). The key-change check and the expiry countdown moved into child components. Both are self-contained async or interval effects.
- **Minor side effect.** `Composer` and `ChatHeader` now mount after `loading` clears, so the chevron pulse and expiry tick start then instead of at screen mount. This is harmless.

| Screen | Old | New | Δ |
|---|---|---|---|
| `app/chat.tsx` — Chat conversation (1:1, group, split pane), incl. `components/chat/*` | 7.5 | **8** | +0.5 |

#### `app/chat.tsx` — **7.5 → 8**
- **Scores now:** Function 8.5 · States 9 · UI 8 · A11y 8.5 · Security 8.5 · Code 6.5 (avg 8.17 → **8**)
  - **Function (8.5, unchanged):** Groups now have Clear chat and Leave group, and search has previous/next. GIF and Forward still bypass the outbox, and the notification-sound picker still has no current mark.
  - **States (9, unchanged).**
  - **UI (7 → 8):** The banner palettes are tinted from tokens, the live-location banner is tokenised, the view-once badge follows the safe-area inset, and the ConnectionBanner contrast is fixed. Left: the fixed `WARN` amber, the bubble's `#4A9FFF` read tick, and the `HL` link colour.
  - **A11y (8 → 8.5):** The bubble has a summary label, roles are complete, modals carry the modal flag, reaction chips have a selected state, and thumbnails are labelled. Left: modal sheets nested inside an accessible backdrop, and TalkBack can still reach the header and banners under the veil.
  - **Security (8.5, unchanged):** Remind is hidden for protected messages, and exports and reminders already honour `meta`. I found Invisible Ink leaks that predate this round (reply bar, quoted reply, Memory banner, search count).
  - **Code (5 → 6.5):** The file went from 4,674 to 2,490 lines across focused files, the hook-deps warnings went from 34 to 0, and `useS()` is shared. Left: `as any` is still 46 in total, `MessageBubble.tsx` is still 1,814 lines with 7 warnings, and the socket effect is still about 310 lines inline.
- **X1 items:**
  1. ✅ Remind is hidden for view-once and Invisible Ink messages (`useMessageActions.ts:79-86`), and Star stores no snapshot for them (`:76`). Exports print `[Protected message]` (`lib/chatExportFormat.ts:19`), and reminders return null for protected rows (`app/message-reminder.tsx:96`). Both of those landed before b8c8bd2, in 749f4ea.
  2. ◐ Android veil. The mention picker, the bars and the composer are hidden while locked (`app/chat.tsx:2363-2366`). The header (`:2213`), search bar (`:2232-2240`), key-change, screenshot and live-location banners (`:2244-2250`) and the FAB (`:2340`) are siblings that are not hidden. A TalkBack user can probably still reach ⋮ and Search under the veil. Needs a device check.
  3. ❌ GIF and Forward still post directly (`app/chat.tsx:1901`, `:1734`). The fixer handed off a typed `enqueueMessage` for `lib/messageQueue.ts`, which only has `enqueueText/Reaction/Edit/Delete` (`lib/messageQueue.ts:226-256`).
  4. ✅ Search has previous/next with wrap-around, "N of M" in a live region, and submit steps to the next match (`InChatSearchBar.tsx:27-42`, `56`, `59-84`). Stepping scrolls and flashes the row (`app/chat.tsx:1957-1963`). It still searches only the loaded window.
  5. ✅ Groups have Clear chat, with "Other members keep their copy", and Leave group, using the same call and wording as group-info (`useChatMenu.ts:264-323`; `app/group-info.tsx:251-256`). Neither navigates in embedded mode (`:291`, `:317`).
  6. ❌ The sound picker has no current mark (`useChatMenu.ts:81-94`). This is blocked: no GET returns `notif_sound`, and ZBE did not add it.
  7. ◐ Theme:
     - Live location is tinted from `c.primary` (`chatStyles.ts` liveLoc*; `ChatBanners.tsx:183-195`).
     - The view-once badge sits at `insets.top + 64` (`MediaCaptionPreview.tsx:95`).
     - Error, memory and ink are tinted from `c.danger`/`c.purple`. Banner text is `c.text`, and `e2eBadge` is `c.success` (chatStyles diff).
     - ConnectionBanner uses `AuroraLight.danger` `#B42318` in both schemes (`ConnectionBanner.tsx:37`; `constants/theme.ts:210`).
     - Left: the fixed `WARN` (`chatStyles.ts:22`), `#B45309` (`ViewerStack.tsx:24`), the bubble's `#4A9FFF` read tick (`MessageBubble.tsx:1743`), and `HL.link #7DD3FC` (`chatStyles.ts:107`).
  8. ✅ The bubble summary label is set at `MessageBubble.tsx:1362-1388`. It never speaks unrevealed ink, view-once or revoked content, and the selftest passes. Modal flags were added at `ChatModals.tsx:23`, `74`, `120`, `160` and `ViewerStack.tsx:58`. See the new findings for the nesting caveat.
  9. ◐ The split is done (above), and chat.tsx has 0 eslint warnings. `as any` is 22 in chat.tsx plus 31 in `components/chat/*` (useChatMenu 15, MessageBubble 6, ChatHeader 4, …), so the total is not reduced.
  10. ❌ Message Info per-member timestamps are blocked on the backend. There is no multi-select.
- **Other Z-C1 claims checked:**
  - ✅ The reaction chip has a role, label, selected state and hitSlop (`MessageBubble.tsx:1771-1777`). The quoted-reply preview has a role (`:1435-1436`).
  - ✅ Roles on mic, send and voice discard/send. Send is labelled "Save edit" while editing and has the silent long-press hint and busy state (`Composer.tsx:121-124`, `233-245`).
  - ✅ Thumbnails are labelled with a selected state, and the caption field is labelled (`MediaCaptionPreview.tsx:106-118`, `147`).
  - ✅ ViewerStack has a role, hint, hitSlop and the modal flag, and the bottom inset comes from 4ee0369 (`ViewerStack.tsx:41`, `58`).
  - ✅ Mentions use Unicode (`app/chat.tsx:1426`, `1442`; `MessageBubble.tsx:84`).
  - ✅ The dead attach `color` field is gone (`app/chat.tsx:1920-1945`).
  - ✅ The stale `title` in `recordScreenshotAttempt` is fixed through `titleRef` (`:1624`, `1672`, `2082`). The screenshot effect is keyed on primitives (`:1620-1682`).
  - ✅ `useS` is a module-level single-entry cache (`chatStyles.ts` useS).
  - ✅ The Chat lock entry passes `chatName` (`useChatMenu.ts:240`).
  - ✅ Whiteboard now gets the return params (`app/chat.tsx:1938-1943`).
- **Regressions:** none from the split or the fixes.
  - One risk to check on a device. The new `\p{L}` / `u`-flag regex literals (`app/chat.tsx:1426`, `1442`; `MessageBubble.tsx:84`) must be supported by the shipped Hermes/Babel pipeline. If they are not, they fail at module parse and take down both the chat screen and every bubble. The fixer only ran tsc, which does not prove this. Not verifiable statically.
- **New findings** (these predate round 3; earlier rounds did not record them):
  1. **Invisible Ink text shows outside the bubble** for a recipient who has not tilted the phone:
     - The composer reply bar prints `replyTo.content` (`ComposerBars.tsx:155-160`).
     - The in-bubble quote prints `replyPlain` (`MessageBubble.tsx:1144-1146`, `1453`).
     - The Memory banner quotes any `text` message ≥1 year old (`ChatBanners.tsx:134-135`, `167-168`).
     - The in-chat search counts and steps to ink rows, so it works as a content oracle (`InChatSearchBar.tsx:28`, `35`).
     - The pinned bar already handles ink correctly (`ChatBanners.tsx:217-219`).
  2. **On iOS, modal sheets sit inside an accessible ancestor.** Each backdrop is a `Pressable` with a role and label, so it is accessible by default and its children collapse into it. This applies to `ChatModals.tsx:22`, `73`, `119` and `159`, `ViewerStack.tsx:57` and `GifPicker.tsx:130`. The inner sheets in `ChatModals` are also accessible Pressables with no `accessible={false}` (`:23`, `74`, `120`, `160`). VoiceOver probably cannot reach the attach cells, the forward rows, or the photo actions. `MessageActionSheet.tsx:69-72` does this correctly, with the backdrop as a sibling. Not verifiable statically.
  3. **The bubble is one accessible element with no role** (`MessageBubble.tsx:1387-1413`). Nested controls (the quoted-reply jump, link preview, poll options, VaultBeam pills) are probably not individually reachable on iOS. The `longpress` action is still exposed. Needs a device check.
  4. **Small issues:**
     - The lock error has no live region (`ChatLockGate.tsx:86`).
     - "Back to chats" on the veil uses `router.replace` even in an embedded pane (`ChatLockGate.tsx:93`).
     - Leave group in an embedded pane leaves the pane showing a chat you no longer belong to (`useChatMenu.ts:317`).
     - The composer `TextInput` has no `accessibilityLabel` (`Composer.tsx:150-158`).
     - The count reads "1 matches" (`InChatSearchBar.tsx:60`).
- **Subscreens:**
  - Message thread (FlatList + MessageRow) — 8 → 8.5. Summary label and verbatim move. Quoted-reply ink leak, nested controls.
  - Header (`ChatHeader`) — 8.5 → 9. Every icon has a role, plus `c.success`/`c.online`. Under the veil, TalkBack can still reach it.
  - Overflow menu + Screenshot/Sound/Disappearing pickers — 8 → 8.5. Group Clear/Leave, `chatName`. No mark on the current sound.
  - In-chat search bar — 6 → 7.5. Previous/next, "N of M", live region. Loaded window only, ink oracle, "1 matches".
  - ConnectionBanner — 8 → 9. Offline background is about 6.5:1 (`ConnectionBanner.tsx:35-37`).
  - Error bar — 8 → 8.5. Tinted from `c.danger`, live region.
  - Security-code-change banner — 7.5 → 8.5. `c.text`/`c.accentOn` on a `WARN` tint.
  - Inbound screenshot banner — 7.5 → 8.5.
  - Memory Bubble — 7 → 7. Tokenised, but quotes Invisible Ink text (`ChatBanners.tsx:135`, `168`).
  - Live-location banner — 7 → 8. Tokenised. It is not lock-gated for TalkBack, and the ✕ is still nested in the touchable (`ChatBanners.tsx:182-200`).
  - Pinned-message bar — 8.5 → 8.5 (moved unchanged).
  - Scroll FAB + "Load newer" pill — 8.5 → 8.5.
  - @mention picker — 7 → 7.5. Unicode. Still first name only (`app/chat.tsx:1441`), plus the Hermes `\p{}` risk above.
  - Live viewers stack + "Viewing now" modal — 7 → 8. Role, hint, modal flag, palette roles, inset. Backdrop nesting; fixed amber.
  - Typing indicator — 8.5 → 8.5.
  - Edit-mode bar — 8 → 8.5 (`brandAlpha`).
  - Vanish Mode / Invisible Ink bars — 6.5 → 8. Tinted, with `c.text` ink.
  - Composer link-preview card — 8 → 8.5 (close has a role).
  - Reply bar — 8.5 → 8. A role was added, but it prints unrevealed ink text (`ComposerBars.tsx:160`).
  - Composer + camera tap/slide — 8 → 9. Roles, states, "Save edit", silent hint. The input has no label.
  - Voice recording mode — 8 → 8.5 (roles).
  - Long-press MessageActionSheet — 8.5 → 9. Remind is hidden for protected messages.
  - Message Info modal — 7 → 7.5. Modal flag and backdrop label. Nesting issue; no timestamps (backend).
  - Profile photo viewer — 7.5 → 8. Modal flag; nesting.
  - Attach menu — 7 → 7.5. Dead `color` removed, modal flag. Nesting; still `setTimeout(a.onPress, 120)` (`ChatModals.tsx:128`).
  - GifPicker overlay + preview — 7.5 → 8. The sheet is `accessible={false}` and Cancel/Send are labelled. The backdrop is still an accessible ancestor (`GifPicker.tsx:130`), and the send is not queued.
  - Media caption preview — 7.5 → 8.5. Labelled thumbnails, inset badge, roles, caption label.
  - Forward picker — 6.5 → 7. Modal flag. No search; not queued; nesting.
  - Per-chat lock gate — 8.5 → 8.5. The composer area is hidden on Android. The header, ⋮, search and banners are not, and the error has no live region.
  - Not-found / loading — 9 → 9.
  - Failure / destructive Alerts — 8.5 → 8.5. The new Clear and Leave both confirm (`useChatMenu.ts:268-273`, `311-313`).
  - Group-chat mode — 7 → 8. Clear/Leave, Unicode mentions.
  - Embedded split-pane mode — 8 → 8. Clear, Leave and Block don't navigate. Lock "Back to chats" replaces; Leave strands the pane.
  - `components/chat/MessageBubble.tsx` — 7.5 → 8. Summary label, chip/quote roles, location tokens, shared `useS`. 1,814 lines, 7 deps warnings, `HL`/`#4A9FFF`, ink in the quote.
  - `components/MessageActionSheet.tsx` — 8 → 8. File unchanged. The backdrop is a sibling, which is the right pattern.
- **Still needed for 10/10:**
  1. Stop unrevealed Invisible Ink text appearing outside its bubble:
     - Reply bar (`ComposerBars.tsx:155-160`).
     - In-bubble quote (`MessageBubble.tsx:1453`).
     - Memory banner (skip `meta.invisibleInk`, `ChatBanners.tsx:134-135`).
     - In-chat search (skip ink and view-once rows, `InChatSearchBar.tsx:28`, `35`).
  2. Hide everything except the veil from assistive tech while locked on Android: the header, search bar, banners and FAB (`app/chat.tsx:2213-2250`, `2340`). For example, wrap them like `:2363-2366`, or render the veil as the only child.
  3. Fix modal a11y nesting on iOS. Make each backdrop a sibling (the `MessageActionSheet.tsx:69-72` pattern), or set `accessible={false}` on the backdrop and the inner sheet. Affected: `ChatModals.tsx:22-23`, `73-74`, `119-120`, `159-160`, `ViewerStack.tsx:57`, `GifPicker.tsx:130`. Give the bubble `accessibilityRole` and expose its nested controls (`MessageBubble.tsx:1387`).
  4. Route GIF and Forward through the outbox once `lib/messageQueue.ts` has a typed enqueue (`app/chat.tsx:1901`, `:1734`).
  5. Mark the current notification sound when the server returns `notifSound` (`useChatMenu.ts:81-94`).
  6. Confirm on a device that Hermes accepts the `\p{L}` / `u` regexes (`app/chat.tsx:1426`, `1442`; `MessageBubble.tsx:84`), or add a runtime selftest.
  7. Theme: add a palette warning role for `WARN` and `#B45309` (`chatStyles.ts:22`, `ViewerStack.tsx:24`). Tokenise the bubble's read tick and the `HL` link colour (`MessageBubble.tsx:1743`, `chatStyles.ts:107`).
  8. A11y nits: a live region on the lock error (`ChatLockGate.tsx:86`), a label on the composer input (`Composer.tsx:150`), and "1 match" (`InChatSearchBar.tsx:60`).
  9. Embedded mode: the veil's "Back to chats" and Leave group should not replace or strand the split pane (`ChatLockGate.tsx:93`, `useChatMenu.ts:317`).
  10. Code: cut the 46 `as any` (`useChatMenu.ts` 15, `app/chat.tsx` 22). Move the socket effect out (`app/chat.tsx:971-1280`). Split `MessageBubble.tsx` and fix its 7 deps warnings.
  11. Search beyond the loaded window, or hand off to `/in-chat-search`. Add per-member times in Message Info (backend) and multi-select.

---

### C2 — Chat tools, backup & import — round-3 re-rating

This is a static, read-only review from `b8c8bd2` to `HEAD` (`c28d1b2`), and the working tree is clean. It uses the same rubric (`RUBRIC.md`) and output format (`RERATE.md`). Each overall score is the mean of the six dimensions, rounded to the nearest 0.5, with ties rounded up.

**Baselines ("Old" and their open items):**
- `rerate2/X1.md` for bookmarks, chat-export, chat-wallpaper and message-reminder.
- `rerate/C2.md` for the other 12 screens.
- `ratings/C2.md` for hidden-chats, which no later round re-rated.

**Fixer claims checked:** `fixes/ZC2.md`. I checked every claim against the current code. I also checked the handoffs:
- Done: ✅ `chatName` is now passed from the chat menu (`components/chat/useChatMenu.ts:240`, from ZC1).
- Not done:
  - ❌ `components/finance/useDatePicker` was not moved. It still uses `useFinanceTheme` (`components/finance/useDatePicker.tsx:16,23`).
  - ❌ `lib/chatService` has no `dropBookmarkPlaintext`.
  - ❌ `enableE2EEBackup` was not rolled back. It still deletes on failure (`lib/cloudBackup.ts:155-163`).
  - ❌ There is no server rate limit for `/user/pin/verify`. `fixes/ZBE.md` has no item for it.

**Evidence I ran myself** (`npx tsx`, all exit 0 at HEAD):
- a11yCoverage, themeCoverage (22/20), bookmarkBodies, bookmarkProtected (new), scopedChoice, chatExportFormat, chatLockPin, chatLockFactors, chatLockReceipts, orphanRoutes (51), chatCode, wallpaperFile, waImport, screenBackCoverage, recoveryKeyCheck (new) and uiDebtRatchet ("no file got worse").
- ZC2 reported chatCode, chatLockFactors, chatLockReceipts and orphanRoutes as failing because of the chat.tsx split. They pass now, so the split-out kept those strings.
- `npx eslint` on the 17 screens plus the 3 changed libs gives 0 errors and 3 warnings. All 3 already existed before round 3:
  - `app/broadcast.tsx:125` (`selected?.id` deps)
  - `app/import-chats.tsx:186` and `:385` (missing deps)

**Chat.tsx split (regression check).** Every entry point of this batch still resolves after the split:
- Chat ⋮ menu (`components/chat/useChatMenu.ts`): Export chat at `:177`, Chat lock with `chatName` at `:240`, Schedule at `:246`, Wallpaper at `:253`, Bubble theme at `:258`, Exit Kit → import-chats at `:333`.
- Poll: `app/chat.tsx:1935`.
- Remind: `components/chat/useMessageActions.ts:83`. It is now hidden for view-once and ink messages.
- Star stores no snapshot for protected messages (`useMessageActions.ts:76`).

I found no regression from the split in this batch.

Nothing here is device-verified or deployed. The beforeRemove prompts, AppState re-lock, countdown announcements, `dismissTo`, and the scheduled-copy prune are **not verifiable statically**.

| Screen | Old | New | Δ |
|---|---|---|---|
| `app/in-chat-search.tsx` | 8.0 | 8.0 | 0 |
| `app/message-reminder.tsx` | 7.5 | 8.0 | +0.5 |
| `app/schedule-message.tsx` | 8.0 | 8.0 | 0 |
| `app/scheduled.tsx` | 7.0 | 7.5 | +0.5 |
| `app/create-poll.tsx` | 8.0 | 8.0 | 0 |
| `app/bookmarks.tsx` | 7.5 | 8.0 | +0.5 |
| `app/chat-code.tsx` | 8.0 | 8.0 | 0 |
| `app/chat-export.tsx` | 7.0 | 7.5 | +0.5 |
| `app/chat-themes.tsx` | 7.5 | 8.0 | +0.5 |
| `app/chat-wallpaper.tsx` | 7.0 | 7.5 | +0.5 |
| `app/receipt-control.tsx` | 7.0 | 7.5 | +0.5 |
| `app/broadcast.tsx` | 7.0 | 7.5 | +0.5 |
| `app/hidden-chats.tsx` | 5.5 | 7.5 | +2.0 |
| `app/app-lock-chats.tsx` | 7.5 | 8.0 | +0.5 |
| `app/import-chats.tsx` | 7.5 | 7.5 | 0 |
| `app/chat-backup.tsx` | 7.0 | 7.5 | +0.5 |
| `app/backup-e2ee.tsx` | 7.5 | 8.0 | +0.5 |

---

#### `app/in-chat-search.tsx` — **8.0 → 8.0**
- **Scores now:** Function 8.5 · States 8.5 · UI 8 · A11y 8 · Security 7.5 · Code 8 (mean 8.08)
- **Original items:**
  - ✅ `renderItem`, `highlightMatch` and `onTapResult` are `useCallback`s, and the separator is hoisted (`app/in-chat-search.tsx:32`, `:136-177`). `renderItem` still depends on `term`, so it is rebuilt on every keystroke. That is correct, but the gain is limited.
  - ✅ The lock gate is wrapped in `KeyboardSafe` (`:185`, `:243`). `unlockTxt` uses `c.bubbleOutText` (`:388`).
  - ✅ The search input is labelled (`:263`).
  - ✅ `debounce` is typed (`:40`). The lock error has the alert role (`:237`).
- **Regressions:** none.
- **New finding (existed before round 3):** results can contain view-once and Invisible Ink text.
  - `searchCachedMessagesInChat` selects no `meta` and filters only on type and envelope (`lib/localDb.ts:962-975`). `searchInChat` passes the hits straight through (`lib/chatService.ts:2586-2593`).
  - Bookmarks, Reminders and Export now hide these messages; this screen does not. I lowered Security from 8 to 7.5 for this.
- **Subscreens:** Lock gate — 7.5 → 8.5. It is keyboard-safe, uses tokens and has an alert role.
- **Still needed for 10/10:**
  1. Exclude `meta.viewOnce`/`meta.invisibleInk` rows from search hits (`lib/localDb.ts:962-975`), or render them as "Protected message" in `renderItem` (`app/in-chat-search.tsx:162-177`).
  2. Add a Try again to the error state, which today shows the raw `e.message` (`:108-109`, `:289-294`).
  3. Make the screen reachable from the chat's own search. Today its only entry is contact-info (`app/contact-info.tsx:282`).

#### `app/message-reminder.tsx` — **7.5 → 8.0**
- **Scores now:** Function 8 · States 8 · UI 7.5 · A11y 7.5 · Security 8 · Code 7.5 (mean 7.75, tie rounded up)
- **Original (X1) items:**
  1. ✅ `cachedText` returns null for `meta.viewOnce`/`invisibleInk` (`app/message-reminder.tsx:95-96`). Remind is also no longer offered for these messages (`components/chat/useMessageActions.ts:79-86`).
  2. ✅ The copy is fixed: "Settings → Message reminders" (`:245`) and "Long-press any message in a chat → Remind" (`:344`).
  3. ✅ Errors are surfaced:
     - `loadReminders` throws on a read failure or a non-array (`:71-75`). The list shows "Couldn't load reminders" with Try again (`:332-339`).
     - The composer cancels the OS notification if storing the row fails (`:174-186`).
     - Cancel reports a save failure but still removes the row (`:306-312`).
  4. ✅ The trigger has no `as any` (`:171`), `backTxt` is gone, and the headers have roles (`:205`, `:329`).
- **Regressions:** minor. A corrupted stored value (unparseable JSON, `:74`) now blocks every new reminder: the composer always cancels and reports failure (`:174-186`). The list's only option is Try again, which fails the same way (`:336`). Before round 3, a corrupted value read as an empty list and was overwritten. There is no reset path.
- **Subscreens:** Composer — 7.5 → 8. Reminders list — 7.5 → 8.
- **Still needed for 10/10:**
  1. Add a recovery path for an unreadable list, for example "Clear reminders" in the error state, which cancels all scheduled notifications and resets `vc_message_reminders_v1` (`:71-75`, `:332-339`).
  2. A reminder row can only cancel. Add an "Open chat" action (`setPendingJump` and push `/chat`), and keep cancel as an accessibility action (`:353-360`).
  3. Add pull-to-refresh to the list (`:348`).
  4. The `preview` text travels as a route param (`useMessageActions.ts:83-84`). Consider re-reading it from the sealed cache by id, as the list already does.

#### `app/schedule-message.tsx` — **8.0 → 8.0**
- **Scores now:** Function 8 · States 8 · UI 8 · A11y 8 · Security 8.5 · Code 7.5 (mean 8.0)
- **Original items:**
  1. ❌ `useDatePicker` is still imported from `components/finance` (`app/schedule-message.tsx:20-21`), and it still uses `useFinanceTheme` (`components/finance/useDatePicker.tsx:16,23`). ZI1 only themed its scrim (`:61-62`). The handoff is still open.
  2. ✅ `busyRef` is set synchronously in `doSchedule` (`:64`, `:74-75`, `:88`).
  3. ✅ `backTxt` is removed. Also done: a header role (`:110`), a custom-time label (`:156`), and a "Scheduled" link (`:189`).
- **Regressions:** none.
- **Subscreens:** Custom date/time picker — 7.5 → 7.5. The finance theming is unchanged, and iOS needs a device check.
- **Still needed for 10/10:**
  1. Move `useDatePicker` to a shared UI module themed with `useTheme` (`components/finance/useDatePicker.tsx:16,23`, `app/schedule-message.tsx:21`).
  2. Back discards a typed message with no prompt (`:107`). Sibling create-poll now asks (`app/create-poll.tsx:40-56`).
  3. Fix the stale header comment "sweep loop in server.js" (`:8`); the backend is Go.
  4. The inline "Scheduled" link is a nested `Text` with no minimum target (`:189`). Make it a 44dp button.

#### `app/scheduled.tsx` — **7.0 → 7.5**
- **Scores now:** Function 7.5 · States 8 · UI 7.5 · A11y 7.5 · Security 7.5 · Code 7.5 (mean 7.58)
- **Original items:**
  1. ✅ The `SCHEDULED_LOCAL` branches, the casts, Edit and the unused imports are gone (`app/scheduled.tsx:28-36`, `:124-135`).
  2. ✅ `pruneScheduledCopies` runs only when the list is shorter than `SERVER_LIST_LIMIT` (`:39-40`, `:78`, `lib/scheduledLocalCopy.ts:66-82`). That the server lists delivered rows for 7 days is **not verifiable statically**.
  3. ✅ Non-text rows null an envelope `content` (`:49`).
  4. ✅ A cold-load error shows Try again, and the empty `ScrollView` has a `RefreshControl` (`:157-171`).
  5. ✅ There is one server load, from `useFocusEffect` (`:108-110`). The cache paint is guarded by `loadedRef` (`:93-104`). `backTxt` is gone, and rows have a full label (`:202`).
- **Regressions:** none.
- **New finding (existed before round 3):** previews of messages scheduled into locked chats are shown without a lock check (`:46-54`). Bookmarks and Reminders apply `isChatLocked` (`app/bookmarks.tsx:50-59`, `app/message-reminder.tsx:271-279`).
- **Subscreens:** Cancel dialog — 6.5 → 7.5. The dead Edit branch is gone, and the cancel error is surfaced (`:124-135`).
- **Still needed for 10/10:**
  1. Hide previews for locked chats with `isChatLocked`, failing closed, as bookmarks does (`:46-54`).
  2. A refresh failure over existing rows is silent, because the error is only set when `prev.length === 0` (`:85-88`). Show a "Couldn't refresh" line, as broadcast and bookmarks do.
  3. Move `setError` out of the `setRows` updater, since side effects inside an updater run twice under StrictMode (`:85-88`). Memoise `renderItem` (`:195`).

#### `app/create-poll.tsx` — **8.0 → 8.0**
- **Scores now:** Function 8.5 · States 8 · UI 8 · A11y 8 · Security 8 · Code 8 (mean 8.08)
- **Original items:**
  1. ✅ A `beforeRemove` guard asks "Discard poll?" when there is text, and is bypassed after a send (`app/create-poll.tsx:40-56`, `:90`). Device behaviour is **not verifiable statically**.
  2. ✅ Send (`:196`) and Add option (`:208`) have `minHeight: 44`.
  3. ✅ `backTxt` and `removeBtnTxt` are removed.
- **Regressions:** none.
- **Subscreens:** none.
- **Still needed for 10/10:**
  1. `submit` guards double taps only through the `posting` state (`:70-97`, `:112`). Add a synchronous ref, as schedule-message has (`app/schedule-message.tsx:74-75`).
  2. Drop the `beforeRemove` event cast (`:49`) by typing the listener (`EventArg<'beforeRemove', true, …>`).
  3. Poll options are sent as `meta.options` (`lib/chatService.ts:1633-1635`). Whether `meta` is encrypted in transit and at rest is **not verifiable statically** from this screen. State it in the UI, as broadcast does.

#### `app/bookmarks.tsx` — **7.5 → 8.0**
- **Scores now:** Function 8 · States 8.5 · UI 8 · A11y 8 · Security 8 · Code 8 (mean 8.08)
- **Original (X1) items:**
  1. ◐ Pre-fix ink and view-once bookmarks show "🔒 Protected message" and their snapshot is never read (`app/bookmarks.tsx:60-62`, `lib/bookmarkBodies.ts:30-33`). The new `bookmarkProtected` selftest passes.
     - The snapshot is hidden but not purged; this is documented in a `ponytail:` comment (`:60-61`).
     - The check depends on the server returning `meta` in `/user/bookmarks` (`lib/chatService.ts:1682`, `meta?: any`), which is **not verifiable statically**.
  2. ✅ Refresh and saved-copy states:
     - The empty `ScrollView` has a `RefreshControl` (`:177-179`).
     - A failed refresh over cached rows shows "Couldn't refresh — showing your saved copy" (`:105-108`, `:170-174`).
     - A failed cold load shows Try again (`:181-190`).
  3. ✅ `'(deleted chat)'`, `as any` and `backTxt` are removed. `router.push` is typed (`:129`).
- **Regressions:** none. One edge case: a cached `[]` is truthy, so a failed load with an empty cache shows both "Couldn't refresh" and "No bookmarks yet" instead of the error state (`:87`, `:107`).
- **Subscreens:** none.
- **Still needed for 10/10:**
  1. Purge protected snapshots, not just hide them, once `lib/chatService` exports a snapshot delete (`:60-62`).
  2. Treat an empty cache as a cold load, using `cached?.length` (`:87`, `:107`).
  3. Memoise `renderItem` (`:207`).

#### `app/chat-code.tsx` — **8.0 → 8.0**
- **Scores now:** Function 8 · States 8.5 · UI 8 · A11y 8.5 · Security 8 · Code 8 (mean 8.17)
- **Original items:**
  1. ✅ The stale comment is fixed.
  2. ✅ Touch targets are fixed: back is 44 (`app/chat-code.tsx:350`), tabs 44 (`:354`), Copy/Share actions 56×48 (`:376`), Stop 44 (`:389`).
  3. ✅ The per-second live region is replaced by `announceForAccessibility` at the 60, 30 and 10 s marks (`:68-77`, `:130-133`). The timer row has a static label (`:224`). Real TalkBack output is **not verifiable statically**.
  4. ✅ "New code" on a live code asks "Replace this code?" (`:146-152`).
- **Regressions:** none.
- **Subscreens:** Share-a-code tab — 8 → 8.5. Enter-a-code tab — 8 → 8.
- **Still needed for 10/10:**
  1. The share text always says "expires in 2 minutes" (`:252`). Use the remaining time.
  2. `mint`, `stop` and `join` guard re-entry with state only (`:135-136`, `:155-157`, `:168-170`). Add a ref guard.
  3. Map server errors to user copy instead of `e.message` (`:175`).

#### `app/chat-export.tsx` — **7.0 → 7.5**
- **Scores now:** Function 8 · States 7.5 · UI 7.5 · A11y 8 · Security 8 · Code 7 (mean 7.67)
- **Original (X1) items:**
  1. ✅ Protected messages export as `[Protected message]` (`lib/chatExportFormat.ts:19`). The selftest passes.
  2. ✅ The truncation warning now comes before formatting and sharing ("Export anyway?", `app/chat-export.tsx:211-215`).
  3. ✅ The PIN is digits-only with `maxLength={8}` (`:327-330`). Unlock is disabled under 4 digits (`:341-345`), and the error has the alert role (`:334`).
  4. ✅ The RN styles use tokens (`:353`). `BRAND_ACCENT` is used only in the exported HTML (`:17-18`, `:246-248`). The `'#00000099'` scrim is kept with a comment (`:383-384`). The PIN buttons are 44dp (`:389-390`).
- **Regressions:** none.
- **Subscreens:** Chat-lock PIN modal — 7.5 → 8.
- **Still needed for 10/10:**
  1. A long export cannot be cancelled. Leaving mid-export keeps paging up to 500×200 messages and setting state after unmount (`:64-81`, `:196-225`). Add Cancel and an unmount flag.
  2. Building the whole export as one string in memory (`:227-238`, `:240-268`) can exhaust memory on large chats. Stream it to the file in chunks.
  3. Add a scrim token (`:384`). Hoist the per-render closures (`fetchAll`, `bodyOf`, `writeFile`) out of the component.

#### `app/chat-themes.tsx` — **7.5 → 8.0**
- **Scores now:** Function 8.5 · States 8 · UI 7.5 · A11y 8 · Security 8 · Code 7.5 (mean 7.92)
- **Original items:**
  1. ✅ `stored` and `globalId` are tracked separately. The preview uses `resolveScoped`, the rule chat.tsx uses (`app/chat-themes.tsx:59-61`, `:94-98`).
     - A per-chat screen has a "Same as all chats · <name>" radio (`:139-151`).
     - Reset removes the key (`:79-91`, `:111-118`).
     - The scopedChoice selftest passes.
  2. ✅ A `touched` ref drops a late load result (`:63`, `:70`, `:80`).
- **Regressions:** none.
- **Subscreens:** none.
- **Still needed for 10/10:**
  1. `getBubbleColors` is exported from a route file and imported by `app/chat.tsx:73`. Move it with the storage keys into `lib/` (`:21-22`, `:176-186`).
  2. A load failure silently shows the defaults (`:73`). Say so, or disable saving.
  3. Replace the meta colour literals `rgba(255,255,255,0.6)` and `rgba(0,0,0,0.45)` and the `idealText` hexes (`:46`, `:99`) with tokens.

#### `app/chat-wallpaper.tsx` — **7.0 → 7.5**
- **Scores now:** Function 7.5 · States 8 · UI 7.5 · A11y 8 · Security 7.5 · Code 7.5 (mean 7.67)
- **Original (X1) items:**
  1. ✅ `PreviewBg` is at module scope, with props (`app/chat-wallpaper.tsx:77-95`, `:226`).
  2. ✅ `savingRef` and `saving` guard save, and the button shows Saving… (`:112-113`, `:148-152`, `:181-184`, `:313`). The picker is in a try/catch (`:189-206`). The wallpaperFile selftest passes.
  3. ✅ One save model: `beforeRemove` asks "Discard wallpaper change?" when the pick differs from what is stored, and is bypassed after Set (`:130-146`, `:175`). A `touched` ref guards the load/pick race (`:115-125`).
  4. ✅ Colour tiles are announced by name ("<Name> wallpaper", `:30-41`, `:267`). Tabs and Reset are 44dp (`:346`, `:335`).
- **Regressions:** none.
- **New finding (existed before round 3; chat-themes fixed the same issue this round):** a per-chat screen ignores the global wallpaper.
  - The load reads only the per-chat key (`:121-123`), so a chat that inherits the all-chats wallpaper shows "Default" checked (`:253-258`). Meanwhile the chat actually shows the global one (`getWallpaper`, `:63-73`).
  - There is no "Same as all chats" option, and saving Default stores `SCOPED_DEFAULT`, which permanently opts out (`:169`).
- **Subscreens:** Colors — 7.5 → 8. Gradients — 7.5 → 8. My photo — 7.5 → 8.
- **Still needed for 10/10:**
  1. Apply the chat-themes model on the per-chat screen: read the global value, preview the inherited wallpaper, and add "Same as all chats" that removes the key (`:118-128`, `:166-170`, `:253-263`).
  2. Move `getWallpaper` and the storage keys from the route file into `lib/` (`:63-73`; imported at `app/chat.tsx:72`).
  3. Give the Set button `minHeight` and remove the inline `{ opacity: 0.6 }` (`:313`, `:367`).

#### `app/receipt-control.tsx` — **7.0 → 7.5**
- **Scores now:** Function 8 · States 8 · UI 7.5 · A11y 8 · Security 7 · Code 7.5 (mean 7.67)
- **Original items:**
  1. ✅ `reloadKey` re-runs the load, and a Try again button sits in the error bar. The empty text is hidden after a failure (`app/receipt-control.tsx:63`, `:93`, `:179-188`, `:210`).
  2. ✅ Toggles are 44×44 with gap 4 and no hitSlop (`:243-244`).
  3. ✅ `Toggle` is at module scope with a typed icon (`:35-51`).
  4. ✅ Rapid taps:
     - `rulesRef` is patched synchronously (`:97`, `:110`, `:115-122`).
     - Requests are serialised per contact and flag through `chains` (`:100`, `:124-134`).
     - Rollback happens only if no later tap changed the flag (`:131`).
- **Regressions:** none.
- **Subscreens:** none.
- **Still needed for 10/10:**
  1. `Toggle` calls `useS()` per instance, so every row builds three StyleSheets (`:39`). Pass styles down instead.
  2. `c.danger + '1F'` and `'66'` assume a 6-digit hex token (`:235`). Use an alpha helper, as `brandAlpha` does.
  3. Add pull-to-refresh to the list (`:193`). Whether the server honours `hideRead`/`hideTyping`/`hideLastSeen` is **not verifiable statically**.

#### `app/broadcast.tsx` — **7.0 → 7.5**
- **Scores now:** Function 7 · States 7.5 · UI 7.5 · A11y 8 · Security 7 · Code 7 (mean 7.33)
- **Original items:**
  1. ✅ (n/a here) The query survives the auth gate; this was fixed in `app/_layout.tsx` by another package, per the ZC2 log.
  2. ✅ The channel list has a `RefreshControl` (`app/broadcast.tsx:298`). With no cache, a failed load shows "Couldn't load channels" with Try again (`:312-320`). Over a cache, it shows a "Couldn't refresh" line (`:288-290`).
  3. ✅ The `openId` ref drops a page for a channel that is no longer open (`:61`, `:152-167`, `:176`).
  4. ✅ Pagination: `onEndReached` loads older posts with `before`, 50 per page, with `hasMore` and a footer spinner (`:29`, `:169-181`, `:233-235`).
  5. ❌ There is still no leave or admin delete, and `channel_post` is still not filtered by channel (`:117-120`). These need backend changes; the ZBE log has none.
  6. ◐ The `rgba(0,0,0,0.55)` scrim is kept with a comment (`:411-412`).
- **Regressions:** none.
- **Subscreens:** Channel list — 6.5 → 8. Channel detail — 7 → 7.5 (paginated; a load failure is still only an Alert). Create modal — 7.5 → 7.5. Join modal — 7.5 → 7.5.
- **Still needed for 10/10:**
  1. Leave and admin delete, and filtering `channel_post` by `channelId`. All need backend work (`:117-120`).
  2. The channel detail has no retry. A failed post load shows an Alert followed by "No posts yet" (`:164-166`, `:232`).
  3. Split the list and detail modes into components, and fix the deps warning (`:125`). Add ref guards to `create`, `join` and `sendPost` (`:127`, `:139`, `:183`).
  4. Add a scrim token (`:412`).

#### `app/hidden-chats.tsx` — **5.5 → 7.5**
- **Scores now:** Function 8 · States 8 · UI 7.5 · A11y 8 · Security 7 · Code 7.5 (mean 7.67)
- **Original items:**
  1. ✅ `list.filter(c => c.hidden)` (`app/hidden-chats.tsx:189-191`). Whether the server returns only hidden rows is **not verifiable statically**.
  2. ✅ An `AppState` listener returns to the PIN stage on `background` (`:60-67`). This needs a device check.
  3. ◐ The attempt counter is persisted with its own key (`:39-49`), using the shared tracker's backoff and 15-minute decay (`services/security/pinAttempts.ts:37-42`, `:93-104`).
     - An unreadable counter fails closed (`:101-102`, `:125-126`). The 5-strike exit is kept (`:116-121`).
     - The backoff message is shown (`:103-106`).
     - There is still no server limit, documented in a `ponytail:` comment (`:42-43`). It is client-side only, so clearing app storage resets it.
  4. ✅ A11y:
     - The PIN has a label (`:142`). Cancel, Unlock and back have roles and state (`:158`, `:161-166`, `:244`). The title is a header (`:247`).
     - Errors are alert live regions (`:155`, `:251`).
     - Rows have a label with the unread count, a hint, and an "Unhide chat" accessibility action (`:290-298`).
  5. ✅ `#22C55E` and `#fff` are replaced with `c.success` and `c.bubbleOutText` (`:344`, `:356-358`). The unused vars are gone. Aurora is on the loading and list views (`:234`, `:242`). A failed load shows "Couldn't load hidden chats" with a 44dp Try again (`:254-270`, `:345`).
  6. ✅ The copy now reads "⋮ menu → Hide chat" (`:275`).
- **Regressions:** none.
- **Subscreens:** PIN gate — 5.5 → 7.5. Hidden list — 5.5 → 8.
- **Still needed for 10/10:**
  1. Add a server-side attempt limit on `POST /user/pin/verify` (backend; `:42-43`).
  2. Re-lock on iOS `inactive` too, or blur the list. The app-switcher snapshot on iOS is not covered by `background` (`:63-64`). Android FLAG_SECURE behaviour is **not verifiable statically**.
  3. Wrap the PIN gate in `KeyboardSafe`; its centred input is under the keyboard on small screens (`:133`).
  4. Add an `alive` guard to `load` (`:186-200`) and an in-flight guard to Unhide (`:218-225`). Replace the raw `e.message` (`:126`, `:194`). Memoise `renderItem` (`:284`).

#### `app/app-lock-chats.tsx` — **7.5 → 8.0**
- **Scores now:** Function 8.5 · States 8 · UI 7.5 · A11y 8 · Security 8.5 · Code 7 (mean 7.92)
- **Original items:**
  1. ✅ `chatName` is passed from the chat menu (`components/chat/useChatMenu.ts:240`). The screen uses it as a fallback (`app/app-lock-chats.tsx:245`, `:259`).
  2. ◐ `'#FFF'` is gone (`c.bubbleOutText`, `:182-183`, `:687`). The `rgba(0,0,0,0.7)` scrim remains (`:619`).
  3. ✅ Chips, Cancel, the CTA and back have `minHeight: 44` (`:639`, `:668`, `:678`, `:683`).
  4. ✅ `loadChats` is a `useCallback` with no eslint-disable (`:246-261`). A `mounted` ref guards the async setters (`:241-242`). `icon` is typed (`:52-58`).
  5. ✅ `LockConfigModal` is a module-level component (`:69-193`, used at `:478-489`).
- **Regressions:** none.
- **Subscreens:** Lock config modal — 7.5 → 8. Remove-lock PIN prompt — 7.5 → 8.
- **Still needed for 10/10:**
  1. `toggleLock` has no in-flight guard, so a second flip during the biometric or PIN prompt starts a parallel removal (`:300-337`, `:409`).
  2. Move the inline danger and empty styles into the StyleSheet (`:452`, `:458`). Add a scrim token (`:619`).
  3. The file is still 688 lines. Memoise `renderChatItem` (`:371`), and pass the modal a state object instead of 13 props (`:69-80`).

#### `app/import-chats.tsx` — **7.5 → 7.5**
- **Scores now:** Function 8.5 · States 8.5 · UI 7.5 · A11y 8 · Security 7 · Code 6.5 (mean 7.67)
- **Original items:**
  1. ◐ The media is documented in a `ponytail:` comment (`app/import-chats.tsx:301-305`) but is still written unencrypted (`:305`). Security is unchanged at 7.
  2. ✅ `chatsErr`: `PickChat` shows "Couldn't load your chats" with Try again (`:113-114`, `:156-162`, `:418`, `:636-649`).
  3. ✅ The `runParse` body is in a try/catch. A stale parse is ignored; otherwise the error goes to 'failed' (`:205-250`). The re-parse is called with `void` (`:503`). The waImport selftest passes.
  4. ✅ `getCurrentUserAsync` and `setMeta` are now inside the `try` (`:283-291`).
  5. ◐ Colours and styles:
     - Done: `'#fff'` → `c.bubbleOutText` (`:733`), token alpha replaces the rgba (`:879-883`, `:904`), `type S` replaces `s: any` (`:607`), and the date pills are 44dp (`:895`).
     - Not done: the file is not split (906 lines), and the 2 deps warnings remain (`:186`, `:385`).
- **Regressions:** none.
- **Subscreens:** Pick chat — 7.5 → 8. Pick source — 8 → 8. Pick file — 8 → 8. Reading/matching — 7.5 → 8. Preview — 8 → 8. Importing — 8 → 8. Done — 7.5 → 7.5. Failed — 8 → 8.
- **Still needed for 10/10:**
  1. Seal imported media at rest once chat-media sealing exists (`:301-305`).
  2. Split the steps into files and fix the two deps warnings (`:186`, `:385`).
  3. `c.success + '1A'` assumes a 6-digit hex token (`:880`, `:882`, `:904`). Use an alpha helper.

#### `app/chat-backup.tsx` — **7.0 → 7.5**
- **Scores now:** Function 8 · States 8 · UI 7.5 · A11y 8 · Security 7.5 · Code 7 (mean 7.67)
- **Original items:**
  1. ✅ The restart copy is gone. "Restore complete" offers "Open chats" through `router.dismissTo('/(tabs)/chats')` (`app/chat-backup.tsx:173-178`). `dismissTo` exists in the installed expo-router 6. The Chats tab re-reads on focus (`app/(tabs)/chats.tsx:147`). Device behaviour is **not verifiable statically**.
  2. ✅ The E2EE and Google rows have role, label and state (`:290-299`, `:318-324`). The modal buttons are 44dp (`:439`). Restore is 44dp (`:272`).
  3. ◐ `'#fff'` → `c.bubbleOutText` (`:269`, `:418`). The `rgba(0,0,0,0.5)` scrim is kept with a comment (`:428-429`).
  4. ✅ A `mounted` ref guards every setter, and `refresh` is a stable `useCallback` (`:68-81`).
- **Regressions:** none.
- **Subscreens:** Backup secret modal — 7 → 8. Restore confirm — 7 → 7.5.
- **Still needed for 10/10:**
  1. The 64-digit key input is plain multiline text (`:372-374`). Offer a masked or secure mode, or at least `importantForAutofill="no"`.
  2. Remove `console.warn` and `(e as any)` from `onBackUp` (`:121`). Move inline styles into the sheet (`:228`, `:272`).
  3. Add a scrim token (`:429`).

#### `app/backup-e2ee.tsx` — **7.5 → 8.0**
- **Scores now:** Function 7.5 · States 8.5 · UI 8 · A11y 8 · Security 7.5 · Code 7.5 (mean 7.83)
- **Original items:**
  1. ✅ "I'VE SAVED IT" asks for 2 random 4-character groups (`app/backup-e2ee.tsx:40-55`, `:186-225`, `:256`, `lib/recoveryKeyCheck.ts:16-28`). The groups match the displayed grouping (`lib/backupCrypto.ts:92-94`). A match clears the key and goes to 'on'. "Show the key again" is available (`:218-221`). The selftest passes.
     - The header back still leaves after the "Saved it?" alert and skips the check (`:153`). This is a stated decision, not a defect.
  2. ❌ There is still no "Change password" or "Switch to key" on 'on' (`:302-326`). The lib handoff is not done: `enableE2EEBackup` still deletes the secret on a failed upload (`lib/cloudBackup.ts:155-163`).
  3. ✅ The password stage is in `KeyboardSafe` (`:260-298`).
  4. ✅ `c.bubbleOutText` and `c.danger` are used with no fallbacks (`:383`, `:386-387`). Headers have roles.
- **Regressions:** none.
- **New finding (existed before round 3, in the lib):** a failed Turn off leaves the screen saying "On" while the device has already reverted to account mode.
  - `disableE2EEBackup` deletes the secret before uploading (`lib/cloudBackup.ts:169-173`). The screen keeps `stage === 'on'` on error (`:128-142`).
  - So the next scheduled backup is written server-readable while the UI still says it is encrypted.
- **Subscreens:** Loading — 7 → 7. Error — 7.5 → 8. Off — 7.5 → 8. Create password — 7.5 → 8. Key shown once — 7 → 8. Key check (new) — 8. On — 7.5 → 7.5.
- **Still needed for 10/10:**
  1. Fix the two lib rollbacks:
     - `disableE2EEBackup` should upload with the account key before deleting the secret, or restore it on failure (`lib/cloudBackup.ts:169-173`).
     - `enableE2EEBackup` should restore the previous secret and header instead of deleting them (`:155-163`).
  2. After those fixes, add "Change password" and "Switch to key" to the 'on' stage (`:302-326`).
  3. The copy says "64-digit" for a hex key that includes letters (`:310`, `:383`). Say "64-character". Give `secondaryBtn` and `dangerBtn` a `minHeight` (`:384`, `:386`).

---

### D — Groups & Communities — re-rating (round 3)

Base `b8c8bd2` → `HEAD` (`c28d1b2`). Fix log checked: `fixes/ZD.md`. Each claim was checked against `git diff b8c8bd2 HEAD` and the current files, and none was accepted on the log's word alone. The baselines ("Old" and open items) are:
- `rerate2/X3.md` for communities and group-calendar.
- `rerate/D.md` for the other 12 screens it covers.
- The original D section of `2026-10-04_screen_ratings.md` for group-chat, group-create, group-invitations and group-join.

Helpers read: `lib/groups/opThread.ts` (new), `components/groups/ThreadGaps.tsx` (new), and the diffs of `lib/groups/{calendar,catalog,taskReminders,tripSession}.ts`, `lib/privacyPrefs.ts`, `lib/family/historyGate.ts` and `components/finance/useDatePicker.tsx`.

**Checks run (read-only, at HEAD):**
- `npx tsc --noEmit -p .` exits 0.
- `npx eslint` on the 18 screens, `lib/groups` and `components/groups` exits 0, with 0 warnings.
- These selftests all exit 0:
  - `lib/orphanRoutes` (51 assertions, including "/group-chat …" and "/creator-channels is reached only from nowhere")
  - `lib/screenBackCoverage`
  - `lib/a11yCoverage`
  - `lib/themeCoverage`
  - `lib/uiDebtRatchet` ("no file got worse")
  - `lib/groupRefRouting`
  - `lib/groups/{eventReminderPrivacy, groupScreenFixes, groupScreensRound3}`
  - the self-checks in `lib/groups/calendar.ts` and `catalog.ts`

The fix log's note that orphanRoutes fails no longer applies: it passes at HEAD.

**Server facts used** (from the repo's `vaultchat-backend-go`, which is not deployed):
- The page cap is 200 (`internal/routes/chats.go:46`, applied at `chats_helpers.go:1128-1129`).
- The trip TTL is 8 h (`space_trips.go:29`), and it matches `lib/groups/trips.ts:206`.
- The membership 409 messages that group-join matches are at `chats_membership.go:866, 909`.

**Nothing here is device-verified or deployed.** Items marked 📱 need a device check.

| Screen | Old | New | Δ |
|---|---|---|---|
| `app/group-admin.tsx` | 6.0 | 7.5 | +1.5 |
| `app/group-calendar.tsx` | 7.0 | 8.0 | +1.0 |
| `app/group-chat.tsx` (redirect) | 4.0 | 9.5 | +5.5 |
| `app/group-create.tsx` | 7.0 | 8.0 | +1.0 |
| `app/group-info.tsx` | 7.0 | 7.5 | +0.5 |
| `app/group-insights.tsx` | 6.5 | 7.5 | +1.0 |
| `app/group-invitations.tsx` | 7.0 | 8.0 | +1.0 |
| `app/group-invites.tsx` | 7.0 | 8.0 | +1.0 |
| `app/group-join.tsx` | 7.0 | 8.0 | +1.0 |
| `app/group-members.tsx` | 7.5 | 8.0 | +0.5 |
| `app/group-notes.tsx` | 7.0 | 7.5 | +0.5 |
| `app/group-privacy.tsx` | 7.5 | 8.0 | +0.5 |
| `app/group-tasks.tsx` | 7.5 | 8.0 | +0.5 |
| `app/group-trip.tsx` | 7.5 | 8.0 | +0.5 |
| `app/group-calls.tsx` | 7.0 | 8.0 | +1.0 |
| `app/create-group.tsx` | 7.0 | 8.0 | +1.0 |
| `app/communities.tsx` | 6.5 | 7.0 | +0.5 |
| `app/creator-channels.tsx` (redirect) | 4.5 | 10 | +5.5 |

#### Cross-screen items
- **Duplicated op-log reader (notes/tasks):** ✅ One reader, `lib/groups/opThread.ts:53-105`. It pages with `before=` at the real server cap (`:22`, `:61-75`), counts unreadable messages (`:82-83`) and keeps the sender check (`:88`). Both screens use it (`app/group-notes.tsx:61`, `app/group-tasks.tsx:72`). The `ponytail:` stop at 10 pages is documented with a replacement condition (`opThread.ts:23-31`).
- **Invite-link copy contradiction:** ✅ The group-invites footer (`app/group-invites.tsx:391-395`) and header (`:4-9`) now agree with group-info's "Invite links" row (`app/group-info.tsx:557-562`).
- **Two approval systems:** ◐ Still two server queues, now labelled and cross-linked:
  - The comment at `app/group-admin.tsx:11-19` explains both.
  - The toggle is "Approve invite-link joins" (`:355-358`).
  - A link to "How people join" (`:361-373`).
  - The merge needs backend work, which is logged in ZD as a handoff.
- **Redirect shims:** ✅ Both are `<Redirect>`, and their `INSET_SCREENS` entries were removed (`app/_layout.tsx:212-216` in the diff).
- **Calendar reminder privacy:** ✅ `setNotifPreview` now calls `hideBookedEventReminderTitles()` (`lib/privacyPrefs.ts:90-95`), which rewrites booked titles in every group at once (`lib/groups/taskReminders.ts:170-197`). 📱
- **Two creation UIs:** ◐ The split is documented (`app/create-group.tsx:9-13`, `app/group-create.tsx:12-14`). They are not merged; the log calls this a product decision.

---

#### `app/group-admin.tsx` — **6.0 → 7.5**
- **Scores now:** Function 7.5 · States 7 · UI 7.5 · A11y 7.5 · Security 7.5 · Code 7 (mean 7.33)
- **Previous "Still needed" items:**
  1. ◐ **Approval systems.** These are not merged because the server has two doors. Each setting is now named for the door it guards, and the two screens link to each other (`:11-19`, `:355-373`).
  2. ✅ **Switches labelled** (`:358`, `:380`).
  3. ✅ **Chips are radios** with selected/checked, inside radiogroups (`:69-75`, `:333-341`).
  4. ✅ **Remove is un-nested.** The row is a View holding two sibling touchables (`:432-456`). 📱 TalkBack/VoiceOver.
  5. ✅ **`PolicyToggle` hoisted** to module scope (`:66-82`). It is used for all three policies (`:330`, `:348`, `:351`).
  6. ✅ **Banner timer.** There is one ref'd timer, cleared on unmount (`:114-120`).
  7. ✅ **Aurora and keyboard.** `<AuroraBackground/>` is in the main view, inside `KeyboardSafe` (`:275-276`), and `keyboardShouldPersistTaps` is set (`:293`).
  8. ✅ **`'#888'` gone.** `thumbColor` uses `colors.textFaint` (`:359`, `:381`).
  9. ✅ **Group Info hidden while `loadFailed`** (`:294-296`). Join-request failures get their own Retry (`:110-111`, `:392-395`).
- **Regressions:** none.
- **Subscreens:**
  - Role menu: 7.5 → 7.5
  - Remove confirm: 7.5 → 7.5
  - Link join requests list: 6 → 7.5 (error/Retry, roles)
- **Still needed for 10/10:**
  1. Merge the approval queues once the backend writes link joins into `chat_invitations` (ZD backend handoff 1).
  2. Back has no `accessibilityRole` (`:280`). It is the file's one entry in `lib/uiDebtRatchet.baseline.json` (`unroled: 1`).
  3. Policy, slow-mode and switch changes have no in-flight guard. Two quick taps race on the captured `prev` (`:175-214`).
  4. A missing `chatId` renders "No members." instead of a not-found state (`:129`, `:418-420`).
  5. Reject has no confirmation (`:222-226`, `:404`).
  6. Members render through `.map` in a ScrollView (`:421`). Use a FlatList for large groups.

#### `app/group-calendar.tsx` — **7.0 → 8.0**
- **Scores now:** Function 8.5 · States 8 · UI 7.5 · A11y 8 · Security 8 · Code 7.5 (mean 7.92)
- **X3 "Still needed" items:**
  1. ✅ **Real date/time picker.**
     - A "Starts …" row opens `useDatePicker` in datetime mode (`:362-369`).
     - The day and hour chips are shortcuts over one `start` (`:371-398`, `lib/groups/calendar.ts:236-257`).
     - 📱 picker.
  2. ✅ **Edit flow.**
     - Tapping your own event opens a prefilled sheet (`:198-202`), which saves through `updateGroupEvent` (PATCH, `:222`; `lib/chatService.ts:2259-2265`).
     - A repeating event is edited as a series, and the sheet says so (`:413-417`).
  3. ✅ **Visible delete and roles.**
     - The trash button (`:494-499`) is backed by an accessibility action (`:475-476`).
     - Rows are `button` or `text` depending on `canEdit` (`:472`).
  4. ✅ **Delete gating.** `eventActions` (`lib/groups/calendar.ts:270-283`) mirrors the server rule `calMayEdit`; I did not read the Go code, and the comment states the rule. It is fed by `getChat` (`:159-163`). Edit is author-only, for the documented sender-key reason (`calendar.ts:262-268`).
  5. ✅ **Undecryptable events counted** (`:72-92`). They are shown in the list and in the empty state (`:304`, `:330`, `:504-514`).
  6. ✅ **Refresh-failed banner** over the rows (`:308-315`).
  7. ✅ **Reminder titles re-synced** when the preference changes (`lib/privacyPrefs.ts:90-95` → `taskReminders.ts:170-197`). It only tightens, as documented. 📱
- **Regressions:**
  - The picker's iOS sheet is a `<Modal>` rendered inside the composer `<Modal>` (`:426` inside `:337`). Nested RN modals on iOS are a known presentation risk. 📱 Not verifiable statically.
  - The iOS sheet uses the finance theme (`components/finance/useDatePicker.tsx:23, 60-70`), so it differs visually from the group screens.
- **Subscreens:** Event sheet (new + edit): 7 → 8.
- **Still needed for 10/10:**
  1. **Cache-id collision.** Event row ids share the decrypt-cache slot with chat messages of the same id (`ponytail:` at `:78-81`). This needs the `decryptFromChat` cache namespace handoff; `lib/chatService.ts` is unchanged there.
  2. Device-check the nested picker modal on iOS (`:426`), and consider moving `useDatePicker` out of `components/finance`.
  3. An admin cannot edit another member's event until the server records `updated_by` (ZD backend handoff 4).
  4. A missing `groupId` shows "Nothing this month" instead of a not-found state (`:138`, `:297-305`).
  5. On every focus and save, `syncReminders` decrypts the reminder horizon a second time (`:99-103`, `:165`, `:229`).

#### `app/group-chat.tsx` — **4.0 → 9.5** (rated as a redirect)
- **Scores now:** Function 9.5 · States 10 · UI 10 · A11y 10 · Security 9.5 · Code 9 (mean 9.67)
- **Original items:**
  1. ✅ It is kept as a deep-link alias, not deleted, which the brief accepts. The `INSET_SCREENS` entry is gone (the `app/_layout.tsx` diff). `lib/orphanRoutes.selftest.ts:142` pins "no callers".
  2. ✅ **Redirect behaviour.** It is now `<Redirect>` (`:18-19`):
     - Nothing is rendered, so there is no spinner to label and no effect deps.
     - `chatId ?? id` maps to `/chat?id=` (`:17`, `:19`), which is what `/chat` reads (`app/chat.tsx:168-195`).
     - A link without an id lands on `/(tabs)/chats` rather than a Back with nowhere to go (`:18`).
- **Regressions:** none.
- **Subscreens:** none.
- **Still needed for 10/10:**
  1. `name` is forwarded (`:19`), but `/chat` never reads it: its params are id, chatId and captured* only (`app/chat.tsx:168-172`). Drop it, so the group name does not ride in route history.
  2. The `as any` casts are probably unnecessary (`:18-19`); `app/filevault.tsx:16` redirects without one.

#### `app/group-create.tsx` — **7.0 → 8.0**
- **Scores now:** Function 8 · States 7.5 · UI 8 · A11y 8 · Security 7.5 · Code 8 (mean 7.83)
- **Original items:**
  1. ✅ **Radios.** Type cells, swatches, icons and privacy rows are radios with selected/checked (`:119`, `:153-154`, `:164-165`, `:180`). Swatches are named (`:35-39`), and Create has role/state (`:192-193`).
  2. ◐ **Not merged with `create-group`.** The split is documented (`:12-14`).
  3. ✅ **`Platform` import removed** (`:18-21`).
  4. n/a **Registry self-heal.** ZD says family.tsx adopts typed groups the registry lacks. I did not re-verify this; it is outside these files.
- **Regressions:** none.
- **Subscreens:** Type/colour/icon/privacy pickers: 6.5 → 8.
- **Still needed for 10/10:**
  1. Wrap each picker group in a `radiogroup`, and give the section labels `accessibilityRole="header"` (`:111`, `:150`, `:161`, `:172`).
  2. If `saveGroup`/`setActiveGroupId` threw after the server create (`:82-86`), the catch would say "Could not create group" (`:90`) although the group exists. Retrying would then make a duplicate. Separate the two failures.
  3. Product: merge the two creation UIs, or keep the documented split.

#### `app/group-info.tsx` — **7.0 → 7.5**
- **Scores now:** Function 8.5 · States 7.5 · UI 7.5 · A11y 7.5 · Security 7.5 · Code 7 (mean 7.58)
- **Previous "Still needed" items:**
  1. ✅ **`KeyboardSafe` root** (`:594`).
  2. ✅ **One FlatList.**
     - The header is `ListHeaderComponent` and Leave is the footer (`:596-622`).
     - There is an empty-search message (`:616`).
  3. ✅ **Link policy.** The row sub-text matches group-invites (`:561-562`).
  4. ✅ **Tokens and Aurora.**
     - `AppText` is used (`:51`).
     - Aurora is in the main, loading and error views (`:288`, `:305`, `:321`, `:595`).
     - The presence dot uses `c.online` (`:730`).
  5. ✅ **Dead styles** `backTxt`/`navChevron` removed (`:684-739`).
  6. ✅ **No-id "Go back"** has a role (`:295`).
- **Regressions:** none.
- **Subscreens:**
  - Rename: 7.5 → 7.5
  - Description: 7 → 7.5 (now has keyboard handling)
  - Leave confirm: 7 → 7
  - Remove confirm: 7.5 → 7.5
- **Still needed for 10/10:**
  1. A refresh failure over a painted cache is silent (`:127-131`). Add a stale/Retry indicator.
  2. The Remove pill is about 26 dp tall with no `hitSlop` (`:675`, `:734`).
  3. The member sub-line shows the raw role key (`:669`). Use `ROLE_LABELS` as group-admin/members do.
  4. To show 9 thumbnails, the media strip reads 200 server and 400 local messages (`:147-150`).
  5. At 739 lines, the file could be split. The `header` element alone spans `:341-591`.

#### `app/group-insights.tsx` — **6.5 → 7.5**
- **Scores now:** Function 7.5 · States 8 · UI 7.5 · A11y 7 · Security 8.5 · Code 7 (mean 7.58)
- **Previous "Still needed" items:**
  1. ✅ **Real `failed` state.** It reads "This is not an empty week" with Retry (`:57-58`, `:142-145`, `:209-220`). The identity message is kept for no-identity only (`:238-259`).
  2. ✅ **Tabs.** `tablist`/`tab` with selected state (`:178`, `:197`).
  3. ✅ **Fetch claim corrected** (`:3-6`, `:121-123`, `:325-332`).
  4. ✅ **`useMemo` for `repeatDestinations`** (`:159-162`).
  5. ✅ **Avatar palette.** It uses the shared `<Avatar ring>` (`:273`).
  6. ✅ **Lint.** A commented disable for the deliberate trigger (`:149-151`); eslint is clean.
- **Additional (handoff):**
  - ✅ **Unknown permission is no longer guessed.** `groupWithHistoryAccess` asks the server, or throws into `failed` (`:92`; `lib/family/historyGate.ts:18-33`).
  - The gate withholds on `'denied'` only (`:94`), per the HEAD commit 2a0b220.
- **Regressions:** none.
- **Subscreens:** Week/Month tabs: 6 → 7.5.
- **Still needed for 10/10:**
  1. `getMessages(groupId, { limit: 300 })` (`:126`) is capped at 200 by the server (`chats.go:46`). This is the same bug ZD found and fixed for notes/tasks. Reuse paging so a month's trips are not cut off.
  2. A missing `groupId` ends on "Nothing recorded yet" (`:79`, `:263-268`) instead of a not-found state.
  3. Stats and member rows are separate text nodes (`:165-170`, `:271-290`). Group each row for screen readers.

#### `app/group-invitations.tsx` — **7.0 → 8.0**
- **Scores now:** Function 8 · States 8.5 · UI 8 · A11y 7.5 · Security 8.5 · Code 7.5 (mean 8.0)
- **Original items:**
  1. ✅ **Load failure.** A `failed` state shows an error screen with Retry (`:199-210`), or a banner over the list (`:221-228`).
  2. ✅ **Decline guard** `if (acting) return` (`:100`).
  3. ✅ **Roles.** Accept and Decline have role and label (`:158-159`, `:176-177`). "Waiting" is exposed as text (`:169-170`).
  4. ✅ **FlatList** with RefreshControl, empty state and footer (`:212-249`).
- **Additional:** ✅ The server icon/colour are validated (`:113-114`; `lib/groups/catalog.ts` `hexColorOr`).
- **Regressions:** none.
- **Subscreens:**
  - Decline/withdraw confirm: 7 → 7.5
  - Waiting alert: 7 → 7
- **Still needed for 10/10:**
  1. White text sits on a server-chosen accent (`:158-161`). A valid `#RRGGBB` can still be too light for contrast.
  2. Accepting with `joined` always pushes `/family` (`:77`), even for a group whose type is not a Family Space. 📱
  3. Group each card's text for screen readers (`:119-150`).

#### `app/group-invites.tsx` — **7.0 → 8.0**
- **Scores now:** Function 8.5 · States 8 · UI 8 · A11y 7.5 · Security 7.5 · Code 7.5 (mean 7.83)
- **Previous "Still needed" items:**
  1. ✅ **Search error.** `searchFailed` shows its own row (`:76-77`, `:118-119`, `:253-260`).
  2. ✅ **Link policy.** The footer and header now agree with `/invite-link` (`:4-9`, `:391-395`).
  3. ✅ **Resend busy guard** (`:86-87`, `:169-175`, `:375-381`).
  4. ✅ **Refresh failures.** A Retry row shows when either half rejects (`:99`, `:300-306`).
  5. ✅ **Pills have roles**, plus label, busy state and `hitSlop` (`:284-287`, `:336-337`).
- **Regressions:** none.
- **Subscreens:**
  - Turn-down confirm: 7 → 7
  - Withdraw/revoke confirm: 7 → 7
- **Still needed for 10/10:**
  1. The turn-down confirm lacks the `if (acting) return` guard that approve has (`:159-160` vs `:146`). Withdraw/revoke has no busy state (`:187-192`).
  2. A missing `chatId` has no not-found state. Search still calls `inviteCandidates('')` (`:90`, `:116`).
  3. The "Waiting" and "Sent" headings have no `accessibilityRole="header"` (`:310`, `:353`).

#### `app/group-join.tsx` — **7.0 → 8.0**
- **Scores now:** Function 8 · States 8 · UI 8 · A11y 8 · Security 8.5 · Code 8 (mean 8.08)
- **Original items:**
  1. ✅ **Invited users.** They get an `'invited'` state with "Open invitations" (`:32`, `:63`, `:129-142`).
  2. ◐ **Duplicate detection.** It now matches error text only on HTTP 409 (`:86-87`; `err.status` is set at `lib/api.ts:613`). There is a `ponytail:` note, and the strings match the server (`chats_membership.go:866, 909`). A structured code needs the backend.
  3. ✅ **Missing `groupId`.** A "Group not found" state (`:93-102`), and `ask` is guarded (`:76`).
  4. ✅ **Icon and colour validated** (`:48-50`).
  5. ✅ **Buttons have role/state** (`:157-160`, `:170`).
- **Regressions:** none.
- **Subscreens:** none.
- **Still needed for 10/10:**
  1. Use a structured 409 error code (ZD backend handoff 2) in place of `:86-87`.
  2. A row the user already accepted (`status: 'accepted'`, not `requested`) is shown as "Answer it in your invitations" (`:63`, `:134`). The invitations screen then shows "Waiting". Branch on status.
  3. White text sits on a param-supplied accent (`:139-140`, `:161-164`). Check contrast.

#### `app/group-members.tsx` — **7.5 → 8.0**
- **Scores now:** Function 8 · States 8 · UI 8 · A11y 8 · Security 8 · Code 7.5 (mean 7.92)
- **Previous "Still needed" items:**
  1. ✅ **Share picker states.** `chatsState` covers loading, failed with Retry, and ok (`:81-82`, `:165-170`, `:368-377`). Rows read "Share in X" (`:379-381`).
  2. ✅ **Refresh-failed banner** (`:275-282`).
  3. ✅ **`MemberSheet` extracted** (`:421-496`).
  4. ✅ **`roleTone` uses theme tokens** (`:49-52`, `:470`).
  5. ✅ **Close buttons and backdrops have roles** (`:359`, `:389`, `:400`, `:490`).
  6. ◐ **Approval merge** is blocked on the backend.
- **Regressions:** none.
- **Subscreens:**
  - Member actions sheet: 8 → 8.5
  - Share picker: 5.5 → 7.5
  - Join-mode list: 7.5 → 7.5
- **Still needed for 10/10:**
  1. Merge the approval queues (backend).
  2. A missing `groupId` renders "0 members" (`:85`, `:283-286`). Add a not-found state.
  3. The share picker maps every chat in a ScrollView (`:367-388`). Use a FlatList.
  4. Add a busy/double-tap guard on `doShare` (`:178-181`).

#### `app/group-notes.tsx` — **7.0 → 7.5**
- **Scores now:** Function 8 · States 8 · UI 7.5 · A11y 7 · Security 7.5 · Code 7.5 (mean 7.58)
- **Previous "Still needed" items:**
  1. ✅ **The 400-message window is replaced** by paged reads at the real 200 cap, plus 2,000 messages of local history (`:61`; `opThread.ts:61-79`).
  2. ✅ **Fold extracted.** The reader is shared, and the folds stay per type (`opThread.ts:4-7`).
  3. ◐ **Who may delete.** Kept as shared-edit, with a confirm (`:135-141`). The log records this as a decision.
  4. ✅ **Refresh-failed banner** (`:179-186`).
  5. ✅ **Undecryptable ops and partial reads** are shown (`:209`; `ThreadGaps.tsx:118-139`).
- **Additional:** ✅ Roles, `hitSlop` 12 and input labels (`:195`, `:228`, `:235`, `:239`). The backdrop is labelled (`:220-221`).
- **Regressions:** none new. Still open:
  - The pin button is a touchable nested inside the card touchable (`:188-197`). This is the merge problem group-admin's own comment describes (`app/group-admin.tsx:432-434`): on iOS the accessible card hides Pin from VoiceOver. 📱
  - Banner Retry sets `loading`, which swaps the whole list for a spinner (`:181`, `:158`).
- **Subscreens:** Note editor: 7.5 → 8.
- **Still needed for 10/10:**
  1. Un-nest Pin from the card, or expose it as an `accessibilityActions` entry (`:188-197`).
  2. Refresh with the list kept on screen, not a full-screen spinner (`:181`).
  3. Each focus may decrypt up to about 2,200 messages (`opThread.ts:31-33`). Replace this with a server op index or a local fold snapshot, as the `ponytail:` note says.
  4. A missing `groupId` shows "No notes yet" (`:58`, `:169-176`).

#### `app/group-privacy.tsx` — **7.5 → 8.0**
- **Scores now:** Function 8.5 · States 8 · UI 8 · A11y 7.5 · Security 8.5 · Code 8 (mean 8.08)
- **Previous "Still needed" items:**
  1. ✅ **A `now` tick** every 30 s while a timer is set (`:59-65`). It drives the summary and chips (`:141`, `:217-219`). After expiry, the screen says "Sharing stopped at …" (`:229-233`).
  2. ✅ **`reloadPrivacy` failure** shows "Saved, not applied yet" (`:91-96`).
  3. n/a **An unknown but present id** shows defaults. The log argues this is the true state; that is accepted, and a missing id is handled (`:102-111`).
- **Regressions:** none. Nit: the interval keeps ticking after expiry until `sharingUntil` changes (`:62-64`).
- **Subscreens:** Stop-timer confirm: 7.5 → 7.5.
- **Still needed for 10/10:**
  1. No in-flight guard on `patch`. Rapid toggles each read and merge the stored value concurrently (`:79-97`; `lib/groups/store.ts:325`).
  2. Only "Location" is a header (`:152`). "Details", "Invisible" and "Share for a while" are not (`:172`, `:198`, `:212`). The chips have no radiogroup.
  3. The first load has no try/catch (`:71`). It relies on `readJSON` never throwing.

#### `app/group-tasks.tsx` — **7.5 → 8.0**
- **Scores now:** Function 8 · States 8.5 · UI 8 · A11y 8 · Security 7.5 · Code 8 (mean 8.0)
- **Previous "Still needed" items:**
  1. ✅ **Paged read** (`:72`).
  2. ✅ **Shared reader** (`opThread.ts`).
  3. ◐ **Delete rule** kept as shared-edit, by decision (`:143-149`).
  4. ✅ **Refresh-failed banner** (`:234-241`).
- **Additional:** ✅ Labels and `hitSlop` (`:168`, `:173`, `:248`, `:272`). Gaps are shown (`:278`).
- **Regressions:** none.
- **Subscreens:** Due-date and assignee chips: 8 → 8.
- **Still needed for 10/10:**
  1. Same per-focus decrypt cost as notes (`opThread.ts:31-33`).
  2. A missing `groupId` shows "Nothing yet" (`:69`, `:228-232`).
  3. Section heading with `accessibilityRole="header"` (`:217`), and radiogroup wrappers for the chips (`:182`, `:194`).

#### `app/group-trip.tsx` — **7.5 → 8.0**
- **Scores now:** Function 8 · States 8 · UI 8 · A11y 7.5 · Security 7.5 · Code 7.5 (mean 7.75)
- **Previous "Still needed" items:**
  1. ✅ **"Group not found" state** (`:191-200`).
  2. ✅ **Server end failure.** `endTrip` returns `{confirmed}` (`lib/groups/tripSession.ts:453-469`). On false, the screen says it ended on this phone only, for up to 8 h (`:173-178`). The TTL matches the server.
  3. ✅ **Destination input labelled** (`:217`).
  4. ✅ **Location permission** is checked and requested before `geocodeAsync`, with `permissionDenied` (`:122-127`). 📱
- **Regressions:** none.
- **Subscreens:** Leave/End confirms: 7.5 → 8.
- **Still needed for 10/10:**
  1. Navigate/join, Leave and End have no busy or double-tap guard (`:146-183`).
  2. Participant rows are three separate text nodes (`:295-313`). Give each one label.
  3. The `currentTrip()` initial state can belong to another group (`:53`). Filter it by `groupId`.

#### `app/group-calls.tsx` — **7.0 → 8.0**
- **Scores now:** Function 8.5 · States 8 · UI 7.5 · A11y 8 · Security 7.5 · Code 7.5 (mean 7.83)
- **Previous "Still needed" items:**
  1. ✅ **1:1 calls use the direct chat.** `createDirectChat({userId})` runs first (`:79-91`), matching voicecall's params (`app/voicecall.tsx:87-89`). There is a per-row busy guard and an alert. 📱
  2. ✅ **Legacy ring failure.** It sets `rang=false`, which shows "Members were not rung" (`:106-115`, `:131-134`).
  3. ✅ **`AppText`** (`:32`).
  4. ✅ **`starting` is reset** if the push throws (`:126-129`).
- **Regressions:** none.
- **Subscreens:** Voice/Video toggle: 8 → 8.5 (radiogroup at `:149`).
- **Still needed for 10/10:**
  1. A missing `chatId` reads "Couldn't load the group's members" (`:63`, `:67`). Add a not-found state.
  2. `starting` clears only on the next focus (`:56-57`). If the call screen fails to mount, the button stays inert until then.
  3. White text sits on primary (`:153`, `:227`, `:230`). It is fine on brand colours. Device-verify calls. 📱

#### `app/create-group.tsx` — **7.0 → 8.0**
- **Scores now:** Function 8 · States 8 · UI 8 · A11y 8 · Security 8 · Code 7.5 (mean 7.92)
- **Previous "Still needed" items:**
  1. ✅ **Keyboard.** `KeyboardSafe keyboardOnly` (`:144`). The list is `flex:1` and the Create bar is in normal flow (`:192`, `:220`). The gesture inset is dropped while the keyboard is up (`:55`, `:220`). 📱
  2. ✅ **`errorBar`** uses `c.danger` + alpha (`:251`).
  3. ✅ **Inputs labelled** (`:163`, `:185`).
  4. ✅ **The partial-invite alert names who was not invited** (`:114-122`).
  5. ◐ **UI merge.** The split is documented (`:9-13`), by decision.
- **Regressions:** none.
- **Subscreens:** Selected-member chips: 8 → 8.
- **Still needed for 10/10:**
  1. Only direct-chat peers can be picked (`:65-75`). There is no search for other accounts, which group-invites has.
  2. A group cannot be created with nobody picked (`:101`), while group-create allows that.
  3. Product decision on the two creation UIs.

#### `app/communities.tsx` — **6.5 → 7.0**
- **Scores now:** Function 6.5 · States 8 · UI 7.5 · A11y 7.5 · Security 6 · Code 7 (mean 7.08)
- **X3 "Still needed" items:**
  1. ❌ **Leave, edit, delete and add-existing-group.** These are blocked: the server has only create, list, get and create-group (ZD backend handoff 3).
  2. ✅ **`openCommunity`.**
     - The cache read is inside the try (`:70-73`).
     - An `openSeq` guard protects every write (`:42`, `:68`, `:74`, `:78`, `:82-84`).
     - Header Back and hardware Back invalidate in-flight opens (`:63`, `:119`).
  3. ✅ **Modal inputs labelled** (`:227`, `:229`).
  4. ✅ **Error-bar retry** shows a spinner and busy/disabled state, with a re-entry guard (`:39-40`, `:87-91`, `:175-181`).
- **Regressions:** none.
- **Subscreens:**
  - Community detail: 7 → 7
  - Name modal: 7 → 7.5
- **Still needed for 10/10:**
  1. Community management (backend first).
  2. Detail painted from cache gives no sign when the network refresh fails (`:81-82` alerts only when there was no cache).
  3. `nameModal` is a function declared after the component's returns (`:220-242`), and two full views share one component. Extract both.
  4. The empty-state CTA has no label beyond its text, and there is no tap-outside-to-dismiss on the modal (`:197`, `:224`). These are minor.

#### `app/creator-channels.tsx` — **4.5 → 10** (rated as a redirect)
- **Scores now:** Function 10 · States 10 · UI 10 · A11y 10 · Security 10 · Code 9 (mean 9.83)
- **Previous items:**
  1. ✅ It is kept as an alias. `INSET_SCREENS` entry removed (the `app/_layout.tsx` diff), and it is guarded by `lib/orphanRoutes.selftest.ts:144`.
  2. ✅ **Redirect behaviour.** It is now a bare `<Redirect href="/broadcast">` (`:36-38`), the same pattern as `app/filevault.tsx:15-17`:
     - Instant, with nothing rendered.
     - No side effects.
     - The target is real (`app/broadcast.tsx` exists).
- **Regressions:** none.
- **Subscreens:** none.
- **Still needed for 10/10:** nothing meaningful. Nit: the `as any` cast (`:37`) is probably unnecessary under typed routes (compare `app/filevault.tsx:16`).

---

### E+K — Calls, Live, Network + Utilities, Comfort, Games — round-3 re-rating

| Screen | Old | New | Δ |
|---|---|---|---|
| `app/voicecall.tsx` | 7.0 | 7.5 | +0.5 |
| `app/videocall.tsx` | 6.5 | 7.0 | +0.5 |
| `app/incoming-call.tsx` | 7.5 | 8.0 | +0.5 |
| `app/group-call-active.tsx` | 7.0 | 7.5 | +0.5 |
| `app/call-reliability.tsx` | 6.5 | 7.5 | +1.0 |
| `app/network-test.tsx` | 7.0 | 7.5 | +0.5 |
| `app/live.tsx` | 7.0 | 8.0 | +1.0 |
| `app/live-view.tsx` | 7.0 | 7.5 | +0.5 |
| `app/live/join/[code].tsx` | 7.0 | 8.0 | +1.0 |
| `app/notifications.tsx` | 7.0 | 7.5 | +0.5 |
| `app/notification-sounds.tsx` | 7.5 | 8.0 | +0.5 |
| `app/storage-manager.tsx` | 7.0 | 8.0 | +1.0 |
| `app/cache-cleanup.tsx` | 8.0 | 8.5 | +0.5 |
| `app/offline-mode.tsx` | 8.0 | 8.5 | +0.5 |
| `app/vision-comfort.tsx` | 8.0 | 8.5 | +0.5 |
| `app/eye-check.tsx` | 8.0 | 8.5 | +0.5 |
| `app/perf-debug.tsx` | 8.0 | 8.5 | +0.5 |
| `app/dashboard.tsx` | 7.0 | 7.5 | +0.5 |
| `app/games.tsx` (+ boards/sheets) | 7.5 | 8.0 | +0.5 |

**Method and evidence**
- I am an independent reviewer and this review was read-only. For every screen I read `git diff b8c8bd2 HEAD -- <file>`, the new helpers it now uses, and the current code around each claim. The helpers are `components/call/inviteResult.ts`, `lib/golive/hostPasscodeMemo.ts`, `components/SafetyNavBar.tsx`, `lib/outboxSummary.ts`, `lib/sounds.ts`, `lib/games/{useQuickMatch,useLiveTables,startHint,pieceNames,origin}.ts`, and the Chess, Rummy, Ludo, TicTacToe and rules diffs.
- I checked every claim in `fixes/ZE.md` and `fixes/ZK.md`.
- Open items come from the latest list for each screen: `rerate2/X2.md` for storage-manager and live-view, the original sections of `2026-10-04_screen_ratings.md` for call-reliability, live, live/join, vision-comfort, eye-check and perf-debug, and `rerate/EK.md` for the rest.
- The overall score is the mean of the six dimension scores, rounded to the nearest 0.5, with ties rounded up. That is the same rule the earlier EK rerate used.
- Checks I ran:
  - `npx tsc --noEmit -p .` exited 0.
  - Selftests, all passing: `components/call/inviteResult` (7), `lib/call/callControls`, `lib/call/addPerson`, `lib/call/signalFailClosed`, `lib/golive/hostPasscodeMemo` (6), `lib/golive/immersiveStage`, `lib/speedTest` (5), `lib/ringtoneChoice`, `lib/outboxSummary` (9), `lib/eyeCheckModel`, `lib/visionComfort`, `lib/games/{startHint (5), liveTables, useAddBot, gamesNative, fairness}`, `lib/gamesBackCoverage` (17), `lib/a11yCoverage`, `lib/themeCoverage` (22), `lib/orphanRoutes` (51), `lib/screenBackCoverage`, `lib/responsiveLayout` (28) and `lib/uiDebtRatchet` ("no file got worse").
  - I grepped the entry points of all 19 routes. Each has at least one live caller. The chat split kept the Vision Comfort entry at `components/chat/useChatMenu.ts:156`.
- **Handoffs not landed.** Four handoffs named in the fix logs are not in HEAD. In each case the client fix only partly helps today:
  - `lib/broadcast.ts:361-366` still maps every non-403 to `invalid`.
  - `lib/call/engine.ts:949-950` still returns `targets.length` when the ring was rate-limited.
  - `services/cache/cacheManager.ts:136`, `:144` still swallow save errors.
  - There is still no `onPrimary` or `warning` palette token.
  - Two handoffs did land: the Security Hub entry at `app/settings.tsx:401`, and the nav bar now points Vault at `/vault`.
- **Nothing here is device-verified or deployed.** That covers ringing, decline delivery, safe-area layout, `beforeRemove` and Modal back handling, screen-reader activation of the live stage layer, NetInfo detection, and battery-exemption read-back. The backend reapers cited in ZE D3 are in source but not deployed.

**Regressions from round 3 in this batch**
- None are functional.
- Two test-integrity and honesty issues:
  1. `lib/call/callControls.selftest.ts:98-101` still asserts "Beauty is gone from the video call control strip (requested)". The check only passes because the button is now multi-line (`app/videocall.tsx:546-553`), and the button still exists, renamed "Tint". The test now encodes a false statement.
  2. `app/call-reliability.tsx:64` reads `isIgnoringBatteryOptimizations()`, which returns **true** when the native `VaultPower` module is missing (`lib/batteryOptimization.ts:55`). I grepped the repo, including `plugins/`, and found no `VaultPower` implementation; `android/` is not checked in. If the build lacks the module, card 1 now says "Done — crazzychat can receive a call while closed" (`:112`) without knowing. This is not verifiable statically, but the fallback is now a positive claim rather than "no warning".

---

#### `app/voicecall.tsx` — **7.0 → 7.5**
- **Scores now:** Function 8.5 · States 7.5 · UI 7 · A11y 8 · Security 7.5 · Code 5 (mean 7.25)
- **Original items:**
  - ❌ `VoiceCallLegacy` is still in the file (`app/voicecall.tsx:362`). This is deferred by the rollback flag (ZE D1).
  - ✅ The badge now uses `protectionFor(1, null)` (`:334`). The contract that null means "SFU path, fail-closed publish" is documented in `components/call/CallEncryptionBadge.tsx:47-53` and enforced by `lib/call/room.ts:666`, `:723`, `:814`.
  - ✅ Invites report their outcome via `inviteAndDescribe` (`:294`, `components/call/inviteResult.ts:13-29`; selftest 7/7). Residual: a rate-limited ring still reads "Calling X", because `engine.inviteToCall` returns `targets.length` (`lib/call/engine.ts:949-950`).
  - ✅ The add-person button has its role (`:315`), and the avatar is hidden from accessibility.
  - ✅ The reaction emoji are labelled (`components/call/CallReactions.tsx:21-23`, `:82-85`).
- **Regressions:** none.
- **Subscreens:**
  - Add-to-call sheet: 7 → 8.
  - In-call chat: 7.5 → 8 (roles, input label, send state: `components/call/CallChatSheet.tsx:85-126`).
  - Reaction picker: 6.5 → 8.
- **Still needed for 10/10:**
  1. Remove `VoiceCallLegacy` (`:362` onward) once `constants/flags.ts` CALL_ENGINE_V2 is no longer a rollback.
  2. Return the server's `rang` from `inviteToCall` (`lib/call/engine.ts:949-950`) so a rate-limited invite is not reported as "Calling".
  3. Guard the `.then(setAddSheet)` against unmount (`:294-295`).

#### `app/videocall.tsx` — **6.5 → 7.0**
- **Scores now:** Function 8 · States 7.5 · UI 7 · A11y 7.5 · Security 7.5 · Code 5 (mean 7.08)
- **Original items:**
  - ❌ `VideoCallLegacy` is still there (`:575`). It holds the file's one unroled touchable (legacy filter chip `:1055`; ratchet baseline `unroled: 1`).
  - ✅ The share banner is now inline in the inset-positioned top column (`:445`, `:458`).
  - ◐ "Beauty" is renamed to an honest "Tint", with an "only you see them" label and note (`:495`, `:549-550`). There is still no real processor (ZE D6).
  - ✅ The filter chips are `radio` with a label and `checked` (`:498-504`).
  - ✅ The badge is derived (`:454`).
  - ✅ The invite result is reported (`:414`).
  - ✅ The Stop button no longer passes `active` and is labelled "Stop sharing your screen" (`:534`).
- **Regressions:** the test-integrity issue in `lib/call/callControls.selftest.ts:98-101` (see above).
- **Subscreens:**
  - Add-to-call sheet: 7 → 8.
  - Tint strip (formerly Beauty): 5 → 7.
  - In-call chat / reactions: 7.5 → 8.
- **Still needed for 10/10:**
  1. Remove `VideoCallLegacy` (`:575` onward) after the rollback gate.
  2. Decide on Tint: either remove it, or keep it and fix `callControls.selftest.ts` #4 so it describes the truth.
  3. Make the same `inviteToCall` return-value fix as for voicecall.
  4. Delete the now-unused `shareBanner` style, or keep it legacy-only (`makeStyles`, legacy use at `:1027`).

#### `app/incoming-call.tsx` — **7.5 → 8.0**
- **Scores now:** Function 8.5 · States 8 · UI 7.5 · A11y 8 · Security 7 · Code 7.5 (mean 7.75)
- **Original items:**
  - ✅ A failed `webrtc_end` is retried twice in the background (`:226-231`, `sendDecline` `:284-294`). A 1:1 call ends with an "Could not reach the caller" alert (`:230`). "Sent" means emitted, not acknowledged, and delivery is not verifiable statically.
  - ✅ For group decline, the ZE "not reproduced" note matches the code: the alert is suppressed for groups (`:229`).
  - ✅ The duplicated `canGoBack` fallback is merged into `leaveRef` (`:143`).
  - ✅ The avatar initial is hidden from accessibility (`:256`).
- **Regressions:** none.
- **Subscreens:** Call-waiting mode: 7.5 → 8.
- **Still needed for 10/10:**
  1. Use an acknowledged emit (socket.io ack) so "told" means received (`:287-289`).
  2. Remove the `'/' as any` cast (`:143`).
  3. The first `sendDecline` awaits `getSocket()` before leaving (`:226`). On a hung connect, the ring screen stays up until `shouldAbandonPendingConnect` fires (`lib/socket.ts:292`). Consider leaving first. Needs a device check.

#### `app/group-call-active.tsx` — **7.0 → 7.5**
- **Scores now:** Function 8.5 · States 7.5 · UI 7 · A11y 7.5 · Security 8 · Code 6 (mean 7.42)
- **Original items:**
  - ✅ The controls clear the home indicator (`:499`). The top chrome uses the inset-derived `HEADER_TOP`, as ZE argued.
  - ✅ Tiles get a role and a "Moderate X, hand raised, in the audience" label (`:89-95`). The hand badge and Add pill are labelled (`:409`).
  - ✅ `changeRole` awaits and reports failure (`:168-172`). "Move to audience" asks first (`:181-186`). Invites report their outcome.
  - ✅ The pager has `accessibilityState.disabled` (`:459`, `:469`).
  - ◐ `CtrlBtn` is typed and only toggles get a state, but `GroupCallLegacy` remains (`:531`).
- **Regressions:** none.
- **Subscreens:**
  - Moderation sheet: 7 → 8.
  - Add people sheet: 7 → 8.
  - Pager: 7.5 → 8.
  - In-call chat / reactions: 7.5 → 8.
- **Still needed for 10/10:**
  1. Remove `GroupCallLegacy` (`:531` onward) after the rollback gate.
  2. "Lower hand" is still fire-and-forget (`:187`). Await it and report failure like `changeRole`.
  3. The call chrome has 22 hex literals (ratchet baseline). They are deliberate always-dark colours but are not tokenised as a dark palette.

#### `app/call-reliability.tsx` — **6.5 → 7.5**
- **Scores now:** Function 7.5 · States 7 · UI 7.5 · A11y 8 · Security 7.5 · Code 7.5 (mean 7.5)
- **Original items:**
  - ◐ Real read-back: the screen calls `isIgnoringBatteryOptimizations()` on focus and after the request (`:62-66`, `:117`). But that function reports `true` when it cannot tell, which here becomes a positive "Done" (`:112`). Whether `VaultPower` is in the build is not verifiable statically (see Regressions).
  - ✅ "I've done this" persists under `DONE_KEY` and can be undone, with a checkbox role and state (`:24`, `:40-45`, `:145-150`).
  - ✅ The Android-only cards are gated (`:87`, `:105`, `:125`, `:130`), and there is an iOS intro (`:79-81`).
  - ✅ The Switch is labelled (`:172`), and the buttons have roles and labels (`:97`, `:118`, `:142`).
  - ✅ The low-data save reverts and shows an inline error (`:173-181`). An OEM failure shows a fallback hint (`:125-127`). Back falls back to `/settings` (`:73`).
- **Regressions:** the "unknown reads as done" claim (above).
- **Subscreens:**
  - Full-screen intent card: 7 → 7.5.
  - Battery card: 6.5.
  - OEM auto-start: 6 → 7.5.
  - Low-data card: 6.5 → 8.
- **Still needed for 10/10:**
  1. Make the exemption state tri-state (`true` / `false` / `unknown`). Show "Couldn't check" instead of "Done" when `VaultPower` is absent (`lib/batteryOptimization.ts:55`, `app/call-reliability.tsx:108-120`, `:155`).
  2. Catch a rejected `requestIgnoreBatteryOptimizations` (`:117`), and surface a failed `DONE_KEY` write (`:44`).
  3. Remove the `'/settings' as any` cast (`:73`).

#### `app/network-test.tsx` — **7.0 → 7.5**
- **Scores now:** Function 7.5 · States 8 · UI 7.5 · A11y 7.5 · Security 7 · Code 7.5 (mean 7.5)
- **Original items:**
  - ✅ Hard-coded colours are replaced with tokens. Only `#FFF` on the brand gradient remains, with a comment (`:511`; ratchet hex 1).
  - ✅ History rows speak one sentence. The gauge has an `accessibilityValue` (`:267`).
  - ✅ `saveHistory` uses a functional update (`:131-137`).
  - ✅ The `connectionType` state and the IIFE are removed. An `AbortController` is aborted on unmount (`:80`) and passed to every fetch.
  - ✅ A history read failure gets its own retry row (`:423-426`).
  - ❌ It still uses the Cloudflare endpoint (backend work, ZE D4). The exposure is disclosed.
- **Regressions:** none.
  - Nit: `AsyncStorage.setItem` runs inside the `setHistory` updater (`:132-135`). Side effects in an updater can run twice under StrictMode. That is harmless here but not idiomatic.
- **Subscreens:**
  - Results grid: 7.5 → 8.
  - History list: 6.5 → 8.
  - Failed panel: 7.5.
- **Still needed for 10/10:**
  1. Move to an app-owned speed endpoint (P1/ZE D4).
  2. The Back button is 40×40 with no hitSlop and no `canGoBack` fallback (`:334`, `:471`).
  3. Persist outside the state updater (`:131-137`).

#### `app/live.tsx` — **7.0 → 8.0**
- **Scores now:** Function 8 · States 8 · UI 7.5 · A11y 8 · Security 8 · Code 7.5 (mean 7.83)
- **Original items:**
  - ✅ There is a load-error state with Try again (`:393-402`) and a real `refreshing` state (`:155-158`).
  - ✅ The segment uses the `radio` role with `checked` (`:202-204`). Cards have a role and a full label (`:421`). The CTAs and inputs are labelled.
  - ✅ The notice follows the chosen visibility (`:164-170`).
  - ✅ Cancel clears the passcode (`:295`). The passcode now goes through memory, not params (`:110`).
- **Regressions:** none.
- **Subscreens:**
  - Go-live composer: 7 → 8.
  - Join card: 7 → 8.
  - Live-now list: 6.5 → 8.
- **Still needed for 10/10:**
  1. When a refresh fails with a list already shown, the stale list stays with no hint (`:393` only covers the empty case). Add a small "couldn't refresh" line.
  2. The "LIVE" label is 11 pt `#EF4444` on a glass card (`:475-476`). Check its contrast in light mode, which is not verifiable statically.
  3. Remove the `'/live-view' as any` casts.

#### `app/live-view.tsx` — **7.0 → 7.5**
- **Scores now:** Function 8 · States 8 · UI 7 · A11y 7.5 · Security 8 · Code 5 (mean 7.25)
- **Original items:**
  - ❌ The file is still 2107 lines (ZE D2).
  - ✅ The teardown paths are merged into `releaseOwnedMedia` (`:126-142`, used at `:614`, `:719`, `:740`).
  - ✅ Chat unread is counted by message id (`:839-847`). The draft is restored on a failed send, with a "Not sent" alert (`:655-656`). The list auto-scrolls (`:1867`).
  - ✅ Poll options use the `radio` role with a label and checked/disabled/busy state (`:1697-1700`). The composer is labelled, a failed create keeps the draft (`:697`), and End poll is confirmed (`:1672`).
  - ✅ There are non-gesture ways to show the chrome: the stage layer is an accessible button with an `activate` action (`:1411-1416`), and there is a "Show controls" button (`:1457-1466`). Both need a device check.
  - ✅ `__getValue` is gone; values are tracked in `touch` (`:1071`).
  - ✅ The passcode is out of params and lives in an in-memory memo (`:64`, `:721`; selftest 6/6).
  - ◐ End-on-unmount is deliberately not added (ZE D3). It relies on reapers that exist only in backend source and are not deployed.
- **Regressions:** none.
  - Note: `onContentSizeChange` always scrolls to the end (`:1867`), so reading back through history while messages arrive jumps you down.
- **Subscreens:**
  - Waiting / Failed / Ended: 8.
  - Top chrome: 8 → 8.5.
  - Live chat: 6.5 → 8.
  - Poll card: 6.5 → 8.
  - Poll composer: 6.5 → 8.
  - Invite panel: 7.5 → 8.
  - Host media: 8.
  - Camera PiP: 6.5 (still drag-only).
  - Stage strip: 6 (tiles are unnamed and unlabelled, `:1637-1639`).
- **Still needed for 10/10:**
  1. Split the screen: stage geometry and gestures into a hook, and chat, poll and invite panels into components.
  2. Label the stage-strip tiles (`:1637-1639`), and give PiP a non-drag position control.
  3. `closePoll` swallows errors (`lib/broadcast.ts:278-283`) while the UI marks the poll closed (`:1675-1676`). Return a result and revert on failure.
  4. Auto-scroll only when the user is already at the bottom (`:1867`).
  5. Deploy and confirm the golive reapers, or end the broadcast on unmount.

#### `app/live/join/[code].tsx` — **7.0 → 8.0**
- **Scores now:** Function 8 · States 7.5 · UI 8 · A11y 8 · Security 8 · Code 7.5 (mean 7.83)
- **Original items:**
  - ◐ Offline is now told apart from invalid with NetInfo (`:113-116`), and there is Try again on the error step (`:235-243`). The library still folds 5xx into `invalid` (`lib/broadcast.ts:361-366`; the handoff did not land).
  - ✅ The Name step has a Cancel (`:197-199`).
  - ✅ The StatusBar override is removed, so the bar follows the theme.
  - ✅ The CTAs have roles and states. The unused `Platform` import is removed. Aurora is on every step (`:152`, `:208`, `:222`).
- **Regressions:** none.
- **Subscreens:**
  - Name: 7 → 8.
  - Joining: 6.5 → 8 (live region, Aurora).
  - Passcode: 7.5 → 8.5.
  - Error: 5.5 → 7.5.
- **Still needed for 10/10:**
  1. Return `reason: 'network'` from `redeemInviteLink` for no-status or 5xx responses (`lib/broadcast.ts:364-366`), and drop the NetInfo heuristic.
  2. Remove the `'/(tabs)/chats' as any` and `as any` route casts (`:84`, `:110`).

#### `app/notifications.tsx` — **7.0 → 7.5**
- **Scores now:** Function 8 · States 8 · UI 7.5 · A11y 8 · Security 7.5 · Code 6.5 (mean 7.58)
- **Original items:**
  - ✅ The micro text is raised to 11–12 pt (`:201`, `:237`, `:240`, `:258`). Danger tints use `colors.danger + alpha` (`:191`, `:319`, `:340`), and white on danger is the named `ON_DANGER` (`:31`, `:327`).
  - ✅ The nav bar is the shared `SafetyNavBar` (`:354`; `components/SafetyNavBar.tsx`). It sits in the layout flow with a `SCREEN_BOTTOM` margin, uses tablist/tab roles, has 44 pt items, and uses `dismissTo` (supported in expo-router 6.0.23). Its Vault entry now goes to the real `/vault` instead of the `/filevault` redirect.
  - ✅ SOS history has pull-to-refresh (`:216`) and an error state with Try again instead of "No alerts" (`:220-227`).
  - ✅ The `as any` casts are removed, there is a radiogroup (`:279`), and the back button is 44 pt (`:372`).
- **Regressions:** none.
- **Subscreens:**
  - SOS history: 6.5 → 8.
  - Privacy: 7.5 → 8.
  - Panic: 7.5 → 8.
- **Still needed for 10/10:**
  1. `setNotifPreview` and `setRemoteLinkPreviews` are fire-and-forget (`:288`, `:312`). A failed save looks saved.
  2. The Switch uses `thumbColor={colors.card}` (`:312`), while notification-sounds keeps a white `THUMB` for exactly that dark-mode contrast reason. Pick one rule.
  3. The screen is mostly inline style objects (for example `:221-245`, `:319-347`). Move them into `makeStyles`.
  4. Back has no `canGoBack` fallback (`:198`).

#### `app/notification-sounds.tsx` — **7.5 → 8.0**
- **Scores now:** Function 8 · States 8 · UI 7.5 · A11y 8.5 · Security 8 · Code 8.5 (mean 8.08)
- **Original items:**
  - ✅ The screen uses `AppText`. White Switch thumbs are a documented decision (`THUMB`).
  - ✅ `setSoundPrefs` now commits only after `setItem` and rejects on failure (`lib/sounds.ts:55-61`). The screen alerts and skips the preview. `setSoundPrefs` has no other callers.
  - ✅ There is a radiogroup, header roles, and a 44 pt back button.
- **Regressions:** none.
- **Subscreens:** none.
- **Still needed for 10/10:**
  1. Guard against rapid ringtone taps racing two saves (`pickRingtone`). Disable the rows while saving.
  2. Add an on-primary or Switch-thumb token so `THUMB` is not a literal (palette handoff).

#### `app/storage-manager.tsx` — **7.0 → 8.0**
- **Scores now:** Function 8.5 · States 8.5 · UI 7.5 · A11y 7.5 · Security 8 · Code 7 (mean 7.83)
- **Original items:**
  - ◐ Reuse of `cacheManager` was rejected with a sound reason (ZK D2, comment at `:58-61`). `info` is typed, and the `as any` casts are removed.
  - ✅ Delete-old counts the files it removes (`:95`, `:265-267`).
  - ✅ The Files colour is the theme's amber via `catColor` at render time (`:137-139`). The loading state has the header with Back (`:282-305`).
  - ✅ Category rows are labelled. `chatStores` is cleared on failure (`:163`, `:185`).
  - ✅ The X2 regression is fixed: one unreadable subfolder is now skipped and counted (`:90`), and a note says so.
- **Regressions:** none.
- **Subscreens:**
  - Destructive confirmations: 8 → 8.5.
  - Load-failed state: 7.5 → 8.
  - Loading: 6 → 8.
- **Still needed for 10/10:**
  1. The walk calls `getInfoAsync` once per file (`:85`). On large media folders this is slow; batch it or show progress. Not verifiable statically.
  2. Back has no `canGoBack` fallback (`:285`).
  3. Use a `warning` token instead of `TAB_ICON_INK.calls` once the palette has one.

#### `app/cache-cleanup.tsx` — **8.0 → 8.5**
- **Scores now:** Function 8.5 · States 8 · UI 8 · A11y 8.5 · Security 9 · Code 8 (mean 8.33)
- **Original items:**
  - ✅ `dbCache` shows "Not measured" (`:34`, rendered in the category row).
  - ✅ Chips, back and retry are 44 pt (`:224`, `:251`).
  - ◐ The screen reverts and alerts on a setter rejection (`:110-121`). But `setAutoCleanDays` and `setClearOnLogout` still `.catch(() => {})` (`services/cache/cacheManager.ts:136`, `:144`), so those branches are unreachable today.
  - ✅ White on primary is the named `ON_PRIMARY` (`:31`).
- **Regressions:** none.
- **Subscreens:**
  - Clear confirmation: 8.5.
  - Load-failed: 8 → 8.5.
- **Still needed for 10/10:**
  1. Drop the swallowing `.catch` in `services/cache/cacheManager.ts:136`, `:144`.
  2. Add an on-primary palette token.

#### `app/offline-mode.tsx` — **8.0 → 8.5**
- **Scores now:** Function 8.5 · States 8.5 · UI 8 · A11y 8.5 · Security 8 · Code 8 (mean 8.25)
- **Original items:**
  - ✅ There is a `mounted` guard (`:74`).
  - ✅ The retry outcome comes from a recount via `describeRetry` and is shown in a polite live region (`:137`, `:242`). Failed chats are listed as links (`:209-222`; `lib/outboxSummary.ts`; selftest 9/9).
  - ✅ There is a note about unreadable or locked rows (`:86`, `:245-248`). It needs a device check.
  - ✅ `ON_PRIMARY`, header roles, and the cast is removed.
- **Regressions:** none.
- **Subscreens:** Outbox card: 8 → 8.5.
- **Still needed for 10/10:**
  1. The recount runs right after `flush()`, so in-flight sends read as "still waiting". Re-read on the queue's own events, which `on` already provides, to update the result line.
  2. Add an on-primary token.

#### `app/vision-comfort.tsx` — **8.0 → 8.5**
- **Scores now:** Function 8.5 · States 8.5 · UI 8 · A11y 9 · Security 8.5 · Code 8 (mean 8.42)
- **Original items:**
  - ✅ Reset asks first, naming the profile (`:119-126`).
  - ✅ A `beforeRemove` guard covers back, hardware back and the swipe gesture (`:49-64`). It needs a device check.
  - ✅ The spectacle-power input is removed, with an honest explanation. Kinds are keyed by id (`SIGHT_KINDS` `:23-31`) and use radio and radiogroup (`:224-230`).
  - ✅ There is a `sameProfile` field comparison (`:33`) and `ON_PRIMARY`.
- **Regressions:** none. Save does not navigate, so the guard cannot fire after a save.
- **Subscreens:**
  - Sight step: 7 → 8.5.
  - Discard dialog: 8 → 9.
  - Eye Check suggestion: 8.
  - Preview and slider: 9.
- **Still needed for 10/10:**
  1. Back has no `canGoBack` fallback (`:148`).
  2. The Eye Check handoff can stack a second Vision Comfort on the first, because eye-check replaces itself with a new instance. Use `dismissTo('/vision-comfort')` with params.

#### `app/eye-check.tsx` — **8.0 → 8.5**
- **Scores now:** Function 8.5 · States 8.5 · UI 8.5 · A11y 8.5 · Security 9 · Code 6.5 (mean 8.25)
- **Original items:**
  - ✅ The feedback timer is cleared on unmount (`:57`, `:92`, `:103`).
  - ✅ There is live-region text feedback (`:207`, `:218`). The icon uses the light palette's success and danger, which are tuned for the white field (`:203`).
  - ✅ A mid-test back asks first (`MID_TEST` `:24`, `:63-72`). The summary's `replace` is not blocked. Needs a device check.
  - ❌ The single-line JSX remains: 25 lines are over 300 characters (ZK D4).
- **Regressions:** none.
- **Subscreens:**
  - Acuity: 7.5 → 8.5.
  - Colour plates: 8 → 8.5.
  - The others are unchanged at 8–8.5.
- **Still needed for 10/10:**
  1. Split the per-phase JSX into components (for example `:153-260`).

#### `app/perf-debug.tsx` — **8.0 → 8.5**
- **Scores now:** Function 9 · States 8.5 · UI 8.5 · A11y 8.5 · Security 7 · Code 8.5 (mean 8.33)
- **Original items:**
  - ◐ Still ungated (`app/(tabs)/profile.tsx:485`, `:490`). ZK's reasoning holds: `lastError` is a fixed string and the ids are client temp ids. Kept as a product decision.
  - ✅ The theme amber is used through `slow` (`:27`), and `Row` is typed (`:154`).
  - ✅ Rows are spoken as one sentence and the header is hidden (`:124`, `:134`). There is `SCREEN_BOTTOM` padding (`:66`), and Back is 44 pt.
- **Regressions:** none.
- **Subscreens:** none.
- **Still needed for 10/10:**
  1. Gate the long-press behind `__DEV__` or a diagnostics flag (`app/(tabs)/profile.tsx:485`, `:490`).
  2. Add a `warning` palette token.

#### `app/dashboard.tsx` — **7.0 → 7.5**
- **Scores now:** Function 8 · States 7 · UI 7.5 · A11y 8 · Security 7.5 · Code 8 (mean 7.67)
- **Original items:**
  - ✅ The check rows are links to where each setting is changed (`:26-38`), with full spoken labels.
  - ✅ There is a real entry point at `app/settings.tsx:401`, and the shared nav is at `:196`.
  - ✅ Refresh is disabled and busy, with a spinner (`:112-114`).
  - ✅ The score ring has a summary role and label (`:119-124`). Radar colours use `brandAlpha`.
- **Regressions:** none.
- **Subscreens:** none.
- **Still needed for 10/10:**
  1. Refresh on focus. Now that the rows send you off to change a setting, coming back shows the old score until you tap Refresh (`load` only runs on mount, `:80-81`).
  2. A failed refresh over cached data is silent (`:77`). Say the data is stale.
  3. "Blocked Contacts" is always `ok: true` (`:34`), and "Active Sessions ≤ 3" is an arbitrary threshold. Both inflate the score.
  4. Add a mount guard to `load`.

#### `app/games.tsx` + boards/sheets — **7.5 → 8.0**
- **Scores now:** Function 8.5 · States 8 · UI 8 · A11y 7.5 · Security 8.5 · Code 7.5 (mean 8.0)
- **Original items:**
  - ✅ The quick-match cancel race is fixed with an attempt generation (`lib/games/useQuickMatch.ts:47`, `:63`, `:73`, checked in every callback). Searching has Retry (`app/games.tsx:363`, `:596`). "Your games" refreshes on focus, has a failure row, and keeps 404 silent (`lib/games/useLiveTables.ts:58`, `:68`; `app/games.tsx:275-289`; selftest passes).
  - ✅ Searching, BotOffer and PromoPicker are `Modal`s with `onRequestClose` (`app/games.tsx:577`, `:680`; `components/games/Chess.tsx:1340`).
  - ✅ The Rummy leave copy matches the hub (`components/games/Rummy.tsx:1083`). The server behaviour is not verifiable statically.
  - ◐ Accessibility:
    - Done: piece names in square labels, promotion and captured material (`Chess.tsx:1024`, `:1561`; `lib/games/pieceNames.ts`); Start-disabled reasons in Chess, Ludo and TicTacToe (`Chess.tsx:1452`; `lib/games/startHint.ts`; selftest 5/5).
    - Rummy micro text is raised to 9–9.5 pt, with `adjustsFontSizeToFit` down to 0.72–0.8. The "PLAY SMART" tagline is still 7 pt, though hidden from assistive tech (`Rummy.tsx:2367`).
    - No full board sweep (ZK D7).
  - ✅ Code health: the duplicate `useReduceMotion` is removed, `GAMES_HTTP` is shared (`Rummy.tsx:1467`; `lib/games/origin.ts`), RulesSheet is flattened (`rules.tsx:107`), and TicTacToe uses `useAddBot` (`TicTacToe.tsx:62`).
  - ❌ The draw offer still comes from a toast regex (`Chess.tsx:375`). This is blocked on the protocol (ZK D6).
- **Regressions:** none.
  - Note: `lib/games/origin.ts` derives http from ws, which `lib/gamesSocket.ts:33-35` derived from http. Exporting `GAMES_HTTP` from gamesSocket would be one source.
- **Subscreens:**
  - ModeSheet: 8.
  - Searching: 6 → 8.
  - BotOffer: 7.5 → 8.
  - LeaderboardSheet: 8.5.
  - HistorySheet: 8.
  - InviteSheet: 7.
  - RulesSheet: 7 → 8.
  - VoiceSheet: 7.5.
  - "Which game" code sheet: 8.
  - Chess: 7.5 → 8. Its lobby goes 7.5 → 8 and its promotion picker 6.5 → 8. The draw-offer banner stays at 6.
  - Ludo: 7.5. Its lobby goes 7.5 → 8. Ludo settings stay at 6.
  - Rummy: 7.5 → 8. The leave confirmation goes 6 → 8. Table info, score and stat labels go 7 → 7.5.
  - Tic-Tac-Toe: 7 → 7.5. Its lobby goes 6.5 → 8.
- **Still needed for 10/10:**
  1. A line-by-line accessibility pass of the Chess, Ludo and Rummy boards (3173, 1564 and 1380 lines; ZK D7). Chess still has one unroled touchable per the ratchet baseline.
  2. Drive the draw offer from a protocol field (`Chess.tsx:375`), which needs the games server.
  3. Rummy's 3173-line file. Split out the table-select, panels and sheets.
  4. Ludo settings sheet (6/10) is unchanged since the audit.
  5. Export `GAMES_HTTP` from `lib/gamesSocket.ts` and delete the re-derivation in `lib/games/origin.ts`.

---

### F — Media, Files & Documents — round-3 re-rating

- **Baselines.** The "Old" scores come from the task. The open items come from `rerate2/X1.md` for media-viewer and file-preview, and from `rerate/F.md` for the other screens.
- **What changed.** `git diff b8c8bd2 HEAD` for each screen, plus `lib/scanVault.ts`, `lib/imageEditMath.ts`, `lib/zoomPan.ts`, `lib/strokePath.ts`, `lib/storyDuration.ts`, `lib/archive.ts`, `lib/shelfOpen.ts`, and the handoff targets (`app/chat.tsx:1932-1945`, `components/chat/MessageBubble.tsx:994-1003`, `components/status/GateChallenge.tsx`, `components/chat/ViewerStack.tsx`).
- **Fix log.** `fixes/ZF.md`. Every claim was checked against the current code. I read every screen file in full, except file-viewer, where I read the diff and every cited region.
- **What I ran myself.** All of these were read-only checks:
  - The selftests all exited 0: a11yCoverage, archive, camera/cameraMode, docOpen, imageEditMath (31), keyboardAvoidance (4), permissionDeadEnd (5), reader, responsiveLayout (28), rowOverflow (6), screenBackCoverage, serverOrigin, shelf, shelfOpen (13), silentFailure, storyDuration (7), strokePath (5), themeCoverage (22/20), uiDebtRatchet ("no file got worse"), videoSeek (11), whiteboardStroke (3) and zoomPan (9).
  - `npx tsc --noEmit -p .` exited 0.
  - `npx eslint` on the 13 screens and the new libs gave 0 errors and 4 warnings, all `exhaustive-deps` in `app/story-viewer.tsx:215,237,277,292`.
- **Not verified.** Nothing here is device-verified. Gestures (pinch, crop drag), ViewShot capture of react-native-svg filters and paths, and the camera's `onCameraReady` re-fire on iOS are **not verifiable statically**. They count only for what the code shows.
- **Rounding.** I used the mean of the six dimensions, rounded to the nearest 0.5, with ties rounded up (the X1 convention). One screen sits exactly on a tie: camera, at 7.75.

| Screen | Old | New | Δ |
|---|---|---|---|
| app/camera.tsx | 7.5 | 8 | +0.5 |
| app/media-viewer.tsx | 6 | 7 | +1 |
| app/media-gallery.tsx | 6 | 7.5 | +1.5 |
| app/image-editor.tsx | 5.5 | 7 | +1.5 |
| app/file-preview.tsx | 7.5 | 8 | +0.5 |
| app/file-viewer.tsx | 6.5 | 7.5 | +1 |
| app/video-player.tsx | 5.5 | 7 | +1.5 |
| app/reader.tsx | 8 | 8 | 0 |
| app/shelf.tsx | 8 | 8 | 0 |
| app/archive-viewer.tsx | 7.5 | 8 | +0.5 |
| app/docscanner.tsx | 6 | 7 | +1 |
| app/story-viewer.tsx | 7.5 | 7.5 | 0 |
| app/whiteboard.tsx | 5.5 | 7.5 | +2 |

**Regressions introduced by round 3:**
1. **docscanner can lose a scan's key.** Details are under that screen.
   - Migration deletes the plaintext PDF (`app/docscanner.tsx:74`) before the sealed list that holds its key is written (`:133`).
   - `persistRecent` swallows a sealing failure (`:115`). A new scan then shows "PDF ready" (`:243-246`), but its MediaKey was never stored.
2. **file-preview tokenises the whole file up front** (`app/file-preview.tsx:221`), up to 2 MB (`:18`). Before, it was lazy per row. First paint of a large file is slower. The effect on a device is not verifiable statically.
3. **ZF #28 overstates the media-viewer hex cleanup.** The log says 5 hex literals remain. `app/media-viewer.tsx` actually has 15: `:40`, `:49`, six `'#FFFFFF'` at `:266,293,313,660,687,762`, and the CODE palette at `:328`. The uiDebtRatchet baseline records 14. This is not a code regression, but the claim is inaccurate.

The chat.tsx and shop-book.tsx splits touch none of these screens. The whiteboard and image-editor entry points in `app/chat.tsx:1878-1945` pass the full return params.

---

#### `app/camera.tsx` — **7.5 → 8**
- **Scores now:** Function 8.5 · States 8 · UI 8 · A11y 8 · Security 7 · Code 7. The mean is 7.75, a tie, rounded up.
- **Original items:**
  - ✅ 1 Leaving with scanned pages now asks first. A `beforeRemove` guard covers ✕, "Not now", hardware back and swipe (`app/camera.tsx:155-167`). Delivering a capture sets `allowLeave` (`:186-188`), so attaching never asks.
  - ✅ 2 The review sheet has a page strip of thumbnails. Each page has a labelled remove button (`:571-584`), and removing the last page closes the sheet (`:300-306`).
  - ✅ 3 ML Kit and PDF errors now use fixed copy, and a cancel is ignored (`:266-270`, `:294-296`).
  - ✅ 4 The 250 ms sleep is replaced by a wait on `onCameraReady` with a 1.5 s floor (`:174-183`, `:234`, `:395`).
    - On Android the mode setter re-arms camera creation (`node_modules/expo-camera/android/.../ExpoCameraView.kt:152-155`), and `onCameraReady` fires at `:600`.
    - On iOS the re-fire is not verifiable statically. If it does not re-fire, hold-to-record waits up to 1.5 s.
- **Regressions:** none found.
- **Subscreens:** Permission gate 8 → 8 · Mode tabs 8.5 → 8.5 · Scan review sheet 7 → 8.5
- **Still needed for 10/10:**
  1. While the review sheet is open, hardware back should close the sheet. It is an in-tree overlay with no BackHandler (`:553-560`), so back goes to the discard prompt (`:159-167`).
  2. ✕ is not disabled while recording (`:403`). If `recordAsync` resolves after the screen leaves, `leave(capture)` (`:240`) could deliver a video the user closed on. That is not verifiable statically. Stop the recording, or ignore the result, on close.
  3. Delete removed and abandoned scan pages from the cache. The ML Kit page images stay as plaintext files (`:264`, `:300-306`).
  4. Clear the floor timer in `waitForCamera` (`:180-183`). Type the `beforeRemove` event instead of `e: any` (`:159`).

#### `app/media-viewer.tsx` — **6 → 7**
- **Scores now:** Function 8 · States 7.5 · UI 6.5 · A11y 6.5 · Security 8 · Code 6.5
- **X1 items:**
  - ✅ 1 The video track is seekable.
    - A draggable track with a thumb uses `seekFraction`/`seekTargetMs` (`app/media-viewer.tsx:152-164`, `:200-212`).
    - The track is `adjustable` with ±10 s actions (`:202-205`).
    - The image has pinch zoom (1–5×) and pan clamped by `lib/zoomPan` (`:83-139`), and an a11y activate action (`:131-134`). The gestures themselves are not verifiable statically.
  - ✅ 2 `ArchiveCard` and `GenericViewer` are hoisted to module scope with `useReady` (`:276-325`).
  - ◐ 3 Dark-media token set: the `M` set is built from `AuroraDark` (`:39-51`), and the cards are now dark (`:749`). Still 15 hex literals (see Regressions 3), and CodeViewer still uses inline styles (`:360-373`).
  - ✅ 4 Retry, user copy and typed helpers.
    - The error state has a Retry that re-resolves and remounts the player (`:619-623`, `:682-689`).
    - `MediaKeyMissingError` gets its own copy (`:478-480`).
    - Share and Save use user copy (`:578-581`, `:613-616`).
    - The helpers are typed (`:53-66`).
- **Regressions:** no functional regressions.
  - The comment at `:379-383` still describes shadowing a `Dimensions.get`, which no longer exists.
  - The ZF hex claim is inaccurate.
- **Subscreens:** ImageViewer 4.5 → 7 · VideoPlayer 5 → 7 · AudioPlayer 6 → 6.5 · CodeViewer 7 → 7 · ArchiveCard 6.5 → 7.5 · GenericViewer 6 → 7.5 · "Nothing to show" 7.5 → 7.5 · ProtectedMediaView 7.5 → 7.5 · Error+Retry (new) — 8
- **Still needed for 10/10:**
  1. VideoPlayer's tap-to-toggle `TouchableOpacity` (`:178-179`, role button) wraps the play button and the new seek track. An accessible parent groups its children, so screen readers likely cannot reach the inner controls. Exact behaviour is not verifiable statically. Make the wrapper `accessible={false}`, or move the toggle off the wrapper.
  2. `getAccessToken().then(...)` has no catch (`:435`). If it yields null, `waitingForAuth` stays true (`:471`), and the player spins forever with no error.
  3. Move the remaining hex into `M`: on-accent `#FFFFFF` ×6 and the CODE palette (`:328`). Move CodeViewer's inline styles into the stylesheet (`:360-373`).
  4. Pad the video controls with the safe-area inset (fixed `paddingBottom:30`, `:738`). Delete the stale comment (`:379-383`).
  5. Audio skips by ±10% of the clip (`:247-251`, `:264`, `:268`), which is unpredictable on long clips. Use fixed seconds and an adjustable waveform.

#### `app/media-gallery.tsx` — **6 → 7.5**
- **Scores now:** Function 8 · States 8 · UI 7 · A11y 8 · Security 7.5 · Code 7
- **Original items:**
  - ✅ 1 Photos and videos open in `/media-viewer` through `shelfOpenParams`. Encrypted items first decrypt the body so the key reaches the store (`app/media-gallery.tsx:331-353`; `lib/shelfOpen.ts:31-41`).
  - ✅ 2 Errors are no longer shown as empty.
    - With no cache, there is an error state with Retry (`:472-481`).
    - With a cache, there is a stale bar with Retry (`:459-468`), driven by `loadError` (`:153-156`, `:227-231`).
    - The page cap shows a note (`:200-210`, `:514-516`).
  - ✅ 3 Tiles, file rows, links, tabs, chips, Back and the title have roles, labels and state (`:356-357`, `:363-364`, `:373-374`, `:385-387`, `:437-443`, `:450-451`, `:430`, `:433`).
  - ✅ 4 The photo Modal (and its `top:54`) is gone. Photos get media-viewer's zoom, share and save.
  - ✅ 5 `SW` is removed. `#FFFFFF` remains as documented on-accent ink (`:539-540`, `:560`).
  - ✅ (handoff) The `tab` param seeds the initial tab (`:130`, `:135-136`).
- **Regressions:** none found.
- **Subscreens:** Tabs 6 → 8.5 · Album grouping 6.5 → 8 · Full-screen photo Modal 4.5 → removed (replaced by media-viewer) · Error/stale states (new) — 8
- **Still needed for 10/10:**
  1. The decrypt-then-parse block is written three times (`:254-259`, `:285-288`, `:336-339`). Extract one helper.
  2. Use safe-area insets instead of `HEADER_TOP` (`:532`), as sibling screens do.
  3. Type `MediaThumb`'s `style` (`:75`) and drop the `as any` route casts (`:310`, `:347`). Make the play badge tokenised (`:367`, `:548`).
  4. `openMedia` reports every failure as "could not be decrypted" (`:348-349`), including navigation errors. Split the copy.

#### `app/image-editor.tsx` — **5.5 → 7**
- **Scores now:** Function 7.5 · States 7 · UI 7 · A11y 7 · Security 6 · Code 7
- **Original items:**
  - ✅ 1 Crop is user-positioned.
    - The box moves, and its four corners resize it (`app/image-editor.tsx:172-197`, `:387-410`).
    - "Free" works (`:38`), the box is ratio-locked otherwise, and it is mapped to pixels by `containFrame`/`toImageCrop` (`:129-136`, `:227`; `lib/imageEditMath.ts:99-153`).
    - Crop has a re-entry guard (`:218`). The overlay sits outside the ViewShot (`:387`).
  - ◐ 2 Filters, brightness and contrast use a real colour matrix (`:119`, `:52-58`; `lib/imageEditMath.ts:82-90`) through react-native-svg's installed `FilterImage` (`node_modules/react-native-svg/package.json` 15.12.1, `filter-image` export present). Whether ViewShot captures the SVG filter output is not verifiable statically.
  - ✅ 3 Each stroke is one SVG `Path` (`:60-69`).
  - ✅ 4 Edge padding and styling.
    - The top bar uses the inset (`:628`).
    - The overlay is a themed scrim (`:612-617`, `:673-675`).
    - Icons are Ionicons (`:332-339`).
  - ✅ 5 Clean-up items.
    - The text input is labelled (`:505`).
    - Discard asks only when something is dirty (`:287`, `:319-325`).
    - `rotation` and the no-op `applyFilter` are gone.
- **Regressions:** none found.
- **Subscreens:** Crop 3.5 → 7.5 · Draw 6 → 7.5 · Text 6.5 → 7 · Filter 4 → 7.5 · Adjust 5 → 7 · Processing overlay 6 → 7.5 · Discard confirm 7 → 7.5
- **Still needed for 10/10:**
  1. Any draw, text or colour edit sends a ViewShot of the screen-sized canvas (`:299-302`; canvas `SW × SH·0.55`, `:81`, `:635`). The full-resolution photo is replaced by a downscaled one with letterbox bands. Capture at image resolution, or crop the capture to `frame`.
  2. Guard hardware back and swipe with `beforeRemove`. Only the Cancel button asks (`:319-325`), so back drops all edits.
  3. Pad the bottom toolbar and sub-panels with the safe-area inset (`:637`, `:643`).
  4. Strokes and text are in canvas coordinates and are not transformed on rotate or crop (`:200-236`), so they drift off their content. Bake them in first, or clear them with a warning.
  5. Delete the ImageManipulator and ViewShot temp files after sending (`:204-209`, `:225-230`, `:301`). Surface an `Image.getSize` failure (`:126`), which today leaves crop "not ready" forever.
  6. Give the crop box screen-reader actions, such as preset insets (`:394-399`). Type `viewShotRef` and `style` (`:52`, `:89`).

#### `app/file-preview.tsx` — **7.5 → 8**
- **Scores now:** Function 7.5 · States 8.5 · UI 7.5 · A11y 7.5 · Security 8.5 · Code 7.5
- **X1 items:**
  - ✅ 1 The tokenizer and maps are typed (`app/file-preview.tsx:22-24`, `:26`, `:42`, `:55`, `:73`), and tokens are memoised per file and language (`:218-221`).
  - ✅ 2 `copyAll` and `shareFile` are wrapped, with user copy (`:201-216`).
  - ✅ 3 The info bar is hidden until content exists (`:272-278`). The badge uses `brandAlpha`/`accentOn` (`:320`), and the button text uses `bubbleOutText` (`:332`).
- **Regressions:** the tokenisation is eager, as listed above (`:221`).
- **Subscreens:** none.
- **Still needed for 10/10:**
  1. Tokenise lazily, with a per-index cache inside `renderItem` (`:221`, `:236`), so a 2 MB file paints its first rows at once.
  2. Expose the disabled state of Copy and Share (`:258`, `:262`). Move the header's inline styles into the stylesheet (`:253-265`).
  3. Share sends the text as a message (`:212`). Offer the file itself via expo-sharing. Type `info` (`:181`).

#### `app/file-viewer.tsx` — **6.5 → 7.5**
- **Scores now:** Function 8.5 · States 8.5 · UI 6 · A11y 7 · Security 8.5 · Code 6
- **Original items:**
  - ✅ 1 The bottom bar appears only for image, audio and unknown files, and it calls `openInDeviceApp` with busy state (`app/file-viewer.tsx:1388-1408`).
  - ✅ 2 Temp copies are still purged (unchanged).
  - ✅ 3 Audio sends the token to our own server only (`:678`). A run-id stale guard unloads a late sound (`:671`, `:692`). `staysActiveInBackground` is `false` (`:676`).
  - ✅ 4 "Pinch to zoom" is replaced with "Scroll to read the pages" (`:993`).
  - ✅ 5 The skip buttons are "Back/Forward 15 seconds" (`:1250-1251`, `:1271-1272`). The seek area is `adjustable` (`:1216-1223`). Open, Retry, Back and Share have roles (`:967-969`, `:1038-1039`, `:1313`, `:1362`, `:1378`).
  - ✅ 6 Safe-area insets replace the `Platform.OS` paddings (`:1353`, `:1385`, `:1395`). The four `as any` casts are gone (`:453`, `:504`, `:626`, `:655`). The file is now 1,583 lines.
  - ✅ 7 `handleShare` reports unavailable or failed (`:833-841`).
  - ✅ (found) `downloadAuthed` gates the token with `isOwnServerUrl` (`:391-393`). `openInDeviceApp` uses it (`:787`).
- **Regressions:** none found.
- **Subscreens:** Image 5.5 → 6 · PDF/PdfView 7 → 7.5 · Office/DocView 8.5 → 8.5 · Text reader 8 → 8.5 · Audio 5.5 → 7.5 · Hand-off card 7 → 7.5 · Unknown type 5 → 6.5 · Error+Retry 7 → 8 · Loading 7 → 7 · Bottom bar 4 → 7.5
- **Still needed for 10/10:**
  1. Split the renderers out of the 1,583-line file (`renderImage` from `:908`). This is the deferred ZF item.
  2. Image viewer.
     - It has double-tap zoom only, no pinch, and pan that is never clamped (`:844-890`).
     - Its error is "Failed to load image" (`:919`).
     - It has no a11y zoom action.
     - Reuse `lib/zoomPan` as media-viewer does.
  3. The `C` palette is a fixed dark set with 49 hex literals (`:62-81`, uiDebtRatchet baseline), not theme tokens. The header height is assumed to be 64 (`:1385`).
  4. PdfView still has no zoom gesture, and iOS still falls back (deferred).

#### `app/video-player.tsx` — **5.5 → 7**
- **Scores now:** Function 7 · States 7 · UI 7 · A11y 7.5 · Security 7 · Code 6.5
- **Original items:**
  - ✅ 1 The fake PiP is removed, and the header says why (`app/video-player.tsx:1-5`). There is one `<Video>` (`:434-446`).
  - ✅ 2 The default export wraps `VideoPlayerInner` in `ErrorBoundary` (`:48-54`).
  - ✅ 3 Share downloads remote files into `vt_share_`. The token goes to our own server only. Share reports failures and shows a busy state (`:297-324`, `:527-533`).
  - ✅ 4 Controls use Ionicons (`:523-607`). The bars use insets (`:688`, `:747`). The scale is tracked in `scaleRef` (`:136-139`). Mute is a `switch` (`:586-587`), and the tap zones have role, label and hint (`:504-513`).
  - ✅ 5 `__getValue`, `Dimensions` and the `useS` dimensions are gone.
- **Regressions:** none found.
- **Subscreens:** Controls overlay 7 → 8 · PiP 3 → removed · "Nothing to play" 7 → 7 · Load-error overlay 7.5 → 7.5
- **Still needed for 10/10:**
  1. These awaits have no catch:
     - `seekRelative` (`:254`)
     - `cycleSpeed` (`:269`)
     - `toggleMute` (`:275`)
     - `toggleFullscreen` (`:281`)

     A torn-down player rejects as an unhandled promise, and Mute flips its UI state only after the await.
  2. The resume seek runs on mount, before the video loads (`:93-104`), so it may be ignored. Apply it in `onLoad`.
  3. `[, setStatus]` is dead state that re-renders every 250 ms (`:73`, `:231`). Remove it.
  4. The "Nothing to play" state uses `colors.textDim` on the fixed black stage (`:401`, `:405`), which is dark-on-black in the light theme. The play button fill is cyan `rgba(0,229,255,.25)` against a blue ACCENT (`:724`).
  5. `resumeKey` keeps a reversible encoding of the file URI in AsyncStorage (`lib/videoSeek.ts:24-28`). Hash it.

#### `app/reader.tsx` — **8 → 8**
- **Scores now:** Function 8 · States 8.5 · UI 8 · A11y 8.5 · Security 8 · Code 8
- **Original items:**
  - ✅ 1 The stepper −/+ have `accessibilityRole="button"` (`app/reader.tsx:273`, `:275`).
  - ✅ 2 A spinner shows while `cached === null` (`:137-138`). `width` and `useWindowDimensions` are removed.
  - ❌ 3 The plaintext `text` param fallback remains (`components/chat/MessageBubble.tsx:1000-1002`). The handoff was not applied.
  - ✅ (found) A failed cache read is an error state with Retry (`app/reader.tsx:48-60`, `:139-148`).
- **Regressions:** none found.
- **Subscreens:** Reader settings sheet 8.5 → 8.5 · Pages layout 8 → 8 · Read-error state (new) — 8
- **Still needed for 10/10:**
  1. For self-decrypted rows, write the plaintext to the cache and pass only `{chatId,id}`. Drop the `text` param (`components/chat/MessageBubble.tsx:1000-1002`).
  2. The entry chip has no `accessibilityRole` (`components/chat/MessageBubble.tsx:995-1003`).
  3. Move the inline styles of the new error state into the stylesheet (`app/reader.tsx:140-147`).

#### `app/shelf.tsx` — **8 → 8**
- **Scores now:** Function 8 · States 8.5 · UI 8 · A11y 8.5 · Security 8 · Code 8
- **Original items:**
  - ✅ 1 The filter input is labelled (`app/shelf.tsx:146`). The title has a header role (`:133`).
  - ✅ 2 A failed pin write reverts the row and shows an Alert (`:99-112`). A stale bar with Retry appears when a refresh fails with rows shown (`:185-194`).
  - n/a 3 Informational note only.
- **Regressions:** none found.
- **Subscreens:** Kind chips + sort 8.5 → 8.5 · Stale bar (new) — 8
- **Still needed for 10/10:**
  1. The pin button is nested inside the row's accessible `TouchableOpacity` (`:240`, inside the row at `:227`), so screen readers may not reach it (not verifiable statically). Expose pin as an `accessibilityActions` entry on the row.
  2. The pin rollback restores the `pins` captured when the toggle started (`:108-109`), so overlapping toggles on two rows can undo each other. Revert only the toggled id.
  3. Drop the `as any` on the route (`:121`).

#### `app/archive-viewer.tsx` — **7.5 → 8**
- **Scores now:** Function 8.5 · States 8 · UI 8 · A11y 8.5 · Security 8.5 · Code 7.5
- **Original items:**
  - ✅ 1 Lazy listing, lazy inflate, and size caps.
    - The listing comes from the central directory (`app/archive-viewer.tsx:120-121`; `lib/archive.ts:162-164`).
    - A tap inflates only that entry, via the fflate `filter` (`:167-170`).
    - There is a compressed-size cap before the base64 read (`:93-99`; `MAX_ARCHIVE_BYTES` `lib/archive.ts:154`) and a per-entry cap (`:160-163`; `MAX_ENTRY_BYTES` `lib/archive.ts:159`).
  - ✅ 2 "Open in another app" goes straight to `Sharing.shareAsync`, downloading a remote file first, with a busy state and an error (`:194-224`, `:251-259`).
  - ✅ (found) The token goes to our own server only (`:82`, `:211`). Back is labelled "Up one folder" inside a folder (`:233`). The title has a header role (`:237`).
- **Regressions:** none found.
- **Subscreens:** Directory browser 8 → 8.5 · Error state 7.5 → 7.5 · Unsupported-format state 7 → 8.5
- **Still needed for 10/10:**
  1. The per-entry cap trusts the declared `originalSize` (`:160`). Bound the actual inflated output too. Whether fflate enforces this is not verifiable statically.
  2. Size refusals still show a Retry that can only fail again (`:94-98`, `:262-269`). Offer "Open in another app" instead.
  3. Entries are flattened to their basename (`:177`), so two `README.md` files in different folders overwrite each other. Type `info` (`:95`).

#### `app/docscanner.tsx` — **6 → 7**
- **Scores now:** Function 7.5 · States 7 · UI 6.5 · A11y 7.5 · Security 7 · Code 6
- **Original items:**
  - ✅ 1 Scans are encrypted at rest. Details:
    - Each PDF is AES-256-GCM encrypted under its own MediaKey into `VaultScans/<id>.vcs` (`app/docscanner.tsx:229-236`; `lib/scanVault.ts:57-65`).
    - The recent list is sealed under a SecureStore key (`app/docscanner.tsx:113-116`; `lib/scanVault.ts:31-55`).
    - A failed encryption fails the save (`:247-255`).
    - The device-bound key is documented with a `ponytail:` note (`lib/scanVault.ts:13-16`).
  - ✅ 2 The dead camera branch is removed. The gallery path only remains (`:171-183`).
  - ✅ 3 The preview's Share, Send and "Scan another" have roles, and Send has a spinner and busy state (`:516-533`). The row exposes send, share and delete as a11y actions (`:417-423`).
  - ✅ 4 The chat picker has a Close button with a header, row roles and an inset bottom (`:549-581`).
  - ❌ 5 It is still not merged with camera SCAN. This is a deliberate decision in ZF. The emoji title is fixed (`:362`).
- **Regressions:**
  1. **Key loss during migration.**
     - `migrateDoc` deletes the plaintext PDF (`:74`) before the sealed list carrying its new `mk` is written (`:133`).
     - If `sealJson` or `setItem` throws, for example on a SecureStore failure (`lib/scanVault.ts:31-43`), the `.vcs` files are orphaned and their keys are lost.
     - The comment at `:64-66` ("can never lose a scan") is not true for this path.
  2. **Key loss on a new scan.** `persistRecent` swallows a sealing failure (`:115`), and `processToPdf` then reports success (`:243-246`). The scan's key exists only in memory and is gone after a restart.
- **Subscreens:** Step pick 7.5 → 7.5 · Step type 7 → 7 · Step processing 7.5 → 8 · Step preview 6.5 → 7.5 · Chat picker Modal 6.5 → 8 · Delete confirm 7 → 7 · Recent-list error card (new) — 7.5
- **Still needed for 10/10:**
  1. Persist the sealed list, with the new key, before deleting plaintext (`:74`, `:133`). Make `persistRecent` throw so the save fails visibly (`:115`, `:244`).
  2. A list that can never be opened, for example after the keychain was lost, gives an endless Retry (`:124`, `:401-409`). Offer to reset it.
  3. Remove the emoji type icons, tips and filename prefix (`:41-48`, `:390-395`, `:560`). Move the gradient hex onto tokens (`:374`, `:381`; 15 hex literals). Move the inline styles into the stylesheet (throughout `:370-534`). Use insets instead of `HEADER_TOP` (`:606`).
  4. Add a busy guard to `sharePdf`, which decrypts a new temp copy on every tap (`:259-268`). Remove the `as any` (`:230`, `:488`).
  5. The preview still shows the plaintext ML Kit and gallery image (`:509-512`), and those cache files are never removed (deferred in ZF).
  6. Decide on, or merge with, the camera SCAN path (`app/camera.tsx:288-298`).

#### `app/story-viewer.tsx` — **7.5 → 7.5**
- **Scores now:** Function 8.5 · States 8.5 · UI 7.5 · A11y 7 · Security 8 · Code 6.5
- **Original items:**
  - ✅ 1 Video duration follows `durationMillis` from `onLoad`, clamped by `storyDurationMs` (`app/story-viewer.tsx:139-143`, `:313`, `:457`; `lib/storyDuration.ts:14-19`).
  - ✅ 2 The top bar, caption and viewers sheet use insets (`:531`, `:582`, `:590`). The GateChallenge close button uses `40 + insets.bottom` (`components/status/GateChallenge.tsx:93`).
  - ✅ 3 BackHandler closes the viewers sheet first (`:365-371`). Delete and feed errors use user copy (`:130-133`, `:389-390`).
  - ✅ 4 The `text`/`bgColor` casts are removed (`:442-443`). `mediaSrc as any` remains (`:451`).
- **Regressions:** none found.
- **Subscreens:** GateChallenge 7.5 → 8 · Viewers sheet 7 → 8 · Error/loading 8 → 8.5 · Delete confirm 8 → 8.5
- **Still needed for 10/10:**
  1. Stories auto-advance (`:309-318`), and pausing is long-press only (`:515-516`, `:523-524`). Screen-reader users get no accessible pause. Add a pause action, and respect reduce-motion.
  2. Pause and resume restart the bar from 0 (`progress.setValue(0)`, `:309`) while the video continues. Resume from the current value, or from the video position.
  3. Fix the 4 `exhaustive-deps` warnings (`:215`, `:237`, `:277`, `:292`). Type `mediaSrc` (`:451`). The 22 fixed-dark hex literals could become a named dark set, like media-viewer's `M`.

#### `app/whiteboard.tsx` — **5.5 → 7.5**
- **Scores now:** Function 8 · States 7.5 · UI 7 · A11y 7.5 · Security 7 · Code 7.5
- **Original items:**
  - ✅ 1 A Send header button appears when there is a `chatId` (`app/whiteboard.tsx:188-194`). It captures a JPEG and returns it through `dismissTo` + `returnParams` (`:136-151`). The caller passes the full params (`app/chat.tsx:1937-1943`), so the handoff landed.
  - ✅ 2 Each stroke is one SVG `Path`, and committed strokes render through a memoised `StrokeLayer` (`:32-41`, `:204-210`). Whether ViewShot captures SVG is not verifiable statically.
  - ✅ 3 Typed `PathData`/`Point` state (`:57-59`). Inset toolbar (`:268`). Undo and redo (`:99-108`). Clear is a no-op when empty and has a cancel-styled button (`:109-115`).
- **Regressions:** none found.
- **Subscreens:** Toolbar 7.5 → 8.5 · Clear confirm 7 → 8 · Leave guard 7.5 → 7.5
- **Still needed for 10/10:**
  1. The leave guard compares stroke counts (`:124`). Share 3 strokes, undo 1, draw 1, and it no longer asks. Track a dirty flag or a version number instead.
  2. Every move event copies the whole live stroke array and re-renders the screen (`:82-87`). Use a ref with a throttled render, or an Animated path.
  3. Move the header buttons' inline styles into the stylesheet (`:181-194`). The `AuroraBackground` under an opaque canvas is redundant (`:199`, `:267`). Delete the capture temp file after Share (`:157-160`).

---

### G1 — Family Circle — re-rating (round 3)

| Screen | Old | New | Δ |
|---|---|---|---|
| `app/family.tsx` | 7.0 | 7.5 | +0.5 |
| `app/family-map.tsx` | 7.0 | 7.5 | +0.5 |
| `app/family-add.tsx` | 7.5 | 8.0 | +0.5 |
| `app/family-alerts.tsx` | 8.0 | 8.5 | +0.5 |
| `app/family-history.tsx` | 7.5 | 8.0 | +0.5 |
| `app/family-items.tsx` | 6.5 | 7.5 | +1.0 |
| `app/family-member.tsx` | 7.0 | 7.5 | +0.5 |
| `app/family-places.tsx` | 7.5 | 8.0 | +0.5 |
| `app/family-setup.tsx` | 8.0 | 8.0 | 0 |

**Method.** This is a static, read-only review of `git diff b8c8bd2 HEAD`.
- **Baselines.** The "Still needed" lists come from `rerate2/X3.md` (family, family-member, family-setup) and from `rerate/G1.md` (the other six screens).
- **Files read.**
  - The current versions of every changed screen.
  - The new split-outs: `components/family/CrashCountdown.tsx`, `CheckinSheet.tsx`, `AnnouncementSheet.tsx` and `sheetStyles.ts`.
  - The changed components: `FamilyMap.tsx`, `MeetHereSheet.tsx` and `NavigationLayer.tsx`.
  - The new libraries: `lib/family/memberFormat.ts`, `lib/family/historyGate.ts` and `lib/items/crowd.ts`.
  - The changed library `lib/family/circle.ts`.
- **Handoffs.** The fix log (`fixes/ZG1.md`) handed off four items. I checked the files other agents changed for them.
  - Handoff 1: `lib/callBackground.ts` (Z-A).
  - Handoff 2: `lib/family/alerts.ts` (Z-H).
  - Handoff 4: group-insights (`2a0b220`).
  - Handoff 3 (`navigationService` "then" maneuver) was **not** done. Nothing in `lib/nav/navigationService.ts` mentions `thenEvent`.
- **Fixer claims.** Every claim in `fixes/ZG1.md` was checked against the code. All of them hold, with two small inaccuracies:
  - `family.tsx` is 2436 lines, not the "2420" the log states.
  - "family-history `as any` → 0" is true for casts, but the `(p: any)` parameter annotation at `family-history.tsx:168` remains.

**Checks run (read-only, at HEAD `c28d1b2`):**
- `npx tsc --noEmit -p .` exits 0 with no errors (`rerate3/G1_tsc.txt`).
- `npx eslint` on the 9 screens, `components/family/*` and the 4 new or changed libraries: 0 errors and 9 warnings (`rerate3/G1_eslint.txt`).
  - `family.tsx`: 4 exhaustive-deps warnings (`:297`, `:361`, `:608`, `:814`), 1 `require()` (`:919`) and 1 unused disable directive (`:1057`).
  - `family-member.tsx:240,271` and `family-history.tsx:167`: `require()` imports.
  - All of these were already present.
- Selftests, all exit 0. Each log is in `rerate3/G1_st_*.txt`.
  - `lib/items/crowd.selftest.ts` (new)
  - `lib/family/historyOwners.selftest.ts`
  - `lib/locationEgress.selftest.ts`
  - `lib/a11yCoverage.selftest.ts`
  - `lib/uiDebtRatchet.selftest.ts`
  - `lib/pendingLink.selftest.ts`
  - `lib/themeCoverage.selftest.ts`
  - `lib/responsiveLayout.selftest.ts`
- I ran the ratchet's own `unroled` counter over every `app/family*.tsx` and `components/family/*.tsx`. It finds **0 unroled touchables**.

**Not verified:** nothing is deployed or device-verified. These all need a device, and the code is scored only on what it shows:
- the TalkBack/VoiceOver `manage` action
- the WebView summary label
- the pairing Modal with the keyboard
- background notification taps
- the follow-bar slot
- the matrix connector labels

**Cross-cutting, now closed.**
- **Background family-alert taps.** The handler (`lib/callBackground.ts:46-50`) calls `deliverTap(hrefWithQuery('/family-alerts', …))`. The root subscribes to these taps (`lib/pendingLink.ts:187-201`, `app/_layout.tsx:452`), and a repeat of the same tap at cold start is dropped (`app/_layout.tsx:838-841`).
- **The alerts store.** `loadAlerts` shares one in-flight read (`lib/family/alerts.ts:95`, `:117-129`). `clearCircleAlerts` restores the alerts and rethrows when the write fails (`:207-221`).

---

#### `app/family.tsx` — **7.0 → 7.5**
- **Scores now:** Function 8.5 · States 8.5 · UI 7 · A11y 8 · Security 8.5 · Code 5 (mean 7.58)
- **X3 items:**
  1. ✅ **Roster Retry.**
     - `membersFailed` (`:195`) is reset on each try (`:341`) and set in the catch (`:358`).
     - The card reads "Couldn't load members" (`:1605`) and offers a labelled Retry with hitSlop (`:1611-1619`).
  2. ✅ **Member management without long-press.**
     - The row has role, label and hint (`:1346-1348`).
     - When the viewer can manage the member, there is a named `manage` accessibility action (`:1349-1352`) and a visible ⋯ "Manage {name}" button (`:1402-1408`).
     - The help copy is updated (`:2338`).
  3. ✅ **Roles.**
     - Hub: "New space" (`:1567`), "View all members" (`:1624`), the map preview (`:1643`), "+ Invite" (`:2055`) and "View all alerts" (`:2183`).
     - Cards and links: the driver, run and trip cards (`:1946`, `:1989`, `:2024`) and the ops map link (`:1977`).
     - Extracted sheets: the check-in tiles as a radio group with selected/checked state (`CheckinSheet.tsx:122-131`), Send and I'm OK (`:151`, `:162`), and Post with busy state (`AnnouncementSheet.tsx:229-231`).
     - The ratchet counter finds 0 unroled touchables.
  4. ✅ **Manage rows.**
     - "Invite from contacts" is gated on `canInvite` (`:2247`).
     - There is now one "Create or join another space" row → `/family-setup?from=family` (`:2263-2264`).
  5. ◐ **Size.** Done:
     - The three sheets moved out (`:605-610`, `:666-670`, `:2353-2357` call sites).
     - One `as any` remains (`:1748`).
     - `currentPlan()` is called once per render (`:1413`).
     - The background flow is one helper (`:686-688`, used at `:705` and `:1010`).
     - Not done: the file is still 2436 lines.
  6. ✅ **Shared helpers.**
     - `colorFor`/`ago` come from `lib/family/memberFormat.ts` (`:83`).
     - `formatMetres` replaces `dist` (`:1306`).
- **Regressions:** none of behaviour.
  - Zero-space users now land on `/family-setup` (`:283`, `:565`, `:1193`) instead of `/group-create`. That screen links to group-create and adds join-by-code, so it is a functional superset. Its copy is family-specific, though ("Family Circle", "Your family, privately", `family-setup.tsx:61`, `:68`), even when the user came from a non-family space hub.
  - Nit: `memberFormat.ts:10` says "so the selftest runs under tsx", but no `memberFormat.selftest.ts` exists.
- **Subscreens:**
  - Expanded map + roster: 7 → 7.5. Rows are now accessible, and the map has a summary label. Still `maxHeight: 190` (`:1509`), and the map is light-only.
  - Sections grid: 8 → 8.
  - Check-in sheet (`CheckinSheet.tsx`): 7 → 8.5. Radio tiles, labelled note with `maxLength` 200 (`:145-146`), header role, labelled backdrop.
  - Announcement sheet (`AnnouncementSheet.tsx`): 8 → 9. Labelled input, Post with busy/disabled state.
  - Manage sheet: 7.5 → 8.5. Gated invite, one create row, labelled backdrop (`:2223`), rename input with label and `maxLength` (`:2237`).
  - Crash countdown (`CrashCountdown.tsx`): 8 → 8.5. Assertive live-region count (`:40-41`) and a header role. "Send SOS now" is still unlabelled beyond its text.
  - Member actions: 6 → 8. Reachable by ⋯ and by the a11y action.
  - SOS outcome dialog: 8 → 8.
  - Roster error state (new): 8.
- **Still needed for 10/10:**
  1. **Split the 2436-line component further.** Candidates: the manage sheet (`:2215-2350`), `memberRow` (`:1293-1411`), the runs and trip cards (`:1941-2040`). Clear the four exhaustive-deps warnings (`:297`, `:361`, `:608`, `:814`).
  2. **Round positions before the hub's matrix call.** The key is rounded (`:899-907`), but `fetchMatrix(targets.map((t) => t.pos), origin, …)` sends full-precision member positions (`:919-920`). Do what `family-map.tsx:388` now does.
  3. **Reach the nested row buttons with a screen reader.** The accessible row `Pressable` (`:1343-1352`) groups its children, so on iOS VoiceOver cannot reach "Show on map" or "Navigate to" (`:1388-1401`). Add them as accessibility actions, as was done for `manage`.
  4. **Let the expanded roster grow.** Use a proportional height instead of `maxHeight: 190` (`:1509`), and show the roster error state there too.
  5. **Make family-setup's copy fit every space.** Zero-space users from any space type now land there (`:283`).
  6. **Seal the location-store upload** (shared with family-setup; `lib/family/presence.ts:426-434`).

#### `app/family-map.tsx` — **7.0 → 7.5**
- **Scores now:** Function 8 · States 8 · UI 7 · A11y 8 · Security 7.5 · Code 6.5 (mean 7.5)
- **G1 items:**
  1. ✅ **Routing egress.**
     - There is one `/nav/matrix` call (`:401`). Every position is rounded to 0.001° first (`:388-394`), and the call is keyed on those rounded positions.
     - Connectors show "… by road" from the matrix, or the straight line until it answers (`:621-625`).
     - The always-on per-member `fetchRoute` is gone. A route is fetched only on a request: a member's Route, From-Home or the destination (`:304`, `:340`, `:363`).
     - The header states what reaches the routing server (`:11-15`).
     - Meet Here still sends full-precision origins (`MeetHereSheet.tsx:97`). That is a user-initiated action.
  2. ✅ **Follow bar.** It renders only when `showFollowBar` (`:583`, `:1080`).
  3. ✅ **Places load caught** (`:256-262`).
  4. ◐ **Theme-aware map.**
     - Done: a text alternative. The WebView is one accessible element with a summary of who is shown, stale dots and labels (`FamilyMap.tsx:799-813`).
     - Not done: the basemap is still light. This is now a documented decision (`FamilyMap.tsx:779-782`).
  5. ✅ **`MeetHereSheet` controls.**
     - Close has hitSlop (`:141-142`).
     - Clear has a role and hitSlop (`:163-164`).
     - Chips are labelled (`:178-179`), and result rows have role and label (`:214-215`).
     - A failed search says so, in a polite live region (`:226-229`).
  6. ◐ **`thenEvent` / `mrCache`.**
     - The `mrCache`/`mrVersion` refs are gone.
     - `thenEvent` was dropped with a `ponytail:` note (`NavigationLayer.tsx:43-46`). The handoff that would add it to `NavBanner` was not done, so spec §17's "then" chip is absent.
  7. ❌ **Device verification** of the slot model and nav overlay is still pending.
- **Regressions:**
  - **Dead code in `FamilyMap`.** This screen was the only caller of `FamilyMap`'s `memberRoutes`, and a repo grep finds no `memberRoutes=`. The prop, the `memberRoutesJs` memo and the injected `setMemberRoutes` are now unreachable (`FamilyMap.tsx:577`, `:617`, `:748-766`, and the WebView functions at `:195`/`:445`).
  - **Changed default.** The Lines FAB still defaults to drawing connectors, but they are now dashed straight lines with road figures, not road shapes. This is a deliberate privacy trade, and the log records it under Decisions.
- **Subscreens:**
  - `FamilyMap` WebView: 7 → 7.5 (summary label; still light-only; `originWhitelist={['*']}` `:815`).
  - `MeetHereSheet`: 7.5 → 8.5.
  - `SelectedMemberSheet`: 8 → 8 (unchanged).
  - `NavigationLayer`: 7 → 7.5 (dead prop removed, 2 `as any` gone; no THEN chip).
  - Trip and Leave-now bars: 7.5 → 7.5.
  - Route, turn and follow bars: 7 → 8 (follow-bar slot).
  - Saved-place chips: 8 → 8.
  - Roster sheet: 7.5 → 7.5.
  - Connector labels (new): 8.
- **Still needed for 10/10:**
  1. **Remove the now-dead `memberRoutes` path** from `FamilyMap.tsx` (`:577`, `:617`, `:748-766`, `:195`, `:445`). Otherwise route it back through the Lines toggle for a single member.
  2. **Add the "then" maneuver** to `NavBanner` (`lib/nav/navigationService.ts`), and re-add the chip (`NavigationLayer.tsx:43-46`).
  3. **Split the 1309-line screen**, for example the bars and the slot model into components.
  4. **Offer a dark basemap or a high-contrast option**, or record the light-only choice in the theme exemptions (`FamilyMap.tsx:779-782`).
  5. **Round or disclose the Meet Here origins** (`MeetHereSheet.tsx:97`).
  6. **Device-verify** the slots, the follow bar and the matrix labels.

#### `app/family-add.tsx` — **7.5 → 8.0**
- **Scores now:** Function 8 · States 8.5 · UI 8 · A11y 8.5 · Security 8 · Code 8 (mean 8.17)
- **G1 items:**
  1. ✅ **Bounded code.**
     - `circleInviteCode` mints 1 use and 24 h (`lib/family/circle.ts:64-71`).
     - The server already enforces both on join (`vaultchat-backend-go/internal/routes/chats.go:1873`; `chats_helpers.go` cols `:1782`). This enforcement predates round 3, so it is not a backend dependency.
     - Sharing asks first, with honest copy (`:151-172`; it mentions locations only for spaces), and the shared text states the limits.
  2. ✅ **Retry.** The error bar has a polite live region and a labelled Retry (`:238-247`). A failed load no longer renders "No contacts" (`:253-256`).
  3. ✅ **Space ground.** `SpaceGround`/`G.bgTop` are used when opened from a space (`:207-213`). Group-info keeps the aurora.
  4. ✅ **Search input labelled** (`:223`).
- **Regressions:** none.
- **Subscreens:** share-code confirm (new): 8.5.
- **Still needed for 10/10:**
  1. **Make several invites easy.** Each share mints a new one-use code, so inviting three people means three confirm-and-share rounds (`:151-172`). Consider a "how many people" choice capped server-side.
  2. **Use space tokens throughout.** `makeStyles` still uses `c.danger + '22'` and similar hex concatenations (`:327`), plus 3 hex literals (`lib/uiDebtRatchet.baseline.json:106-108`).
  3. **Device-verify** the share sheet and the `SpaceGround` header seam.

#### `app/family-alerts.tsx` — **8.0 → 8.5**
- **Scores now:** Function 9 · States 9 · UI 8 · A11y 8 · Security 8 · Code 9 (mean 8.5)
- **G1 items:**
  1. ✅ **Background taps** (`lib/callBackground.ts:46-50` → `deliverTap` → root opener, `app/_layout.tsx:452`). This is static only; a device check is still needed.
  2. ✅ **`ready` waits for the store.** `loadAlerts` returns the shared in-flight read (`lib/family/alerts.ts:117-129`), and the screen sets `ready` after it (`:73`).
  3. ✅ **A failed clear is surfaced** (`:95-97`). The store reverts and rethrows (`lib/family/alerts.ts:212-220`).
- **Regressions:** none.
- **Subscreens:**
  - Filter tabs: 8 → 8.
  - Clear-history confirm: 8 → 9.
- **Still needed for 10/10:**
  1. **Expose the filters as tabs.** Use `accessibilityRole="tab"` inside a `tablist`, not `button` + selected (`:125-127`).
  2. **Disable or hide the header trash icon when nothing is listed** (`:114`).
  3. **Device-verify** background taps on a locked and an unlocked phone.

#### `app/family-history.tsx` — **7.5 → 8.0**
- **Scores now:** Function 8 · States 8 · UI 8 · A11y 8 · Security 7.5 · Code 8 (mean 7.92)
- **G1 items:**
  1. ✅ **Timeline follows the picker** (`:188`, deps `:196`).
  2. ✅ **Unknown permission is resolved by asking the server** (`:107`; `lib/family/historyGate.ts:19-34`).
     - If the server cannot be asked, the call throws into the existing `loadFailed` + Retry state.
     - `locationEgress` still passes.
  3. ◐ **Map-matching disclosed on screen** (`:302-311`). It is still automatic, not opt-in (`:160-172`).
- **Regressions:** none.
  - Minor: circle-wide, the timeline now hides `actorId === 'system'` rows unless no member is shown (`:188`).
  - Code nit: `(p: any)` at `:168`.
- **Subscreens:**
  - Range tabs: 8.
  - Locked view: 8.
  - Trips list: 8.
  - Member picker: 8 → 8.5.
- **Still needed for 10/10:**
  1. **Make `/nav/trace` matching opt-in**, or round the points first (`:160-172`).
  2. **Type the trace mapper** (`:168`), and replace the `require()` (`:167`).
  3. **Decide where circle-wide system events belong** (`:188`).

#### `app/family-items.tsx` — **6.5 → 7.5**
- **Scores now:** Function 7.5 · States 8 · UI 7 · A11y 8 · Security 7.5 · Code 7.5 (mean 7.58)
- **G1 items:**
  1. ✅ **Crowd-find is real.**
     - The new pure `lib/items/crowd.ts` has `familyTags` and `dueSightings`, with a selftest.
     - While scanning, the screen reports other members' tags it hears, at most once a minute per tag (`:216-232`), sending the place name only (`:203-210`; `lib/items/api.ts:68-77` sends `lat/lng: null`).
     - It lists those tags under "FAMILY'S THINGS" (`:388-410`).
     - Other members' tags are no longer offered for pairing (`:234-241`).
     - The footer matches the behaviour (`:453-458`).
  2. ✅ **Pairing and handlers.**
     - Pairing is a `<Modal>` with `KeyboardSafe` and a labelled backdrop (`:463-466`).
     - The `saving` guard comes with a spinner and busy state (`:84`, `:246-256`, `:494-498`).
     - `removeItem` is wrapped in try/catch (`:351-355`).
  3. ✅ **Labels and dead write.** The input is labelled with `maxLength` 80 (`:473-474`). `leftBehindAlerts` is no longer written (`:252`).
- **Regressions:** none of behaviour.
- **New observations:**
  - `reportFamilySighting` marks a tag "by you" locally even when the report failed (`:207-209`).
  - A sighting reports the reporter's own saved-place name, such as "Home", against another member's tag, to the whole space (`:205-207`). The footer says the phone reports tags it hears, but not that it reveals the searcher's place.
- **Subscreens:**
  - Nearby-devices list: 8 → 8.
  - Pairing sheet (now a Modal): 6 → 8.
  - Remove confirm: 7 → 8.
  - Family's things list (new): 7.5.
- **Still needed for 10/10:**
  1. **Disclose that a sighting carries your place name**, or send "near {member}" or nothing (`:203-210`, footer `:454-458`).
  2. **Update "by you" only after the report succeeds** (`:207-209`).
  3. **Wire a background scan for left-behind alerts**, or keep it out of the spec (`:447-451`).
  4. **Reuse `ago` from `lib/family/memberFormat.ts`.** It has a local copy with different wording (`:276-283`).
  5. **Move the backdrop and the `colors.danger + '18'` concatenations onto tokens** (`:297`, `:520`).

#### `app/family-member.tsx` — **7.0 → 7.5**
- **Scores now:** Function 8 · States 8.5 · UI 7 · A11y 7.5 · Security 7.5 · Code 7 (mean 7.58)
- **X3 items:**
  1. ✅ **`/nav/trace` throttled.** `trackKey` now uses the first ts plus the minute of the last sample, so there is at most one upload per minute of track (`:44-49`, `:231-233`). It keeps the `length < 2` guard, and `locationEgress` passes.
  2. ✅ **Unknown permission is asked, not assumed** (`:146` → `lib/family/historyGate.ts:19-34`). A failure goes to the existing "not loaded" state.
  3. ✅ **A failed self lookup hides Message/Call** (`!!selfId`, `:467-468`).
  4. ✅ **Helpers shared** (`:38-39`). The guardian star is labelled (`:401`).
  5. ✅ **Retry has a busy guard**, spinner and state (`:115`, `:439-447`).
  - ✅ **One identity lookup**, memoised (`:118-127`, `:147`).
- **Regressions:** none.
- **Subscreens:**
  - Withheld state: 8 → 8.
  - Load-failed notice: 7.5 → 8.5.
  - Relationship chips: 8 → 8.
  - Route-to-stale confirm: 8 → 8.
- **Still needed for 10/10:**
  1. **Disclose map-matching on screen.** The day's whole track still goes to `/nav/trace` up to once a minute while the screen is open, and the travelled figure (`:524`) does not carry family-history's routing-server caption (`family-history.tsx:302-311`).
  2. **Use the real relationship role.** The chips use `button` + selected instead of a radio group (`:488-492`).
  3. **Replace the lazy `require()`s** (`:240`, `:271`), and the remaining `eslint-disable` on the pull callback (`:137`).
  4. **Edge case: a circle missing from the local registry.** `historyAccess(null)` returns `'allowed'` (`lib/groups/store.ts:117`), so a deep link to it skips the server check.

#### `app/family-places.tsx` — **7.5 → 8.0**
- **Scores now:** Function 8.5 · States 8.5 · UI 8 · A11y 8.5 · Security 8 · Code 7 (mean 8.08)
- **G1 items:**
  1. ✅ **Roles and labels.**
     - Edit-sheet buttons: Navigate, Unlock/Lock and "View live lock status" (as `link`, with hitSlop), plus Save, Delete and the backdrop (`:590-619`, `:460`).
     - All four inputs are labelled, with `maxLength`s (`:328`, `:335`, `:473`, `:480`).
     - `CHIP_SLOP` is applied to every chip (`:66`, `:347`, `:396`, `:489`).
  2. ✅ **Ordering and errors.**
     - `remove` and `saveEdit` persist first (`:230`, `:300`).
     - `chooseRef` reverts and alerts (`:129-138`).
     - Arm and unlock failures are surfaced: "Could not lock" (`:257-264`) and "Still locked" (`:276-279`).
  3. ✅ **Existing lifetime shown.** An "Until {day time}" chip appears for a timed zone (`:547-563`).
- **Regressions:** none. Nit: misaligned `style=` indentation after the inserted `hitSlop` (`:348`, `:490`).
- **Subscreens:**
  - Edit-place sheet: 8 → 8.5.
  - Lock/unlock confirms: 8 → 8.5.
  - Delete confirm: 8 → 8.5.
- **Still needed for 10/10:**
  1. **Add a busy/disabled guard to the edit-sheet Save** (`:283`, `:616`). `add` has one (`:199`, `:354`).
  2. **Split the 649-line file**, starting with the edit sheet. Fix the indentation at `:348` and `:490`.
  3. **Use radio roles for the single-choice chip groups** (radius, presets, lifetimes; `:344-348`, `:504-506`, `:566-571`).

#### `app/family-setup.tsx` — **8.0 → 8.0**
- **Scores now:** Function 8 · States 8 · UI 8 · A11y 9 · Security 7.5 · Code 7.5 (mean 8.0)
- **X3 items:**
  1. ❌ **Location-store upload is still plaintext.** It is disclosed (`:69`), and not changed (`lib/family/presence.ts:426-434`). Deferred: it needs a backend design.
  2. ✅ **Offered from the hub's zero-space path** (`family.tsx:283`, `:565`, `:1193`). The manage row is now the single create/join entry (`family.tsx:2263`).
  3. ✅ **Name `maxLength` 100, code `maxLength` 64** (`:76`, `:100`). The `as any` casts are gone (`:26`, `:86`).
  4. ❌ **Device verification** of create → hub and the `dismissTo` return is still pending.
- **Regressions:** none.
  - Now that zero-space users land here from any space type, the "Family Circle" title and "Your family, privately" hero (`:61`, `:68`) read oddly for, say, a school-transport user.
  - A pending join calls `router.back()` without a `canGoBack()` check (`:48`), which matters on a deep-link entry.
- **Subscreens:** none (Alerts only).
- **Still needed for 10/10:**
  1. **Seal the location-store upload**, or offer an opt-out of server retention (`lib/family/presence.ts:426-434`).
  2. **Use neutral copy when not opened from a family space** (`:61`, `:68`). Guard `router.back()` with `canGoBack()`, and fall back to `replace` (`:48`).
  3. **Device-verify** create → hub and the `dismissTo` return (`:27`).

---

### G2 — Location, Navigation & Safety — re-rating (round 3)

This is a static, read-only review from `b8c8bd2` to HEAD (`c28d1b2`), using the same rubric (`RUBRIC.md`) and format (`RERATE.md`).
- **Baselines.** The "Old" scores are the ones given in the task. The open items come from:
  - `rerate2/X3.md` for emergency-sos, location-lock, lock-alert and lock-history.
  - `rerate/G2.md` for location, navigate, lock-settings, trusted-contacts and aiguardian.
- **What I read.** I read all 9 screens in full at HEAD, each with its `git diff b8c8bd2 HEAD`. I also read these helpers:
  - Diffs of `components/LocationMap.tsx`, `components/nav/NavBanner.tsx`, `components/nav/NavMap.tsx` (plus its full tail, `:370-489`), `lib/nav/urlCoords.ts` and `lib/lock/lockSettings.ts`.
  - The new files `lib/lock/alarmPalette.ts` and `lib/nav/typedCoords.selftest.ts`.
  - `lib/useReducedMotion.ts`, `lib/lock/lockStore.ts:188-199`, `lib/map/tileProvider.ts:22-80`, `lib/vaultIdLink.ts:10-28` and `services/security/deviceSecurity/viewModel.ts:14-23`.
  - Every caller of `setLockSettings` and `setLockAlerts`.
- **Uncommitted work.** The working tree matches HEAD for every file here. The only uncommitted change, `components/status/GatePicker.tsx`, is outside this batch.
- **Fix claims.** I checked all 44 "Fixed" rows and the deferred and not-reproduced rows of `fixes/ZG2.md` against the code. They all landed in `6961c04`. One claim is false: deferred #2 says viewModel's `STATUS_META` "is not exported". It is exported, at `services/security/deviceSecurity/viewModel.ts:18`, and it was already exported at `b8c8bd2`.
- **Entry points.** None of these were lost in round 3, including the chat.tsx split. The current entries are:
  - `/location`: `app/chat.tsx:1933`.
  - `/navigate`: `app/(tabs)/mini.tsx:44` and `lib/nav/openNavigation.ts:16,23`.
  - `/location-lock`: `navigate.tsx:214`, `family-places.tsx:611` and `lockService.ts:470`.
  - `/lock-alert`: `lockService.ts:195,470`.
  - `/lock-history` and `/lock-settings`: `location-lock.tsx:392-396,556,579`.
  - `/emergency-sos`: `family.tsx:1018,1811,2334` and `lib/spaces/layout.ts:94`.
  - `/trusted-contacts`: `emergency-sos.tsx:208,397,425` and `notifications.tsx:175,336`.
  - `/aiguardian`: `mini.tsx:59`.

**Evidence I ran.** Nothing was device-tested, and none of the backend work is deployed.
- `npx tsc --noEmit -p .` exited 0 with no output (`rerate3/G2_tsc.txt`).
- `npx eslint` on the 16 changed or new files gave 0 errors and 2 warnings: `NavMap.tsx:348` and `:373`, both missing deps (`lock`, `pin`) on lines round 3 did not change. The `navigate.tsx` `params.name` warning from round 1 is gone.
- These `npx tsx` selftests all exited 0, with logs in `rerate3/G2_st_*.txt`:
  - typedCoords (new)
  - urlCoords self-check
  - lockHistoryUnits
  - tileProvider self-check
  - a11yCoverage
  - themeCoverage (22 passed, 20 exemptions)
  - screenBackCoverage
  - responsiveCoverage
  - permissionDeadEnd (5)
  - silentFailure
  - keyboardAvoidance (4)
  - uiDebtRatchet ("no file got worse")
  - locationEgress
  - rowOverflow (6)
  - orphanRoutes (51)
  - navE2E (1540 assertions). It still prints the known esbuild "Unexpected typeof" line from `react-native/index.js`.

| Screen | Old | New | Δ |
|---|---|---|---|
| `app/location.tsx` | 6.5 | 7.5 | +1.0 |
| `app/navigate.tsx` | 7.0 | 7.5 | +0.5 |
| `app/location-lock.tsx` | 7.0 | 7.5 | +0.5 |
| `app/lock-alert.tsx` | 7.0 | 7.5 | +0.5 |
| `app/lock-history.tsx` | 7.0 | 7.5 | +0.5 |
| `app/lock-settings.tsx` | 6.5 | 7.5 | +1.0 |
| `app/emergency-sos.tsx` | 7.0 | 7.5 | +0.5 |
| `app/trusted-contacts.tsx` | 7.0 | 7.5 | +0.5 |
| `app/aiguardian.tsx` | 7.5 | 8.0 | +0.5 |

**Regressions from round 3.** These are the only ones. Neither is functional or security-relevant.
1. **`location-lock.tsx:179-181`: the mode-save failure copy is false.**
   - The alert says "The previous mode is still in use".
   - Since round 3, `setLockSettings` writes the new mode into memory and emits it *before* it rethrows a storage failure (`lib/lock/lockSettings.ts:73-82`). `armLock` reads that in-memory value (`lib/lock/lockService.ts:300, 308`), and the chips show the new mode as selected (`location-lock.tsx:510`).
   - So the new mode is in use. It is just not persisted. `lock-settings.tsx:46` words the same failure correctly.
   - Before round 3, `setLockSettings` never rejected, so this copy could not show.
2. **`aiguardian.tsx:134-135`: the `ponytail:` comment rests on a false premise.**
   - It says `STATUS_META` "is not exported". It is exported (`viewModel.ts:18`).
   - So the hard-coded `'#EF4444' : '#F59E0B'` at `:136` could have been `STATUS_META[a.severity].color` with no change outside this file.

---

#### `app/location.tsx` — **6.5 → 7.5**
- **Scores now:** Function 7.5 · States 8.5 · UI 7.5 · A11y 8 · Security 7 · Code 7.5 (mean 7.67)
- **Original items (rerate/G2.md):**
  1. ✅ **GPS-failure retry.**
     - `locate(ask)` runs on mount, and on Try again (`:106-131`). It sets `gpsError` on failure (`:121-122`).
     - The address card shows "Couldn't get your location" with a labelled Try again button (`:281-289`).
     - LocationMap gets the new `nofix` status (`:271`). It shows a "No GPS fix" card with no spinner (`components/LocationMap.tsx:197-207`), or the "Last known · no current fix" badge (`:275-281`).
  2. ✅ **Denied face re-checks permission.** An AppState `active` listener runs only while `permDenied` is set, and calls `locate(false)`, which does not prompt (`:135-139`).
  3. ✅ **Denied-face roles.** "Open settings" has a role and hint, and its `openSettings()` rejection is caught (`:241-242`). Back has a role and `hitSlop={12}` (`:245`).
  4. ◐ **Live session still ends when you leave the screen** (`:167-168`). This was deferred as a product decision, and the copy is still honest (`:312, 355-358`).
  5. ✅ **Code tidy-up.**
     - `<AuroraBackground/>` is now on the main face (`:257`), and the unused `back` style is gone.
     - `errText(e: unknown)` replaces `e: any` (`:48, 151, 188, 220`).
     - `beginLive` is folded into one `startLive` `useCallback`, and the `eslint-disable` is gone (`:170-233`).
     - The unmount stop is `useEffect(() => stopLive, [stopLive])` (`:168`).
     - `liveCard` uses `c.danger` with alpha (`:389`).
  6. ✅ **Duration chips while starting.** They are disabled while `startingLive`, with radio `checked`, `selected` and `disabled` states (`:336-338`).
- **Regressions:** none.
- **Subscreens:**
  - Permission-denied state: 6 → 7.5 (re-check on return, roles).
  - GPS-failure state: new, 8.
  - Live-sharing mode: 6 → 6.5 (chips locked while starting; the session still dies on leave).
  - LocationMap: 8.5 → 9 (honest `nofix` state; the recentre FAB gets `hitSlop={6}`, `LocationMap.tsx:287`).
- **Still needed for 10/10:**
  1. **Wrong copy after a GPS failure.**
     - Once `gpsError` is set and there is no fix, `loading` is false, so Send and Start are enabled (`:320, 346`).
     - Tapping either then says "Please wait — Still getting your location…" (`:142, 172`), which is false at that point.
     - Fix: disable both buttons while `!loc`, or point the alert to Try again.
  2. **Live session.** Either move it into a service so it survives leaving the screen (`:167-168, 207-231`), or keep the current honest copy as the product decision.
  3. **Stop event sent when nothing is live.** The unmount `stopLive` emits `live_location_stop` even when no session was ever started (`:158-168`). Guard it on `watchRef.current`/`live`.
  4. **Side effect inside a state updater.** `stopLive()` is called from inside the `setTimeLeft` updater (`:227-229`). Move it into an effect keyed on `timeLeft === 0`.
  5. **Missing radiogroup.** Wrap the duration radios in `accessibilityRole="radiogroup"` (`:330`).

#### `app/navigate.tsx` — **7.0 → 7.5**
- **Scores now:** Function 8 · States 8 · UI 7.5 · A11y 7.5 · Security 7.5 · Code 7 (mean 7.58)
- **Original items (rerate/G2.md):**
  1. ✅ **Coordinate range checks.**
     - Typed input goes through `typedCoords()`, an anchored regex with a ±90/±180 check (`lib/nav/urlCoords.ts:27-32`). Out-of-range input alerts "Not a valid position" (`navigate.tsx:129-134`).
     - Deep-link `lat`/`lng` are checked with `inLatLngRange` (`:100-103`).
     - Pinned by `lib/nav/typedCoords.selftest.ts`, which passes. It covers the "Plot 45, 12th Cross" case at `:52`.
  2. ✅ **NavBanner and NavMap a11y.**
     - The NavBanner instruction has `accessibilityLiveRegion="polite"` (`NavBanner.tsx:52`), plus an iOS `announceForAccessibility` keyed on the text (`:33-39`).
     - The NavMap zoom, view-toggle and recentre buttons have roles. The view toggle also has `accessibilityValue` (`NavMap.tsx:448-466`).
  3. ✅ **Theme and missing basemap.**
     - The theme scheme now reaches tileProvider (`NavMap.tsx:392`). tileProvider deliberately serves `liberty` for both themes (`lib/map/tileProvider.ts:31`), so the basemap stays light by documented decision.
     - On the Leaflet path with no `RASTER_FALLBACK_URL`, a "Street map unavailable on this device" notice now shows (`NavMap.tsx:433-444`).
  4. ✅ **Lock entry, colour and keys.**
     - The Location Lock entry has a role, a label with distance and state, and a hint (`navigate.tsx:214-220`).
     - `colors.success` replaces `#22C55E` (`:220-223`).
     - Suggestions are keyed by `lat,lng,label` (`:254`).
  5. ✅ **Preview failure is no longer silent.** `previewNote` explains "position isn't available" or "couldn't preview a route" in a polite live region (`:73-90, 276-278`).
  6. ✅ (extra) **Code and duplication.**
     - `Chip` is hoisted (`:352-361`) and `e: unknown` replaces `e: any` (`:156`).
     - The instruction is no longer duplicated in the sheet, which now carries the trip summary (`:189-198`).
- **Regressions:** none.
- **Subscreens:**
  - Setup mode: 7 → 7.5
  - Active navigation: 6.5 → 7.5 (instruction de-duplicated)
  - Route alternative chips: 7 → 7 (not device-verified)
  - NavBanner: 6.5 → 8 (live region plus the iOS announcement; not device-verified)
  - NavMap: 6.5 → 7.5 (roles, no-basemap notice, typed `camIcon`; still 2 eslint dep warnings at `:348, 373`)
- **Still needed for 10/10:**
  1. **Unlabelled search input.** The destination `TextInput` has only a placeholder (`:243-247`). `location-lock.tsx:451` shows the pattern to copy.
  2. **Silent paths in deep links and preview.**
     - An out-of-range deep link is dropped with no feedback (`:100-103`).
     - If `fetchRoutes` resolves with zero routes, no note shows (`:82-91`).
  3. **Remaining distance shown twice.** It appears in the banner sub-line ("… left", `NavBanner.tsx:55-56`) and again in the sheet ("… to go", `navigate.tsx:192-193`). Keep it in one place.
  4. **NavMap dependency warnings.** Fix the two missing-dependency warnings (`NavMap.tsx:348, 373`).
  5. **Chip semantics.** The single-choice chips (profile, mode, timing, travel mode) could be radios inside a radiogroup (`:308-326, 352-356`).
  6. **`eslint-disable` for the route-options key.** It is still in place (`:95-98`). This was deferred; it works.

#### `app/location-lock.tsx` — **7.0 → 7.5**
- **Scores now:** Function 7.5 · States 8 · UI 7.5 · A11y 8 · Security 7.5 · Code 7 (mean 7.58)
- **Original items (rerate2/X3.md):**
  1. ✅ **Permission denied on mount, and "Current location" busy state.**
     - Denied on mount: `firstFix` sets `locDenied` (`:114-123`). An inline "Location permission needed" card with Settings shows (`:416-430`), and the grant is re-checked on AppState `active` (`:150-154`).
     - "Current location": `useCurrent` has a `locating` spinner with busy and disabled state (`:156-176, 432-434`). A denial goes to `permissionDenied(..., canAskAgain)` (`:161-164`).
  2. ✅ **Ticker.** A `Ticking` child re-renders only the "Locked" stat and the "GPS updated" line (`:62-69, 347, 353-357`). The screen-level interval is gone.
  3. ✅ **A11y gaps.**
     - The background banner has a role and hint (`:360-361`). The Lock button has `disabled` and `busy` state and a hint (`:570-573`).
     - The radius input (`:539`) and the search input (`:451`) are labelled.
     - Planning chips are `busy`, not `selected`, and their siblings are disabled (`:73-84, 373-375`). Section headers have the header role (`:415, 505, 522, 554`).
  4. ✅ **Types and colours.** `Palette` (`:74, 587`) and the Ionicons glyph type (`:40`) are used. Alarm colours come from `lib/lock/alarmPalette.ts`, and `setupMapData` is memoised (`:274`).
  5. ✅ **Swallowed failures.**
     - `restoreLock` now alerts (`:129-133`). A saved-places failure shows an inline line (`:144, 460-464`).
     - Mode-save failures alert (`:179-181`, but see the regression). Unlock failures alert (`:244`).
     - The `lastRadius` write stays best-effort, with a comment explaining why (`:212-213`).
  6. ✅ (found by the fixer) **Weak-GPS bar contrast.** Its text now uses `colors.text` on `surfaceSolid` (`:313-319`).
- **Regressions:** the mode-save copy described at the top (`:179-181`).
- **Subscreens:**
  - Active face: 7.5 → 8
  - Setup face: 7 → 8
  - Background-protection Alert: 7 → 7. The result of `enableKillSafe()` is ignored (`:218`), and so is the banner's (`:360`).
  - Battery Alert: 7 → 7
  - Unlock confirm: 8 → 8.5 (a failure now alerts)
  - NavMap: 6.5 → 7.5
- **Still needed for 10/10:**
  1. **Mode-save copy.** Reword it to match `lock-settings.tsx:46`: applied now, but not saved (`:179-181`).
  2. **Refused kill-safe grant is silent.** When `enableKillSafe()` returns false from the arm alert (`:218`) or the active-face banner (`:360`), nothing is said. Reuse the message from `lock-settings.tsx:109-111`.
  3. **No unmount guard in `firstFix`.** It sets state after awaits without one (`:114-123`). `useCurrent` is a plain handler with a hook-style name; rename it, for example to `pickCurrent` (`:156`).
  4. **Stats read as fragments.** The active-face stat grid is unlabelled, so each label and value is a separate element (`:343-352, 587-594`). Make each `Stat` one accessible element.
  5. **File size.** At 623 lines, the setup and active faces could be split into two components.

#### `app/lock-alert.tsx` — **7.0 → 7.5**
- **Scores now:** Function 7.5 · States 8 · UI 7.5 · A11y 8 · Security 7.5 · Code 7.5 (mean 7.67)
- **Original items (rerate2/X3.md):**
  1. ✅ **Reduced motion.** `useReducedMotion()` stops the loop and holds `ALARM.flashLow` (`:29, 48-56`). Siren, vibration and voice are not affected. Not device-verified.
  2. ✅ **Palette.**
     - The `ALARM` named palette is used throughout (`:60, 101, 129-131, 163-164, 173-189`), and NavBtn `icon` is typed (`:150`).
     - The safe face uses `c.bg`, a green wash, `c.text`/`c.textDim` and `c.success` (`:81-92, 174-175`).
     - The safe button is `#15803D`; I computed about 5.0:1 against white.
  3. ✅ **Sibling NavBtns while planning.** All three are disabled while any mode plans, with `busy` and `disabled` state (`:155-162`).
  4. ✅ (found by the fixer) **Stop Alarm contrast and restore failure.**
     - Stop Alarm sits on solid white, so it is no longer red on red (`:129-131`).
     - A `restoreLock` failure now alerts (`:37-41`).
- **Regressions:** none.
- **Subscreens:**
  - Alarm mode: 7.5 → 8
  - Safe mode: 7 → 8
- **Still needed for 10/10:**
  1. **Secondary-text contrast.** `ALARM.inkMuted` (`#FECACA`) on the bright flash end `#DC2626` is about 3.3:1 by my calculation. That is below 4.5:1 for the 11.5–13.5 pt secondary lines (`:177-181`, `:143`). Use `ink` or `inkSoft` for those lines.
  2. **First-frame flash.** `useReducedMotion` returns false until its first async read resolves (`lib/useReducedMotion.ts:9-12`), so up to one flash cycle can run before it stops. Start this screen with the loop off until the setting is known.
  3. **Announce on mount.** Add a one-shot `announceForAccessibility` when the screen mounts. The fixer deferred this as optional; the assertive phase line already exists (`:117`).

#### `app/lock-history.tsx` — **7.0 → 7.5**
- **Scores now:** Function 8 · States 8.5 · UI 7 · A11y 7.5 · Security 7 · Code 7.5 (mean 7.58)
- **Original items (rerate2/X3.md):**
  1. ✅ **Nested controls un-nested.**
     - The card is a `View`, and only the summary is the toggle. It keeps `expanded`, the hint and the delete action (`:280-306`).
     - The timeline, note input (labelled, `:334`), Save and Delete are siblings (`:308-361`). Needs a VoiceOver check.
  2. ✅ **Pagination.** `limit` (`PAGE = 100`) is passed to `getSessions(filter, limit)` (`:42, 92`; `lockStore.ts:188-198`). The footer reads "Showing the latest N · Show more" (`:252-258`).
  3. ✅ **Export and note feedback.** An export failure alerts (`:118-121`). Save shows busy, and a polite "Note saved" appears (`:152-160, 337-349`).
  4. ✅ **Retry progress.** While loading, the banner stays with "Refreshing…" and a spinner (`:227-239`).
  5. ✅ **Code tidy-up.** `trendMax` is hoisted (`:162`). `eventMeta(type, palette)` is typed and uses theme, zone and ALARM colours (`:44-57`). `Chip` is hoisted (`:61-69`), and the trend bars are labelled (`:193-194`).
  6. ✅ (found by the fixer) **Events failure.** A failed `getEvents` now shows a line instead of an empty timeline (`:115, 310-314`).
- **Regressions:** none.
- **Subscreens:**
  - Export Alert: 6 → 7.5
  - Delete-all confirm: 8.5 → 8.5
  - Per-session delete: 8.5 → 8.5
  - Timeline and note editor: 7 → 8
  - "Show more" footer: new, 7. It shows no progress while the next page loads, and `load` stays `'ok'`.
- **Still needed for 10/10:**
  1. **Summary label drops details.** The summary's `accessibilityLabel` replaces its children, so VoiceOver loses the radius, duration, alarm time, time outside and note (`:283` vs `:289-305`). Include them.
  2. **Events race.** Toggling quickly between sessions can show an older `getEvents` result under the newer session; there is no stale guard (`:108-116`).
  3. **No progress on filter change or "Show more".** `load` is not set to `'loading'` in either case (`:91-105, 253`).
  4. **Emoji in the note preview.** The `📝` (`:304`) is read aloud. Use an icon with `accessibilityElementsHidden`.

#### `app/lock-settings.tsx` — **6.5 → 7.5**
- **Scores now:** Function 7.5 · States 7.5 · UI 7.5 · A11y 8 · Security 8 · Code 7.5 (mean 7.67)
- **Original items (rerate/G2.md):**
  1. ✅ **Save failures surfaced at the root cause.**
     - `setLockSettings` now rethrows the AsyncStorage failure after updating memory (`lib/lock/lockSettings.ts:73-82`).
     - All three callers catch: `lock-settings.tsx:98-99` via `save()`, and `location-lock.tsx:179` and `:213`.
     - `save()` alerts "Setting not saved…" and, separately, "Not applied to the active lock" (`:43-52`).
     - The kill-safe toggle alerts when `enableKillSafe()` returns false or throws, and has busy/disabled state (`:102-118, 176-177`).
  2. ✅ **Battery row.** It has a role, label and hint, and alerts on failure (`:120-127, 184-192`).
  3. ✅ **Types and thumbs.** A `ChannelKey` type replaces `as any` (`:38, 67`). The off thumb is the platform default (`:70, 180, 251`).
  4. ✅ **Test chips.** They are plain actions with an `accessibilityLabel` and no selected state (`:78-90, 266-267`).
  5. ✅ (extra) **Structure.** `Row` and `Chip` are hoisted, and section headers have the header role (`:136, 142, 194, 205, 212, 222, 228, 235, 274`).
- **Regressions:** none.
- **Subscreens:**
  - Custom sensitivity panel: 7.5 → 7.5
  - Repeat-interval chips: 7.5 → 7.5
  - Battery-exemption row: 6.5 → 8
  - Background-tracking switch: 8 (explicit feedback and busy state)
- **Still needed for 10/10:**
  1. **Silent test failures.** "Test voice" and "Test vibration" swallow errors with `catch {}` (`:266-267`). A failed test of an alarm channel should say so.
  2. **Two alerts on a double failure.** When both the write and the apply fail, `save()` shows two alerts back to back (`:43-52`). Collapse them into one message.
  3. **Chip semantics.** The single-choice groups (units, mode, cadence, volume, tone, pattern, grace) use button plus `selected` (`:83-85`). Radios in a radiogroup would announce the group.
  4. **Emoji in visible labels.** The emoji remain in the visible Test chip labels (`:266-267`). They are harmless now that `accessibilityLabel` is set.

#### `app/emergency-sos.tsx` — **7.0 → 7.5**
- **Scores now:** Function 8 · States 8.5 · UI 7 · A11y 7.5 · Security 7 · Code 6.5 (mean 7.42)
- **Original items (rerate2/X3.md):**
  1. ✅ **Reduced motion and Back target.** `useReducedMotion` gates the pulse (`:101, 113-123`). Back gets `hitSlop={8}` (`:282`).
  2. ✅ **History failure surfaced.** `loadHistory` and `historyFailed` show "Couldn't load your SOS history" with Retry, and the empty copy is hidden in that case (`:147-152, 463-474`). After a send it goes through the same path (`:258`).
  3. ✅ **Tokens and types.**
     - The rgba literals are now `brandAlpha`, `c.hairline`, `c.danger` with alpha, and `c.accent` with alpha (`:508-569` styles).
     - Amber is a named `amber(light)` helper (`:498-500`).
     - `countdownTimer` is `ReturnType<typeof setInterval>` (`:100`).
     - The SOS gradient `#FF2D2D`/`#CC0000` is kept as a deliberate alarm colour (`:360`).
  4. ❌ **Server counts recipients, not deliveries.** This is backend-owned. The wording matches that: "Alerting N" (`:329-331`) and "N alerted" (`:485`).
  5. ❌ **Device check** that `/emergency-sos` opens, and the shake flow. Not verifiable statically.
  6. ✅ (X3 nit) **Empty-list refresh line.** A failed refresh with an empty last list now shows the "couldn't refresh" line (`:419-423`).
- **Regressions:** none.
- **Subscreens:**
  - Default / SOS button: 7.5 → 8
  - Countdown: 8 → 8
  - Sending: 6.5 → 6.5
  - Sent: 7.5 → 7.5
  - Shake detection: 7 → 7
  - Contacts selector: 8 → 8.5
  - History: new, 7.5 (failure plus Retry; the Retry shows no progress)
- **Still needed for 10/10:**
  1. **Server-side delivery count.** Have the server count actual push deliveries if "alerted" should mean "reached". This is backend (`user.go` `notified`), not this file.
  2. **Device-verify** that `/emergency-sos` opens and that shake works.
  3. **No unmount guard in `triggerSOS`.** It awaits the GPS fix and the send, then sets state (`:243-263`).
  4. **Accessibility action name ignored.** `onAccessibilityAction` starts the countdown without checking which action fired (`:357-358`). Branch on `actionName`.
  5. **Shake gate written during render.** `shakeGate.current` is reassigned on every render (`:265`). Write it in an effect.
  6. **A11y gaps.**
     - "SOS Contacts" and the screen title lack the header role that "History" now has (`:285, 394` vs `:462`).
     - The "✓" glyph is read aloud (`:325`).
     - The history Retry shows no progress (`:468`).

#### `app/trusted-contacts.tsx` — **7.0 → 7.5**
- **Scores now:** Function 7.5 · States 8 · UI 7.5 · A11y 7.5 · Security 8 · Code 7.5 (mean 7.67)
- **Original items (rerate/G2.md):**
  1. ✅ **VaultID validation.** `isVaultId` (already exported, `lib/vaultIdLink.ts:13`) is checked before `addTrustedContact`, with an inline polite error (`:68, 189`).
  2. ✅ **Cache written.** After a successful add (`:74`) and remove (`:91`), and after a load (`:49`).
  3. ✅ **Labels and roles.** Cancel has a role and `hitSlop` (`:190-191`), the input is labelled and submits on Enter (`:177-178`), and the header has the header role (`:106`).
  4. ✅ **Danger colours.** The `removeBtn` uses `c.danger` with alpha (`:223`).
  5. ✅ (found by the fixer) **Cold-load failure.** It shows "Couldn't load your trusted contacts" with Retry, and Add is hidden until the list loads (`:41-55, 145-151, 161`).
- **Regressions:** none.
- **Subscreens:**
  - Add-by-VaultID form: 7 → 8
  - Remove confirm: 8 → 8.5
- **Still needed for 10/10:**
  1. **Keyboard may cover the form.** The `autoFocus` VaultID input sits low in a non-scrolling `View`, with no keyboard handling (`:110, 168-195`). `lib/keyboardAvoidance.selftest.ts:12-14` says `edgeToEdgeEnabled=true` means the Android window is never resized, so the keyboard may cover it. Not verifiable statically, but there is no `KeyboardSafe` here.
  2. **Stale cache not flagged.** When the cache painted and the network refresh fails, nothing says the list may be stale (`:52`).
  3. **Emoji read aloud.** The "What trusted contacts receive" items are read as "SOS button", "test tube" (`:199-200`). Use icons hidden from accessibility.
  4. **No unmount guard** in `load` or `addByVaultId` (`:44-82`).

#### `app/aiguardian.tsx` — **7.5 → 8.0**
- **Scores now:** Function 8 · States 8 · UI 8 · A11y 8.5 · Security 8 · Code 8 (mean 8.08)
- **Original items (rerate/G2.md):**
  1. ✅ **Read failure surfaced.** `readFailed` shows "Couldn't read the last scan… may be out of date" in a polite live region (`:45, 49-55, 110-114`).
  2. ❌ **Severity colours still hard-coded** (`:136`). The deferral reason is wrong; see the regression at the top. `STATUS_META[a.severity].color` (`viewModel.ts:18-20`) is available today.
  3. ✅ **Headers and combined rows.** The section titles and the screen title have the header role (`:91, 126, 148, 175`). Each check row is one accessible element: "Label: Status. Detail" (`:159-160`).
- **Regressions:** the inaccurate `ponytail:` comment (`:134-135`).
- **Subscreens:**
  - Scan-result Alert: 7 → 7
  - Checks list: 8 → 8.5
- **Still needed for 10/10:**
  1. **Use the exported colours.** Replace `'#EF4444' : '#F59E0B'` with `STATUS_META[a.severity].color`, and delete the `ponytail:` comment (`:134-136`).
  2. **Read failure after a scan.** It can say "Scan complete" and then show the stale-read notice: `finally` calls `load()` (`:78-79`) after `setVm(view)` (`:68`). Skip the reload once a scan has produced a snapshot.
  3. **Long alert body.** The scan-result Alert body can be long, a bullet per action (`:69-74`). An in-screen result card would be easier to read and to navigate with a screen reader.

---

### H — Spaces — round-3 re-rating

Base `b8c8bd2` → HEAD (`5d7c50b`). The round-3 Spaces work is the single commit `e82ccc4` (fix log `fixes/ZH.md`), plus later commits that do not touch these files. This is a static, read-only review. Nothing here is deployed or device-verified.

The backend endpoints in `fixes/ZBE.md` are written but **not deployed**:
- `GET /chats/{id}/shift`
- `riders[].guardians`
- in-place stop ids / `stopIds`

Client code that depends on them is scored only for how it behaves against today's server. I checked that behaviour for each:
- `loadShift` falls back to the device copy on any throw (`lib/spaces/shift.ts:78-89`).
- With `guardians` absent, Call guardian shows the old honest Alert (`app/space-run-driver.tsx:305-312`).
- With no `stopIds`, `idsPreserved` returns false, so riders are re-mapped as before (`lib/spaces/runPlan.ts:115-118`, `app/space-runs-admin.tsx:170`).
- Whether today's Go handler ignores the extra `id` field in the stops PUT is **not verifiable statically**, because the backend repo is not in this checkout.

Old scores are the ones given in the task. Open items come from `rerate2/X2.md` (admin, devices, roster, runs-admin), `rerate/H.md` (the other 12 screens) and the original section for space-leave (`2026-10-04_screen_ratings.md:3108-3123`).

**Rounding:** overall = mean of the six scores, rounded to the nearest 0.5.

**Checks I ran (read-only). All exit 0:**
- `npx tsc --noEmit -p .`: 0 errors (`rerate3/H_tsc.txt`).
- `npx eslint app/space-*.tsx components/spaces/ lib/spaces/ lib/family/alerts.ts`: clean (`rerate3/H_eslint.txt`).
- `npx tsx` selftests:
  - `lib/spaces/leave.selftest.ts` (new), `shift.selftest.ts` and `runPlan.selftest.ts`
  - `lib/spaces/attendance.ts` and `lib/family/alerts.ts`
  - `lib/a11yCoverage`, `themeCoverage` (22 assertions), `uiDebtRatchet` ("no file got worse"), `keyboardAvoidance`, `screenBackCoverage` and `orphanRoutes` (51)
  - Outputs are in `rerate3/H_st_*.txt`.
- I did not run `npm test`.

| Screen | Old | New | Δ |
|---|---|---|---|
| app/space-admin.tsx | 7.0 | 7.5 | +0.5 |
| app/space-attendance.tsx | 5.0 | 7.0 | +2.0 |
| app/space-checkin.tsx | 6.5 | 7.5 | +1.0 |
| app/space-devices.tsx | 6.5 | 7.0 | +0.5 |
| app/space-incidents.tsx | 7.0 | 7.5 | +0.5 |
| app/space-leave.tsx | 6.0 | 7.5 | +1.5 |
| app/space-ops-map.tsx | 6.5 | 7.0 | +0.5 |
| app/space-overview.tsx | 6.5 | 7.5 | +1.0 |
| app/space-pending.tsx | 7.0 | 7.5 | +0.5 |
| app/space-people.tsx | 7.0 | 7.5 | +0.5 |
| app/space-roster.tsx | 7.0 | 7.5 | +0.5 |
| app/space-run-driver.tsx | 6.5 | 7.0 | +0.5 |
| app/space-run.tsx | 6.5 | 7.5 | +1.0 |
| app/space-runs-admin.tsx | 7.0 | 7.0 | 0 |
| app/space-tasks.tsx | 7.0 | 7.5 | +0.5 |
| app/space-transport.tsx | 6.5 | 7.0 | +0.5 |
| app/space-visitors.tsx | 6.5 | 7.5 | +1.0 |

**Shared verified changes:**
- Every screen now mounts `AuroraBackground` in its loaded view.
- `ChatDoorButton` lost its `as any` (`components/spaces/ChatDoorButton.tsx:34`).
- The remaining `#0008` scrims and `#fff` on solid fills are kept on purpose and now carry comments (for example `app/space-admin.tsx:195`). The fix log hands off the missing `onDanger`/`onBrand` token, so that item stays open everywhere.

**Regressions round 3 introduced (summary):**
1. **runs-admin copy is wrong for pickup runs.** The new `requireCode` checkbox says the code is asked "at drop-off" (`app/space-runs-admin.tsx:512`, `:515`). The driver screen asks for it on boarding too (`app/space-run-driver.tsx:280`), so on a morning pickup run the label describes the wrong moment.
2. **devices rename modal may not appear on iOS.** The new rename modal is a sibling `<Modal>` opened while the full-screen detail `<Modal>` is open (`app/space-devices.tsx:542` vs `:327`). The pre-existing show-a-message modal does the same (`:514`). This repo's own comments say a modal must be nested to stack on iOS (`app/space-runs-admin.tsx:533`, `:672`; `app/space-leave.tsx:416`). Whether it presents is **not verifiable statically** (📱).
3. **Space screens borrow the finance theme for date pickers.** Leave, tasks and runs-admin now use `components/finance/useDatePicker`, which draws its iOS sheet with the finance palette (`components/finance/useDatePicker.tsx:22-24`, `:58-61`). That is a visual mismatch on space screens.
4. **transport has a stale comment.** It still says the run view shows "not a map" (`app/space-transport.tsx:291-293`), but `space-run` now renders a `FamilyMap` (`app/space-run.tsx:291-300`). Comment only.

---

#### `app/space-admin.tsx` — **7.0 → 7.5** (mean 7.33)
- **Scores now:** Function 8 · States 7.5 · UI 7 · A11y 7.5 · Security 7 · Code 7
- **Original items:**
  - ✅ Links sheet loading state. `linksLoading` is set on open (`app/space-admin.tsx:103`, `:143-146`) and cleared when the read settles (`:141`). The sheet shows a spinner instead of "No links yet" (`components/spaces/SpaceLinksSheet.tsx:191-194`).
  - ✅ Leave and Tasks entries added, ungated, with perms forwarded (`:65-68`, `:257`).
  - ❌ Still one `getRun` per run, now in parallel (`:124-127`). Needs the `withRiders` backend (fix log handoff).
  - ◐ `as any` is removed (`:191`, `:249`). The `#fff` on the danger fill is commented, not tokenised (`:195-196`, `:309`).
  - ✅ Shift is read from the server, with a device fallback.
    - `ShiftSheet` calls `loadShift` (`components/spaces/ShiftSheet.tsx:31-37`) and says where the pre-fill came from (`:74-78`).
    - Against today's server, `getShift` 404s and the sheet says "this device last saw" (`lib/spaces/shift.ts:88-89`).
- **Regressions:** none.
- **Subscreens:**
  - Links sheet — 7.5 → 8. It has a loading state, a "first 100 of N" notice (`SpaceLinksSheet.tsx:137-141`) and 44pt relation chips (`:240-243`).
  - Shift sheet — 6.5 → 7.5. It reads the server first and labels the source. Cancel is labelled (`ShiftSheet.tsx:90`).
  - Emergency banner — 7 → 7. Run tiles — 7 → 7. Chat door — 8 → 8.
- **Still needed for 10/10:**
  1. Replace the per-run `getRun` with a single scoped call once `?withRiders=1` ships (`:124-127`). A failed `getRun` is currently caught to `[]` (`:126`), so the tiles silently undercount.
  2. Add an `onDanger` token and use it for the SOS banner ink (`:196`, `:309`).
  3. Memoise `styles(colors)` (`:158`). Decide where duty-state editing lives (fix log Partial #2).

#### `app/space-attendance.tsx` — **5.0 → 7.0** (mean 7.17)
- **Scores now:** Function 7 · States 7.5 · UI 7.5 · A11y 6.5 · Security 7.5 · Code 7
- **Original items:**
  - ✅ Shift read. Attendance uses `loadShift` when no params are given (`app/space-attendance.tsx:88`, `:91`), which falls back to the device copy against today's server.
  - ✅ Tracks are read once.
    - One `getTrack(spaceId, {from})` call, grouped by `u` (`:108-114`; `lib/family/history.ts:139-151` filters a single cache read).
    - A thrown read now fails the screen with a LoadError instead of showing "No data" (`:128-131`, `:176`).
  - ✅ Zone picker. `pickWorkZone` and `liveZones` skip disabled and expired zones, with self-check asserts (`lib/spaces/attendance.ts:260-280`, `:427-440`; selftest passes). A radio chip group appears when there is more than one zone (`:190-211`). The pick is stored in AsyncStorage inside a catch (`:89`, `:139`).
  - ◐ Rows have role, `expanded` state, label and hint (`:239-242`). Each day shows "Mon · Late" as text (`:270`). The per-day `accessibilityLabel`s (`:265-267`) sit inside a touchable that is already accessible, with its own label (`:235-243`). A screen reader may therefore never reach them; the visible text fixes the colour-only problem for sighted users. Needs a device check.
  - ✅ Aurora in the loaded view (`:169`), RefreshControl (`:172`), and a spinner on retry (`:176`).
- **Regressions:** none. Minor: after a failed refresh, the previous rows stay under the error card with no "may be out of date" note (`:176`, `:223`).
- **Subscreens:**
  - Per-member week disclosure — 5 → 6.5.
  - **New** Workplace zone picker — **7.5**.
- **Still needed for 10/10:**
  1. Make each day reachable by a screen reader. Either fold the week into the row's label when expanded, or render the week outside the touchable (`:235-279`).
  2. When an error card sits over earlier rows, mark those rows as possibly stale (`:176`, `:223`), as `space-pending` does.
  3. Type `stateIcon` instead of `any` (`:316`) and memoise the styles (`:155`). The data is still device-local by design, so presence depends on what this phone received (`:4-14`).

#### `app/space-checkin.tsx` — **6.5 → 7.5** (mean 7.42)
- **Scores now:** Function 7.5 · States 7 · UI 7.5 · A11y 7.5 · Security 7 · Code 8
- **Original items:**
  - ✅ UTC `today()` and typed dates are gone. The in-screen leave list and modal were removed (the file is now 239 lines). A "Leave" row opens `/space-leave` with perms (`app/space-checkin.tsx:104-107`, `:168-185`) and shows your pending count, plus the count to decide for approvers (`:102-103`).
  - ✅ The duplicated leave UI was replaced by that door, so the leave kinds now live in one place.
  - ✅ Pull-to-refresh (`:126`) and Aurora in the loaded view (`:123`).
  - ✅ 44pt targets. The link row has `minHeight: 44` (`:233`), and the big buttons have role and label (`:152`, `:156`).
- **Regressions:** none.
- **Subscreens:**
  - Request-leave modal — removed (n/a).
  - **New** Leave door row — **7.5**.
- **Still needed for 10/10:**
  1. Load the leave count on its own. Today `getLeave` sits in the same `Promise.all` as attendance (`:58-62`), so a failed leave read hides the check-in hero (`:135`), although leave is now only a badge.
  2. If `getCurrentUserAsync` fails, `me` is `''` (`:63`). The hero then says "Not checked in" (`:79`, `:144`), and `toDecide` counts the viewer's own requests (`:103`). Treat a missing identity as an error.
  3. Both this screen and `space-attendance` are titled "Attendance" (`:115`, `:128`). Rename this one "Check in".

#### `app/space-devices.tsx` — **6.5 → 7.0** (mean 7.0)
- **Scores now:** Function 6.5 · States 7.5 · UI 7 · A11y 7.5 · Security 7 · Code 6.5
- **Original items:**
  - ❌ Ring and message work only while the app is in the foreground. Lock, photo and wipe are still unsupported (`app/space-devices.tsx:60-66`, `:386-394`). Device behaviour is **not verifiable statically**.
  - ✅ Rename. A row shown to the owner or `view_space_ops` (`:419-427`), a modal (`:542-564`), and `updateDevice({label})` (`:178-189`).
  - ✅ Modal buttons.
    - Add and Send now have role, label and `busy` state (`:503-505`, `:531-533`). Cancel has a role (`:498`, `:524`).
    - The message modal stays open while sending and keeps the text on failure (`:528-529`; `runAction` returns a boolean at `:191-208`).
    - Close is 44pt (`:330`, `hit` at `:641`).
  - ✅ Stale-response guard. The `openReq` ref covers events, commands and `isBoundHere` (`:112-124`), and the post-command refresh (`:192`, `:197`). `closeDevice` invalidates it (`:127`).
  - ✅ Aurora in the loaded view (`:241`). The add button sits next to `ChatDoorButton` (`:246-257`).
- **Regressions:** the rename modal is a sibling of the open detail modal (`:542` vs `:327`), so it may not present on iOS (summary item 2).
- **Subscreens:**
  - Device detail — 6.5 → 7.5.
  - Add-device modal — 7 → 7.5.
  - Show-a-message modal — 6 → 7.5 (📱 iOS stacking).
  - **New** Rename modal — **7** (📱 iOS stacking).
- **Still needed for 10/10:**
  1. Nest the message and rename modals inside the detail `<Modal>`, as runs-admin does (`:514`, `:542`).
  2. Device-verify ring and message, and add background command collection (fix log Partial #5).
  3. In `archiveDevice`, an `unbindThisPhone` failure after a successful archive is reported as "Could not remove" (`:167-171`). Separate the two outcomes.
  4. The file is 644 lines with `styles(colors)` built on every render (`:227`). Split the detail sheet out.

#### `app/space-incidents.tsx` — **7.0 → 7.5** (mean 7.5)
- **Scores now:** Function 7.5 · States 8 · UI 7.5 · A11y 7.5 · Security 7.5 · Code 7
- **Original items:**
  - ◐ `mediaRef`. There is now an ops-only row: "Photo attached · open the space's photos" opens `/media-gallery` with `{chatId, tab:'photos'}` (`app/space-incidents.tsx:183-194`). Those params match what the gallery reads (`app/media-gallery.tsx:130-136`). It opens the gallery, not the photo, and the fix log says no client produces `mediaRef` yet (Partial #3).
  - ✅ Buttons have `minHeight: 44` (`:258`). Aurora (`:129`).
  - ✅ Resolve is confirmed with destructive style and "cannot be reopened" wording (`:108-112`).
- **Regressions:** none.
- **Subscreens:** **New** photo row — **6.5**. It is honest, but it is not the photo itself.
- **Still needed for 10/10:**
  1. Open the specific photo, or decrypt it inline, once a client writes `mediaRef` (`:183-194`).
  2. `getRuns` failures are caught to `[]` (`:64`), so a run-linked incident reads "a vehicle" (`:90`) without saying the lookup failed.
  3. Render the incidents in a FlatList (`:149`), and add an `onDanger`/`onBrand` ink token for `#fff` (`:217`, `:263`).

#### `app/space-leave.tsx` — **6.0 → 7.5** (mean 7.33)
- **Scores now:** Function 8 · States 7.5 · UI 7 · A11y 7.5 · Security 7 · Code 7
- **Original items (from `2026-10-04_screen_ratings.md:3118-3123`):**
  - ✅ 1. Dates are picked, not typed (`app/space-leave.tsx:367-388`), using the shared picker rendered inside the Modal (`:417`). `parseDay` is checked on submit (`:161-164`), and `from > to` is refused (`:165-168`).
  - ✅ 2. Withdraw on your own pending request, with a destructive confirmation (`:222-232`, `:126-137`). `decideLeave` accepts `'cancelled'` (`lib/spaces/api.ts:246`).
  - ✅ 3. Local days. `ymd` and `dayOffset` use local date parts (`lib/spaces/leave.ts:14-23`), and the selftest passes.
  - ✅ 4. The FAB and both sheets are inset (`:341`, `:350`, `:424`). Decline is confirmed with destructive style (`:129-135`).
  - ✅ 5.
    - Kind chips are radios inside a radiogroup (`:352-361`).
    - Approve, Decline and Withdraw have role, label and state (`:227-228`, `:239-240`, `:248-249`).
    - Tabs use role `tab` and are 44pt (`:271-272`, `:470`).
    - A "Set allowance" sheet appears for `edit_settings` (`:62-65`, `:293-297`, `:421-457`). It is validated by `allowanceBody` (`lib/spaces/leave.ts:30-43`, selftest).
- **Regressions:** the date picker uses the finance palette (summary item 3).
- **Subscreens:**
  - Tabs — 6.5 → 7.5.
  - Request-leave sheet — 5 → 7.5.
  - **New** Allowance sheet — **7**.
- **Still needed for 10/10:**
  1. "Set allowance" is drawn only inside the balance card, so if `getLeaveBalance` fails (`:96`) the editor disappears (`:289-297`). Show it on its own.
  2. Use `LoadError` instead of the hand-built error card (`:315-323`). Remove `as any` (`:202`). Give the tab row `accessibilityRole="tablist"` (`:266`).
  3. Theme the shared date picker from the caller's palette, not `useFinanceTheme` (`components/finance/useDatePicker.tsx:22-24`).

#### `app/space-ops-map.tsx` — **6.5 → 7.0** (mean 7.08)
- **Scores now:** Function 7.5 · States 7 · UI 7 · A11y 7 · Security 7.5 · Code 6.5
- **Original items:**
  - ✅ Partial failure.
    - `deliver()` keeps the text and the failed ids (`app/space-ops-map.tsx:171-201`).
    - "Retry the rest (N)" resends only to runs that are still active (`:222-228`, `:330-341`).
    - The list resets when the audience or the text changes (`:220`, `:314`).
  - ◐ Keyboard. The screen is wrapped in `KeyboardSafe keyboardOnly` (`:243`) with `keyboardShouldPersistTaps` (`:260`). With a 46% map (`:429`), short screens need a device check (📱).
  - ✅ Emergency sends are confirmed with a destructive Alert (`:210-216`).
  - ✅ Subscriptions run in parallel through `Promise.all` (`:98-111`).
  - ✅ The warning tint uses `c.warning + '18'` (`:432`). Aurora (`:244`). The input is labelled (`:315`). Send is 44pt (`:474`). The openRun cast is removed (`:360`).
  - ❌ N+1 `getRun` (`:63-66`).
- **Regressions:** none.
- **Subscreens:**
  - FamilyMap — 6 → 6 (📱).
  - Emergency mode — 6 → 7.5.
  - Instruction composer — 5 → 7.5.
- **Still needed for 10/10:**
  1. Use the single runs-with-riders call once it ships (`:63-66`).
  2. The run list reloads only on focus (`:78`), so a run started while the screen is open never appears. Add pull-to-refresh or a periodic `getRuns`.
  3. The 44pt chevron is a touchable nested inside the row touchable (`:393-398`). Move it beside the row. Type `me` instead of `(me as any)` (`:96`).
  4. Device-check the keyboard with the 46% map (`:429`), and add the `onDanger` token (`:293`, `:295`).

#### `app/space-overview.tsx` — **6.5 → 7.5** (mean 7.33)
- **Scores now:** Function 7.5 · States 7.5 · UI 7 · A11y 7.5 · Security 7.5 · Code 7
- **Original items:**
  - ✅ Shortcuts carry a permission and are filtered (`app/space-overview.tsx:52-64`, `:432-434`). "Create Task" and "People" need `view_space_ops` (`:419-424`).
  - ✅ `isSchool` uses `familyOf(...) === 'school'` (`:99-102`).
  - ✅ Donut is `accessible`, with role `image` and a label (`components/spaces/Donut.tsx:57-60`). The screen passes labels built from the segments (`:240`, `:291`).
  - ✅ Styles are memoised (`:124`) and passed to Metric, Legend, Chip and Action (`:459-503`). Aurora (`:155`). Link and run rows are 44pt (`:527`, `:548-549`).
- **Regressions:** none.
- **Subscreens:**
  - School tiles — 6 → 7.
  - Business dashboard — 6.5 → 7.5.
  - Donut — 5 → 7.5.
- **Still needed for 10/10:**
  1. "View All Employees" still opens `/space-people` for everyone (`:260`), while the People quick action is gated (`:422`). Gate both the same way. Whether a member without permissions ever gets `sum` is server-side and **not verifiable statically** (`:86`).
  2. Group each Metric card into one accessible element, for example "Total People, 42" (`:461-472`).
  3. Add the `onDanger` token (`:176`, `:513`).

#### `app/space-pending.tsx` — **7.0 → 7.5** (mean 7.58)
- **Scores now:** Function 8 · States 8.5 · UI 7.5 · A11y 7 · Security 7 · Code 7.5
- **Original items:**
  - ✅ A `SectionList` grouped by run, in the server's order, with stable keys (`app/space-pending.tsx:61-69`, `:87-91`).
  - ✅ The section header is 44pt (`:178-181`), with role and label (`:117-118`). Aurora (`:85`).
  - ✅ After a failed refresh, a stale note appears under the error (`:100-102`).
- **Regressions:** none.
- **Subscreens:** none.
- **Still needed for 10/10:**
  1. Make each rider row one accessible element with a label such as "Asha, Green Lane, due 07:45, overdue" (`:125-151`). Today the pills are read as separate fragments.
  2. Memoise the styles (`:71`). Give the last row in each section a bottom radius (`row` at `:174-177` has none). That is visual only and **not verifiable statically**.

#### `app/space-people.tsx` — **7.0 → 7.5** (mean 7.5)
- **Scores now:** Function 7.5 · States 8 · UI 7.5 · A11y 7 · Security 8 · Code 7
- **Original items:**
  - ✅ `PermissionMatrix` takes an optional `colors` prop with memoised styles (`components/spaces/PermissionMatrix.tsx:63-67`). People passes its space palette (`app/space-people.tsx:329-333`).
  - ✅ The list is a FlatList (`:191-254`). The sheet has `18 + insets.bottom` (`:262`).
  - ✅ The search input is labelled (`:186`). The sheet buttons have roles, and Confirm has `busy` state (`:346`, `:352-353`, `:362`, `:368-369`).
- **Regressions:** none.
- **Subscreens:**
  - Role picker sheet — 7.5 → 8.
  - PermissionMatrix — 7 → 7.5.
- **Still needed for 10/10:**
  1. The expanded `PermissionMatrix` is drawn inside the radio touchable (`:296-334`). That touchable's `accessibilityLabel` (`:301`) hides the matrix from screen readers. Render the matrix below the option instead.
  2. `Count` rebuilds `styles(c)` for each instance on every render (`:386-388`). Type the `any[]` destructure (`:86`). The search input's `minHeight` is 42 (`:420`).

#### `app/space-roster.tsx` — **7.0 → 7.5** (mean 7.58)
- **Scores now:** Function 8 · States 8 · UI 7.5 · A11y 7.5 · Security 7.5 · Code 7
- **Original items:**
  - ✅ The chat door is kept next to the add button (`app/space-roster.tsx:156-175`). The warn tint uses `c.warning + '18'` (`:332`). Aurora (`:155`).
  - ✅ Archive is 44pt and labelled "Remove <name> from the roster" (`:239`, `hit` at `:346`). The modal buttons have roles, and Add has state (`:294`, `:301-302`).
  - ✅ Kind is a Child/Adult radio. Schools default to child (`:38-41`, `:66`, `:272-282`). An optional reference is limited to 64 characters (`:283-292`) and sent only when set (`:108`). `addRosterEntry` accepts both (`lib/spaces/api.ts:69-72`).
- **Regressions:** none.
- **Subscreens:**
  - Links sheet — 7.5 → 8.
  - Add-to-roster modal — 6.5 → 7.5.
- **Still needed for 10/10:**
  1. Use a FlatList for a school-sized roster (`:218-245`).
  2. Show an entry's kind (Child or Adult) in its row (`:230-236`).

#### `app/space-run-driver.tsx` — **6.5 → 7.0** (mean 6.92)
- **Scores now:** Function 7 · States 7.5 · UI 7 · A11y 7 · Security 7 · Code 6
- **Original items:**
  - ◐ Call guardian.
    - Code path: one guardian goes `createDirectChat({userId})` → `/voicecall` (`app/space-run-driver.tsx:293-302`). The params match `app/voicecall.tsx:87-89`. Several guardians open a `Sheet` picker (`:315-318`, `:656-659`). `[]` hides the button (`:538`).
    - Against today's server, `guardians` is absent, so the driver still gets the explanatory Alert (`:305-312`). The direct call works only after `ZBE` 4a is deployed.
  - ◐ SOS. A failed send offers "Try again" in place (`:355-362`). It is not queued across restarts, which the `ponytail:` note at `:353-354` admits.
  - ❌ The incident form is still category only (`:369-377`, `:642-647`).
  - ❌ Detection alerts still go to every member (`:186-188`).
  - ✅ The floating bar uses `20 + insets.bottom` (`:591`). The sheet and list are inset (`:464`, `:636`). The call button is 44pt (`:716`). The code input is labelled (`:604`).
- **Regressions:** none.
- **Subscreens:**
  - Handover code — 6.5 → 7.5.
  - Report-a-problem sheet — 5 → 6.
  - Panic confirmation — 6 → 7.
  - **New** Guardian picker Sheet — **7**.
- **Still needed for 10/10:**
  1. Deploy `riders[].guardians` and device-test the call path (📱).
  2. Add a note or photo to incidents (`:369-377`), and queue the SOS durably (`:353-362`).
  3. Scope detection alerts to ops roles (`:186-188`).
  4. Give Start/Finish a `minHeight: 44` (`runBtn` at `:696`). Remove the `any` icon types (`:56`, `:680`). Split the 758-line file.

#### `app/space-run.tsx` — **6.5 → 7.5** (mean 7.33)
- **Scores now:** Function 7.5 · States 8 · UI 7.5 · A11y 6 · Security 8 · Code 7
- **Original items:**
  - ✅ Map and driver name.
    - Once a sealed ping arrives, a `FamilyMap` shows the vehicle (it fades after 90s), the received trail (at most 300 points) and the first rider's stop (`app/space-run.tsx:153-159`, `:200-203`, `:291-300`). FamilyMap supports `path` and `destination` (`components/family/FamilyMap.tsx:603-605`).
    - The driver name comes from `circleMembers` and is hidden when unknown (`:124-132`, `:268`).
    - Rendering the map inside a ScrollView is 📱.
  - ✅ Timeline: a spinner, an inline `LoadError` with retry, a collapsible 44pt header with `expanded` state, and "Nothing recorded yet" only when there is no error (`:164-181`, `:344-358`, `:523`).
  - ✅ Aurora (`:232`).
- **Regressions:** none. FamilyMap's spoken label says "Map showing 1 person" for a vehicle (`components/family/FamilyMap.tsx:805`). That is minor.
- **Subscreens:**
  - RiderCard — 7 → 7.
  - "What happened" timeline — 7 → 8.
  - **New** live map — **7** (📱).
- **Still needed for 10/10:**
  1. Each route stop shows "arrived" only as an icon change (`:330-335`). Add the state to an accessible label for each stop.
  2. Make the arrival-window headline in RiderCard a polite live region, so updates every 30s are announced (`:431-433`).
  3. `RiderCard` and `Row` rebuild `styles(colors)` on every render (`:385`, `:455`), and `Row` takes `icon: any` (`:454`).

#### `app/space-runs-admin.tsx` — **7.0 → 7.0** (mean 7.17)
- **Scores now:** Function 8 · States 7.5 · UI 7 · A11y 7.5 · Security 7 · Code 6
- **Original items:**
  - ✅ The create form sets `scheduledAt` through the shared date+time picker (`app/space-runs-admin.tsx:491-508`, `:494`), rendered inside the modal (`:534`). It also sets `requireCode` (`:509-516`). Both are sent to `createRun` (`:133-137`; the API accepts them at `lib/spaces/api.ts:101-104`).
  - ✅ 44pt targets: `iconHit`, `riderToggle`, `stopChip`, kind chips and `hit` (`:800-807`, `:814-817`).
  - ✅ RefreshControl (`:414`). An `openRun` failure shows an inline LoadError with retry (`:119-126`, `:419-424`).
  - ◐ The stop time and "Day of the run" are still typed (`:694-707`). The file has grown from 742 to 835 lines and is not split.
  - ✅ In-place stops. Ids are sent (`lib/spaces/runPlan.ts:80-89`), and riders are re-mapped only when `!idsPreserved` (`:170`). A 400 `unknown_stop` re-reads the run (`:184-186`; `err.body` is set in `lib/api.ts:617`). The selftest passes. Whether today's server tolerates the extra `id` field is **not verifiable statically**.
- **Regressions:** the `requireCode` label says "at drop-off", but the driver is asked at boarding too (summary item 1). The date picker uses the finance palette (summary item 3).
- **Subscreens:**
  - New-run modal — 6.5 → 8.
  - Edit-run modal — 7 → 7.5.
  - Stop form — 7.5 → 7.5.
  - Rider stop picker — 7.5 → 7.5.
- **Still needed for 10/10:**
  1. Reword the handover checkbox: "Ask for a handover code at pickup and drop-off" (`:512`, `:515`). Alternatively, restrict the driver prompt to match (`app/space-run-driver.tsx:280`).
  2. Replace the typed time and day with a picker; the shared hook supports `'datetime'` (`:694-707`).
  3. Split the 835-line component into edit modal, stop form and create form.

#### `app/space-tasks.tsx` — **7.0 → 7.5** (mean 7.33)
- **Scores now:** Function 8 · States 7.5 · UI 7 · A11y 7.5 · Security 7 · Code 7
- **Original items:**
  - ✅ Overview's "Create Task" is gated (`app/space-overview.tsx:419-421`).
  - ✅ The FAB and sheet are inset (`app/space-tasks.tsx:282`, `:297`). The comment now matches the code (`:119-123`).
  - ✅ When members fail to load, the sheet says the task will be unassigned and offers a 44pt "Try again" (`:107-110`, `:348-357`).
  - ✅ "Another day…" opens the picker and sets the due time to the end of that local day (`:53-57`, `:336-347`). Tabs use role `tab` and are 44pt (`:232`, `:400`).
- **Regressions:** the date picker uses the finance palette (summary item 3).
- **Subscreens:**
  - Tabs — 6.5 → 7.5.
  - New-task sheet — 6.5 → 7.5.
- **Still needed for 10/10:**
  1. The comment at `:137` says the optimistic toggle is "reconciled by reload", but a successful toggle never reloads (`:140-147`). Either reload or fix the comment.
  2. Create has no `accessibilityState` (`:377-384`). The custom due date accepts past days without warning (`:337`).
  3. Use `LoadError` instead of the hand-built error card (`:251-259`), and a FlatList (`:273`).

#### `app/space-transport.tsx` — **6.5 → 7.0** (mean 7.08)
- **Scores now:** Function 7 · States 7 · UI 7 · A11y 7 · Security 8 · Code 6.5
- **Original items:**
  - ✅ `cancelled` now reads "Not travelling on this run" with a neutral tone (`app/space-transport.tsx:62`).
  - ❌ Still N+1 `getRun` (`:145-152`).
  - ✅ The driver name comes from `circleMembers`, best effort (`:155-157`). It is used in `peerName` and in the button text ("Call Asha", `:118`, `:317`). The three casts are gone. The buttons are 44pt with role and label (`:296-311`, `:356`).
- **Regressions:** the stale "not a map" comment (summary item 4).
- **Subscreens:** none.
- **Still needed for 10/10:**
  1. Use the single runs-with-riders call once it ships (`:145-152`).
  2. Use `LoadError` instead of the hand-built error card (`:192-200`). Update the comment at `:291-293`.
  3. Refresh rider states while a run is started, as `space-run` does every 30s (this screen reloads only on focus, `:164`).

#### `app/space-visitors.tsx` — **6.5 → 7.5** (mean 7.5)
- **Scores now:** Function 7.5 · States 7.5 · UI 7.5 · A11y 7.5 · Security 7.5 · Code 7.5
- **Original items:**
  - ✅ Sign out per row for visitors on site, with a confirmation, through redeem-with-exit using the row's code. It is busy-guarded (`app/space-visitors.tsx:146-162`, `:253-264`).
  - ✅ The issue Alert has "Copy code" (`expo-clipboard`, listed in `package.json:104`) and "Share" (`:108-117`). The QR icon became a keypad (`:205`).
  - ✅ Active codes are masked as `••••XY`, with tap-to-reveal for one row and a spelled-out label (`:39`, `:244-252`). Overview's Visitors shortcut is gated on `manage_roster` (`app/space-overview.tsx:58`, `:62`).
  - ✅ The chat door is kept (`:183-195`). Inputs are labelled (`:284`, `:342`). Members are read once per space (`:79-81`). Aurora (`:178`). Chips are 44pt (`:398-401`).
- **Regressions:** none.
- **Subscreens:**
  - Issue-pass modal — 7 → 7.5.
  - Redeem modal — 6 → 7.
  - **New** issue-result Alert — **7.5**.
- **Still needed for 10/10:**
  1. Issue, Admit and Sign out have no `accessibilityState` (`:320-324`, `:348-361`). Only Admit shows a busy spinner (`:360`).
  2. A copied code stays on the clipboard indefinitely (`:113`). Clear it, or say that it was copied.
  3. Use a FlatList for the pass history (`:222`).

---

### I1 — Finance — re-rating (round 3)

Diff b8c8bd2 → HEAD (fix commit 6f58692 "screen audit round 3 (Z-I1)", plus 4ee0369 for the `INSET_SCREENS` handoff). This is a static review. Nothing here is device-verified. The following are **not verifiable statically**: notification delivery, iOS date-picker behaviour, deleting the share-sheet file only after the receiving app has read it, PBKDF2 speed on a phone, and whether the error boundary recovers on a real device. None of the 21 finance files has uncommitted changes. Other agents' working-tree edits are in unrelated files. `app/chat.tsx` is one of them, and `split.tsx` embeds it.

| Screen | Old | New | Δ |
|---|---|---|---|
| `app/finance/_layout.tsx` | 8.0 | 8.5 | +0.5 |
| `app/finance/index.tsx` | 7.5 | 8.0 | +0.5 |
| `app/finance/calendar.tsx` | 7.0 | 8.0 | +1.0 |
| `app/finance/chitti/index.tsx` | 7.0 | 8.0 | +1.0 |
| `app/finance/chitti/new.tsx` | 7.0 | 8.0 | +1.0 |
| `app/finance/chitti/[id].tsx` | 6.0 | 7.5 | +1.5 |
| `app/finance/customer.tsx` | 6.5 | 8.0 | +1.5 |
| `app/finance/emi.tsx` | 8.0 | 8.0 | 0 |
| `app/finance/interest.tsx` | 7.0 | 7.5 | +0.5 |
| `app/finance/io.tsx` | 7.5 | 8.0 | +0.5 |
| `app/finance/ledger/index.tsx` | 7.0 | 7.5 | +0.5 |
| `app/finance/ledger/new.tsx` | 7.0 | 8.0 | +1.0 |
| `app/finance/ledger/[id].tsx` | 7.0 | 8.0 | +1.0 |
| `app/finance/ledger/edit.tsx` | 7.0 | 7.5 | +0.5 |
| `app/finance/ledger/update.tsx` | 7.5 | 8.0 | +0.5 |
| `app/finance/reminders.tsx` | 7.0 | 7.5 | +0.5 |
| `app/finance/reports.tsx` | 6.5 | 7.5 | +1.0 |
| `app/finance/saved.tsx` | 6.5 | 8.0 | +1.5 |
| `app/finance/search.tsx` | 6.5 | 8.0 | +1.5 |
| `app/interest-calculator.tsx` | 7.0 | 7.5 | +0.5 |
| `app/split.tsx` | 7.0 | 8.0 | +1.0 |

#### Shared changes (checked against the code)
- **`utils/financeRules.ts` (new) — ✅ verified.** It has these pure functions:
  - `ledgerInterest`, which handles compound loans and returns a `projected` flag (`:83-90`).
  - `ledgerStatusFor` (`:100-108`) and `groupStatusFor` (`:127-131`).
  - `addMonths`, `auctionDate` and `nextAuction` on calendar months (`:26-32`, `:114-144`).
  - Reminder recurrence (`:151-205`), `amountMatches` (`:213-217`), `sameCustomer` (`:225-232`), `ledgerDatesProblem` (`:46-50`) and `normalizeMobile` (`:60-69`).

  `npx tsx utils/financeRules.selftest.ts` prints "54 assertions passed".
- **Statuses are written on read (closes X3) — ✅.**
  - `listLedger` and `getLedger` run `syncLedgerStatuses` (`db/ledger.ts:93-122`).
  - `listGroups` and `getGroup` run `syncGroupStatuses` (`db/chitti.ts:80-107`).
  - `listReminders` moves recurring `next_at` forward (`db/reminders.ts:48-56`).
  - `setGroupStatus` now has a caller (`chitti/[id].tsx:230`).
- **`DateField` label and clear — ✅.** The spoken label is "`{label}`: value. Change …" (`components/finance/ui.tsx:160-179`). `onClear` adds a labelled clear button.
- **`sharePdf` deletes the PDF in `finally` — ✅** (`utils/financeIO.ts:13-25`). All four callers ignore the returned uri (grep). Share-then-delete timing is not verifiable statically.
- **`useDatePicker` scrim uses theme colours — ✅** (`components/finance/useDatePicker.tsx:57-63`).
- **Handoffs:**
  - ✅ `'interest-calculator'` is gone from `INSET_SCREENS` (`app/_layout.tsx:212-222`).
  - ❌ `lib/themeCoverage.selftest.ts:43` still exempts `app/finance/`. The hero whites are still literals, but now carry a comment at each site.
- **Checks I ran (all exit 0):**
  - `npx tsc --noEmit -p .` gives 0 errors.
  - `npx eslint` on app/finance, split, interest-calculator, components/finance and the changed db/ and utils/ files gives 0 problems.
  - `npx tsx` passes for:
    - utils/: `financeRules`, `financeBackupSeal` (12), `financeGuards` (48)
    - db/: `financeBackup`, `chitti`
    - components/finance/: `ledgerCsv`, `notifyIds`
    - lib/: `uiDebtRatchet` ("no file got worse"; every finance file has 0 unroled touchables), `a11yCoverage`, `keyboardAvoidance`, `themeCoverage`, `orphanRoutes`, `screenBackCoverage`, `silentFailure`, `responsive`

#### Regressions from round 3
1. **Yearly reminders are scheduled one month late. This is a real defect.** Round 3 added "Yearly" to the segment (`app/finance/reminders.tsx:139`), which makes `components/finance/notify.ts:33` reachable. That line builds the trigger with `month: d.getMonth() + 1`. expo-notifications documents yearly trigger fields "in JavaScript `Date` object's ranges (i.e. January is represented as 0)" (`node_modules/expo-notifications/build/Notifications.types.d.ts:310-319`). So a 5 March reminder is scheduled for 5 April. A December reminder gets month 12, which is out of range, and what the OS does with that is not verifiable statically. The in-app `next_at` and Calendar are correct (`utils/financeRules.ts:156`). Only the OS alert is wrong.
2. **Low risk: duplicate `'status'` timeline rows.** `syncLedgerStatuses` and `syncGroupStatuses` run a guarded `UPDATE … WHERE status = ?` but add the timeline row without checking whether a row changed (`db/ledger.ts:100-103`, `db/chitti.ts:87-89`). Two overlapping reads of the same stale row would both add one. Every list read now also writes, so a write failure fails the screen's load.
3. **Stale comment.** The comment at `app/finance/chitti/[id].tsx:403-406` still says auction delete "writes NO timeline entry". `db/chitti.ts:278-287` now writes one.

---

#### `app/finance/_layout.tsx` — **8.0 → 8.5**
- **Scores now:** Function 9 · States 8 · UI 9 · A11y 8 · Security 7 · Code 9
- **Original items:**
  - ✅ The finance `Stack` is wrapped in `ErrorBoundary` with a finance-specific title and message (`:32-54`). On Try again, the boundary remounts its subtree under a new key (`components/ErrorBoundary.tsx:43-55`). Whether the nested stack recovers rather than re-throwing on the same route is not verifiable statically.
  - ❌ The finance section has no app-lock or biometric gate. The fixer recorded this as a product decision and it is not done.
- **Regressions:** none. The fallback uses fixed dark colours on purpose (`components/ErrorBoundary.tsx:17-19`, `:62-66`).
- **Subscreens:** none.
- **Still needed for 10/10:**
  1. Decide on and document the finance lock. The data is plain SQLite (X4). Nothing in `:18-57` adds protection.
  2. Give the boundary fallback a way out of Vault Finance as well as Try again. It replaces the whole stack, header included (`:32-54`).

#### `app/finance/index.tsx` — **7.5 → 8.0**
- **Scores now:** Function 8 · States 8 · UI 8 · A11y 8 · Security 7 · Code 8
- **Original items:**
  - ✅ Interest uses the shared `ledgerInterest` (`:30`, `:62`), so compound loans are summed as compound.
  - ✅ The Overdue tile reads statuses that `listLedger` keeps current (`:52-54`, `:71`; `db/ledger.ts:93-114`).
  - ✅ The `as any` cast is gone. `go(path: Href)` is typed (`:17`, `:82`).
  - ◐ Hero colours are still literals with a comment (`:205-215`), and theme coverage still exempts the folder.
- **Regressions:** none on this screen. See shared regression 2.
- **Subscreens:** none.
- **Still needed for 10/10:**
  1. "Pending" and "earned" interest are full-term figures (to the end date, or a 1-year projection), not accrued or received interest (`:62-68`). Label them as such or accrue to today.
  2. Add a `heroInk` token, or a marker convention, so `app/finance/` can leave `EXEMPT_PREFIX` (`:208-215`; `lib/themeCoverage.selftest.ts:43`).

#### `app/finance/calendar.tsx` — **7.0 → 8.0**
- **Scores now:** Function 8 · States 8 · UI 8 · A11y 8 · Security 8 · Code 8
- **Original items:**
  - ✅ There is one auction per calendar month for the whole duration (`:68-75`, via `auctionDate`).
  - ✅ Recurring reminders are expanded into the visible month (`:62-67`, `occurrencesBetween`).
  - ✅ Each event carries a `ref`, and tapping it opens the ledger, the group or the reminders list (`:19-23`, `:79-83`, `:151-153`).
  - ✅ "Nothing due" shows only once the data is ready (`:148`). Keys are stable (`:58`, `:65`, `:73`, `:130-131`).
- **Regressions:** none.
- **Subscreens:** Selected-day events panel — 6 → 8 (rows are labelled buttons that navigate, `:151-153`).
- **Still needed for 10/10:**
  1. A reminder event opens the list, not that reminder (`:82`).
  2. Recurring reminders do not appear before their current `next_at` (`utils/financeRules.ts:177-187`), so past months show no history.
  3. Give the month title `accessibilityRole="header"` (`:122`).

#### `app/finance/chitti/index.tsx` — **7.0 → 8.0**
- **Scores now:** Function 8 · States 8 · UI 8 · A11y 8 · Security 8 · Code 7
- **Original items:**
  - ✅ Cards have a role and a full label (name, members, installment, % collected) (`:74-77`). The FAB has a role and label (`:89-90`).
  - ✅ One grouped `COUNT` via `paidCountsByGroup` (`:41-44`; `db/chitti.ts:110-117`).
  - ❌ Still no FlatList (`:66-88`).
- **Regressions:** none.
- **Subscreens:** Active / Closed / Draft segment — 6 → 8 (groups close automatically after the last auction, and the detail screen can change status).
- **Still needed for 10/10:**
  1. Use a FlatList for the group list (`:73-86`).

#### `app/finance/chitti/new.tsx` — **7.0 → 8.0**
- **Scores now:** Function 8 · States 8 · UI 7 · A11y 8 · Security 8 · Code 8
- **Original items:**
  - ✅ Members and duration must be whole numbers ≥ 1 (`:39-40`).
  - ✅ A paise-exact installment × members ≠ chit value check asks for confirmation (`:44-52`).
  - ✅ Status can change later through the detail screen's segment (`chitti/[id].tsx:220-233`).
- **Regressions:** none.
- **Subscreens:**
  - Start-date picker — 7 → 8 (spoken label "Start date", `:93`; iOS not verifiable statically).
  - Status segment — 7 → 8 (no longer permanent).
- **Still needed for 10/10:**
  1. Question creating a group directly as "Closed" (`:96`).
  2. Show the mismatch inline next to the fields, not only in an Alert (`:44-52`).

#### `app/finance/chitti/[id].tsx` — **6.0 → 7.5**
- **Scores now:** Function 8 · States 8 · UI 8 · A11y 8 · Security 8 · Code 6
- **Original items:**
  - ✅ Roles and labels on:
    - the add row (`:306-307`)
    - member rows, with a "remove" accessibility action (`:313-317`)
    - dues rows, with role, label and a hint naming the next state (`:341-344`)
    - month chips: radios with selected state inside a radiogroup (`:445-449`)
    - winner chips (`:364-368`)

    Chips have `minHeight: 44` (`:478`, `:491`). The remove and delete buttons have hitSlop 14 (`:327`, `:408`).
  - ✅ try/catch on `cycleStatus` (`:132-143`), `submitAuction` (`:173-175`), `deleteGroup` (`:193-194`), `deleteMember` (`:203`) and `deleteAuction` (`:212`). A ref latch blocks double taps on dues (`:48`, `:133-134`).
  - ✅ Bid ≤ chit value and commission ≤ bid (`:159-160`). Re-recording a month asks for a destructive confirmation (`:161-171`).
  - ✅ The body is in `KeyboardSafe` with `keyboardShouldPersistTaps` (`:259-260`).
  - ✅ Paid, Pending and Overdue are separate tiles (`:272-275`). The next auction is computed from today in calendar months, or reads "All auctions done" (`:237`, `:266`).
  - ◐ `MonthChips` is hoisted (`:441-455`) and used twice (`:335`, `:362`). The file is still 508 lines, with every tab inline (`:239-438`).
- **Regressions:** the stale comment at `:403-406` (shared regression 3).
- **Subscreens:**
  - Members tab — 5 → 8.
  - Member add/edit form — 7 → 8 (now keyboard-safe).
  - Dues tab — 4 → 7.5. Guarded and labelled. The latch is released before `reload()` lands (`:139`, `:142`), so a quick second tap reads the old status and writes the same value again.
  - Auctions tab — 5 → 8.
  - History tab — 7 → 8 (error with Try again, `:415-419`).
  - Delete-group Alert — 7 → 8.
  - Remove-member Alert — 7 → 8.
  - Delete-auction Alert — 6 → 8 (timelined, `db/chitti.ts:278-287`).
  - Group-status segment + confirm (new, `:220-233`, `:279-283`) — 8 (re-activating a finished group is explained, not silently undone).
- **Still needed for 10/10:**
  1. Split the Members, Dues, Auctions and History tabs into components (`:289-432`).
  2. Hold the dues latch until the reload has finished (`:138-142`).
  3. Remove the stale comment (`:403-406`).
  4. Move the hero whites to a token (`:460-464`).

#### `app/finance/customer.tsx` — **6.5 → 8.0**
- **Scores now:** Function 8 · States 8 · UI 8 · A11y 8 · Security 7 · Code 8
- **Original items:**
  - ✅ Rows are matched by mobile when both sides have one, and by name otherwise (`:24`, `:34`; `utils/financeRules.ts:225-232`). The entry point passes `mobile` (`ledger/[id].tsx:94`).
  - ✅ The hero shows the open balance both ways: "Owed to you" and "You owe" (`:45-53`, `:86-93`).
  - ✅ Cards have a role and a label (`:117-119`).
  - ✅ The hero and tiles are gated on `ready` (`:85-103`).
- **Regressions:** none.
- **Subscreens:** none.
- **Still needed for 10/10:**
  1. When the match is by mobile, rows can carry other names, but the header shows only the `name` param (`:78`). Show the aliases.
  2. Check that a negative net position renders clearly (`:88`). This is not verifiable statically.
  3. Give the customer name a header role (`:78`).

#### `app/finance/emi.tsx` — **8.0 → 8.0**
- **Scores now:** Function 8 · States 8 · UI 8 · A11y 8 · Security 9 · Code 8
- **Original items:**
  - ✅ "Loan type" is labelled "(names the PDF)" and is a radiogroup of radio chips (`:82-89`, `:163-169`).
  - ✅ The PDF is deleted after sharing (`utils/financeIO.ts:13-25`).
  - ◐ `#6D3FA8` (`:71`) and the hero whites (`:182-184`) are still literals, now with comments.
- **Regressions:** none.
- **Subscreens:**
  - Amortization schedule — 8 → 8.
  - PDF share — 8 → 8.5.
- **Still needed for 10/10:**
  1. Give each schedule row a single spoken label (month, principal, interest, balance). Today each cell is read on its own (`:140-145`).
  2. Bring the hero and PDF colours under tokens (`:71`, `:183-184`).

#### `app/finance/interest.tsx` — **7.0 → 7.5**
- **Scores now:** Function 7 · States 8 · UI 7 · A11y 8 · Security 8 · Code 7
- **Original items:**
  - ✅ A 0% rate is allowed (`:48`).
  - ✅ `rate_mode` and `period` are stored (`:90`) through an additive migration, and the database open is memoised (`db/interestHistory.ts:24-57`).
  - ✅ Negative duration parts are refused (`:69`).
  - ✅ The date fields say "From date" and "To date" (`:155`, `:157`).
- **Regressions:** none.
- **Subscreens:**
  - Dates / Duration mode — 7 → 8.
  - Date picker — 7 → 8.
  - Result and Share PDF — 8 → 8.
- **Still needed for 10/10:**
  1. Compound interest always compounds yearly (`frequency 1`, `:74`, `:90`). Choosing a Monthly period does not change how often it compounds. Let the user pick the compounding frequency, or say that it is yearly.
  2. Durations use a 365-day year and 30.4-day months (`:53`, `:70`). State the convention in the result.
  3. Move the hero whites to a token.

#### `app/finance/io.tsx` — **7.5 → 8.0**
- **Scores now:** Function 8 · States 8 · UI 8 · A11y 7 · Security 8 · Code 8
- **Original items:**
  - ✅ The Full Backup is sealed under a typed and confirmed password, with a "cannot be recovered" warning (`:70-92`, `:227-239`). The seal reuses the existing `lib/backupCrypto` and `lib/vaultCrypto` (`utils/financeBackupSeal.ts:17-47`; selftest 12 passes). Restore detects a sealed file and refuses a wrong password (`:149-154`). Legacy plain backups still restore.
  - ✅ Rows are validated before restore: `isBackupRow` and scalar-only columns (`db/financeBackup.ts:87-91`, `:114-121`).
  - ✅ CSV import runs in one transaction (`:191`; `db/ledger.ts:75-84`).
  - ✅ The picker uses MIME lists for CSV and JSON (`:31-34`, `:130-132`). An unknown size is caught by checking the length after the file is read (`:142-143`).
  - ✅ Imported mobiles are normalised. Rows with a bad mobile are counted and reported (`:183`; `components/finance/ledgerCsv.ts:152-157`).
- **Regressions:** none.
- **Subscreens:**
  - Spreadsheet mode — 8 → 8.
  - Full Backup mode — 7 → 8.
  - CSV import flow — 8 → 8.5.
- **Still needed for 10/10:**
  1. Sealing and opening run PBKDF2 synchronously on the JS thread with no busy indicator (`:83`, `:151`). The phone-speed impact is not verifiable statically. Show progress, or move the work off the JS thread.
  2. Clear `pw` after export and after restore. Only `pw2` is cleared now (`:85`).
  3. The size check reads the whole file before checking its length (`:140-143`).
  4. The Lucky Draw export reads groups one after another (`:100-103`).

#### `app/finance/ledger/index.tsx` — **7.0 → 7.5**
- **Scores now:** Function 8 · States 8 · UI 8 · A11y 8 · Security 7 · Code 7
- **Original items:**
  - ✅ Cards have a role and label, plus a "delete" accessibility action that matches long-press (`:122-129`).
  - ✅ The FAB, the header add button and UNDO have roles (`:99`, `:160-161`, `:169`). The snackbar has a live region (`:167`), which works on Android only.
  - ✅ Failed deletes and undos raise an alert and reload (`:79-82`, `:89-91`).
  - ❌ Still no FlatList (`:111-158`).
- **Regressions:** none.
- **Subscreens:**
  - All / Lent / Borrowed filter — 8 → 8.
  - Undo snackbar — 6 → 8.
- **Still needed for 10/10:**
  1. Pre-existing bug. If the user opens a ledger while a delete is pending and comes back, the `useFocusEffect` reload (`:36-41`) shows the "deleted" row again. The snackbar still says "Ledger deleted". Filter `pendingDelete` out of the reloaded rows.
  2. Use a FlatList (`:118-155`).
  3. Announce the snackbar on iOS (`AccessibilityInfo.announceForAccessibility`), because `accessibilityLiveRegion` (`:167`) is Android-only.

#### `app/finance/ledger/new.tsx` — **7.0 → 8.0**
- **Scores now:** Function 8 · States 8 · UI 7 · A11y 8 · Security 8 · Code 8
- **Original items:**
  - ✅ The mobile is normalised to 10 digits or refused (`:55-59`).
  - ✅ An end date before the start is refused (`:60-61`; `utils/financeRules.ts:46-50`).
  - ✅ The date fields have distinct labels, and End can be cleared (`:110`, `:112`).
- **Regressions:** none.
- **Subscreens:** Start/End date pickers — 6 → 8 (iOS not verifiable statically).
- **Still needed for 10/10:**
  1. Extract the form shared with `edit.tsx` (`:80-115` vs `edit.tsx:100-125`).

#### `app/finance/ledger/[id].tsx` — **7.0 → 8.0**
- **Scores now:** Function 8 · States 8 · UI 8 · A11y 8 · Security 8 · Code 8
- **Original items:**
  - ✅ The hero and rows say "AT END DATE" or "AFTER 1 YEAR (PROJECTION)" (`:104-106`, `:115-116`). The PDF uses the same labels (`:60-61`). Both use the shared `ledgerInterest` (`:49`).
  - ✅ `Action` has role=button and a spoken label (`:170-185`). The contact row is role=link with a label, and passes `mobile` (`:91-94`).
  - ✅ A reminder created for a ledger or group now writes a `'reminder'` timeline row (`db/reminders.ts:34-38`).
  - ✅ The PDF is deleted after sharing.
- **Regressions:** none.
- **Subscreens:**
  - Delete confirmation — 8 → 8.
  - PDF share — 7 → 8.
  - Timeline — 6 → 8 (error with Try again, `:135-139`; `'status'` rows are labelled, `:166`).
- **Still needed for 10/10:**
  1. Deleting here has no undo, while the list screen has a 30-second undo (`:69-75`). Make the two consistent.
  2. "Remaining" excludes interest, and there is no interest-to-date figure (`:111-117`).
  3. Move the hero whites to a token (`:196-199`).

#### `app/finance/ledger/edit.tsx` — **7.0 → 7.5**
- **Scores now:** Function 8 · States 8 · UI 7 · A11y 8 · Security 8 · Code 7
- **Original items:**
  - ✅ Mobile and end ≥ start are validated (`:70-76`).
  - ◐ There is still no shared `LedgerForm`. Only the rules are shared.
  - ✅ The date fields have distinct labels, and End can be cleared (`edit.tsx` diff, `DateField label=…` with `onClear`).
- **Regressions:** none. An old row with an invalid stored mobile now blocks saving until the number is fixed or cleared, and the message says so (`:73`).
- **Subscreens:** Start/End date pickers — 6 → 8.
- **Still needed for 10/10:**
  1. Extract a shared `LedgerForm` for `new.tsx` and `edit.tsx`.

#### `app/finance/ledger/update.tsx` — **7.5 → 8.0**
- **Scores now:** Function 8 · States 8 · UI 8 · A11y 7 · Security 8 · Code 8
- **Original items:**
  - ✅ The user must confirm when received > remaining, or when the new remaining > the current remaining (`:58-71`). `addLedgerUpdate` keeps an overdue loan overdue (`db/ledger.ts:153-156`).
- **Regressions:** none.
- **Subscreens:** none.
- **Still needed for 10/10:**
  1. Give the ledger name a header role (`:84`).
  2. Confirm explicitly when an update settles the loan to ₹0 (`:73`).

#### `app/finance/reminders.tsx` — **7.0 → 7.5**
- **Scores now:** Function 7 · States 8 · UI 8 · A11y 8 · Security 7 · Code 7.5
- **Original items:**
  - ✅ `next_at` moves forward on read (`db/reminders.ts:48-56`). A new recurring reminder stores its next occurrence (`:81`).
  - ✅ A past one-off time is refused (`:67`).
  - ◐ Yearly is added (`:139`), and a day after the 28th asks for confirmation (`:68-73`). **But the yearly OS trigger is one month late** (regression 1, `components/finance/notify.ts:33`).
  - ✅ The header toggle has a role and `expanded` state (`:126-127`). The screen is wrapped in `KeyboardSafe` (`:131`).
  - ✅ A snooze warns when the repeating alert is unscheduled (`:104-107`).
- **Regressions:** the yearly month off-by-one.
- **Subscreens:**
  - Add form — 6 → 8.
  - Date+time picker — 7 → 7 (not verifiable statically).
  - Permission handling — 7.5 → 8.
- **Still needed for 10/10:**
  1. Use `month: d.getMonth()` (`components/finance/notify.ts:33`).
  2. Add an `anchor_at` column so a snooze or a day-31 reminder does not move the recurrence. The fix log lists this as partial, and `db/reminders.ts:65` overwrites `next_at`.
  3. Guard Snooze, Done and Delete against double taps. Two taps on Snooze schedule two alerts (`:92-110`, `:174-176`).

#### `app/finance/reports.tsx` — **6.5 → 7.5**
- **Scores now:** Function 7 · States 8 · UI 8 · A11y 7 · Security 7 · Code 8
- **Original items:**
  - ✅ Uses the shared compound-aware interest (`:13`, `:58`).
  - ◐ Period membership is still by `created_at` (`:53`). The fixer recorded this as a decision, and the empty state explains it (`:117-120`).
  - ✅ Overdue is derived through `listLedger` (`:52`, `:68`).
  - ✅ There is an empty state (`:117-120`) and a request-sequence guard (`:44`, `:48`, `:72`, `:75`).
- **Regressions:** none.
- **Subscreens:**
  - Month / Year / All Time segment — 6 → 7.
  - PDF / Excel export — 7 → 7.5. The PDF is deleted after sharing, but the Excel file is not (`:103`, unlike `io.tsx:38-40`).
- **Still needed for 10/10:**
  1. Delete the Excel export after sharing (`:103`).
  2. Decide whether period means activity or creation. "Interest earned this month" currently means loans created this month (`:53`, `:63`).

#### `app/finance/saved.tsx` — **6.5 → 8.0**
- **Scores now:** Function 8 · States 8 · UI 8 · A11y 8 · Security 8 · Code 7
- **Original items:**
  - ✅ Tapping an interest row shows its details with a Delete button, and Delete asks for a destructive confirmation (`:48-61`, `:82`).
  - ✅ The rate shows its unit and period, and legacy rows read "Rate N" (`:24-26`).
  - ✅ Every card has a role and label. Interest cards also have a delete accessibility action (`:119-123`). The inert-`TouchableOpacity` item is n/a: every row is pressable now.
  - ❌ Still no FlatList (`:109-137`).
- **Regressions:** none.
- **Subscreens:**
  - Segment — 7 → 7.
  - Interest details Alert (new, `:56-61`) — 7.5. It is an Alert rather than a sheet, and Delete opens a second Alert.
- **Still needed for 10/10:**
  1. Use a FlatList (`:116-135`).
  2. Show interest details in a sheet rather than chained Alerts (`:56-61`).

#### `app/finance/search.tsx` — **6.5 → 8.0**
- **Scores now:** Function 8 · States 8 · UI 7 · A11y 8 · Security 8 · Code 8
- **Original items:**
  - ✅ Amounts match exactly or by rupee-digit prefix (`:58`, `:78`; `utils/financeRules.ts:213-217`).
  - ✅ Result cards have a role and label (`:112-114`, `:133-135`).
  - ✅ Members are searched by name and phone (`:35`, `:62-70`; `db/chitti.ts:154-159`). The search bar is capped to `contentMax` (`:88`, `:158`).
  - ✅ There is a loading state, and "No matches" shows only when the data is ready (`:82-83`, `:102`, `:106`).
- **Regressions:** none.
- **Subscreens:** none.
- **Still needed for 10/10:**
  1. Normalise a phone-shaped query before matching. Mobiles are stored as 10 digits, so "+91 98765…" does not match (`:54`, `:67`).
  2. Say when results are capped at 40 or 20 (`:59`, `:79`, `:108`).
  3. Wrap the screen in `KeyboardSafe`, and announce the result count (`:100`).

#### `app/interest-calculator.tsx` — **7.0 → 7.5**
- **Scores now:** Function 3 · States 8 · UI 8 · A11y 8 · Security 8 · Code 9
- **Original items:**
  - ✅ Removed from `INSET_SCREENS` (`app/_layout.tsx:212-222`).
  - ✅ Redirects to `/finance/interest` (`:11`). `FinHeader` back falls back to `/finance` when there is no history (`components/finance/ui.tsx:63-65`).
- **Regressions:** none.
- **Subscreens:** none.
- **Still needed for 10/10:**
  1. It is still **UNWIRED**. A grep for `interest-calculator` in app/, lib/, components/ and utils/ finds only comments. It is reachable only by URL. Delete it once old links no longer matter.

#### `app/split.tsx` — **7.0 → 8.0**
- **Scores now:** Function 8 · States 8 · UI 8 · A11y 8 · Security 7 · Code 8
- **Original items:**
  - ✅ The divider is `adjustable`, with a value and increment/decrement actions through `clampRatio` (`:87-89`, `:141-151`). Swap, Close and Go back have roles and labels (`:122-131`, `:182-183`).
  - ✅ The PanResponder reads the ratio through a ref and depends only on `[axis, total]` (`:46-49`, `:75-85`).
  - ✅ `Platform` is removed, and `colors` is typed `Palette` (`:19-22`, `:174`). ◐/n/a `brandAlpha` is kept. It is the documented accent-tint token (`constants/theme.ts:82-99`).
- **Regressions:** none from the chat.tsx split. `ChatScreen` still accepts `chatIdProp` and `embedded` (`app/chat.tsx:164`). Behaviour at runtime is not verifiable statically, and `app/chat.tsx` has other agents' uncommitted edits.
- **Subscreens:**
  - "Needs two chats" refusal — 6 → 8.
  - "Not enough room" refusal — 6 → 8.
  - Divider resize — 4 → 8.
- **Still needed for 10/10:**
  1. The refusal title is `numberOfLines={1}` and truncates at large font scales (`:180`).
  2. Bar buttons are `minHeight: 32` with `hitSlop` 10 (`:196`). Prefer a 44 visual target.

---

#### Fix-log claims I could not confirm or that are overstated
- Claim #13 / per-screen "Reminders done 5": the Yearly option exists, but its OS trigger is wrong (regression 1).
- Claim #24: "deleteAuction writes a timeline row" is true. The comment in the screen was not updated (`chitti/[id].tsx:403-406`).
- Handoff `lib/themeCoverage.selftest.ts:43`: not done. `app/finance/` is still exempt.
- Everything else in the "Fixed" table matched the code at the cited places.

---

### I2 — re-rating (round 3: Shop Book split and admin web pages)

Base b8c8bd2 → HEAD 5d7c50b. The relevant commits are 9193a7a (Z-I2 gap fixes plus the split) and 902f3ba (FindShops permission follow-up).

Fix log: `fixes/ZI2.md`. Backend contracts are in `fixes/ZBE.md` and commit 3353236. They are **written, not deployed**.

This is a static, read-only review. Nothing here is device-, browser- or server-verified.

Old scores come from:
- `rerate2/X2.md` for `app/shop-book.tsx` and `admin/logs.html`.
- `rerate/I2.md` for `admin/index.html` and `admin/shopbook.html`, which X1–X3 did not re-rate.

| Screen | Old | New | Δ |
|---|---|---|---|
| app/shop-book.tsx (+ components/shopbook/*) | 6.5 | 7.5 | +1.0 |
| admin/index.html | 7.0 | 7.5 | +0.5 |
| admin/logs.html | 7.0 | 8.0 | +1.0 |
| admin/shopbook.html | 7.0 | 7.5 | +0.5 |

#### Checks I ran (all read-only)

**Split fidelity.** I extracted every top-level declaration from `b8c8bd2:app/shop-book.tsx` (5,516 lines, identical to `9193a7a^`). I diffed each one against the same declaration in the shell plus `components/shopbook/*`.
- All **72 declarations are present**. Three were added: `Bars`, `DraftLine` and `newDraftLine`.
- 15 are byte-identical. These include `CustomerLedgerView`, `AuditScreen`, `TxnRow`, `StatusPill`, `C`, `s` and `applyScheme`.
- Every other difference is one of the round-3 fixes the log describes (roles and labels, guards, validation, currency, keys), a comment moving to its new neighbour, or the `../lib/socket` → `../../lib/socket` path (`components/shopbook/shared.tsx:67`).
- I found no dropped handler, no changed prop contract (beyond the new `favErr`/`onRetryFavs`/`currency` props, which are wired at `app/shop-book.tsx:199-200` and `:308`) and no lost logic.

**Runtime palette reassignment.** I transpiled `theme.ts`, `shared.tsx` and `orders.tsx` with the repo's `babel-preset-expo`.
- `applyScheme` compiles to `exports.C=C=…; exports.s=s=…`, and importers read `_theme.C.x` / `_theme.s.x` at render time. The live binding is preserved.
- No split file copies `C`/`s` into a module-scope constant (grep shows only `newDraftLine`, `OWNER_ORDER_TABS` and `loadErrText` at module scope).
- There is no `React.memo`. The `useMemo`s (`customerViews.tsx:121`, `:283`, `products.tsx:768`) do not depend on the palette.
- FlatLists re-render on a scheme change because `contentContainerStyle={s.body}` changes identity. In RN 0.81, FlatList is a PureComponent that rebuilds its `renderItem` wrapper on every render in non-strict mode.

**Toolchain.**
- `npx tsc --noEmit -p .`: exit 0, **0 errors** in the whole repo. The fix log reported 4 errors in other agents' files; those are gone.
- `npx eslint app/shop-book.tsx components/shopbook/ services/shopBookService.ts utils/shopbook.ts`: exit 0, no output.
- Selftests, all exit 0: `utils/shopbook`, `utils/shopbookInvoice`, `services/khataWalkin`, `lib/finance/grid`, `utils/units`, `lib/a11yCoverage`, `lib/themeCoverage` (22), `lib/uiDebtRatchet`, `lib/silentFailure`, `lib/screenBackCoverage`, `lib/keyboardAvoidance`, `lib/responsiveLayout`, `lib/rowOverflow`, `lib/orphanRoutes` (51), `lib/permissionDeadEnd`, `lib/responsiveCoverage`, `lib/locationEgress`. The `silentFailure`/`orphanRoutes` failures the fix log mentioned no longer reproduce.

**Own a11y scan.** In the shell and all 12 split files: **0** `TouchableOpacity` without `accessibilityRole` and **0** `TextInput` without `accessibilityLabel`.

**Backend graceful-degradation check.**
- `httpx.Body` is plain `json.Unmarshal` (`vaultchat-backend-go/internal/httpx/httpx.go:91-103`). The pre-change `sbOwnerSetStatus` body struct has only `status`/`reason` (`b8c8bd2:…/routes/shopbook.go`). So today's server silently ignores the new `note` and the reject still succeeds.
- `request-pro` does not exist on today's server, so the button will alert "Could not send the request" (`components/shopbook/reports.tsx:191`).

**Admin pages.**
- I recomputed the SHA-256 of every `<script>` block.
- Each page has exactly one real inline script, and its hash matches the meta: `index.html:9` `cW3rzRw/…NeAM=`, `logs.html:9` `THG/u0WI…L5oY=`, `shopbook.html:9` `eYjOjo8H/…8kT4=`. The other "script" match is the regex text inside the HTML comment at `:7`, not a script.
- No `on*=` handlers and no `javascript:` URLs.
- `node --check` passes for all three extracted scripts.
- I fuzzed `logs.html`'s `overlap()` plus the append/trim step (`:201-229`) over 20,000 random windows. The DOM line sequence always equals the new window.

---

#### `app/shop-book.tsx` — **6.5 → 7.5** (mean 7.33)
- **Scores now:** Function 8.5 · States 8 · UI 6.5 · A11y 7 · Security 7.5 · Code 6.5

**Original items** (`rerate/I2.md` 1-11 plus the X2 additions):

1. ◐ **Reject reason.**
   - `rejectPayload` sends `note` only with `other`, trimmed and capped at 200 (`utils/shopbook.ts` `REJECT_NOTE_MAX`/`rejectPayload`; `components/shopbook/orders.tsx:624-628`).
   - The box is capped by `maxLength` (`shared.tsx:119`).
   - Both order views show `rejectNote` when present (`orders.tsx:254`, `:671`).
   - **Written, not deployed.** Today's server ignores the note (see checks), so the owner's words still do not reach the customer until the backend is live.
2. ✅ **Repeat order.**
   - Sends `productId` for catalog lines (`orders.tsx:183`).
   - One `repeatKey` per attempt, rotated on success (`:173`, `:188-189`).
   - A 409 price change prompts the customer the same way the cart does (`:194-204`).
   - Busy-guarded and disabled with state (`:175`, `:410-411`).
3. ✅ **Silent failures.**
   - `addList`/`removeList` alert on failure, and add is guarded (`customerViews.tsx:510-524`).
   - Loyalty/ledgers: `ErrorState`, with no fake "0 pts" (`:501-506`, `:540-558`).
   - Coupons/ratings: an inline retry (`:376-382`, `:412-416`).
   - Favourites: an inline retry plus an alert on toggle failure (`app/shop-book.tsx:168-191`; `customerViews.tsx:153-157`).
   - Stock history (`products.tsx:614-618`, `:727-728`) and countries (`settings.tsx:54-60`, `:237`) each show `ErrorState`.
   - The initial unread badge stays silent, with a stated reason (`app/shop-book.tsx:75-77`). That is acceptable.
   - Still silent: `myLocationRequest` (`settings.tsx:101`).
4. ✅ **Busy guards.**
   - `decide` (`orders.tsx:139-145`) and `setAvail` (`:563-569`) are guarded.
   - "Decline return" is disabled until there is a note (`:960-963`).
5. ✅ **Input validation.**
   - Typed quantity (`catalog.tsx:259-263`).
   - Coupon percent capped at 100 (`products.tsx:37-42`).
   - Purchase quantity and cost (`:455-463`).
   - HH:MM, lunch pair and prep 0–1440 (`settings.tsx:137-150`).
   - The on-mount location prompt is gone: the effect only reads the grant (`:125-131`).
6. ◐ **OwnerPlans and currency.**
   - ✅ No hard-coded prices (`reports.tsx:219`, `:229`). ✅ Every remaining `₹` is a fallback or a comment (grep).
   - ◐ **Request Pro** (`:187-193`, `:237-249`) depends on an undeployed endpoint (it 404s today, with an alert).
   - ◐ `requestedAt` is lost on reload.
   - ❌ There is no support contact channel.
7. ◐ **A11y.**
   - Every touchable now has a role and every input a label (my scan: 0 / 0).
   - Tabs and radios carry selected/checked state: TabBar (`shared.tsx:145-148`), the mode toggle (`app/shop-book.tsx:107-110`), owner filters (`orders.tsx:515-520`), report scope (`reports.tsx:287-290`), sort (`customerViews.tsx:307-310`), language (`:579-582`), coupon kind (`products.tsx:76-83`), status (`settings.tsx:227-229`), ReasonModal (`shared.tsx:107-110`) and stars (`orders.tsx:440-443`).
   - `Chip`, `Field` and `Switch` are labelled (`shared.tsx:182-184`, `:229-231`, `:240-241`).
   - Nested touchables are also offered as actions (`customerViews.tsx:221-222`, `reports.tsx:63-64`).
   - ❌ `lib/a11yCoverage.selftest.ts` is not tightened. However, `lib/uiDebtRatchet.selftest.ts` now freezes the per-file unroled count.
   - ❌ New findings: see "Still needed" items 1-3.
8. ◐ **NotificationCenter.** Rows read as one labelled element (`customerViews.tsx:655-656`). They are still a ScrollView `map` and not tappable (`:650-664`).
9. ✅ **Safe area and theming.**
   - The TabBar pads by `insets.bottom` (min 8), and tabs are at least 44 high (`shared.tsx:143-145`; `theme.ts:269-273`).
   - The amber/blue literals became tokens (`theme.ts:164-169`).
   - The `navyFill` token fixes white text on the dark navy (`theme.ts:54`, `:106`, `:204`, `:299`, `:314`).
10. ◐ **Code health.**
    - ✅ The file is split: the shell is 347 lines and the largest module is `orders.tsx` at 988 lines.
    - ✅ `Bars` is hoisted (`reports.tsx:372-392`).
    - ✅ `key={i}` is gone: DraftLine/client keys (`ledger.tsx:212-216`, `products.tsx:415`, `:464-468`) and content keys for read-only rows.
    - ✅ `Platform`, `deliveryBadge`, `planPrice` and `formatINR` were removed, and the stale "keyed on the scheme" comment was fixed (`app/shop-book.tsx:62-66`).
    - ❌ There is no shared load/err/retry hook: 19 copies of `setLoading(true); setErr('')` remain.
    - ❌ The `entitledPlan()` double fetch remains (`app/shop-book.tsx:279`).
    - ❌ `as any` remains (`shared.tsx:36`, `:308`, `:399`).
11. ❌ **Device verification** is still pending: upload, location, safe area, contrast and the repeat flow.

**Regressions from the split:** none in behaviour.
- **Follow-up commit 902f3ba.** After the split, `lib/permissionDeadEnd` flagged FindShops' `enableLocation`. In the monolith a file-level check had been satisfied by ShopSettings' `permissionDenied`. The follow-up adds a real Settings path (`customerViews.tsx:106-111`). That is an improvement over pre-split behaviour, not a loss.
- **Split housekeeping nits:**
  - Orphan trailing comments with no code after them: `app/shop-book.tsx:345-347` (the quick-link chevron note) and `settings.tsx:304-306` (the "upgrade surfaces" banner).
  - A stale "3,800-line screen" comment (`settings.tsx:71`).
  - All 12 files open with "moved … unchanged" (`shared.tsx:1-2` etc.), although each one holds round-3 edits.

**Subscreens:**
- Customer › FindShops — 6.5 → 7.5 (labelled search `:137`, favourites error/retry `:153-157`, Settings path `:106-111`; the load error has no retry control `:186`)
- Customer › ProductSearch — 6 → 7 (sort radios `:307-310`; still a fresh fix with no (0,0) guard `:261-262`; under 2 chars is silent `:271`)
- Customer › ShopFlow details — 6 → 7 (extras error/retry `:376-382`, `:412-416`; content keys `:460`; shop-currency coupons `:425`)
- Customer › Catalog + type-any + voice — 6.5 → 7.5 (steppers and inputs labelled `catalog.tsx:183-204`, `:222-254`; qty gate `:259-263`)
- Customer › CartView — 7 → 7.5 (labelled steppers `checkout.tsx:92-101`; live coupon message `:118`; an applied coupon is not re-checked when the cart shrinks `:28-36`)
- Customer › MyOrders — 7 → 7 (unchanged)
- Customer › OrderTrack — 6.5 → 7.5 (`orders.tsx:139-145`, `:173-209`, `:440-446`)
- ReasonModal (shared) — 6.5 → 7.5 (radios and `maxLength` `shared.tsx:107-119`; title is not a header and the radiogroup has no label)
- Customer › InvoiceView — 7 → 7.5 (backslash stripped `invoices.tsx:267`; label "Invoice PDF" vs visible "PDF" `:335`)
- Customer › ReturnRequest — 7 → 7.5 (qty labelled `orders.tsx:846`)
- Customer › CustomerLedgerView — 7 → 7 (byte-identical)
- Customer › CustomerProfile — 5 → 7 (`customerViews.tsx:495-558`, `:611-612`; no loading indicator before loyalty arrives)
- NotificationCenter — 5.5 → 6 (rows labelled; not tappable, not virtualized `:650-664`)
- Owner › load-failure state — 8 → 8.5 (`ErrorState` + retry `app/shop-book.tsx:290-295`)
- Owner › ShopSettings / Create shop — 6 → 7.5 (`settings.tsx:125-150`, `:227-229`, `:237`; `myLocationRequest` silent `:101`)
- Owner › OwnerDashboard — 7 → 7.5 (QR action `reports.tsx:59-64`; share catch `:46`)
- Owner › Shop QR — 7 → 7 (`navyFill` ink `:43`; title not a header `:40`)
- Owner › OwnerPlans — 6 → 7 (honest Request Pro `:187-249`; backend not deployed; no contact channel)
- Owner › OwnerReports — 6.5 → 7.5 (tabs `:287-290`, hoisted Bars with row labels `:374-392`; name keys `:334`, `:356`)
- Owner › OwnerCoupons — 6.5 → 7.5 (`products.tsx:32-42`, `:76-92`)
- Owner › OwnerSuppliers — 7 → 7.5 (inputs labelled `:160-167`)
- Owner › PurchasesScreen + Record step — 6 → 7 (gates `:455-463`, keys `:464-468`; product chips print "cube-outline" `:522`; no loading indicator in the list header `:564-579`)
- Owner › ReturnsScreen + Decline modal — 7 → 7.5 (`orders.tsx:927-936`, `:956-963`)
- Owner › AuditScreen — 7 → 7 (byte-identical)
- Owner › VerificationScreen — 7.5 → 7.5 (unchanged since X2; documents open in the external browser `verification.tsx:138-143`)
- Owner › OwnerOrders — 7 → 7.5 (tabs with selected `orders.tsx:515-520`)
- Owner › OwnerOrderDetail — 6 → 7.5 (`:563-569`, `:624-628`, `:687-701`)
- Owner › Suggest-alternative — 6.5 → 7 (labelled `:644-647`; the modal closes before `setAvail` settles, so a failure loses the typed alternative `:582-583`)
- Owner › BillScreen — 7 → 7.5 (labels `invoices.tsx:146`, `:176-185`; trash/put-back/apply are not disabled while `busy` `:176-186`, `:204-222`)
- Owner › Bill "Add an item" — 7 → 7.5 (labelled inputs `:81-87`; blank name explained `:90`)
- Owner › OwnerProducts — 7 → 7.5 (row labels `products.tsx:232-233`)
- Owner › ProductEditor — 7 → 7.5 (Field/Switch labelled via `shared.tsx:229-241`; tax % has no upper bound `products.tsx:322-324`)
- Owner › BulkAdd — 6 → 6.5 (keys `:802`; unparsed lines are not reported `:768`)
- Owner › StockScreen + item detail — 7 → 7.5 (history error `:614-618`, `:727`; kind chips print "cube-outline" `:713`)
- Owner › OwnerKhata (+ Add customer) — 7 → 7.5 (labels `ledger.tsx:123-151`)
- Owner › CounterSale — 6 → 7 (DraftLine keys `ledger.tsx:235-238`; shop currency `:311-312`; still goes straight to the share sheet, with a `ponytail:` note `:269-281`)
- Owner › KhataDetail (+ credit-limit) — 7 → 7 (currency fixed `:402`, `:627`; method chips print "cash-outline" `:666`; Share bill/receipt unreachable by screen reader, Still-needed item 3)

**Still needed for 10/10:**
1. **Dark-mode contrast (new finding, predates round 3).** White text on `C.green` measures about 1.9:1 in dark mode, which fails AA. Dark `C.green` is `#5BD08B` (`components/shopbook/theme.ts:48`); I computed white on it at 1.94:1. It is the fill under white text for:
   - `primaryBtn` (`:187-189`), `addBtn` (`:172-173`), `smallGreen` (`:198-199`)
   - `chipActive` (`:144`, text at `shared.tsx:186`), `statusBtnActive` (`:249`), `filterChipActive` (`:254-256`), `couponCode` (`:290-293`)

   Add a `greenFill` token the way `navyFill` (`:54`) was added.
2. **Chip glyph-name bug.** `Chip` renders its `icon` prop as text (`shared.tsx:185`). Payment-method chips therefore display "cash-outline CASH" (`ledger.tsx:666`), and purchase and stock-kind chips display "cube-outline …" (`products.tsx:522`, `:713`). Pass `""` or an emoji, or render an Ionicon.
3. **Unreachable Share button.** `TxnRow`'s `accessible` wrapper (`shared.tsx:308-319`) swallows LedgerRow's "Share bill/receipt" button (`:360-370`), so screen-reader users cannot issue a khata document (`ledger.tsx:529-531`). Expose it via `accessibilityActions`, as `ShopCard` does (`customerViews.tsx:221-222`).
4. **Deploy and verify.**
   - Deploy the ZBE backend so the reject note, Request Pro and `rejectNote` work.
   - Persist "Requested on" across reloads (fixer handoff: return `proRequestedAt` from `/my-shop`).
   - Device-verify upload, location, safe area, contrast and repeat order.
5. **NotificationCenter.** Use a FlatList with rows that open `data.orderId` (`customerViews.tsx:650-664`).
6. **Remaining state gaps.**
   - BillScreen `patch()` has no guard, and its row buttons are not disabled while busy (`invoices.tsx:49-54`, `:176-186`, `:204-222`).
   - Suggest-alternative closes before the result (`orders.tsx:582-583`).
   - The FindShops error has no retry control (`customerViews.tsx:186`).
   - `myLocationRequest` fails silently (`settings.tsx:101`).
   - ProductSearch is silent under 2 chars (`customerViews.tsx:271`).
   - A late stock-history response can land on the wrong item (`products.tsx:614-622`).
7. **Code health.**
   - Extract the load/err/retry hook (19 copies, e.g. `orders.tsx:24-28`, `products.tsx:26-30`).
   - Have `/my-shop` return the entitled plan (`app/shop-book.tsx:279`; `services/shopBookService.ts:969`).
   - Remove the orphan comments (`app/shop-book.tsx:345-347`, `settings.tsx:304-306`), the stale "3,800-line" note (`settings.tsx:71`) and the "unchanged" headers.
   - Type away `as any` (`shared.tsx:36`, `:308`, `:399`).
8. **Verification documents.** Open them in the in-app viewer rather than `Linking.openURL` (`verification.tsx:138-143`).
9. **Small validation.** Bound tax % (`products.tsx:322-324`) and report unparsed BulkAdd lines (`:768`). Add a support contact for Pro once one exists.

---

#### `admin/index.html` — **7.0 → 7.5** (mean 7.5)
- **Scores now:** Function 8.5 · States 7.5 · UI 7 · A11y 7.5 · Security 7.5 · Code 7.5

**Original items:**
1. ✅ **Tabs.** WAI-ARIA tabs with roving tabindex and Arrow/Home/End keys (`admin/index.html:147`, `:307-333`). Panels are `role=tabpanel` with `aria-labelledby` (`:150-223`).
2. ✅ **Live regions.** `#statusPill` and `#bcResult` are `role=status aria-live=polite` (`:142`, `:204`). `#logWrap` is `role=log aria-live=off`, deliberately, with the reason documented (`:216-219`).
3. ✅ **Focus and contrast.**
   - `outline:none` is gone and `select:focus` is fixed (`:30-31`). There is a global `:focus-visible` (`:33`).
   - `--faint` is .5 and `--sub` is .62 (`:20`). I estimate `--faint` at about 4.6:1 on `--bg`.
4. ◐ **Third-party resources.** Google Fonts are still loaded (`:13-15`), `style-src 'unsafe-inline'` remains (`:9`), and `frame-ancestors` needs a header (not verifiable).
5. ✅ **Navigation.** Topbar links to `/logs.html` and `/shopbook.html` (`:144`).
   - `admin/LOGS_DEPLOY.md` documents only `logs.html`, so whether `/shopbook.html` is deployed is not verifiable.
6. ✅ **Session revoke errors.** Shown inline with `role=alert` next to the row (`:461-471`).
7. ❌ **Light theme.** Still dark-only (`:11`).

**Regressions:** none. The hash matches.

**Subscreens:**
- Login — 7.5 → 7.5
- Dashboard — 7.5 → 7.5 (`loadDashboard` has no in-flight guard `:353`)
- Users — 7.5 → 7.5
- Messages — 7.5 → 7.5
- Sessions — 7.5 → 8 (`:461-471`)
- Broadcast — 7.5 → 8 (`:204`)
- Live Log — 7.5 → 7.5 (Pause has no `aria-pressed` `:501`)
- API Explorer — 7.5 → 7.5

**Still needed for 10/10:**
1. Self-host the fonts and drop them from the CSP (`:9`, `:13-15`). Send `frame-ancestors 'none'` as a header.
2. Document the deployment of `shopbook.html` next to `logs.html` (`admin/LOGS_DEPLOY.md:42-54`) so the link at `:144` resolves.
3. Add `aria-pressed` to Pause (`:501`). Announce the status pill only on a state change, not on every "Reconnecting…" retry (`:513-517`, `:574`).
4. Add an in-flight guard to the 10 s dashboard refresh (`:344-353`).
5. Support a light theme or `color-scheme: light dark` (`:11`, `:17-23`).

---

#### `admin/logs.html` — **7.0 → 8.0** (mean 7.92)
- **Scores now:** Function 8.5 · States 8.5 · UI 7 · A11y 7.5 · Security 8 · Code 8

**Original items:**
1. ✅ **In-flight guards.** `state.loading` and `state.sourcing` stop overlapping requests (`admin/logs.html:141-142`, `:259-260`, `:280-281`).
2. ✅ **`r.ok` and stale catches.**
   - `api()` checks `r.ok` and survives non-JSON responses (`:240-249`).
   - A 5xx reads as disconnected (`:290`).
   - The catches write "no connection" only while a token exists (`:272`, `:295`).
   - A token forgotten while a request is in flight is respected (`:263`, `:286`). Forget stops both timers (`:326-332`).
3. ✅ **Linking.** Linked from the console (`admin/index.html:144`). This page links back (`:79-80`), and the back link has a name (`:79`).
4. ✅ **Live region.** `#log` has `role=log aria-live=polite aria-relevant=additions` (`:108`), and the status has `role=status` (`:81`).
5. ✅ **Incremental render.** Only new lines are appended and the top is trimmed (`:201-229`). My fuzz run confirms the result always equals the new window.
6. ❌ **Browser check** of the ≤700px layout and the CSP: not done.

**Regressions:** none.

**Subscreens:**
- Token overlay — 8 → 8
- Source navigator — 7 → 7.5 (`aria-current` `:174`)
- Log view — 7 → 8 (`:213-234`)

**Still needed for 10/10:**
1. **Polite live region.** A full rebuild (first load, a source or filter change, up to 2,000 lines) replaces `innerHTML` inside the polite region (`:221-222`), and 2 s polling announces every new line. Suspend announcing during a rebuild or while the filter is typed in, or let the user toggle it.
2. **Highlighting.** `lineHtml` matches the filter against already-escaped HTML, so a filter such as `lt` or `amp` splits entities (`:189-192`). Highlight before escaping, or by text nodes.
3. Browser-verify the CSP and the ≤700px layout (`:9`, `:67-73`). Drop the hard-coded host from the footer (`:125`).

---

#### `admin/shopbook.html` — **7.0 → 7.5** (mean 7.67)
- **Scores now:** Function 7.5 · States 8 · UI 7 · A11y 7.5 · Security 8.5 · Code 7.5

**Original items:**
1. ◐ **Discoverability.** Linked from the console and from logs (`admin/index.html:144`, `admin/logs.html:80`). It links back (`admin/shopbook.html:55`). Deployment is still undocumented (`admin/LOGS_DEPLOY.md` mentions only `logs.html`).
2. ✅ **JSON validation.**
   - `countryProblems` and `categoryProblems` check required keys, types, the code and currency formats, `taxFields` shape, sort and enabled (`:270-317`).
   - A failing box gets `aria-invalid`, focus and a toast saying why (`:322-330`). There is also a red border (`:28`).
3. ✅ **Double-submit.** The delegated handler disables the clicked button and sets `aria-busy` until its promise settles (`:574-577`).
   - Gap: Enter in the key field calls `loadAll()` without that guard (`:597`).
4. ❌ **Entitlement form.** Still a chain of `prompt()`s (`:492-508`).
5. ◐ **Returns filter.**
   - Sends `?shopId=` and shows `Shop <id>` on each row (`:539`, `:548`).
   - Shows a "not filtered" warning only when the rows do not match (`:540-541`). That is correct against today's server: rows carry no `shopId`, so the warning shows.
   - The actual filter needs the backend deploy.
6. ✅ **Focus.** `:focus-visible` and `select:focus` (`:25-27`). ❌ Still dark-only (`:11`).

**Regressions:** none. The hash matches.

**Subscreens:**
- Connect bar — 7.5 → 7.5 (`:597`)
- Platform stats — 7.5 → 7.5
- Shop approvals — 7.5 → 8
- Verification queue + Documents — 7.5 → 8
- Location changes — 7.5 → 8
- Subscriptions / entitlements — 7.5 → 7.5 (prompt chain `:492-508`)
- Country tax engine — 5.5 → 7.5 (`:278-300`, `:319-336`)
- Categories & starter catalogs — 5.5 → 7.5 (`:301-317`)
- Support windows — 6.5 → 7 (`:532-553`; the filter needs the deploy)

**Still needed for 10/10:**
1. Replace the entitlement `prompt()` chain with a form that has a date input (`:492-508`).
2. Document deploying this page (`admin/LOGS_DEPLOY.md`), and deploy the backend `?shopId=` filter so the warning at `:541` disappears.
3. Route the Enter-to-connect path through the busy guard (`:597`).
4. Give the repeated action buttons names that include the shop (for example "Approve <name>" via `aria-label`, `:208-211`, `:357-359`, `:441-442`, `:484-486`). Consider a light theme (`:11`).

---

### J — Settings, privacy & vault: round-3 re-rating

Base b8c8bd2 → HEAD (5d7c50b). Round-3 commit for this batch: cfbe2bc (Z-J). The 13 screen files and their changed helpers (`lib/vaultKeyStore.ts`, `lib/privacyChecklist.ts`, `lib/statusPrivacySelection.ts`, `components/ui/Sheet.tsx`) have no uncommitted changes.

I checked the claims in `fixes/ZJ.md` against the current code. "Old" open items come from `rerate2/X2.md` (vault, encrypted-notes, status-privacy), `rerate/J.md` (settings, privacy-dashboard, ghost-mode, last-seen-privacy, login-history, vault-features, vaultbeam-settings, d2de-status) and the original J section (vaultcheck, filevault).

This review is static and read-only. **Nothing here is deployed or device-verified.** That covers the background re-lock and picker bracketing in the vault and notes, the sealed notes draft, `setSecure` on the dashboard, VoiceOver reachability and contrast: each counts only for what the code shows.

**Checks I ran myself (outputs are in `scratchpad/rerate3/J_*`):**
- `npx tsc --noEmit -p .` exited 0 with 0 errors (`J_tsc.txt`).
- `npx eslint` on the 13 screens plus `Sheet.tsx` gave 0 errors and 2 warnings. Both warnings are pre-existing exhaustive-deps warnings in `app/encrypted-notes.tsx:260` and `:369` (`J_eslint.txt`).
- `npx tsx` selftests, all exit 0:
  - privacyChecklist (6 passed)
  - statusPrivacySelection
  - a11yCoverage
  - themeCoverage (22 assertions, 20 exemptions)
  - orphanRoutes (51)
  - silentFailure
  - vaultCrypto
  - uiDebtRatchet ("no file got worse")
  - resumeLockPolicy
  - notesVault
  - screenBackCoverage
- Not run: full `npm test`, `npm run lint`, `openspec validate`.

**The chat.tsx split did not regress this batch.** The only VaultCheck caller moved to `components/chat/useMessageActions.ts:108-121`. It still passes only `attachmentId`, `msgType`, `mime`, `filename` and `isMine`, which matches the narrowed params at `app/vaultcheck.tsx:42`.

| Screen | Old | New | Δ |
|---|---|---|---|
| app/settings.tsx | 8.0 | 8.5 | +0.5 |
| app/privacy-dashboard.tsx | 8.0 | 8.5 | +0.5 |
| app/ghost-mode.tsx | 8.0 | 8.5 | +0.5 |
| app/last-seen-privacy.tsx | 7.5 | 8.5 | +1.0 |
| app/status-privacy.tsx | 7.5 | 8.5 | +1.0 |
| app/login-history.tsx | 8.0 | 8.5 | +0.5 |
| app/vault.tsx | 6.5 | 7.5 | +1.0 |
| app/vault-features.tsx | 6.0 | 8.0 | +2.0 |
| app/vaultcheck.tsx | 7.0 | 8.0 | +1.0 |
| app/vaultbeam-settings.tsx | 6.5 | 7.5 | +1.0 |
| app/filevault.tsx (redirect) | 8.0 | 8.5 | +0.5 |
| app/encrypted-notes.tsx | 6.0 | 7.0 | +1.0 |
| app/d2de-status.tsx | 7.0 | 8.0 | +1.0 |

---

#### `app/settings.tsx` — **8.0 → 8.5** (mean 8.33)
- **Scores now:** Function 9 · States 8 · UI 8.5 · A11y 8.5 · Security 8.5 · Code 7.5
- **Original items:**
  1. ✅ **One owner for the four privacy settings.** The four switches are now a single "Last seen & privacy" link (`app/settings.tsx:331-338`), and the owner is stated in `app/last-seen-privacy.tsx:9-10`. The dashboard chips became a read-only summary row (`app/privacy-dashboard.tsx:196-243`). A grep for `lastSeenVisible|profilePhotoVisible|readReceipts|discoverable` in `app/` now finds no editor other than last-seen-privacy (`app/dashboard.tsx:24-31` only reads them). The old "Read receipts" row is renamed "Per-contact receipts" and still opens `/receipt-control` (`:402`).
  2. ✅ **QR button.** The card is now a View with two sibling touchables (`:258-276`), and the QR button is 44×44 (`:629`). Actual VoiceOver reachability is not verifiable statically.
  3. ✅ **Stale hint and hard-coded white.** The "Light mode is rolling out…" hint is gone (`:564-566`). Thumbs, the active pill and the avatar initials use `colors.bubbleOutText` (`:322`, `:558-559`, `:608`, `:632`, `:654`).
  4. ✅ **Unused imports and casts.** `brandAlpha` is no longer imported (`:38-42`). FileSystem calls are typed (`:177-178`, `:184`).
  5. ✅ **Export cleanup.** Sharing is checked before anything is written (`:172-175`), and the file is deleted in a `finally` after the share (`:179-185`).
  - Handoff ✅: a "Security Hub" row links to `/dashboard` (`:401`).
- **Regressions:** none found.
- **Subscreens:**
  - Picker Sheet — 8.5 → 8.5. Cancel is now labelled and actions are keyed by label (`components/ui/Sheet.tsx:78`, `:90`).
  - Appearance control — 7.5 → 8.5. The hint is gone and the colours are tokens (`:557-566`).
  - Blocked users — 8.5 → 8.5.
- **Still needed for 10/10:**
  1. Local preferences still persist silently, with no failure path (D4):
     - `setAutoDownload` (`:296-298`), `setSaveToGallery` (`:320`) and `setUsageCounterEnabled` (`:144-147`).
     - The getters at `:89-90` and `isMfaEnabled()` at `:149` have no `.catch`.
     - A profile load failure is swallowed (`:114`), so the card shows "Your name" (`:260`, `:269`).
  2. Unblock has no in-flight guard, and its button stays enabled during the request (`:201-214`, `:489`). Its target is about 32pt tall (`paddingVertical: 8`, font 12, `:657`) and should be at least 44.
  3. About 25 `router.push('…' as any)` casts (for example `:198`, `:259`, `:273`, `:283`) and `e: any` catches. The file is 674 lines.

#### `app/privacy-dashboard.tsx` — **8.0 → 8.5** (mean 8.42)
- **Scores now:** Function 8.5 · States 8.5 · UI 8.5 · A11y 8.5 · Security 8 · Code 8.5
- **Original items:**
  1. ◐ **Screenshot blocking.** The row now uses `setSecure(true)`'s result (`app/privacy-dashboard.tsx:69-76`, `:82`), so a dev build reports Off (`lib/screenGuard.ts:119`). In a release build, though, `setSecure` returns `native || Platform.OS === 'android'` (`lib/screenGuard.ts:132`). On Android that is still `true` whatever happened, so the fact is still mostly a platform inference. Reading a fact this way also re-asserts FLAG_SECURE as a side effect (`:75`).
  2. ✅ **Per-row degradation.** Sources load with `Promise.allSettled` (`:69-76`). A failed source becomes `'unknown'` through `factOf` (`:46-48`), the row shows "Could not check" (`:155-156`, `:165`), and the row is left out of the score (`lib/privacyChecklist.ts:69-72`). An alert notice offers Try again (`:210-220`). The selftest covers this (6 passed).
  3. ✅ **Duplicate controls.** "Who can see" is a read-only summary that links to `/last-seen-privacy` (`:196-243`).
  4. ✅ **Back button and icon colour.** Back has `hitSlop={8}` (`:295`), and the check icon uses `bubbleOutText` (`:161`). Contrast is not verifiable statically.
- **Regressions:** none found. A load sequence guards stale loads (`:64-67`, `:77`, `:98`).
- **Subscreens:**
  - Score ring — 8 → 8.5. Unknown facts no longer distort it.
  - Checks list — 8.5 → 9.
  - Who can see — 8 → 8.5. It is now read-only with one destination.
  - Improve your score — 8.5 → 8.5.
- **Still needed for 10/10:**
  1. Report the real guard state rather than `native || android` (`lib/screenGuard.ts:132`), and read it without re-asserting it. The fixer's handoff proposes `isSecureNow()`.
  2. Contrast of `bubbleOutText` on `primary` for the "on" icon (`:161`, `:357`) is not verifiable statically.
  3. Remove the `as any` casts (`:108-109`) and the `r.route!` non-null assertion (`:273`).

#### `app/ghost-mode.tsx` — **8.0 → 8.5** (mean 8.25)
- **Scores now:** Function 8.5 · States 8.5 · UI 8.5 · A11y 8 · Security 8 · Code 8
- **Original items:**
  1. ✅ **Failed refresh with rows on screen.** An alert banner says "Showing your saved list — it could not be refreshed", with Try again (`app/ghost-mode.tsx:120-129`).
  2. ✅ **Unused bindings.** `GhostModeScreen` now only reads params (`:53-58`).
  3. ✅ **Clear.** It is single-flight, with `clearing` state, busy state and a spinner (`:216`, `:261-269`, `:344-346`). The `#fff` values are tokens (`:374`, `:399`). Header titles have the header role (`:99`, `:281`).
- **Regressions:** none found.
- **Subscreens:**
  - List view — 8 → 8.5.
  - Per-target editor — 8 → 8.
- **Still needed for 10/10:**
  1. **The editor has the same stale-refresh gap.** When a cached state was painted, a failed `getGhostMode` is swallowed (`:225`, `:230-231`).
  2. While one switch saves, the other switches stay enabled and their taps are silently ignored (`:240`, `:366-375`). Disable them, or show that they are waiting.
  3. Remove the `pathname: '/ghost-mode' as any` cast (`:157`).

#### `app/last-seen-privacy.tsx` — **7.5 → 8.5** (mean 8.5)
- **Scores now:** Function 9 · States 8.5 · UI 8.5 · A11y 8.5 · Security 8 · Code 8.5
- **Original items:**
  1. ✅ **Concurrent saves.** Saves are serialised: every Switch is disabled while one saves (`app/last-seen-privacy.tsx:50`, `:62`, `:124`). A failed save rolls back only the key that failed, using a functional update (`:68-69`). A per-row spinner shows progress (`:115`).
  2. ✅ **Consolidated with Settings.** This screen is now the only editor (header comment `:9-10`; Settings `:331-338`; dashboard `:229-243`).
  3. ✅ **Types and header role.** `icon` is a typed Ionicons name and keys are `PrivacyKey` (`:33-34`). The title has `accessibilityRole="header"` (`:86`).
- **Regressions:** none found.
- **Still needed for 10/10:**
  1. `toggle` has no unmount guard on `setSettings`, `setBusy` or the Alert (`:61-74`).
  2. The Switch label is the title only (`:121`). Add `row.info` as an `accessibilityHint`.
  3. Whether these settings are enforced on the server is not verifiable statically (`:107`).

#### `app/status-privacy.tsx` — **7.5 → 8.5** (mean 8.25)
- **Scores now:** Function 8 · States 8.5 · UI 8 · A11y 8.5 · Security 8.5 · Code 8
- **Original items:**
  1. ✅ **Save progress.** The header shows "Saving…" with a spinner in a polite live region (`app/status-privacy.tsx:112-117`). Mode rows and contact rows carry `busy` and `disabled` state (`:145`, `:181`).
  2. ✅ **Mode row labels.** Each label joins the label and the sub-text, with checked and selected state (`:143-145`).
  3. ✅ **Confirm before clearing a list.** Leaving a mode that holds people asks a destructive "Clear your list?" first (`:88-98`). The rule is `modeSwitchClearsList` (`lib/statusPrivacySelection.ts:16-18`), and the selftest passes.
- **Regressions:** none found.
- **Subscreens:** Contact selector — 7.5 → 8.
- **Still needed for 10/10:**
  1. A `listChats` failure blocks the whole screen, including picking a mode (`:53`, `:65-66`). Degrade it to "contacts could not load" and keep mode selection usable.
  2. Each checkbox tap is its own PUT, and every row is disabled while it runs (`:99-103`, `:178`). Picking several people is slow.
  3. The contact list is only peers of direct chats (`:58-63`). What the server means by "My contacts" is not verifiable statically.

#### `app/login-history.tsx` — **8.0 → 8.5** (mean 8.42)
- **Scores now:** Function 8 · States 8.5 · UI 8.5 · A11y 9 · Security 8 · Code 8.5
- **Original items:**
  1. ✅ **Header in every state.** The header, with Back and the header role, renders while loading too (`app/login-history.tsx:136-156`).
  2. ✅ **Cold-load error.** When `error && rows.length === 0`, the intro is hidden (`:179-187`).
  3. ✅ **Dead style and footer label.** `backTxt` is gone (`:255-282`). The footer has a label and busy state (`:213`).
- **Regressions:** none found.
- **Still needed for 10/10:**
  1. **A failed refresh is silent when cached rows are shown** (`:67-69`). Show a "showing saved list" notice, as `app/ghost-mode.tsx:120-129` now does.
  2. Try again shows no progress (`:168`); only pull-to-refresh shows the spinner.
  3. The "Done" alert after "Sign out others" fires even if the screen has unmounted (`:123`).

#### `app/vault.tsx` — **6.5 → 7.5** (mean 7.58)
- **Scores now:** Function 8 · States 8 · UI 8 · A11y 7 · Security 8 · Code 6.5
- **Original items (X2 list):**
  1. ✅ **Export gating.** The header export and the modal Export are both disabled unless `manifestState === 'ok'` (`app/vault.tsx:549-557`, `:758-761`). The handler also guards (`:498`). Sharing is checked before writing (`:500-503`), and "Last export" is recorded after `shareAsync` returns (`:508-513`).
  2. ✅ **Delete order.** The list is saved first, then the file is deleted (`:474-481`). This was already in HEAD before round 3.
  3. Re-lock and large files:
     - ◐ **Re-lock is done.** AppState `background` clears the key cache, wipes the open dir, clears the PIN, keys, list and modal, and returns to the gate (`:244-261`). Pickers, the share sheet and the whole add flow are bracketed by `withSystemUi` (`:239-243`, `:361`, `:366-400`, `:443`, `:508`), with a `ponytail:` comment naming the limit (`:235-238`). Needs a device check.
     - ❌ **Streaming is not done (D1).** Whole files are still read as base64 into JS memory (`:318-320`, `:424-430`).
  4. ✅ **Tokens and icons.** Emoji became Ionicons (`:59-64`, `:134`, `:155`, `:663`). Colours are tokens, and the scrim is a commented rgba (`:915-917`). Per-tab colours and the dead styles are gone (`:807-950`).
  5. ✅ **Touch targets.** Back is 44×44 with `hitSlop` (`:542`, `:818`), and Back is also on the gate (`:179-186`). Delete is 44×44 (`:900`). Long-press delete also has an `accessibilityAction` (`:679-680`).
  6. ✅ **Key notice.** `unlockVaultKeys` returns `miss: 'storage' | 'damaged' | 'pin'` (`lib/vaultKeyStore.ts:30-54`). The screen words each case, and the storage case has Try again (`:582-600`).
- **Regressions:** none found. When the app backgrounds mid-open, `handleOpen` keeps its captured PIN and deletes its temporary copy in `finally` (`:452-457`).
- **Subscreens:**
  - PIN gate — 7.5 → 8. The icons are hidden from a11y, Back is present and the header role is set (`:133-135`, `:154-157`).
  - File tabs and list — 7.5 → 8.
  - Export file list modal — 7 → 7. It is gated correctly, but see item 2 below.
- **Still needed for 10/10:**
  1. Stream large files instead of reading them as base64 (`:318-320`, `:424-430`; D1).
  2. **The modal's scrim is a touchable that wraps the panel** (`:732-737`). On iOS an accessible parent probably hides Export and Cancel from VoiceOver (not verifiable statically), and a tap on the panel's text dismisses the sheet. Make the scrim a sibling, as in `components/ui/Sheet.tsx:65`.
  3. When `keys` is null, new files fall back to v1 with a constant salt (`lib/vaultCrypto.ts:131`; D2).
  4. Re-lock fires only on `background` (`:247`). The file list may show in the iOS app-switcher snapshot during `inactive` (not verifiable statically). `vaultPin` stays in React state while unlocked (`:198`, `:228`).
  5. MIME types are hard-coded `'image/jpeg'` and `'video/mp4'` (`:379`, `:395`), although `asset.mimeType` exists; notes uses it at `app/encrypted-notes.tsx:432`. `retryKeys` has no busy state (`:303-305`, `:589`). `e.message` is read without `?.` (`:349`, `:451`). The component is 950 lines.

#### `app/vault-features.tsx` — **6.0 → 8.0** (mean 7.92)
- **Scores now:** Function 8.5 · States 8 · UI 8 · A11y 7 · Security 8 · Code 8
- **Original items:**
  1. ✅ **Expiry countdown.** A 1 s tick runs while a code is shown (`app/vault-features.tsx:145-152`). At zero the code is cleared locally (`:154-156`). The spoken label is per minute (`:292-296`).
  2. ✅ **Roles and decorative icons.** `CodeButton` has role, label and busy state (`:433-444`, `:298-303`). Generate has role and state (`:307-319`). Back is 44×44 with `hitSlop={10}` (`:266`, `:471`). Emoji became Ionicons hidden from a11y (`:424`), and the ⚡ badge is gone.
  3. ✅ **Dead styles and types.** The dead styles are gone (`:463-577`), and `saveSetting<K>` is typed (`:158`).
  4. ✅ **Tokens.** Colours are tokens; the scrim is a commented rgba (`:553-554`).
  5. ✅ **Error handling.** A `loadSettings` failure shows an inline alert with Try again (`:121-128`, `:340-347`). Copy and Share catch their errors (`:195-217`). Revoke is single-flight with a busy state (`:229-253`, `:303`).
  - ✅ The lock note uses `lockAppliesTo({signedIn, mfaOn, hasDevicePin})` (`:108-111`), and the resumeLockPolicy selftest passes.
- **Regressions:** **the lock-picker scrim now carries `accessibilityRole="button"` and `accessibilityLabel="Close"` while still wrapping the radio options** (`:380-412`). The nesting predates round 3; the explicit role and label were added in cfbe2bc. On iOS, VoiceOver probably announces one "Close" button and cannot reach the five radios (not verifiable statically).
- **Subscreens:**
  - Temp Chat Code — 7 → 8.5.
  - Auto screen lock picker — 7.5 → 7. The options are probably unreachable to VoiceOver (see Regressions).
  - Privacy link — 8 → 8.5.
  - Vault link — 7.5 → 8.5.
- **Still needed for 10/10:**
  1. Make the scrim a sibling of the panel, not its parent (`:380-387`), or use `components/ui/Sheet`.
  2. `lockApplies` is computed once at mount (`:108-111`). After turning on MFA or a PIN in Settings and coming back, the note is stale. Re-check on focus.
  3. The `setTimeout` that resets `codeCopied` has no unmount cleanup (`:200`).

#### `app/vaultcheck.tsx` — **7.0 → 8.0** (mean 8.17)
- **Scores now:** Function 8 · States 8.5 · UI 8.5 · A11y 7.5 · Security 8.5 · Code 8
- **Original items:**
  1. ✅ **Retry, timeout and progress.**
     - Try again comes with guidance (`app/vaultcheck.tsx:116-129`).
     - There is a 120 s timeout (`:35`, `:71-74`).
     - Elapsed seconds are shown (`:110-112`), with a hint for video (`:108`).
  2. ✅ **Colours.** Verdict colours are palette roles (`:26-32`, `:93`), and the error uses `colors.danger` (`:118`).
  3. ✅ **Share and Row.** Share has role and label (`:193-194`). `Row` has no line cap (`:212-221`).
  4. ✅ **Params and types.** The `uri` param is dropped, and only a string `attachmentId` is accepted (`:40-42`, `:62-63`). `S` is typed (`:212`).
- **Regressions:**
  1. **The timeout does not stop the analysis.** `Promise.race` rejects, but `verifyMedia` keeps running (`:71-74`), so the message "…was stopped" (`:72`) is not accurate. A retry starts a second analysis while the first may still be running.
  2. **The elapsed counter updates its polite live region every second** (`:110-112`). This is chatty for TalkBack. vault-features deliberately speaks per minute instead (`app/vault-features.tsx:292-294`).
- **Subscreens:**
  - Report view — 7 → 8.5.
  - Error state — 5 → 8.
- **Still needed for 10/10:**
  1. Make the timeout cancel the work, or reword it ("still running in the background"). Ignore a stale result after a retry (`:71-75`).
  2. Speak progress less often: give it a coarse label, or announce once (`:110-112`).
  3. Replace `key={i}` (`:159-160`, `:187-188`). Hide the decorative icons (`:118`, `:134`).

#### `app/vaultbeam-settings.tsx` — **6.5 → 7.5** (mean 7.33)
- **Scores now:** Function 5.5 · States 7.5 · UI 8 · A11y 8.5 · Security 7 · Code 7.5
- **Original items:**
  1. ❌ **The feature is still off.** `VB_AUTODOWNLOAD = false` (`constants/flags.ts:165`), and the screen discloses it (`app/vaultbeam-settings.tsx:52-57`). This is a product decision (D5).
  2. ✅ **Mobile data vs unmetered.** Picking "Mobile data only" also saves `unmeteredOnly: false` (`:76`). The switch is disabled and explains why (`:78-81`). This matches the engine, where cellular always counts as expensive (`lib/vaultBeamAutoDownload.ts:68`, `:73`).
  3. ✅ **Types and tokens.** The props are `Palette` and `ViewStyle` (`:32`, `:110-142`), `BRAND_ACCENT` is replaced by `colors.primary` (`:127`, `:139`), and section titles have the header role (`:113`).
- **Regressions:** none found.
- **Subscreens:** Auto-download options — 5.5 → 6.5.
- **Still needed for 10/10:**
  1. Ship the feature, or hide the screen until it ships (`:52-57`).
  2. `save()` neither awaits nor serialises (`:27-29`), so quick taps can fire overlapping `patchSettings` calls. The save-failure notice has no retry (`:59-64`).
  3. Drop the redundant `as VBMode`/`as VBNetwork` casts (`:68-77`). The Switch has no `thumbColor` (`:139`).

#### `app/filevault.tsx` (redirect) — **8.0 → 8.5** (mean 8.5)
- **Scores now:** Function 8 · States 9 · UI 8.5 · A11y 9 · Security 8.5 · Code 8
- **Original items:**
  1. ✅ **The destination works for every PIN length.** The vault accepts 4–8 digits (`app/vault.tsx:108-110`, `:159-166`), and the pinFormat selftest passed in earlier rounds.
  2. ◐ **Callers point at `/vault`.** `components/SafetyNavBar.tsx:23` now routes to `/vault` (integrated in 4ee0369). The `filevault` entry is gone from `INSET_SCREENS`, and a grep of `app/_layout.tsx` finds no `filevault`. No in-app reference to `/filevault` remains (repo grep). The alias itself is kept for old links.
- **Regressions:** the comment at `:10-11` still says "the in-app caller left is components/SafetyNavBar.tsx", which is no longer true.
- **Still needed for 10/10:**
  1. Fix the stale comment (`:10-11`). Delete the alias once no external link needs it; whether any deep link does is not verifiable statically.

#### `app/encrypted-notes.tsx` — **6.0 → 7.0** (mean 7.08)
- **Scores now:** Function 7.5 · States 8 · UI 6.5 · A11y 7.5 · Security 8.5 · Code 4.5
- **Original items (X2 list):**
  1. ✅ **Load after the gate, clear on re-lock.**
     - `loadNotes` runs only when `gate === 'open'` (`app/encrypted-notes.tsx:259-260`).
     - Re-lock clears the notes, `loadOk`, the modals and the generated password, and bumps `loadSeq` so an in-flight load cannot repaint (`:186-197`; checked at `:263-267`, `:270`, `:292`).
  2. ✅ **Drafts and Cancel.**
     - The draft is sealed under the DEK before the key is dropped (`:105-110`, `:180-185`), then reopened after the next unlock and load, with an alert (`:322-336`).
     - Pickers and share sheets are bracketed (`:170-174`, `:425-440`, `:488`, `:665`, `:678`), with a `ponytail:` comment (`:167-169`).
     - A dirty check backs a destructive "Discard changes?" confirm, which also covers Android back (`:407-421`, `:476-482`, `:956`).
     - Needs a device check.
  3. ✅ **Change passphrase.** `startChangePassphrase` checks the current passphrase with `checkPassphrase` first (`:751-760`, `:1270-1276`).
  4. ✅ **A11y.**
     - The generator, category chips, toolbar, colour dots, tag chips and toggle rows all have roles and labels (`:864`, `:871-882`, `:1008`, `:1058-1059`, `:1068-1069`). The toggle rows use the switch role with checked state (`:936-937`, `:1078-1087`).
     - Note cards have a "Move to trash" action (`:897-898`), Restore has a role (`:1183`), and the generator has `onRequestClose` (`:1129`).
  5. ◐ **Tokens and AppText.**
     - Done: `AppText` (`:24`), `HEADER_TOP` (`:1333`, `:1378`), `#555` → `textFaint`, `#EF4444`/`#ff6b6b` → `danger`, `#FFF` → `bubbleOutText`.
     - Still hex: the category and tag palettes (`:62-74`) and the `'#3B82F6'` defaults (`:224`, `:390`, `:401`, `:916-917`).
  6. ◐ **Split, iOS reminder, export cleanup.**
     - ❌ Not split: the file is now 1434 lines, up from 1286.
     - ✅ The reminder row is Android-only with a note elsewhere (`:1092-1109`).
     - ✅ The `.vcnotes` export is deleted after sharing, and Sharing is checked first (`:657-669`).
- **Regressions:** none found. Restoring a draft of a PIN-locked note reopens it without the per-note challenge (`:328-334`). This is a documented decision: the screen gate (same MPIN) has just been passed.
- **Subscreens:**
  - PIN gate — 7 → 7.5.
  - Notes list — 6 → 7.5. Labels, trash action, switch role.
  - Note editor — 6.5 → 8. Discard confirm, sealed draft, roles.
  - Markdown preview — 7 → 8. The toolbar is labelled.
  - Password generator — 7 → 8. It has `onRequestClose`.
  - Image viewer — 6 → 7.
  - Secure Trash — 7 → 8.
  - Locked-note challenge — 7.5 → 8.
  - Backup & restore — 7.5 → 8.5. The current passphrase is required, and the export file is deleted.
- **Still needed for 10/10:**
  1. Split the 1434-line component into gate, list, editor and backup. This also fixes the two exhaustive-deps warnings (`:260`, `:369`).
  2. Re-lock only on `background`, not on every non-`active` state (`:179`). As written, an iOS `inactive` event (Control Center, notification shade) closes the editor and every modal.
  3. **The gate's PinPad has no `length`, `minLength` or `onSubmit`, so it uses the default of 6** (`:809-814`; `components/PinPad.tsx:17`). `submitPin` accepts 4–8 digits (`:209`). Whether sign-in MPINs can be anything other than 6 digits is not verifiable statically. Mirror `app/vault.tsx:159-166`.
  4. Unhandled rejections and orphans:
     - `armNoteReminder` in `restoreNote` (`:564`) and `openAttachment` in `openAttachmentFile` (`:485`) can reject unhandled.
     - A failed draft seal (`:183-185`) orphans the draft's newly added attachments.
  5. Tokenise or exempt the palette hex values (`:62-74`, `:224`, `:390`, `:401`, `:916-917`).
  6. Hide or replace the emoji glyphs (`:900-904`, `:928`).
  7. Tag chips are 32pt (`:1364`) and category chips 36pt (`:1346`) with no `hitSlop`.
  8. Add an iOS reminder picker (`:1092-1109`).

#### `app/d2de-status.tsx` — **7.0 → 8.0** (mean 7.75)
- **Scores now:** Function 6.5 · States 8 · UI 8 · A11y 8.5 · Security 7.5 · Code 8
- **Original items:**
  1. ◐ **Safety-number link.** There is still no link: `verify-contact` needs a peer (D6). The copy now gives the exact path (`app/d2de-status.tsx:81-87`), and that path exists: `app/contact-info.tsx:404` titles the card "End-to-End Encrypted" while `E2EE_ENABLED = true` (`constants/flags.ts:13`).
  2. ✅ **A11y.** The score bar is hidden (`:49-54`). The score is a header with a spoken label (`:46-47`). Each layer card is one accessible element (`:65-66`).
  3. ◐ **Unverifiable claims.** `LAYER_INFO` for TLS and keystore is now worded as build intent (`:18-24`). The service label "Transport — encrypted on all connections" still states it as fact (`services/d2deService.ts:54`); this is not verifiable statically.
- **Regressions:** none found.
- **Still needed for 10/10:**
  1. Reword the service labels as build intent (`services/d2deService.ts:54-58`).
  2. The path copy names the "End-to-End Encrypted" card, which is titled "Encrypted in Transit" when the flag is off (`app/contact-info.tsx:404`). Derive the copy from the same flag.
  3. Function stays capped. This is a static readout of compile-time flags (`:1-4`) and cannot check a live conversation.
