# VaultChat — Screen-by-Screen Rating Report

_Date: 2026-10-04 · Branch base: `18eb6d2`_

## 1. Scope and method

- **Screens rated: 193.** That is every route file under `app/` (190 `.tsx` files, including the root, tab and finance layout shells) plus the 3 web admin pages in `admin/`. `app/(constants)/authService.ts` is a service module, not a screen, so it is not rated.
- **Subscreens rated: about 535.** These are the modals, bottom sheets, overlays, wizard steps, in-screen tabs and modes, and the pickers and components each screen renders. Each one is scored under its parent screen in §6.
- **This is a static, read-only code review.** 14 reviewers each read their screen files in full, plus the services those screens call. Every claim cites `path:line`. Anything code can't show — visual polish, behaviour on a real device, what the server enforces — is marked _"not verifiable statically"_. Nothing was deployed or tested on a device.
- **What was run:** the reviewers ran the repo's focused selftests where relevant: `a11yCoverage`, `themeCoverage`, `responsiveCoverage`, `screenBackCoverage`, `orphanRoutes`, `launchVeil`, `chatLockFactors`, `financeBtnLatch` and others. All of those passed.
- **What was not run:** `npm test`, `npm run lint` and `npm run typecheck` could not run, because `node_modules` is not installed in this environment. The `waImport` and `backupCrypto` selftests fail to load for the same reason.
- **Spot-checks:** I re-read the source behind 25 of the most serious claims before accepting them. They are marked **(verified)** in §3.

### Rubric
Each screen and subscreen is scored 0–10 on six dimensions:

| Dimension | What it measures |
|---|---|
| **Function** | Every control does real end-to-end work; no stubs, mock data or dead buttons; the screen is reachable. |
| **States** | Loading, empty, error, offline and retry states; protection against double submits; input validation. |
| **UI** | Theme tokens, light and dark mode, responsive layout, safe areas and keyboard handling, consistency with sibling screens. |
| **A11y** | Roles, labels and state on controls; touch target size; font scaling. |
| **Security** | Validation, exposure of sensitive data, confirmation before destructive actions, permission handling. |
| **Code** | Size and complexity, list virtualisation, re-renders, `as any`, dead code. |

**Overall = the mean of the six, rounded to the nearest 0.5.** For calibration: 10 means nothing meaningful left to improve, 5 means it works but has clear gaps, and 3 or below means broken, a stub, or unreachable.

## 2. Headline

- **Mean score across all 193 screens: 6.0 / 10.** No screen reaches 8.5 or above.
- **Distribution:**

| Score band | 8–8.5 | 7–7.5 | 6–6.5 | 5–5.5 | 3–4.5 | ≤2.5 |
|---|---|---|---|---|---|---|
| Screens | 7 | 41 | 85 | 28 | 28 | 4 |

- **Average score by area:**

| Area | Screens | Avg |
|---|---|---|
| A · Launch, auth, onboarding, app lock | 21 | 6.3 |
| B · Main tabs, contacts, links | 19 | 6.4 |
| C1 · Chat conversation (`chat.tsx`) | 1 (33 subscreens) | 6.0 |
| C2 · Chat tools, backup, import | 18 | 5.9 |
| D · Groups and communities | 18 | 6.1 |
| E · Calls, live, voice | 13 | 5.9 |
| F · Media, files, documents | 15 | 5.4 |
| G1 · Family Circle | 9 | 6.3 |
| G2 · Location, navigation, safety | 11 | 5.6 |
| H · Spaces (operations) | 17 | 5.6 |
| I1 · Finance | 21 | 6.6 |
| I2 · Shop Book and admin web pages | 4 (56 subscreens) | 6.0 |
| J · Settings, privacy, vault | 14 | 5.6 |
| K · Utilities, comfort, games, productivity | 12 | 6.1 |

## 3. Most serious findings across the app (fix these first)

Each item cites its source; full detail is in the matching area section of §6.

1. **The Vault can't be unlocked with a PIN set in the app (verified).**
   - `app/vault.tsx:94` checks the PIN only when exactly 8 digits are entered.
   - The only in-app way to set a PIN, `app/backup-pin.tsx:29-31`, accepts exactly 6 digits.
   - The vault also derives its key from the PIN with one fixed salt for every user (`lib/vaultCrypto.ts:15`), leaves decrypted copies in the cache (`app/vault.tsx:328`), and its "Export" shares a plaintext file list that it calls encrypted.
2. **Screens that report success they never achieved (verified).**
   - `offline-mode` says "N messages sent successfully" but sends nothing (`app/offline-mode.tsx:160-169`).
   - `call-recording` says "All participants have been notified" with no notification code behind it (`:356`), and its Share button only shows an alert (`:417`).
   - `email-bridge` shows mock inboxes and claims messages were sent encrypted.
   - `scanner` shows "AES-256 Encrypted · Sent Successfully".
   - `vaultdrop`'s Send is a 2-second timer.
3. **A user can get stuck on the security-block screen (verified).** Privacy Dashboard → "Blocked contacts" pushes `/blocked` (`app/privacy-dashboard.tsx:349`). That screen swallows the hardware back button (`app/blocked.tsx:141-143`), has the swipe gesture disabled and has no on-screen exit.
4. **App lock runs only at cold launch (verified).** `checkLockOnResume` (`services/lockService.ts:23`) has no caller. Per-chat locks can only be created from `app-lock-chats`, which nothing links to: `setChatLock` has a single caller, `app/app-lock-chats.tsx:168` (verified). A locked chat still sends read receipts and clears its notifications while the lock screen covers it, and `in-chat-search` reads locked chats without unlocking them.
5. **Emergency SOS is unreliable.**
   - Temporary `[sos-probe]` debug logging is still shipped, and its comment says the route "does not navigate" on a device (`app/emergency-sos.tsx:68-76`, verified).
   - In Family, the SOS message waits for location permission prompts before it is sent (`app/family.tsx:969`, verified).
   - If loading contacts fails, the screen says "No trusted contacts set up".
6. **Spaces transport doesn't work end to end.**
   - The run builder always saves riders with `stopId: null` (`app/space-runs-admin.tsx:151`, verified), so the driver's per-stop rider list is empty.
   - "Call guardian" is a placeholder alert (`app/space-run-driver.tsx:260-264`, verified).
   - Device commands (lock, ring, wipe) are never fetched by any client.
   - Driver safety alerts stay on the driver's phone.
7. **Settings that are saved but never read.**
   - Voice effect: `vc_voice_effect` appears only in `app/voice-effects.tsx` (verified).
   - The vault-features timers and toggles.
   - The "Left-behind alerts" switch: `lib/items/leftBehind.ts` is never imported (verified).
   - The VaultBeam roaming toggle.
   - Chat backup's "Include videos" switch.
   - Message requests: the `msgRequests` key is written only by `app/msgrequests.tsx` itself, so the list is always empty (verified).
8. **Media playback and editing are broken.**
   - The video seek bar never seeks: a `PanResponder` created once inside `useRef` keeps a stale `seekToPosition`, captured while `durationMs` was still 0 (`app/video-player.tsx:237-241, 327-347`, verified).
   - `media-viewer` defines its player components inside the render function, so they remount and playback restarts.
   - In `image-editor`, the brush colour and size and the brightness and contrast settings never reach the output.
9. **Bugs in `chat.tsx`.**
   - The quick-react modal can never open: `setReactPicker` is only ever called with `null` (`app/chat.tsx:2225, 4181`, verified).
   - `onSend` reads `composerLp` but leaves it out of its dependency list (`:1575` vs `:1605`, verified), so link previews are likely dropped.
   - A failed edit is not rolled back.
   - Forward and Copy are offered on view-once and Invisible Ink messages.
10. **Shop Book defects.**
    - The cart is shared across shops.
    - "Upgrade to Pro" only changes a display column; the backend gates on entitlements instead (`vaultchat-backend-go/internal/routes/shopbook.go:262-273`, verified).
    - Delete Product has no confirmation (`app/shop-book.tsx:2731`, verified).
    - There are 35 empty `catch {}` blocks, so errors show as empty lists.
11. **Finance on iOS and for screen readers.**
    - Every date picker calls the Android-only `DateTimePickerAndroid` with no iOS branch (verified).
    - `Field` uses its placeholder as the accessibility label (`components/finance/ui.tsx:134`, verified).
    - Chitti member numbers can collide (`app/finance/chitti/[id].tsx:100`, verified).
12. **Plaintext copies of private data.**
    - `bookmarks` and `scheduled` write decrypted message bodies to plain AsyncStorage.
    - `message-reminder` puts the message text in the notification tray.
    - The file viewer, archive viewer and file preview leave decrypted temp files that cache cleanup doesn't cover.
    - The ghost-mode list and login-history IPs are cached unencrypted.
    - `UsageCounter` POSTs raw pathnames, including invite codes from `/join/<code>`.
13. **Offline wipes the community list (verified).** `listCommunities` returns `[]` on any error (`lib/chatService.ts:2671`), which overwrites the cached list.
14. **Games: "Join a table by code" always opens Rummy (verified).** The code is `onOpen('rummy', …)` (`app/games.tsx:240`), although its comment says it opens the last game the player tapped.

## 4. App-wide patterns, and what reaching 10/10 means everywhere

These recur across most screens. Fixing them once, in shared code or in a selftest, raises scores across the board.

1. **The accessibility selftest is too narrow.** `lib/a11yCoverage.selftest.ts` only checks that icon-only buttons have labels, and it counts any `<Text>` child (even `'←'`) as a label. Rows, chips, tabs, toggles and `<Text onPress>` controls mostly lack `accessibilityRole` and `accessibilityState`. Extend the test to require a role on every `Touchable`/`Pressable` and state on toggles and selected chips.
2. **Errors look like empty states.** Many screens swallow load failures (`catch {}` or service functions that return `[]`) and then show "Nothing here". Make services throw, and render the existing `ErrorState` with a retry button (`components/finance/ui.tsx:472`) or an equivalent.
3. **Destructive actions with no confirmation.** Examples: Delete Product, Chess Resign, Rummy Drop, clearing game history, "Delete Forever" in notes, broadcast in the admin console, and the Alerts "Scan device" action, which can wipe keys.
4. **Unwired, legacy, mock and redirect routes.** 20 route files have no in-app entry point (§4a). Several of them make false claims. Delete them, or wire them in and make them real.
5. **Hard-coded dark-mode colours.** Hard-coded colours make some text unreadable in light theme. Examples: the media-viewer code view, video-player controls, SOS screen text, and the white "Remove lock" button text in `app-lock-chats`.
6. **Code health.** `chat.tsx` (4,588 lines, 44 `as any` casts, 30+ unused imports) and `shop-book.tsx` (5,364 lines) should be split into modules. Run `npm run lint` with dependencies installed to remove unused imports.
7. **Copy that doesn't match behaviour.** Examples: the privacy claims in `sync-contact`, the games voice sheet, `lock-settings` and `trusted-contacts`, and "on all your devices" in Calls. Make the copy match the code.

### 4a. Unwired screens (no in-app navigation found)

The reviewers grepped `router.push/replace`, `href`, `pathname` objects, data-array `route:` fields, tabs and deep links. Expo Router still opens any registered route through the `vaultchat://` scheme, so these routes are reachable only by URL.

`scanner`, `email-bridge`, `lock`, `vaultdrop`, `contact`, `app-lock-chats`, `biometric-setup`*, `security-questions`, `setup-complete`*, `call-recording`, `voice-effects`, `voice-speed`, `voice-transcribe`, `meeting-scheduler`, `slideshow`, `stickers`, `current-location`, `location-sharing`†, `sync-contact`†, `admin/shopbook.html` (web; not linked from any page).

\* Reachable only through an orphaned chain of legacy screens. † Linked only from `components/VaultFeatureSheet.tsx`, which nothing renders.

### 4b. Redirect-only routes (not real screens)

Their scores in §6 are not comparable with the other screens; read them as "keep the shim or delete it".

| Route | Redirects to | Reviewer score |
|---|---|---|
| `filevault` | `/vault` | 8 (wired) |
| `interest-calculator` | `/finance` | 7 (deep link only) |
| `group-chat` | `/chat` | 4 (unwired) |
| `creator-channels` | `/broadcast` | 3.5 (unwired) |

## 5. Master scorecard (all 193 screens)

Sorted by area, then score. Subscreen scores are in §6.

| Area | Score | Screen | Name | Wired |
|---|---|---|---|---|
| A | **2.5** | `app/lock.tsx` | Legacy CRED-style lock | **UNWIRED** |
| A | **3.5** | `app/biometric-setup.tsx` | Legacy biometric "registration" | Effectively **UNWIRED** (only via orphan chain) |
| A | **3.5** | `app/security-questions.tsx` | Legacy local security questions | **UNWIRED** |
| A | **4.5** | `app/backup-pin.tsx` | Device PIN setup | Yes (from Settings) |
| A | **4.5** | `app/setup-complete.tsx` | Legacy "crazzychat is Ready" | Effectively **UNWIRED** (only via orphan chain) |
| A | **6** | `app/app-lock.tsx` | Cold-launch lock / sealed-session unlock | Yes |
| A | **6.5** | `app/_layout.tsx` | Root shell (launch gate, veil, global overlays) | Yes (root) |
| A | **6.5** | `app/onboard-profile.tsx` | Profile step (1 of 3) | Yes |
| A | **6.5** | `app/restore-backup.tsx` | Restore chats on new phone | Yes (partially — see notes) |
| A | **6.5** | `app/blocked.tsx` | Security block screen | Yes (+1 mis-wired entry) |
| A | **6.5** | `app/permissions.tsx` | App permissions | Yes (from Settings) |
| A | **7** | `app/index.tsx` | Cold-start router | Yes (cold-start default) |
| A | **7** | `app/mpin-recover.tsx` | Forgot MPIN | Yes |
| A | **7.5** | `app/(tabs)/_layout.tsx` | Bottom tab bar | Yes |
| A | **7.5** | `app/onboard.tsx` | Mobile number landing | Yes |
| A | **7.5** | `app/email-verify.tsx` | SMS OTP entry | Yes |
| A | **7.5** | `app/onboard-security.tsx` | Security questions step (2 of 3) | Yes |
| A | **7.5** | `app/onboard-success.tsx` | Account secured / login hand-off | Yes |
| A | **7.5** | `app/mpin-entry.tsx` | Returning-user MPIN sign-in | Yes |
| A | **7.5** | `app/delete-account.tsx` | Delete account | Yes |
| A | **8** | `app/onboard-mpin.tsx` | Create MPIN (3 of 3) + commit | Yes |
| B | **3** | `app/contact.tsx` | Contact info (legacy mock) | **UNWIRED** |
| B | **4** | `app/msgrequests.tsx` | Message Requests | Yes (Settings) |
| B | **5.5** | `app/sync-contact.tsx` | Sync Contact (6-digit code) | **UNWIRED** |
| B | **6** | `app/i/[token].tsx` | Legacy invitation token redeem | Deep link only (legacy) |
| B | **6.5** | `app/(tabs)/status.tsx` | Status (stories) | Yes (tab) |
| B | **6.5** | `app/(tabs)/calls.tsx` | Calls log | Yes (tab) |
| B | **6.5** | `app/(tabs)/profile.tsx` | Profile | Yes (tab + Settings) |
| B | **6.5** | `app/(tabs)/alerts.tsx` | Security Alerts log | Yes (hidden tab, Chats header) |
| B | **6.5** | `app/new-chat.tsx` | New chat | Yes |
| B | **6.5** | `app/contacts.tsx` | Address-book discovery | Yes |
| B | **6.5** | `app/contact-info.tsx` | Contact Info | Yes |
| B | **6.5** | `app/qr-contact.tsx` | QR contact (My QR / Scan) | Yes |
| B | **6.5** | `app/add/[...segments].tsx` | Add by VaultID link | Deep link only |
| B | **7** | `app/(tabs)/chats.tsx` | Chats list | Yes (tab) |
| B | **7** | `app/join/[code].tsx` | Join group via invite code | Deep link only |
| B | **7** | `app/invite-link.tsx` | Group invite links | Yes |
| B | **7.5** | `app/search.tsx` | Global search | Yes |
| B | **7.5** | `app/verify-contact.tsx` | Verify safety number | Yes |
| B | **8** | `app/(tabs)/mini.tsx` | Mini Apps launcher | Yes (tab) |
| C1 | **6** | `app/chat.tsx` | Chat Conversation | Yes (30+ entry points, notification taps) |
| C2 | **3.5** | `app/app-lock-chats.tsx` | Per-chat lock settings | **UNWIRED** |
| C2 | **4.5** | `app/stickers.tsx` | Sticker picker | **UNWIRED** |
| C2 | **5.5** | `app/message-reminder.tsx` | Message reminders | Yes |
| C2 | **5.5** | `app/bookmarks.tsx` | Bookmarks | Yes |
| C2 | **5.5** | `app/chat-export.tsx` | Export chat | Yes |
| C2 | **5.5** | `app/chat-wallpaper.tsx` | Chat wallpaper | Yes |
| C2 | **5.5** | `app/broadcast.tsx` | Broadcast channels | Yes |
| C2 | **5.5** | `app/hidden-chats.tsx` | Hidden chats | Yes |
| C2 | **6** | `app/scheduled.tsx` | Scheduled messages list | Yes |
| C2 | **6** | `app/chat-themes.tsx` | Bubble theme | Yes |
| C2 | **6** | `app/chat-backup.tsx` | Chat backup | Yes |
| C2 | **6** | `app/backup-e2ee.tsx` | End-to-end encrypted backup | Yes |
| C2 | **6.5** | `app/schedule-message.tsx` | Schedule a message | Yes |
| C2 | **6.5** | `app/receipt-control.tsx` | Per-contact privacy (receipts/typing/last seen) | Yes |
| C2 | **6.5** | `app/import-chats.tsx` | Exit Kit (WhatsApp import) | Yes |
| C2 | **7** | `app/in-chat-search.tsx` | In-chat message search | Yes |
| C2 | **7** | `app/create-poll.tsx` | Create poll | Yes |
| C2 | **7** | `app/chat-code.tsx` | Chat by code | Yes |
| D | **3.5** | `app/creator-channels.tsx` | Creator Channels (redirect) | **UNWIRED** (redirect to /broadcast) |
| D | **4** | `app/group-chat.tsx` | Legacy Group Chat Redirect | **UNWIRED** (legacy redirect) |
| D | **5.5** | `app/group-admin.tsx` | Group Admin Controls | Yes (group-info) |
| D | **5.5** | `app/group-calls.tsx` | Group Call Hub | Yes (chat, group-info, calls tab) |
| D | **5.5** | `app/communities.tsx` | Communities | Yes (new-chat, dashboard, notifications) |
| D | **6** | `app/group-calendar.tsx` | Shared Calendar | Yes (family only) |
| D | **6** | `app/group-info.tsx` | Group Info | Yes (chat, chats tab, contact-info) |
| D | **6** | `app/group-notes.tsx` | Shared Notes | Yes (family only) |
| D | **6** | `app/create-group.tsx` | New Group (direct add) | Yes (new-chat) |
| D | **6.5** | `app/group-insights.tsx` | Group Insights | Yes (family only) |
| D | **6.5** | `app/group-privacy.tsx` | What This Group Can See | Yes (family, group-invitations) |
| D | **6.5** | `app/group-tasks.tsx` | Shared Tasks | Yes (family only) |
| D | **6.5** | `app/group-trip.tsx` | Group Trip | Yes (family only) |
| D | **7** | `app/group-create.tsx` | New Typed Group | Yes (family / family-setup) |
| D | **7** | `app/group-invitations.tsx` | My Invitations | Yes (chats tab, family, push) |
| D | **7** | `app/group-invites.tsx` | Add People / Sent Invitations | Yes (group-create, family, group-members) |
| D | **7** | `app/group-join.tsx` | Ask to Join | Yes (group card bubble) |
| D | **7** | `app/group-members.tsx` | Members & Roles | Yes (family, spaces layout) |
| E | **3.5** | `app/call-recording.tsx` | Call recording | **UNWIRED** |
| E | **4** | `app/voice-effects.tsx` | Voice effects | **UNWIRED** |
| E | **4.5** | `app/voice-speed.tsx` | Voice message speed player | **UNWIRED** |
| E | **5** | `app/network-test.tsx` | Network speed test | Yes (Settings) |
| E | **6** | `app/voice-transcribe.tsx` | Voice to text | **UNWIRED** |
| E | **6.5** | `app/voicecall.tsx` | Voice call | Yes |
| E | **6.5** | `app/videocall.tsx` | Video call | Yes |
| E | **6.5** | `app/incoming-call.tsx` | Incoming call ring | Yes (socket + notification) |
| E | **6.5** | `app/group-call-active.tsx` | Group call | Yes |
| E | **6.5** | `app/call-reliability.tsx` | Call reliability | Yes (Settings) |
| E | **6.5** | `app/live-view.tsx` | Live broadcast viewer / host stage | Yes |
| E | **7** | `app/live.tsx` | Go Live hub | Yes (Mini tab) |
| E | **7** | `app/live/join/[code].tsx` | Private live join | Yes (in-app + deep link) |
| F | **2** | `app/scanner.tsx` | "VaultScan" Document Scanner (mock) | **UNWIRED** (and a mock) |
| F | **3.5** | `app/video-player.tsx` | Video Player | Yes, narrow (VaultBeam bubble only) |
| F | **4** | `app/image-editor.tsx` | Image Editor | Yes (chat "Edit photo") |
| F | **4.5** | `app/media-viewer.tsx` | Universal Media Viewer | Yes (bubble, shelf, file-viewer) |
| F | **4.5** | `app/slideshow.tsx` | Image Slideshow | **UNWIRED** |
| F | **4.5** | `app/whiteboard.tsx` | Whiteboard | Yes (chat attach sheet) |
| F | **5** | `app/file-preview.tsx` | Syntax-highlighted File Preview | Yes, narrow (media-viewer CodeViewer only) |
| F | **5.5** | `app/docscanner.tsx` | Doc Scanner (photo → PDF) | Yes (Mini apps) |
| F | **6** | `app/media-gallery.tsx` | Shared Media (per chat / group album) | Yes (group-info, contact-info, family) |
| F | **6.5** | `app/file-viewer.tsx` | Universal File Viewer | Yes (bubble, gallery, archive, shop-book, media-viewer) |
| F | **6.5** | `app/shelf.tsx` | Bookshelf (all shared files) | Yes (Mini apps) |
| F | **6.5** | `app/archive-viewer.tsx` | Archive Browser | Yes (bubble, media-viewer, gallery) |
| F | **6.5** | `app/story-viewer.tsx` | Status/Story Viewer | Yes (status tab, chats list, chat header) |
| F | **7.5** | `app/camera.tsx` | Camera (Scan · Photo · Video) | Yes (chat attach sheet) |
| F | **7.5** | `app/reader.tsx` | Chat Reader | Yes (bubble "Read as page") |
| G1 | **5.5** | `app/family-map.tsx` | Live map / Meet Here / navigation | Yes |
| G1 | **6** | `app/family.tsx` | Spaces / Family hub | Yes |
| G1 | **6** | `app/family-history.tsx` | Location history | Yes |
| G1 | **6** | `app/family-items.tsx` | Find my things (BLE) | Yes |
| G1 | **6** | `app/family-setup.tsx` | Create / join circle | Yes (one buried row) |
| G1 | **6.5** | `app/family-member.tsx` | Member detail | Yes |
| G1 | **6.5** | `app/family-places.tsx` | Safe Zones | Yes (permission-gated tile) |
| G1 | **7** | `app/family-add.tsx` | Invite to space | Yes |
| G1 | **7.5** | `app/family-alerts.tsx` | Family alerts centre | Yes (in-app only; notification taps do not route here) |
| G2 | **4.5** | `app/location-sharing.tsx` | Location Sharing (3-mode) | **UNWIRED** (only from an unrendered component) |
| G2 | **4.5** | `app/current-location.tsx` | Current Location snapshot | **UNWIRED** |
| G2 | **4.5** | `app/emergency-sos.tsx` | Emergency SOS | Yes (family, deep link) |
| G2 | **5.5** | `app/location-lock.tsx` | Location Lock (setup / active) | Yes (navigate, family-places, notifications) |
| G2 | **6** | `app/location.tsx` | Share location (chat) | Yes (chat attach menu) |
| G2 | **6** | `app/navigate.tsx` | Navigate (turn-by-turn) | Yes (mini-apps, chat, family, shops, lock) |
| G2 | **6** | `app/lock-alert.tsx` | Location Lock exit alarm | Yes (lock service + notification tap) |
| G2 | **6** | `app/lock-history.tsx` | Lock History & Statistics | Yes (location-lock) |
| G2 | **6** | `app/lock-settings.tsx` | Alarm & Alert Settings | Yes (location-lock) |
| G2 | **6** | `app/trusted-contacts.tsx` | Trusted Contacts | Partly (only from SOS empty state) |
| G2 | **7** | `app/aiguardian.tsx` | Security Hub | Yes (mini-apps "Security Hub") |
| H | **4.5** | `app/space-devices.tsx` | Devices and theft protection | Yes (admin console only) |
| H | **4.5** | `app/space-runs-admin.tsx` | Run builder | Yes |
| H | **5** | `app/space-attendance.tsx` | Location-derived attendance | Yes |
| H | **5** | `app/space-run-driver.tsx` | Driver manifest | Yes |
| H | **5.5** | `app/space-checkin.tsx` | Check in / out and leave | Yes |
| H | **5.5** | `app/space-incidents.tsx` | Incident queue | Yes |
| H | **5.5** | `app/space-ops-map.tsx` | Live operations map | Yes |
| H | **5.5** | `app/space-pending.tsx` | Pending pickups | Yes |
| H | **5.5** | `app/space-visitors.tsx` | Visitor passes | Yes |
| H | **6** | `app/space-admin.tsx` | Space admin console | Yes |
| H | **6** | `app/space-leave.tsx` | Leave requests and approvals | Yes |
| H | **6** | `app/space-overview.tsx` | Operations dashboard | Yes |
| H | **6** | `app/space-people.tsx` | People / team board | Yes |
| H | **6** | `app/space-roster.tsx` | Roster | Yes |
| H | **6** | `app/space-run.tsx` | Guardian/rider run view | Yes |
| H | **6** | `app/space-tasks.tsx` | Work tasks | Yes |
| H | **6.5** | `app/space-transport.tsx` | Transport landing (parent/rider) | Yes |
| I1 | **5** | `app/finance/chitti/[id].tsx` | Lucky Draw group detail | Yes |
| I1 | **6** | `app/finance/customer.tsx` | Customer profile | Yes |
| I1 | **6** | `app/finance/ledger/edit.tsx` | Edit Ledger | Yes |
| I1 | **6** | `app/finance/reminders.tsx` | Finance Reminders | Yes |
| I1 | **6** | `app/finance/reports.tsx` | Reports | Yes |
| I1 | **6** | `app/finance/search.tsx` | Finance Search | Yes |
| I1 | **6.5** | `app/finance/index.tsx` | Finance Dashboard | Yes |
| I1 | **6.5** | `app/finance/calendar.tsx` | Finance Calendar | Yes |
| I1 | **6.5** | `app/finance/io.tsx` | Import / Export | Yes |
| I1 | **6.5** | `app/finance/ledger/new.tsx` | Add Ledger | Yes |
| I1 | **6.5** | `app/finance/ledger/[id].tsx` | Ledger detail | Yes |
| I1 | **6.5** | `app/finance/ledger/update.tsx` | Update Amount | Yes |
| I1 | **6.5** | `app/finance/saved.tsx` | Saved & History | Yes |
| I1 | **7** | `app/finance/chitti/index.tsx` | Lucky Draw list | Yes |
| I1 | **7** | `app/finance/chitti/new.tsx` | New Lucky Draw Group | Yes |
| I1 | **7** | `app/finance/interest.tsx` | Interest Calculator | Yes |
| I1 | **7** | `app/finance/ledger/index.tsx` | Ledger Book list | Yes |
| I1 | **7** | `app/interest-calculator.tsx` | Legacy interest-calculator redirect | **UNWIRED** in-app (deep-link shim only) |
| I1 | **7** | `app/split.tsx` | Split view (two chats) | Yes |
| I1 | **7.5** | `app/finance/emi.tsx` | EMI Calculator | Yes |
| I1 | **8** | `app/finance/_layout.tsx` | Vault Finance section shell | Yes |
| I2 | **5.5** | `app/shop-book.tsx` | Shop Book (Customer + Shop Owner mini-app) | Yes |
| I2 | **5.5** | `admin/shopbook.html` | Shop Book admin | **UNWIRED** |
| I2 | **6.5** | `admin/index.html` | Admin Console | Standalone web page (one inbound link) |
| I2 | **6.5** | `admin/logs.html` | Server log viewer | **UNWIRED** (direct URL only) |
| J | **2.5** | `app/vaultdrop.tsx` | VaultDrop | **UNWIRED** |
| J | **3.5** | `app/vault.tsx` | Vault | Yes |
| J | **3.5** | `app/vault-features.tsx` | Vault Features | Yes |
| J | **4.5** | `app/privacy-dashboard.tsx` | Privacy Dashboard | Yes |
| J | **5** | `app/encrypted-notes.tsx` | Encrypted Notes | Yes |
| J | **5** | `app/d2de-status.tsx` | Encryption status | Yes |
| J | **5.5** | `app/vaultbeam-settings.tsx` | VaultBeam auto-download | Yes |
| J | **6** | `app/ghost-mode.tsx` | Ghost Mode | Yes |
| J | **6.5** | `app/settings.tsx` | Settings | Yes |
| J | **6.5** | `app/status-privacy.tsx` | Status privacy | Yes |
| J | **7** | `app/last-seen-privacy.tsx` | Last Seen & Privacy | Yes |
| J | **7** | `app/vaultcheck.tsx` | VaultCheck (Verify media) | Yes |
| J | **7.5** | `app/login-history.tsx` | Active devices | Yes |
| J | **8** | `app/filevault.tsx` | File Vault (redirect) | Yes |
| K | **2.5** | `app/email-bridge.tsx` | Encrypted Email | **UNWIRED** |
| K | **3** | `app/offline-mode.tsx` | Offline Mode | Yes (Settings) |
| K | **4** | `app/meeting-scheduler.tsx` | Meeting Scheduler | **UNWIRED** |
| K | **6** | `app/notifications.tsx` | Alerts & Safety | Yes (vault-features, dashboard nav) |
| K | **6** | `app/storage-manager.tsx` | Storage Manager | Yes (Settings) |
| K | **6.5** | `app/notification-sounds.tsx` | Notifications & Sounds | Yes (Settings) |
| K | **6.5** | `app/dashboard.tsx` | Security Hub | Weak (only from `/notifications` nav bar) |
| K | **7.5** | `app/cache-cleanup.tsx` | Cache cleanup | Yes (Storage Manager) |
| K | **7.5** | `app/games.tsx` | Games hub + boards | Yes (Mini tab, push, deep link, chat card) |
| K | **8** | `app/vision-comfort.tsx` | Vision Comfort | Yes (Settings, chat menu, Eye Check) |
| K | **8** | `app/eye-check.tsx` | Eye Check | Yes (Vision Comfort) |
| K | **8** | `app/perf-debug.tsx` | Diagnostics | Yes (hidden long-press) |

## 6. Detailed ratings, subscreens and improvements by area

One section per area follows. Each lists every screen with its route, entry points, six dimension scores, every subscreen with its own score, strengths, and a numbered "To reach 10/10" list citing `path:line`.

## A — Launch, Auth, Onboarding & App Lock

Static read-only review. Every assigned file was read in full. Selftests run (all passed): `lib/orphanRoutes.selftest.ts` (19 assertions), `lib/launchVeil.selftest.ts`, `lib/onboardNav.selftest.ts`, `lib/confirmIdentity.selftest.ts`, `lib/permissionDeadEnd.selftest.ts`. Visual polish, real-device behaviour and server-side enforcement are not verifiable statically.

| Screen | Route | Wired? | Score |
|---|---|---|---|
| `app/_layout.tsx` (root shell) | — (root Stack) | Yes (root) | 6.5 |
| `app/index.tsx` | `/` | Yes (cold-start default) | 7 |
| `app/(tabs)/_layout.tsx` (tab bar) | `/(tabs)/*` | Yes | 7.5 |
| `app/onboard.tsx` | `/onboard` | Yes | 7.5 |
| `app/email-verify.tsx` | `/email-verify` | Yes | 7.5 |
| `app/onboard-profile.tsx` | `/onboard-profile` | Yes | 6.5 |
| `app/onboard-security.tsx` | `/onboard-security` | Yes | 7.5 |
| `app/onboard-mpin.tsx` | `/onboard-mpin` | Yes | 8 |
| `app/onboard-success.tsx` | `/onboard-success` | Yes | 7.5 |
| `app/mpin-entry.tsx` | `/mpin-entry` | Yes | 7.5 |
| `app/mpin-recover.tsx` | `/mpin-recover` | Yes | 7 |
| `app/app-lock.tsx` | `/app-lock` | Yes | 6 |
| `app/restore-backup.tsx` | `/restore-backup` | Yes (partially — see notes) | 6.5 |
| `app/delete-account.tsx` | `/delete-account` | Yes | 7.5 |
| `app/blocked.tsx` | `/blocked` | Yes (+1 mis-wired entry) | 6.5 |
| `app/permissions.tsx` | `/permissions` | Yes (from Settings) | 6.5 |
| `app/backup-pin.tsx` | `/backup-pin` | Yes (from Settings) | 4.5 |
| `app/setup-complete.tsx` | `/setup-complete` | Effectively **UNWIRED** (only via orphan chain) | 4.5 |
| `app/biometric-setup.tsx` | `/biometric-setup` | Effectively **UNWIRED** (only via orphan chain) | 3.5 |
| `app/security-questions.tsx` | `/security-questions` | **UNWIRED** | 3.5 |
| `app/lock.tsx` | `/lock` | **UNWIRED** | 2.5 |

---

### `app/_layout.tsx` — Root shell (launch gate, veil, global overlays) — **6.5/10**
- **Route:** root Stack (wraps every route) · **Entry points:** app launch; also the owner of auth redirects `app/_layout.tsx:264-291`.
- **Purpose:** Boot sequence (polyfills, Sentry, FLAG_SECURE, security scan, push/call/notification wiring) plus the launch auth gate and opaque veil; mounts UpdateGate → TermsGate → UsageCounter → CallBar → Stack (`app/_layout.tsx:890-1046`).
- **Scores:** Function 8 · States 7 · UI 7 · A11y 7 · Security 7 · Code 4
- **Subscreens:**
  - Launch veil (Overlay, `app/_layout.tsx:1054-1061`) — **8/10** — opaque `colors.bg` cover until gate lands, latched by `landed` (`:310-314`) and hidden from a11y via `accessibilityElementsHidden`/`importantForAccessibility` (`:880-881`); guarded by `lib/launchVeil.selftest.ts` (passes). Fix: no timeout by design (`lib/launchGate.ts:53-58`) — if `getLaunchSessionState` never settles the veil never drops; consider a visible "still starting" state rather than an indefinite blank.
  - UpdateGate (Overlay/blocking screen, `components/UpdateGate.tsx:43-80`) — **6.5/10** — real version check (`:32-35`), fails open; but "Update now" is a silent no-op when the server sends no `updateUrl` (`:38-41`), the version is checked only once at mount (`:26-36`), the advise bar has no top inset despite `edgeToEdgeEnabled` (`components/UpdateGate.tsx:122-125`, `app.json:46`), strings are English-only while TermsGate uses `t()`, and `UpdateSpinner` (`:84-90`) has no importer. Fix: fall back to a platform store URL and recheck on AppState `active`.
  - TermsGate (Overlay/blocking screen, `components/TermsGate.tsx:107-151`) — **6.5/10** — real accept POST (`lib/terms.ts:82-87`) with error kept on screen (`:91-95`), i18n via `t()`. Defects: the foreground re-check reads a stale `state` captured at mount (`:73`, deps `[]` at `:82`) and `fetchTermsState()` without `force` returns the cached answer (`lib/terms.ts:27`), so terms republished mid-process are never noticed despite the comment at `:70-71`; signed-out polling continues every 30 s indefinitely (`:63-64`); no ScrollView around a full-screen block of translated copy (`:108-150`); a11y label hard-coded English (`:140`). Fix: call `fetchTermsState(true)` on foreground and read state via a ref.
  - ErrorBoundary (Overlay, `components/ErrorBoundary.tsx:25-34`) — **5/10** — NOT mounted at the root: root only gets `Sentry.wrap` when `EXPO_PUBLIC_SENTRY_DSN` is set (`app/_layout.tsx:1079`); the component is used only by media-viewer, archive-viewer, games, reader. `componentDidCatch` only `console.error`s (`:20-22`), "Try Again" has no `accessibilityRole` (`:30`). Fix: wrap `RootLayoutInner` in it (or export an expo-router `ErrorBoundary`) and report to Sentry.
  - UsageCounter (headless observer, `components/UsageCounter.tsx:17-29`) — **6/10** — one observer instead of 195 call sites, opt-out honoured (`lib/usageCounter.ts:106-107`). Privacy defect: it counts the raw `usePathname()` (`:18,24`), which for dynamic routes registered in the root (`join/[code]` `app/_layout.tsx:940`, `live/join/[code]` `:943`, `add/[...segments]` `:947`) contains the invite code/segments, and the counts are POSTed to `/app/usage` (`lib/usageCounter.ts:126`). Fix: count `useSegments()`/route template names, not the resolved path.
  - CallBar (Overlay, `components/CallBar.tsx:103-132`) — **7/10** — live store subscription (`:43`), live insets (`:56-60`), descriptive a11y label with timer (`:110`), labelled End-call (`:126`). Issues: `display: Platform.OS === 'web' ? 'flex' : 'flex'` is dead and the "hidden on narrow screens" comment is false (`:161-162`); End-call target is 30 dp + hitSlop 8 (`:127,165-166`); hard-coded `#1F9D55` (`:141`, documented). Fix: actually hide the CTA below a width breakpoint and enlarge the end target to 44.
- **Strengths:**
  - Root owns the auth decision and stashes the deep link on every redirecting branch, including the catch (`app/_layout.tsx:264-291`), replayed by `resetTo` (`lib/authNav.ts:43-52`).
  - App-wide FLAG_SECURE before the veil drops (`app/_layout.tsx:242`, `lib/screenGuard.ts:107-119`).
  - Notification/call routing de-duplicated (`app/_layout.tsx:424-427`, `:724-734`).
- **To reach 10/10:**
  1. Order the security verdict against the launch gate: `runSecurityCheck` does its own `router.replace('/blocked')` (`app/_layout.tsx:374`) independently of the gate's `router.replace('/onboard'|'/app-lock')` (`:271,276,290`); a gate that settles after the scan would replace `/blocked`. Make the gate await or re-check the verdict.
  2. Relock on resume: the MFA/sealed gate runs only once per cold launch (`:264-276`); `checkLockOnResume` in `services/lockService.ts:23` has no caller.
  3. Mount an error boundary at the root (`:1069-1079`), see ErrorBoundary above.
  4. Remove orphan routes still registered and deep-linkable via `vaultchat://` (`app.json:8`): `security-questions`, `biometric-setup` (`app/_layout.tsx:935-936`), `lock` (`:950`).
  5. Split the 1079-line file: call routing (`:404-799`), notification ingest (`:576-634`) and boot work into hooks/modules; drop the `as any` route casts (`:271,276,290,432,664,669,749,754,807`).
  6. Fix UsageCounter path leak and TermsGate stale recheck (above).

### `app/index.tsx` — Cold-start router — **7/10**
- **Route:** `/` · **Entry points:** expo-router initial route, registered `app/_layout.tsx:934`.
- **Purpose:** Waits for the root gate (`launchAllowed`), then routes to `/restore-backup` or `/(tabs)/chats` (`app/index.tsx:44-48`).
- **Scores:** Function 8 · States 7 · UI 6 · A11y 5 · Security 8 · Code 8
- **Subscreens:** Fallback splash view (Overlay, `app/index.tsx:80-88`) — **6.5/10** — mirrors native splash (`:92-94`); hard-coded `#010628`, image has no `accessible={false}`/label.
- **Strengths:**
  - No longer races the root gate (`app/index.tsx:30-44`, `lib/launchGate.ts:51-63`).
  - Local-only restore eligibility check (`lib/restoreGate.ts:84-91`).
- **To reach 10/10:**
  1. The restore offer only runs on launches the gate allowed (`app/index.tsx:44-46`); a returning user signing in on a new phone goes `mpin-entry` → `resetTo('/(tabs)/chats')` (`app/mpin-entry.tsx:46`) and never passes here, so the restore prompt is skipped in exactly the "new phone" case it was built for. Route post-sign-in through the same `shouldCheckRestore` check (e.g. inside `resetTo` when heading into tabs, `lib/authNav.ts:43`).
  2. The catch (`app/index.tsx:49-52`) leaves the user on the fallback view if `router.replace` throws; log it at least.
  3. Mark the fallback image decorative (`app/index.tsx:82-86`).

### `app/(tabs)/_layout.tsx` — Bottom tab bar — **7.5/10**
- **Route:** `/(tabs)/{chats,status,mini,calls,profile,alerts}` · **Entry points:** `app/index.tsx:48`, `app/mpin-entry.tsx:46`, `app/onboard-success.tsx:70`, `app/app-lock.tsx:37`, `app/restore-backup.tsx:71`; registered `app/_layout.tsx:938`.
- **Purpose:** Floating glass tab bar with raised Mini Apps button and unread badge.
- **Scores:** Function 8 · States 8 · UI 8 · A11y 6 · Security 8 (n/a — nothing sensitive) · Code 7
- **Subscreens:** Mini Apps center button (Tab item, `app/(tabs)/_layout.tsx:25-45,136`) — **7/10** — hard-coded gradient hex (`:35`), bar hidden on that screen (`:136`).
- **Strengths:**
  - Clears system nav bar with live insets (`:102-106`) and grows with font/vision scaling (`:149-153`).
  - Reduced-motion respected (`:54-66`).
- **To reach 10/10:**
  1. The unread count is drawn (`:79-83`) but no `tabBarAccessibilityLabel`/`tabBarBadge` is set (`:122`), so screen readers get "Chats" with no count.
  2. Labels are capped at `maxFontSizeMultiplier={1.2}` (`:42,85`); allow larger scale with the 2-line fallback already present.
  3. `useStyles`/`useUnreadTotal` run in every tab icon instance (`:30,52,73`); compute once in `TabLayout` and pass down.
  4. Move gradient/shadow hex (`:35,170`) into theme tokens.

### `app/onboard.tsx` — Mobile number landing — **7.5/10**
- **Route:** `/onboard` · **Entry points:** `app/_layout.tsx:271,290`, `app/app-lock.tsx:89`, `app/delete-account.tsx:105`, `app/(tabs)/profile.tsx:254`, `lib/api.ts:499`, `app/onboard-success.tsx:52,90`.
- **Purpose:** Phone → `/auth/lookup` → existing user to `/mpin-entry`, new user sends SMS OTP → `/email-verify` (`app/onboard.tsx:40-63`).
- **Scores:** Function 8 · States 7 · UI 8 · A11y 7 · Security 6 · Code 8
- **Subscreens:**
  - Country picker (Modal in PhoneField, `components/auth/PhoneField.tsx:92-114`) — **6.5/10** — rows have no `accessibilityRole`/`selected` state (`:98-109`), sheet has no bottom safe-area padding (`:131`), and taps on the sheet's non-touchable area bubble to the backdrop Pressable (`:93-94`). Fix: Sheet-style modal with roles and insets.
- **Strengths:**
  - Per-country national length validation (`components/auth/PhoneField.tsx:40-47`) and trimming on country change (`:104`).
  - Busy guard + labelled CTA with busy state (`app/onboard.tsx:41,86-89`); 429/423 messages name the wait (`lib/onboarding.ts:85-98`).
- **To reach 10/10:**
  1. Existing-account sign-in requires only phone + MPIN, no SMS possession factor (`app/onboard.tsx:46-47`), and `/auth/lookup` returns `userId` unauthenticated (`lib/onboarding.ts:136-138`); add OTP (or device binding) before `/mpin-entry`. Server lockout is only a comment (`app/mpin-entry.tsx:2`) — not verifiable statically.
  2. PhoneField's TextInput has no `accessibilityLabel` (`components/auth/PhoneField.tsx:81-90`); the "MOBILE NUMBER" caption (`app/onboard.tsx:77`) is not associated.
  3. Use a ref latch for double-submit like email-verify does (`app/onboard.tsx:41` vs `app/email-verify.tsx:53`).

### `app/email-verify.tsx` — SMS OTP entry — **7.5/10**
- **Route:** `/email-verify` · **Entry points:** `app/onboard.tsx:56`.
- **Purpose:** Verifies phone OTP → `phoneTicket` → `/onboard-profile` (`app/email-verify.tsx:84-100`).
- **Scores:** Function 8 · States 8 · UI 8 · A11y 7 · Security 7 · Code 7
- **Subscreens:**
  - "Didn't get the code?" Sheet (Sheet, `app/email-verify.tsx:183-192`) — **8/10** — real voice/WhatsApp resend (`lib/onboarding.ts:120-125`), Sheet has scrim label and `accessibilityViewIsModal` (`components/ui/Sheet.tsx:63-64`).
- **Strengths:**
  - Synchronous in-flight ref prevents autofill double-POST (`app/email-verify.tsx:42-53,85-86`).
  - Wall-clock cooldown from the server value and lockout `retryAfter` (`:59-82,97-98`).
  - Masked number + live-region errors (`:33,165`).
- **To reach 10/10:**
  1. No guard when the in-RAM onboarding store is empty (process death / deep link): `phone` may be `''` and is POSTed (`app/email-verify.tsx:39,89`; store is module memory `lib/onboarding.ts:58-64`). Redirect to `/onboard` if `!phone`.
  2. Rename the route as the file header itself asks (`:6-13`).
  3. MpinInput's hidden input/Pressable have no a11y label (`components/auth/MpinInput.tsx:58,69-79`).

### `app/onboard-profile.tsx` — Profile step (1 of 3) — **6.5/10**
- **Route:** `/onboard-profile` · **Entry points:** `app/email-verify.tsx:91`.
- **Purpose:** Collects optional email, names, DOB (≥13), status, local avatar into the onboarding store; nothing sent (`app/onboard-profile.tsx:104-112`).
- **Scores:** Function 7 · States 6 · UI 8 · A11y 5 · Security 7 · Code 7
- **Subscreens:**
  - Photo source Sheet (Sheet, `app/onboard-profile.tsx:235-241`) — **8/10** — camera/gallery/remove with permission dead-end handling (`:81`).
  - Date of birth picker (Picker, `app/onboard-profile.tsx:184-199`) — **6/10** — trigger `TouchableOpacity` has no role/label (`:185`).
- **Strengths:**
  - Local-date ISO formatting fixes the UTC off-by-one (`:42-58`).
  - Optional email validated only when typed (`:99-102`).
- **To reach 10/10:**
  1. Round-trip bug: returning to this step re-parses `st.dob` with `new Date('YYYY-MM-DD')` (`:71`), which is UTC midnight and shows the previous day west of UTC — the same class of bug `:42-53` fixed on the way out. Parse with local components.
  2. Label inputs: none of the TextInputs carry `accessibilityLabel` (`:157,160-170,176,180,202-209`).
  3. `pickFrom` has no try/catch around permission/launch calls (`:77-88`).
  4. Header comment says the palette is fixed night (`:13-15`) but `useAuthTheme` switches on scheme (`lib/useAuthTheme.ts:9`); correct the comment.

### `app/onboard-security.tsx` — Security questions step (2 of 3) — **7.5/10**
- **Route:** `/onboard-security` · **Entry points:** `app/onboard-profile.tsx:111`.
- **Purpose:** Pick `REQUIRED_SECURITY_ANSWERS` distinct questions + answers into the store (`app/onboard-security.tsx:28-43`).
- **Scores:** Function 8 · States 7 · UI 8 · A11y 7 · Security 7 · Code 8
- **Subscreens:**
  - Question picker (Modal in SecurityQuestionRow, `components/auth/SecurityQuestionRow.tsx:58-75`) — **6.5/10** — options lack role/selected state (`:64-70`), no bottom inset (`:91`), sheet taps bubble to backdrop (`:59-60`).
- **Strengths:**
  - Duplicate questions excluded across rows (`app/onboard-security.tsx:77`, `components/auth/SecurityQuestionRow.tsx:27`).
  - Labelled select (`components/auth/SecurityQuestionRow.tsx:36-37`), answers masked (`:54`).
- **To reach 10/10:**
  1. No explanation why Next is disabled (`app/onboard-security.tsx:35,86`); show per-row "at least 2 characters".
  2. Label answer inputs (`components/auth/SecurityQuestionRow.tsx:46-55`).
  3. Reuse `Sheet` for the picker instead of a bespoke Modal.

### `app/onboard-mpin.tsx` — Create MPIN (3 of 3) + commit — **8/10**
- **Route:** `/onboard-mpin` · **Entry points:** `app/onboard-security.tsx:42`.
- **Purpose:** Set/confirm MPIN, then profile/init → security questions → mpin/set with resumable ticket (`app/onboard-mpin.tsx:67-107`).
- **Scores:** Function 9 · States 8 · UI 8 · A11y 7 · Security 8 · Code 7
- **Subscreens:**
  - Create MPIN step (Step, `app/onboard-mpin.tsx:140`) — **8/10** — weak-PIN + DOB-year rejection (`:19-26,62-65`) with live-region message (`:146`).
  - Confirm MPIN step (Step, `app/onboard-mpin.tsx:141`) — **7.5/10** — mismatch resets both (`:68`); fix: say which step failed in the announced message.
- **Strengths:**
  - Resume-not-restart after partial commit (`:72-97`).
  - Back swallowed only while the commit is in flight (`:51-54,113,116`).
- **To reach 10/10:**
  1. Extract `isWeak` to a shared helper; `app/mpin-recover.tsx:77` duplicates it without the DOB rule.
  2. Guard missing `phoneTicket` before `initProfile` (`:88-93`) — store is RAM-only (`lib/onboarding.ts:58-64`).
  3. Label MpinInput for screen readers (`components/auth/MpinInput.tsx:58,69`).

### `app/onboard-success.tsx` — Account secured / login hand-off — **7.5/10**
- **Route:** `/onboard-success` · **Entry points:** `app/onboard-mpin.tsx:101`.
- **Purpose:** Logs in via MPIN, uploads avatar, optional device MFA, resets store, `resetTo` chats or `/import-chats` (`app/onboard-success.tsx:49-96`).
- **Scores:** Function 8 · States 8 · UI 8 · A11y 6 · Security 7 · Code 8
- **Subscreens:** "Could not continue" recovery Alert (Dialog, `app/onboard-success.tsx:80-94`) — **7.5/10** — offers sign-in escape when back is blocked.
- **Strengths:**
  - Back deliberately blocked post-commit with an escape on failure (`:40-43,73-94`).
  - Encrypted avatar upload best-effort (`:58-59`, `lib/onboarding.ts:179-193`).
- **To reach 10/10:**
  1. `enableMfa()` can throw after the JWT is stored (`lib/mfa.ts:28-29` → network `configureMfa`), landing in the catch that tells an already-signed-in user "Could not continue" (`app/onboard-success.tsx:61-66,71-82`); wrap MFA separately and continue.
  2. "Import an existing conversation" has no `accessibilityRole`/state (`:144-151`).
  3. Plaintext MPIN lives in the RAM store until here (`app/onboard-mpin.tsx:100`); clear it on every exit including unmount.

### `app/mpin-entry.tsx` — Returning-user MPIN sign-in — **7.5/10**
- **Route:** `/mpin-entry` · **Entry points:** `app/onboard.tsx:47`, `app/onboard-success.tsx:90`.
- **Purpose:** `/auth/mpin/verify` → tokens → `resetTo('/(tabs)/chats')` (`app/mpin-entry.tsx:38-52`).
- **Scores:** Function 8 · States 7 · UI 8 · A11y 7 · Security 6 · Code 9
- **Subscreens:** None.
- **Strengths:**
  - `resetTo` clears auth stack and replays the stashed deep link (`app/mpin-entry.tsx:44-46`, `lib/authNav.ts:43-52`).
  - Live-region error (`:82-84`).
- **To reach 10/10:**
  1. Missing `userId` silently no-ops (`:39`); show an error and route to `/onboard`.
  2. No SMS/device factor for a new device (see onboard #1); lockout enforcement only claimed in a comment (`:2`).
  3. Skip-restore gap for new phones (see index #1).

### `app/mpin-recover.tsx` — Forgot MPIN — **7/10**
- **Route:** `/mpin-recover` · **Entry points:** `app/mpin-entry.tsx:87`.
- **Purpose:** Answer ≥3 server-held questions → recovery ticket → new MPIN → signed in (`app/mpin-recover.tsx:51-91`).
- **Scores:** Function 8 · States 7 · UI 8 · A11y 6 · Security 6 · Code 6
- **Subscreens:**
  - Answer phase (Step, `app/mpin-recover.tsx:113-159`) — **7/10** — inputs unlabeled (`:127-134`).
  - New/confirm MPIN phase (Step, `app/mpin-recover.tsx:161-176`) — **6.5/10** — weaker `isWeak` (no DOB) (`:77`).
- **Strengths:**
  - Live-region errors (`:139,174`); progress counter on CTA (`:155`).
- **To reach 10/10:**
  1. Use `resetTo('/(tabs)/chats')` not `router.replace` (`:86`) so `/onboard` and `/mpin-entry` don't remain under Chats and the deep link replays (`lib/authNav.ts:1-16`).
  2. Recovery is knowledge-only (3 of 5 answers, `:93`) with no OTP; add an SMS step before issuing the ticket.
  3. Send trimmed answers (`:67-69` filters on trim but sends raw).
  4. Share `isWeak` with onboard-mpin.

### `app/app-lock.tsx` — Cold-launch lock / sealed-session unlock — **6/10**
- **Route:** `/app-lock` · **Entry points:** `app/_layout.tsx:276`, `lib/api.ts:408`.
- **Purpose:** Unlock via biometric, remote MPIN, or local PIN for a sealed session (`app/app-lock.tsx:57-103`).
- **Scores:** Function 7 · States 6 · UI 7 · A11y 4 · Security 6 · Code 7
- **Subscreens:**
  - Sealed-session PIN mode (Mode, `app/app-lock.tsx:114-143`) — **6/10** — honest failure copy (`:74`); button/link have no role (`:131,140`), error not live (`:139`).
  - Biometric mode (Mode, `:144-153`) — **6/10** — no roles (`:147,150`).
  - MPIN mode (Mode, `:154-165`) — **5/10** — no "Forgot MPIN?" path (compare `app/mpin-entry.tsx:86-92`); null `userId` shows "Session error — sign in again" (`:95`) with no sign-in button in this mode.
  - Forgotten PIN Alert (Dialog, `:81-92`) — **7/10** — explains consequences before destructive sign-out.
- **Strengths:**
  - Back consumed only when the lock was pushed over a live stack (`:48-51`).
  - Biometric skipped when it cannot unseal (`:54-60`).
- **To reach 10/10:**
  1. Add "Forgot MPIN?" → `/mpin-recover` and a sign-in escape in MPIN mode (`:154-165`).
  2. Add `accessibilityRole`/labels to all five touchables (`:131,140,147,150,162`), live regions on errors (`:139,161`), and hide the emoji (`:111`).
  3. `getCachedUser()` has no catch (`:53`) and `tryBiometric` runs without an unmount guard (`:62-65`).
  4. MPIN mode needs network (`verifyMpinRemote`, `:98`); say so when offline.
  5. Gate is cold-launch only (see root #2).

### `app/restore-backup.tsx` — Restore chats on new phone — **6.5/10**
- **Route:** `/restore-backup` · **Entry points:** `app/index.tsx:46` only.
- **Purpose:** Shows backup meta and restores from server or Google Drive (`app/restore-backup.tsx:65-94`).
- **Scores:** Function 6 · States 7 · UI 7 · A11y 4 · Security 7 · Code 7
- **Subscreens:** "Chats restored" state (State, `app/restore-backup.tsx:96-114`) — **6.5/10** — CTA no role (`:108`).
- **Strengths:**
  - Real APIs (`lib/cloudBackup.ts:379,411,436`); busy guard (`:75`); decline marked seen (`:69-72`).
  - Honest "skipping is safe" copy (`:173-178`).
- **To reach 10/10:**
  1. Unreachable after an in-session sign-in (see index #1), the main new-phone path.
  2. Add `accessibilityRole="button"` + busy state to `:108,141,152,169`.
  3. Don't surface raw `e.message` (`:89`); map known errors.
  4. Type `Row`'s `S` prop instead of `any` (`:184`).

### `app/delete-account.tsx` — Delete account — **7.5/10**
- **Route:** `/delete-account` · **Entry points:** `app/settings.tsx:192`.
- **Purpose:** Type identity to arm, confirm, `DELETE /user/account`, local purge, `resetTo('/onboard')` (`app/delete-account.tsx:92-110`).
- **Scores:** Function 9 · States 8 · UI 8 · A11y 5 · Security 6 · Code 8
- **Subscreens:** Final "Delete account?" Alert (Dialog, `app/delete-account.tsx:114-121`) — **7/10** — destructive style, second deliberate act.
- **Strengths:**
  - Load failure → retry rather than an un-armable form (`:73-80,155-159`); confirmation logic tested (`lib/confirmIdentity.selftest.ts` passes).
  - Post-delete cleanup cannot strand the user (`:96-105`).
- **To reach 10/10:**
  1. No re-authentication: the confirm is explicitly "not an authentication check" (`lib/confirmIdentity.ts:3-5`) and a phone suffix ≥6 digits arms it (`lib/confirmIdentity.ts:51-52`); require MPIN/biometric before `run` (`app/delete-account.tsx:112-121`).
  2. Reason chips need `accessibilityRole="radio"` + `selected` (`:190-196`); CTA/retry need roles (`:156,200`); input needs a label (`:168`).
  3. Remove unused `Platform` import (`:19`).

### `app/blocked.tsx` — Security block screen — **6.5/10**
- **Route:** `/blocked` · **Entry points:** `app/_layout.tsx:374`; **mis-wired** from `app/privacy-dashboard.tsx:350` ("Blocked Contacts → Manage").
- **Purpose:** Non-dismissable screen for `restrict`/`wipe` verdicts with level-accurate copy (`app/blocked.tsx:125-128,176-221`).
- **Scores:** Function 5 · States 6 · UI 7 · A11y 6 · Security 7 · Code 7
- **Subscreens:** Contact Support Alert (Dialog, `app/blocked.tsx:148-156`) — **5/10** — shows an email string only, no `mailto:` action.
- **Strengths:**
  - Copy branches on what actually happened (`:5-10,177-221`).
  - Back blocked (`:141-143`) and gesture disabled (`app/_layout.tsx:931`).
- **To reach 10/10:**
  1. Fix the mis-wire: Privacy Dashboard pushes `/blocked` with no params (`app/privacy-dashboard.tsx:350`), which renders the "crazzychat Blocked" security screen and swallows Back (`app/blocked.tsx:141-143`) with no on-screen exit — a user trap. Point that row at a blocked-contacts screen.
  2. Make "Contact Support" open `mailto:` (`:148-156`).
  3. Add `accessibilityRole="header"` to the title (`:175`) and stable keys instead of index (`:193,240`).

### `app/permissions.tsx` — App permissions — **6.5/10**
- **Route:** `/permissions` · **Entry points:** `app/settings.tsx:390` (`?from=settings`); `app/biometric-setup.tsx:34,35,39,69` (orphan chain).
- **Purpose:** Shows/request camera, mic, contacts, location (+background), motion, notifications; Android 14 full-screen-intent (`app/permissions.tsx:56-116`).
- **Scores:** Function 8 · States 7 · UI 6 · A11y 4 · Security 7 · Code 7
- **Subscreens:** Full-screen-intent row (Card, `app/permissions.tsx:148-157`) — **6.5/10** — opens real settings (`lib/CallService` `openFullScreenIntentSettings`), no role/label.
- **Strengths:**
  - Reads current grants without prompting and refreshes on resume (`:56-80`).
  - Context-aware exit/copy for Settings vs onboarding (`:32-35,128-133,170`; `lib/orphanRoutes.selftest.ts` asserts the exit).
- **To reach 10/10:**
  1. Per-row status (`:142-144`) is a glyph with no `accessibilityLabel`/state; buttons lack roles (`:149,161,169`).
  2. "Grant Permissions" fires every prompt including background location in one go (`:86-98`); request per row with rationale, and link denied (`canAskAgain=false`) rows to OS settings (`lib/permissionDenied.ts`).
  3. Replace hard-coded blues/greens (`:191-192,199,206`) with tokens.
  4. `lib/screenBackCoverage.selftest.ts:49-50` still exempts this screen as "nothing pushes to it", which is now false (`app/settings.tsx:390`).

### `app/backup-pin.tsx` — Device PIN setup — **4.5/10**
- **Route:** `/backup-pin` · **Entry points:** `app/settings.tsx:384` (`?from=settings`); `app/security-questions.tsx:29` (unwired).
- **Purpose:** Set/confirm a 6-digit local PIN via `pinStore.setPin`, which also seals the session (`app/backup-pin.tsx:34-39`, `services/security/pinStore.ts:52-62`).
- **Scores:** Function 6 · States 4 · UI 6 · A11y 3 · Security 4 · Code 5
- **Subscreens:**
  - Set PIN stage (Step, `app/backup-pin.tsx:50-62`) — **4.5/10** — no weak-PIN check (`:35`).
  - Confirm PIN stage (Step, `:50-62`) — **4.5/10** — `savePIN` rejection unhandled (`:37`), leaving the user on a full pad with no message.
- **Strengths:**
  - Real scrypt-backed store, not a plaintext SecureStore value (`services/securityService.ts:342-348`).
  - Returns to Settings when opened from there (`:38`).
- **To reach 10/10:**
  1. Changing an existing PIN requires no current PIN: Settings → Device PIN goes straight to `setPin`, which overwrites and re-seals (`app/backup-pin.tsx:34-38`, `services/security/pinStore.ts:52-61`). Verify the old PIN (or biometric) first.
  2. try/catch + error state around `savePIN` (`:37`); add weak-PIN rejection shared with onboard-mpin.
  3. Keys need labels ("Delete" for `⌫`) and roles (`:57-61`); add a visible back control from Settings.
  4. Hide the 8-step onboarding dots and "Used if biometrics fail" copy when `fromSettings` (`:51,53`).
  5. Reuse `components/PinPad.tsx` or `MpinInput` instead of a third keypad (`:11,56-62`).

### `app/setup-complete.tsx` — Legacy "crazzychat is Ready" — **4.5/10**
- **Route:** `/setup-complete` · **Entry points:** effectively **UNWIRED** — only `app/permissions.tsx:35` on the non-Settings branch, which is reached only from `app/biometric-setup.tsx` ← `app/backup-pin.tsx:38` (non-Settings) ← `app/security-questions.tsx:29`, which has no caller (`lib/orphanRoutes.selftest.ts:144,151,153`). Deep-linkable via `app.json:8`.
- **Purpose:** Animated checklist and "Enter crazzychat" button; writes `setup_complete` (`app/setup-complete.tsx:16-22,53`).
- **Scores:** Function 3 · States 4 · UI 6 · A11y 4 · Security 3 · Code 6
- **Subscreens:** None.
- **Strengths:**
  - Uses theme tokens for text/surfaces (`:66-73`).
- **To reach 10/10:**
  1. Delete it (the live equivalent is `app/onboard-success.tsx`), or stop asserting static claims: every item including "Biometric lock active" and "Permissions granted" is hard-coded true (`:24-31,51`) even when skipped.
  2. `markSetupComplete()` is unawaited with no catch (`:17`) and the flag is never read for routing (only `services/securityService.ts:364-371` / purge).
  3. Button needs a role (`:53`); use `resetTo` (`:53`).

### `app/biometric-setup.tsx` — Legacy biometric "registration" — **3.5/10**
- **Route:** `/biometric-setup` · **Entry points:** effectively **UNWIRED** — only `app/backup-pin.tsx:38` non-Settings branch (`lib/orphanRoutes.selftest.ts:153`), whose only upstream is unwired `security-questions`.
- **Purpose:** Prompts `authenticateAsync` then pushes `/permissions` (`app/biometric-setup.tsx:33-42`).
- **Scores:** Function 2 · States 4 · UI 5 · A11y 3 · Security 3 · Code 5
- **Subscreens:** None.
- **Strengths:**
  - Detects missing hardware/enrolment (`:24-29`).
- **To reach 10/10:**
  1. It registers nothing: a successful prompt is not persisted and does not call `enableMfa` (`:39`, compare `lib/mfa.ts:22-31`), yet copy says biometrics are "required every time you open crazzychat" (`:54`). Delete, or call `enableMfa`.
  2. Mount effect awaits without catch/unmount guard (`:24-29`); `clr+"55"` assumes hex tokens (`:60`).
  3. Ring touchable has no role/label (`:58`).

### `app/security-questions.tsx` — Legacy local security questions — **3.5/10**
- **Route:** `/security-questions` · **Entry points:** **UNWIRED** — grepped `security-questions` across app/components/lib/services: only its own `Stack.Screen` (`app/_layout.tsx:935`); `lib/orphanRoutes.selftest.ts:144` asserts zero callers. Reachable only by `vaultchat://security-questions` (`app.json:8`).
- **Purpose:** Stores 3 SHA-256-salted answers in SecureStore then `/backup-pin` (`app/security-questions.tsx:24-30`, `services/securityService.ts:410-423`).
- **Scores:** Function 3 · States 3 · UI 5 · A11y 3 · Security 4 · Code 4
- **Subscreens:** Inline question dropdown (Dropdown, `app/security-questions.tsx:64-72`) — **3/10** — no roles/labels, nested ScrollView.
- **Strengths:**
  - Keyboard handling fixed and guarded (`:33-48`, `lib/keyboardAvoidance.selftest.ts:158-160`).
- **To reach 10/10:**
  1. Delete (live flow is `app/onboard-security.tsx`) and remove `app/_layout.tsx:935`; its answers are never used by the live recovery (`app/mpin-recover.tsx:54` uses the server).
  2. If kept: try/catch + busy guard around `saveSecurityAnswers` (`:24-30`); use a slow KDF rather than SHA-256 (`services/securityService.ts:392-400`).
  3. No back control (exempted in `lib/screenBackCoverage.selftest.ts:51-52`); a11y on all touchables (`:60,67,80`).

### `app/lock.tsx` — Legacy CRED-style lock — **2.5/10**
- **Route:** `/lock` · **Entry points:** **UNWIRED** — no literal `/lock` route reference in app/components/lib (`lib/orphanRoutes.selftest.ts:148`); registered `app/_layout.tsx:950`, deep-linkable via `app.json:8`.
- **Purpose:** Biometric or 8-char "secret code"/PIN unlock into chats (`app/lock.tsx:116-249`).
- **Scores:** Function 2 · States 2 · UI 3 · A11y 2 · Security 2 · Code 3
- **Subscreens:**
  - Scanning stage (Stage, `app/lock.tsx:281-344`) — **3/10** — ring touchable has no label (`:283`).
  - Code stage (Stage, `:347-419`) — **2/10** — Verify disabled until 8 chars (`:398-400`) so a 4–6 digit PIN (`:193-200`) can never be submitted.
  - Locked stage (Stage, `:422-432`) — **1/10** — "Locked for 30 minutes" has no timer or persistence (`:41,121-123`), and the biometric effect depends on `[fails]` (`:158`) and calls `setStage("scanning")` (`:128`) on re-run, which immediately leaves the locked stage.
- **Strengths:**
  - The "any code opens the app" branch was removed and is guarded (`:219-232`, `lib/orphanRoutes.selftest.ts:115-130`).
- **To reach 10/10:**
  1. Delete the file and `app/_layout.tsx:950`; `app/app-lock.tsx` is the live gate.
  2. If kept: fix the lockout bypass (`:117-158`), persist attempts, replace static-salt SHA-256 (`:208-211`), dedupe `handleBiometric` (`:126-156` vs `:160-190`), remove `as any` (`:148,182`), theme and a11y everything (`:23-34`).

---

### Appendix — shared auth components (rated where rendered)

- `components/auth/MpinInput.tsx` (rendered by onboard-mpin, mpin-entry, mpin-recover, email-verify, app-lock) — **7/10** — robust IME handling (blur/refocus `:50-55`, opacity 0.01 `:95-104`), paste-aware digit filtering (`:31-35`), `oneTimeCode` autofill (`:78`). Fix: the wrapping Pressable and hidden TextInput have no `accessibilityLabel`/role, and the cells convey no "n of 6 entered" (`:58-79`).
- `components/auth/PhoneField.tsx` (onboard) — **7/10** — see onboard subscreen; input unlabeled (`:81-90`).
- `components/auth/SecurityQuestionRow.tsx` (onboard-security) — **7/10** — see onboard-security subscreen; answer unlabeled (`:46-55`).
- `components/PinPad.tsx` — **not rendered by any Batch A screen** (only `app/encrypted-notes.tsx`); **5.5/10** for reference — themed (`:20-25`) but keys have no labels and `⌫`/`del` is read as a symbol (`:48-49`), no haptics/role; Batch A's `app/backup-pin.tsx:11,56-62` re-implements the same pad instead of reusing it.


---

## B — Main Tabs, Contacts & Links

| Screen | Route | Wired? | Score |
|---|---|---|---|
| `app/(tabs)/chats.tsx` | `/(tabs)/chats` | Yes (tab) | 7/10 |
| `app/(tabs)/status.tsx` | `/(tabs)/status` | Yes (tab) | 6.5/10 |
| `app/(tabs)/calls.tsx` | `/(tabs)/calls` | Yes (tab) | 6.5/10 |
| `app/(tabs)/mini.tsx` | `/(tabs)/mini` | Yes (tab) | 8/10 |
| `app/(tabs)/profile.tsx` | `/(tabs)/profile` | Yes (tab + Settings) | 6.5/10 |
| `app/(tabs)/alerts.tsx` | `/(tabs)/alerts` | Yes (hidden tab, Chats header) | 6.5/10 |
| `app/new-chat.tsx` | `/new-chat` | Yes | 6.5/10 |
| `app/search.tsx` | `/search` | Yes | 7.5/10 |
| `app/contacts.tsx` | `/contacts` | Yes | 6.5/10 |
| `app/contact.tsx` | `/contact` | **UNWIRED** | 3/10 |
| `app/contact-info.tsx` | `/contact-info` | Yes | 6.5/10 |
| `app/sync-contact.tsx` | `/sync-contact` | **UNWIRED** | 5.5/10 |
| `app/qr-contact.tsx` | `/qr-contact` | Yes | 6.5/10 |
| `app/verify-contact.tsx` | `/verify-contact` | Yes | 7.5/10 |
| `app/add/[...segments].tsx` | `/add/<vaultId>/<name>` | Deep link only | 6.5/10 |
| `app/join/[code].tsx` | `/join/<code>` | Deep link only | 7/10 |
| `app/i/[token].tsx` | `/i/<token>` | Deep link only (legacy) | 6/10 |
| `app/msgrequests.tsx` | `/msgrequests` | Yes (Settings) | 4/10 |
| `app/invite-link.tsx` | `/invite-link` | Yes | 7/10 |

Evidence from repo selftests (run with `npx tsx`, all passed): `lib/a11yCoverage.selftest.ts` reports 0 unlabelled icon-only touchables (it checks only icon-only buttons; it does not check roles, states or text buttons, per its own note at lib/a11yCoverage.selftest.ts:79-80). `lib/themeCoverage.selftest.ts`, `lib/responsiveCoverage.selftest.ts` and `lib/screenBackCoverage.selftest.ts` also passed.

Not rated as subscreens of this batch, because no screen in the batch renders them:
- `components/ui/ChatRow.tsx` is only re-exported (components/ui/index.ts:6). `app/(tabs)/chats.tsx` defines and renders its own `ChatRow` (chats.tsx:820-993). The shared one is dead in this flow (see the Chats code-health notes).
- `components/status/GateChallenge.tsx` and `PuzzleBoard.tsx` are rendered only by `app/story-viewer.tsx:50`, which belongs to another batch. `GatePicker` is rated under Status.

---

### `app/(tabs)/chats.tsx` — Chats list — **7/10**
- **Route:** `/(tabs)/chats` · **Entry points:** tab registration `app/(tabs)/_layout.tsx:122`; `router.replace('/(tabs)/chats')` from `app/lock.tsx:147`, `app/setup-complete.tsx:53`, `app/app-lock.tsx:37` (resetTo), `app/group-info.tsx:245`, `app/media-viewer.tsx:459`, `app/(tabs)/profile.tsx:290`.
- **Purpose:** Lists the user's chats from `/chats`, with a cache-first paint, realtime refresh, folders, swipe and bulk actions, and entry points to new chat, search, alerts, temporary chat, contacts and broadcast.
- **Scores:** Function 8 · States 7 · UI 7 · A11y 5 · Security 8 · Code 6
- **Subscreens:**
  - Temporary-chat sheet (Modal, `app/(tabs)/chats.tsx:740`) — **7/10** — Routes to `/new-chat?ttl=` (chats.tsx:405) and `/chat-code` (chats.tsx:410), both real. `SheetItem` has no `accessibilityRole` (chats.tsx:813) and the sheet sets no `accessibilityViewIsModal`. Fix: reuse `components/ui/Sheet.tsx`, which already has both (Sheet.tsx:64,75).
  - Avatar photo popup (Modal, `chats.tsx:760`) — **7/10** — Message, Audio, Video and Info all push real routes (chats.tsx:780-796). Each avatar tap awaits a full `listStoriesFeed()` network call with no feedback (chats.tsx:415-426). Fix: read the story-feed cache (`lib/storyFeedCache`) instead, or show a pressed or loading state.
  - Selection / bulk-action mode (Mode, `chats.tsx:557-597`) — **7/10** — Pin, favourite, mute, archive and delete call real services, and partial failures are counted (chats.tsx:486-493). Bulk calls run one at a time (chats.tsx:490, 516), and rows expose no `accessibilityState.selected`. Fix: run them with `Promise.allSettled` and add the selected state to the row.
  - Folder chips (Tab, `chats.tsx:653-670`) — **8/10** — `GlassChip` carries role, selected state and a count label (components/ui/GlassChip.tsx:51-53). The four counts re-filter the whole list on every render (chats.tsx:655-658). Fix: compute them once in a `useMemo`.
  - Swipe actions (Overlay, `chats.tsx:873-892`) — **6/10** — Single-row Pin, Mute, Archive and Delete actions are swipe-only, with no `accessibilityActions`. The Archive action draws a white icon on `colors.surfaceSolid` (chats.tsx:885-886); the light-mode contrast cannot be verified statically. Fix: add `accessibilityActions` on the row and use a token background for Archive.
- **Strengths:**
  - Paints cached chats first with read-pointer correction, then reconciles from the network (chats.tsx:217-245). The primed request is reused at boot (chats.tsx:177-184).
  - Socket listeners are attached only after the cancel check, refreshes are coalesced, and the list resyncs on reconnect and on foreground (chats.tsx:361-378, 204-207, 388-391).
  - Optimistic pin, mute and archive roll back on failure (chats.tsx:432-449), and delete is confirmed (chats.tsx:450-465).
- **To reach 10/10:**
  1. Give the chat row an `accessibilityRole="button"`, a composed `accessibilityLabel` (name, preview, time, unread) and `accessibilityState={{selected}}` (chats.tsx:896). The unused `components/ui/ChatRow.tsx:69-84` already builds exactly this label. Either adopt that component or delete it.
  2. The "No chats yet" empty state sits outside the `SectionList`, so it has no `RefreshControl` (chats.tsx:672-677 vs 712). Offline with an empty cache, the only recovery is leaving the tab. Wrap the empty state in a refreshable `ScrollView` and add a Retry button next to the error bar (chats.tsx:651).
  3. Remove the dead styles `avatar`, `avatarGroup`, `avatarImg`, `avatarTxt`, `presenceDot`, `rowPin`, `rowMuted`, `actionIcon`, `fabTxt` and `headerBtnTxt` (chats.tsx:1065-1069, 1073, 1075, 1101, 1105, 1023), and fix the stale "Long-press action sheet" label (chats.tsx:1087).
  4. Replace the hard-coded colours (read-tick `'#4A9FFF'` chats.tsx:964, `'rgba(0,0,0,0.85)'` 1012, error-bar rgba 1032) with palette tokens. Switch the RN `Text` (chats.tsx:12) to `AppText` for brand font and comfort scaling, as sibling tabs do (status.tsx:21, calls.tsx:18).
  5. Reduce the 19 `as any` route casts (e.g. chats.tsx:398, 405, 420) by using typed routes. Move `formatRelative` (chats.tsx:995) into `lib/format` so it is not re-implemented in status.tsx:556.

### `app/(tabs)/status.tsx` — Status (stories) — **6.5/10**
- **Route:** `/(tabs)/status` · **Entry points:** tab registration `app/(tabs)/_layout.tsx:123`.
- **Purpose:** Shows the stories feed (mine, recent, muted) and composes text or photo/video statuses, with an optional puzzle or question gate and E2EE key wrapping.
- **Scores:** Function 7 · States 6 · UI 7 · A11y 4 · Security 8 · Code 6
- **Subscreens:**
  - Text status composer (Modal, `status.tsx:370`) — **6.5/10** — Posts for real via `postTextStory` with an in-flight guard (status.tsx:169-180). The colour swatches (status.tsx:381) and emoji buttons (407, 417) have no labels. Close discards typed text without asking (status.tsx:374). Fix: label the swatches by colour name and confirm discard when the text is non-empty.
  - Media preview + caption editor (Modal, `status.tsx:434`) — **6/10** — Compresses, uploads (encrypted when E2EE is on) and posts each asset (status.tsx:241-294). When the 3rd of N assets fails, the already-posted ones stay in `previewAssets`, so Retry re-posts them (status.tsx:241-299). The video preview renders `<Image>` on a video URI (status.tsx:449); whether a frame shows is not verifiable statically. Fix: drop each asset from the batch after it posts successfully.
  - GatePicker (component, `components/status/GatePicker.tsx`) — **7/10** — The copy is honest about puzzle vs question strength (GatePicker.tsx:112-117), and short answers are flagged (177-181). The options and grid chips lack `accessibilityRole="radio"` and checked state (GatePicker.tsx:91-99, 130-134). The answer input is neither `secureTextEntry` nor `autoCorrect={false}` (GatePicker.tsx:159-167), so the keyboard may learn the secret. `Opt` is a component declared inside render (GatePicker.tsx:86), and the error colour is hard-coded `'#E5533D'` (178).
  - Emoji panel (Overlay, `status.tsx:399`) — **6/10** — Recent emoji are persisted (status.tsx:105-112). Every emoji button is unlabelled. Fix: set `accessibilityLabel` to the emoji's name.
  - Status options menu (Dialog, `status.tsx:354-357`) — **6/10** — An `Alert` with a single real action (`/status-privacy`). Fix: route the icon straight there, or use `components/ui/Sheet`.
  - StoryRing (component, `components/StoryRing.tsx`) — **8/10** — A pure SVG segmented ring (StoryRing.tsx:26-43). It conveys unseen/seen by colour only. Fix: have the status row's label state the unseen count.
- **Strengths:**
  - The question gate locks the content key on-device and wraps the locked envelope per viewer, so audience members cannot bypass it (status.tsx:273-282). It is refused when E2EE is off (status.tsx:234-237).
  - A question with a missing or weak answer is rejected before any upload (status.tsx:228-231).
  - Shows the cached feed first for offline use (status.tsx:139-150), with real-time refresh on `story_posted`.
- **To reach 10/10:**
  1. Fix the socket-listener leak. `s.on('story_posted', …)` runs before the `if (!cancel)` check (status.tsx:162), the exact bug chats.tsx:354-361 documents and fixes. Return early if cancelled before attaching.
  2. Make the multi-asset post idempotent per asset (status.tsx:241-299). Remove posted assets from state as each succeeds.
  3. Add `accessibilityRole` and labels to the status rows (status.tsx:331, 506), for example "Alice, 3 updates, 2 unread, 2h ago", and to the swatches, emoji and thumbnails (381, 407, 417, 458).
  4. Add `.catch` to the un-caught `AsyncStorage.getItem().then` calls (status.tsx:104, 115).
  5. Scale the fixed font sizes with `m.textScale` (title 28 status.tsx:572, rowName 15 620, rowSub 12 621), as chats.tsx:1009 does. Remove the dead styles `headerBtnTxt` and `avatarRing*` (status.tsx:574, 611-614).
  6. Resolve the "Long-press TODO" on My status (status.tsx:503-505). Muting is AsyncStorage-only (status.tsx:121), so it does not follow the user across devices. Document that or sync it.

### `app/(tabs)/calls.tsx` — Calls log — **6.5/10**
- **Route:** `/(tabs)/calls` · **Entry points:** tab registration `app/(tabs)/_layout.tsx:137`.
- **Purpose:** Shows the on-device call log merged with server call history, grouped per peer, with redial, call info and removal.
- **Scores:** Function 6 · States 6 · UI 7 · A11y 6 · Security 6 · Code 7
- **Subscreens:**
  - Call actions sheet (Sheet, `calls.tsx:302` → `components/ui/Sheet.tsx`) — **8/10** — Has role=button rows, `accessibilityViewIsModal`, safe-area insets and a scroll for >3 actions (Sheet.tsx:63-88). Rows use `key={i}` (Sheet.tsx:76). Fix: key rows on `a.label`.
  - Call info modal (Modal, `calls.tsx:266`) — **7/10** — Voice and Video redial for real, and it lists every entry (calls.tsx:277-295). It has no close button, no `accessibilityViewIsModal`, and an unlabelled backdrop (calls.tsx:267).
  - Remove / Clear confirmations (Dialog, `calls.tsx:164-168`, `173-185`) — **5/10** — The per-row dialog says "removes the call from your history on all your devices. It cannot be undone." (calls.tsx:166). `hideServerCalls` is device-local by design (lib/callLog.ts:98-101), so that wording is false. Fix: say "from this device", as confirmClear does (calls.tsx:174).
- **Strengths:**
  - The device log paints first, then merges with server history (calls.tsx:84-110). Server-only rows are hidden rather than deleted (calls.tsx:147-151, lib/callLog.ts:112-121).
  - Group calls redial through `/group-calls` rather than 1:1 (calls.tsx:132-138).
  - Declined calls get their own label and colour (calls.tsx:50-54, 193).
- **To reach 10/10:**
  1. The "New call" FAB opens `/contacts` (calls.tsx:261), which can only start a chat (contacts.tsx:183-184, "Message →" 228). There is no call path. Route it to a picker that ends in `/voicecall` or `/videocall`.
  2. Correct the misleading removal text (calls.tsx:166) to match lib/callLog.ts:98-101.
  3. Tapping the row body places a call immediately (calls.tsx:205-206), which risks accidental calls. Make row tap open call info, as WhatsApp does, and keep the explicit Call-back button (calls.tsx:224).
  4. Add `.catch` to the `getCallLog()` promises (calls.tsx:84, 106) and surface failures of the merge (calls.tsx:110, currently `catch(() => {})`). `removeCallLog`/`hideServerCalls` swallow their own errors (lib/callLog.ts:84, 120), so the row vanishes even when the write failed.
  5. Give the row `accessibilityRole` and a label (calls.tsx:205). Hoist `DirArrow` out of render (calls.tsx:188) and memoise `renderItem` (calls.tsx:198).

### `app/(tabs)/mini.tsx` — Mini Apps launcher — **8/10**
- **Route:** `/(tabs)/mini` · **Entry points:** centre tab `app/(tabs)/_layout.tsx:136`; `app/family.tsx:1392` (fallback replace).
- **Purpose:** A grid of mini-app tiles, each pushing a real route, gated by remote kill switches.
- **Scores:** Function 9 · States 8 · UI 8 · A11y 8 · Security 9 · Code 7
- **Subscreens:** None.
- **Strengths:**
  - Every tile route exists: `/live` (dir), `/navigate`, `/family`, `/finance` (dir), `/shop-book`, `/encrypted-notes`, `/docscanner`, `/shelf`, `/games`, `/aiguardian` (verified with `ls app/`; list at mini.tsx:44-60).
  - The kill switch blocks both the tile and the route (mini.tsx:85, 130).
  - Responsive column count with tile role and label (mini.tsx:160-162, 136-137).
- **To reach 10/10:**
  1. Delete the unreachable "Coming Soon" branches (mini.tsx:91-95) and the `Soon` badge (mini.tsx:143). Every entry satisfies `route: string` (mini.tsx:61).
  2. The back button is 40×40 (mini.tsx:183-185) and has no `accessibilityRole`. Raise it to a 44dp minimum, as calls.tsx:324-326 does.
  3. Remove `<Stack.Screen options={{ headerShown:false }}/>` inside a Tabs child (mini.tsx:101). Tabs already sets `headerShown:false` (_layout.tsx:110).
  4. Decide the orphaned `vc_miniapp_todos` data, which the comment says is not purged on sign-out (mini.tsx:63-68).

### `app/(tabs)/profile.tsx` — Profile — **6.5/10**
- **Route:** `/(tabs)/profile` · **Entry points:** tab `app/(tabs)/_layout.tsx:142` (bar hidden on this screen but shown on other tabs); `app/settings.tsx:237`.
- **Purpose:** View and edit name, About and phone; change or remove the photo; verify the phone by OTP; view account facts; sign out.
- **Scores:** Function 8 · States 6 · UI 7 · A11y 5 · Security 7 · Code 6
- **Subscreens:**
  - Inline edit rows (Mode, `profile.tsx:356-373`, `EditRow` 459-493) — **6/10** — Saves for real via PUT `/user/profile` (profile.tsx:126-144). There is no cancel once a row is in edit mode. The pencil/check button reads "Edit profile" for every row and state (profile.tsx:486).
  - Phone OTP step (Step, `profile.tsx:391-414`) — **6.5/10** — Real send and verify (profile.tsx:210-239) with a 6-digit check (227). Editing the phone during the `code` step does not reset it, so the code is verified against the new number (profile.tsx:230). There is no resend or timer.
  - Sign-out confirmation (Dialog, `profile.tsx:242-258`) — **8/10** — Clear consequence text, unregisters push, disconnects the socket, and uses `resetTo`. `logoutUser()` is not wrapped (profile.tsx:250), so a failure gives no feedback.
- **Strengths:**
  - Cache-first load with the cache read inside try (profile.tsx:95-121).
  - Warns before a number change moves the account (profile.tsx:383-388).
  - Back fallback when there is no history (profile.tsx:290). The version comes from the build, not hard-coded (449).
- **To reach 10/10:**
  1. The verified tick shows whenever `profile.phone` exists, even beside an edited, unverified number (profile.tsx:372). Use `verified={phone.trim() === String(profile?.phone ?? '').trim()}`.
  2. Saving any row PUTs all three fields, including an unverified `phone` (profile.tsx:132-136). Send only the edited field, and keep phone changes behind OTP. Server acceptance is not verifiable statically.
  3. Add keyboard avoidance (`KeyboardSafe`, as new-chat.tsx:117 uses). Inline inputs and the OTP box sit low in a plain `ScrollView` (profile.tsx:280, 400).
  4. Per-row labels: "Edit name" / "Save name" (profile.tsx:486). Label the avatar touchable "Change profile photo" (profile.tsx:305), and give "Remove photo" a role and a confirm (profile.tsx:323).
  5. Delete the empty effect (profile.tsx:81-86) and the stale header claim "Photo upload is deferred to Phase 4" (profile.tsx:4). Type `keyboardType` instead of `any` (profile.tsx:462).

### `app/(tabs)/alerts.tsx` — Security Alerts log — **6.5/10**
- **Route:** `/(tabs)/alerts` (hidden, `href: null`) · **Entry points:** `app/(tabs)/_layout.tsx:144`; Chats header `app/(tabs)/chats.tsx:618`; `app/aiguardian.tsx:163`.
- **Purpose:** Renders the on-device hash-chained audit log with an integrity banner, and runs a device-integrity scan on demand.
- **Scores:** Function 8 · States 6 · UI 7 · A11y 5 · Security 6 · Code 8
- **Subscreens:**
  - Expanded event details (Overlay/inline, `alerts.tsx:140-153`) — **6/10** — Shows severity, timestamp and a truncated hash. The row has no `accessibilityRole` or `accessibilityState.expanded` (alerts.tsx:124-128).
- **Strengths:**
  - Load failure is distinct from "no events" (alerts.tsx:201-211). try/finally prevents a stuck spinner (alerts.tsx:84-93).
  - The integrity banner reports the broken sequence number (alerts.tsx:175-187).
  - All data comes from real services (`services/security/auditChain` list/verify/sync, alerts.tsx:20-24).
- **To reach 10/10:**
  1. "Scan device" calls `runSecurityCheck`, which on a wipe-level result runs `wipeAllKeys()` (services/securityService.ts:304-306, 328). It does so with no confirmation, and alerts.tsx ignores the returned report (alerts.tsx:111), so there is no routing to `/blocked`. Warn before the scan, and act on `report.level`.
  2. Scan failures are swallowed silently (alerts.tsx:112-113). Show an error row or toast.
  3. `RefreshControl refreshing={false}` (alerts.tsx:199) never shows a spinner. Track a `refreshing` state. The error is shown only when the list is empty (alerts.tsx:202), so add an error bar for the non-empty case.
  4. The background `syncAuditChain().then(setEvents…)` has no unmount guard (alerts.tsx:97-101).
  5. Move the `SEV_COLOR` hex values (alerts.tsx:28-34) into theme tokens with light/dark variants. Add a row role and expanded state (alerts.tsx:124).

### `app/new-chat.tsx` — New chat — **6.5/10**
- **Route:** `/new-chat` · **Entry points:** `app/(tabs)/chats.tsx:399` (FAB and empty CTA 676, 720); `chats.tsx:405` (temporary chat `ttl`).
- **Purpose:** Search existing direct-chat peers, start a chat by phone number, reach group/community/address book, and apply a temporary-chat TTL.
- **Scores:** Function 6 · States 6 · UI 7 · A11y 6 · Security 8 · Code 7
- **Subscreens:**
  - New contact by phone (Step, `new-chat.tsx:164-172`) — **7/10** — `PhoneField` + `toE164` validation, `createDirectChat({phone})`, in-flight guard (new-chat.tsx:96-105). The dial code is hard-coded to `'+91'` (new-chat.tsx:65).
- **Strengths:**
  - The TTL is applied on the way out, for both new and existing chats, and an honest alert says when the timer failed (new-chat.tsx:43-56).
  - A TTL banner states the consequence before the person is picked (new-chat.tsx:130-137).
  - Uses `KeyboardSafe` and `keyboardShouldPersistTaps` (new-chat.tsx:117, 155).
- **To reach 10/10:**
  1. The placeholder says "Search name or number" (new-chat.tsx:145), but the filter matches only `name` (new-chat.tsx:93). Match phone too, or change the placeholder.
  2. In temporary mode, "New group", "New community" and "Find from address book" drop the `ttl` (new-chat.tsx:160-174), which silently produces a normal chat. Hide those rows when `ttlSeconds` is set, or carry the TTL.
  3. A `listChats()` failure is swallowed, so offline shows "No contacts yet" (new-chat.tsx:86, 191). Fall back to `getCachedChats` (as chats.tsx:225 does) and show an error with retry.
  4. Guard row taps against double-submit (new-chat.tsx:181), give rows and `ActionRow` (107-112) `accessibilityRole="button"`, and hoist `ActionRow` out of render.
  5. Remove the unused `Platform` import (new-chat.tsx:11) and the stale header claim of an invite-link footer row (new-chat.tsx:3-4).

### `app/search.tsx` — Global search — **7.5/10**
- **Route:** `/search` · **Entry points:** `app/(tabs)/chats.tsx:617`.
- **Purpose:** On-device search over chat names and decrypted message content, jumping to the matched message.
- **Scores:** Function 8 · States 6 · UI 8 · A11y 6 · Security 9 · Code 8
- **Subscreens:** None.
- **Strengths:**
  - Message search runs locally over the FTS5 blind index (lib/localDb.ts:859-871), and the query never leaves the device.
  - Debounced at 220 ms with cleanup (search.tsx:56-62). The jump-to-message hand-off uses `setPendingJump` (search.tsx:83-86).
  - Labelled input and back button (search.tsx:92, 96).
- **To reach 10/10:**
  1. A `listChats()` failure is swallowed (search.tsx:45-49), so offline there are no chat-name results. Use `getCachedChats()` first, as chats.tsx:225 does.
  2. Stale-result race: an older `searchAllMessages` promise can resolve after a newer query (search.tsx:60). Compare against the latest query before `setMsgs`.
  3. Give result rows `accessibilityRole="button"` and a composed label (search.tsx:128, 141). Highlight the match in the `h.content` snippet (search.tsx:145).
  4. Type the section data instead of `any[]` (search.tsx:77).

### `app/contacts.tsx` — Address-book discovery — **6.5/10**
- **Route:** `/contacts` · **Entry points:** `app/(tabs)/chats.tsx:624`, `app/new-chat.tsx:174`, `app/(tabs)/calls.tsx:261` (labelled "New call"), `app/family-add.tsx:207`.
- **Purpose:** Hashes address-book phone numbers, matches them on `/contacts/match`, and lists on-app contacts (open chat) and invitees (SMS/share).
- **Scores:** Function 7 · States 6 · UI 7 · A11y 6 · Security 6 · Code 7
- **Subscreens:**
  - Scanning progress (Overlay, `contacts.tsx:271-280`) — **8/10** — A real progress counter, updated every 25 contacts (contacts.tsx:118).
  - Permission-denied state (Overlay, `contacts.tsx:282-291`) — **5/10** — "Try again" re-requests even when `canAskAgain` is false (contacts.tsx:91-93, 287). Fix: offer `Linking.openSettings()`.
- **Strengths:**
  - Deduplicated hashes, chunked 1000 per request (contacts.tsx:127-144).
  - Virtualisation tuned for large address books (contacts.tsx:309-313).
  - Per-row opening state (contacts.tsx:220, 226).
- **To reach 10/10:**
  1. Failed match chunks are only `console.warn`ed (contacts.tsx:141-143). Offline, every contact is then listed under "Invite", which is wrong. Surface an error and skip the invite split when any chunk fails.
  2. The privacy claim "raw phone numbers never leave the device" (contacts.tsx:13) rests on an unsalted `SHA256(normalised phone)` (lib/chatService.ts:2801-2805). The phone-number space is small enough to enumerate. Reword the claim, or move to a keyed or OPRF scheme.
  3. The Calls "New call" FAB lands here with no call action (calls.tsx:261). Add Call buttons, or a `mode` param that switches the row action.
  4. The address book is re-hashed on every mount (contacts.tsx:178), with no cache. Cache matched rows and rescan on demand.
  5. Invite avatars draw white initials (`'#fff'`, contacts.tsx:345) on `c.glassSoft` (344); light-mode contrast is not verifiable statically, so use a token. Add row roles (contacts.tsx:220, 235) and replace the hand-built flat list (contacts.tsx:246-256) with `SectionList`.

### `app/contact.tsx` — Contact info (legacy mock) — **3/10**
- **Route:** `/contact` · **Entry points:** **UNWIRED**. The only reference is the Stack registration `app/_layout.tsx:1027`. Grepped `'/contact'`, `pathname: '/contact'` and `"contact"` across app/components/lib/hooks/services, and found no push, href or link.
- **Purpose:** A mock contact page with fixed placeholder data.
- **Scores:** Function 1 · States 2 · UI 6 · A11y 4 · Security 1 · Code 3
- **Subscreens:**
  - Block / Report / Delete dialogs (Dialog, `contact.tsx:138-168`) — **1/10** — Block only flips local state (contact.tsx:143). Report has no `onPress` (156). Delete only calls `router.back()` (167). Each dialog promises an effect that never happens.
- **Strengths:**
  - Uses theme tokens via `makeStyles(c)` (contact.tsx:180-285).
  - Export chat passes `chatId` to the real `/chat-export` (contact.tsx:125).
- **To reach 10/10:**
  1. Delete the screen and its Stack entry (app/_layout.tsx:1027). `app/contact-info.tsx` is the real, wired implementation.
  2. If it is kept, remove the fabricated data: phone `'+91 98765 43210'` (contact.tsx:64), the About text (79), media count "6" and the emoji grid (87, 92). Wire mute, block, report and delete to `muteChat`, `blockUser`, `reportUser` and `setHidden`, as contact-info.tsx:176-220 does.
  3. Message/Audio/Video push `/chat`, `/voicecall` and `/videocall` with only `name`/`avatar` (contact.tsx:35-37), but chat reads `id`/`chatId` (app/chat.tsx:239-243).

### `app/contact-info.tsx` — Contact Info — **6.5/10**
- **Route:** `/contact-info` · **Entry points:** `app/chat.tsx:3338`, `app/(tabs)/chats.tsx:794`.
- **Purpose:** Peer profile with call, video, search, mute and block actions, a viewing-status privacy toggle, shared media/files/links, groups in common, safety-number entry, Ghost Mode, and report.
- **Scores:** Function 8 · States 7 · UI 6 · A11y 6 · Security 7 · Code 6
- **Subscreens:**
  - Block / Unblock / Report & block dialogs (Dialog, `contact-info.tsx:183-220`) — **7/10** — Real `blockUser`, `unblockUser` and `reportUser`, each confirmed with rollback. If report succeeds and block then fails, the UI reverts to "not blocked" with a generic "Failed" (contact-info.tsx:210-216).
- **Strengths:**
  - Cache-first, and shared media are unioned with local history so purged bodies are not lost (contact-info.tsx:97-107, 128-133).
  - The encryption card reflects the real `E2EE_ENABLED` flag (contact-info.tsx:350-367) and links to `/verify-contact`.
  - Mute and block are optimistic with revert (contact-info.tsx:176-202).
- **To reach 10/10:**
  1. `readCache` runs outside the `try` (contact-info.tsx:97). profile.tsx:91-94 notes it can throw (locked DEK). On a throw the IIFE rejects and `loading` never clears, leaving the spinner at contact-info.tsx:286. Move the read inside `try`.
  2. The back button is absolutely positioned at `top: 54` (contact-info.tsx:409), ignoring `HEADER_TOP` and insets. Use `HEADER_TOP` as the hero does (408).
  3. Shared-file rows do nothing on tap (contact-info.tsx:310-313). Open the document viewer, or route to `/media-gallery` (as 293 does).
  4. Label the `Switch` (contact-info.tsx:274). Add a role to "See All" (293). Hoist `ActionButton` out of render (224).
  5. Remove the dead styles `avatar`, `avatarImg`, `avatarText`, `onlineDot` (contact-info.tsx:410-413), the unused `Dimensions` import (13) and the stale comment about a module-level `Dimensions.get` (46-50). Replace the hard-coded rgba values (373, 428, 431, 436) with tokens.
  6. Peer-supplied links open directly with `Linking.openURL` (contact-info.tsx:323). Add a confirmation that shows the host.

### `app/sync-contact.tsx` — Sync Contact (6-digit code) — **5.5/10**
- **Route:** `/sync-contact` · **Entry points:** **UNWIRED**. The only route reference is `components/VaultFeatureSheet.tsx:46`, and `VaultFeatureSheet` is not rendered anywhere (grepped `VaultFeatureSheet`/`VaultFeature` across app/components/lib/hooks/services; `app/vault-features.tsx` only matches on its own component name). The screen is reachable only by deep link (`vaultchat` scheme, app.json:8).
- **Purpose:** Mutual-consent contact exchange: one side generates a 6-digit code, the other enters it, then the users can open a direct chat.
- **Scores:** Function 3 · States 6 · UI 5 · A11y 5 · Security 7 · Code 7
- **Subscreens:**
  - "Show My Code" tab (Tab, `sync-contact.tsx:187-218`) — **5/10** — `createSyncCode`, polling and countdown are real (sync-contact.tsx:61-88). On success the initiator gets a placeholder `userId: ''` (sync-contact.tsx:69), so they never learn who synced and get no Message button (137).
  - "Enter Their Code" tab (Tab, `sync-contact.tsx:220-252`) — **7/10** — Digit-only input and a real `verifySyncCode` (sync-contact.tsx:90-97, 228). No keyboard avoidance.
  - Done screen (Step, `sync-contact.tsx:116-151`) — **6/10** — Claims "Contact saved securely" (123), but nothing in the client saves a contact; server behaviour is not verifiable statically.
- **Strengths:**
  - The code is copied with `copyAndAutoClear` (sync-contact.tsx:99).
  - The SafeAreaView is the cross-platform one (sync-contact.tsx:11-15).
- **To reach 10/10:**
  1. Wire an entry point, for example render `VaultFeatureSheet` or add a row in new-chat or contacts. Otherwise delete the screen.
  2. Return the accepting user from `getSyncStatus` and populate `synced` (sync-contact.tsx:65-70) so the initiator can message them.
  3. Polling treats any error, including a transient network error, as an expired code and wipes it (sync-contact.tsx:71-75). Only reset on 404/410.
  4. The countdown effect depends on `timeLeft` and recreates its interval every second (sync-contact.tsx:49-58). Depend on `phase` only.
  5. Switch to `AppText` (RN `Text` at sync-contact.tsx:9) and render `AuroraBackground` in the main view (it exists only in Done, 119). Move the rgba purples (sync-contact.tsx:270-280) into tokens, raise the 9px label (268), and give the tabs `accessibilityRole="tab"` with selected state (179-184).

### `app/qr-contact.tsx` — QR contact (My QR / Scan) — **6.5/10**
- **Route:** `/qr-contact` · **Entry points:** `app/(tabs)/profile.tsx:348`, `app/settings.tsx:249`.
- **Purpose:** Shows the user's VaultID as a QR code, and scans another user's QR to open a direct chat.
- **Scores:** Function 7 · States 7 · UI 6 · A11y 5 · Security 7 · Code 8
- **Subscreens:**
  - My QR tab (Tab, `qr-contact.tsx:121-143`) — **7/10** — Real `getMyProfile` and QR rendering. A profile load failure falls through silently to "No VaultID yet" (qr-contact.tsx:42, 133).
  - Scan tab (Tab, `qr-contact.tsx:145-174`) — **6.5/10** — Real `CameraView` with a scan guard and "Scan Again" (qr-contact.tsx:157-171). A permanent camera denial only re-requests (qr-contact.tsx:151), with no settings link.
  - "Contact found" confirmation (Dialog, `qr-contact.tsx:77-91`) — **7/10** — Confirms before creating the chat, which is good.
- **Strengths:**
  - Resolve → confirm → `createDirectChat` → replace (qr-contact.tsx:76-90).
  - Self-scan is detected (qr-contact.tsx:74).
- **To reach 10/10:**
  1. `parseVaultId` accepts any QR payload: any URL containing `/add/` on any host, or any raw string (qr-contact.tsx:60-65). Restrict it to the app's schemes and host plus the VaultID charset before calling `resolveVaultId`.
  2. The shared link `https://vaultchat.app/add/…` (qr-contact.tsx:55) does not deep-link into the app. app.json's only https intent filter is `api.corefinite.com/live/join` (app.json:51-56).
  3. Give the tabs a role and selected state (qr-contact.tsx:113-118), and label the QR image for screen readers (132).
  4. Switch RN `Text` (qr-contact.tsx:10) to `AppText`, and add an error state with Retry for the profile load.

### `app/verify-contact.tsx` — Verify safety number — **7.5/10**
- **Route:** `/verify-contact` · **Entry points:** `app/contact-info.tsx:355`, `app/chat.tsx:3651`.
- **Purpose:** Computes the 60-digit safety number from both identity keys and persists a "verified" mark.
- **Scores:** Function 8 · States 7 · UI 7 · A11y 6 · Security 8 · Code 9
- **Subscreens:** None.
- **Strengths:**
  - A real computation via `computeSafetyNumber` (verify-contact.tsx:266), with clear reasons when keys are missing (262-263).
  - Optimistic toggle with revert and an in-flight guard (verify-contact.tsx:274-287).
  - Explanatory copy on what a mismatch means (verify-contact.tsx:319-324).
- **To reach 10/10:**
  1. The "unavailable" state has no Retry button, although `load` exists (verify-contact.tsx:305-310). Add one.
  2. Give the verify toggle `accessibilityRole="switch"` with `accessibilityState={{checked: verified}}` (verify-contact.tsx:326-331). Give the number a spaced `accessibilityLabel` so it is read in groups (316).
  3. Add `numberOfLines`/shrink to the header title so long names do not overflow (verify-contact.tsx:296). Switch RN `Text` (217) to `AppText`.
  4. Offer QR comparison or copy of the number. Only read-aloud comparison is supported (verify-contact.tsx:320-321).

### `app/add/[...segments].tsx` — Add by VaultID link — **6.5/10**
- **Route:** `/add/<vaultId>/<name>` · **Entry points:** deep link only, via the `vaultchat`/`crazzychat` schemes (app.json:8). The URL is produced by the QR payload (qr-contact.tsx:49) and the share text (55). Signed-out and locked launches replay it via `stashLaunchLink` (app/_layout.tsx:268, 273, 287). No in-app `router.push` was found (grepped `/add/`).
- **Purpose:** Resolves a VaultID from a link, then opens or creates the direct chat.
- **Scores:** Function 7 · States 5 · UI 7 · A11y 6 · Security 5 · Code 8
- **Subscreens:** None.
- **Strengths:**
  - Runs once via ref (add/[...segments].tsx:38-40), with self-link detection (44-48).
  - Distinguishes 404 and 401 errors (add/[...segments].tsx:56-60).
- **To reach 10/10:**
  1. Opening any external link immediately creates a chat with that user, with no confirmation (add/[...segments].tsx:49-54). The in-app scanner asks first (qr-contact.tsx:77). Show the same "Contact found → Open chat" step.
  2. `decodeURIComponent(parts[1])` runs during render and throws `URIError` on a malformed `%` sequence (add/[...segments].tsx:36). Wrap it in try/catch.
  3. The error state has no Retry, only "Go to Chats" (add/[...segments].tsx:74). Add a retry for network errors.
  4. Give the button a role, and switch RN `Text` (add/[...segments].tsx:13) to `AppText`.

### `app/join/[code].tsx` — Join group via invite code — **7/10**
- **Route:** `/join/<code>` · **Entry points:** deep link only (`vaultchat://join/…`, app.json:8; Stack registration app/_layout.tsx:940). Links and QR codes are produced by `app/invite-link.tsx:19, 67, 178` as `https://vaultchat.app/join/…`, a host not in app.json's intent filters (app.json:51-56). No in-app push was found (grepped `join/`).
- **Purpose:** Redeems a group invite code via `joinViaInvite`, then lands in the chat or shows a pending-approval state.
- **Scores:** Function 6 · States 8 · UI 7 · A11y 6 · Security 5 · Code 9
- **Subscreens:**
  - Pending-approval state (Step, `join/[code].tsx:162-171`) — **8/10** — Clear explanation and a way home.
  - Error state with retry (Step, `join/[code].tsx:173-185`) — **8/10** — Retry plus "Back to chats". The CTA uses `minHeight` so large fonts do not clip it (join/[code].tsx:201-204).
- **Strengths:**
  - Uses `router.replace`, so Back does not re-run the redeem (join/[code].tsx:137-139).
  - Covers all three phases: joining, pending and error (join/[code].tsx:118-121).
- **To reach 10/10:**
  1. It auto-joins on open with no preview of the group name and no confirmation (join/[code].tsx:145). A forwarded link silently adds the user. Fetch a preview and ask "Join <group>?".
  2. The header claims "In-app paste-to-join from /new-chat" (join/[code].tsx:6), but new-chat.tsx has no such path. Add one, or fix the comment.
  3. Register the `vaultchat.app` host with `/join` in app.json intent filters (app.json:48-56), or switch `JOIN_BASE` to the custom scheme, so QR scans open the app.
  4. Give the CTAs roles, and switch RN `Text` (join/[code].tsx:110) to `AppText`.

### `app/i/[token].tsx` — Legacy invitation token redeem — **6/10**
- **Route:** `/i/<token>` · **Entry points:** deep link only (`vaultchat://i/…`, app.json:8). No in-app producer exists: `redeemInvitation` is documented as LEGACY with "Nothing in the app produces one any more" (lib/chatService.ts:2407-2414). Grepped `/i/` and `i/[token]`.
- **Purpose:** Redeems a pre-v2 signed invitation token and opens the chat.
- **Scores:** Function 4 · States 7 · UI 6 · A11y 6 · Security 4 · Code 8
- **Subscreens:**
  - Error state with retry (Step, `i/[token].tsx:264-278`) — **7/10** — Surfaces the server's wording, with Retry and "Go to chats".
- **Strengths:**
  - Uses `replace`, so Back does not bounce (i/[token].tsx:242-243).
  - Shows the server's reason for expiry or supersession (i/[token].tsx:247-249).
- **To reach 10/10:**
  1. It auto-redeems a token that the service itself calls "a forwardable credential" (lib/chatService.ts:2410-2412), with no confirmation (i/[token].tsx:254). Add a confirm step, or retire the route on a deadline.
  2. `Stack.Screen options={{ title: 'Invitation' }}` (i/[token].tsx:258) has no effect: the root Stack hides headers by default (app/_layout.tsx:912) and this route is not opted in. While redeeming there is no on-screen exit. Add a back or cancel control.
  3. Use `useTheme`-based `makeStyles` and `AppText` like its siblings, not static `StyleSheet` with RN `Text` (i/[token].tsx:220, 284-292). Add button roles.

### `app/msgrequests.tsx` — Message Requests — **4/10**
- **Route:** `/msgrequests` · **Entry points:** `app/settings.tsx:429`.
- **Purpose:** Intended to list messages from non-contacts with Accept and Decline.
- **Scores:** Function 1 · States 4 · UI 6 · A11y 5 · Security 2 · Code 5
- **Subscreens:**
  - Request card (component, `msgrequests.tsx:40-115`) — **3/10** — Never shown with real data; see Function. Its Accept and Decline buttons have no roles.
  - Decline confirmation (Dialog, `msgrequests.tsx:160-175`) — **2/10** — Says "Their message will be deleted" (162), but it only rewrites a local AsyncStorage array (169-171).
- **Strengths:**
  - The corrupt-blob parse is guarded (msgrequests.tsx:133-138).
  - The empty state is clear (msgrequests.tsx:203-208).
- **To reach 10/10:**
  1. The data source is never written. The `'msgRequests'` AsyncStorage key is only read here (msgrequests.tsx:136); a repo-wide grep finds no writer. The list is therefore always empty. Back it with a server or chat-state query, for example chats pending acceptance.
  2. Accept pushes `/chat` with `contactId`, `contactName` and `fromRequest` (msgrequests.tsx:149-156), but chat reads only `id`/`chatId` (app/chat.tsx:239-243). Pass the chat id.
  3. Make Decline call a real server action, or reword the copy (msgrequests.tsx:5-8, 162).
  4. Await and catch `loadRequests` (msgrequests.tsx:124-131). Hoist the `new Animated.Value(1)`/`(20)` constants out of render (msgrequests.tsx:65). Raise the 9-10px text (msgrequests.tsx:229, 250, 256) and switch to `AppText`.

### `app/invite-link.tsx` — Group invite links — **7/10**
- **Route:** `/invite-link` · **Entry points:** `app/group-info.tsx:471`.
- **Purpose:** Lists, creates (with expiry), copies, shares, QR-renders and revokes group invite links.
- **Scores:** Function 7 · States 7 · UI 7 · A11y 6 · Security 7 · Code 8
- **Subscreens:**
  - Invite QR modal (Modal, `invite-link.tsx:173-186`) — **7/10** — Renders a real QR with a Close button. It has no `accessibilityViewIsModal`, and the QR is unlabelled. The encoded https host does not open the app (see join/[code]).
  - Revoke confirmation (Dialog, `invite-link.tsx:74-84`) — **8/10** — Confirmed and optimistic, with rollback on error.
- **Strengths:**
  - Real `listInviteLinks`, `createInviteLink` and `revokeInviteLink` (invite-link.tsx:16, 43-84).
  - Copying uses `copyAndAutoClear` (invite-link.tsx:70).
  - Shows expiry, revoked state and use counts (invite-link.tsx:86-92, 141-143).
- **To reach 10/10:**
  1. One tap on "Permanent" mints a never-expiring credential that lets anyone join, with no confirmation (invite-link.tsx:122-124). Confirm before creating, at least for Permanent.
  2. A missing `chatId` silently shows an empty list (invite-link.tsx:44, 53). Show an error. Load errors have no retry or pull-to-refresh (invite-link.tsx:46, 118).
  3. `JOIN_BASE` uses `https://vaultchat.app/join/` (invite-link.tsx:19), which app.json does not route into the app (app.json:51-56).
  4. Give the link action buttons `accessibilityRole` (invite-link.tsx:147-162). Switch RN `Text` (10) to `AppText`.


---

## C1 — Chat Conversation Screen

| Screen | Route | Wired? | Score |
|---|---|---|---|
| `app/chat.tsx` — Chat conversation (1:1 + group + split-pane) | `/chat` | Yes (30+ entry points, notification taps) | **6/10** |

### `app/chat.tsx` — Chat Conversation — **6/10**
- **Route:** `/chat` (registered `app/_layout.tsx:939`; params `id`/`chatId` read at `app/chat.tsx:239-267`) · **Entry points:** chat list `app/(tabs)/chats.tsx:397`; native notification taps `app/_layout.tsx:664`, `app/_layout.tsx:807`; group redirect `app/group-chat.tsx:28` (all group chats render through this screen); split view embeds it as a component `app/split.tsx:126`, `app/split.tsx:147`; plus `app/new-chat.tsx:54`, `app/search.tsx:85`, `app/contacts.tsx:184`, `app/create-group.tsx:97`, `app/hidden-chats.tsx:172`, `app/msgrequests.tsx:150`, `app/bookmarks.tsx:92`, `app/chat-code.tsx:144`, `app/join/[code].tsx:43`, `app/i/[token].tsx:35`, `app/qr-contact.tsx:84`, `app/communities.tsx:111`, `app/contact.tsx:35`, `app/family.tsx:2300`, `app/import-chats.tsx:477`, `components/spaces/ChatDoorButton.tsx:34` and more (grepped `pathname: '/chat'` and `returnTo: '/chat'`). Capture screens return through `returnTo: '/chat'` (`app/chat.tsx:2557`, `2705`, `2737`, `2748`).
- **Purpose:** The E2EE message thread. Local-first paint from SQLite, live socket updates, durable text/media outbox, and every per-chat action (calls, settings, attachments, reactions, forward, pin, lock).
- **Scores:** Function 7 · States 8 · UI 6 · A11y 5 · Security 7 · Code 4 (avg 6.17 → **6**)
- **Subscreens:**
  - Message thread (FlatList mode, `app/chat.tsx:3761-3907`, bubbles `components/chat/MessageBubble.tsx:1098-1772`): **7/10**. Inverted, tuned list (`3898-3906`) with a memo comparator (`MessageBubble.tsx:1755-1772`), two-way paging (`2761-2927`), and date, unread and imported dividers (`3812-3814`). The bubble `TouchableOpacity` has no `accessibilityLabel` and no `accessibilityActions`, so screen-reader users cannot reach long-press actions (`MessageBubble.tsx:1359-1381`). Every bubble also builds a full stylesheet through `useS()` (`MessageBubble.tsx:1128`, `chatStyles.ts:74-77`). Fix: add a11y actions (reply/react/more) to the bubble, and pass `S` down from the screen.
  - Header: title, presence, call buttons, overflow trigger (`app/chat.tsx:3498-3595`): **6.5/10**. Call buttons route to real screens for direct (`3550-3563`) and group (`3574-3587`) chats, and the expiry countdown works (`3531-3542`). The avatar (`3503`) and title (`3515`) touchables have no label or role. The lock icon is hard-coded `#22C55E` (`3521`). On narrow screens the icon buttons are 36pt with no hitSlop (`chatStyles.ts:125`). Fix: label the avatar and title and add hitSlop to reach 44pt.
  - Chat overflow menu + Screenshot / Notification-sound / Disappearing pickers (Sheet, `app/chat.tsx:4315-4320`; built `1902-2220`): **7.5/10**. Every item calls a real API, the toggles roll back on failure (`1918-1924`, `1962-1968`, `2049-2055`), and destructive items are confirmed (`2153-2216`). The Sheet has roles (`components/ui/Sheet.tsx:63,75,86`). The notification-sound picker does not mark the current sound (`1936-1942`). The menu is a flat list of 15+ rows. Fix: show the current sound and group the rows under section headers.
  - In-chat search bar (mode, `app/chat.tsx:3602-3630`): **4.5/10**. The match count filters `messages`, not `renderMessages`, so hidden reaction, trip and location plumbing rows are counted (`3615` vs the filters at `326-355`). It searches only the loaded window (≤400, `203`) and has no next/previous jump. A full `/in-chat-search` screen already exists and is wired to `jumpToMessage` via `consumePendingJump` (`app/in-chat-search.tsx:104`, `app/chat.tsx:3170-3176`). Fix: route "Search in chat" (`2018-2021`) to `/in-chat-search`, or count over `renderMessages` and add prev/next.
  - ConnectionBanner (Overlay strip, `app/chat.tsx:3599`; `components/ConnectionBanner.tsx:14-29`): **7/10**. Driven by the real socket state. The offline color is hard-coded `#B00020` (`ConnectionBanner.tsx:34`) and there is no `accessibilityLiveRegion`. Fix: use `colors.danger` and announce state changes.
  - Error bar (Banner, `app/chat.tsx:3632-3636`): **6/10**. Shown only when the outer load throws (`942-943`). It has no retry action and uses hard-coded rgba colors (`chatStyles.ts:181`). Fix: add Retry, which re-runs the load effect.
  - Security-code-change banner (Banner, `app/chat.tsx:3643-3668`): **6/10**. Calls the real `lib/keyChange` check, 1:1 only (`1826-1836`), with Verify routing to `/verify-contact`. The Verify and Dismiss touchables have no role. Dismiss awaits `acknowledgeKeyChange` with no catch (`3658-3662`). Colors are fixed `#FCD34D` (`chatStyles.ts:197-202`). Fix: add `accessibilityRole="button"`, wrap Dismiss in try/catch, and use theme tokens.
  - Inbound screenshot banner (Banner, `app/chat.tsx:3670-3679`): **6.5/10**. Fed by the socket with a self-echo guard (`1244-1254`) and auto-dismissed after 4s (`1895-1899`). It has no live region, and `#FCD34D` is used in both themes (`chatStyles.ts:191`). Fix: add `accessibilityLiveRegion="polite"` and a themed color.
  - Memory Bubble (Banner, `app/chat.tsx:3682-3703`): **5.5/10**. Considers only loaded messages (`3393-3413`). The tap-to-dismiss touchable has no role or label, and colors are fixed (`chatStyles.ts:187-188`). Fix: add a role and label, and a theme-aware palette.
  - Live-location banner (Banner, `app/chat.tsx:3706-3722`): **5/10**. Works (E2E decrypt `1285-1301`, navigate `3710`). The subtitle text is hard-coded `rgba(255,255,255,0.6)` (`3718`) and the ✕ is `rgba(255,255,255,0.5)` (`3720`), unthemed white in both schemes. The ✕ is a bare glyph with no label, nested inside another touchable. Fix: use `colors.textDim` and an `Ionicons` close with `accessibilityLabel`.
  - Pinned-message bar (Banner, `app/chat.tsx:3725-3758`): **6/10**. Unpin is optimistic with rollback (`3749-3752`), and tap jumps to the message. A pinned text message shows only "Message", never its text (`3727-3732`). The bar's main touchable has no label (`3734`). Fix: show the decrypted text preview and label the bar.
  - Scroll-to-bottom FAB + "Load newer" pill (Overlay, `app/chat.tsx:3910-3925`, `3798-3811`): **7/10**. Handles the trimmed window (`3915`), and the pill is labelled with a busy state. The FAB has no `accessibilityLabel` (`3911`). Fix: label it, e.g. "Scroll to latest, N new".
  - @mention picker (group mode Overlay, `app/chat.tsx:3928-3942`; logic `1507-1537`): **5.5/10**. Inserts only the first name (`1525`). The regex `\w` misses non-ASCII names (`1510`, `1526`). `mentionsRef` is not cleared in the per-chat reset (`687-709`). Rows have no role. Fix: use full-name, Unicode-aware tokens, reset `mentionsRef` on chat change, and add a role.
  - Live viewers stack + "Viewing now" modal (Modal, `app/chat.tsx:3951-3955`; `components/chat/ViewerStack.tsx:37-76`): **6.5/10**. Opt-in (`app/chat.tsx:551`, `609`) and the trigger is labelled. Activity colors are hard-coded (`ViewerStack.tsx:18-22`), the sheet uses translucent `glassSoft` (`ViewerStack.tsx:89`), and there is no `accessibilityViewIsModal`. Fix: use tokens, a solid surface and a modal a11y flag.
  - Typing indicator (Banner, `app/chat.tsx:3958-3967`): **6.5/10**. Self-filtered and fails closed (`1208-1220`). An unknown member falls back to a raw uid slice (`3963`), and there is no live region. Fix: fall back to "Someone" and add `accessibilityLiveRegion`.
  - Edit mode bar (Mode, `app/chat.tsx:3970-3977`; send path `1550-1566`): **5.5/10**. The window is enforced (`1703-1707`). The rejection rollback exists (`979-991`), but only after enqueue succeeds. If `enqueueEdit` throws, the optimistic text stays with no rollback (`1557-1561` vs catch `1600-1601`). The banner shows the internal id "Editing message #123" (`3972`), and Cancel has no role. Fix: restore `before` in the catch, and show a quoted preview instead of the id.
  - Vanish Mode / Invisible Ink bars (Banners, `app/chat.tsx:3980-3999`): **6/10**. Both reflect real state and the ink bar disarms on tap (`3992`). Colors are hard-coded (`chatStyles.ts:257-266`), and the ink touchable has no role. Fix: use theme tokens and add a role.
  - Composer link-preview card (Overlay, `app/chat.tsx:4003-4014`; fetch `408-419`): **4.5/10**. Probable bug: `onSend` reads `composerLp` (`1575`), but its deps omit it (`1605`). The preview is set by a debounced effect after the last keystroke, so the memoised `onSend` still holds the earlier `null`. The preview the user sees is then dropped on send, unless they type again after it appears. Fix: add `composerLp` to the `onSend` deps (`1605`).
  - Reply bar (Mode, `app/chat.tsx:4017-4044`): **7.5/10**. Reset per chat (`701`), typed previews, and a labelled cancel (`4040`). The sender name falls back to "message", and there is no "You" for your own messages (`4022`). Fix: show "You" when `senderId === meId`.
  - Composer (normal) + camera tap/slide gesture (`app/chat.tsx:4063-4174`, PanResponder `2613-2632`): **6.5/10**. Real outbox send (`1577`), silent send on long-press (`4162`), `maxLength` 4000, and the composer grows up to the pane height (`483`). The camera control is an `Animated.View` with only pan handlers, so it has no role or label and screen readers cannot activate it (`4133-4143`). Fix: wrap it in a labelled Pressable and give the video note its own a11y action.
  - Voice recording mode (Mode, `app/chat.tsx:4050-4061`; `2289-2386`): **5.5/10**. Records for real and is cleaned up on unmount (`2381-2386`). The hint says "Slide to cancel" (`4054`), but no gesture exists on this composer. Clips under 500ms are discarded with no feedback (`2361-2365`). Fix: implement the slide or change the copy, and toast "Hold longer".
  - Quick-react Modal (Modal, `app/chat.tsx:4177-4197`): **2/10**. **Unreachable**: `setReactPicker` is only ever called with `null` (`2225`, `4181`, `4183`), so `reactPicker` can never be non-null. Reactions work through the action sheet instead. Fix: delete it, along with `QUICK_REACTS` (`4583`).
  - Long-press MessageActionSheet (Sheet, `app/chat.tsx:4200-4205`; `components/MessageActionSheet.tsx:26-108`; actions `app/chat.tsx:1661-1802`): **7/10**. Every action is real: pin with rollback, star with a local copy, Edit gated by window and plaintext, Revoke and Delete confirmed with enqueue-first (`1786-1793`). Tiles and reactions have no `accessibilityRole` (`MessageActionSheet.tsx:83`, `95`), and there is no `accessibilityViewIsModal`. Forward and Copy are offered on view-once and Invisible Ink messages (`app/chat.tsx:1676-1677`). Fix: hide Forward and Copy for `meta.viewOnce`/`invisibleInk` received messages, and add roles.
  - Message Info modal (Modal, `app/chat.tsx:4208-4247`): **6.5/10**. Derived from real delivery and read cursors, excluding members who have left (`4217-4220`), with an empty state (`4241`). Read is hard-coded `#4A9FFF` (`4238`). Rows have no a11y grouping. Delivered/read times are not shown. Fix: use a theme token and show per-member timestamps if the server provides them.
  - Profile photo viewer (Modal, `app/chat.tsx:4250-4285`): **6/10**. Opens a story first when one exists (`3314-3326`), and its actions are real routes. None of the four action buttons has a role (`4262-4280`). "Message" just closes the viewer. Fix: add roles and labels.
  - Attach menu (Modal, `app/chat.tsx:4288-4309`; actions `2732-2758`): **6.5/10**. All 13 entries reach real pickers or screens. Big File is gated to 1:1 with a native check (`2666-2668`). Each action's `color` is dead (defined `2737-2756`, never read; `4301` uses `colors.text`). Cells have no role. Actions are delayed with `setTimeout(a.onPress, 120)` (`4298`). Fix: drop or use the `color` field, add roles, and run the action on modal `onDismiss`.
  - GifPicker overlay + preview dialog (Overlay, `app/chat.tsx:4312`; `components/GifPicker.tsx:66-230`): **7/10**. Debounced search through the backend proxy, KLIPY attribution, error and empty states (`GifPicker.tsx:84-101`), and a preview before send. Sending bypasses the outbox: `sendMessage` is called directly, so offline sends just fail (`app/chat.tsx:2717`). Grid cells and tabs have no label, role or selected state (`GifPicker.tsx:161-185`). Fix: queue through `enqueueText`/outbox, and label the cells and tabs.
  - Media caption preview (full-screen Modal, `app/chat.tsx:4323-4447`): **6/10**. Multi-item, with per-item caption and view-once, KeyboardSafe, and a per-item enqueue error (`2486-2493`). The send button (`4430`) and view-once toggle (`4412`) have no `accessibilityLabel`. Text and icons hard-coded `#fff` sit on `colors.bg` (`4364`, `4405`). Offsets are fixed instead of insets (`top: 48` at `4348`, paddingBottom `4410`). `#1F2937` is hard-coded (`4415`). Fix: label both controls, use `colors.text`, and use `useSafeAreaInsets`.
  - Forward picker (Modal, `app/chat.tsx:4450-4510`; `lib/chatService.ts:2726-2742`): **5.5/10**. Real send, hop-count notice, loading and empty states. There is no search over the chat list. Rows show the raw `item.type` (`4503`) and have no role. The send is not queued offline (`2274-2280`). It copies `source.meta` wholesale, including `viewOnce`/`localUri` (`chatService.ts:2732`). Fix: add a filter input, strip local-only meta, and use outbox semantics.
  - Per-chat lock gate (full-screen Overlay, `app/chat.tsx:4516-4576`; logic `3223-3283`): **6.5/10**. Fails closed on read errors (`3252-3257`), re-veils on focus (`3247`), and enforces both factors (`3278-3281`). While veiled, the screen still marks messages read: the read effect checks `appActive`/`cvFocused`, not `lockState` (`1393`). It still broadcasts "reading" viewer activity (`609`) and clears notifications (`713-715`). PIN entry has no attempt limit (`3274-3275`), and the PIN is an unsalted fixed-prefix SHA-256 in AsyncStorage (`lib/chatLock.ts:29-30`, `57-58`). Unlock and Back have no role (`4565`, `4571`). Fix: gate read receipts, viewer emission and the notification clear on `lockState === 'open'`, and add backoff on PIN attempts.
  - Not-found / loading states (`app/chat.tsx:3446-3474`): **8/10**. The not-found state has a labelled exit button (`3456-3463`). The loading spinner has no a11y label, and `#fff` is hard-coded (`3462`).
  - Failure / destructive Alert dialogs (Alerts, `app/chat.tsx:1612-1653`, `1734-1757`, `1764-1799`, `2153-2216`): **7.5/10**. Retry, Cancel and Delete are real, and destructive ones are confirmed. The screenshot Alert claims "The other side has been notified." even when the report fails (`1874-1882`). Fix: alert only after the report resolves.
  - Group-chat mode (`app/chat.tsx:1511`, `1986-1993`, `2095-2101`, `3352`, `3570-3590`): **6.5/10**. Group calls, group info and member count are wired, and key-change is deliberately 1:1 (`1823-1828`). There is no Clear chat or Leave group in the menu, because those entries only exist under `if (peer)` (`2103-2217`). The mention issues above apply. Fix: add Clear chat and Leave group for groups.
  - Embedded split-pane mode (`app/chat.tsx:226-246`, `264`): **6/10**. The doc says `embedded` "Hides the screen-level back button" (`232`), but the Back button renders unconditionally and calls `router.back()` (`3500`). Fix: wrap `3500-3502` in `!embedded`.
- **Strengths:**
  - Async safety is strong: every async load, page and decrypt is gated on `alive()`/`chatIdRef` against pane swaps (`app/chat.tsx:729-731`, `1113-1116`, `2765-2769`), with a full per-chat state reset (`687-709`).
  - Message durability: delivery is acked only after the local persist (`1130-1133`), sends are optimistic through the durable outbox with failed/retry states (`951-1033`, `1611-1634`), and rollbacks exist for pin, unpin and settings (`1666-1675`, `3749-3752`).
  - Screenshot policy obeys the peers' setting and goes through `setSecure` (`1853-1868`). The lock gate fails closed (`3252-3257`). Copy auto-clears the clipboard (`1677`). Related selftests pass: `a11yCoverage` (0 unlabelled icon-only buttons), `themeCoverage`, `chatLockFactors`, `editWindow`, `chatTimeline`, `silentFailure`, `klipyAttribution` (run with `npx tsx`).
- **To reach 10/10:**
  1. Gate the read effect (`app/chat.tsx:1393`), viewer emission (`609`) and `clearMessageNotifications` (`713-715`) on `lockState === 'open'`, so opening a locked chat without unlocking does not send blue ticks. Add attempt backoff to `submitLockPin` (`3274`), and a salted/KDF PIN hash in `lib/chatLock.ts:29-30`.
  2. Add `composerLp` to the `onSend` deps (`1605`) so the compose-time link preview is actually sent.
  3. In the `onSend` catch (`1600`), roll back the optimistic edit (`1557-1558`) when `enqueueEdit` throws.
  4. Accessibility: add labels and roles to the avatar and title (`3503`, `3515`), the scroll FAB (`3911`), the pinned bar (`3734`), the key-change buttons (`3650-3664`), the live-location ✕ (`3720`), attach cells (`4294`), forward rows (`4495`), photo actions (`4262-4280`), lock buttons (`4565`, `4571`), and the media-preview send and view-once controls (`4412`, `4430`). Make the camera control focusable (`4133`). Add `accessibilityActions` on bubbles (`MessageBubble.tsx:1359`). Raise narrow header targets to 44pt (`chatStyles.ts:125`).
  5. Fix the search mode: count over `renderMessages` (`3615`), or route to the existing `/in-chat-search` (`2018-2021`).
  6. Hide the Back button when `embedded` (`3500`).
  7. Remove dead code: the unreachable quick-react Modal and `QUICK_REACTS` (`4177-4197`, `4583`), 30+ unused imports (e.g. `FileSystem`, `IntentLauncher`, `Sharing`, `Linking`, `Swipeable`, `Dimensions`, `Audio`, `LinkPreview`, `VaultBeamBubble`, `ProgressRing`, `FileBubble`, `getMedia`, `copyToCache`, `thumbDataUri`, `unvotePoll`, `voteOnPoll`, `putLiveKey`, `markViewedOnce`, `isRevokedSync`, `idealText`, `HL`, `makeStyles`, `renderWithHighlight`, `ELEVATION`, `Palette` at `23-224`), unused `const me` in socket handlers (`1203`, `1222`, `1232`, `1277`, `1303`), the dead `color` field in attach actions (`2737-2756`), the misplaced `meId IS A DEPENDENCY` comment on an effect whose deps are `[chatId, pollIdKey]` (`1372-1386`), orphan comments (`4046`, `4585-4588`), and the "Slide to cancel" copy with no gesture (`4054`).
  8. Theme: replace the dark-tuned fixed hex/rgba colors in banners and modals with tokens (`3521`, `3708-3720`, `4238`, `4364`, `4405`, `4415`; `chatStyles.ts:181-266`), and use safe-area insets in the media preview (`4348`, `4410`).
  9. Privacy: disable Forward and Copy on received view-once and Invisible Ink messages (`1676-1677`), and strip `localUri`/`viewOnce` from forwarded meta (`lib/chatService.ts:2732`). Route GIF and Forward sends through the outbox (`2717`, `2274`).
  10. Split the 4,588-line component: extract the socket subscription (`1036-1350`), paging/jump (`2761-3176`), lock gate (`3223-3283`, `4516-4576`) and modals into hooks and components. Reduce the 44 `as any` casts. Hoist `useS()` out of each bubble (`MessageBubble.tsx:1128`). Show pinned text content (`3727-3732`). Add message multi-select (none exists; grep for selection mode found only image-picker options at `2442`, `2509`).

_Notes:_ `npm run lint` could not be run because `eslint-config-expo/flat` is not installed (`eslint.config.js:3`), so the exhaustive-deps finding at `1605` comes from reading the code. These listed components are **not rendered by chat.tsx or MessageBubble** (grep found no reference): ChatHeaderAction (used only by `app/(tabs)/chats.tsx`), SharedMediaThumb (`app/group-info.tsx`, `app/contact-info.tsx`), ReactionPicker (call components only), FormattingToolbar, SmartReplyBar, WritingAssistant, VoiceRecorder, MediaMessage, InvisibleInk, VaultFeatureSheet, TransferProgress, NetworkBanner (no importers anywhere in `app/` or `components/`), LocationMap, DocView, PdfView, ProtectedMediaView (other screens only). `LinkPreview` and `VaultBeamBubble` render via `MessageBubble.tsx:1600-1602`, `1532`. Their imports in chat.tsx (`74`, `141`) are unused. Visual polish, real-device keyboard behavior, and FLAG_SECURE coverage of RN `<Modal>` windows are not verifiable statically.


---

## C2 — Chat Tools, Backup & Import

| Screen | Route | Wired? | Score |
|---|---|---|---|
| `app/in-chat-search.tsx` | `/in-chat-search` | Yes | 7/10 |
| `app/message-reminder.tsx` | `/message-reminder` | Yes | 5.5/10 |
| `app/schedule-message.tsx` | `/schedule-message` | Yes | 6.5/10 |
| `app/scheduled.tsx` | `/scheduled` | Yes | 6/10 |
| `app/create-poll.tsx` | `/create-poll` | Yes | 7/10 |
| `app/stickers.tsx` | `/stickers` | **UNWIRED** | 4.5/10 |
| `app/bookmarks.tsx` | `/bookmarks` | Yes | 5.5/10 |
| `app/chat-code.tsx` | `/chat-code` | Yes | 7/10 |
| `app/chat-export.tsx` | `/chat-export` | Yes | 5.5/10 |
| `app/chat-themes.tsx` | `/chat-themes` | Yes | 6/10 |
| `app/chat-wallpaper.tsx` | `/chat-wallpaper` | Yes | 5.5/10 |
| `app/receipt-control.tsx` | `/receipt-control` | Yes | 6.5/10 |
| `app/broadcast.tsx` | `/broadcast` | Yes | 5.5/10 |
| `app/hidden-chats.tsx` | `/hidden-chats` | Yes | 5.5/10 |
| `app/app-lock-chats.tsx` | `/app-lock-chats` | **UNWIRED** | 3.5/10 |
| `app/import-chats.tsx` | `/import-chats` | Yes | 6.5/10 |
| `app/chat-backup.tsx` | `/chat-backup` | Yes | 6/10 |
| `app/backup-e2ee.tsx` | `/backup-e2ee` | Yes | 6/10 |

Evidence notes for the whole batch:
- Repo selftests I ran (read-only, `npx tsx`): `lib/a11yCoverage.selftest.ts` passes ("icon-only (need a label): 305, unlabelled: 0"), and so do `lib/themeCoverage.selftest.ts`, `lib/responsiveCoverage.selftest.ts`, `lib/screenBackCoverage.selftest.ts`, `lib/chatCode.selftest.ts`, `lib/chatLockFactors.selftest.ts` and `lib/chatTimeline.selftest.ts`. `lib/waImport.selftest.ts` and `lib/backupCrypto.selftest.ts` could not run here because `fflate` and `@noble/hashes` are missing (node_modules is not installed). This is an environment limit, not a verdict on the code.
- The a11y selftest checks only *icon-only* touchables, so the text-bearing touchables in this batch that lack `accessibilityRole`/`accessibilityState` are not enforced by it.
- Screenshot protection is app-wide: `setSecure(true)` at `app/_layout.tsx:242`. The root Stack paints `colors.bg` behind every screen (`app/_layout.tsx:912`), so a screen without `AuroraBackground` looks flat but is not transparent.
- Deep links: `lib/pendingLink.ts:42-63` turns any `vaultchat://<path>` into a route. That makes every route here technically deep-linkable, but that is not an in-app entry point.

---

### `app/in-chat-search.tsx` — In-chat message search — **7/10**
- **Route:** `/in-chat-search` · **Entry points:** `app/contact-info.tsx:261` (Search action). contact-info is reached from `app/chat.tsx:3338` and from the Chats-list avatar popup `app/(tabs)/chats.tsx:794`.
- **Purpose:** Debounced on-device search of the decrypted local message cache for one chat. Tapping a result hands a jump target back to the chat.
- **Scores:** Function 8 · States 8 · UI 8 · A11y 6 · Security 4 · Code 8
- **Subscreens:** None (loading/error/empty/results are in-screen states, `app/in-chat-search.tsx:161-193`).
- **Strengths:**
  - Search is truly local. `searchInChat` reads `localDb` and does not replay the ratchet (`lib/chatService.ts:2541-2566`).
  - Out-of-order responses are guarded by `reqSeq`, invalidated synchronously (`app/in-chat-search.tsx:44-63`). The selftest enforces this (`lib/chatTimeline.selftest.ts:28`).
  - Result tap works end-to-end: `setPendingJump` (`app/in-chat-search.tsx:104`) is consumed on chat focus (`app/chat.tsx:3170-3176`).
- **To reach 10/10:**
  1. **Locked chats can be searched without unlocking them.** The screen never checks `getLock(chatId)`, and it is reachable from the Chats list without opening the chat (`app/(tabs)/chats.tsx:794` → `app/contact-info.tsx:261`). Gate it with the same lock check as `app/chat-export.tsx:129-174` before calling `searchInChat` (`app/in-chat-search.tsx:54`).
  2. Add `accessibilityRole="button"` and a label (sender + snippet) to result rows (`app/in-chat-search.tsx:109`). Add `accessibilityRole` to the back and clear buttons (`:126`, `:144`).
  3. Delete the stale header note that says scroll-to-message is "tracked as a follow-up" (`app/in-chat-search.tsx:7-10`). The jump is implemented at `:102-106`.
  4. Memoise `renderItem`/`highlightMatch` (`app/in-chat-search.tsx:83-116`) so a keystroke does not rebuild up to 80 highlighted rows.

### `app/message-reminder.tsx` — Message reminders — **5.5/10**
- **Route:** `/message-reminder` · **Entry points:** `app/chat.tsx:1686-1689` (message action "Remind" → composer mode), `app/settings.tsx:426` (list mode).
- **Purpose:** Schedules a local notification for a message (composer) or lists and cancels pending reminders (list).
- **Scores:** Function 7 · States 6 · UI 6 · A11y 5 · Security 4 · Code 6
- **Subscreens:**
  - Composer (Mode, `app/message-reminder.tsx:92-196`) — **6/10** — real `scheduleNotificationAsync` with permission flow. Fix: set `busy` before the permission await (`:102-117`) so a double tap cannot schedule twice.
  - Reminders list (Mode, `app/message-reminder.tsx:198-281`) — **5.5/10** — cancel deletes the row only after a successful OS cancel (`:224-232`). It has no AuroraBackground (`:243`) and rows have no a11y role.
- **Strengths:**
  - The cancel path will not erase the cancellation handle on failure (`app/message-reminder.tsx:217-229`).
  - The permission-denied path goes through the shared `permissionDenied` helper (`:112`).
  - The empty state explains how to create a reminder (`:251-257`).
- **To reach 10/10:**
  1. **Decrypted message text goes into the notification tray.** The body is `"${preview.slice(0, 140)}"` (`app/message-reminder.tsx:122`), which bypasses the user's tray-privacy setting. `lib/privacyPrefs.ts:30-35` states there is deliberately no "full text" mode. Build the content with `notifContent(getNotifPreview(), …)` (`lib/privacyPrefs.ts:55-63`).
  2. The preview plaintext is persisted unencrypted in AsyncStorage (`app/message-reminder.tsx:69-71, 130-135`). Store it through the sealed kv store that bookmarks use (`lib/chatService.ts:1699-1731`), or store only `chatId`/`messageId`.
  3. Persist the pruned list in `loadReminders` (`:62-65`) so expired rows do not accumulate.
  4. Remove the user-facing route path "/message-reminder" from the copy (`:191`). Remove the unused `colors`/`S` (`:79-80`). Type `router` instead of `any` (`:95`, `:198`).
  5. Add `accessibilityRole="button"` and a "Cancel reminder" hint to preset and list rows (`:168-177`, `:264`). Add AuroraBackground to the list and loading views (`:239`, `:243`).

### `app/schedule-message.tsx` — Schedule a message — **6.5/10**
- **Route:** `/schedule-message` · **Entry points:** `app/chat.tsx:2075-2081` (chat menu "Schedule a message"), `app/scheduled.tsx:114` (Edit; dead while `SCHEDULED_LOCAL=false`, `constants/flags.ts:142`).
- **Purpose:** Seals a text message on-device and POSTs it to `/user/scheduled-messages` for server-side delivery.
- **Scores:** Function 7 · States 7 · UI 7 · A11y 5 · Security 7 · Code 7
- **Subscreens:**
  - Custom date → time picker (Dialog, `app/schedule-message.tsx:89-106`) — **5/10** — uses `DateTimePickerAndroid` only, but the app also has an iOS config (`app.json:16`). Fix: use the cross-platform `DateTimePicker` component on iOS.
- **Strengths:**
  - Content is encrypted before upload, and private meta is split off (`lib/chatService.ts:1541-1561`).
  - Empty text, missing chat and past times are validated (`app/schedule-message.tsx:66-69`).
  - Buttons are disabled while scheduling (`:140-142`, `:168-170`).
- **To reach 10/10:**
  1. Fix the misleading copy. The header says the screen is reached by "long-press Send" (`app/schedule-message.tsx:3`). The only entry is the chat menu (`app/chat.tsx:2076`), and grep finds no long-press schedule.
  2. Provide an iOS date/time picker path (`:15`, `:91`).
  3. Wrap the content in `KeyboardSafe` like `app/chat-code.tsx:151`, so the multiline input (`:123-131`) is not covered by the keyboard.
  4. Add `accessibilityRole="button"` to the quick-time and custom buttons (`:138`, `:157`, `:167`), and an `accessibilityLabel` to the input (`:123`).
  5. The local plaintext copy is unencrypted AsyncStorage (`lib/scheduledLocalCopy.ts:10-21`). Move it to the sealed kv store (`lib/chatService.ts:1699-1731`).
  6. Replace hard-coded `'#fff'` (`:215`) with `c.bubbleOutText`, as `app/create-poll.tsx:166` does.

### `app/scheduled.tsx` — Scheduled messages list — **6/10**
- **Route:** `/scheduled` · **Entry points:** `app/settings.tsx:424`.
- **Purpose:** Lists pending scheduled messages and those delivered in the last 7 days. Tapping a pending row cancels it.
- **Scores:** Function 6 · States 7 · UI 7 · A11y 5 · Security 5 · Code 6
- **Subscreens:**
  - Cancel/Edit action dialog (Alert, `app/scheduled.tsx:107-127`) — **6/10** — real cancel with error alert. The "Edit" branch only exists under `SCHEDULED_LOCAL` (`:109`), which is `false` (`constants/flags.ts:142`).
- **Strengths:**
  - Local-first paint from cache with a soft error when a cache exists (`app/scheduled.tsx:77-92`).
  - Pull-to-refresh (`:161`). Delivered rows are disabled (`:173-174`).
  - The server ciphertext is replaced by the sender's local copy (`:64-72`).
- **To reach 10/10:**
  1. The full plaintext list is written to the unencrypted AsyncStorage cache (`app/scheduled.tsx:76` → `lib/localCache.ts:28-30`). Cache rows without `content`, or use the sealed store.
  2. Fix the empty-state instruction "long-press the Send button" (`:154`). The real entry is the chat menu (`app/chat.tsx:2076`).
  3. Remove or flag-gate the dead `SCHEDULED_LOCAL` branches and their `as any` casts (`:55-61`, `:102`, `:108-117`).
  4. Give rows `accessibilityRole="button"` and a label/hint ("Cancel scheduled message to X") (`:171-192`).
  5. Reload on focus (`useFocusEffect`) so a message scheduled from a chat shows up without pull-to-refresh (`:86-93`).

### `app/create-poll.tsx` — Create poll — **7/10**
- **Route:** `/create-poll` · **Entry points:** `app/chat.tsx:2751` (attach menu "Poll").
- **Purpose:** Composes a question with 2–12 options and sends it as a `poll` message.
- **Scores:** Function 8 · States 7 · UI 7 · A11y 5 · Security 8 · Code 8
- **Subscreens:** None.
- **Strengths:**
  - Real send through `createPoll` → `sendMessage` (`lib/chatService.ts:1627-1636`). Options travel in private meta; only `optionCount` is public (`lib/msgEnvelope.ts:67-71, 112`).
  - Question length and non-empty options are validated (`app/create-poll.tsx:51-59`). Min/max options are enforced (`:41-47`).
  - The remove-option icon button is labelled (`:118`).
- **To reach 10/10:**
  1. Reject duplicate options after trim (`app/create-poll.tsx:55`).
  2. Key option rows by a stable id, not the index (`:108`), so removing a middle option does not shift focus and IME state.
  3. Add `accessibilityLabel="Allow multiple answers"` to the `Switch` (`:143`). Add `accessibilityRole="button"` to Send and Add option (`:83`, `:129`).
  4. Wrap the content in `KeyboardSafe` (`:93`) so lower option inputs stay visible with the keyboard up.

### `app/stickers.tsx` — Sticker picker — **4.5/10**
- **Route:** `/stickers` · **Entry points:** **UNWIRED**. I grepped `'/stickers'`, `pathname: '/stickers'`, `"stickers"` and `route:` patterns across app/components/lib/hooks/services/constants. The only hits are the Stack registration (`app/_layout.tsx:967`) and an unrelated GifPicker tab (`components/GifPicker.tsx:38`). The chat uses `GifPicker initialTab="stickers"` instead (`app/chat.tsx:4312`).
- **Purpose:** Six hard-coded emoji "packs". Tapping one sends a `sticker` message.
- **Scores:** Function 1 · States 6 · UI 6 · A11y 4 · Security 7 · Code 3
- **Subscreens:** None.
- **Strengths:**
  - Send goes through the real `sendMessage` path with a `sending` guard (`app/stickers.tsx:62-79`).
  - Tile width follows `useWindowDimensions` (`:52-54`).
- **To reach 10/10:**
  1. Decide: delete the route (it duplicates the GifPicker stickers tab, `app/chat.tsx:4312`) or wire it into the attach menu (`app/chat.tsx:2751` area).
  2. If it is kept: the tile size `(SW-80)/8` is about 35dp on a 360dp screen (`app/stickers.tsx:54`), below 44/48dp. Use 6 columns or a min size. Add `accessibilityLabel` per sticker (`:101-109`).
  3. Remove the unused `Dimensions` import and the stale comment about a module-level `Dimensions.get` (`:16`, `:38-42`).

### `app/bookmarks.tsx` — Bookmarks — **5.5/10**
- **Route:** `/bookmarks` · **Entry points:** `app/settings.tsx:425`.
- **Purpose:** Lists bookmarked messages across chats. Tap opens the chat; long-press removes the bookmark.
- **Scores:** Function 5 · States 7 · UI 7 · A11y 4 · Security 3 · Code 7
- **Subscreens:** None (only the remove confirmation Alert, `app/bookmarks.tsx:95-116`).
- **Strengths:**
  - Local-first cache paint and an offline-tolerant error (`app/bookmarks.tsx:48-75`).
  - Bodies the server reclaimed are filled from the sealed local snapshot (`:61-67`, `lib/chatService.ts:1723-1731`).
  - Removal is confirmed (`:96-115`).
- **To reach 10/10:**
  1. **Decrypted bookmark bodies are written to plaintext AsyncStorage** via `writeCache('bookmarks', hydrated)` (`app/bookmarks.tsx:69`, `:106` → `lib/localCache.ts:28-30`). This contradicts the sealed-store design in `lib/chatService.ts:1699-1701`. Cache without `content`.
  2. When the server still has `content`, it is shown raw (`app/bookmarks.tsx:64`, `:168`). `listBookmarks` does no decryption (`lib/chatService.ts:1688-1690`), and E2EE is on (`constants/flags.ts:13`), so this is likely ciphertext. Whether the server returns ciphertext here is not verifiable statically. Prefer the local snapshot, or decrypt.
  3. `removeBookmark` does not delete the local plaintext snapshot (`lib/chatService.ts:1749-1751`). Delete `vc_bookmark_pt_<id>` too.
  4. Jump to the message on tap with `setPendingJump` (`lib/chatJump.ts:8-10`), as `app/search.tsx:84` does, instead of only opening the chat (`app/bookmarks.tsx:92`). Update the header note (`:3-5`).
  5. Removal is long-press only (`:153`). Add `accessibilityActions` (remove) and `accessibilityRole` on rows. Add a role on back (`:127`).
  6. The empty state says to choose "Bookmark" (`:140`), but the action is labelled "Star" (`app/chat.tsx:1678`).

### `app/chat-code.tsx` — Chat by code — **7/10**
- **Route:** `/chat-code` · **Entry points:** `app/(tabs)/chats.tsx:408-411` (temporary-chat sheet, `mode` param).
- **Purpose:** Creates a 6-digit, 2-minute code that opens a chat, or joins with one.
- **Scores:** Function 8 · States 8 · UI 7 · A11y 5 · Security 6 · Code 8
- **Subscreens:**
  - Share-a-code tab (Tab, `app/chat-code.tsx:175-252`) — **7/10** — live countdown, auto-clears a dead code (`:103-113`), revoke (`:125-134`). Fix: put the code on `copyAndAutoClear` (`lib/clipboardSafe.ts:46`) instead of raw `Clipboard.setStringAsync` (`:199`).
  - Enter-a-code tab (Tab, `app/chat-code.tsx:253-284`) — **7.5/10** — digit-only, 6-length validation (`:139-140`, `:263`) and a join guard. Fix: add `accessibilityLabel` to the input (`:260`).
- **Strengths:**
  - Busy/joining guards on every network action (`app/chat-code.tsx:115-148`).
  - On re-entry the live code is re-read instead of re-minted (`:89-95`).
  - Uses `KeyboardSafe` and `keyboardShouldPersistTaps` (`:151`, `:174`). Covered by `lib/chatCode.selftest.ts`, which passes.
- **To reach 10/10:**
  1. Tabs need `accessibilityRole="tab"` and `accessibilityState={{selected}}` (`app/chat-code.tsx:162-170`). Option rows need `accessibilityRole="radio"` and `checked` (`:218-232`). The countdown needs `accessibilityLiveRegion="polite"` (`:186-189`).
  2. Show an error state when `getChatCode` fails, instead of swallowing it (`:90-93`).
  3. Replace `'#fff'` (`:242`, `:281`, `:305`, `:335`) with a palette token. Remove the unused `Platform` import (`:23`). Fix the inaccurate "second device gets linked" comment (`:329`).

### `app/chat-export.tsx` — Export chat — **5.5/10**
- **Route:** `/chat-export` · **Entry points:** `app/contact.tsx:125`.
- **Purpose:** Fetches all messages, unions them with the local cache, formats TXT/HTML and shares the file through the system sheet behind a lock/confirm gate.
- **Scores:** Function 4 · States 6 · UI 6 · A11y 6 · Security 5 · Code 6
- **Subscreens:**
  - Chat-lock PIN modal (Modal, `app/chat-export.tsx:292-321`) — **6/10** — labelled secure input (`:306`), keyboard-safe. Fix: add an attempt limit or back-off in `submitPin` (`:117-120`).
- **Strengths:**
  - The export gate fails closed and enforces "both" as two factors (`app/chat-export.tsx:129-174`).
  - Unions with local history so reclaimed bodies are kept (`:60`, `lib/messageHistory.ts:39-56`).
  - HTML output escapes bodies and names (`:209`, `:222`, `:228`).
- **To reach 10/10:**
  1. **Exports can contain ciphertext.** `getMessages` returns raw server rows with no decryption (`lib/chatService.ts:1456-1463`). The union lets the server row win whenever it still has `content` (`lib/messageHistory.ts:51-52`). The chat screen runs `hydrateMessages` (`app/chat.tsx:858-859`); the export path (`app/chat-export.tsx:54-60`) does not. Hydrate or decrypt before `bodyOf` (`:69-82`).
  2. The plaintext file is left in `documentDirectory` after sharing (`:89-94`, `:204-205`, `:235-236`). Write it to the cache directory and delete it after `shareAsync`.
  3. Set `exporting` (or a ref) before `authorizeExport()` (`:178-179`). Today a double tap can start two export flows.
  4. Use real sender names in groups. `senderLabel` labels every non-self message as `peerName` (`:67`).
  5. Report it when the 500×200 page cap is hit (`:53`) instead of silently truncating.
  6. Replace `'#00000099'`/`'#FFFFFF'`/`BRAND_ACCENT` in RN styles (`:315`, `:345`, `:351`) with tokens. Add `accessibilityRole` to the export buttons (`:261`, `:269`).

### `app/chat-themes.tsx` — Bubble theme — **6/10**
- **Route:** `/chat-themes` · **Entry points:** `app/settings.tsx:266` (global), `app/chat.tsx:2088-2091` (per chat).
- **Purpose:** Chooses the outgoing-bubble colour, global or per chat. `app/chat.tsx:3209-3216` reads it on focus.
- **Scores:** Function 7 · States 5 · UI 7 · A11y 4 · Security 8 (low-sensitivity setting) · Code 6
- **Subscreens:** None.
- **Strengths:**
  - Live preview uses theme bubble tokens (`app/chat-themes.tsx:91-104`).
  - Text colour is picked for contrast (`:41-46`, `:73-74`).
  - The chat screen re-reads the setting on focus, so changes apply immediately (`app/chat.tsx:3205-3216`).
- **To reach 10/10:**
  1. "Default" on a per-chat screen deletes the per-chat key (`app/chat-themes.tsx:67`), and `getBubbleColors` then falls back to the global choice (`:133-134`). A chat therefore cannot opt back to Default while a global colour is set. Store an explicit `'default'` per chat.
  2. Wrap the AsyncStorage reads and writes in try/catch with a user-visible error (`:58-69`).
  3. Swatches need `accessibilityRole="radio"`, `accessibilityState={{checked}}` and a label (`:112`). Reset needs a role (`:86`).
  4. Show global vs per-chat scope in the title. Both ternary branches say 'Bubble theme' (`:85`). Remove the unused `Alert` import (`:11`).

### `app/chat-wallpaper.tsx` — Chat wallpaper — **5.5/10**
- **Route:** `/chat-wallpaper` · **Entry points:** `app/settings.tsx:267`, `app/chat.tsx:2083-2086`.
- **Purpose:** Chooses a solid, gradient or photo wallpaper per chat or globally. `app/chat.tsx:3213` reads it.
- **Scores:** Function 6 · States 5 · UI 7 · A11y 4 · Security 7 · Code 5
- **Subscreens:**
  - Colors tab (Tab, `app/chat-wallpaper.tsx:172-196`) — **6/10** — colour tiles labelled (`:186`). The Default tile has no label or state (`:175-182`).
  - Gradients tab (Tab, `app/chat-wallpaper.tsx:198-212`) — **5.5/10** — the tiles have no role, label or selected state (`:203`).
  - My photo tab (Tab, `app/chat-wallpaper.tsx:214-231`) — **5/10** — permission is handled (`:100-104`), but the picker URI is stored as-is (`:110`, `:91`). Fix: copy it into app storage.
- **Strengths:**
  - Grid sizes come from live `useWindowDimensions` (`app/chat-wallpaper.tsx:68`, `:244-248`).
  - Denied permission uses the shared `permissionDenied` helper (`:102`).
  - The live preview uses real themed bubbles (`:148-159`).
- **To reach 10/10:**
  1. Copy the picked image into `documentDirectory` before saving (`app/chat-wallpaper.tsx:109-111`). Persisting a picker cache URI may break after cache eviction; not verifiable statically.
  2. Same per-chat Default issue as themes: `reset` removes the key (`:92`, `:97`), and `getWallpaper` falls back to the global default (`:54-55`).
  3. Hoist `PreviewBg` out of the render (`:116-130`). As an inline component it remounts the `Image` and `LinearGradient` on every state change.
  4. Saving behaviour differs from Bubble theme, which saves on tap (`app/chat-themes.tsx:65-69`), while wallpaper needs "Set wallpaper" (`:233`) and discards on back with no prompt. Pick one model.
  5. Tabs need `accessibilityRole="tab"` and `selected` (`:164`). Add labels for the gradient and Default tiles (`:175`, `:203`). Remove the unused `Dimensions` import and the stale comment (`:12`, `:63-67`). Replace `'#fff'` (`:267`, `:286`).

### `app/receipt-control.tsx` — Per-contact privacy (receipts/typing/last seen) — **6.5/10**
- **Route:** `/receipt-control` · **Entry points:** `app/settings.tsx:392`.
- **Purpose:** Per-contact toggles mapped to `/user/ghost-mode` rows for direct-chat peers.
- **Scores:** Function 8 · States 6 · UI 7 · A11y 6 · Security 7 · Code 6
- **Subscreens:** None.
- **Strengths:**
  - Real API: `listGhostMode` and `setGhostMode` PUT a partial patch (`lib/chatService.ts:1921-1937`), with an optimistic update and rollback (`app/receipt-control.tsx:78-96`).
  - Toggles use `accessibilityRole="switch"` and `accessibilityState.checked` (`:103-114`).
  - Unmount-safe initial load (`:42-66`).
- **To reach 10/10:**
  1. Rollback restores the whole `rules` snapshot captured before the call (`app/receipt-control.tsx:82`, `:93`), so a failure reverts other toggles changed meanwhile. Roll back only `[userId][hideKey]`.
  2. Include the contact name in each toggle label, e.g. "Read receipts for Alice" (`:171-173`). Raise toggles from 34dp + hitSlop 4 to at least 44dp (`:110`, `:210`).
  3. Clear `error` on the next success and add retry or pull-to-refresh (`:59-60`, `:94`, `:156`).
  4. Hoist `Toggle` out of the component (`:106-117`). Drop the `as any` (`:91`).

### `app/broadcast.tsx` — Broadcast channels — **5.5/10**
- **Route:** `/broadcast` · **Entry points:** `app/(tabs)/chats.tsx:625`, `app/creator-channels.tsx:15` (redirect).
- **Purpose:** Lists, creates and joins channels. The in-screen channel view shows posts (with realtime) and lets the admin post.
- **Scores:** Function 5 · States 5 · UI 6 · A11y 4 · Security 6 · Code 6
- **Subscreens:**
  - Channel list (Mode, `app/broadcast.tsx:194-243`) — **5.5/10** — cache-first (`:59-65`). No AuroraBackground (`:195-196`) and no refresh.
  - Channel detail (Mode, `app/broadcast.tsx:135-191`) — **5/10** — realtime join/leave (`:68-86`). Android hardware back leaves the whole screen because there is no `BackHandler` for the in-screen mode, and there is no keyboard handling around the post bar (`:173-185`).
  - Create channel (Modal, `app/broadcast.tsx:246-260`) — **6/10** — busy-guarded. No `maxLength` on name or description (`:251-252`).
  - Join channel (Modal, `app/broadcast.tsx:263-284`) — **6/10** — busy-guarded. Cancel has no role (`:280`).
- **Strengths:**
  - Real `/channels` API calls (`lib/chatService.ts:1403-1423`) with error alerts.
  - Socket listener cleanup on channel change (`app/broadcast.tsx:82-85`).
  - Modals are wrapped in `KeyboardSafe` (`:247`, `:264`).
- **To reach 10/10:**
  1. The shared invite link `https://vaultchat.app/channel/<code>` (`app/broadcast.tsx:132`) has no matching route (no `app/channel*`) and no intent filter (`app.json:48-63` only covers `api.corefinite.com/live/join`). Add a join route and intent, or share only the code.
  2. Make the detail view a real route (or add a `BackHandler`) and wrap it in `KeyboardSafe` (`:135-191`).
  3. Paginate posts with the existing `before` support (`lib/chatService.ts:1412-1419`). Today the screen loads 50 only (`app/broadcast.tsx:116`).
  4. Filter `channel_post` by channel id once the payload carries it (`:78-81`; `ChannelPost` has no `channelId`, `lib/chatService.ts:1396-1402`).
  5. Add leave/unsubscribe and admin delete. Grep found none in this file.
  6. Posts are sent to the server as plaintext (`lib/chatService.ts:1421-1423`). Tell users in the UI that channels are not end-to-end encrypted.
  7. Add `accessibilityRole` to Create, Join, Share, POST and Cancel (`:145`, `:182`, `:207`, `:211`, `:256`, `:280`).

### `app/hidden-chats.tsx` — Hidden chats — **5.5/10**
- **Route:** `/hidden-chats` · **Entry points:** `app/settings.tsx:427`.
- **Purpose:** A server-verified MPIN gate, then a list of hidden chats with long-press unhide.
- **Scores:** Function 6 · States 6 · UI 6 · A11y 4 · Security 5 · Code 6
- **Subscreens:**
  - PIN gate (Step, `app/hidden-chats.tsx:50-140`) — **5.5/10** — server `verifyPin` (`lib/chatService.ts:2617-2623`), format validation (`:70-73`), resilient IME focus (`:66`). The attempt counter is component state and resets on re-entry (`:57`, `:82-93`).
  - Hidden list (Step, `app/hidden-chats.tsx:142-259`) — **5.5/10** — refresh and error states (`:151-169`, `:207`). It does not filter `c.hidden` (`:153-154`) and has no AuroraBackground (`:195`, `:199`).
- **Strengths:**
  - The PIN is verified server-side, not compared locally (`app/hidden-chats.tsx:77`).
  - Unhide is confirmed (`:175-191`).
  - The app-wide FLAG_SECURE covers this screen (`app/_layout.tsx:242`).
- **To reach 10/10:**
  1. Filter `list.filter(c => c.hidden)` client-side (`app/hidden-chats.tsx:153-154`; `hidden` exists on `ChatSummary`). Whether the server returns only hidden rows is not verifiable statically.
  2. Re-lock to the PIN stage on AppState background (`:42-47`). Today the list stays open after the app is backgrounded.
  3. Rely on server-side rate limiting for PIN attempts (not verifiable here), or persist the client counter. Leaving and re-entering resets it (`:57`).
  4. Add an `accessibilityLabel` to the PIN input (`:108`). Add roles on Cancel/Unlock/back (`:126`, `:129`, `:201`). Add an unhide `accessibilityAction`, since long-press is the only path (`:231`).
  5. Replace `'#22C55E'`/`'#fff'` (`:135`, `:277`, `:289`, `:291`) with tokens. Remove the unused `colors`/`S` (`:39-40`).
  6. The empty-state copy "⋮ menu → 🕶️ Hide chat" (`:213`) should match the real label "Hide chat" (`app/chat.tsx:2064`) without the emoji.

### `app/app-lock-chats.tsx` — Per-chat lock settings — **3.5/10**
- **Route:** `/app-lock-chats` · **Entry points:** **UNWIRED**. I grepped `app-lock-chats`, `lock-chats` and "Per-Chat Lock" across app/components/lib/hooks/services/constants. The only hits are the Stack registration (`app/_layout.tsx:1000`) and selftests. It is also the *only* caller of `setChatLock` (`app/app-lock-chats.tsx:168`), so users cannot create a chat lock from the UI, even though `app/chat.tsx:3219-3251` enforces locks.
- **Purpose:** Toggles a biometric/PIN lock per chat and sets its auto-lock timer.
- **Scores:** Function 1 · States 4 · UI 4 · A11y 3 · Security 5 · Code 4
- **Subscreens:**
  - Lock config panel (Overlay, `app/app-lock-chats.tsx:175-264`) — **4/10** — offers only factors the device can produce (`:190-198`). The PIN is not confirmed by a second entry (`:213-222`), and a typo makes the lock unremovable without that PIN. It is not a `Modal` (no back handling or keyboard avoidance).
  - Remove-lock PIN prompt (Overlay, `app/app-lock-chats.tsx:363-395`) — **3/10** — enforces the lock's own factors (`:139-151`). But the "Remove lock" text is `#FFF` (`:542`) on a `confirmBtn` with no background (`:535`), so it is invisible on the light `c.glass` panel. There is no attempt limit (`:89-92`).
- **Strengths:**
  - Removing a lock requires that lock's own factors (`app/app-lock-chats.tsx:122-153`). Enforced by `lib/chatLockFactors.selftest.ts`, which passes.
  - An unreadable lock table shows an explicit error instead of an empty list (`:105-109`, `:344-348`).
- **To reach 10/10:**
  1. Wire it in: add a Settings row and a chat-menu "Lock chat" action near `app/chat.tsx:2064`.
  2. Fix the invisible "Remove lock" label. Give `confirmBtn` a background, or reuse the gradient (`app/app-lock-chats.tsx:389-391`, `:535`, `:542`).
  3. Require PIN confirmation, digits-only input (`:216`), and an attempt limit on `submitUnlockPin` (`:89-92`).
  4. Wrap `setChatLock`/`removeChatLock` in try/catch with an alert (`:152-153`, `:168`). Add a loading state; today the screen shows "No chats yet" while `listChats` is pending and swallows its failure (`:110-113`, `:355`).
  5. Every unlocked row reads "No messages" because `lastMessage` is never populated (`:112`, `:284`). Populate it or drop the line.
  6. Convert the overlays to `<Modal>` with `KeyboardSafe`. Label the `Switch` with the chat name (`:302-307`). Give chips `accessibilityRole="radio"` and state (`:199-206`, `:229-235`).
  7. Replace `'#2B7FE0'`, `'#F59E0B'`, `'#9CA3AF'`, `'#FFF'` and `rgba(0,0,0,0.7)` (`:251`, `:256`, `:276`, `:306`, `:479`). Delete the orphaned StatusBar comment (`:32-39`).
  8. Security (lib): `hashPin` uses a fixed prefix plus a single SHA-256 (`lib/chatLock.ts:29-30`) stored in AsyncStorage (`lib/chatLock.ts:15`). A 4–8 digit PIN can be brute-forced offline. Use a per-lock random salt and a slow KDF.

### `app/import-chats.tsx` — Exit Kit (WhatsApp import) — **6.5/10**
- **Route:** `/import-chats` · **Entry points:** `app/settings.tsx:422`, `app/onboard-success.tsx:146`, `app/chat.tsx:2107-2113` (chat menu "Exit Kit", 1:1 only).
- **Purpose:** On-device import of one WhatsApp export into one direct chat, with contact verification, date-order disambiguation, media copy and resumable writes.
- **Scores:** Function 8 · States 7 · UI 7 · A11y 5 · Security 7 · Code 6
- **Subscreens:**
  - Pick chat (Step, `app/import-chats.tsx:574-611`) — **7/10** — single selection, loading and empty states. Rows have no `accessibilityRole` (`:599`).
  - Pick source (Step, `:373-416`) — **7/10** — not-ready sources are disabled with "Coming next" (`:396-412`). Disabled rows have no `accessibilityState`.
  - Pick file (Step, `:418-431`) — **8/10** — clear steps, shared `Button`s.
  - Reading/matching (Step, `:433-439`) — **6/10** — has no Cancel, unlike importing (`:470`).
  - Preview / confirm (Step, `Preview` `:613-708`) — **7/10** — two hard gates: unverified-contact ack and ambiguous dates (`:627-630`). The ack checkbox has no `accessibilityRole="checkbox"` or state (`:659-668`), and the date pills have no selected state (`:682`).
  - Importing (Step, `:455-472`) — **6.5/10** — progress bar and cancel. The progress bar has no a11y value.
  - Done (Step, `Done` `:710-740`) — **6.5/10** — the imported count can be wrong on error or cancel (see fix 2).
  - Failed (Step, `:482-492`) — **8/10** — specific failure copy per reason (`:73-88`).
- **Strengths:**
  - Single-target design with no network code. The contact is verified by phone, then name, else explicit ack (`app/import-chats.tsx:509-532`, `:627-630`).
  - Streaming positional reads, so the archive is never fully resident (`:187-191`). Cancel is propagated to extraction and DB writes (`:267`, `:305`), and unmount cancels (`:129`).
  - Resume/partial state is persisted, and dedupe keys make retries idempotent (`:240-242`, `:276`, `:309-312`).
- **To reach 10/10:**
  1. If `getChat` fails, the error is swallowed (`app/import-chats.tsx:143`) and `runImport` silently returns because `chat` is null (`:228`). The Import button then does nothing. Surface an error with retry.
  2. `progress.done` is read from the `useCallback` closure (`:332`, `:342`; deps `:336`, `:345`), so the error and cancel outcome reports the value from when the callback was created, not the live count. Use a ref.
  3. Add a Cancel during `reading`/`matching` (`:433-439`) that sets `cancelRef`.
  4. Add a11y roles and states: ack checkbox (`:659`), date pills (`:682`), source and contact rows (`:394`, `:599`), progress `accessibilityValue` (`:462`).
  5. Imported media is written as plaintext under `APP_DOCS/VaultChat/Imported` (`:256-266`). Note or seal it in line with the cache-encryption plan (`constants/flags.ts:95`).
  6. Replace the `rgba(...)` literals and `'#fff'` (`:661`, `:807-831`) with tokens. Type `s` props instead of `any` (`:547-621`). Consider splitting the 833-line file by step.

### `app/chat-backup.tsx` — Chat backup — **6/10**
- **Route:** `/chat-backup` · **Entry points:** `app/settings.tsx:418`, `app/(tabs)/chats.tsx:295` (restore prompt).
- **Purpose:** Manual backup to account, device and Drive; restore; auto-backup frequency and network; Google connect; link to E2EE settings.
- **Scores:** Function 6 · States 5 · UI 7 · A11y 4 · Security 7 · Code 6
- **Subscreens:**
  - Backup secret modal (Modal, `app/chat-backup.tsx:305-344`) — **6/10** — shown when an E2EE blob needs a secret. It is wrapped in `KeyboardSafe` and the copy is honest. The input has no `accessibilityLabel` (`:317`), and the UNLOCK/Cancel touchables have no roles (`:330-339`).
  - Restore confirm (Alert, `app/chat-backup.tsx:175-184`) — **7/10** — confirms before restore.
- **Strengths:**
  - Backup reports only what actually succeeded. The account copy goes first, and only real backups reset the timer (`app/chat-backup.tsx:95-126`).
  - Restore order and the "secret required" short-circuit are well reasoned (`:135-159`).
  - The network setting is honoured by the scheduler (`lib/backupScheduler.ts:121-122`).
- **To reach 10/10:**
  1. **The "Include videos" switch is dead.** `includeVideos` is never read outside its type and default (`lib/backupScheduler.ts:34`, `:60`; grep shows no consumer), and the bundle contains no media (`lib/cloudBackup.ts:1-10`). Remove it or implement it (`app/chat-backup.tsx:282-292`).
  2. While settings load, the screen renders a blank view with no back button (`:186`), and a `getBackupSettings` rejection is unhandled (`:66`, `:84`). Render the header and a spinner, and catch the error.
  3. Refresh `mode` on focus. Returning from `/backup-e2ee` (`:247`) leaves the "Off/On" row stale, because `refresh` runs only on mount (`:84`).
  4. Catch `saveBackupSettings` failures in `patch` and roll back (`:86-90`).
  5. Radio rows need `accessibilityRole="radio"` and `checked` (`:239`, `:276`). Add a label on the `Switch` (`:286`) and a role on Restore (`:229`).
  6. "Restart the app to see them" (`:157`). Trigger an in-app reload of the chat list instead.

### `app/backup-e2ee.tsx` — End-to-end encrypted backup — **6/10**
- **Route:** `/backup-e2ee` · **Entry points:** `app/chat-backup.tsx:247`.
- **Purpose:** Switches the backup key from account-managed to a user password or a generated 64-digit key, or back.
- **Scores:** Function 7 · States 6 · UI 6 · A11y 4 · Security 5 · Code 7
- **Subscreens:**
  - Loading (Step, `app/backup-e2ee.tsx:115-118`) — **4/10** — header only, no spinner.
  - Off (Step, `:224-254`) — **7/10** — states the trade-off plainly (`:231-241`).
  - Create password (Step, `:160-194`) — **6.5/10** — `passwordProblem` and match check (`:52-54`), busy-disabled. The inputs have no `accessibilityLabel` (`:171-180`).
  - Key shown once (Step, `:122-158`) — **4/10** — the header back (`:108`) exits with no confirmation after E2EE has already been switched on (`:81-82`), losing the only copy of the key. The copy uses raw `Clipboard` (`:137`).
  - On (Step, `:196-222`) — **7/10** — confirmed turn-off (`:89-104`).
- **Strengths:**
  - Every enable/disable path is confirmed with explicit no-recovery copy (`app/backup-e2ee.tsx:55-58`, `:73-76`, `:89-92`).
  - Busy guards prevent competing uploads (`:48-50`, `:183-184`, `:215`).
  - Password strength is checked by a shared helper (`:52-53`, `lib/backupCrypto`).
- **To reach 10/10:**
  1. In the `keyshown` stage, guard the header back and Android back with the same "Saved it?" confirmation (`app/backup-e2ee.tsx:106-113`, `:143-152`).
  2. Copy the recovery key with `copyAndAutoClear` (`lib/clipboardSafe.ts:7-8`, `:46`) instead of `Clipboard.setStringAsync` (`:137`).
  3. When `getBackupMode` fails, show an error and retry, not the "off" stage (`:42-43`). Today a user whose backup is already E2EE could be told it is off.
  4. Ask the user to re-type the key (or part of it) before leaving `keyshown` (`:143-152`).
  5. Add AuroraBackground to every stage, not just loading (`:117` vs `:124-125`, `:162`, `:198`, `:226`). Add a spinner to loading. Add `accessibilityLabel`s on the inputs and roles on the buttons (`:171-189`, `:215`, `:243-251`).
  6. Offer "change password / switch to key" without a round-trip through account mode. Today `turnOff` (`:89-104`) re-uploads a server-readable backup first.


---

## D — Groups & Communities

| Screen | Route | Wired? | Score |
|---|---|---|---|
| `app/group-admin.tsx` | `/group-admin` | Yes (group-info) | 5.5 |
| `app/group-calendar.tsx` | `/group-calendar` | Yes (family only) | 6.0 |
| `app/group-chat.tsx` | `/group-chat` | **UNWIRED** (legacy redirect) | 4.0 |
| `app/group-create.tsx` | `/group-create` | Yes (family / family-setup) | 7.0 |
| `app/group-info.tsx` | `/group-info` | Yes (chat, chats tab, contact-info) | 6.0 |
| `app/group-insights.tsx` | `/group-insights` | Yes (family only) | 6.5 |
| `app/group-invitations.tsx` | `/group-invitations` | Yes (chats tab, family, push) | 7.0 |
| `app/group-invites.tsx` | `/group-invites` | Yes (group-create, family, group-members) | 7.0 |
| `app/group-join.tsx` | `/group-join` | Yes (group card bubble) | 7.0 |
| `app/group-members.tsx` | `/group-members` | Yes (family, spaces layout) | 7.0 |
| `app/group-notes.tsx` | `/group-notes` | Yes (family only) | 6.0 |
| `app/group-privacy.tsx` | `/group-privacy` | Yes (family, group-invitations) | 6.5 |
| `app/group-tasks.tsx` | `/group-tasks` | Yes (family only) | 6.5 |
| `app/group-trip.tsx` | `/group-trip` | Yes (family only) | 6.5 |
| `app/group-calls.tsx` | `/group-calls` | Yes (chat, group-info, calls tab) | 5.5 |
| `app/create-group.tsx` | `/create-group` | Yes (new-chat) | 6.0 |
| `app/communities.tsx` | `/communities` | Yes (new-chat, dashboard, notifications) | 5.5 |
| `app/creator-channels.tsx` | `/creator-channels` | **UNWIRED** (redirect to /broadcast) | 3.5 |

Method: every screen file read in full; entry points from a grep across `app/ components/ lib/ hooks/ services/` for `'/route'`, `pathname: '/route'` and `route: '/route'` forms, plus `app/_layout.tsx`. Selftests run, all passing: `lib/a11yCoverage.selftest.ts` (0 unlabelled icon-only buttons), `lib/themeCoverage.selftest.ts`, `lib/screenBackCoverage.selftest.ts`, `lib/orphanRoutes.selftest.ts`, `lib/groupRefRouting.selftest.ts`. Note that the a11y selftest checks only icon-only buttons (`lib/a11yCoverage.selftest.ts:7-12`). It does not check role/state on text touchables, switches or radios, which is where most a11y gaps below are.

---

### Cross-screen duplication and overlap (evidence)

1. **`create-group` vs `group-create`: two group-creation flows with different consent models.**
   - `app/create-group.tsx:96` calls `createGroupChat(name, { ids })`. It **adds** direct-chat peers straight into an untyped group and lands on `/chat` (`:97`). It is reached from `app/new-chat.tsx:160`.
   - `app/group-create.tsx:57-70` calls `createGroupChat(n, { allowEmpty: true }, { groupType, privacy, icon, color })`. It creates the group solo, saves it to the local registry (`:71-75`) and continues to `/group-invites` (`:77`), where people get an **invitation** they must accept. It is reached from `app/family-setup.tsx:70` and `app/family.tsx:1482,2232`.
   - The project's own rationale says adding people without consent is wrong (`app/family-add.tsx:9-15`, `app/group-info.tsx:254-260`). `create-group` still does it.
2. **`group-invites` vs `group-invitations`: complementary, not duplicates.** `group-invites` is the admin side (`/chats/:id/invitations`, `lib/chatService.ts:2354-2384`). `group-invitations` is the invitee side (`/invitations`, `lib/chatService.ts:2388-2404`). There is real overlap elsewhere, though:
   - `group-invites` and `app/family-add.tsx` both send `createInvitation`: `app/group-invites.tsx:124` and `app/family-add.tsx:121`. `group-info` "Add member" goes to `/family-add` (`app/group-info.tsx:263-266`), while `group-members` "Add people" goes to `/group-invites` (`app/group-members.tsx:268`).
   - Policy contradiction: `app/group-invites.tsx:4-7` and `:352-353` say there is "no link or code to share", and `app/group-join.tsx:8-11` calls a link a credential. But `app/group-info.tsx:468-479` routes admins to `/invite-link`, which creates shareable links and a QR code (`app/invite-link.tsx:1-5,13`), redeemed by `joinViaInvite` (`lib/chatService.ts:2175-2179`).
3. **`group-admin` vs `group-members`: role and remove logic duplicated, with different gating.**
   - Both change roles and remove members: `app/group-admin.tsx:195-227` and `app/group-members.tsx:122-138`.
   - `group-admin` lets any admin act on any non-owner (`app/group-admin.tsx:371`), even though its header says promote/demote is "owner-gated" (`:7`).
   - `group-members` uses the server-mirrored rank check (`app/group-members.tsx:209-212`, mirror noted at `:19-20`).
   - **Two approval systems:**
     - `group-admin`: the `approveMembers` toggle plus `/join-requests` (`app/group-admin.tsx:164-183`; `lib/chatService.ts:2520-2527`).
     - `group-members` / `group-invites`: `approvalMode` plus `/membership/pending` (`app/group-members.tsx:177-190`; `app/group-invites.tsx:83-89`; `lib/chatService.ts:2420-2431`).
   - A third member list sits in `app/group-info.tsx:483-516`.
4. **Two parallel group hubs.** Calendar, notes, tasks, insights, trip, privacy and members are reachable **only** from the Family Space manage sheet (`app/family.tsx:2223-2284`). The chat-group hub `group-info` reaches only admin, calls, media, invite-link and family-add (`app/group-info.tsx:394,410,459,471,264`). A plain chat group therefore has no path to shared calendar, notes or tasks.
5. **`group-notes` vs `group-tasks`: near-identical code.** Both have a rebuild/publish/replay fold (`app/group-notes.tsx:54-104` vs `app/group-tasks.tsx:66-124`), including the same un-verified `op.by` handling (see their entries).
6. **Redirect shims:** `group-chat` → `/chat` (`app/group-chat.tsx:27-29`) and `creator-channels` → `/broadcast` (`app/creator-channels.tsx:15`). Both are still listed in `INSET_SCREENS` (`app/_layout.tsx:209,213`).

---

### `app/group-admin.tsx` — Group Admin Controls — **5.5/10**
- **Route:** `/group-admin` · **Entry points:** `app/group-info.tsx:459` (admin-only section, `:453`); registered at `app/_layout.tsx:998`.
- **Purpose:** Admin console for a chat group: rename, send/media/add policies, slow mode, approval and anti-spam toggles, join requests, member role/remove (`app/group-admin.tsx:116-227`).
- **Scores:** Function 7 · States 5 · UI 6 · A11y 4 · Security 6 · Code 5
- **Subscreens:**
  - Role menu (inline Overlay, `app/group-admin.tsx:391-408`) — **5/10** — calls the real `setMemberRole` (`:201`), but options have no `accessibilityRole`/`State` and the gate ignores rank (`:371`). Fix: reuse `canManageRole` from `lib/groups/permissions` as `group-members.tsx:210` does.
  - Remove-member confirm (Alert, `:211-226`) — **7/10** — destructive style, optimistic update with rollback (`:215-223`). Fix: none beyond the shared gating issue.
- **Strengths:**
  - Every control calls a real PATCH, with optimistic update and rollback on failure (`:132-171`, `lib/chatService.ts:2004-2017`).
  - Destructive remove is confirmed (`:211`).
  - `HEADER_TOP` used for the inset (`:426`), enforced by `lib/responsiveCoverage.selftest.ts:166`.
- **To reach 10/10:**
  1. Replace `canManage = isAdmin && role !== 'owner' && !isMe` (`:371`) with the mirrored `canManageRole`/`canRemoveMember` checks (`app/group-members.tsx:209-211`), or retire this screen's member section in favour of `/group-members`.
  2. Reconcile the two approval systems. `approveMembers` + `listJoinRequests` (`:164-183`) duplicate `approvalMode` + `pendingMembers` (`app/group-members.tsx:177-190`, `app/group-invites.tsx:83-89`).
  3. On load failure (`:105-107`) the screen shows "No members." (`:363-365`) and keeps role 'member', with no retry. Add an error state and retry.
  4. Accessibility:
     - Add `accessibilityRole="radio"`/`accessibilityState={{selected}}` to the policy and slow-mode chips (`:188, :291-299, :306-312`).
     - Add `accessibilityLabel` to both Switches (`:326, :335`).
     - Un-nest the remove button from the row touchable (`:374-389`).
  5. Move `PolicyToggle` out of the render body (`:185-193`); it is re-created every render and remounts its children. Use it for "Who can send" too, instead of the inline copy (`:289-301`).
  6. Clear the banner `setTimeout` on unmount (`:86`).
  7. Fix the stale header comment, which says slow mode and moderation are "intentionally omitted" (`:10-13`) when they are implemented at `:303-337`.
  8. Render `<AuroraBackground />` in the main view; only the loading view has it (`:232` vs `:242`).
  9. Replace `'#888'` (`:327, :336`) with a token.

### `app/group-calendar.tsx` — Shared Calendar — **6.0/10**
- **Route:** `/group-calendar` · **Entry points:** `app/family.tsx:2240` (Family Space manage sheet only).
- **Purpose:** Month view of end-to-end encrypted group events: fetch month buckets, decrypt, expand recurrences, add or delete (`:78-179`).
- **Scores:** Function 6 · States 5 · UI 7 · A11y 4 · Security 7 · Code 7
- **Subscreens:**
  - New-event sheet (Modal, `:260-327`) — **6/10** — real encrypt + `createGroupEvent` (`:146-151`), `KeyboardSafe` (`:266`), busy guard (`:132`). But scheduling is limited to 3 day presets × 9 fixed hours (`:42-48`), and the chips have no `accessibilityState`. Fix: a real date/time picker and selected state on the chips.
- **Strengths:**
  - Events are sealed with the group's chat encryption; the server only sees a month bucket (`:144-151`).
  - Destructive delete is confirmed, with repeat-aware copy (`:166-178`).
  - Theme tokens throughout; native header with a back control (`:189`).
- **To reach 10/10:**
  1. Reminders are never scheduled. Events are saved with `remindMin: 30` (`:142`), but `reminderAt` (`lib/groups/calendar.ts:179`) has no caller outside its self-check. Wire it to local notifications, as `syncTaskReminders` does for tasks (`app/group-tasks.tsx:87`).
  2. Add an error state. A first-load failure is swallowed (`:99-101`) and shows "Nothing this month" (`:210-217`), and decrypt failures are dropped silently (`:86`).
  3. Guard against stale responses when switching months quickly. `load` (`:78-102`) has no sequence/live check, so an older month's rows can overwrite the current one.
  4. Delete is long-press only (`:226`). Add `accessibilityActions` and a visible delete affordance, plus `accessibilityRole`/`Label` on event rows (`:224-229`).
  5. Tapping "Add to calendar" while `me` is unresolved silently does nothing (`:132`). Disable the button or show feedback.
  6. Add an edit flow; events can only be created or deleted (`:130-179`).
  7. Delete is offered to any member for any event (no `createdBy` check, `:162-178`). Whether the server restricts it is not verifiable statically.

### `app/group-chat.tsx` — Legacy Group Chat Redirect — **4.0/10**
- **Route:** `/group-chat` · **Entry points:** **UNWIRED**. The grep for `/group-chat` finds only `lib/orphanRoutes.selftest.ts:146`, which asserts it has no callers. There is no deep-link handling for it.
- **Purpose:** Forwards to `/chat` with the id, or goes back (`:27-30`).
- **Scores:** Function 1 · States 4 · UI 6 · A11y 4 · Security 6 · Code 3
- **Subscreens:** None
- **Strengths:**
  - Uses theme tokens for the spinner and background (`:35, :41`).
  - Handles a missing id by going back (`:29`).
- **To reach 10/10:**
  1. Delete the file and its `INSET_SCREENS` entry (`app/_layout.tsx:213`). `lib/orphanRoutes.selftest.ts:133-137` already says deleting it is an improvement.
  2. If it is kept, add `params.groupName` and `router` to the effect deps (`:30`) and give the spinner an `accessibilityLabel` (`:35`).

### `app/group-create.tsx` — New Typed Group — **7.0/10**
- **Route:** `/group-create` · **Entry points:** `app/family-setup.tsx:70`; `app/family.tsx:1482, 2232`; `router.replace` when there are no circles at `app/family.tsx:286, 566, 1135`.
- **Purpose:** Create a typed group (type, name, description, colour, icon, join privacy) and continue to invitations (`:51-81`).
- **Scores:** Function 8 · States 7 · UI 8 · A11y 5 · Security 7 · Code 7
- **Subscreens:**
  - Type grid / colour / icon / privacy pickers (inline Step, `:100-175`) — **6.5/10** — real state feeding the create call. The type cells and privacy rows have no role/state, and colour swatches announce hex codes (`:141`). Fix: radio roles, selected state, and named colours.
- **Strengths:**
  - Server is the source of truth for caps and type defaults; overrides are sent only when picked (`:65-68`).
  - Double-submit guard, name validation and error alert (`:53-54, :78-80`).
  - `KeyboardSafe` plus `minHeight` for font scaling (`:84, :195-198`).
- **To reach 10/10:**
  1. Accessibility:
     - Add `accessibilityRole="radio"` + `accessibilityState={{selected}}` to type cells (`:105-114`), privacy rows (`:165-173`) and swatches/icons (`:141, :151`).
     - Swatch labels read "Colour #9D6FD0" (`:141`). Use colour names.
  2. Consolidate with `app/create-group.tsx` (see Duplication §1) so "New group" from `/new-chat` uses this consent-based flow.
  3. Remove the unused `Platform` import (`:16`).
  4. `saveGroup`/`setActiveGroupId` failures are swallowed (`lib/groups/store.ts:144, :218`). Surface or retry them, so the local registry cannot silently miss the new group.

### `app/group-info.tsx` — Group Info — **6.0/10**
- **Route:** `/group-info` · **Entry points:** `app/chat.tsx:2099, 3333`; `app/(tabs)/chats.tsx:796`; `app/contact-info.tsx:340`; registered at `app/_layout.tsx:1015`.
- **Purpose:** Chat-group hub: photo, name, description, call, media, viewing-status privacy, admin links, member list, remove, leave (`:163-267`).
- **Scores:** Function 8 · States 5 · UI 6 · A11y 4 · Security 7 · Code 5
- **Subscreens:**
  - Inline rename editor (`:328-343`) — **6/10** — real `updateChat` (`:168`), but Save has no busy guard and no label. Fix: `saving` state plus a disabled Save.
  - Inline description editor (`:354-367`) — **6/10** — same pattern (`:177-185`), same missing guard.
  - Leave confirm (Alert, `:240-251`) — **7/10** — destructive, then replaces to the chats tab.
  - Remove confirm (Alert, `:217-235`) — **7/10** — confirmed, cache patched.
- **Strengths:**
  - Local-first cache paint and refresh, keeping the cache on error (`:101-128`).
  - Explicit no-id state with a way out (`:274-289`).
  - Photo permission handled via `permissionDenied` (`:189-192`).
  - Confirmations on remove and leave (`:217, :240`).
- **To reach 10/10:**
  1. Load failure with no cache traps the user. It alerts (`:125`), then hits `loading || !chat` and spins forever with no header or back control (`:291-292`). Render an error state with Retry and Back.
  2. Add busy/double-submit guards to rename and description Save (`:340, :366`).
  3. Add keyboard handling (`KeyboardSafe`, as siblings do), because the multiline description sits inside a plain ScrollView (`:302, :356-365`).
  4. Accessibility:
     - Label the photo touchable (`:311`) and the rename tap target (`:345`).
     - Label the "Share my viewing status" Switch (`:444`).
     - Give nav rows `accessibilityRole="button"` (`:391, :407, :456, :468`).
  5. The member list is a `FlatList` with `scrollEnabled={false}` inside a ScrollView (`:502-504`), so there is no virtualization for large groups.
  6. Use `AppText` instead of raw RN `Text` (`:27`), as siblings do. Add `<AuroraBackground />` to the main view (`:302`). Replace `'#22C55E'` with `c.online` (`:629`).
  7. Remove the dead styles `backTxt` and `navChevron` (`:588, :615`), and add `patchChat` to the `useCallback` deps (`:175, :185, :213, :236`).

### `app/group-insights.tsx` — Group Insights — **6.5/10**
- **Route:** `/group-insights` · **Entry points:** `app/family.tsx:2267` (Family Space only).
- **Purpose:** Computes per-member distance, arrivals, check-ins and trip history on-device for a week or month (`:74-141`).
- **Scores:** Function 7 · States 6 · UI 7 · A11y 5 · Security 8 · Code 6
- **Subscreens:**
  - Week/Month tabs (Tab, `:163-189`) — **6/10** — re-tap freeze fixed (`:179`), but no `accessibilityRole="tab"`/`State`. Fix: add them.
- **Strengths:**
  - Withholds the load, not just the render, when the viewer lacks `view_history` (`:92-103, :111-114`).
  - Explicit Retry when identity is unknown, with an accessible label (`:221-230`).
  - Honest copy about estimates and locality (`:300-306`).
- **To reach 10/10:**
  1. Wrap the effect body (`:76-139`) in `try/finally { setLoading(false) }`. A rejection from `getTrack` (`:100`, via `loadCache` at `lib/family/history.ts:147`) or `circleMembers` leaves the spinner up permanently.
  2. Add tab roles/state (`:167-186`).
  3. Compute `frequentDestinations(trips, 3)` once with `useMemo`; it is called twice per render (`:274, :276`).
  4. The footer says nothing is fetched (`:3-4`, `:303-305`), but the screen calls `getMessages(groupId, {limit: 300})` (`:121`). Reword it to "nothing is uploaded".
  5. `AVATAR_COLORS` is a hard-coded palette (`:38`). Move it to theme tokens.

### `app/group-invitations.tsx` — My Invitations — **7.0/10**
- **Route:** `/group-invitations` · **Entry points:** `app/(tabs)/chats.tsx:638`; `app/family.tsx:2229`; membership push tap at `app/_layout.tsx:815`.
- **Purpose:** The invitee's inbox to accept, decline or withdraw group invitations and requests (`:61-104`).
- **Scores:** Function 8 · States 7 · UI 8 · A11y 5 · Security 8 · Code 7
- **Subscreens:**
  - Decline/withdraw confirm (Alert, `:89-103`) — **7/10** — status-aware copy, busy indicator.
  - "Waiting for approval" notice (Alert, `:77-80`) — **7/10** — honest outcome messaging.
- **Strengths:**
  - Accept routes straight to the space with the privacy sheet on top (`:67-75`).
  - Per-card busy state and a re-entrancy guard on accept (`:62-63, :148-149`).
  - Pull-to-refresh (`:196-199`) and a clear empty state (`:201-211`).
- **To reach 10/10:**
  1. Load errors are swallowed (`:55`), so a first-load failure renders "No invitations" (`:201-211`). Track an error and show Retry.
  2. Decline lacks the `if (acting) return` guard that accept has (`:62` vs `:96-97`).
  3. Accessibility: give Accept/Decline `accessibilityRole="button"` (`:153, :169`). Expose the "Waiting" pseudo-button (`:163-166`) as text with `accessibilityRole="text"`, or merge it into the card label.
  4. Use a FlatList for long lists (`:213`).

### `app/group-invites.tsx` — Add People / Sent Invitations — **7.0/10**
- **Route:** `/group-invites` · **Entry points:** `app/group-create.tsx:77`; `app/family.tsx:2223` (only when `canInvite`); `app/group-members.tsx:268`.
- **Purpose:** Admin side: search candidates and invite, approve or turn down pending members, resend or withdraw sent invitations (`:79-182`).
- **Scores:** Function 8 · States 7 · UI 7 · A11y 6 · Security 7 · Code 7
- **Subscreens:**
  - Turn-down confirm (Alert, `:143-155`) — **7/10**.
  - Withdraw/revoke confirm (Alert, `:168-181`) — **7/10** — distinguishes cancel from revoke (`:175-176`).
- **Strengths:**
  - Debounced search with a sequence guard against stale responses (`:94-114`).
  - `Promise.allSettled` so one failing half doesn't blank the other (`:83-89`).
  - Icon-only buttons are labelled (`:226, :306, :339, :342`).
- **To reach 10/10:**
  1. Search errors are rendered as "Nobody found… need a crazzychat account" (`:107-108`, `:237-245`). Distinguish a network error from no results.
  2. Avatars use the raw `photoURL` (`:194`), whereas `app/group-info.tsx:547-549` wraps `ChatMember.photoURL` in `attachmentUrl()` with an Authorization header. These avatars probably don't render; needs device verification.
  3. Resolve the policy conflict with `/invite-link` (Duplication §2): the footer (`:352-353`) is contradicted by `app/group-info.tsx:471`.
  4. Add a busy guard to resend (`:158-161`). Refresh failures are silent (`:87-88`).
  5. Give the Invite/Approve pills `accessibilityRole="button"` (`:259, :301`).

### `app/group-join.tsx` — Ask to Join — **7.0/10**
- **Route:** `/group-join` · **Entry points:** `components/chat/MessageBubble.tsx:390` (group card bubble), guarded by `lib/groupRefRouting.selftest.ts`.
- **Purpose:** Sends a join request for a group shared as a card (`:68-81`).
- **Scores:** Function 7 · States 6 · UI 8 · A11y 5 · Security 8 · Code 8
- **Subscreens:** None
- **Strengths:**
  - Checks for an existing request on focus, with a live guard (`:50-66`).
  - State machine prevents double submit (`:69`).
  - Honest "ask, not join" copy (`:118-121, :142-143`).
- **To reach 10/10:**
  1. Any invitation row for this chat sets `'asked'` (`:56`), so a user who was **invited** sees "Your request is with the admins" (`:112-113`). Branch on `i.requested` and link to `/group-invitations` for real invitations.
  2. Duplicate and member detection depends on regex-matching server error text (`:76-77`). Use status codes or structured errors.
  3. Guard a missing `groupId` (`:37`); it currently posts to `/chats//membership/request` (`lib/chatService.ts:2446`).
  4. Name, icon and colour come only from route params (`:34-45`). Validate the icon against `Ionicons.glyphMap` and the colour as hex before using them.
  5. Give "Ask to join" and "Done" `accessibilityRole="button"` (`:122, :133`).

### `app/group-members.tsx` — Members & Roles — **7.0/10**
- **Route:** `/group-members` · **Entry points:** `app/family.tsx:1526, 2226`; section data `lib/spaces/layout.ts:97, 139`.
- **Purpose:** Typed-group member list with rank-gated role change, remove, ownership transfer, join-mode selection and group-card sharing (`:115-190`).
- **Scores:** Function 8 · States 6 · UI 7 · A11y 5 · Security 8 · Code 7
- **Subscreens:**
  - Member actions sheet (Modal, `:360-432`) — **7/10** — options filtered by `canManageRole` (`:366`); confirmations for remove and transfer (`:128, :141`). Options lack role/selected state.
  - Share picker (Modal, `:325-357`) — **5.5/10** — no loading state, so "No other chats to share into yet." shows while `listChats` runs (`:156-159, :336-340`), and errors become an empty list (`:159`). Fix: loading/error states and a FlatList.
  - Join-mode radio list (inline, `:277-319`) — **6.5/10** — confirm before change (`:184-189`), but no radio role/state.
- **Strengths:**
  - Two-gate permission and rank model mirrored from the server (`:8-20, :209-212`).
  - The permission set starts empty and only widens from the server (`:88-91`).
  - Every destructive or policy action is confirmed (`:128, :141, :163, :184`).
- **To reach 10/10:**
  1. Load failure only alerts (`:96-97`) and leaves an empty list with no retry. Add an error state.
  2. Avatars use the raw `m.photoURL` (`:194`), unlike `app/group-info.tsx:547-549` (`attachmentUrl` + auth header). These probably don't render; needs device verification.
  3. Accessibility:
     - Give member rows `accessibilityLabel` and a hint naming the actions (`:216-221`).
     - Give mode rows `accessibilityRole="radio"` + state (`:283`).
     - Give sheet options state (`:385`).
  4. Fix the share picker's loading/error states (above).
  5. Replace the IIFE inside JSX (`:364-429`) with a component. Move `ROLE_TONE` and `'#F59E0B'` to tokens (`:51, :403`).
  6. Merge with the member management in `app/group-admin.tsx` (Duplication §3).

### `app/group-notes.tsx` — Shared Notes — **6.0/10**
- **Route:** `/group-notes` · **Entry points:** `app/family.tsx:2278` (Family Space only).
- **Purpose:** End-to-end encrypted shared notes, stored as op messages in the group thread and folded locally (`:54-139`).
- **Scores:** Function 7 · States 6 · UI 7 · A11y 5 · Security 5 · Code 6
- **Subscreens:**
  - Note editor (Modal, `:192-233`) — **6/10** — `KeyboardSafe`, field-level diffs (`:114-121`). On a send failure the sheet still closes (`:125`) after "Not saved" (`:101`), and the draft is lost on the next open (`:106`). Fix: keep the sheet open on failure.
- **Strengths:**
  - Field-level merge so concurrent edits don't clobber each other (`:115-121`).
  - Delete is confirmed (`:135`). Pin and delete icons are labelled (`:175, :206`).
  - Offline keeps the current list (`:69-71`).
- **To reach 10/10:**
  1. Ops are trusted without checking the sender. `decodeNoteOp(body)` is used (`:64-66`) without comparing `op.by` to `m.senderId`, so any member can forge attribution. The fold accepts any `del` (`lib/groups/notes.ts:84`). Reject ops where `op.by !== m.senderId`.
  2. Ops are sent as plain text messages (`:99`). The chat timeline filters only the `VCTRIP1:`/`VCTRIPEND1:` prefixes (`app/chat.tsx:333-334`), and no `VCNOTE1:` filter was found anywhere. Raw note ops probably appear as bubbles in the group chat; needs device verification.
  3. Notes come from the last 400 server messages unioned with local history (`:31, :58-59`). A busy group pushes notes out of reach for new devices and new members.
  4. Keep the editor open when publish fails (`:121-125`). Disable Save while `me` is null instead of silently returning (`:111`).
  5. Give note cards `accessibilityRole="button"` + label (`:169`). Extract the rebuild/publish fold shared with `group-tasks` (Duplication §5).

### `app/group-privacy.tsx` — What This Group Can See — **6.5/10**
- **Route:** `/group-privacy` · **Entry points:** `app/family.tsx:2284`; `app/group-invitations.tsx:75` (after joining).
- **Purpose:** Per-group location precision, battery/speed hiding, invisibility and timed sharing, applied to the live publisher (`:69-77`).
- **Scores:** Function 8 · States 5 · UI 8 · A11y 4 · Security 7 · Code 8
- **Subscreens:**
  - Stop-timer confirm (Alert, `:190-193`) — **7/10**.
- **Strengths:**
  - Changes are pushed into the running publisher immediately (`:69-74`, `lib/family/presence.ts:776-778`).
  - Live summary of the current exposure (`:101-111`).
  - Speed is forced hidden in approximate mode (`:153-158`).
- **To reach 10/10:**
  1. Saves can fail silently. `setGroupPrivacy` returns the merged value even when the write fails (`lib/groups/store.ts:143-145, :321-323`), so the UI shows a setting that was not persisted. For a privacy control, surface write failures.
  2. `patch` has no try/catch (`:69-72`). A missing `groupId` shows defaults while changes silently no-op (`:60, :70`). Show a "group not found" state instead.
  3. Accessibility:
     - Add `accessibilityLabel` to the three Switches (`:144, :153, :172`).
     - Give precision rows `accessibilityRole="radio"` + selected state (`:122-126`) and duration chips state (`:181`).
  4. The 1-hour and 8-hour chips never show as selected (`:179`). Derive the selected state from `sharingUntil`.

### `app/group-tasks.tsx` — Shared Tasks — **6.5/10**
- **Route:** `/group-tasks` · **Entry points:** `app/family.tsx:2281` (Family Space only).
- **Purpose:** End-to-end encrypted shared task list (add, assign, due date, done, delete), with OS reminders reconciled on rebuild (`:66-150`).
- **Scores:** Function 8 · States 6 · UI 8 · A11y 6 · Security 5 · Code 7
- **Subscreens:**
  - Due-date and assignee chips (inline Step, `:181-212`) — **6/10** — real state, no selected `accessibilityState`.
- **Strengths:**
  - OS reminders are synced from the fold, so remote changes reschedule them (`:82-87`).
  - Toggle and delete controls are labelled (`:232, :256`). Delete is confirmed (`:146`).
  - `KeyboardSafe` with `keyboardShouldPersistTaps` (`:160, :164`).
- **To reach 10/10:**
  1. Verify `op.by === m.senderId` before folding (`:76-78`). Today any member can forge `by`/`doneBy`, and any member can delete any task (`lib/groups/tasks.ts:104`).
  2. As with notes, `VCTASK1:` ops are sent as text (`:119`) and no timeline filter for them was found (`app/chat.tsx:333-334` handles trip prefixes only). Needs device verification.
  3. Add an error state; a first-load failure shows "Nothing yet." (`:88-90, :221-225`). Disable add while `me` is null (`:128`).
  4. Add `accessibilityState={{selected}}` to the chips (`:187, :195, :202`). Remove the unused `Platform` import (`:13`).

### `app/group-trip.tsx` — Group Trip — **6.5/10**
- **Route:** `/group-trip` · **Entry points:** `app/family.tsx:1897, 2271` (when `canNavigate`).
- **Purpose:** Start or join a convoy trip to a destination, see each member's ETA and status, and navigate, leave or end the trip (`:106-156`).
- **Scores:** Function 7 · States 5 · UI 8 · A11y 5 · Security 6 · Code 7
- **Subscreens:**
  - Leave/End confirms (Alert, `:145-156`) — **5/10** — confirmed, but neither awaited call is wrapped in try/catch, and End can no-op (below).
- **Strengths:**
  - Server-first start with 409 race resolution (`lib/groups/tripSession.ts:94-113`).
  - Subscription cleanup with a live flag (`:58-89`). ETAs re-render on a timer (`:85-87`).
  - Only derived ETAs are shared, not positions (`:3-7`).
- **To reach 10/10:**
  1. "End trip" can silently fail for everyone else. It is shown when `trip.startedBy === me` (`:231`), but `endTrip()` returns early when the in-memory `active` is null (`lib/groups/tripSession.ts:442-443`), e.g. after an app restart where the trip arrived via `subscribeTrip`. The UI still clears (`:154`). Pass the trip into `endTrip`, or rehydrate `active` first.
  2. Wrap the `leave` and `end` handlers in try/catch (`:147, :154`).
  3. Range-check manual coordinates: `COORD_RE` accepts any number (`:33, :113`).
  4. Guard a missing `groupId` before calling `circleMembers(groupId)` (`:66-67`).
  5. Disable "Start trip" while `me` is unresolved (`:108`). Location-permission handling for `geocodeAsync` (`:115`) is not verifiable statically.
  6. Give the "Everyone follows my route" toggle `accessibilityRole="checkbox"` + `accessibilityState={{checked: lead}}` (`:180`). Remove the unused `Platform` import (`:13`).

### `app/group-calls.tsx` — Group Call Hub — **5.5/10**
- **Route:** `/group-calls` · **Entry points:** `app/chat.tsx:1987, 1992, 3576, 3583`; `app/group-info.tsx:394`; `app/(tabs)/calls.tsx:134`; registered at `app/_layout.tsx:1014`.
- **Purpose:** Pick voice or video, start an SFU group call (`/group-call-active`), or tap a member for a 1:1 call (`:67-103`).
- **Scores:** Function 7 · States 4 · UI 6 · A11y 5 · Security 6 · Code 6
- **Subscreens:**
  - Voice/Video mode toggle (Tab, `:117-124`) — **5/10** — no `accessibilityRole`/`State`.
- **Strengths:**
  - Ring responsibility is split correctly between the engine and legacy builds (`:74-93`).
  - Unmount guard on load (`:52-65`).
  - Member avatars use `attachmentUrl` with an auth header (`:144-145`).
- **To reach 10/10:**
  1. "Start group call" is enabled while loading and with zero members (`:126`). It pushes `members: ''` (`:100`) and can be double-tapped. Disable it until members load and add a guard.
  2. A load failure is shown as "No other members to call." (`:60, :157`). Add an error state with retry.
  3. Validate the `mode` param: `(modeParam as CallMode) || 'voice'` accepts any string (`:47`).
  4. Fix the contradictory comments. `:74` says "Real mesh group call", while `:8-13` says the mesh is gone. The notice says "best for small groups" (`:130`) against the 64-seat SFU (`:5`).
  5. Remove the dead `notice` style with hard-coded rgba (`:174`). Use `AppText` instead of raw `Text` (`:25`).
  6. Accessibility: mode buttons need role/state (`:119`); member rows need `accessibilityLabel` ("Call <name>") (`:142`).
  7. A 1:1 call from here passes the **group** `chatId` (`:70`). Whether `/voicecall` handles that correctly is not verifiable statically.

### `app/create-group.tsx` — New Group (direct add) — **6.0/10**
- **Route:** `/create-group` · **Entry points:** `app/new-chat.tsx:160`; registered at `app/_layout.tsx:1031`.
- **Purpose:** Name a group, pick direct-chat peers and create it with them added immediately, then open `/chat` (`:44-102`).
- **Scores:** Function 7 · States 7 · UI 6 · A11y 4 · Security 5 · Code 6
- **Subscreens:**
  - Selected-member chips (inline, `:142-152`) — **5/10** — tap to remove works, but there is no `accessibilityLabel` ("Remove <name>").
- **Strengths:**
  - Async-safe load with an `active` flag (`:44-70`).
  - `canCreate` gating plus a creating state (`:86-102`).
  - FlatList with search, and the bottom bar respects the gesture inset (`:170-177, :227-233`).
- **To reach 10/10:**
  1. Members are added without consent (`:96`), unlike the invitation model in `app/family-add.tsx:9-15` and `app/group-create.tsx:57-77`. Route "New group" to the invitation flow, or send invitations here (Duplication §1).
  2. A load error shows the error bar **and** "No contacts yet…" (`:139, :164-168`). Show only the error, with retry.
  3. No keyboard handling: the absolute bottom bar (`:233`) and inputs (`:130, :157`) are not wrapped in `KeyboardSafe`, unlike `app/group-create.tsx:84`.
  4. Give contact rows `accessibilityRole="checkbox"` + `accessibilityState={{checked: sel}}` (`:107`) and label the chips (`:145`).
  5. Remove the dead styles `avatar`, `avatarSel` and `avatarTxt` (`:219-221`). Replace the hard-coded rgba error colours (`:208`) with tokens.

### `app/communities.tsx` — Communities — **5.5/10**
- **Route:** `/communities` · **Entry points:** `app/new-chat.tsx:161`; `app/dashboard.tsx:19` (via `:91`); `app/notifications.tsx:27` (via `:168`); registered at `app/_layout.tsx:1028`.
- **Purpose:** List communities, create one, open one to see its groups, add a group, open group chats (`:38-83`).
- **Scores:** Function 6 · States 4 · UI 7 · A11y 5 · Security 6 · Code 6
- **Subscreens:**
  - Community detail view (in-state Overlay, `:86-132`) — **5.5/10** — real `getCommunity` and cache. The header back is labelled (`:92`), but there is no Android hardware-back handling (no `BackHandler` imported, `:8-10`), and "New group" is shown to every member although `detail.isOwner` exists (`:123`, `lib/chatService.ts:2668`).
  - Name modal (Modal, `:175-197`) — **6/10** — `KeyboardSafe`, busy-disabled Create (`:188`). Buttons lack a role.
- **Strengths:**
  - Local-first cache for the list and detail (`:38-64`).
  - Labelled header buttons (`:92, :140, :142`).
  - Empty state with a call to action (`:147-153`).
- **To reach 10/10:**
  1. Offline wipes the cache. `listCommunities` swallows errors and returns `[]` (`lib/chatService.ts:2670-2672`), so `loadList` overwrites the cached list and writes `[]` back (`:43-45`), and its catch (`:46`) never runs. Let `listCommunities` throw, or skip the write on failure.
  2. Handle hardware back in detail mode (return to the list), or make detail its own route.
  3. Gate "New group" on `detail.isOwner` (`:123`).
  4. Add the missing management features (leave, edit, delete, add an existing group); only create/list/open exist (`lib/chatService.ts:2670-2681`).
  5. Give community and group rows `accessibilityLabel` and role (`:111, :160`).

### `app/creator-channels.tsx` — Creator Channels (redirect) — **3.5/10**
- **Route:** `/creator-channels` · **Entry points:** **UNWIRED**. The grep for `creator-channels` finds only the file itself and `app/_layout.tsx:209` (`INSET_SCREENS`); there is no navigation call or deep link.
- **Purpose:** Redirects to `/broadcast`; the old demo screen was removed (`:3-6, :15`).
- **Scores:** Function 1 · States 3 · UI 3 · A11y 4 · Security 6 · Code 3
- **Subscreens:** None
- **Strengths:**
  - The fabricated monetization demo was removed rather than kept (`:3-6`).
- **To reach 10/10:**
  1. Delete the route and its `INSET_SCREENS` entry (`app/_layout.tsx:209`), or add it to `lib/orphanRoutes.selftest.ts` `REACHABLE_FROM` as `[]` so it can't be re-wired by accident.
  2. If it is kept, render a themed background and spinner instead of a bare `<View />` (`:16`), which flashes an unthemed blank screen.


---

## E — Calls, Live & Voice

| Screen | Route | Wired? | Score |
|---|---|---|---|
| `app/voicecall.tsx` | `/voicecall` | Yes | 6.5 |
| `app/videocall.tsx` | `/videocall` | Yes | 6.5 |
| `app/incoming-call.tsx` | `/incoming-call` | Yes (socket + notification) | 6.5 |
| `app/group-call-active.tsx` | `/group-call-active` | Yes | 6.5 |
| `app/call-recording.tsx` | `/call-recording` | **UNWIRED** | 3.5 |
| `app/call-reliability.tsx` | `/call-reliability` | Yes (Settings) | 6.5 |
| `app/network-test.tsx` | `/network-test` | Yes (Settings) | 5 |
| `app/live.tsx` | `/live` | Yes (Mini tab) | 7 |
| `app/live-view.tsx` | `/live-view` | Yes | 6.5 |
| `app/live/join/[code].tsx` | `/live/join/[code]` | Yes (in-app + deep link) | 7 |
| `app/voice-effects.tsx` | `/voice-effects` | **UNWIRED** | 4 |
| `app/voice-speed.tsx` | `/voice-speed` | **UNWIRED** | 4.5 |
| `app/voice-transcribe.tsx` | `/voice-transcribe` | **UNWIRED** | 6 |

Method notes (apply to every entry below):
- Entry points: grepped `['"\`]/<route>` across `app/ components/ lib/ hooks/ services/`, plus the bare route name repo-wide in `*.ts,*.tsx,*.json` (excluding node_modules), `app/_layout.tsx` Stack registrations, `app.json` intent filters/schemes. The app scheme `vaultchat`/`crazzychat` (`app.json:8`) makes every route deep-linkable, so "UNWIRED" means no in-app navigation, not "unreachable" (`lib/orphanRoutes.selftest.ts:3-9` says the same).
- `CALL_ENGINE_V2 = true` (`constants/flags.ts:191`), so the `*Legacy` bodies in the three call screens are dead code at runtime. They are rated as code-health cost only.
- Selftests that I ran and that pass: `lib/a11yCoverage.selftest.ts` ("unlabelled: 0 (budget 0)"), `lib/orphanRoutes.selftest.ts` (19 assertions), `lib/themeCoverage.selftest.ts` (23 assertions, 21 exemptions). The call screens and live-view are deliberately theme-exempt (`lib/themeCoverage.selftest.ts:27-34`, always-dark per `constants/callTheme.ts:1-7`). The a11y scanner only checks icon-only touchables (`lib/a11yCoverage.selftest.ts:7-15`), so a pass there does not cover role/state.
- `npx eslint` could not run: `Cannot find module 'eslint-config-expo/flat'` from `eslint.config.js:3`. The unused-import findings below were checked by hand with grep counts.
- I could not check anything visual or on a device statically (contrast, real call audio/video, server behaviour).

---

### `app/voicecall.tsx` — Voice call — **6.5/10**
- **Route:** `/voicecall` · **Entry points:** `app/chat.tsx:1988`, `app/chat.tsx:3559`, `app/chat.tsx:4268`, `app/contact-info.tsx:259`, `app/contact.tsx:36`, `app/(tabs)/calls.tsx:139`, `app/(tabs)/chats.tsx:785`, `app/family-member.tsx:277`, `app/group-calls.tsx:69`, `app/space-transport.tsx:112`, `app/incoming-call.tsx:180` (accept), `app/_layout.tsx:754` (notification answer), `components/CallBar.tsx:90` (resume).
- **Purpose:** A 1:1 audio call. It renders the state of the headless call engine (`lib/call/engine`) and adds mute, speaker, end, add-person, in-call chat and reactions.
- **Scores:** Function 8 · States 7 · UI 7 · A11y 6 · Security 7 · Code 5
- **Subscreens:**
  - Add-to-call sheet (Sheet, `app/voicecall.tsx:338`) — **7/10** — Loads direct contacts when opened, excludes self and the peer (`:266-279`), and has empty and error copy (`:282`, `:295`). However, `engine.inviteToCall` is fire-and-forget (`:291`) even though it returns the number of people rung (`lib/call/engine.ts:936`), so the user gets no confirmation or failure message. Fix: await it and toast the result.
  - In-call chat (Modal, `components/call/CallChatSheet.tsx:78`, opened from `CallExtras.tsx:58`) — **7.5/10** — Uses a virtualized FlatList (`:95`), a measured keyboard lift (`:58-67`), an honest "not saved" empty state (`:104`), maxLength 500 (`:116`), and labelled close and send buttons (`:90`, `:121`). The `mine` bubble colour is hard-coded (`:145`), the composer has a fixed `paddingBottom: 26` with no safe-area inset (`:150`), and sending gives no failure feedback. Fix: add a bottom inset and a send-failure state.
  - Reaction picker plus overlay (Overlay, `components/call/CallReactions.tsx:71`, `:60`) — **6.5/10** — The animation is native-driven and the overlay is `pointerEvents="none"` (`:64`). The emoji buttons have no `accessibilityLabel` or role (`:77`), so a screen reader reads raw emoji. Fix: label each one (for example "Send heart reaction").
- **Strengths:**
  - Incoming calls never fall through to dialling, and a resumed screen re-attaches instead of re-dialling (`app/voicecall.tsx:149-167`).
  - Back minimises a connected call and hangs up an unconnected one. When the call ends there is a `canGoBack` fallback, so a notification-launched call is not stranded (`:191-212`, `:231-234`).
  - The end reason is surfaced only for involuntary ends (`:222-224`, `lib/call/endMessage.ts:21-41`).
- **To reach 10/10:**
  1. Delete the dead `VoiceCallLegacy` body (`app/voicecall.tsx:351-730`, about 380 lines) and its imports. While doing so, remove the unused `callFail`, `offerTag` and `enterPipMode` imports (`:39`, `:47`), which appear only in import and comment lines.
  2. Add `accessibilityRole="button"` and `accessibilityState={{ selected: active }}` to `components/call/CallControlButton.tsx:38-42`. The Mute and Speaker toggle state is currently conveyed only by colour. `app/group-call-active.tsx:773-776` already does this.
  3. Derive the encryption badge instead of hard-coding `protection="transport"` (`app/voicecall.tsx:324`). The comment on `:323` calls it "the strong one", but it renders the weaker label. Use `protectionFor(...)` (`components/call/CallEncryptionBadge.tsx:59`) so the comment, the code and the actual guarantee agree.
  4. Await `engine.inviteToCall` and show the result (`app/voicecall.tsx:291`).
  5. Add `accessibilityRole="button"` to the add-person button (`:306-311`).

### `app/videocall.tsx` — Video call — **6.5/10**
- **Route:** `/videocall` · **Entry points:** `app/chat.tsx:1993`, `app/chat.tsx:3552`, `app/chat.tsx:4272`, `app/contact-info.tsx:260`, `app/contact.tsx:37`, `app/(tabs)/calls.tsx:139`, `app/(tabs)/chats.tsx:788`, `app/group-calls.tsx:69`, `app/incoming-call.tsx:180`, `app/_layout.tsx:754`, `components/CallBar.tsx:90`.
- **Purpose:** A 1:1 video call driven by the engine. It has a remote/local RTCView, mute, camera, flip, Android screen share, "Beauty" filters, speaker, end and add-person.
- **Scores:** Function 7.5 · States 7 · UI 6.5 · A11y 5.5 · Security 7 · Code 5
- **Subscreens:**
  - Add-to-call sheet (Sheet, `app/videocall.tsx:550`) — **7/10** — Same logic as voice (`:390-425`). The invite result is also ignored (`:419`).
  - Beauty filter strip (Overlay, `app/videocall.tsx:490`) — **5/10** — This is only a flat tint over the local preview. The file states it does "nothing pixel-level" and the far side never sees it (`:77-79`). The chips have no role, label or selected state (`:494`). Fix: rename it to "Preview tint" or implement the processor path described at `:91-99`, and add `accessibilityRole="button"` with `accessibilityState.selected`.
  - In-call chat / reactions (`CallExtras`, `app/videocall.tsx:505`) — **7.5/10** — Same as voice. It is correctly positioned from the measured bar height (`:254-255`).
- **Strengths:**
  - The control bar is a single scrollable row whose height is measured, so controls are never clipped (`:507-520`, `:242-255`).
  - The self-view filter is never painted over the remote person (`:440-445`).
  - Screen-share errors alert unless the user cancelled (`:355-368`), and the sharing banner shows both directions (`:471-479`).
- **To reach 10/10:**
  1. Remove `VideoCallLegacy` (`app/videocall.tsx:563-1089`, about 525 dead lines) and the unused `callFail`, `offerTag` and `enterPipMode` imports (`:27`, `:36`).
  2. Fix the camera control label. It reads "Off" while the camera is on (`:522`), so a screen reader announces "Off" for the turn-off action. Use "Turn camera off" / "Turn camera on" as group-call does (`app/group-call-active.tsx:463`).
  3. Position the share banner from the safe area (`insets.top`) instead of `top: 110` (`app/videocall.tsx:1101`).
  4. Make the "Beauty" feature honest about being local-only, or ship the `_setVideoEffects` path (`:91-99`).
  5. Add role and state to `CallControlButton` (`components/call/CallControlButton.tsx:38`) and to the filter chips (`app/videocall.tsx:494`).
  6. Derive the encryption badge rather than hard-coding `"transport"` (`:455`).

### `app/incoming-call.tsx` — Incoming call ring — **6.5/10**
- **Route:** `/incoming-call` · **Entry points:** `app/_layout.tsx:432` (pushed on the `call_incoming` socket event, registered at `:490`). It is also in `components/CallBar.tsx:38` as a call route.
- **Purpose:** Plays the ringtone, shows the caller, and offers Accept or Decline (or "Hold & accept" during call-waiting). It tracks re-sealed offers live.
- **Scores:** Function 7 · States 6 · UI 7 · A11y 6 · Security 7 · Code 6
- **Subscreens:**
  - Call-waiting mode (Mode, `app/incoming-call.tsx:222-242`) — **6.5/10** — Real: it calls `holdActiveCall()` (`:175`) and shows the "Hold & accept" label (`:242`). It has the same back-button and double-tap gaps as the main screen.
- **Strengths:**
  - The socket listeners are guarded against attaching after unmount (`:135-143`, `:162-169`). The comment explains a real leaked-`router.back()` bug.
  - The latest re-sealed offer wins over the route parameter (`:111`, `:124-134`, `:184`).
  - The caller name falls back to the local chat store, and the placeholder is never forwarded (`:53-75`).
- **To reach 10/10:**
  1. Handle Android back. There is no `BackHandler` (imports at `:10`), so a hardware back pops the ring screen. Cleanup only stops the ringtone (`:86`): no `webrtc_end` is sent and no call log is written, so the caller keeps ringing. Route back to `decline()` (`:204`).
  2. Add a re-entry guard: `accept`/`decline` set `decidedRef` but never check it (`:172-173`, `:204-205`). A double tap can call `router.replace` twice, or decline after accepting. Start each with `if (decidedRef.current) return;`.
  3. Delete the dead accept-wait state. `setWaitingForOffer` is never called, and `acceptWaitRef` and `ACCEPT_OFFER_WAIT_MS` are unused (`:115-118`, `:234-242`). Also remove the unused `Alert` import (`:10`).
  4. Add `accessibilityRole="button"` to Accept and Decline (`:229`, `:233`).
  5. Add a top safe-area inset to the body. Only the bottom inset is applied (`:228`).

### `app/group-call-active.tsx` — Group call — **6.5/10**
- **Route:** `/group-call-active` · **Entry points:** `app/group-calls.tsx:95`, `app/incoming-call.tsx:177`, `app/_layout.tsx:749` (notification answer), `components/CallBar.tsx:84`.
- **Purpose:** An SFU group call (up to `SFU_MAX` = 64, `lib/call/mode.ts:33`) with a paged grid, raise hand, host moderation, an invite picker, and in-call chat and reactions.
- **Scores:** Function 8 · States 6.5 · UI 6 · A11y 6.5 · Security 7.5 · Code 5.5
- **Subscreens:**
  - Moderation sheet (Sheet, `app/group-call-active.tsx:154-165`, rendered `:474`) — **7/10** — Calls real engine role APIs (`lib/call/engine.ts:1003`, `:996`). It gives no feedback when `setRole` returns false, and there is no confirmation for "Move to audience". Fix: await the call and toast on failure.
  - Add people sheet (Sheet, `:180-244`) — **7/10** — Lists group members first, then direct contacts, with a seat count (`:228`). Load errors are handled (`:187-189`). The invite result is ignored (`:235`, `:240`).
  - Pager (Segment, `:417-435`) — **7.5/10** — Labelled, has a role, disables at the ends, and resets when pages vanish (`:308`). The disabled state is shown only by colour; add `accessibilityState.disabled`.
  - In-call chat / reactions (`CallExtras`, `:453`) — **7.5/10** — Positioned from the measured bar height (`:455-460`).
- **Strengths:**
  - Large calls page the grid and tell the engine which tracks are visible (`:303-322`).
  - `CtrlBtn` labels state the action and include role and state (`:770-777`).
  - Ring claims are released on unmount (`:261-269`), and back minimises a connected call (`:335-343`).
- **To reach 10/10:**
  1. When the call ends, fall back if there is no history. `router.back()` alone (`:282`) leaves a notification-launched group call on a dead screen. The 1:1 screens fixed exactly this (`app/voicecall.tsx:231-234`).
  2. Apply bottom and top safe-area insets to the controls. They use a fixed `paddingBottom: 36` (`:824`) with no `useSafeAreaInsets`, so the controls can sit under the gesture bar (not verifiable statically).
  3. Give `ParticipantTile` an `accessibilityRole="button"` and label (for example "Moderate <name>") when it is tappable (`:82-86`). Also label the ✋ badge (`:96-98`) and the "Add · n/64" pill (`:371`).
  4. Remove `GroupCallLegacy` (`:487-760`), and type `CtrlBtn` props instead of `any` (`:770`).
  5. Await the invite and role calls and surface the results (`:159-162`, `:235`).

### `app/call-recording.tsx` — Call recording — **3.5/10**
- **Route:** `/call-recording` · **Entry points:** **UNWIRED**. The only references are `app/_layout.tsx:999` (Stack registration) and selftests (`lib/responsiveCoverage.selftest.ts:166`, `lib/rowOverflow.selftest.ts:217`). No push, replace, Link or data array references `/call-recording`.
- **Purpose:** Records the device microphone with expo-av and keeps a local list of recordings. It is not attached to any call.
- **Scores:** Function 1.5 · States 4.5 · UI 5 · A11y 5 · Security 1.5 · Code 4.5
- **Subscreens:**
  - Idle / Recording / Paused step (Step, `app/call-recording.tsx:494-501`, `:327-386`) — **4/10** — The mic recording is real (`:189-191`) and is stopped on unmount (`:88-98`), but the waveform is fake and random (`:117-139`). Pause and resume errors are swallowed (`:212-213`, `:225-226`).
  - Finished step (Step, `:388-429`) — **2.5/10** — "Share" is a stub alert that falsely reports "Recording shared in chat." (`:417`). "Save to Vault" only flips a flag and claims "encrypted and saved to File Vault" (`:307-311`).
  - Past recordings list (Mode, `:443-479`) — **4.5/10** — Uses a FlatList, has an empty state, labelled play and delete buttons, and confirms deletes (`:292-304`). Delete removes only the metadata, so the audio file stays on disk (`:299-300`). The only way out of the list is to leave the screen.
- **Strengths:**
  - The microphone and audio session are released on unmount (`:88-98`).
  - The permission-denied path goes through `permissionDenied` (`:179-182`).
  - Deletes are confirmed (`:293-303`).
- **To reach 10/10:**
  1. Remove the false claims. "All participants have been notified" (`:356`, `:439`) is shown with no notification sent anywhere. Either implement a consent signal through the call engine, or delete the banner. As written it is a privacy and legal hazard.
  2. Replace the stubbed Share (`:417`) and the fake Vault save (`:307-311`) with real `sendMedia`/vault encryption, or remove the buttons.
  3. Decide the screen's fate. Either wire it from a call screen with real call audio, or delete it. `callerName` is the placeholder `'Call Participant'` (`:245`).
  4. Delete the audio file when a recording is deleted (`:299`), and keep metadata out of plaintext AsyncStorage (`:150`).
  5. Fix dark mode. The `LinearGradient` has a hard-coded light `'#F9FAFB'` stop over `colors.bg` (`:485`).
  6. Remove the unused `Dimensions` import and the `setCurrentUri` state (`:16`, `:71`). Replace the counter timer with wall-clock time, as `components/call/CallTimer.tsx` does.

### `app/call-reliability.tsx` — Call reliability — **6.5/10**
- **Route:** `/call-reliability` · **Entry points:** `app/settings.tsx:417`.
- **Purpose:** Guides the user through Android full-screen intent, battery exemption and OEM auto-start, and provides a low-data call toggle.
- **Scores:** Function 6 · States 5.5 · UI 7.5 · A11y 5.5 · Security 7 · Code 7
- **Subscreens:**
  - Full-screen intent card (Card, `app/call-reliability.tsx:66-80`) — **7/10** — Shown only when the permission is missing, and re-checked on focus (`:43-46`).
  - OEM auto-start steps (Card, `:95-114`) — **6/10** — Deep links are real (`lib/batteryOptimization.ts:126-145`), but "I've done this" is self-attested and not persisted (`:110`).
  - Low-data mode card (Card, `:127-142`) — **6.5/10** — Real preference, but `setLowDataMode` failures are unhandled (`:133`) and the Switch has no `accessibilityLabel` (`:131`).
- **Strengths:**
  - FSI status is refreshed on focus so the screen does not nag after the user grants it (`:40-46`).
  - Uses theme tokens and `HEADER_TOP` (`:148-166`), and the back button is labelled (`:53`).
- **To reach 10/10:**
  1. Read the real exemption state. `battOk` is set to true as soon as the request intent returns (`:89`), even though `isIgnoringBatteryOptimizations()` exists (`lib/batteryOptimization.ts:49`) and is used elsewhere (`app/family.tsx:637`). Check it on focus.
  2. Persist the confirmations, or delete the dead `DONE_KEY` (`:20`).
  3. Hide the Android-only cards on iOS. Step 1 always renders, and `requestIgnoreBatteryOptimizations` is a no-op on iOS (`lib/batteryOptimization.ts:75`).
  4. Add `accessibilityLabel="Low data mode"` to the Switch (`:131`) and `accessibilityRole="button"` to the action buttons (`:76`, `:89`, `:107`, `:110`).
  5. Handle errors from `setLowDataMode` and `oemInstructions()` (`:133`, `:32`).

### `app/network-test.tsx` — Network speed test — **5/10**
- **Route:** `/network-test` · **Entry points:** `app/settings.tsx:438` (guarded by `lib/orphanRoutes.selftest.ts:88`).
- **Purpose:** Measures ping, jitter, download and upload against `speed.cloudflare.com`, shows a gauge, and keeps the last 20 results.
- **Scores:** Function 5 · States 4 · UI 5.5 · A11y 4.5 · Security 5 · Code 5.5
- **Subscreens:**
  - Results grid (Panel, `app/network-test.tsx:366-389`) — **5.5/10** — Reports figures even when every request failed (see fix 1).
  - History list (Panel, `:392-420`) — **6/10** — Bounded to 20 (`:118`) with an empty state (`:395`).
- **Strengths:**
  - The Start button is disabled while a test runs (`:350`).
  - The layout width is reactive (`:42-45`).
  - History is capped (`:118`).
- **To reach 10/10:**
  1. Stop fabricating results. A failed download adds `sizes[i] * 0.8` bytes as an "estimate" (`:154-156`), and failed uploads still count their bytes (`:182-183`), so an offline device reports a speed. Track failures and show an error state.
  2. Wrap `runTest` (`:195-236`) in try/catch with an unmount guard. Async state updates continue after leaving the screen, and there is no error UI.
  3. Fix the stale closure. `connectionDetails` is read at `:232` from the render before `await checkConnection()` (`:203`). Have `checkConnection` return its value.
  4. Disclose the third party, or move the test to the app's own server. Requests go to Cloudflare (`:22`, `:101`, `:130`, `:148`), which exposes the device IP. The "Server Online" label (`:333`) describes Cloudflare, not crazzychat.
  5. Remove or use the dead `needleAnim` animation. It is animated (`:72-83`) but the needle renders from the unanimated `needleAngle` (`:244`, `:270`). Also remove the unused `backArrow` style (`:432`).
  6. Give the gauge an `accessibilityLabel` and value (for example "Download 42 megabits per second"). Add `accessibilityRole="button"` to Start (`:348`). Replace the hard-coded colours (`:256`, `:354`).
  7. Remove the header's `Platform` 56/40 `paddingTop` (`:430`). The screen is already in `INSET_SCREENS` (`app/_layout.tsx:216`), which adds the status-bar inset, so this likely double-pads the top (not verifiable statically).

### `app/live.tsx` — Go Live hub — **7/10**
- **Route:** `/live` · **Entry points:** `app/(tabs)/mini.tsx:44` (`route: '/live'`) and `app/live-view.tsx:740` (viewer leave).
- **Purpose:** Lists live broadcasts, composes and starts a broadcast (public or private, optional passcode, camera/mic choice), and lets the user paste an invitation to join a private live.
- **Scores:** Function 8 · States 6.5 · UI 7.5 · A11y 5.5 · Security 7.5 · Code 7.5
- **Subscreens:**
  - Go-live composer (Step, `app/live.tsx:157-284`) — **7/10** — Validates the title (`:88`), guards double submit (`:276`), and maps 409/503 errors to useful messages (`:118-132`). The Public/Private segment has no role or selected state (`:176-193`). Cancel does not clear `passcode` (`:271`).
  - Join private live card (Step, `:305-340`) — **7/10** — Accepts a full URL or a bare code (`:68-77`, `lib/broadcast.ts:371-375`), and Continue is disabled when empty (`:334`).
  - Live now list (List, `:354-401`) — **6.5/10** — Has loading and empty states (`:356-364`). A load error is swallowed (`:80`), so offline looks like "Nobody is live right now". The cards have no role or label (`:367`).
- **Strengths:**
  - States up front that broadcasts are not end-to-end encrypted (`:148-154`), and reads per-broadcast `e2ee` from the server (`:394`).
  - The camera/mic pre-choice uses switch role and state (`:248-255`).
  - Turns on the native header so there is a back control (`:140-141`).
- **To reach 10/10:**
  1. Track a load error separately and show an offline or retry message instead of the empty state (`:79-82`). Also wire `RefreshControl.refreshing` to real state; it is hard-coded `false` (`:145`).
  2. Add `accessibilityRole="radio"` (or button) with `accessibilityState.selected` to the visibility segment (`:176`). Add a role and label to the broadcast cards (`:367`) and the Go-live CTA (`:287`).
  3. Make the notice match the chosen visibility. It always says "Broadcasts are public" (`:151`), even under the Private option, which says the opposite (`:200`).
  4. Clear `passcode` on Cancel (`:271`).

### `app/live-view.tsx` — Live broadcast viewer / host stage — **6.5/10**
- **Route:** `/live-view` · **Entry points:** `app/live.tsx:102` (host after go-live), `app/live.tsx:372` (watch), `app/live/join/[code].tsx:103` (after redeem).
- **Purpose:** The viewer watches HLS, or low-latency WebRTC for a private live. The host or co-host publishes through LiveKit and controls mic, camera and screen. It also has live chat, polls, invite links, PiP, pinch zoom and auto-orientation.
- **Scores:** Function 7.5 · States 6.5 · UI 7 · A11y 6 · Security 7 · Code 4.5
- **Subscreens:**
  - Waiting / Failed / Ended states (State, `app/live-view.tsx:1169-1199`, `:1302-1309`) — **6/10** — Honest copy, including stage-full versus network (`:1190-1194`). However, "Go back" uses `router.back()` (`:1175`, `:1196`, `:1306`), which `:725-728` explains exits the app for a viewer who arrived through an invitation. The host's Failed "Go back" never calls `endBroadcast`.
  - Top chrome row (Toolbar, `:1431-1553`) — **7/10** — Every icon is labelled with hitSlop. The host's End button is hidden while waiting (`:1533`) and the native header is off (`app/_layout.tsx:912`; `:1167` does not set `headerShown`), so a host stuck on "Starting your broadcast…" has no on-screen exit.
  - Live chat panel (Panel, `:1751-1811`) — **6.5/10** — Moves to the right in landscape (`:1765-1771`) and the list is bounded to 200 (`:632`). There is no auto-scroll to new messages (`:1780`). The draft is cleared before sending and lost on failure with no message (`:640-647`). The unread badge stops counting once the list hits the 200 cap, because `messages.length` stays at 200 (`:632`, `:825`).
  - Poll card (Card, `:1592-1633`) — **6.5/10** — Votes are final and server-confirmed (`:658-674`). Options have no role or label (`:1613`). The host's "End" button marks the poll closed optimistically even though `closePoll` swallows errors (`:1600`, `lib/broadcast.ts:278-283`).
  - Poll composer (Form, `:1636-1672`) — **6/10** — Validates at least 2 options (`:680-683`). There is no way to remove an option, and the "+ Option", "Cancel" and "Start poll" text buttons have no role (`:1660-1668`).
  - Invite panel (Sheet, `:1679-1744`) — **7.5/10** — The code is captured once, there is separate-channel copy for the passcode (`:1702-1719`), and the controls are labelled.
  - Host media controls (Toolbar, `:1820-1849`) — **8/10** — Role, label and selected/disabled state (`:1830-1833`), a busy guard (`:487`), and state re-read from the room (`:495`).
  - Camera PiP (Overlay, `:1387-1406`) — **6.5/10** — Draggable and clamped, with a labelled hide toggle (`:1474-1483`). There is no a11y alternative to dragging.
  - Stage strip (List, `:1561-1572`) — **6/10** — Shows peer tiles with no names or labels.
- **Strengths:**
  - Careful lifecycle handling: owned media is released idempotently (`:123-139`), the room is torn down before ending (`:690-715`), and a viewer stops on server end (`:588-613`).
  - The stage role comes from the server, not the URL (`:153-171`). Camera/mic choices are applied at join, not after (`:299-308`).
  - Reconnecting, failed and live states are distinct and fresh (`:1438-1448`).
- **To reach 10/10:**
  1. Give the host an exit while waiting (`:1533`), and call `endBroadcast` on the host Failed path and on unmount or hardware back. There is no `BackHandler`, and only `stop()` ends the broadcast (`:713`). Whether the server reaps an orphaned `starting` broadcast is not verifiable statically.
  2. Use `leaveAsViewer` (or a `canGoBack` fallback) on the Ended, Failed and Unavailable "Go back" buttons (`:1175`, `:1196`, `:1306`).
  3. Split the 2010-line component. The four copies of teardown logic (`:123-139`, `:446-474`, `:690-712`, `:729-741`) should become one helper. Move the stage geometry and gestures into a hook (`:789-1163`).
  4. Fix the chat: compute unread from `lastId` or ids rather than a length that is capped at 200 (`:825`), restore the draft when sending fails (`:640-647`), and auto-scroll the list (`:1780`).
  5. Add roles and labels to the poll options and composer buttons (`:1613`, `:1600`, `:1660-1668`). Provide an accessible way to show the chrome, because double-tap-only (`:846-850`) is unreachable for TalkBack and VoiceOver users.
  6. Replace the private Animated API `__getValue` (`:1027`, `:1041`) with listener-tracked values.
  7. Stop carrying the plaintext passcode in route params (`pc`, `:59`; set at `app/live.tsx:113`). Use an in-memory store.

### `app/live/join/[code].tsx` — Private live join — **7/10**
- **Route:** `/live/join/[code]` · **Entry points:** `app/live.tsx:76`; Android App Link `app.json:48-62` (`pathPrefix: /live/join`); schemes `app.json:8`; registered at `app/_layout.tsx:943`; path parsing covered by `lib/pendingLink.selftest.ts:37`.
- **Purpose:** Redeems a private-live invitation code with an optional display name and passcode, then replaces the route with `/live-view`.
- **Scores:** Function 8 · States 6 · UI 7 · A11y 5.5 · Security 8 · Code 7.5
- **Subscreens:**
  - Name step (Step, `app/live/join/[code].tsx:132-188`) — **7/10** — Prefills only an untouched field (`:90`) and does not block on the profile lookup (`:133-138`). There is no Cancel button on this step.
  - Joining (Step, `:190-202`) — **6.5/10** — Spinner and copy. It lacks the `AuroraBackground` that the other steps use.
  - Passcode step (Step, `:224-282`) — **7.5/10** — `secureTextEntry` (`:260`), wrong-passcode state (`:252`, `:264`), Cancel. The "Join live" CTA has no label or role (`:266`).
  - Error (Step, `:204-222`) — **5.5/10** — Every failure, including offline, shows "This invitation isn't valid" because `redeemInviteLink` maps any non-403 to `invalid` (`lib/broadcast.ts:363-366`). There is no Retry.
- **Strengths:**
  - The redeem happens on a user action, which removes the name race (`:114-123`).
  - Passcode handling is a proper second factor (`:96-112`, `:250-264`).
  - `replace` keeps Back out of the redeem flow (`:102-103`).
- **To reach 10/10:**
  1. Distinguish network errors from invalid codes in `redeemInviteLink` (`lib/broadcast.ts:360-366`), and add a Retry on the error step (`:204-222`).
  2. Add a Cancel or back control to the Name step (`:139-187`).
  3. Make the StatusBar follow the theme. It is forced to `light-content` (`:147`, `:194`, `:208`, `:232`) on a screen whose colours are themed, so it will be white on a light background in light mode.
  4. Add `accessibilityRole="button"` to the CTAs (`:175`, `:266`, `:216`, `:277`), and remove the unused `Platform` import (`:32`).

### `app/voice-effects.tsx` — Voice effects — **4/10**
- **Route:** `/voice-effects` · **Entry points:** **UNWIRED**. No `['"\`]/voice-effects` literal in `app/`, `components/`, `lib/`, `hooks/` or `services/`. Repo-wide it appears only in `design/ui-audit/changed-screen-review.json:2569` and `lib/responsiveCoverage.selftest.ts:85`, and it is not registered in `app/_layout.tsx`.
- **Purpose:** Records a mic sample, plays it back at a preset "effect" rate, and saves a preset choice "for calls".
- **Scores:** Function 2 · States 4 · UI 6 · A11y 4 · Security 3.5 · Code 4.5
- **Subscreens:**
  - Preview recorder (Panel, `app/voice-effects.tsx:129-165`) — **4/10** — Recording is real (`:80`), but the label says "Hold to Record" while it is tap-to-toggle (`:137-138`). Pitch is never applied; only `rate` is (`:100`).
  - Effect picker grid (Grid, `:169-185`) — **4/10** — The cards have no role, label or selected state (`:171-173`). The P/S values shown (`:179-180`) misrepresent what playback does.
- **Strengths:**
  - The microphone permission goes through `permissionDenied` (`:77-78`).
  - Uses palette-driven styles (`:194-216`).
- **To reach 10/10:**
  1. Remove or implement "Use in Calls". It writes `vc_voice_effect` (`:110-115`), but a repo-wide grep finds that key read nowhere, so the alert "will be used during calls" (`:114`) is false. The header pitches this feature "for privacy" (`:2`), which makes the false claim a privacy risk.
  2. Apply pitch, or drop it from the UI. `pitch` values (`:25-36`) are never used. "Robot", "Echo" and "Whisper" are only rate changes.
  3. Stop the recording and unload `soundRef` on unmount (there is no cleanup effect), and wrap `stopRecord` in try/catch (`:85-91`).
  4. Type the state: `useState(null)` for recording and sound (`:49-54`) only compiles because `strict: false` (`tsconfig.json:4`).
  5. Add roles, labels and `accessibilityState.selected` to the effect cards and buttons (`:137`, `:151`, `:154`, `:171`). Fix the "Hold to Record" wording.
  6. Wire it from somewhere, or delete it.

### `app/voice-speed.tsx` — Voice message speed player — **4.5/10**
- **Route:** `/voice-speed` · **Entry points:** **UNWIRED**. No route literal in `app/`, `components/`, `lib/`, `hooks/` or `services/`. The only mention is `design/ui-audit/changed-screen-review.json:2594`, and there is no `_layout` registration.
- **Purpose:** Plays the audio file given by the `uri` param at 0.5x–2x, with ±10 s skip.
- **Scores:** Function 3.5 · States 3.5 · UI 6 · A11y 5 · Security 4 · Code 6
- **Subscreens:**
  - Speed selector (Segment, `app/voice-speed.tsx:156-169`) — **4/10** — Changing speed changes `speed`, which is in the load effect's dependencies (`:72`), so the sound is unloaded and recreated. Playback stops and position resets on every speed tap. The chips have no selected state (`:158-160`).
- **Strengths:**
  - Play/pause is labelled and has a role (`:144`).
  - Speed chips meet the 44 pt minimum height (`:204`).
  - Skip is clamped to the duration (`:87`).
- **To reach 10/10:**
  1. Remove `speed` from the load effect's dependencies (`:72`) and rely on `setRateAsync` (`:163`), which already handles a speed change.
  2. Validate the `uri` param (`:27`, `:60`). Any deep link (`vaultchat://voice-speed?uri=…`, scheme at `app.json:8`) can make the app stream an arbitrary remote URL. Restrict it to local `file://` URIs.
  3. Surface load failure instead of `catch {}` (`:68`), and show a loading state.
  4. Replace the random waveform (`:39`) with real metering, or a plain progress bar. Fix the hard-coded `rgba(255,255,255,0.15)` bars, which disappear on a light theme (`:120`).
  5. Add role and label to the skip buttons (`:140`, `:150`) and `accessibilityState.selected` to the chips (`:158`).
  6. Wire it from the voice-message bubble, or delete it.

### `app/voice-transcribe.tsx` — Voice to text — **6/10**
- **Route:** `/voice-transcribe` · **Entry points:** **UNWIRED**. It is registered in the Stack (`app/_layout.tsx:949`) but no push, replace or href references `/voice-transcribe`.
- **Purpose:** Live dictation through `@react-native-voice/voice`. The text can be edited and sent to `chatId` with `sendMessage` (`lib/chatService.ts:1465`).
- **Scores:** Function 4 · States 6 · UI 7 · A11y 6.5 · Security 6 · Code 7
- **Subscreens:** None (single panel).
- **Strengths:**
  - Real recognizer wiring, with cleanup on unmount (`app/voice-transcribe.tsx:39-54`).
  - The send path goes through the normal message pipeline, with a sending guard and error alert (`:71-83`, `:130`).
  - Back and mic controls are labelled and have roles (`:90`, `:116`).
- **To reach 10/10:**
  1. Wire it, for example from the chat composer's mic long-press, passing `chatId` (`:32`). Today it is reachable only by deep link.
  2. Use the device locale instead of hard-coded `'en-US'` (`:60`).
  3. Qualify the "transcribed on-device" claim (`:100`). The OS recognizer may use a cloud service; I could not verify which statically. Check `Voice.isAvailable()` before starting.
  4. Add `accessibilityRole="button"` to Clear and Send (`:127`, `:130`).
  5. Add a keyboard-avoiding wrapper. The multiline input sits above the controls with no `KeyboardSafe` (`:97-134`).


---

## F — Media, Files & Documents

Static read-only review. Every screen file was read in full, as were `components/DocView.tsx`, `PdfView.tsx`, `PdfThumbnailer.tsx`, `ProtectedMediaView.tsx`, `components/chat/ViewerStack.tsx` and `components/status/GateChallenge.tsx` (lines 50–169). Focused selftests were run and all passed: `lib/docOpen`, `lib/archive`, `lib/camera/cameraMode`, `lib/whiteboardStroke`, `lib/reader`, `lib/shelf`, `lib/a11yCoverage` ("every icon-only button is labelled") and `lib/permissionDeadEnd`. Note that `a11yCoverage` counts any `<Text>` child as a label, so glyph-only text such as `'←'` passes it. Deep links: expo-router routes any `vaultchat://<route>` by itself (`lib/pendingLink.ts:64-67`), so a route registered in `app/_layout.tsx` but never navigated to in-app is marked **UNWIRED**.

| Screen | Route | Wired? | Score |
|---|---|---|---|
| app/camera.tsx | /camera | Yes (chat attach sheet) | 7.5 |
| app/media-viewer.tsx | /media-viewer | Yes (bubble, shelf, file-viewer) | 4.5 |
| app/media-gallery.tsx | /media-gallery | Yes (group-info, contact-info, family) | 6 |
| app/image-editor.tsx | /image-editor | Yes (chat "Edit photo") | 4 |
| app/file-preview.tsx | /file-preview | Yes, narrow (media-viewer CodeViewer only) | 5 |
| app/file-viewer.tsx | /file-viewer | Yes (bubble, gallery, archive, shop-book, media-viewer) | 6.5 |
| app/video-player.tsx | /video-player | Yes, narrow (VaultBeam bubble only) | 3.5 |
| app/slideshow.tsx | /slideshow | **UNWIRED** | 4.5 |
| app/reader.tsx | /reader | Yes (bubble "Read as page") | 7.5 |
| app/shelf.tsx | /shelf | Yes (Mini apps) | 6.5 |
| app/archive-viewer.tsx | /archive-viewer | Yes (bubble, media-viewer, gallery) | 6.5 |
| app/docscanner.tsx | /docscanner | Yes (Mini apps) | 5.5 |
| app/scanner.tsx | /scanner | **UNWIRED** (and a mock) | 2 |
| app/story-viewer.tsx | /story-viewer | Yes (status tab, chats list, chat header) | 6.5 |
| app/whiteboard.tsx | /whiteboard | Yes (chat attach sheet) | 4.5 |

---

### `app/camera.tsx` — Camera (Scan · Photo · Video) — **7.5/10**
- **Route:** `/camera` (modal, `app/_layout.tsx:976`) · **Entry points:** `app/chat.tsx:2557` (composer slide-up/startMode), `app/chat.tsx:2737` (Camera tile), `app/chat.tsx:2748` (Scan tile, `startMode: 'scan'`)
- **Purpose:** One camera surface. It captures a photo or video, records a round video note, or scans pages into a PDF. The capture goes back to the chat through `dismissTo` with `captured*` params (`camera.tsx:146-155`, `lib/camera/cameraMode.ts:54-68`).
- **Scores:** Function 8 · States 7 · UI 8 · A11y 8 · Security 6 · Code 7
- **Subscreens:**
  - Permission gate (Overlay/state, `camera.tsx:286-304`) — **6/10**. It shows a branded inline gate, but "Allow camera" only calls `requestCam` (`:297`). Once the OS stops asking (`canAskAgain` false), there is no "Open settings" path. Fix: branch on `camPerm.canAskAgain` and call `Linking.openSettings()`.
  - Mode tabs SCAN/PHOTO/VIDEO (Tab, `camera.tsx:382-400`) — **8.5/10**. Has `accessibilityRole="tab"` and selected state, a capped font in a fixed pill (`:385-396`), and reduce-motion support (`:102-109`). Fix: none significant.
  - Scan review sheet (Overlay, `camera.tsx:483-540`) — **7/10**. Style chips are role=radio, there is a name input and a busy-guarded Attach. It shows no page thumbnails and cannot delete or reorder a page. It is not a `Modal`, and the screen has no `BackHandler`, so hardware back or ✕ (`:333`) silently drops every scanned page. Fix: add a page strip with remove, and confirm before leaving when `scanPages.length > 0`.
- **Strengths:**
  - Leaves by chat id via `router.dismissTo`, so a notification-deep-linked chat is not lost (`camera.tsx:146-155`). The params contract is selftested (`lib/camera/cameraMode.ts:54-68`).
  - Permissions are asked when they are needed: the mic only on VIDEO (`:158-170`) and the library only on thumbnail tap (`:131-143`, `:250-253`).
  - Double-capture guards (`busy`, `scanningRef`) and an AppState reset so SCAN cannot wedge (`:113-118`, `:173-174`, `:210-212`).
- **To reach 10/10:**
  1. Add an `openSettings` route out of a refused camera/mic permission. Today the gate repeats a silent refusal (`camera.tsx:297`, `:161`), and the file is exempted from the guard that would catch this (`lib/permissionDeadEnd.selftest.ts:51-52`).
  2. Confirm before discarding scanned pages on ✕ or hardware back (`camera.tsx:333`, `:488`).
  3. Add page preview/remove in the review sheet (`camera.tsx:490-538`).
  4. Replace the 250 ms sleep in hold-to-record (`camera.tsx:188`) with waiting for the CameraView mode change. It is a timing guess.
  5. Raw `e.message` from ML Kit or the PDF build is shown to the user (`camera.tsx:221`, `:246`). Map it to user copy.

### `app/media-viewer.tsx` — Universal Media Viewer — **4.5/10**
- **Route:** `/media-viewer` · **Entry points:** `components/chat/MessageBubble.tsx:1293`, `app/shelf.tsx:100-107`, `app/file-viewer.tsx:711` (video redirect)
- **Purpose:** Resolves an attachment (including view-once or E2EE ones) to a local file. Renders images, video, audio, code text and archive or generic cards. Redirects documents to `/file-viewer` (`:204-211`).
- **Scores:** Function 6 · States 5 · UI 3 · A11y 4 · Security 7 · Code 3
- **Subscreens:**
  - ImageViewer (Mode, `:267-287`) — **4/10**. A tap toggles 2.5× zoom, but there is no pan or pinch, although the file header promises "zoom, pan" (`:2`). Fix: add a pinch/pan gesture (as `components/DocView.tsx:190-195` does with RNGH).
  - VideoPlayer (Mode, `:290-331`) — **4/10**. Play/pause works. The progress bar is display-only (`:321-324`), so there is no seeking. Fix: make the track a seekable control.
  - AudioPlayer (Mode, `:334-370`) — **4.5/10**. Has an unmount-safe `createAsync` (`:343-346`). The waveform uses `Math.random()` on every render, so it flickers on each 200 ms status update (`:358`). The ±10% buttons have labels but no role (`:361-365`). Fix: use stable bar heights (as `file-viewer.tsx:267` does).
  - CodeViewer (Mode, `:373-401`) — **2.5/10**. Unreadable. The filename `#1F2937` sits on header `#161B22` (`:387-388`), and line text `#C9D1D9` sits on a `#FFFFFF` ScrollView (`:386`, `:396`). Remote files download without the bearer token (`:378`). Fix: set the ScrollView background to the dark canvas and use the `downloadAuthed` pattern.
  - ArchiveCard (Mode, `:407-417`) — **5.5/10**. Real Browse and Save actions, but the buttons have no role (`:409`, `:413`).
  - GenericViewer (Mode, `:419-435`) — **5.5/10**. Download & Open, plus Open without saving to `/file-viewer`. Light card `#F9FAFB` on a black screen (`:533`).
  - "Nothing to show" empty state (State, `:443-469`) — **7.5/10**. Labelled Go back with a fallback to chats.
  - ProtectedMediaView wrapper for view-once (Overlay, `:493-500`) — **7.5/10**. See the shared components section.
- **Strengths:**
  - View-once handling: downloads to an ephemeral cache file, deletes it on unmount (`:86-91`, `:141-160`), marks viewed only after load (`:95-100`), and hides Share/Save (`:478`).
  - Auth headers are applied to every player, and a player is not mounted before the token arrives (`:127-135`, `:295-298`, `:338`).
  - An ErrorBoundary wraps the screen (`:551-557`).
- **To reach 10/10:**
  1. Hoist `ImageViewer`/`VideoPlayer`/`AudioPlayer`/`CodeViewer` (`:267`, `:290`, `:334`, `:373`) to module scope. They are defined inside render, so every parent state change remounts them: video restarts, audio reloads, zoom resets. For example `setFileSize` after the HEAD request (`:191-193`), `setMe` (`:66-68`) and `setAuthHeaders` (`:106`) all trigger it.
  2. Fix the CodeViewer contrast and add auth to its download (`:378`, `:386-388`, `:396`).
  3. Make the video seek bar interactive (`:321-324`) and add pinch/pan to the image (`:271-279`).
  4. Move hard-coded hex (`:31`, `:518-545`, inline styles `:387-433`) onto a dark-media token set.
  5. Add `accessibilityRole="button"` to the header and card buttons (`:479-480`, `:409`, `:413`, `:421`, `:426`), and give the error text a Retry action (`:486`).
  6. Show a mapped message instead of `Alert.alert('Error', e.message)` (`:263`), and type the helpers (`:33`, `:44-45`, implicit `any`).

### `app/media-gallery.tsx` — Shared Media (per chat / group album) — **6/10**
- **Route:** `/media-gallery` · **Entry points:** `app/group-info.tsx:410`, `:428`; `app/contact-info.tsx:293`; `app/family.tsx:2275`
- **Purpose:** Lists a chat's photos, videos, files and links from server history merged with local history (`:187-212`). Supports an album grouping by date or member (`:347-357`).
- **Scores:** Function 6 · States 6 · UI 7 · A11y 4 · Security 5 · Code 7
- **Subscreens:**
  - Photos/Videos/Files/Links tabs (Tab, `:385-392`) — **6/10**. Counts are shown. The tabs have no `accessibilityRole="tab"` or selected state (`:387`), and the active count is hard-coded `#FFFFFF` (`:389`).
  - Album grouping All/By date/By member (Segment + SectionList, `:394-424`) — **6.5/10**. Memoised rows (`:347-357`). The chips have no role or state (`:397`).
  - Full-screen photo viewer (Modal, `:440-447`) — **4/10**. No zoom, share or save. A video tile also opens here (`:317`) and renders `MediaThumb` (an expo-image), so **videos cannot be played** from the gallery. The close button sits at a fixed `top: 54` rather than the safe-area inset (`:484`). Fix: route video to `/media-viewer` and use insets.
- **Strengths:**
  - `MediaThumb` is hoisted to module scope to avoid the remount/decrypt storm (`:58-82`). The grid size reacts to window changes (`:35-37`, `:144-145`).
  - It merges with local history, so the retention sweep does not erase the gallery (`:198-212`). It paints from cache first (`:161-171`).
  - Files open through the authenticated, decrypting resolver with a re-entrancy guard and a clear MediaKeyMissing message (`:249-308`).
- **To reach 10/10:**
  1. Exclude view-once media in `bucket()` (`:43-56`), or route it through the protected viewer. `bucket` does not check `meta.viewOnce` (which the chat honours, `components/chat/MessageBubble.tsx:1319`), so view-once photos appear as grid thumbnails and open in the unprotected Modal.
  2. Make video tiles play: push `/media-viewer` with `msgType: 'video'` instead of `setViewer` (`:317`, `:445`).
  3. Add an error and offline state with retry. Today a failure with no cache shows "No photos shared yet" (`:213-216`, `:423-436`). Surface the 5×200-message cap (`:190`).
  4. Add accessibility labels and roles to the photo tiles (`:311`), file rows (`:324`) and tabs/chips (`:387`, `:397`).
  5. Remove the unused `SW` in `useS` (`:121`), and replace `#FFFFFF` (`:389`, `:470`) with an `accentOn` token.

### `app/image-editor.tsx` — Image Editor — **4/10**
- **Route:** `/image-editor` · **Entry points:** `app/chat.tsx:2705` (`onEditPhoto`, "Edit photo" tile `app/chat.tsx:2744`)
- **Purpose:** Crop, rotate, draw, text, filter and adjust a photo, then hand it back to the chat via `capturedUri` (`:233-236`).
- **Scores:** Function 3 · States 4 · UI 5 · A11y 3 · Security 6 · Code 4
- **Subscreens:**
  - Crop panel (Tool mode, `:383-400`) — **3/10**. Only a centred crop to a fixed ratio (`:147-148`). "Free" is selectable but then rejected with "Choose a crop ratio first" (`:23`, `:128-131`).
  - Draw panel (Tool mode, `:402-429`) — **2.5/10**. `drawPan` is created once in `useRef` (`:88-107`) and closes over the initial `drawColor`/`brushSize` (`:94`), so picking a colour or size has no effect on strokes. Strokes are one View per segment (`:257-285`). Fix: read colour and size from refs (as `app/whiteboard.tsx:33-40` does).
  - Text panel (Tool mode, `:431-478`) — **4/10**. Adds and removes overlays. Dragging adds the cumulative `g.dx/g.dy` on every move (`:200-203`), so text accelerates away from the finger. The PanResponder is recreated every render (`:345`).
  - Filter panel (Tool mode, `:480-495`) — **3/10**. The filters are translucent tint Views (`:169-177`). "B&W" is a 50% grey wash, not desaturation (`:171`). `applyFilter` is effectively a no-op (`:162-166`).
  - Adjust panel (Tool mode, `:497-528`) — **2/10**. Brightness and contrast only change an on-screen overlay. `handleDone` captures the ViewShot only when there are lines, text or a filter (`:214`), and the "brightness" step is just a resize (`:221-229`), so these edits never reach the sent image. Negative contrast does nothing (`:329`).
  - Processing overlay (Overlay, `:530-535`) — **6/10**. Present, but hard-coded `rgba(2,11,24,0.85)` (`:591`) in light mode.
  - Discard confirmation (Alert, `:244-249`) — **7/10**. Destructive confirm. It is shown even with no edits.
- **Strengths:**
  - Hands the result back through the shared `capturedUri` contract that chat consumes once (`:231-236`; `app/chat.tsx:2522-2549`).
  - Rotate and crop use the real `expo-image-manipulator` (`:113-117`, `:149-153`).
  - Reactive window size in styles (`:34-44`).
- **To reach 10/10:**
  1. Fix the stale-closure draw colour and size (`:88-107`), and the text-drag drift (`:200-203`; store the start position and add `g.dx`).
  2. Apply brightness, contrast and filters to the output. Always capture the ViewShot when an adjust overlay is present (`:214`), and use real colour-matrix filters instead of tints (`:169-177`, `:221-229`).
  3. Add a user-positioned crop rectangle and make "Free" work (`:128-148`).
  4. Return with `router.dismissTo` and full params (as `app/camera.tsx:151-154` does). `router.replace` here (`:233`) pushes a second `/chat` over the existing one.
  5. Disable Done while processing (`:308`) and guard Rotate re-entry (`:110-124`).
  6. Replace the emoji/glyph tool icons (`:288-295`) with Ionicons plus labels. Label the colour dots and size buttons (`:406-421`, `:448-463`) and add selected state.
  7. Use safe-area insets instead of `Platform.OS === 'ios' ? 56 : 40` (`:545`). Remove the dead `rotation` state (`:59`, `:119`).

### `app/file-preview.tsx` — Syntax-highlighted File Preview — **5/10**
- **Route:** `/file-preview` · **Entry points:** `app/media-viewer.tsx:391` (CodeViewer "Open with Syntax Highlighting"). It is reached only for code types that `lib/docOpen.ts:56-60` does not send to `/file-viewer` (for example .kt or .php opened from the Shelf, `app/shelf.tsx:100`).
- **Purpose:** Reads a text or code file and renders tokenised, coloured lines, with Wrap/Copy/Share header actions.
- **Scores:** Function 6 · States 4 · UI 6 · A11y 5 · Security 6 · Code 4
- **Subscreens:** None (the header actions are buttons, not subscreens).
- **Strengths:**
  - Copy uses `copyAndAutoClear` (`:170`), which limits clipboard exposure.
  - Has a real back header (`:183-201`), and the chrome follows theme tokens (`:238-243`).
  - The language map and tokenizer cover many languages (`:32-128`).
- **To reach 10/10:**
  1. Virtualise and cap. Every line is tokenised and mounted on every render in nested ScrollViews (`:214-231`). Use a FlatList with memoised tokens (as `app/file-viewer.tsx:1066-1078` does), plus a size cap.
  2. Use an authenticated download for http (`:151-156`), and add a cancel flag for unmount.
  3. Replace the "error as file content" approach (`:161-163`) with an error state and Retry.
  4. Delete or purge the `preview_*` cache copy (`:153`). `lib/mediaCacheGC.ts:20-23` only knows the `vo_`/`vv_`/`dc_` prefixes.
  5. Type `tokenize`/`LANG_MAP`/`KEYWORDS` (`:32`, `:45`, `:63`; implicit `any`). Add `accessibilityRole` to the header buttons (`:190-198`).

### `app/file-viewer.tsx` — Universal File Viewer — **6.5/10**
- **Route:** `/file-viewer` · **Entry points:** `components/chat/MessageBubble.tsx:553-555`, `app/media-viewer.tsx:206-211` and `:428`, `app/archive-viewer.tsx:132`, `app/shop-book.tsx:101`, `app/media-gallery.tsx:291-294` (via `viewerRouteFor`)
- **Purpose:** In-app reader for PDF (native PdfRenderer), docx/xlsx/pptx (structured blocks), windowed plain text, audio and images, with hand-off to the device app.
- **Scores:** Function 8 · States 8 · UI 5 · A11y 5 · Security 7 · Code 6
- **Subscreens:**
  - Image mode (`:873-894`) — **5.5/10**. Double-tap 2.5× and pan only, no pinch (`:810-849`). There is no ProtectedMediaView, which is acceptable for non-view-once media.
  - PDF mode → `PdfView` (`:942-972`) — **7/10**. Native pages with a text fallback on failure (`:700-706`, `:943`). The action bar says "Pinch to zoom" (`:955`), but `PdfView` has no gesture (`components/PdfView.tsx:200-219`).
  - Office reader → `DocView` (`:982-1046`) — **8/10**. Two-phase parse with stale-run guards (`:469-573`) and a flat-text fallback (`:1012-1023`).
  - Text/code windowed reader (`:1051-1135`) — **8/10**. FlatList, byte-window paging, and per-window failure retry that keeps already-read text (`:1079-1099`, `:448-456`).
  - Audio player (`:1140-1220`) — **5.5/10**. Both skip buttons read just "15s" (`:1189-1216`), and the seek area has no label or role (`:1163-1178`). It loads without auth for http and with no unmount guard (`:642-661`).
  - Hand-off card (`:920-938`) — **7/10**. Uses FileProvider + ACTION_VIEW with a MIME guess and a share fallback (`:740-792`).
  - Unknown type (`:1225-1234`) — **5/10**. Tells the user to use "Open With...", which actually opens the share sheet.
  - Error state + Retry (`:1239-1252`) — **7/10**. Retry re-runs the single loader (`:858-865`). The button has no role.
  - Loading skeleton (`:1257-1265`) — **7/10**.
  - Bottom "Open With..." bar (`:1328-1341`) — **4/10**. It calls `handleShare` (share sheet), which duplicates and conflicts with the "Open in another app" action bars (`:954-969`, `:1025-1043`, `:1117-1132`). `handleShare` swallows all errors (`:806`).
- **Strengths:**
  - Authenticated downloads with honest 401/403 copy (`:385-396`). The Google gview leak was removed in favour of on-device hand-off (`:908-919`).
  - Stale-load protection via the `runRef` counter (`:329-337`, `:684-695`). Size checks happen before reading (`:617-631`).
  - Large text never materialises in full (windowing, `:417-460`). ErrorBoundary at `:1513-1519`.
- **To reach 10/10:**
  1. Remove the duplicate bottom "Open With..." bar, or make it call `openInDeviceApp`. Today two adjacent bars do different things (`:1330` vs `:957`).
  2. Purge the plaintext temp copies: `temp_view_*`, `temp_doc_*` and `safeName` files in the cache (`:584`, `:614`, `:752`, `:800`) are not covered by `lib/mediaCacheGC.ts:20-23`.
  3. Fix the audio loader: add auth headers and an unmount/stale guard, as `media-viewer.tsx:343-346` does (`:642-661`). Drop `staysActiveInBackground: true` (`:644`), since the sound is unloaded on unmount anyway.
  4. Add pinch zoom to images (`:827-849`) and PDFs (`components/PdfView.tsx:202`), or remove the "Pinch to zoom" hint (`:955`).
  5. Accessibility: give the 15-second skip buttons distinct labels such as "Back 15 seconds" (`:1189`, `:1208`). Label the seek area and add roles to Retry/Open (`:1246`, `:927`).
  6. Replace the fixed `Platform.OS` paddings with safe-area insets (`:1357`, `:1378`, `:1497`). Split the renderers into components to shrink the 1,519-line file and its `as any` casts (`:425`, `:476`, `:598`, `:627`).
  7. Make `handleShare` report failures (`:806`), and fix the unescaped backslash in its filename regex (`:799` vs `:749`).

### `app/video-player.tsx` — Video Player — **3.5/10**
- **Route:** `/video-player` · **Entry points:** `components/VaultBeamBubble.tsx:89` only (chat video bubbles go to `/media-viewer`, `MessageBubble.tsx:1293`)
- **Purpose:** Full-screen player with overlay controls, ±10 s double-tap, pinch zoom, swipe to dismiss, speed, mute, an in-app "PiP" and resume position.
- **Scores:** Function 4 · States 3 · UI 3 · A11y 2 · Security 5 · Code 4
- **Subscreens:**
  - Controls overlay (Overlay, `:474-559`) — **3.5/10**. Every button is a unicode glyph `<Text>` with no `accessibilityLabel` (`:478-484`, `:491-505`, `:529-555`). Glyph colours use `c.text` from the theme (`:609`, `:649`, `:685`), which is `#1B1526` in light mode (`constants/theme.ts:217`), on a fixed black background (`:19`, `:569`). The controls are near-invisible in light theme.
  - PiP mode (Mode, `:356-384`) — **2.5/10**. It is not system PiP. It replaces the whole screen with a 170×100 box on black and mounts a new `<Video>` (`:360`), so playback restarts. ✕ stops the video and returns to the full player (`:377`) instead of closing it.
  - "Nothing to play" empty state (State, `:390-412`) — **7/10**. Labelled Go back with a fallback.
- **Strengths:**
  - Has an empty or invalid source state with an exit (`:386-412`).
  - Double-tap seek ripples and speed cycling are real expo-av calls (`:231-249`, `:291-323`).
  - Swipe to dismiss restores portrait first (`:124-142`, `:266-269`).
- **To reach 10/10:**
  1. Fix scrubbing. `seekPanResponder` is built once (`:327-347`) and captures the first-render `seekToPosition`, where `durationMs` is 0, so `seekToPosition` returns early (`:237-239`) and dragging the bar never seeks. Use refs for duration.
  2. Add `onError` to `<Video>` with an error and retry state. Today a bad file spins forever (`:428-438`, `:441-445`).
  3. Restore the orientation lock on unmount (add effect cleanup). Hardware back after fullscreen leaves the app locked in `LANDSCAPE_RIGHT` (`:257-264`).
  4. Save the resume position only on pause or unmount. The cleanup currently re-runs on every `positionMs` change, writing AsyncStorage about four times a second (`:87-94`). Also, `btoa(videoUri)` throws on non-Latin-1 paths (`:75`, `:90`).
  5. Use fixed light colours (or AuroraDark) for the controls instead of `c.text` (`:609-885`). Add `accessibilityLabel`s and Ionicons to every control (`:371-379`, `:478-555`).
  6. Remove the fake PiP, or keep the same `<Video>` instance (`:356-384`). Use `expo-sharing` for http too: `Share.share({url})` is iOS-only (`:274`; see `media-viewer.tsx:215-226`).
  7. Remove the `as any` `__getValue` access (`:150`, `:166`), the unused `Dimensions` import (`:7`) and the unused `SCREEN_W/H` in `useS` (`:37`). Wrap the screen in an ErrorBoundary as the sibling viewers do.

### `app/slideshow.tsx` — Image Slideshow — **4.5/10**
- **Route:** `/slideshow` (`app/_layout.tsx:1013`) · **UNWIRED**: `grep slideshow` across app/, components/, lib/ finds only the Stack registration. It is reachable by deep link alone (`lib/pendingLink.ts:64-67`).
- **Purpose:** Pages through a JSON `images` param, with a thumbnail strip, autoplay, share and save to gallery.
- **Scores:** Function 2 · States 5 · UI 4 · A11y 5 · Security 6 · Code 6
- **Subscreens:**
  - Controls overlay: top bar, thumbnail strip and prev/autoplay/next (Overlay, `:151-218`) — **4.5/10**. Text and icons use `c.text` on fixed `rgba(0,0,0,0.6/0.7)` bars (`:154`, `:204`, `:225-233`), so they are dark-on-dark in light theme. Thumbnails have no labels (`:179`).
  - Empty "No images" state (State, `:117-128`) — **5/10**. The Go Back button has no role or label and uses a hard-coded `#4A9FFF` (`:123-124`).
- **Strengths:**
  - Parses the untrusted route param defensively (`:39-50`).
  - Clears the autoplay timer on unmount (`:59-63`).
  - Uses `permissionDenied` for gallery saves (`:90-91`).
- **To reach 10/10:**
  1. Wire it in (for example from the gallery photo Modal, `app/media-gallery.tsx:440-447`), or delete it.
  2. Clamp `startIdx` to `imageList.length - 1` before `initialScrollIndex` (`:51`, `:142`).
  3. Download remote URIs before `saveToLibraryAsync` and `shareAsync` (`:92`, `:99`). Report share failures instead of swallowing them (`:100`).
  4. Use fixed light colours on the dark bars (`:225-238`), and draw a background in the populated state. It is `'transparent'` (`:224`) with no `AuroraBackground`, unlike the empty state at `:120`.
  5. Add labels and roles to the thumbnails and prev/next/autoplay buttons (`:179`, `:190`, `:194`, `:201`).

### `app/reader.tsx` — Chat Reader — **7.5/10**
- **Route:** `/reader` (modal, `app/_layout.tsx:1008`) · **Entry points:** `components/chat/MessageBubble.tsx:994-997` ("Read as page" chip on long messages)
- **Purpose:** Re-renders a long, already-decrypted message as a typographic page, with reader themes, font, size, spacing, margins and a scroll/pages layout.
- **Scores:** Function 8 · States 7 · UI 8 · A11y 6 · Security 7 · Code 8
- **Subscreens:**
  - Reader settings sheet (Modal, `:142-182`) — **7/10**. Persists through `lib/readerSettings`, and the steppers are labelled (`:224-226`). `Seg` options have no `accessibilityRole`/`accessibilityState` (`:200-207`), the scrim has no label (`:143`), and Reset/Done have no role (`:173-178`).
  - Pages layout mode (Mode, `:128-138`) — **6.5/10**. Prev/next are labelled. Changing page does not scroll to the top, so the new page opens at the old scroll offset (`:130-134`, `:112-139`).
- **Strengths:**
  - The pure logic is in `lib/reader.ts`, with a passing selftest, and is memoised (`:50-52`).
  - Uses safe-area insets (`:100`, `:114`, `:144`), and the status bar matches the reader theme (`:97`).
  - Has an ErrorBoundary (`:252-258`).
- **To reach 10/10:**
  1. Scroll to the top on page change (add a ScrollView ref) (`:130-134`).
  2. Add roles and selected state to the `Seg` chips, and roles to Reset/Done (`:200`, `:173-178`).
  3. Catch `setReaderSettings`/`resetReaderSettings` failures (`:56-58`, `:173`).
  4. Add an empty state for a missing `text` (`:40`; it currently shows "Long message" with 0 words). Remove the unused `width` (`:37`).
  5. Do not carry the decrypted body as a navigation param (`MessageBubble.tsx:996`). Pass a message id and resolve it from the local cache, so plaintext never sits in route or URL state.

### `app/shelf.tsx` — Bookshelf (all shared files) — **6.5/10**
- **Route:** `/shelf` · **Entry points:** `app/(tabs)/mini.tsx:56`
- **Purpose:** Lists every attachment in the local message cache, with kind chips, text filter, sort and per-device pins (`:70-92`).
- **Scores:** Function 6 · States 7 · UI 8 · A11y 6 · Security 4 · Code 8
- **Subscreens:**
  - Kind chips and sort row (Segment, `:140-164`) — **6/10**. Real filtering via `queryShelf` (`:95`). The chips have no `accessibilityRole`/selected state (`:150`), and the sort buttons have no role or state (`:160`).
- **Strengths:**
  - Offline, local-first, with an empty state that explains why the list may be incomplete (`:173-184`).
  - Pin toggles are labelled per file (`:198`). The list is a FlatList (`:169`), and the logic is in `lib/shelf.ts` with a passing selftest.
  - Refreshes on focus (`:84`).
- **To reach 10/10:**
  1. Pass `encrypted`, `isMine` (from `senderId`) and `viewOnce` when opening a file (`:100-107`). `listAllAttachments` drops `meta.encrypted` and `meta.viewOnce` (`lib/localDb.ts:1090-1099`), so E2EE files open without the flag that `media-viewer` needs to avoid the ciphertext-as-file path (`app/media-viewer.tsx:169-172`, `:184`), and view-once media opens unprotected.
  2. Exclude view-once attachments from the shelf (`lib/localDb.ts:1084-1099`).
  3. Show an error when the cache read fails instead of an empty shelf (`:80`).
  4. Add roles and state to the chips and sort buttons (`:150`, `:160`), and an `accessibilityLabel` on the row (`:187`).

### `app/archive-viewer.tsx` — Archive Browser — **6.5/10**
- **Route:** `/archive-viewer` · **Entry points:** `components/chat/MessageBubble.tsx:549-550`, `app/media-viewer.tsx:410`, `app/media-gallery.tsx:291` (via `viewerRouteFor`)
- **Purpose:** Unzips with fflate, lets the user browse folders, and extracts one entry on tap to the cache before handing it to `/file-viewer` (`:111-138`).
- **Scores:** Function 6 · States 6 · UI 8 · A11y 6 · Security 5 · Code 7
- **Subscreens:**
  - Directory browser (List mode, `:167-201`) — **7/10**. Has back-to-parent (`:148`), a per-row busy spinner (`:196-198`) and an empty folder state.
  - Error state (State, `:161-165`) — **5/10**. Has no Retry. A refused or failed entry (`:115`, `:134`) replaces the whole listing with the error.
- **Strengths:**
  - Untrusted entry paths go through `safeEntryPath`, and output is flattened to a basename (`:113-117`, `:122-126`). Covered by `lib/archive.selftest.ts`.
  - Authenticated download (`:56-69`), and raw platform errors are kept off-screen (`:87-100`).
  - `alive` guard and ErrorBoundary (`:52`, `:231-237`).
- **To reach 10/10:**
  1. Check sizes before inflating. `unzip()` decompresses everything into memory (`:73-75`) before `tooLargeToOpen` runs (`:81`), so a zip bomb exhausts memory first. Use fflate's `filter` with `originalSize` to refuse early (`lib/archive.ts:118-121` is the limit).
  2. `lib/docOpen.ts:47`/`:86` route `.rar/.7z/.tar/.gz/.bz2/.xz` here, but only zip is parsed (`:73-75`). Either support them or route them to hand-off with a clear message.
  3. Show entry-level errors as a toast or inline message, not as a replacement of the list, and add Retry (`:115`, `:134`, `:161-165`).
  4. Purge `cache/archive/<name>/` extractions on leave or through `lib/mediaCacheGC.ts` (`:124-131`).
  5. Add an `accessibilityLabel` on rows that names file or folder and size (`:178`). Import `Buffer` explicitly (`:71`, `:129`) instead of relying on the global polyfill (`app/_layout.tsx:83`).

### `app/docscanner.tsx` — Doc Scanner (photo → PDF) — **5.5/10**
- **Route:** `/docscanner` · **Entry points:** `app/(tabs)/mini.tsx:55`
- **Purpose:** ML Kit scan or gallery pick → resize → `expo-print` PDF → saved to `VaultScans/`, with share, a durable outbox send to a picked chat, and a list of recent documents.
- **Scores:** Function 7 · States 6 · UI 6 · A11y 4 · Security 5 · Code 6
- **Subscreens:**
  - Step "pick" with Recent documents (Step, `:292-353`) — **6.5/10**. Has real Scan and Gallery actions. Delete is available only by long-press (`:327`, `:349`), which is undiscoverable for assistive tech.
  - Step "type" (Step, `:356-378`) — **6/10**. Classification is required just to choose an emoji (`:126`). The type cards have no selected state (`:361`).
  - Step "processing" (Step, `:381-394`) — **6/10**. Real per-page progress. Back (`:280`) calls `resetScanner` while `processToPdf` keeps running and later forces `step='preview'` (`:186-189`).
  - Step "preview" (Step, `:397-427`) — **6.5/10**. Share and Send work. The Send button is disabled while `busy` (`:417`) but shows no spinner.
  - Chat picker (Modal, `:435-471`) — **6.5/10**. Has loading, empty and offline alert states (`:218-231`). Rows are text-only, `paddingBottom: 28` is fixed (`:503`), and there is no close button.
  - Delete confirmation (Alert, `:252-260`) — **6/10**. Destructive confirm.
- **Strengths:**
  - Sends through the durable `enqueueMedia` outbox instead of an inline upload (`:202-250`).
  - Moves the PDF out of the evictable cache and names it from the title (`:151-177`).
  - Uses `permissionDenied` and an ErrorBoundary (`:110`, `:481-487`).
- **To reach 10/10:**
  1. Cancel or ignore an in-flight `processToPdf` when the user backs out (`:131-193`, `:280`). Use a run counter as `file-viewer.tsx:337` does.
  2. Make delete a visible action with a label (`:327`, `:340-345`).
  3. Wire or remove the dead camera path: `pickPhoto('camera')` is never called, only `'gallery'` (`:105-111`, `:302`).
  4. Scanned IDs and contracts are written in plaintext to `documentDirectory/VaultScans` (`:168-176`), and titles to AsyncStorage (`:85-88`). Encrypt at rest or document the limitation.
  5. Merge with the camera SCAN pipeline (`app/camera.tsx:210-248`, `lib/docs/pdf.ts`) so there is one scan-to-PDF implementation.
  6. Add roles and selected state to the type cards (`:361`). Drop the emoji-in-title (`:284`) or hide it from the screen reader.

### `app/scanner.tsx` — "VaultScan" Document Scanner (mock) — **2/10**
- **Route:** `/scanner` (`app/_layout.tsx:1037`) · **UNWIRED**: `grep "/scanner"` finds no in-app navigation. The Mini-app "Scanner" tile goes to `/docscanner` (`app/(tabs)/mini.tsx:55`).
- **Purpose:** A three-step Scan/Enhance/Export UI whose export only copies the picked image to a cache file with whatever extension was chosen.
- **Scores:** Function 1 · States 2 · UI 3 · A11y 2 · Security 1 · Code 2
- **Subscreens:**
  - Step 0 Scan (Step, `:245-313`) — **1.5/10**. The tool row buttons have no `onPress` (`:287-292`). The page-count stepper is cosmetic (`:275-283`). Icons are mojibake `"??"` (`:26-50`, `:227`, `:249`).
  - Step 1 Enhance (Step, `:316-390`) — **1/10**. Filters and sliders never touch the image (`:332-363`), and the slider thumb is `display:none` (`:588`).
  - Step 2 Export (Step, `:393-462`) — **1.5/10**. "PDF/DOCX/XLSX/ZIP" is a renamed JPEG copy (`:179-183`). There is a fake 1.2 s delay (`:185`). The crazzychat target only shows an Alert saying "Sending…" and sends nothing (`:187-188`).
  - Done (Step, `:465-486`) — **1/10**. Claims "Sent Successfully!" and "AES-256 Encrypted · Zero Server Storage" (`:468-473`, also `:428`), and none of it is true.
- **Strengths:**
  - Camera permission uses `permissionDenied` (`:138-142`).
  - Theme-aware light/dark style branches (`:494-640`).
- **To reach 10/10:**
  1. Delete the screen and its Stack entry (`app/_layout.tsx:1037`). `app/docscanner.tsx` is the real implementation. At minimum, remove the false encryption and "sent" claims (`:428`, `:468-473`, `:188`), since they misinform users.
  2. If it is kept, implement real format conversion instead of renaming (`:179-183`), and wire or remove every no-op control (`:287-292`, `:332-363`).
  3. Fix the mojibake glyphs (`:26-50`, `:227`, `:235`, `:249`, `:266`, `:271`, `:310`).

### `app/story-viewer.tsx` — Status/Story Viewer — **6.5/10**
- **Route:** `/story-viewer` · **Entry points:** `app/(tabs)/status.tsx:321`, `app/(tabs)/chats.tsx:420`, `app/chat.tsx:3320`
- **Purpose:** Shows one author's active statuses, with E2EE key unwrap, puzzle and question gates, auto-advance, a viewers list and delete for your own statuses.
- **Scores:** Function 8 · States 7 · UI 5 · A11y 4 · Security 8 · Code 6
- **Subscreens:**
  - GateChallenge, puzzle or question (Overlay, `:459-484`; `components/status/GateChallenge.tsx:89-155`) — **5/10**. The answer flow is busy-guarded (`GateChallenge.tsx:64-80`). The background is themed `c.bg` (`:158`), but the title and input text are hard-coded `#fff` (`:160`, `:163`), so it is white-on-light in light theme. Its close button (`:159`, `top:48`) sits under the story top bar (`story-viewer.tsx:620`, `top:56`).
  - Viewers sheet (Overlay, `:560-592`) — **5.5/10**. Has empty and loading states. If `listStoryViews` fails, it shows an Alert but stays on the "Loading…" spinner forever (`:340-345`). There is no hardware-back handling.
  - Error and loading states (State, `:381-400`) — **6/10**. They use `c.bg` (`:608`) with a white spinner and forced `light-content` status bar (`:385`, `:396-397`), which are invisible in light theme.
  - Delete confirmation (Alert, `:353-375`) — **8/10**. Destructive confirm and local removal.
- **Strengths:**
  - While gated, media is never rendered, and the progress clock stops (`:402-414`, `:293`).
  - Marks a story viewed only once its media actually resolved (`:295-300`). Paints cache-first, then revalidates (`:83-130`).
  - Prefetches one story ahead after the current one loads (`:231-269`). ErrorBoundary at `:653-659`.
- **To reach 10/10:**
  1. Accessibility: the tap zones and progress segments have no labels (`:490-501`, `:513-518`), so a screen reader cannot move between stories. Add labelled previous/next actions and `accessibilityLabel="Story i of n"` on segments.
  2. Use a fixed black background for this full-bleed surface (`:608`, `:619`) and white chrome in `GateChallenge` (`GateChallenge.tsx:158`), matching the `statusbar-exempt` intent (`:384`).
  3. Drive video duration from playback status instead of a fixed 15 s (`:56`, `:305`).
  4. Reset `viewers` to `[]` or an error state on failure (`:343-345`). Use safe-area insets for `topBar` and the caption (`:620`, `:630`).
  5. Type `text` and `bgColor` on the story type instead of `(current as any)` (`:421-422`, `:430`).

### `app/whiteboard.tsx` — Whiteboard — **4.5/10**
- **Route:** `/whiteboard` · **Entry points:** `app/chat.tsx:2755` (passes `chatId`)
- **Purpose:** Freehand drawing with pen, eraser, colours, brush sizes, undo and clear, shared as a PNG via the OS share sheet.
- **Scores:** Function 4 · States 5 · UI 6 · A11y 2 · Security 6 · Code 4
- **Subscreens:**
  - Toolbar: pen/eraser/clear, colours, brushes (Panel, `:133-163`) — **3/10**. The tool buttons are emoji-only text with no label (`:136-144`). The colour dots and brush buttons have no label or state (`:150-160`).
  - Clear confirmation (Alert, `:71-76`) — **7/10**. Destructive confirm.
- **Strengths:**
  - Refs avoid stale colour, brush and tool in the PanResponder (`:33-40`, `:57-61`). Stroke commit logic is selftested (`lib/whiteboardStroke.ts`).
  - Header back and actions are restored (`:114-122`), and colours come from theme tokens (`:169-184`).
- **To reach 10/10:**
  1. Implement "share in chat" (`:2`). The `chatId` passed from `app/chat.tsx:2755` is never read, and Share only opens the OS sheet (`:78-84`). Return via the `capturedUri` contract (`app/chat.tsx:2522-2549`).
  2. Draw connected segments or an SVG path instead of one dot View per point (`:90-110`). Fast strokes break up, and every move re-renders all paths (`:51-56`, `:128-129`).
  3. Label the tool, colour and brush controls and add selected state (`:136-160`).
  4. Add redo and a leave guard for unsaved drawings. Show user copy instead of "Make sure react-native-view-shot is installed" (`:86`).
  5. Type `paths`/`currentPath` (`:28-29`, implicit `any[]`). Use insets for the toolbar `paddingBottom: 28` (`:172`).

---

### Shared components rendered by this batch

- `components/DocView.tsx` — Document reader (rendered at `app/file-viewer.tsx:1010`) — **8/10**. Pinch zoom resizes text rather than scaling a bitmap, with a labelled reset pill (`:174-195`, `:290-299`). Column widths are measured from content, and rows are revealed in chunks behind a documented `ponytail:` ceiling (`:48-56`, `:69-80`). Fix: the "Show N more rows" Pressable has a role but no explicit label (`:129-137`). Split sheets into multiple blocks so the outer FlatList can virtualise them (`:48-54`).
- `components/PdfView.tsx` — Native PDF pages (rendered at `app/file-viewer.tsx:947`) — **6.5/10**. Off-UI-thread PdfRenderer, bounded windowing and getItemLayout (`:202-219`). It halves the page size on TOO_LARGE (`:62-89`), and its failure reasons are distinct (`:173-177`). Fixes: there is no zoom gesture, yet the host says "Pinch to zoom" (`app/file-viewer.tsx:955`). iOS always falls back (`:150-153`). The `coverTxt` is white (`:239`) on the themed `c.surfaceSolid` (`:237`), which is `#EAF1FA` in light mode, so it is invisible. Page images have no `accessibilityLabel` (`:98-101`).
- `components/PdfThumbnailer.tsx` — Offscreen PDF thumbnail host (mounted lazily from `app/_layout.tsx:552`; used by `lib/thumbnails.ts:58`) — **6/10**. Lazy mount, a 20 s timeout, and waiters fail when the WebView errors (`:52-59`, `:79`, `:127-131`). Risk: it still runs pdf.js inside a `file:///android_asset` WebView (`:22`, `:116-125`), the configuration `PdfView.tsx:5-16` identifies as falling back to main-thread parsing and ANRs. The comment at `:122` still references the removed PdfView WebView. Fix: render page 1 with `lib/pdfNative.renderPdfPage`.
- `components/ProtectedMediaView.tsx` — VaultView guard (rendered at `app/media-viewer.tsx:494`) — **7.5/10**. Starts blocked until the first guard reading (`:57-60`, `:118-125`). Re-asserts FLAG_SECURE without clearing it (`:64-76`), tiles a watermark with the viewer's identity (`:143-161`), and gives an honest capability status (`:163-178`). Fix: the foreground listener only bumps the timestamp and does not re-query the capture state as its comment claims (`:83-90`). The blocked-state icons are hard-coded hex (`:121`, `:130`).
- `components/chat/ViewerStack.tsx` — "Viewing now" avatar stack (rendered at `app/chat.tsx:3953`, chat header; outside this batch's screens) — **6/10**. The trigger has a count label (`:37`), and the theme is tokenised (`:81-97`).
  - Viewing-now sheet (Modal, `:52-76`) — **5.5/10**. There is no close button (backdrop or back only). The backdrop and the inner `onPress={() => {}}` Pressable have no role or label (`:53-54`). `paddingBottom: 28` is fixed, not inset (`:89`). The activity colour is backed by a text label (`:65-68`), which is good.


---

## G1 — Family Circle

| Screen | Route | Wired? | Score |
|---|---|---|---|
| `app/family.tsx` — Spaces / Family hub | `/family` | Yes | **6/10** |
| `app/family-map.tsx` — Live map / Meet Here / navigation | `/family-map` | Yes | **5.5/10** |
| `app/family-add.tsx` — Invite to space | `/family-add` | Yes | **7/10** |
| `app/family-alerts.tsx` — Family alerts centre | `/family-alerts` | Yes (in-app only; notification taps do not route here) | **7.5/10** |
| `app/family-history.tsx` — Location history | `/family-history` | Yes | **6/10** |
| `app/family-items.tsx` — Find my things (BLE) | `/family-items` | Yes | **6/10** |
| `app/family-member.tsx` — Member detail | `/family-member` | Yes | **6.5/10** |
| `app/family-places.tsx` — Safe Zones | `/family-places` | Yes (permission-gated tile) | **6.5/10** |
| `app/family-setup.tsx` — Create / join circle | `/family-setup` | Yes (one buried row) | **6/10** |

Method: a static read of all nine screens in full, plus all four `components/family/*` files and the lib functions they call (`lib/family/circle.ts`, `lib/groups/store.ts`, `lib/family/history.ts`, `lib/items/api.ts`, `lib/nav/routing.ts`, `lib/push.ts`, `lib/family/notify.ts`, `lib/spaces/layout.ts`). Selftests I ran: `npx tsx lib/a11yCoverage.selftest.ts` passes with "unlabelled: 0 (budget 0)". It checks only **icon-only** touchables, so `<Text onPress>` links and text buttons with no role are outside its scope. `lib/themeCoverage.selftest.ts` and `lib/screenBackCoverage.selftest.ts` also pass. Nothing was run on a device. Visual polish and real-device behaviour are not verifiable statically. OpenSpec `family-navigation/tasks.md:59-72` still lists the device checks (route→navigate, arrival, iOS) as open.

Cross-cutting notes:
- **The family/generic section lists in `lib/spaces/layout.ts:92-100,135-141` are not live entry points.** `family.tsx:1640` renders `sections` only when the space family is *not* `family`/`generic`. Those `/family-map`, `/family-places`, `/family-alerts` and `/family-history` entries are never drawn. The real entry points are the hand-built tiles at `family.tsx:1670-1784`.
- **Notification taps do not open the alerts screen.** Family alerts are shown with `data.type 'family-alert'` and `pressAction 'open-family'` (`lib/family/notify.ts:86,93`). A grep for `open-family` finds no handler. `lib/push.ts:240-257` routes only `call`, `membership`, `games_turn` and `chatId`.
- **Components use React Native `Text`, not `AppText`.** `MeetHereSheet.tsx:15`, `SelectedMemberSheet.tsx:19`, `NavigationLayer.tsx:22` and `FamilyMap.tsx:24` import RN `Text`, so they bypass the brand font and vision-comfort scaling in `components/ui/Text.tsx:28-40`.
- **The map is always light.** `FamilyMap.tsx:780` hard-codes `mapScheme = 'light'`, so every map in this batch shows a light basemap in dark theme.
- **No screen in the batch uses `lib/responsive`.** The grep count is 0 for all 13 files.

---

### `app/family.tsx` — Spaces / Family hub — **6/10**
- **Route:** `/family` · **Entry points:** `app/(tabs)/mini.tsx:51` (Mini Apps tile "Spaces"), `app/_layout.tsx:813` (membership push `member_approved`, with `?groupId=`), `app/group-invitations.tsx:74`, `app/family-setup.tsx:23` (`router.replace`).
- **Purpose:** A multi-space dashboard: greeting, status, map preview, quick tiles, hold-to-SOS, sharing switch, runs, trip card, distances, roster and highlights. It has a full-screen map mode and four modals (`family.tsx:1-7`).
- **Scores:** Function 7 · States 7 · UI 7 · A11y 5 · Security 7 · Code 4
- **Subscreens:**
  - Expanded full-screen map + roster sheet (Mode, `family.tsx:1412-1429`) — **7/10**. Live `FamilyMap`, a labelled collapse button (`:1417`), and the same `memberRow`. Fix: the roster is capped at `maxHeight: 190` (`:1425`), and the map is light-only (`FamilyMap.tsx:780`).
  - Space-type sections grid (Mode, `family.tsx:1640-1663`) — **7/10**. School, office and transport spaces route to real `/space-*` screens with params. Fix: the tiles have no `accessibilityRole` (`:1643-1655`).
  - Check-in sheet (Modal, `family.tsx:2074-2132`) — **7/10**. Choose-then-send (`:2113-2121`), `KeyboardSafe`, and an "I'm OK" ladder answer (`:2125`). Fix: the status tiles have no role or selected state (`:2095-2103`), and the note has no `maxLength` (`:2111`).
  - Announcement sheet (Modal, `family.tsx:2135-2187`) — **8/10**. Busy guard, `maxLength 500`, a server-refusal alert (`:2160-2177`). It is reachable only from the manage sheet when `canAnnounce` (`:2235`). Fix: the Post button has no role or label.
  - Manage sheet (Modal, `family.tsx:2190-2323`) — **6/10**. More than 20 real routes, and leave/delete are confirmed. Fixes:
    - Two near-duplicate rows: "Create or join another group" → `/group-create` (`:2232`) and "Create or join another circle" → `/family-setup` (`:2303`).
    - "Invite from contacts" is not gated by `canInvite` (`:2220`), unlike the header button (`:1407`).
    - None of the `mRow` touchables has a role.
    - The speed-alert `Switch` has no label (`:2298`).
  - Crash-detected countdown (Modal, `family.tsx:2327-2362`) — **5/10**. Countdown, then SOS, with "I'm OK" or "Send SOS now". Problems:
    - The "I'm OK" fill is `rgba(34,197,94,0.20)` under white text (`:2349-2351`) over the light sheet `#FBFAFE` (`constants/spaceTheme.ts:40`). That is very low contrast, and it contradicts the comment at `:2332-2335`, which says "deep green" fills.
    - The Android back button silently cancels the countdown (`:2327`).
  - Member actions dialog (Alert, `family.tsx:1109-1128`) — **6/10**. Real `setGuardian` / `removeCircleMember`, with a removal confirmation (`:1118`). It opens only on long-press (`:1272`), and the row has no `accessibilityActions`, so screen-reader users cannot reach it.
- **Strengths:**
  - Honest loading versus known-empty roster: `membersLoaded` gates "Loading members…" (`:1199-1213`, `:1519`).
  - Permissions start empty and fall back to cached values, never "allow all" (`:250`, `:384-388`). Every unmount-sensitive async path uses a `live`/`cancelled` flag (`:307-334`, `:397-469`).
  - Destructive circle actions are confirmed (`:1152`, `:1162`, `:1118`), and the hub re-arms presence on focus (`:498-501`).
- **To reach 10/10:**
  1. **Send the SOS before any permission prompt.** `fireSos` awaits `toggleShare(true)` (`:969`), which awaits `requestBackgroundPermission()` and `requestIgnoreBatteryOptimizations()` (`:641-642`) before `sendMessage` (`:972`). A system dialog can therefore delay the SOS. Send first, then turn on sharing and show the guidance.
  2. **Make leave and delete report failure.** `leaveCircle` swallows the server error (`lib/family/circle.ts:59`), and `deleteCircle` swallows every per-member removal (`circle.ts:78-82`). The UI then forgets the circle as if it worked (`family.tsx:1155-1156`, `:1166`). Also, `doLeave` has no try/catch (`:1155`).
  3. **Fix the crash modal.** Give "I'm OK" an AA-contrast solid fill (`:2349`). Make `onRequestClose` either a no-op or an explicit "I'm OK" (`:2327`).
  4. **Make the hold-to-SOS usable with a screen reader.** Add `accessibilityRole="button"` and an `accessibilityActions` activate path to the hold-to-SOS `Pressable` (`:1795-1798`). A TalkBack double-tap cannot perform a 1.5 s hold.
  5. **Add roles and labels to text touchables.** Add `accessibilityRole` (and a selected state where relevant) to:
     - the quick tiles (`:1671-1783`)
     - the "New space" chip (`:1481`)
     - the status-card "View All" (`:1525`)
     - the map preview (`:1542`)
     - "+ Invite" (`:1927`)
     - "Today's Highlights" View All (`:2054`)
     - the manage rows (`:2220-2316`)
     - the member row `Pressable` (`:1270`)

     Also label both Switches (`:1339`, `:2298`).
  6. **Show a retry when the roster fails.** A non-403/404 roster failure leaves "Loading members…" forever (`:354-360`, `:1519`). Surface an error with a Retry.
  7. **Split the 2465-line component.** Candidates: the check-in, announcement, manage and crash modals; `memberRow`; the distance/sort block; the runs card. Also compute `currentPlan()` once rather than four times per render (`:1357-1360`), and reduce the 43 `as any` casts (mostly route pathnames).
  8. **Remove duplicated helpers.** `AVATAR_COLORS`/`colorFor` (`:82-83`) and `dist`/`ago` (`:94-101`) are duplicated in `family-member.tsx:39-52` and `family-history.tsx:36`. `formatMetres` already exists (`:76`).

---

### `app/family-map.tsx` — Live map / Meet Here / navigation — **5.5/10**
- **Route:** `/family-map` · **Entry points:** `app/family.tsx:1691-1695` ("Meet Here" tile), `app/family-member.tsx:315-318` ("Follow", with `followId`). The `lib/spaces/layout.ts:93,137` entries are not rendered (see the cross-cutting notes).
- **Purpose:** A standalone read-only live map of the circle. It adds per-member road routes, follow, Meet Here search, family trips, leave-now alarms and turn-by-turn navigation (`family-map.tsx:1-10`).
- **Scores:** Function 7 · States 6 · UI 6 · A11y 4 · Security 6 · Code 5
- **Subscreens:**
  - `FamilyMap` WebView engine (Component, `components/family/FamilyMap.tsx`; used at `family-map.tsx:704`) — **7/10**.
    - Good: MapLibre runtime fallback to Leaflet (`FamilyMap.tsx:820-828`), style retry ×8 (`:558-564`), memoised 1 MB source (`:781-790`), clustering (`:653-672`).
    - Fixes: light-only basemap (`:780`); `originWhitelist={['*']}` (`:802`); no text alternative for markers.
  - `MeetHereSheet` (Sheet, `family-map.tsx:1035-1046` → `components/family/MeetHereSheet.tsx`) — **7/10**.
    - Good: debounced geocode with a sequence guard against stale results (`MeetHereSheet.tsx:64-84`); one matrix call with index alignment (`:87-104`); an honest straight-line fallback notice (`:233-240`).
    - Fixes:
      - Result rows have no role (`:204-208`).
      - "Clear search" has no role (`:159`).
      - The close button target is only `padding: 4` (`:139`).
      - "Start family trip here" broadcasts to the whole circle with no confirmation (`:296-304` → `family-map.tsx:651-658`).
  - `SelectedMemberSheet` (Sheet, `family-map.tsx:740-773` → `components/family/SelectedMemberSheet.tsx`) — **7/10**.
    - Good: labelled 44 dp actions with selected/disabled state (`SelectedMemberSheet.tsx:61-79`, `:154-159`).
    - Fix: the "Routes" FAB (`family-map.tsx:928-940`, `bottom: chipsBottom`, rendered later in the JSX) is drawn over this absolutely positioned sheet (`SelectedMemberSheet.tsx:142-146`).
  - `NavigationLayer` (Overlay, `family-map.tsx:775-798` → `components/family/NavigationLayer.tsx`) — **6/10**.
    - Good: labelled buttons, a polite live region (`NavigationLayer.tsx:184`), arrival card.
    - Fixes:
      - The `thenEvent`/`topInset` props are never passed (`family-map.tsx:775-798` vs `NavigationLayer.tsx:44,64`).
      - The search bar renders after the layer at `top: 8` (`family-map.tsx:802-807`), so it covers the maneuver capsule (`NavigationLayer.tsx:91,275`).
      - The dock (`bottom ≈ chipsBottom+12`, full width, `:92,276`) overlaps the "Routes" FAB (`family-map.tsx:933`).
      - Device verification is still open (`openspec/changes/family-navigation/tasks.md:59-72`).
  - Trip bar and Leave-now bar (Overlay, `family-map.tsx:872-923`) — **5/10**.
    - Good: real `startTrip`/`endTrip`, with an end confirmation (`:663-671`); an AlarmManager leave alarm (`:521-529`).
    - Fixes:
      - END/LEAVE/JOIN/CLEAR are bare `<Text onPress>` at 11–12 px with no role or hitSlop (`:884`, `:904`).
      - `leaveTrip`/`joinTrip` have no error handling (`:673-677`).
  - Route, turn and follow bars (Overlay, `family-map.tsx:963-1032`) — **5/10**. Real `fetchRoute` and nav start/stop. Fix: NAVIGATE, STOP NAV, CLEAR and STOP are role-less `<Text onPress>` (`:994-1012`, `:1025-1030`).
  - Saved-place chips (Overlay, `family-map.tsx:830-868`) — **6/10**. Labelled with selected state (`:840-843`). Fix: they sit at `searchTop + 52` (`:831`), outside the slot system (`:561-568`), so the follow bar or leave bar at `searchTop + 46` overlaps them.
  - Roster sheet (Sheet, `family-map.tsx:1048-1157`) — **6/10**. Honest freshness labels (`:61-69`), trip ETAs and published references. Fixes: an endless spinner if `circleMembers` fails (`:157-159`, `:1049-1050`), and Route/Follow/focus are role-less text links (`:1088-1116`).
- **Strengths:**
  - Read-only by design: it reads the OS last-known position and never prompts or publishes (`:8-10`, `:124-146`).
  - Every async effect is cancellation-guarded (`:148-211`, `:277-304`). Re-routing is keyed on coordinates, not object identity (`:301-304`, `:333-334`).
  - Road-versus-straight-line figures are always labelled (`:289-291`, `:374-378`). The overlay "slot" stacking is computed from the bars actually on screen (`:540-576`).
- **To reach 10/10:**
  1. **Fix the overlay collisions.** Put the place-chip row, the nav capsule and the bottom FABs into the same slot model. Hide the search bar, place chips and Routes/From-Home FABs while `navBanner.active` (`:802`, `:830`, `:927`, `:946`), and pass `topInset` to `NavigationLayer`.
  2. **Replace the 14 `<Text onPress>` controls.** Use `TouchableOpacity` with `accessibilityRole="button"`, a label and a hitSlop of at least 44 dp (`:884`, `:904`, `:994-1030`, `:1088-1116`). Make the nested clear icon its own labelled touchable outside the search bar (`:815-817`); a screen reader cannot reach it today.
  3. **Add an error state with Retry.** Do this for `circleMembers` (`:157-159`). Catch `Promise.all(getPlaces, getDefaultRef)` (`:238`) and `leaveTrip`/`joinTrip` (`:673-677`).
  4. **Confirm before starting a circle-wide trip** (`:651-658`), since it changes every member's map.
  5. **Reconsider routing every member to the backend.** Always-on routes send each member's decrypted position to the routing backend on every 250 m move (`:366-381`). Either use the single `/nav/matrix` call the hub already uses (`family.tsx:910-911`) and draw shapes only on request, or document this egress in the space privacy copy.
  6. **Pass `thenEvent` from the nav banner or drop the prop** (`NavigationLayer.tsx:44-45`), and drop the per-member `mrCache` + `mrVersion` ref/state pairing in favour of a single state map (`:360-389`).

---

### `app/family-add.tsx` — Invite to space — **7/10**
- **Route:** `/family-add` · **Entry points:** `app/family.tsx:956-959` (header person-add `:1407`, "+ Invite" `:1927`, manage row `:2220`), `app/group-info.tsx:264`.
- **Purpose:** Pick existing DM contacts and send consent-based invitations, with a share-a-code fallback (`family-add.tsx:1-24`).
- **Scores:** Function 8 · States 8 · UI 7 · A11y 4 · Security 6 · Code 8
- **Subscreens:** None. Only the system Share sheet (`:147`) and Alerts.
- **Strengths:**
  - It invites rather than adds: one `createInvitation` per person, so one failure does not lose the rest (`:113-141`). The consent rationale is at `:9-15`.
  - Loading, empty, error-bar, no-match and busy states are all present (`:213-251`). Existing members are shown but cannot be selected (`:71-73`, `:96`, `:160`).
  - Virtualised `FlatList` (`:225-231`). Themed styles through `makeStyles(colors)` (`:45`, `:257`).
- **To reach 10/10:**
  1. **Make contact rows real checkboxes.** Give them `accessibilityRole="checkbox"` and `accessibilityState={{ checked: sel, disabled: isMember }}` with a name label (`:159-163`). Add roles to the address-book row (`:207`), the share-code row (`:235`) and the CTA (`:240`). The file has 0 `accessibilityLabel`s.
  2. **Bound the shared invite code.** `circleInviteCode` mints a code that never expires and has unlimited uses for a location-sharing group (`lib/family/circle.ts:31-33`). Use a bounded expiry and use count, and confirm before sharing. This also contradicts the hub's claim that the forwardable code is gone (`family.tsx:950-955`).
  3. **Add a Retry to the error bar** (`:213`). It currently only states the error.
  4. **Use the shared space background.** Use `SpaceGround`/`useSpaceGlass` as the sibling family screens do (`family-alerts.tsx:19`, `family-setup.tsx:11`), instead of `AuroraBackground` and `colors.bg` (`:186`, `:189`).

---

### `app/family-alerts.tsx` — Family alerts centre — **7.5/10**
- **Route:** `/family-alerts` · **Entry points:** `app/family.tsx:1446` (bell), `:1741` (Alerts tile), `:2054` (Highlights "View All"). Not reachable from a family-alert notification tap (`lib/family/notify.ts:86,93`; no `open-family` handler found).
- **Purpose:** A device-local typed inbox of family events with All/Important/System filters, severity tint, mark-read on open and clear (`:1-10`).
- **Scores:** Function 7 · States 7 · UI 8 · A11y 6 · Security 8 · Code 9
- **Subscreens:**
  - Filter tabs (Tab, `:117-128`) — **8/10**. Role and selected state set (`:122`).
  - Clear-history confirm (Dialog, `:89-95`) — **8/10**. Destructive style and "this device only" copy.
- **Strengths:**
  - `SectionList` grouped Today/Yesterday/Earlier, virtualised (`:78-87`, `:130-134`).
  - Read receipt on focus, debounced and cleaned up (`:73-76`). Labelled header icon button (`:110`).
  - Consistent space theming tokens (`:101`, `:106-108`, `:123`).
- **To reach 10/10:**
  1. **Route notification taps here.** Handle notifee `pressAction 'open-family'` / `data.type 'family-alert'` and open `/family-alerts?circleId=` (`lib/family/notify.ts:86,93`). Today a tap only opens the app.
  2. **Add a loading state.** `loadAlerts()` is async (`:71`), and the empty state "No alerts yet" (`:135-143`) can show before the store loads.
  3. **Make rows readable to a screen reader.** Give rows `accessibilityRole="button"` and a label that includes the unread state. Unread is currently shown only by a colour dot and font weight (`:149-167`).
  4. **Skip navigation for system rows.** Only push `/family-member` for kinds that have a real member actor (`:151-154`).

---

### `app/family-history.tsx` — Location history — **6/10**
- **Route:** `/family-history` · **Entry points:** `app/family.tsx:1772-1775` (History tile, gated by `canHistory`, no `userId`), `app/family-member.tsx:404-407` (per member).
- **Purpose:** Day/Week/Month view of the device-local track, with the path on a map, stats, segmented trips and an alert timeline (`:1-9`).
- **Scores:** Function 5 · States 6 · UI 8 · A11y 6 · Security 5 · Code 7
- **Subscreens:**
  - Range tabs (Tab, `:179-190`) — **8/10**. Role and selected state.
  - Locked "Not shared with you" view (Mode, `:194-201`) — **8/10**. The load is withheld, not just the render (`:110-113`).
  - Trips list with per-trip map focus (Mode, `:243-274`) — **6/10**. Rows have no role or selected state (`:249-253`).
- **Strengths:**
  - The permission gate runs before `getTrack`, so a denied viewer never loads or uploads others' tracks (`:89-113`).
  - Honest empty map and empty timeline copy (`:209-214`, `:278-281`). Trips are re-derived on read (`:147`).
  - Consistent tokens and a native header (`:172-175`).
- **To reach 10/10:**
  1. **Stop merging every member's track in the circle-wide view.** From the hub no `userId` is passed (`family.tsx:1774`), so `getTrack` returns every member's samples merged by time (`lib/family/history.ts:149-150`). Distance (`:122`), trips (`:147`) and the path (`:148-152`) are then computed across interleaved people. Either require a member picker or draw one path per member.
  2. **Fix the "nothing uploaded" claim.** The header says nothing here was ever uploaded (`:8-9`), but `fetchTraceDistance` POSTs the polyline to `/nav/trace` (`:137-138`; `lib/nav/routing.ts:249-251`). Correct the copy, or make map-matching opt-in.
  3. **Decide whether unknown permissions should fail open.** `historyAccess(g) !== 'denied'` treats `'unknown'` as allowed (`:96`; `lib/groups/store.ts:116-119`). Keep that deliberately, or fetch `getChat` permissions before revealing others' history.
  4. **Wrap the focus loader in try/catch.** On a throw the spinner stays forever (`:81-118`). Set an error state with Retry.
  5. **Add accessibility to trip rows and the map.** Give trip rows a role and selected state (`:249-253`), and give the map card an `accessibilityLabel` summary (`:205-207`).
  6. **Reuse `formatMetres`** (`lib/family/distance`) instead of the local `dist` copy (`:36`).

---

### `app/family-items.tsx` — Find my things (BLE) — **6/10**
- **Route:** `/family-items` · **Entry points:** `app/family.tsx:1761-1763` (the "Find Things" tile; rendered only for family/generic spaces, `:1640`, `:1664`).
- **Purpose:** Pair BLE tags, run a hot/cold finder from smoothed RSSI, and record and share last-seen sightings with the space (`:1-10`).
- **Scores:** Function 4 · States 6 · UI 6 · A11y 6 · Security 6 · Code 7
- **Subscreens:**
  - Nearby-devices discovery list (Mode, `:343-373`) — **6/10**. Fix: cards have no role or label (`:352-356`).
  - Pairing panel (inline Sheet, `:376-407`) — **5/10**. The icon picker is labelled (`:391`). Problems:
    - It renders at the bottom of the ScrollView, below up to 12 discovery rows, and is not a Modal, so it can appear off-screen after tapping PAIR.
    - Cancel and Save have no role (`:399-404`).
    - `doPair` has no error handling (`:210-216`).
  - Remove-item confirm (Dialog, `:307-324`) — **7/10**. Destructive style; reports a local-only removal (`:316-321`).
- **Strengths:**
  - Every BLE failure path tells the user something (`:123-151`), and a dropped scan is surfaced (`:140-146`).
  - The scan render storm is throttled to one state write per 800 ms (`:87-121`). The scanner is destroyed on unmount (`:160`).
  - Partial failures of shared registration are surfaced rather than swallowed (`:217-229`, `:424-430`).
- **To reach 10/10:**
  1. **The "Left-behind alerts" switch does nothing.** It persists `leftBehindAlerts` (`:421-433`), but nothing imports `observeItem`/`leftBehindText` from `lib/items/leftBehind.ts:57,88`; a repo grep finds only the self-check. Either wire it to the scan loop and geofence exits, or remove the switch.
  2. **Report and show other members' tags.** The sighting loop iterates only local `items` (`:190-196`), and `shared` is used only to annotate local items (`:291`). Tags shared by other members are never reported when heard and are never listed, which contradicts `:178-180` and the footer (`:437-441`).
  3. **Sightings send plaintext coordinates to the server.** `reportSighting` POSTs `lat`/`lng` to `/chats/:id/items/sighting` (`lib/items/api.ts:71-74`; called at `:181`). That conflicts with the family "server never sees a location" promise (`family-setup.tsx:54`). Send only `placeName`, or seal the coordinates.
  4. **Move pairing into a Modal and handle its errors.** Use a `<Modal>` with `KeyboardSafe` (`:376`), add try/catch and a busy guard to `doPair` (`:210`) and to the remove handler (`:309-310`), and add `circleId` to the `rememberSighting` dependencies (`:183`).
  5. **Label the remaining controls.** Label the left-behind `Switch` (`:421`) and give roles to the discovery cards and pairing buttons (`:352`, `:399`, `:402`).

---

### `app/family-member.tsx` — Member detail — **6.5/10**
- **Route:** `/family-member` · **Entry points:** `app/family.tsx:1273-1276` (roster row tap), `app/family-alerts.tsx:151-154` (alert row).
- **Purpose:** One member's status, battery, actions (Message/Call/Route/Follow/History), relationship label, today's stats and timeline, GPS quality and safe-zone status (`:1-11`).
- **Scores:** Function 7 · States 6 · UI 7 · A11y 7 · Security 6 · Code 6
- **Subscreens:**
  - Withheld/locked state (Mode, `:383-396`, `:449`) — **8/10**. It explains the lock instead of inventing "0 m travelled".
  - Relationship chips (Picker, `:413-442`) — **8/10**. Optimistic save that reverts on failure (`:95-107`), with role, state and label.
  - Route-to-stale-fix confirm (Dialog, `:296-303`) — **8/10**.
- **Strengths:**
  - Decide-then-fetch permission gating, so a denied viewer never loads or uploads the track (`:130-141`).
  - Labelled action tiles (`:321-326`). Freshness-tiered status text that is never "Online" on an old fix (`:358-366`).
  - An `alive` ref stops state writes after blur (`:78-80`, `:142`, `:150-156`). Message/Call has a double-tap guard (`:270-281`).
- **To reach 10/10:**
  1. **Wrap `pull()` in try/catch.** A failing `getPlaces`/`getGroup` leaves the spinner forever and throws an unhandled rejection every 15 s from the interval (`:112-118`, `:150-156`). Set an error state with Retry.
  2. **Hide Message and Call on your own row.** The hub opens this screen for yourself (`family.tsx:1275`), and Message/Call then call `createDirectChat` with your own id (`:270-277`, `:400-401`).
  3. **Throttle the `/nav/trace` POST.** `trackKey` changes with every new sample, and the screen polls every 15 s (`:38`, `:150-156`, `:197-214`), so a moving member's whole day is re-POSTed about every 15 s. Debounce it (for example, once per N new samples or per minute).
  4. **Review the unknown-permission rule.** As in history, unknown permissions are treated as allowed (`:130`).
  5. **Remove duplicated helpers.** `AVATAR_COLORS`/`colorFor`/`ago`/`dist` (`:39-52`) duplicate `family.tsx:82-101`. Also add a label to the guardian star icon (`:356`).

---

### `app/family-places.tsx` — Safe Zones — **6.5/10**
- **Route:** `/family-places` · **Entry points:** `app/family.tsx:1727-1738` (Safe Zones tile, gated by `canZones`).
- **Purpose:** Manage device-local geofences: add by GPS, address or `lat, lng`; per-place on/off; edit radius, schedule and lifetime; pick a reference place; lock or unlock through the shared Location Lock; navigate (`:1-14`).
- **Scores:** Function 7 · States 6 · UI 8 · A11y 4 · Security 7 · Code 7
- **Subscreens:**
  - Edit-place sheet (Modal, `:398-542`) — **6/10**.
    - Good: `KeyboardSafe` inside the Modal (`:405`), a height cap with scroll (`:411-414`), radius validation (`:243-248`), and the reference name follows a rename (`:251-254`).
    - Fixes:
      - The lifetime chips never show a selected non-permanent choice: `on` is always `false` for timed options (`:486`).
      - Chips and day letters have no role, state or label (`:431`, `:446`, `:463-471`).
      - Save and Delete have no error handling (`:255`, `:199`).
  - Lock-radius-adjusted confirm and Unlock confirm (Dialog, `:227-230`, `:233-238`) — **8/10**.
  - Delete-place confirm (Dialog, `:191-203`) — **8/10**. It clears the reference choice (`:198`).
- **Strengths:**
  - Place coordinates stay on the device; only a crossing result is shared (`:3-5`, `:324-334`). Delete and unlock are confirmed.
  - Location permission is requested in context, with `permissionDenied` guidance (`:146-149`). The geocoder falls back from server to platform for no-GMS phones (`:156-164`).
  - `KeyboardSafe` is used at both screen and Modal level (`:269`, `:405`), with consistent glass tokens.
- **To reach 10/10:**
  1. **Make the chips and rows accessible.** Add `accessibilityRole` and `accessibilityState={{selected}}` to the radius chips (`:297-301`, `:431-435`), schedule presets (`:446`), lifetime chips (`:488`) and day chips. Day chips need full-name labels, because "S"/"T" are ambiguous (`:463-471`). Add a role and label to the place rows (`:368`) and a label to each row `Switch` (`:391`).
  2. **Fix the lifetime selection.** Store the chosen lifetime key, not just an absolute `expiresAt`, so the selected chip can render (`:485-495`).
  3. **Handle persistence errors.** `persist` failures are unhandled in `toggle`, `remove` and `saveEdit` (`:136-140`, `:188-189`, `:199`, `:255`). Revert the state and alert.
  4. **Validate typed coordinates.** `COORD_RE` accepts any number (`:44`, `:154-155`); reject latitudes outside ±90 and longitudes outside ±180.
  5. **Correct the privacy copy.** The address query is sent to the server geocoder (`:160`). The "no coordinate leaves the phone" header (`:3-5`) should also say that typed addresses are looked up server-side.
  6. **Remove the unused `Platform` import** (`:20`).

---

### `app/family-setup.tsx` — Create / join circle — **6/10**
- **Route:** `/family-setup` · **Entry points:** `app/family.tsx:2303` (manage-sheet row "Create or join another circle", with no `from` param). The hub's zero-space redirect goes to `/group-create`, not here (`family.tsx:286`, `:566`), so the comment at `family-setup.tsx:19-21` is out of date.
- **Purpose:** Create a named circle or join one with an invite code (`:1-2`).
- **Scores:** Function 3 · States 7 · UI 8 · A11y 6 · Security 6 · Code 5
- **Subscreens:** None (Alerts only).
- **Strengths:**
  - Busy guard per action, and disabled buttons with empty input (`:26-41`, `:63`, `:85`).
  - `KeyboardSafe` + `ScrollView keyboardShouldPersistTaps` (`:44`, `:50`). Consistent space glass tokens and a native header (`:45-48`).
  - Points to the typed-group flow (`:67-75`).
- **To reach 10/10:**
  1. **A created circle never appears in the hub.** Three things combine:
     - `createCircle` makes an untyped group and writes only the legacy key (`lib/family/circle.ts:13-17`; `lib/family/store.ts:10,28-31`).
     - `listGroups` reads that legacy key only once, at the first migration (`lib/groups/store.ts:155-163`).
     - The hub adopts only chats that have a `groupType` (`family.tsx:149`).

     Fix: create through the typed `/group-create` path, or call `saveGroup({... groupType: 'family'})` after `createCircle`/`joinCircle`.
  2. **Handle pending and already-member joins.** `joinCircle` ignores `pending`/`alreadyMember` from `joinViaInvite` (`lib/chatService.ts:2176-2179`; `circle.ts:20-28`) and reports success anyway. Tell the user when approval is pending.
  3. **Stop stacking a second hub.** `done()` calls `router.replace('/family')` when `from !== 'family'` (`:23`). The only caller does not pass `from` (`family.tsx:2303`), so a second `/family` instance is stacked on the first. Pass `from: 'family'` or use `router.back()`.
  4. **Make the hero copy accurate.** "The server never sees a location" (`:54`) is contradicted by item sightings (`lib/items/api.ts:71-74`) and `/nav/trace` uploads (`family-history.tsx:137-138`).
  5. **Add accessibility roles and labels.** Give the create, join and other-group buttons `accessibilityRole="button"` (`:63`, `:69`, `:85`), and give the inputs labels beyond the placeholder (`:60`, `:82`). Remove the unused `Platform` import (`:7`).


---

## G2 — Location, Navigation & Safety

| Screen | Route | Wired? | Score |
|---|---|---|---|
| `app/location.tsx` | `/location` | Yes (chat attach menu) | 6.0 |
| `app/location-sharing.tsx` | `/location-sharing` | **UNWIRED** (only from an unrendered component) | 4.5 |
| `app/current-location.tsx` | `/current-location` | **UNWIRED** | 4.5 |
| `app/navigate.tsx` | `/navigate` | Yes (mini-apps, chat, family, shops, lock) | 6.0 |
| `app/location-lock.tsx` | `/location-lock` | Yes (navigate, family-places, notifications) | 5.5 |
| `app/lock-alert.tsx` | `/lock-alert` | Yes (lock service + notification tap) | 6.0 |
| `app/lock-history.tsx` | `/lock-history` | Yes (location-lock) | 6.0 |
| `app/lock-settings.tsx` | `/lock-settings` | Yes (location-lock) | 6.0 |
| `app/emergency-sos.tsx` | `/emergency-sos` | Yes (family, deep link) | 4.5 |
| `app/trusted-contacts.tsx` | `/trusted-contacts` | Partly (only from SOS empty state) | 6.0 |
| `app/aiguardian.tsx` | `/aiguardian` | Yes (mini-apps "Security Hub") | 7.0 |

Evidence runs (read-only): `npx tsx lib/screenBackCoverage.selftest.ts` → "all screen-exit checks passed"; `lib/a11yCoverage.selftest.ts` → "unlabelled: 0 (budget 0)"; `lib/themeCoverage.selftest.ts` → "23 assertions passed"; `lib/responsiveCoverage.selftest.ts` → passed. Those guards are file-level regex scans. Two problems below get past them: the location-lock setup face and the white-on-white text in emergency-sos.

---

### `app/location.tsx` — Share location (chat) — **6/10**
- **Route:** `/location` · **Entry points:** `app/chat.tsx:2749` (attach-menu "Location", passes `chatId`, `name`); declared at `app/_layout.tsx:1040`.
- **Purpose:** Sends a one-shot location message, or starts a timed, encrypted live-location relay to the current chat (`location.tsx:112-189`).
- **Scores:** Function 7 · States 6 · UI 6 · A11y 4 · Security 7 · Code 6
- **Subscreens:**
  - Permission-denied state (Mode, `location.tsx:191-205`): **6/10**. It offers Open settings and Back, but nothing re-checks permission after the user comes back from Settings. Fix: re-request permission on AppState `active`.
  - Live-sharing mode (Mode, `location.tsx:251-261`): **5/10**. Leaving the screen ends sharing, because the unmount cleanup calls `stopLive` (`:108`), and every update carries the address from the start of the session (`:163`). Fix: move the live session into a service that outlives the screen, and re-geocode or drop `address` from the updates.
  - LocationMap (component, `location.tsx:223-229` → `components/LocationMap.tsx`): **8/10**. Its denied, locating, loading, failed and retry states are honest (`LocationMap.tsx:185-226`). Fix: add `accessibilityRole` to "Try again" (`:217`).
- **Strengths:**
  - Real end-to-end path: `sendMessage(chatId, …, 'location')` (`location.tsx:120`). Live updates are AES-GCM encrypted with a per-session key (`:147-165`, `lib/liveLocationCrypto.ts:30-41`), and the server relays them without storing (`vaultchat-backend/server.js:876-886`).
  - Caches the last fix so the map opens in the right place (`location.tsx:34, 94, 100`).
  - The labelled back button has a `hitSlop` (`location.tsx:213`).
- **To reach 10/10:**
  1. Guard `startLive` against a double tap. The button is only disabled while `loading` (`location.tsx:285`), but `sendMessage` is awaited (`:149`). A second tap sends a second live message and overwrites `watchRef` (`:169`), which leaks the first watcher.
  2. Make the copy at `location.tsx:288-291` ("updates while crazzychat is open") true, or change it. Sharing actually stops as soon as the screen unmounts (`:108`).
  3. Send the current address with each fix, or none. `pushUpdate` closes over the address from session start (`location.tsx:163`).
  4. On a GPS error (`:102-103`) the card stays on "Getting your location…" (`:62`) and nothing offers a retry. Add a retry button.
  5. A11y: give the duration chips `accessibilityRole="radio"` and `accessibilityState={{selected}}` (`:276-282`), and give the primary buttons and "Navigate here" a role (`:242, 258, 265, 285`).
  6. Render `<AuroraBackground/>` on the main face as well as the denied face (`:194` only), remove the unused `Platform` import (`:21`) and the `back` style (`:303`), and replace `e: any` (`:122, 152, 177`).
  7. Merge this screen with `app/location-sharing.tsx`, which re-implements the same feature (same `newLiveKey`/`encryptPosition`/`sendMessage` flow at `location-sharing.tsx:122-145`).

### `app/location-sharing.tsx` — Location Sharing (3-mode) — **4.5/10**
- **Route:** `/location-sharing` · **Entry points:** **UNWIRED**. The only reference is `components/VaultFeatureSheet.tsx:36`, and `VaultFeatureSheet` is not imported by any file except `lib/responsiveLayout.selftest.ts:237` (grepped the whole repo, excluding node_modules). Declared at `app/_layout.tsx:984`. It is reachable only by typing a deep link.
- **Purpose:** A picker for Current, Live (timed) or Until I stop, then a duration step, then an active screen (`location-sharing.tsx:37-38`).
- **Scores:** Function 4 · States 4 · UI 6 · A11y 3 · Security 5 · Code 5
- **Subscreens:**
  - Mode picker (Step, `:241-280`): **4/10**. When there is no `chatId`, every card is disabled (`:269`). Mode cards have no role. The "Until I Stop" card starts sharing immediately (`:267`).
  - Duration step (Step, `:202-239`): **3/10**. For "Current Location" the duration is fake. `until` is only set when `isLive` (`:123, 129`), so the chosen time only decides when the screen auto-closes (`:103-108`). Fix: skip this step for snapshots.
  - Active screen (Step, `:168-200`): **4/10**. In manual mode, unmounting only removes the watcher (`:93`) and never emits `live_location_stop` (that happens only in `cleanup`, `:96-100`), so peers keep the live banner. Fix: call `cleanup()` in the unmount effect.
  - Loading overlay (Overlay, `:160-166`): **6/10**. Acts as a de facto double-submit guard.
  - LocationMap (component, `:176, 256`): **8/10**. See location.tsx.
- **Strengths:**
  - Uses safe-area-context `SafeAreaView` and documents why (`:19-23`).
  - Coordinates travel in E2E message content, not in plaintext meta (`:125-130`).
  - Shows a map preview before sharing (`:256-261`).
- **To reach 10/10:**
  1. Wire it up, or delete it in favour of `/location` (see the duplication note under location.tsx). Today no reachable control opens it.
  2. Wrap `getCurrentPositionAsync` (`:82`). It sits outside the `try` that starts at `:85`, so a rejection becomes an unhandled promise and the map waits on "Waiting for a GPS fix…" forever.
  3. Emit the stop event on unmount (`:93` vs `:96-100`).
  4. Stop requesting background location permission (`:135`). Only a foreground `watchPositionAsync` runs (`:136`), so the screen asks for "Allow all the time" and never uses it.
  5. Remove the duration step for Current (`:202-239`).
  6. A11y: add roles to the text "Back" buttons (`:208, 245`), the mode cards (`:269`) and the duration cards, and give the cards `accessibilityState.selected` (`:219, 225`).
  7. Type `socketRef` (`:70`, `any`) and remove the unused `Platform` import (`:17`).

### `app/current-location.tsx` — Current Location snapshot — **4.5/10**
- **Route:** `/current-location` · **Entry points:** **UNWIRED**. I grepped `current-location` in app/, components/, lib/, services/, hooks/, constants/, app.json and lib/pendingLink.ts. The only hit is the `INSET_SCREENS` entry at `app/_layout.tsx:210`.
- **Purpose:** Gets a high-accuracy GPS fix, shows lat/lng/altitude/accuracy, and shares it as a location message (`current-location.tsx:48-105`).
- **Scores:** Function 3 · States 5 · UI 5 · A11y 4 · Security 6 · Code 5
- **Subscreens:**
  - Pre-fetch mode (Mode, `:123-150`): **5/10**. Shows a denied-state map when permission was refused (`:127-131`). The emoji icons have no accessibility handling.
  - Result mode (Mode, `:152-200`): **5/10**. Uses honest `reading()` filtering of 0/null values (`:26-27`), but "Share to Chat" has no sending or disabled state (`:188`).
- **Strengths:**
  - `reading()` refuses to show Android's 0 as a real altitude or accuracy (`:21-27`).
  - Uses the shared `permissionDenied` helper with `canAskAgain` (`:54`).
- **To reach 10/10:**
  1. Wire it or delete it. It duplicates `/location`'s one-shot send (`location.tsx:112-127`).
  2. Remove the double top inset. The screen is in `INSET_SCREENS` (`app/_layout.tsx:210`, which applies `paddingTop: HEADER_TOP` at `:915-921`) and also hard-codes `paddingTop: Platform.OS === 'ios' ? 56 : 44` (`current-location.tsx:209`).
  3. Add a `sharing` state with a disabled button to `shareLocation` (`:81-105`, `:188`) so a double tap can't send twice.
  4. Fix the stale header comment "sends via Firestore chat message" (`:3`). Remove the unused `setShared` state (`:42`) and the commented `RED` (`:19`).
  5. A11y: add roles to Get, Share and Refresh (`:136, 188, 196`). The emoji `Text` at `:117, 130, 147, 161, 184` should be hidden from screen readers or labelled. The back button is 36pt with `hitSlop={4}` (`:113, 210`), which is under 44pt.
  6. Use `c.primary` instead of `c.purple` for the CTA (`:220`) to match the sibling screens.

### `app/navigate.tsx` — Navigate (turn-by-turn) — **6/10**
- **Route:** `/navigate` · **Entry points:** `app/(tabs)/mini.tsx:45` (opened via `:85-88`, behind the `mini.navigate` flag); `lib/nav/openNavigation.ts:15-23`, called from `app/chat.tsx:2750, 3710`, `app/location.tsx:242`, `app/family.tsx:1321`, `app/family-member.tsx:301,305`, `app/group-trip.tsx:127,140`, `app/shop-book.tsx:4862`; `app/location-lock.tsx:174`; `app/lock-alert.tsx:50`.
- **Purpose:** Destination search, route preview with alternatives, haptic/voice guidance settings, then live navigation against Valhalla (`navigate.tsx:1-4`).
- **Scores:** Function 6 · States 6 · UI 7 · A11y 4 · Security 7 · Code 6
- **Subscreens:**
  - Setup mode (Mode, `:187-311`): **6/10**. Has real geocoding and a preview map. The route-option chips do not refresh the preview (see 2).
  - Active navigation mode (Mode, `:153-185`): **6/10**. Has a labelled Reroute button, an End button and a progress bar. The instruction is drawn twice, in NavBanner (`NavBanner.tsx:45-47`) and in the sheet (`navigate.tsx:167-169`).
  - Route alternative chips (Tab, `:256-270`): **3/10**. Selecting "Alt N" only changes the preview (`:263-266`). `start()` never passes the choice (`:126`), `StartNavOpts` has no route field (`lib/nav/navigationService.ts:78-83`), and `startNavigation` fetches its own primary route (`:271`).
  - NavBanner (Overlay, `components/nav/NavBanner.tsx:30-65`): **6.5/10**. Reads well and uses theme tokens. It has no `accessibilityLiveRegion` or announcement, so screen-reader users never hear manoeuvres, and distances are metric only (`:21-24`).
  - NavMap (component, `components/nav/NavMap.tsx:284-453`): **6.5/10**. MapLibre with a style retry (`:267-280`). The basemap is forced to light (`:388`) even in dark theme. The Leaflet downgrade has no basemap (`RASTER_FALLBACK_URL = ''`, `lib/map/tileProvider.ts:56`) and only logs a `console.warn` (`NavMap.tsx:420`), with no user-visible notice. FAB and zoom buttons have labels but no `accessibilityRole` (`:431, 435, 442, 447`).
- **Strengths:**
  - Server-proxied type-ahead with a 350 ms debounce, plus a "lat, lng" fast path (`:89-109`). Deep-link params are `isFinite`-checked (`:79-84`).
  - Native header is enabled explicitly, with the reason recorded (`:147-148`). Buttons use `minHeight` for font scaling (`:323-339`).
  - Route chips appear only for alternatives Valhalla actually returned (`:50-52, 256`).
- **To reach 10/10:**
  1. Pass the selected alternative into `startNavigation` (`navigate.tsx:126`; `navigationService.ts:78-83, 271`), or remove the chips.
  2. Add `s.routeOpts` to the preview effect's dependencies (`navigate.tsx:78`). Toggling Shortest or Avoid tolls during setup does not re-fetch the preview (`setRouteOpt` only re-routes when `banner.active`, `:135`).
  3. The "Custom" vibration profile (`:26`) has no editor anywhere: `setNavSettings` is only called from navigate.tsx. `custom` defaults to `{}` (`lib/nav/navSettings.ts:21`) and `hapticLanguage.ts:112` returns `custom?.[event]`, so choosing Custom gives no vibration at all. Hide it until there is an editor.
  4. Fix the suggestion race. An in-flight `geocodeSearch` that resolves after a newer query still calls `setSugs` (`:93-99`). Guard it with a request id or a cancelled flag.
  5. Range-check typed coordinates. The regex at `:108-109` accepts `999, 999` as a destination.
  6. A11y: add `accessibilityRole` and `accessibilityState.selected` to `Chip` (`:138-143`). Add roles to Find (`:220`) and the suggestion rows (`:225`). Add `accessibilityLiveRegion="polite"` to the instruction in NavBanner (`NavBanner.tsx:45`).
  7. Use the theme's success token instead of hard-coded `#22C55E` (`:191-194`). Key suggestions by coordinates, not by index (`:225`). Pass the theme scheme to NavMap (`NavMap.tsx:388`).

### `app/location-lock.tsx` — Location Lock (setup / active) — **5.5/10**
- **Route:** `/location-lock` · **Entry points:** `app/navigate.tsx:190` (behind `LOCATION_LOCK = true`, `constants/flags.ts:256`); `app/family-places.tsx:527`; `app/lock-alert.tsx:63, 102`; notification tap at `lib/lock/lockService.ts:466`.
- **Purpose:** Pick a point and radius and arm an on-device geofence. While armed it shows live status, the map, unlock, alarm stop and navigate-back (`location-lock.tsx:1-9`).
- **Scores:** Function 6 · States 5 · UI 6 · A11y 5 · Security 7 · Code 5
- **Subscreens:**
  - Setup face (Mode, `:306-454`): **5/10**. Its `Stack.Screen` sets only `title` (`:310`), with no `headerShown: true`. The root stack hides headers (`app/_layout.tsx:912`) and the screen is not in `INSET_SCREENS` (`:208-222`), so this face has no native header or back control and no status-bar inset. `screenBackCoverage` passes only because `headerShown: true` appears in the active face (`:197`).
  - Active face (Mode, `:189-304`): **6/10**. The live stats are real (`lockService.ts:245-254`). The map's "you" marker is stale (see 2).
  - Background-protection Alert (Dialog, `:146-150`): **7/10**. Asks for consent first, then `enableKillSafe`.
  - Battery-optimization Alert (Dialog, `:155-160`): **7/10**.
  - Unlock confirm Alert (Dialog, `:167-172`): **8/10**. A destructive-style confirmation that explains the consequence.
  - NavMap with lock circle, pin drop, compass and zoom (component, `:228-238, 366-377`): **6.5/10**. See navigate.tsx.
- **Strengths:**
  - Real engine: `armLock` checks GPS services and permission and returns a reason (`lockService.ts:286-292`). Unlock records the session (`:425-452`).
  - The accuracy guard warns when radius < 2× accuracy and suggests a value (`location-lock.tsx:176, 416-424`), as spec.md:22-31 requires.
  - Unlock asks for confirmation (`:167-172`). Key buttons are labelled (`:281, 443`).
- **To reach 10/10:**
  1. Add `headerShown: true` to the setup face's `Stack.Screen` (`:310`), as the active face does at `:197`.
  2. Show the live position on the active map. `pos: myPos` (`:229`) is only set once on mount (`:94`) or by "Current location" (`:111`), and `LockView` has no position field (`lockService.ts:40-59`). That breaks spec "Live lock map" (`openspec/changes/location-lock/specs/location-lock/spec.md:78-79`).
  3. Add a `catch` to `arm()` (`:140-164`, try/finally only). `armLock` can reject at `getCurrentPositionAsync` (`lockService.ts:294`) and the user gets no feedback.
  4. In grace phase the alarm bar is announced as a "Stop alarm" button but its `onPress` is `undefined` (`:199-203`). Make it non-interactive, or change the label, while `grace`.
  5. Surface failures from navigate-back. `navigateBackToLock(...).catch(() => {})` and then pushing `/navigate` (`:174`) can land the user on an empty setup screen.
  6. Tell the user when location permission is denied on mount (`:91-92` returns silently). Add a busy state to `useCurrent` (`:107-118`).
  7. Perf: the 1 s ticker (`:70, 101-105`) re-renders the whole screen and rebuilds the `data={{…}}` literal (`:229`), so NavMap's geo effect re-injects `setPos` every second (`NavMap.tsx:323-336`). Memoize `data` or move the ticker into a `Stat` child.
  8. A11y: add role and selected state to the Chips, mode chips and radius presets (`:182-187, 382-392`), and to Current, Drop-pin, Find and Test (`:314, 318, 335, 436`). Type `colors: any` (`:457`).

### `app/lock-alert.tsx` — Location Lock exit alarm — **6/10**
- **Route:** `/lock-alert` · **Entry points:** `lib/lock/lockService.ts:192` (pushed when the alarm fires in the foreground); `lib/lock/lockService.ts:466` (notification press); in `INSET_SCREENS` (`app/_layout.tsx:215`).
- **Purpose:** A full-screen flashing alarm with distance outside the zone, Stop Alarm and navigate-back. It turns green once the user is back inside (`lock-alert.tsx:1-5`).
- **Scores:** Function 7 · States 6 · UI 6 · A11y 4 · Security 7 · Code 7
- **Subscreens:**
  - Alarm mode (Mode, `:71-106`): **6/10**. After Stop Alarm the phase is `'silenced'` (`lib/lock/alarmController.ts:146`), so the `else` branch shows "Alarm starts in moments — head back now" (`lock-alert.tsx:86-93`), which is false. Fix: add a separate silenced message.
  - Safe mode (Mode, `:54-69`): **7/10**. The Done button falls back to `replace('/location-lock')` when there is no back stack.
- **Strengths:**
  - Restores the lock session on a cold full-screen-intent launch (`:28-30`).
  - The flash animation is cleaned up and gated on the user's `flash` setting (`:33-42`).
  - The safety-critical nav row wraps on 320dp screens, with the reason recorded (`:132-137`).
- **To reach 10/10:**
  1. Fix the misleading text after silencing (`:86-93`).
  2. Surface navigate-back failures. `navigateBackToLock(...).catch(() => {})` followed by `router.replace('/navigate')` (`:48-51`) hides routing errors.
  3. A11y: add `accessibilityRole="button"` to Done, Stop Alarm, the NavBtns and "Back to lock screen" (`:63, 87, 113, 102`). Make the big status text an `accessibilityLiveRegion="assertive"` region (`:75-76`). Honour `lib/useReducedMotion.ts` for the full-screen flash (`:36-41`).
  4. Move the hard-coded alarm palette (`#7F1D1D`, `#DC2626`, `#FECACA`, `:46, 88, 103, 122-137`) into named constants. Only `c.glassSoft` uses the theme (`:87`). Type `icon: any` (`:109`).

### `app/lock-history.tsx` — Lock History & Statistics — **6/10**
- **Route:** `/lock-history` · **Entry points:** `app/location-lock.tsx:296` (active face), `:449` (setup face).
- **Purpose:** Local SQL session list with filters, today/7/30-day stats, a 7-day trend, an expandable timeline with notes, CSV/JSON export, and delete (`lock-history.tsx:1-5`).
- **Scores:** Function 7 · States 5 · UI 6 · A11y 3 · Security 7 · Code 7
- **Subscreens:**
  - Export format Alert (Dialog, `:79-85`): **6/10**. Errors are swallowed with `catch {}`.
  - Delete-all confirm (Dialog, `:87-92`): **7/10**. Destructive style, and the copy says it cannot be undone. No try/catch around `clearAllHistory`.
  - Per-session delete confirm (Dialog, `:94-99`): **5/10**. Reachable only by long-press (`:185`).
  - Expanded timeline + note editor (Mode, `:205-237`): **5/10**. Saving gives no feedback or error handling (`:228-231`). The previous session's `events` show until `getEvents` resolves (`:72-77`).
- **Strengths:**
  - `FlatList` with header and empty components (`:174-183`).
  - Local only. `lockStore` has no network calls (grep for `fetch|api(` in `lib/lock/lockStore.ts` found nothing).
  - Deletions ask for confirmation (`:87-99`).
- **To reach 10/10:**
  1. Add loading and error states. `reload().catch(() => {})` (`:70`) shows "No lock sessions yet" (`:179-183`) both while loading and after a failure.
  2. Show event distances in the user's units. `{Math.round(e.distance)} m` (`:213`) ignores `settings.units`, but spec.md:138-143 requires imperial in history.
  3. A11y: give per-session delete a visible control, or `accessibilityActions` with `onAccessibilityAction`. Long-press only (`:185`) can't be found with a screen reader. Add `accessibilityRole`, `accessibilityState.expanded` and a hint to the session cards (`:185`), and selected state to the Chips (`:101-106`).
  4. Paginate. `getSessions` caps results at 100 (`lib/lock/lockStore.ts:188`) and the screen never says so.
  5. Handle failures in note save and clear-all (`:90, 230`). Hoist the `max` out of the trend map (`:136`).

### `app/lock-settings.tsx` — Alarm & Alert Settings — **6/10**
- **Route:** `/lock-settings` · **Entry points:** `app/location-lock.tsx:292` (active), `:428` (setup).
- **Purpose:** Units, monitoring mode, custom sensitivity, background/battery, tracking cadence, alert channels, volume, tone, pattern, grace, repeat, tests and About (`lock-settings.tsx:1-5`).
- **Scores:** Function 7 · States 5 · UI 7 · A11y 4 · Security 6 · Code 6
- **Subscreens:**
  - Custom sensitivity panel (Mode, `:85-98`): **7/10**. Real persisted values.
  - Repeat-interval chips (Mode, `:190-194`): **7/10**.
  - Android battery-exemption row (`:117-130`): **7/10**. Errors are swallowed.
- **Strengths:**
  - Every change persists and is applied live to an armed lock (`:41-46`, `lockService.ts:388-396`).
  - Real test actions: full alarm, voice and vibration (`:196-204`).
  - Native header enabled explicitly (`:71-72`). `minHeight` used for scaling (`:237-240`).
- **To reach 10/10:**
  1. Correct the privacy copy. "the only network call is to crazzychat's own routing engine" (`:214-216`) leaves out the geocoding proxy (`lib/nav/geocode.ts:12`, used by `location-lock.tsx:128`) and the basemap tile host `tiles.openfreemap.org` (`lib/map/tileProvider.ts:24`). Spec.md:145-147 names the permitted calls.
  2. Don't show "Background tracking" as ON when no lock is active. The value is hard-coded `true` while disabled (`:110-111`), but arming can end with `killSafe: false` (`location-lock.tsx:145`).
  3. A11y: give every `Switch` an `accessibilityLabel`, or link it to its row text (`:52, 109, 183`). Add selected state to the Chips (`:61-66`).
  4. Surface persistence failures instead of `.catch(() => {})` (`:42, 45`). Remove `as any` (`:54`). Use theme tokens for the `'#999'` thumbs (`:56, 114, 187`).
  5. Add the version to About, as spec.md:138-139 requires (`:210-223`).

### `app/emergency-sos.tsx` — Emergency SOS — **4.5/10**
- **Route:** `/emergency-sos` · **Entry points:** `app/family.tsx:979, 1706, 2306`; `lib/spaces/layout.ts:94` (`route: '/emergency-sos'`); deep link `vaultchat://emergency-sos` (`lib/pendingLink.selftest.ts:31`); `INSET_SCREENS` (`app/_layout.tsx:211`). The file's own note says the route was not navigating on a device as of 2026-09-20 (`emergency-sos.tsx:68-72`). Whether that is still true is not verifiable statically.
- **Purpose:** Hold-to-SOS (or shake 3×) runs a 5 s countdown, then sends `POST /user/sos` to the selected trusted contacts, with history (`emergency-sos.tsx:1-4, 238-256`).
- **Scores:** Function 6 · States 5 · UI 3 · A11y 3 · Security 5 · Code 4
- **Subscreens:**
  - Default / SOS button (Mode, `:315-335`): **4/10**. Long-press only, with no role, label or hint (`:320-329`).
  - Countdown (Mode, `:285-293`): **6/10**. Has a cancel. The interval is cleared on unmount (`:103-105`).
  - Sending (Mode, `:294-299`): **6/10**.
  - Sent (Mode, `:300-314`): **5/10**. Shows `selectedContacts.length` (`:305`) and ignores the server's returned `contactsNotified` (`:246`; `vaultchat-backend/routes/user.js:183`). It does warn when no location was sent (`:306-310`).
  - Shake detection (Mode, `:139-199`): **3/10**. The listener lives for the whole mount, not just while focused. With `/trusted-contacts` pushed on top (`:362`), three shakes still start a countdown the user can't see. The duplicate trigger logic (`:142-177` vs `:207-256`) also re-subscribes the accelerometer on every countdown tick, because `countdown` is a dependency (`:199`).
  - SOS contacts selector (Mode, `:354-383`): **4/10**. Rows have no checkbox role or state, and the check is shown by colour and icon only (`:368-380`).
- **Strengths:**
  - `sosFix` never blocks or throws. It races a 6 s fix against the last-known position and documents the bug it replaces (`:34-66`).
  - Real backend: `sendSOS` → `POST /user/sos` (`lib/chatService.ts:1340-1344`), which pushes to trusted contacts and records the event (`vaultchat-backend/routes/user.js:146-183`).
  - Fixes the countdown timer leak on unmount (`:100-105`).
- **To reach 10/10:**
  1. Remove the temporary `console.warn('[sos-probe] …')` instrumentation at module scope and inside render (`:68-76`). It runs on every render.
  2. Fix legibility. A white→`#0D0A18`→white `LinearGradient` covers the whole screen (`:270`), while the title, section headers and names are hard-coded `#FFF` (`:418, 434, 443, 453, 462, 469, 481`), so the header and history text is white on white. Use theme tokens.
  3. Remove the double inset: `INSET_SCREENS` (`app/_layout.tsx:211`) plus the screen's own `paddingTop: 56/40` (`:415`).
  4. Gate shake detection on focus with `useFocusEffect` (`:139-199`). Merge `triggerSOSInEffect` and `startCountdownFromShake` into `triggerSOS` and `startCountdown` (`:142-177` vs `:207-256`).
  5. Don't turn a load failure into the empty state. `listTrustedContacts` errors are swallowed (`:128`) and the screen then says "No trusted contacts set up" (`:359-365`). In an emergency that misleads the user and blocks sending. Show an error with a retry.
  6. Show the server's `contactsNotified` (`:246, 305`).
  7. A11y: on the SOS button (`:320`) add `accessibilityRole="button"`, `accessibilityLabel="Send emergency SOS"`, a hint "Double-tap and hold", and an `accessibilityActions` alternative. Add role and state to the ON/OFF toggle (`:344-351`) and the contact rows (`:368`). Announce the countdown (`:289`).
  8. Delete the dead `SOS_MESSAGE`/`TEST_MESSAGE` (`:23-27`) and replace the `any[]` state (`:82, 92`).

### `app/trusted-contacts.tsx` — Trusted Contacts — **6/10**
- **Route:** `/trusted-contacts` · **Entry points:** `app/emergency-sos.tsx:362` only, and only when the list is empty (`:359`). Once one contact exists, no in-app path leads here to add or remove contacts. I grepped app/ and app/(tabs) for `trusted` push/route/href. Declared at `app/_layout.tsx:973`.
- **Purpose:** List, add (by VaultID) and remove up to 3 emergency contacts against `/contacts/trusted` (`trusted-contacts.tsx:1-4`).
- **Scores:** Function 5 · States 7 · UI 7 · A11y 5 · Security 5 · Code 7
- **Subscreens:**
  - Add-by-VaultID form (Mode, `:144-166`): **6/10**. Disabled while searching (`:158`). The Add button has no role and the form gives no inline validation.
  - Remove confirm (Dialog, `:72-82`): **8/10**. Destructive confirmation with optimistic removal and rollback (`:76-79`).
- **Strengths:**
  - Cache first, with an alert only on a cold load (`:36-53`).
  - The max of 3 is enforced on the client (`:58`) and the server (`vaultchat-backend/routes/contacts.js:223-225`).
  - Uses `FlatList`, `HEADER_TOP` and theme tokens (`:110, 180-209`).
- **To reach 10/10:**
  1. Add a permanent entry point, such as an "Edit contacts" link in the SOS contacts section (`emergency-sos.tsx:356`) and a Settings/Security row.
  2. Remove the claims about alerts that don't exist. The copy says contacts are notified "when your account is accessed from a new device" (`:102, 170`). Grepping `trusted_contacts` in both backends finds only SOS dispatch (`vaultchat-backend/routes/user.js:154`, `vaultchat-backend-go/internal/routes/user.go:594`), CRUD and account deletion. No new-device alert exists.
  3. A11y: label the Remove button with the contact's name (`:123`). Add a text or accessibility equivalent for the colour-only online dot (`:122`). Add a role to Add and Add-confirm (`:138, 158`).
  4. Validate the VaultID format on the client before the request (`:56`). `replace('@','')` only strips the first `@`.

### `app/aiguardian.tsx` — Security Hub — **7/10**
- **Route:** `/aiguardian` · **Entry points:** `app/(tabs)/mini.tsx:60` (opened via `:85-88`, behind the `mini.security` flag); declared at `app/_layout.tsx:1022`.
- **Purpose:** A thin renderer over the tested device-security core. It scans, scores risk 0–100, lists checks and actions, and links to the security log (`aiguardian.tsx:1-12`).
- **Scores:** Function 8 · States 6 · UI 8 · A11y 5 · Security 8 · Code 8
- **Subscreens:**
  - Scan-result Alert (Dialog, `:62-67`): **7/10**. Lists actions, or gives an honest "clean ≠ safe" caveat.
  - Checks list (Mode, `:129-150`): **8/10**. Shows "Not evaluated" instead of a fake "clear" (`viewModel.ts:22`). The status is text, not colour only.
- **Strengths:**
  - All the logic lives in pure, selftested modules (`services/security/deviceSecurity/*.selftest.ts`). The screen only renders the view model (`:42-48`).
  - Double-scan guard and error alert (`:52-74`).
  - A permanent disclosure says what the scan cannot detect (`:153-161`).
- **To reach 10/10:**
  1. Handle `load()` rejections. `useFocusEffect(... load())` (`:50`) and the `finally { load() }` (`:72`) have no catch, so a secure-store failure becomes an unhandled rejection with a stale view.
  2. A11y: give the score ring a single label, e.g. "Risk 20 of 100, Low" (`:92-95`). Add `accessibilityRole="button"` and `accessibilityState={{busy: scanning}}` to Run scan (`:101`), and a role to "View full security log" (`:163`).
  3. Move the hard-coded severity colours `#EF4444`/`#F59E0B` (`:117`) into the view model next to `statusColor`.


---

## H — Spaces (Operations)

| Screen | Route | Wired? | Score |
|---|---|---|---|
| app/space-admin.tsx | /space-admin | Yes | 6/10 |
| app/space-attendance.tsx | /space-attendance | Yes | 5/10 |
| app/space-checkin.tsx | /space-checkin | Yes | 5.5/10 |
| app/space-devices.tsx | /space-devices | Yes (admin console only) | 4.5/10 |
| app/space-incidents.tsx | /space-incidents | Yes | 5.5/10 |
| app/space-leave.tsx | /space-leave | Yes | 6/10 |
| app/space-ops-map.tsx | /space-ops-map | Yes | 5.5/10 |
| app/space-overview.tsx | /space-overview | Yes | 6/10 |
| app/space-pending.tsx | /space-pending | Yes | 5.5/10 |
| app/space-people.tsx | /space-people | Yes | 6/10 |
| app/space-roster.tsx | /space-roster | Yes | 6/10 |
| app/space-run-driver.tsx | /space-run-driver | Yes | 5/10 |
| app/space-run.tsx | /space-run | Yes | 6/10 |
| app/space-runs-admin.tsx | /space-runs-admin | Yes | 4.5/10 |
| app/space-tasks.tsx | /space-tasks | Yes | 6/10 |
| app/space-transport.tsx | /space-transport | Yes | 6.5/10 |
| app/space-visitors.tsx | /space-visitors | Yes | 5.5/10 |

### How users reach the Spaces area (shared context)
- Mini tab "Spaces" tile → `/family` (`app/(tabs)/mini.tsx:51`); notification tap → `/family` (`app/_layout.tsx:813`); invitation accept → `/family` (`app/group-invitations.tsx:74`).
- On `/family`, a school/office/transport space renders type-specific section tiles from `sectionsFor()` (`app/family.tsx:774-777`, `app/family.tsx:1640-1653`), defined as data in `lib/spaces/layout.ts:102-132`. Family/generic spaces render their own tiles instead (`app/family.tsx:1640`, else-branch at `:1661`), so the FAMILY/GENERIC `checkin` sections (`lib/spaces/layout.ts:95,138`) are never drawn.
- Manage sheet: Admin console (`app/family.tsx:2248`), Attendance (`:2255`), Roster (`:2263`). Driver auto-redirect to their started run (`app/family.tsx:798-805`), driver run card (`:1822-1825`), run rows (`:1864`), Map link (`:1852`).
- No deep-link handler in `app/_layout.tsx` or `lib/pendingLink.ts` references any `/space-*` route (grep of both files for `space-` returned nothing).
- Header pattern: every screen uses `spaceHeader()` (`lib/spaces/theme.ts:60-82`), which sets `headerShown: true` (back chevron) and, when given a chat target, mounts `ChatDoorButton` (`components/spaces/ChatDoorButton.tsx:24-41`, role+label+44pt min target). Screens that pass their own `headerRight` (roster, devices, runs-admin, visitors) lose the chat door (`lib/spaces/theme.ts:72-74`).
- `components/spaces/SpaceGround.tsx` is NOT rendered by any screen in this batch (grep: only `app/family*.tsx` import it). Batch screens use `AuroraBackground`, but in 13 of 17 screens it is mounted only in the loading branch; the loaded view has none (e.g. `app/space-attendance.tsx:123` vs `:131`, `app/space-pending.tsx:64` vs `:72`). Only admin (`:120`), leave (`:199`), tasks (`:174`) and transport (`:168`) mount it in the loaded view. Root `contentStyle` is opaque `colors.bg` (`app/_layout.tsx:912`), so the effect is a flat ground after loading, not see-through.
- Selftests run (all pass): `lib/a11yCoverage.selftest.ts` (0 unlabelled icon-only buttons, budget 0; it checks only icon-only touchables), `lib/themeCoverage.selftest.ts`, `lib/responsiveCoverage.selftest.ts`, `lib/screenBackCoverage.selftest.ts` (`spaceHeader` counts as an exit), `npx tsx lib/spaces/layout.ts`, `lib/spaces/runHeartbeat.selftest.ts`, `scripts/check-space-identity.ts`.
- Unused spaces APIs (no caller anywhere in `app/`, `components/`, `lib/` outside `lib/spaces/api.ts`): `addLink`/`removeLink` (`lib/spaces/api.ts:80-84`), `setShift` (`:345`), `setDutyState` (`:155`), `setLeaveAllowance` (`:290`), `updateDevice` (`:329`). So space links, shift windows, duty state, leave allowances and device archiving cannot be configured from the app.

---

### `app/space-admin.tsx` — Space admin console — **6/10**
- **Route:** `/space-admin` · **Entry points:** `app/family.tsx:2248`; section tiles `lib/spaces/layout.ts:111,122,131` (pushed by `app/family.tsx:1645-1653`); `app/space-transport.tsx:208`; `app/space-overview.tsx:405`
- **Purpose:** Hub for a space's operators: scope statement, derived run tiles, SOS banner and a permission-filtered list of ops screens (`app/space-admin.tsx:47-61`, `:182-223`).
- **Scores:** Function 7 · States 5 · UI 7 · A11y 4 · Security 7 · Code 6
- **Subscreens:**
  - Emergency banner (Overlay, `app/space-admin.tsx:143-153`) — **6/10** — real open-SOS check that routes to incidents, but hard-coded `#fff` icon/text and no `accessibilityRole`. Fix: add role/label and use a token.
  - Derived run tiles (`app/space-admin.tsx:159-178`) — **6/10** — computed by `tilesForType` from real runs, but a failed fetch looks the same as "Nothing running yet" (`:89-91`, `:170-178`). Fix: track the error separately.
  - Chat door (header, `app/space-admin.tsx:122` via `lib/spaces/theme.ts:75-80`) — **8/10** — labelled, role, 44pt (`components/spaces/ChatDoorButton.tsx:35-37`).
- **Strengths:**
  - Draws only tiles the caller can use and forwards `perms`/`canManage` on every push (`app/space-admin.tsx:185`, `:194-206`).
  - Runs, roster and incident fetches go to real endpoints and fail independently (`app/space-admin.tsx:88-92`).
- **To reach 10/10:**
  1. Show an error with retry when `getRuns`/`getRoster`/`getIncidents` fail, instead of turning failures into empty data (`app/space-admin.tsx:89-91`). Add pull-to-refresh to the `ScrollView` (`:121`).
  2. Add `accessibilityRole="button"` and a label that includes the badge count to the entry rows (`app/space-admin.tsx:191-207`) and the SOS banner (`:144`).
  3. Replace the N+1 `getRun` per run (`app/space-admin.tsx:96-99`) with the server summary already used by overview (`getOpsSummary`, `lib/spaces/api.ts:208`).
  4. Add the missing Leave and Tasks entries, which exist as office sections (`lib/spaces/layout.ts:118-119`) but not in `ENTRIES` (`app/space-admin.tsx:47-61`). Add entries for the unused configuration APIs listed above (links, shift, leave allowance).
  5. Remove `as any` on pathnames (`app/space-admin.tsx:146`, `:195`).

### `app/space-attendance.tsx` — Location-derived attendance — **5/10**
- **Route:** `/space-attendance` · **Entry points:** `app/family.tsx:2255`; `app/space-admin.tsx:55`
- **Purpose:** Builds on-device present/late/absent/unknown states for each member from location samples crossing the space's first safe zone (`app/space-attendance.tsx:67-105`).
- **Scores:** Function 4 · States 5 · UI 5 · A11y 3 · Security 7 · Code 5
- **Subscreens:**
  - Per-member week disclosure (inline expand, `app/space-attendance.tsx:187-200`) — **5/10** — the day dots are distinguished by colour only (`:191`), and the row toggle has no role or expanded state (`:166-170`).
- **Strengths:**
  - "No data" is reported as unknown, not absent, and computed figures are not uploaded, as `openspec/changes/spaces-operations/specs/space-attendance/spec.md:18-20,53-56` requires (`app/space-attendance.tsx:210-220`, `:247-255`).
  - Clear empty states for a missing zone or shift (`app/space-attendance.tsx:134-152`).
- **To reach 10/10:**
  1. Supply a shift window. The screen reads it only from route params (`app/space-attendance.tsx:58-65`), but neither entry point passes one (`app/family.tsx:2255`, `app/space-admin.tsx:194-206`) and `setShift` has no caller (`lib/spaces/api.ts:345`). As a result, "late", "left early" and "absent" are never computed, and the card's advice to "Set one in the space's settings" (`:147-149`) points at a setting that does not exist. Read the shift from the server and add an editor.
  2. Fetch member tracks in parallel. Today it awaits one `getTrack` per member inside a loop (`app/space-attendance.tsx:83-84`), so N members means N sequential round trips. Also add an error state; right now everything is caught to `[]` (`:71-72`, `:84`).
  3. Let the user choose the workplace zone instead of using `places[0]` (`app/space-attendance.tsx:77`).
  4. Mount `AuroraBackground` in the loaded view (`app/space-attendance.tsx:131`), add `accessibilityRole="button"` and `accessibilityState={{expanded}}` to rows (`:166`), and give each week dot a text or label alongside its colour (`:190-193`).

### `app/space-checkin.tsx` — Check in / out and leave — **5.5/10**
- **Route:** `/space-checkin` · **Entry points:** `lib/spaces/layout.ts:116` (office tile via `app/family.tsx:1645`); `app/space-admin.tsx:54`; `app/space-overview.tsx:248,385,399`
- **Purpose:** Declared check-in/check-out, a leave list with approve/reject, and today's team record (`app/space-checkin.tsx:87-122`).
- **Scores:** Function 7 · States 5 · UI 6 · A11y 4 · Security 6 · Code 6
- **Subscreens:**
  - Request-leave modal (Modal, `app/space-checkin.tsx:248-280`) — **5.5/10** — validates format and order (`:105-106`) under KeyboardSafe, but dates are free text and default to the UTC date (`:285`). Fix: native date picker plus a local date.
- **Strengths:**
  - Real check-in, check-out and leave endpoints, with server errors passed through (`app/space-checkin.tsx:87-115`).
  - The check-in button disappears after check-out instead of moving the arrival time (`app/space-checkin.tsx:165-169`).
- **To reach 10/10:**
  1. Fix the wrong accessibility labels. The leave approve/reject icons say "Approve check-in"/"Reject check-in" (`app/space-checkin.tsx:206`, `:209`).
  2. Stop turning load failures into empty data, which then shows "No leave requested" (`app/space-checkin.tsx:70-71`, `:181`). Show an error with retry and add pull-to-refresh.
  3. `today()` uses `toISOString()`, which gives the UTC date, so near midnight the default leave dates are wrong (`app/space-checkin.tsx:285`). Use local date parts.
  4. Confirm before Reject and Withdraw (`app/space-checkin.tsx:197`, `:206`).
  5. Remove the duplicated leave UI. It overlaps `app/space-leave.tsx`, with different leave kinds (`:35-40` vs `app/space-leave.tsx:38`). Link to `/space-leave` instead.
  6. Add role/state to the "Request" link and kind chips (`app/space-checkin.tsx:176`, `:255-261`), and mount Aurora in the loaded view (`:137`).

### `app/space-devices.tsx` — Devices and theft protection — **4.5/10**
- **Route:** `/space-devices` · **Entry points:** `app/space-admin.tsx:60` only
- **Purpose:** List space devices, show their history, and queue remote ring/lock/message/photo/wipe commands (`app/space-devices.tsx:51-57`, `:113-143`).
- **Scores:** Function 3 · States 5 · UI 5 · A11y 4 · Security 5 · Code 6
- **Subscreens:**
  - Device detail (full-screen Modal, `app/space-devices.tsx:228-313`) — **4/10** — the commands it queues are never executed by any client (see fix 1). The header uses a hard-coded `paddingTop: 54` (`:431`), and the non-transparent modal's root is `transparent` (`:229`, `:416`).
  - Add-device modal (Modal, `app/space-devices.tsx:316-349`) — **6.5/10** — trimmed, `maxLength`, disabled while busy (`:321-342`). Kind chips have no selected state.
  - Show-a-message modal (Modal, `app/space-devices.tsx:352-373`) — **4/10** — the UI is fine, but the message it queues is never delivered (fix 1).
- **Strengths:**
  - Wipe requires a destructive confirmation (`app/space-devices.tsx:130-139`).
  - Copy is honest that a command is a request, not a result (`app/space-devices.tsx:118-122`, `:288-291`).
- **To reach 10/10:**
  1. Implement the device side. No app code polls `GET …/devices/{id}/commands`, calls the ack route, or posts a heartbeat. The only references to commands are `lib/spaces/api.ts:336-343` and this screen, while the backend defines `PATCH …/commands/{cmdId}` and `POST …/heartbeat` (`vaultchat-backend-go/internal/routes/spaces_devices.go:55,61`) and says the device "collects it from GET /commands on its next connection" (`:490-491`). Today every command stays "Waiting" forever and `lastSeenAt` never updates, so the copy promising it "runs the next time this device connects" (`app/space-devices.tsx:121`) is not backed by code.
  2. Confirm Lock and Capture photo before sending; only wipe is confirmed (`app/space-devices.tsx:142`). Explain what "Capture photo" does to whoever holds the device.
  3. Use safe-area insets instead of `paddingTop: 54` (`app/space-devices.tsx:431`), give the detail modal an opaque ground (`:229`), and mount Aurora in the loaded view (`:158`).
  4. Add archive/rename through `updateDevice`, which has no caller (`lib/spaces/api.ts:329`).
  5. Add `accessibilityRole="button"` to device rows and action rows (`app/space-devices.tsx:188`, `:264-273`), and `accessibilityState` to kind chips (`:325`).

### `app/space-incidents.tsx` — Incident queue — **5.5/10**
- **Route:** `/space-incidents` · **Entry points:** `lib/spaces/layout.ts:110,130`; `app/space-admin.tsx:56,146`; `app/space-overview.tsx:147,400,403`
- **Purpose:** Lists incidents with SOS first, and lets the user acknowledge or resolve them (`app/space-incidents.tsx:72-94`).
- **Scores:** Function 6 · States 5 · UI 6 · A11y 4 · Security 5 · Code 7
- **Subscreens:** None
- **Strengths:**
  - Sorts open SOS first and keeps resolved incidents visible (`app/space-incidents.tsx:72-77`).
  - Per-row busy guard (`app/space-incidents.tsx:159`, `:167`).
- **To reach 10/10:**
  1. Hide Acknowledge/Resolve from non-ops viewers. The school and transport "Alerts" tiles have no `needs` (`lib/spaces/layout.ts:110,130`), so parents and drivers see buttons (`app/space-incidents.tsx:153-174`) that the screen's own header says the server refuses (`:16-17`). Gate them on `perms` as the leave and tasks screens do.
  2. Confirm before Resolve (`app/space-incidents.tsx:164-168`).
  3. After a load error, show an error card with retry instead of an Alert followed by "Nothing reported" (`app/space-incidents.tsx:60-61`, `:112-120`). Add pull-to-refresh.
  4. Show incident photos/media (`Incident.mediaRef`, `lib/spaces/api.ts:47`), as the spec requires (`openspec/changes/spaces-operations/specs/space-ops-comms/spec.md:40-47`). Nothing renders it today.
  5. Add `accessibilityRole` to the action buttons and mount Aurora in the loaded view (`app/space-incidents.tsx:109`, `:156-172`).

### `app/space-leave.tsx` — Leave requests and approvals — **6/10**
- **Route:** `/space-leave` · **Entry points:** `lib/spaces/layout.ts:119`; `app/space-overview.tsx:315,386`
- **Purpose:** Leave list in My/Pending/History tabs, a balance card, approve/decline, and a request sheet (`app/space-leave.tsx:82-133`).
- **Scores:** Function 6 · States 7 · UI 6 · A11y 5 · Security 6 · Code 6
- **Subscreens:**
  - My/Pending/History tabs (Tab, `app/space-leave.tsx:205-219`) — **6.5/10** — role and selected state are set (`:210-211`).
  - Request-leave sheet (Sheet, `app/space-leave.tsx:275-326`) — **5/10** — no format validation, only a string comparison (`:118-122`); UTC defaults (`:44`); no bottom safe-area padding (`:351`).
- **Strengths:**
  - Full loading, error-with-retry, empty, and pull-to-refresh states (`app/space-leave.tsx:223-268`).
  - Treats an unset allowance as "not set", not zero (`app/space-leave.tsx:225-239`).
- **To reach 10/10:**
  1. Validate dates as `YYYY-MM-DD` before submitting; `space-checkin` already has `isDay` (`app/space-checkin.tsx:286`) and this screen does not (`app/space-leave.tsx:118-122`). Use a date picker.
  2. Let the requester withdraw their own pending request; only `space-checkin` offers this (`app/space-checkin.tsx:196-200`).
  3. Compute `dayOffset` from local date parts, not `toISOString()` (`app/space-leave.tsx:41-45`).
  4. Inset the FAB and sheet with safe-area values (`app/space-leave.tsx:344-347`, `:351`). Confirm before Decline (`:178-184`).
  5. Add `accessibilityRole`/`accessibilityState` to the kind chips and Approve/Decline (`app/space-leave.tsx:282-288`, `:178-191`). Add allowance editing through `setLeaveAllowance` (no caller, `lib/spaces/api.ts:290`).

### `app/space-ops-map.tsx` — Live operations map — **5.5/10**
- **Route:** `/space-ops-map` · **Entry points:** `lib/spaces/layout.ts:106,117,127`; `app/family.tsx:1852`; `app/space-admin.tsx:50`; `app/space-overview.tsx:330,371`
- **Purpose:** Every active run's sealed position on `FamilyMap`, derived tiles, a run list, and a run-targeted or emergency instruction composer (`app/space-ops-map.tsx:83-106`, `:160-192`).
- **Scores:** Function 7 · States 6 · UI 5 · A11y 3 · Security 7 · Code 6
- **Subscreens:**
  - FamilyMap (Map, `app/space-ops-map.tsx:210`) — **6/10** — reuses the clustered map. Its rendering on a device is not verifiable statically.
  - Emergency mode (Mode, `app/space-ops-map.tsx:157`, `:244-260`) — **5.5/10** — real addressing of all active runs, but the toggle has no role or state, and there is no confirmation before a broadcast to every run.
  - Instruction composer (`app/space-ops-map.tsx:262-294`) — **5/10** — honest audience copy (`:288-292`), but no keyboard avoidance, and a partial failure clears the text (`:177`).
- **Strengths:**
  - One sealed subscription per active run, with cleanup and per-run failure isolation (`app/space-ops-map.tsx:83-106`).
  - A 30s tick keeps the staleness fade accurate (`app/space-ops-map.tsx:77-80`, `:119`).
- **To reach 10/10:**
  1. Keep the failed run ids and text after a partial send, and offer "retry the rest". Today `setInstruction('')` runs before the failure count is reported (`app/space-ops-map.tsx:176-181`), so the operator has to retype and resend to everyone.
  2. Give a non-gesture way to open a run. Opening one is long-press only (`app/space-ops-map.tsx:308`), which screen readers cannot discover. Add a chevron button or `accessibilityActions`.
  3. Wrap the composer in `KeyboardSafe`, as other screens do (`app/space-ops-map.tsx:270`).
  4. Add `accessibilityRole="switch"` and `accessibilityState={{checked}}` to the emergency toggle (`app/space-ops-map.tsx:245`), and role/selected to run rows (`:304`).
  5. Replace hard-coded `#F59E0B18` with a warning token (`app/space-ops-map.tsx:360`). Mount Aurora in the loaded view (`:207`).
  6. Subscribe to runs in parallel instead of awaiting each in sequence (`app/space-ops-map.tsx:89-103`).

### `app/space-overview.tsx` — Operations dashboard — **6/10**
- **Route:** `/space-overview` · **Entry points:** `lib/spaces/layout.ts:121`; `app/space-admin.tsx:48`
- **Purpose:** One server summary (`getOpsSummary`) rendered as school tiles or as the business dashboard with donuts, links and quick actions (`app/space-overview.tsx:62-75`, `:155-323`).
- **Scores:** Function 7 · States 6 · UI 6 · A11y 3 · Security 7 · Code 6
- **Subscreens:**
  - School tiles mode (Mode, `app/space-overview.tsx:155-177`) — **6/10** — "—" shown for nulls (`:46`), but the footnote blames a missing shift for any null (`:172-176`).
  - Business dashboard mode (Mode, `app/space-overview.tsx:178-322`) — **6/10** — rich and real, but Metric/Legend/Chip/Action rebuild the whole StyleSheet on each render (`:431`, `:444`, `:456`, `:468`).
  - Donut (component, `components/spaces/Donut.tsx:16-63`) — **5/10** — no accessibility label or summary for the chart (`:53-61`), and the default colours are hard-coded white (`:18`), though callers override them (`app/space-overview.tsx:214-216`).
- **Strengths:**
  - Handles the server's `not_permitted` answer explicitly (`app/space-overview.tsx:68`).
  - Falls back to open-task counts when the breakdown is missing (`app/space-overview.tsx:290-302`).
- **To reach 10/10:**
  1. Gate shortcut links on `perms`, as the admin console does. Runs, Roster and Visitors are drawn for everyone (`app/space-overview.tsx:396-405`). `go()` also drops `canManage` (`:104-110`), so Roster opens without manage controls (`app/space-roster.tsx:38`).
  2. Use `familyOf()` for `isSchool` instead of exact string equality (`app/space-overview.tsx:79-82`; compare `lib/spaces/layout.ts:63`, which also matches `college` and other school types).
  3. Add a retry button to the error card (`app/space-overview.tsx:136-141`).
  4. Accessibility: add roles to all touchables (`app/space-overview.tsx:147`, `:231`, `:330`, `:335`, `:407`, `:469`), and give Donut an `accessibilityLabel` built from its segments (`components/spaces/Donut.tsx:53`).
  5. Hoist `styles(c)` out of the sub-components into a memoized value (`app/space-overview.tsx:431-468`). Mount Aurora in the loaded view (`:129`).

### `app/space-pending.tsx` — Pending pickups — **5.5/10**
- **Route:** `/space-pending` · **Entry points:** `lib/spaces/layout.ts:108,128`; `app/space-admin.tsx:51`
- **Purpose:** Riders still waiting, grouped by run in the server's order, with overdue and not-started flags (`app/space-pending.tsx:35-57`, `:88-128`).
- **Scores:** Function 7 · States 3 · UI 6 · A11y 4 · Security 7 · Code 6
- **Subscreens:** None
- **Strengths:**
  - Keeps the server's order and does no client filtering (`app/space-pending.tsx:47-57`).
  - Shows "overdue" only when a planned time exists (`app/space-pending.tsx:112-119`).
- **To reach 10/10:**
  1. Do not show "Nobody is waiting" after a load failure. The catch only alerts, and then the empty-state text renders (`app/space-pending.tsx:38-39`, `:79-86`). On the screen meant for "when a parent rings" (`:3`), that is a false all-clear. Render an error card with retry.
  2. Add a timer re-render so "overdue" updates without a refresh, as ops-map does (`app/space-pending.tsx:115`; compare `app/space-ops-map.tsx:77-80`).
  3. Pass the chat target to `spaceHeader` (`app/space-pending.tsx:77`) and mount Aurora in the loaded view (`:72`).
  4. Add `accessibilityRole="button"` to the run header row (`app/space-pending.tsx:90`). Use a SectionList for long manifests (`:88`).

### `app/space-people.tsx` — People / team board — **6/10**
- **Route:** `/space-people` · **Entry points:** `lib/spaces/layout.ts:109,115`; `app/space-admin.tsx:52`; `app/space-overview.tsx:231,388`
- **Purpose:** Server-derived status per person, search, and a role change with confirmation (`app/space-people.tsx:66-135`).
- **Scores:** Function 7 · States 6 · UI 6 · A11y 4 · Security 8 · Code 6
- **Subscreens:**
  - Role picker sheet with confirm step (Sheet, `app/space-people.tsx:237-350`) — **7/10** — two-step confirm (`:312-330`), double-tap guard (`:115`), re-read after save (`:121`). Radio rows have no role or state (`:273-283`).
  - PermissionMatrix (component, `components/spaces/PermissionMatrix.tsx:59-176`) — **7/10** — keeps null and [] distinct and pairs each icon with a word (`:101-133`, `:153-165`), but uses the app theme instead of the space palette (`:62`), so it ignores the business skin.
- **Strengths:**
  - Role changes are gated by rank client-side (`canChangeRole`) and re-checked server-side, with the server's 409 wording shown (`app/space-people.tsx:110`, `:128-130`).
  - "No check-in" is never shown as absent (`app/space-people.tsx:34-39`).
- **To reach 10/10:**
  1. Show "Nobody matches" only when a query is set; for an empty list show a real empty state (`app/space-people.tsx:186`). After a load error, show an error with retry, not an Alert and an empty list (`:69-70`).
  2. Use a plain `View` for rows that cannot be edited (they are still `TouchableOpacity`, `app/space-people.tsx:192-197`), and add role/hint on editable rows. Add `accessibilityRole="radio"` and `accessibilityState={{checked}}` to role options (`:273`).
  3. Pass the space palette into `PermissionMatrix` instead of `useTheme()` (`components/spaces/PermissionMatrix.tsx:62`).
  4. Switch to FlatList for large teams (`app/space-people.tsx:182-225`). Add a bottom safe-area inset to the sheet (`:401`).

### `app/space-roster.tsx` — Roster — **6/10**
- **Route:** `/space-roster` · **Entry points:** `app/family.tsx:2263`; `lib/spaces/layout.ts:107,129`; `app/space-admin.tsx:53`; `app/space-overview.tsx:398`
- **Purpose:** The server-scoped roster, with a truncation warning, add, and archive (`app/space-roster.tsx:49-109`).
- **Scores:** Function 4 · States 5 · UI 6 · A11y 6 · Security 7 · Code 7
- **Subscreens:**
  - Add-to-roster modal (Modal, `app/space-roster.tsx:195-229`) — **6.5/10** — trimmed, `maxLength` 120, busy-guarded (`:73-87`, `:216-223`). Name is the only field; `externalRef` and `kind` are not offered.
- **Strengths:**
  - The truncation flag is rendered, not swallowed (`app/space-roster.tsx:139-147`).
  - Archive asks for destructive confirmation (`app/space-roster.tsx:89-108`).
- **To reach 10/10:**
  1. Add link management (guardian_of / supervises / teaches). `addLink`/`removeLink` have no caller (`lib/spaces/api.ts:80-84`), so the scoped-visibility engine the spec centres on (`openspec/changes/spaces-operations/specs/spaces-core/spec.md:47-53`) cannot be configured from the app, and the empty state tells parents "An administrator adds those links" (`app/space-roster.tsx:153`).
  2. Restore manage controls when the screen is opened from a section tile or the overview. Those pushes do not pass `canManage` (`app/family.tsx:1646-1652`, `app/space-overview.tsx:104-110`), but the screen reads only that param (`app/space-roster.tsx:38`). Derive it from `perms` as well.
  3. After a load error, show an error card instead of an Alert followed by the "Nobody is linked to you" empty text (`app/space-roster.tsx:61-62`, `:149-156`). Add pull-to-refresh.
  4. Keep the chat door when adding `headerRight` (`app/space-roster.tsx:125-135`). Replace `#F59E0B18` with a token (`:245`). Mount Aurora in the loaded view (`:124`).

### `app/space-run-driver.tsx` — Driver manifest — **5/10**
- **Route:** `/space-run-driver` · **Entry points:** `app/family.tsx:804` (auto-redirect for a driver with a started run), `app/family.tsx:1824`
- **Purpose:** Driver's single-stop manifest: start/finish, arrived, mark on board/absent, handover code, incidents, panic, heartbeat and sealed position broadcast (`app/space-run-driver.tsx:110-209`, `:231-351`).
- **Scores:** Function 3 · States 6 · UI 6 · A11y 4 · Security 6 · Code 6
- **Subscreens:**
  - Handover code modal (Modal, `app/space-run-driver.tsx:495-525`) — **5/10** — Confirm is enabled with an empty code (`:515-518`). Fix: disable until the code is non-empty.
  - Report-a-problem sheet (Sheet, `app/space-run-driver.tsx:528-548`) — **5/10** — files a category only, with no note or photo (`:311`), unlike the spec (`openspec/changes/spaces-operations/specs/space-ops-comms/spec.md:45-47`). No double-submit guard (`:308-316`). No bottom inset (`:638`).
  - Panic confirmation (Alert, `app/space-run-driver.tsx:270-306`) — **6/10** — confirmation survives a pocket press, but a failed send is not queued or retried (`:298-301`).
- **Strengths:**
  - Idempotent `transitionId`, with an optimistic update and rollback (`app/space-run-driver.tsx:231-247`).
  - Heartbeat and background-broadcast lifecycle, pinned by `lib/spaces/runHeartbeat.selftest.ts` (passes) (`app/space-run-driver.tsx:110-119`, `:189-209`).
- **To reach 10/10:**
  1. Fix the driver missing riders who have no stop. `nextStop` returns the first stop for riders with no `stopId` (`lib/spaces/runs.ts:85-88`), but the screen then filters with `ridersAtStop(riders, current.id)` (`app/space-run-driver.tsx:227`), which matches only `stopId === current.id` (`lib/spaces/runs.ts:94`). With no stops, `current` is null and the screen says "Everyone has been marked." (`app/space-run-driver.tsx:480-485`). I confirmed this with a tsx check: with stops, current=`s1` and 0 riders are listed; with no stops, current=null. Every rider added through runs-admin has `stopId: null` (`app/space-runs-admin.tsx:151`), so on those runs the driver can mark nobody.
  2. Send detection alerts to ops. Overspeed, deviation and long-stop go to `recordAlert` (`app/space-run-driver.tsx:158-166`), which is device-local storage (`lib/family/alerts.ts:9-12`, `:98-103`). They never reach ops, contrary to `openspec/changes/spaces-operations/specs/space-ops-comms/spec.md:54-71`.
  3. Replace the "Call guardian" stub, an Alert saying numbers are not on the roster yet (`app/space-run-driver.tsx:260-264`). Wire it to a guardian's direct chat or call, as `space-transport` does for drivers (`app/space-transport.tsx:106-120`). If that is not possible, remove the button.
  4. Tell the driver when foreground location is not granted. Today the broadcast silently does nothing (`app/space-run-driver.tsx:138-139`), so the bus is invisible with no warning.
  5. Queue and retry the SOS incident on failure (`app/space-run-driver.tsx:296-301`). Add retry to the "This run is not available" state (`:364-370`).
  6. Add `accessibilityRole` to Start/Finish, Arrived, mark buttons and the incident bar (`app/space-run-driver.tsx:385-391`, `:420`, `:451-466`, `:489`). Use safe-area insets for the floating bar (`:619-626`).

### `app/space-run.tsx` — Guardian/rider run view — **6/10**
- **Route:** `/space-run` · **Entry points:** `app/family.tsx:1864`; `app/space-transport.tsx:283`; `app/space-ops-map.tsx:308`; `app/space-overview.tsx:338`; `app/space-pending.tsx:92`
- **Purpose:** Per-rider card with an arrival window, vehicle status, live-position freshness, route stops and an on-demand event timeline (`app/space-run.tsx:173-283`).
- **Scores:** Function 5 · States 5 · UI 6 · A11y 4 · Security 8 · Code 7
- **Subscreens:**
  - RiderCard (component, `app/space-run.tsx:286-361`) — **6/10** — road ETA with fallbacks (`:308-327`), but `now` is captured only at render (`:295`), so the window goes stale between pings.
  - "What happened" timeline (expandable, `app/space-run.tsx:262-281`) — **6.5/10** — states honestly that path replay is unavailable (`:275-280`). The whole card is the touchable and becomes disabled after opening (`:262`).
- **Strengths:**
  - No client-side rider filter, and an honest "waiting for first position" message (`app/space-run.tsx:9-18`, `:232-241`).
  - Delay threshold comes from the server (`app/space-run.tsx:69-73`, `:93`).
- **To reach 10/10:**
  1. Render the vehicle on a map. Entry buttons say "Live bus" with a map icon (`app/space-transport.tsx:286-287`), but this screen has no map, only "Last update …" (`app/space-run.tsx:216-242`). The spec requires live position, driver name and next stop (`openspec/changes/spaces-operations/specs/space-runs/spec.md:75-77`); driver name is not shown either.
  2. Update rider and stop state live or by polling while the run is started. Today `load()` runs only on focus (`app/space-run.tsx:101`), so a waiting parent never sees "On board" without leaving and returning. Add pull-to-refresh and a 30s tick for the arrival window (`:295`).
  3. Add a retry to "This run is not available" (`app/space-run.tsx:162-169`).
  4. Replace hard-coded `#F59E0B` and `#F59E0B18` (`app/space-run.tsx:349`, `:427`) with `colors.warning`. Pass the chat target to `spaceHeader` (`:175`).

### `app/space-runs-admin.tsx` — Run builder — **4.5/10**
- **Route:** `/space-runs-admin` · **Entry points:** `app/space-admin.tsx:49`; `app/space-overview.tsx:397`
- **Purpose:** Create runs, then edit driver, ordered stops and rider manifest, or cancel (`app/space-runs-admin.tsx:92-188`).
- **Scores:** Function 4 · States 4 · UI 5 · A11y 5 · Security 5 · Code 5
- **Subscreens:**
  - New-run modal (Modal, `app/space-runs-admin.tsx:250-288`) — **6/10** — name required, busy-guarded. It cannot set a schedule time or `requireCode`, though `createRun` accepts both (`lib/spaces/api.ts:101-104`).
  - Edit-run modal (full-screen Modal, `app/space-runs-admin.tsx:291-381`) — **3.5/10** — stops are saved as labels only, riders never get a stop, taps race each other, and the header uses a hard-coded `paddingTop: 54` (`:432`). Details below.
- **Strengths:**
  - Cancelling a run requires destructive confirmation (`app/space-runs-admin.tsx:172-188`).
  - Server errors for driver conflicts are shown (`app/space-runs-admin.tsx:165-168`).
- **To reach 10/10:**
  1. Let the admin assign each rider to a stop. Riders are always saved with `stopId: null` (`app/space-runs-admin.tsx:150-151`), which leaves them invisible on the driver screen (see run-driver fix 1).
  2. Capture stop coordinates and planned times. `setRunStops` sends only `{ label }` (`app/space-runs-admin.tsx:121`, `:135`), so stops never get lat/lng or `plannedAt`. That disables driver deviation detection (`app/space-run-driver.tsx:88-91`), forces the guardian ETA onto the per-stop constant (`app/space-run.tsx:315`), and stops `isDelayed` and "overdue" from ever firing (`lib/spaces/runs.ts:175-176`, `app/space-pending.tsx:115`).
  3. Disable driver and rider rows while `busy`, or queue the edits. Each tap PUTs a whole list built from the `editing` snapshot (`app/space-runs-admin.tsx:142-156`), but rows are not disabled (`:314`, `:362`), so two quick taps can overwrite each other.
  4. Show an error with retry when loads fail; failures are currently caught to `[]` and show "No runs yet" (`app/space-runs-admin.tsx:70-72`, `:220`).
  5. Confirm a mid-run driver change and stop removal (`app/space-runs-admin.tsx:314`, `:333`). Add stop reordering.
  6. Use safe-area insets and an opaque ground in the edit modal (`app/space-runs-admin.tsx:293`, `:432`). Remove `as any` (`:147`, `:151`). Add role/state to radio and checkbox rows (`:314`, `:362`).

### `app/space-tasks.tsx` — Work tasks — **6/10**
- **Route:** `/space-tasks` · **Entry points:** `lib/spaces/layout.ts:118`; `app/space-overview.tsx:280,297,387`
- **Purpose:** Server-scoped task list in To Do/Overdue/Done tabs, an optimistic done toggle, and a create sheet for ops (`app/space-tasks.tsx:75-124`).
- **Scores:** Function 5 · States 7 · UI 6 · A11y 5 · Security 7 · Code 7
- **Subscreens:**
  - To Do/Overdue/Done tabs (Tab, `app/space-tasks.tsx:179-193`) — **6.5/10** — role and selected state set (`:184-185`).
  - New-task sheet (Sheet, `app/space-tasks.tsx:237-277`) — **5/10** — only title and priority (`:116`). No assignee or due date, though `createWorkTask` accepts both (`lib/spaces/api.ts:251-253`).
- **Strengths:**
  - Optimistic toggle with rollback and a per-row busy guard (`app/space-tasks.tsx:95-109`, `:142`).
  - Loading, error-with-retry, empty and refresh states (`app/space-tasks.tsx:199-228`).
- **To reach 10/10:**
  1. Add assignee and due-date inputs (`app/space-tasks.tsx:116`). Without them every new task is "Unassigned" (`:151`) and the Overdue tab can never fill (`:127`). The header's "Creating and assigning" (`:15`) is only half true.
  2. Add `accessibilityRole="checkbox"` and `accessibilityState={{checked: !!t.doneAt}}` to task rows (`app/space-tasks.tsx:142`), and state to the priority chips (`:253-258`).
  3. Hide the Overview "Create Task" quick action for non-ops users, who land on a screen with no create button (`app/space-overview.tsx:387` vs `app/space-tasks.tsx:231`).
  4. Use safe-area insets for the FAB and sheet (`app/space-tasks.tsx:300-303`, `:307`). The comment says a plain member's error is not an error state, but the code sets `err` for any failure (`:81-84`); make them agree.

### `app/space-transport.tsx` — Transport landing (parent/rider) — **6.5/10**
- **Route:** `/space-transport` · **Entry points:** `lib/spaces/layout.ts:105,120,126` (first tile for school and transport spaces)
- **Purpose:** Runs the caller can see, with their linked riders' states, next stop, a link to the run, and a call to the driver (`app/space-transport.tsx:132-153`, `:217-305`).
- **Scores:** Function 6 · States 7 · UI 7 · A11y 4 · Security 8 · Code 6
- **Subscreens:** None (the driver call pushes `/voicecall`, which is out of this batch)
- **Strengths:**
  - Needs no permissions and no location, and the empty and error states are clearly distinct (`app/space-transport.tsx:183-215`).
  - The driver call resolves a real direct chat before pushing `/voicecall`, with a re-entrancy guard (`app/space-transport.tsx:105-120`).
  - Status pairs an icon with text (`app/space-transport.tsx:232-241`).
- **To reach 10/10:**
  1. Map the `cancelled` rider state. It falls through to "Waiting to be picked up" (`app/space-transport.tsx:60`), but `cancelled` is a valid state (`openspec/changes/spaces-operations/specs/space-runs/spec.md:31`).
  2. Relabel "Live bus" or give its target a map (`app/space-transport.tsx:282-288` → `app/space-run.tsx`, which has none).
  3. Replace the N+1 `getRun` per run (`app/space-transport.tsx:140-147`) with one scoped call.
  4. Add `accessibilityRole` and labels to the "Live bus", "Driver" and "Try again" buttons (`app/space-transport.tsx:187`, `:282`, `:292`). Pass the driver's name instead of the literal `'Driver'` (`:113`). Remove `as any` pathnames (`:112`, `:208`, `:283`).

### `app/space-visitors.tsx` — Visitor passes — **5.5/10**
- **Route:** `/space-visitors` · **Entry points:** `app/space-admin.tsx:57` (gated on `manage_roster`); `app/space-overview.tsx:401,404` (ungated)
- **Purpose:** Issue time-boxed passes and admit or sign out visitors by code (`app/space-visitors.tsx:71-110`).
- **Scores:** Function 5 · States 5 · UI 6 · A11y 4 · Security 6 · Code 7
- **Subscreens:**
  - Issue-pass modal (Modal, `app/space-visitors.tsx:188-221`) — **6/10** — name required, preset durations, busy guard. No host selection.
  - Redeem modal (Modal, `app/space-visitors.tsx:224-254`) — **5.5/10** — uppercase and `maxLength`, and the server deliberately gives one message for every failure (`:102-106`). Code entry is typed only.
- **Strengths:**
  - Sorts who is on site first (`app/space-visitors.tsx:62-69`).
  - A single, non-oracle error message (`app/space-visitors.tsx:103-106`).
- **To reach 10/10:**
  1. Let the issuer choose a host. `hostId` is never sent (`app/space-visitors.tsx:76-79`), though the API accepts it (`lib/spaces/api.ts:173`) and the spec requires a named host (`openspec/changes/spaces-operations/specs/space-attendance/spec.md:40-43`).
  2. Add QR scanning, or drop the QR wording. The entry uses a `qr-code-outline` icon (`app/space-visitors.tsx:139`) and the admin hint says "Issue and admit visitors" (`app/space-admin.tsx:57`), but redemption is typed only (`:229-233`). Add Share/Copy for a new code instead of showing it only in an Alert (`:82-85`).
  3. Add a per-row "Sign out" for visitors on site instead of requiring the code to be retyped (`app/space-visitors.tsx:154-177`).
  4. After a load error, show an error card, not an Alert followed by "No passes yet" (`app/space-visitors.tsx:51-52`, `:143`). Gate the overview's Visitors shortcut on `manage_roster` (`app/space-overview.tsx:401,404`).
  5. Add roles to the admit button and hour chips (`app/space-visitors.tsx:138`, `:199-204`). Consider masking active codes in the list (`:175`), since they are door credentials (`:11`).


---

## I1 — Finance (Ledger, Chitti, Calculators)

| Screen | Route | Wired? | Score |
|---|---|---|---|
| `app/finance/_layout.tsx` (section shell) | `/finance/*` | Yes | 8 |
| `app/finance/index.tsx` | `/finance` | Yes | 6.5 |
| `app/finance/calendar.tsx` | `/finance/calendar` | Yes | 6.5 |
| `app/finance/chitti/index.tsx` | `/finance/chitti` | Yes | 7 |
| `app/finance/chitti/new.tsx` | `/finance/chitti/new` | Yes | 7 |
| `app/finance/chitti/[id].tsx` | `/finance/chitti/[id]` | Yes | 5 |
| `app/finance/customer.tsx` | `/finance/customer` | Yes | 6 |
| `app/finance/emi.tsx` | `/finance/emi` | Yes | 7.5 |
| `app/finance/interest.tsx` | `/finance/interest` | Yes | 7 |
| `app/finance/io.tsx` | `/finance/io` | Yes | 6.5 |
| `app/finance/ledger/index.tsx` | `/finance/ledger` | Yes | 7 |
| `app/finance/ledger/new.tsx` | `/finance/ledger/new` | Yes | 6.5 |
| `app/finance/ledger/[id].tsx` | `/finance/ledger/[id]` | Yes | 6.5 |
| `app/finance/ledger/edit.tsx` | `/finance/ledger/edit` | Yes | 6 |
| `app/finance/ledger/update.tsx` | `/finance/ledger/update` | Yes | 6.5 |
| `app/finance/reminders.tsx` | `/finance/reminders` | Yes | 6 |
| `app/finance/reports.tsx` | `/finance/reports` | Yes | 6 |
| `app/finance/saved.tsx` | `/finance/saved` | Yes | 6.5 |
| `app/finance/search.tsx` | `/finance/search` | Yes | 6 |
| `app/interest-calculator.tsx` | `/interest-calculator` | **UNWIRED** in-app (deep-link shim only) | 7 |
| `app/split.tsx` | `/split` | Yes | 7 |

Issues that affect several screens (cited once here, then referred to below):
- **X1. Field labels come from placeholders.** `Field` sets `accessibilityLabel={rest.placeholder}` (`components/finance/ui.tsx:134`). The visible `<Label>` text is not linked to the input. A screen reader therefore hears "₹ 0" for Principal, Chit Value, Installment, Received and Remaining, and "e.g. 20" for both Members and Duration.
- **X2. Date picker is Android-only.** Every finance date picker calls `DateTimePickerAndroid.open` with no `Platform` branch: `ledger/new.tsx:36`, `ledger/edit.tsx:45`, `chitti/new.tsx:76`, `interest.tsx:35`, `reminders.tsx:44-58`. iOS is a configured target (`app.json:16`). Each of these files imports `Platform` and never uses it (grep count = import only). iOS behaviour is not verifiable statically.
- **X3. Ledger status `overdue` is never written by the app.** `setLedgerStatus` and `setGroupStatus` have no callers outside `db/` (grep). The only ledger write of `'overdue'` is CSV import (`app/finance/io.tsx:221`). So the "Overdue" tile and rows (`index.tsx:70,142`, `reports.tsx:61,116`) read 0 for app-created data, and a chitti group's status can never change after it is created.
- **X4. Finance data is stored unencrypted.** All finance data sits in plain `expo-sqlite` `interest.db` (`db/financeDb.ts:18`). Android screenshots are blocked app-wide via `setSecure(true)` (`app/_layout.tsx:242`). The iOS equivalent is not verifiable statically.
- **X5. Theme selftest skips finance.** `lib/themeCoverage.selftest.ts:43` exempts `app/finance/`. Hard-coded hero colours (`rgba(255,255,255,…)`, `#fff`, `#101828` shadows) are therefore not enforced. `lib/a11yCoverage.selftest.ts` passes (0 unlabelled icon-only buttons; I ran it). It does not check roles on rows that contain text.
- **X6. Save-button double-submit latch is in place.** `Btn` latches while its handler's promise is in flight (`components/finance/ui.tsx:245-253`), and `lib/financeBtnLatch.selftest.ts` passes (I ran it). Row taps that are not `Btn` (chitti status cycling, reminder actions) have no such guard.
- No `<Modal>` or Sheet is used anywhere in `app/finance` or `components/finance` (grep). All subscreens are inline cards, segments, Alerts, OS pickers or share sheets.

---

### `app/finance/_layout.tsx` — Vault Finance section shell — **8/10**
- **Route:** `/finance/*` · **Entry points:** registered in root stack `app/_layout.tsx:996`; the Mini-apps tile `app/(tabs)/mini.tsx:52` is pushed at `app/(tabs)/mini.tsx:87-88`.
- **Purpose:** headerless Stack for the 18 finance screens, drawn over one shared theme gradient (`:17-50`).
- **Scores:** Function 9 · States 7 · UI 9 · A11y 8 · Security 7 · Code 9
- **Subscreens:** None
- **Strengths:**
  - All 18 routes are registered explicitly (`:29-46`).
  - The gradient comes from the theme palette and is drawn once, with a `bgMid` fallback for transition frames (`:22-27`, `:55`).
  - The palette follows the light/dark scheme (`components/finance/useFinanceTheme.ts:5-6`, `constants/financeTheme.ts:181`).
- **To reach 10/10:**
  1. Add an error boundary around the finance `Stack` (`:28`). Many child screens fire unhandled promises (see the screens below), and nothing at section level catches a render throw.
  2. Gate the finance section on the app lock or biometric check, or document why it is exempt. Finance data is unencrypted on disk (X4), and nothing in this shell (`:17-50`) adds protection.

### `app/finance/index.tsx` — Finance Dashboard — **6.5/10**
- **Route:** `/finance` · **Entry points:** `app/(tabs)/mini.tsx:52` (pushed at `:88`); `app/interest-calculator.tsx:10` redirect.
- **Purpose:** headline totals, four health tiles and a grid of links into every finance module.
- **Scores:** Function 6 · States 4 · UI 8 · A11y 8 · Security 7 · Code 7
- **Subscreens:** None
- **Strengths:**
  - Every quick action and header button routes to a real screen (`:151-158`, `:100-104`, `:162-167`).
  - Totals are summed in paise to avoid drift (`:65-68`).
  - Header icons use `IconBtn` with 44dp labelled targets (`components/finance/ui.tsx:280-293`). Tiles carry combined labels (`ui.tsx:318`).
- **To reach 10/10:**
  1. The hero says "TOTAL OVERVIEW · THIS MONTH" (`:115`), but `reload` sums every ledger with no date filter (`:52-71`). Filter to the month or relabel.
  2. Add `.catch` and a load/error state to `reload` (`:51-75`). As written it is an unhandled rejection, and zeros show during loading and after a failure. Reuse `useLoadStatus` (`components/finance/useLoad.ts:16-28`) as the list screens do.
  3. Interest uses the simple formula even for `interest_type === 'compound'` and assumes 1 year when there is no end date (`:59-61`). The detail screen uses compound (`ledger/[id].tsx:20-22`). Extract one shared `ledgerInterest()` and use it here, in Reports and in the detail screen.
  4. The "Overdue" tile (`:142`) is always 0 for app-created data (X3). Derive overdue from `end_date < now && remaining > 0`, or write the status.
  5. Replace `router.push(path as any)` (`:80`) with typed hrefs.

### `app/finance/calendar.tsx` — Finance Calendar — **6.5/10**
- **Route:** `/finance/calendar` · **Entry points:** `app/finance/index.tsx:156`.
- **Purpose:** month grid marking ledger end dates, active reminders and chitti auction dates.
- **Scores:** Function 5 · States 4 · UI 8 · A11y 7 · Security 8 · Code 7
- **Subscreens:**
  - Selected-day events panel (in-screen panel, `:100-111`) — **6/10** — read-only rows with no tap-through to the ledger, reminder or group behind each event. Fix: keep a ref id on `Ev` (`:16`) and navigate on press.
- **Strengths:**
  - Day cells have a role, selected state and a full date label that says when events are due (`:90`).
  - Month navigation uses labelled `IconBtn`s (`:76-78`).
  - The Monday-first grid is memoised (`:51-59`).
- **To reach 10/10:**
  1. A chitti group yields one auction event at `start_date + 30d` (`:38`). Generate one per month for `g.duration` so it matches the detail screen's model (`chitti/[id].tsx:145`).
  2. Recurring reminders appear only on `next_at` (`:37`). Expand daily, weekly and monthly reminders into the visible month.
  3. Add catch and loading/error states to `reload` (`:33-40`), which currently has no error handling.
  4. `dayEvents` sorts the memoised array in place (`:68`). Use `[...arr].sort`. Replace the index keys (`:84`, `:104`).

### `app/finance/chitti/index.tsx` — Lucky Draw list — **7/10**
- **Route:** `/finance/chitti` · **Entry points:** `app/finance/index.tsx:154`.
- **Purpose:** groups filtered by Active/Closed/Draft, each with a payment-progress ring.
- **Scores:** Function 7 · States 8 · UI 8 · A11y 5 · Security 8 · Code 6
- **Subscreens:**
  - Active / Closed / Draft segment (Tab, `:63-66`) — **6/10** — tabs have proper roles (`ui.tsx:170-181`), but groups can never move into Closed or Draft after creation (X3). Fix: add a status action in the group detail that calls `setGroupStatus` (`db/chitti.ts:117`).
- **Strengths:**
  - Loading, error-with-retry and empty states are all handled (`:69-74`).
  - Failures are caught explicitly (`:49`).
  - The FAB respects the bottom safe-area inset (`:89`).
- **To reach 10/10:**
  1. Add `accessibilityRole="button"` and a label (name, members, progress) to group cards (`:76-77`) and the FAB (`:89`).
  2. Replace the sequential per-group `listCollections` loop (`:41-46`) with one grouped `COUNT` query.
  3. Use a FlatList for the group list (`:68-88`).

### `app/finance/chitti/new.tsx` — New Lucky Draw Group — **7/10**
- **Route:** `/finance/chitti/new` · **Entry points:** `app/finance/chitti/index.tsx:58`, `:89`.
- **Purpose:** form that creates a chitti group and then replaces itself with the group's detail screen.
- **Scores:** Function 8 · States 6 · UI 7 · A11y 5 · Security 7 · Code 8
- **Subscreens:**
  - Start-date picker (OS dialog, `:76`) — **5/10** — Android-only API (X2). Fix: add an iOS picker branch.
  - Status segment (Tab, `:79`) — **7/10** — has roles; Draft and Closed are permanent once chosen (X3).
- **Strengths:**
  - Required numeric fields are validated (`:33-36`).
  - Saves go through the latched `Btn` (`:82`, X6).
  - `router.replace` to the new group avoids a back-stack loop (`:43`).
- **To reach 10/10:**
  1. Members and Duration of `0.4` pass `!(mem > 0)` (`:35`) and are then rounded to 0 (`:40`). Require whole numbers ≥ 1 before rounding.
  2. Fix X1 so Chit value, Installment, Members and Duration have distinct spoken labels.
  3. Warn when `installment × members ≠ chit_value` (`:32-36`).
  4. Add an iOS date path (X2) and remove the unused `Platform` import (`:6`).

### `app/finance/chitti/[id].tsx` — Lucky Draw group detail — **5/10**
- **Route:** `/finance/chitti/[id]` · **Entry points:** `chitti/index.tsx:77`, `chitti/new.tsx:43`, `saved.tsx:61`, `search.tsx:100`.
- **Purpose:** members, monthly dues, auctions and history for one group.
- **Scores:** Function 6 · States 4 · UI 6 · A11y 4 · Security 6 · Code 5
- **Subscreens:**
  - Members tab (Tab, `:187-230`) — **5/10** — rows (`:210`) and the "Add member" row (`:204`) have no role or label. Fix: add roles, and labels such as "Edit member N".
  - Member add/edit form (inline Card, `:190-202`) — **5/10** — phone is validated (`:91-95`), but the save has no try/catch (`:97-101`). New members are numbered `members.length + 1` (`:100`), so deleting member 2 of 3 and adding one creates a second #3. The member count is never capped at `g.members`. Fix: use `MAX(number)+1` and cap at `g.members`.
  - Dues tab (Tab, `:231-256`) — **4/10** — tapping a row cycles the status (`:245`) with no role, no `accessibilityState`, no error handling and no double-tap guard (`:106-111`). Month chips (`:236`) have no role or selected state. Fix: use radio roles with states and wrap the call in try/catch.
  - Auctions tab (Tab, `:257-320`) — **5/10** — the preview mirrors the recorded split (`:131-138`). There is no check that bid ≤ chit value or commission ≤ bid (`:120-123`). Re-recording a month silently replaces the earlier auction (`db/chitti.ts:226,235-237`). Winner chips (`:273`) have no role or state. Fix: add the bounds checks and confirm before replacing.
  - History tab (Tab, `:321-335`) — **7/10** — append-only timeline. Its load error is swallowed (`:61`).
  - Delete-group Alert (`:140-143`) — **7/10** — confirmed and cascades (`db/chitti.ts:108-115`), but `deleteGroup` has no catch (`:142`).
  - Remove-member Alert (`:220-225`) — **7/10** — confirmed and timeline-logged (`db/chitti.ts:164`).
  - Delete-auction Alert (`:312-317`) — **6/10** — confirmed, but no timeline entry is written (`db/chitti.ts:252-255`). Fix: add `addTimeline` there.
- **Strengths:**
  - Destructive actions are confirmed (`:140`, `:220`, `:312`).
  - Dividends are floored so the payout never exceeds the pot, and the leftover is shown (`:282-294`, `db/chitti.ts:220-224`).
  - Every change is written to the history timeline (`db/chitti.ts:131,154,186,242`).
- **To reach 10/10:**
  1. `reload` fires four promises with no `.catch` (`:57-60`). A missing or failed group renders an empty header forever (`:75`). Add load, error and not-found states via `useLoadStatus`.
  2. Fix member numbering (`:100`). Enforce the `g.members` limit.
  3. Add roles, labels and states to month chips, winner chips, member rows, dues rows and the add row (`:204,210,236,245,265,273`).
  4. Wrap the scroll body in `KeyboardSafe`, as the other forms do (`ledger/new.tsx:69`). The member and auction inputs (`:193-197`, `:279-280`) currently have no keyboard avoidance.
  5. "Pending" counts overdue members too (`:179`). Show overdue separately.
  6. The next-auction date uses 30-day months and the selected tab month, not today (`:145`). Use calendar months.
  7. Split the 393-line file into tab components and deduplicate the month-chip row (`:234-240` vs `:263-269`).

### `app/finance/customer.tsx` — Customer profile — **6/10**
- **Route:** `/finance/customer` · **Entry points:** `app/finance/ledger/[id].tsx:83-84`.
- **Purpose:** combines all ledgers that share one person's name into a net position and a list.
- **Scores:** Function 6 · States 4 · UI 8 · A11y 5 · Security 7 · Code 7
- **Subscreens:** None
- **Strengths:**
  - Totals are summed in paise (`:36-40`).
  - Rows navigate to the real ledger detail (`:80-81`).
  - Stat tiles use the responsive `TileGrid` (`:66-70`).
- **To reach 10/10:**
  1. A failed read is swallowed (`:29`) and then shows "No ledgers" (`:74-75`), which is exactly the false empty state `useLoad.ts:3-7` was written to stop. Use `useLoadStatus`.
  2. Customers are matched by name only (`:29`). The header promises `&mobile=` (`:2`) but only `name` is read (`:22`). Match on mobile when present, so two people with the same name are not merged.
  3. "Outstanding" covers lent rows only (`:39`). Show what is owed to you and what you owe.
  4. Give ledger cards a role and label (`:80`).

### `app/finance/emi.tsx` — EMI Calculator — **7.5/10**
- **Route:** `/finance/emi` · **Entry points:** `app/finance/index.tsx:153`.
- **Purpose:** EMI from amount, rate and tenure, with an amortization table and PDF export.
- **Scores:** Function 7 · States 7 · UI 8 · A11y 7 · Security 8 · Code 8
- **Subscreens:**
  - Amortization schedule (toggle panel, `:123-140`) — **7/10** — capped at 24 rows and shrinks text to fit. The note "full schedule in the PDF" (`:139`) is false: the PDF includes only the first 12 months (`:65-67`). Fix: export `schedule` in full, or change the note.
  - PDF share (share sheet, `:55-69`) — **7/10** — built from the calculated snapshot, with errors alerted (`:68`).
- **Strengths:**
  - The result is a snapshot of the inputs it was calculated from, so later edits cannot change it (`:25-31`).
  - A 0% loan is valid and NaN is rejected (`:37-44`, `utils/finance.ts:34`).
  - Loan-type chips have radio roles, selected state and a 44dp minimum (`:155-160`, `:171`).
- **To reach 10/10:**
  1. Fix the PDF/schedule mismatch (`:65-67` vs `:139`).
  2. Put an upper bound on tenure. `amortization` builds an array of `months` rows (`utils/finance.ts:57-63`), and `months()` (`:34`) is unbounded.
  3. Fix X1 for the amount, rate and tenure fields (`:84,87,94`).
  4. "Loan type" changes only the PDF label (`:58`). Drop it, or use it for preset rates.

### `app/finance/interest.tsx` — Interest Calculator — **7/10**
- **Route:** `/finance/interest` · **Entry points:** `app/finance/index.tsx:152`.
- **Purpose:** simple or compound interest by dates or duration. Results are saved to history and can be shared as a PDF.
- **Scores:** Function 6 · States 7 · UI 7 · A11y 6 · Security 8 · Code 7
- **Subscreens:**
  - Dates / Duration mode (Radio mode, `:136-157`) — **7/10** — NaN-safe duration parsing (`:56-61`). Negative parts are allowed as long as the total is positive (e.g. years −1, months 24).
  - Date picker (OS dialog, `:33-36`) — **5/10** — Android-only (X2).
  - Result and Share PDF (inline result, `:164-180`) — **5/10** — the PDF reads the live `principal`, `rate`, `rateMode`, `period` and `type` (`:100-102`), not the calculated result. Editing after Calculate exports mismatched figures, the same bug `emi.tsx:25-31` already fixed. Fix: snapshot the inputs in `res`.
- **Strengths:**
  - Overflow and Infinity guard (`:73-75`).
  - A failed history write is reported, not swallowed (`:79-91`).
  - Radios expose role and selected state (`ui.tsx:205-207`).
- **To reach 10/10:**
  1. Snapshot the inputs into `res` for the PDF (`:99-106`).
  2. Allow a 0% rate (`:41`), consistent with `ledger/new.tsx:53` and `emi.tsx:44`.
  3. History stores the raw `rate` with no `rateMode` or `period` (`:80`). `saved.tsx:54` then shows a unitless rate. Persist both.
  4. Reject negative duration parts (`:56-60`). Add an iOS date path (X2). Remove the unused `Platform` import (`:7`).

### `app/finance/io.tsx` — Import / Export — **6.5/10**
- **Route:** `/finance/io` · **Entry points:** `app/finance/index.tsx:162-164`.
- **Purpose:** exports ledgers or Lucky Draw data as Excel/CSV, exports and restores a full JSON backup, and imports ledgers from CSV.
- **Scores:** Function 6 · States 6 · UI 8 · A11y 7 · Security 4 · Code 7
- **Subscreens:**
  - Ledger / Lucky Draw spreadsheet mode (Tab, `:119-129`) — **6/10** — real export (`:37-41`, `:61-81`). The CSV columns omit start and end dates (`:25`), and import resets `start_date` to now and `end_date` to null (`:220`), so a round trip loses the loan dates.
  - Full Backup mode (Tab, `:42-56`, `:96-103`) — **6/10** — round-trippable and idempotent (`db/financeBackup.ts:12-14`). The restore only checks the outer shape (`financeBackup.ts:80-84`), has no transaction (`:120-127`), and `INSERT OR REPLACE` can overwrite newer local edits with older backup rows without asking (`:111`).
  - CSV import flow (DocumentPicker + Alerts, `:91-111`) — **5/10** — rows with an unreadable principal are dropped without being counted (`:199-200`), even though the result Alert reports only "Remaining" skips (`:108`). Re-importing the same CSV duplicates every ledger, because `insertLedger` mints a new uuid each time (`db/ledger.ts:53`). The file is split on newlines before CSV parsing (`:176`), so a quoted multi-line note (which `utils/financeIO.ts:55` emits) corrupts the row.
- **Strengths:**
  - Export and import are wrapped in try/catch with clear Alerts (`:83`, `:109-111`).
  - An unreadable Remaining cell skips the row instead of inventing a balance (`:213-215`).
  - Backup creation is confirmed explicitly (`:54-56`).
- **To reach 10/10:**
  1. Security: the JSON backup (names, phones, addresses) is plaintext (`:50`) and left in the cache directory (`utils/financeIO.ts:79-81`). Encrypt it, or at least delete it after sharing. Escape CSV cells starting with `= + - @` against formula injection (`utils/financeIO.ts:53-56`).
  2. Show a preview with counts and require confirmation before import or restore (`:96-105`). Wrap the restore in a transaction (`db/financeBackup.ts:120-127`).
  3. Count principal-invalid rows as skipped (`:199-200`). Parse the CSV as a whole rather than line by line (`:176`).
  4. Add StartDate and EndDate columns to the export and import (`:25`, `:220`). Make CSV import idempotent, for example by matching on name, principal and created date.
  5. Restrict the picker type and check the file size before reading (`:92-94`).

### `app/finance/ledger/index.tsx` — Ledger Book list — **7/10**
- **Route:** `/finance/ledger` · **Entry points:** `app/finance/index.tsx:151`.
- **Purpose:** lent and borrowed ledgers with filters, long-press delete and 30-second undo.
- **Scores:** Function 8 · States 8 · UI 8 · A11y 5 · Security 7 · Code 7
- **Subscreens:**
  - All / Lent / Borrowed filter (Tab, `:96-99`) — **8/10** — roles come from `Segment` (`ui.tsx:170-181`).
  - Undo snackbar (Overlay, `:151-156`) — **6/10** — the earlier pending delete is committed correctly (`:57`) and flushed on unmount (`:69-73`). The UNDO button has no role (`:154`), the snackbar has no live region, and delete failures are swallowed (`:75`).
- **Strengths:**
  - Loading, error-with-retry and empty states (`:103-108`).
  - Undo semantics hold up when two deletes happen in a row or the screen unmounts (`:51-73`).
  - The FAB and snackbar follow the bottom safe-area inset (`:146`, `:152`).
- **To reach 10/10:**
  1. Cards (`:113-116`) have no role or label. Delete is long-press only, with no `accessibilityActions` or hint. Add both.
  2. Add a role to the FAB (`:146`) and UNDO (`:154`). Add `accessibilityLiveRegion` to the snackbar.
  3. Report a failed `deleteLedger` (`:72`, `:75`) instead of `.catch(() => {})`.
  4. Use a FlatList for an unbounded ledger list (`:102-144`).

### `app/finance/ledger/new.tsx` — Add Ledger — **6.5/10**
- **Route:** `/finance/ledger/new` · **Entry points:** `app/finance/ledger/index.tsx:90`, `:146`.
- **Purpose:** form that creates a lend or borrow ledger entry.
- **Scores:** Function 7 · States 6 · UI 7 · A11y 5 · Security 6 · Code 8
- **Subscreens:**
  - Start/End date pickers (OS dialog, `:34-40`) — **5/10** — Android-only (X2). An end date before the start date is accepted.
- **Strengths:**
  - Validates name, principal > 0 and a finite rate ≥ 0 (`:44-53`).
  - Write errors are surfaced (`:61-63`). Money is normalised to paise at the DB boundary (`db/ledger.ts:50-55`).
  - Uses `KeyboardSafe` and the latched `Btn` (`:69`, `:109`).
- **To reach 10/10:**
  1. Validate mobile with the existing `normalizeMobile` (`db/chitti.ts:47-56`). The ledger mobile field (`:80`) is stored unvalidated.
  2. Reject `end < start` (`:42-53`).
  3. Fix X1 (`:77`, `:83`, `:92`). Add an iOS date path. Remove the unused `Platform` (`:6`).

### `app/finance/ledger/[id].tsx` — Ledger detail — **6.5/10**
- **Route:** `/finance/ledger/[id]` · **Entry points:** `ledger/index.tsx:114`, `customer.tsx:81`, `saved.tsx:49`, `search.tsx:83`.
- **Purpose:** computed totals, actions (update, remind, PDF, delete, edit) and the event timeline for one ledger.
- **Scores:** Function 7 · States 4 · UI 8 · A11y 5 · Security 7 · Code 7
- **Subscreens:**
  - Delete confirmation (Alert, `:64-67`) — **6/10** — confirmed, but `deleteLedger(...).then(router.back)` has no catch.
  - PDF share (share sheet, `:48-62`) — **7/10** — HTML is escaped (`utils/financeIO.ts:41-42,97-98`) and failures are alerted. The PDF is left in the cache.
  - Timeline (in-screen list, `:119-139`) — **6/10** — the `reminder` label exists (`:147`), but no code writes a reminder timeline row: none of the `addTimeline` callers in `db/` uses that kind (grep).
- **Strengths:**
  - Every action leads to a real route or service (`:73-74`, `:113-116`).
  - Destructive delete is confirmed (`:64-67`).
  - Header icons are labelled with roles (`:73-74`).
- **To reach 10/10:**
  1. Add loading, error and not-found states. A failed or missing load leaves only a header (`:37-42`).
  2. Interest assumes 1 year when there is no end date and ignores repayments (`:17-24`). The hero "P + I" (`:92-93`) is a projection, not an amount due. Label it as such, or compute to today.
  3. Add a role and label to `Action` (`:156`) and the contact row (`:83`).
  4. Write a timeline row when a reminder is created from this ledger (`reminders.tsx:65-70`).

### `app/finance/ledger/edit.tsx` — Edit Ledger — **6/10**
- **Route:** `/finance/ledger/edit` · **Entry points:** `app/finance/ledger/[id].tsx:73`.
- **Purpose:** edit a ledger's terms (not its balance).
- **Scores:** Function 8 · States 4 · UI 7 · A11y 5 · Security 6 · Code 7
- **Subscreens:**
  - Start/End date pickers (OS dialog, `:43-46`) — **5/10** — Android-only (X2). No `end ≥ start` check.
- **Strengths:**
  - Same validation as create (`:50-59`).
  - The DB keeps `remaining` in step with principal only while nothing has been repaid (`db/ledger.ts:140`). Edits are timeline-logged (`db/ledger.ts:145`).
- **To reach 10/10:**
  1. `getLedger(id).then(setE)` has no catch (`:33`). Failure or a bad id shows an empty header forever (`:69`). Add loading, error and not-found states.
  2. The 90-line form is a copy of `new.tsx`. Extract a shared `LedgerForm` and reuse it in both.
  3. Validate mobile and end ≥ start. Fix X1. Remove the unused `Platform` (`:6`).

### `app/finance/ledger/update.tsx` — Update Amount — **6.5/10**
- **Route:** `/finance/ledger/update` · **Entry points:** `app/finance/ledger/[id].tsx:113`.
- **Purpose:** record a repayment. The new remaining balance is auto-calculated but can be edited.
- **Scores:** Function 8 · States 5 · UI 8 · A11y 5 · Security 6 · Code 8
- **Subscreens:** None
- **Strengths:**
  - Remaining auto-fills until the user edits it (`:29-35`).
  - Writes are paise-exact and set the status (`db/ledger.ts:112-120`). Each update is timestamped on the timeline (`db/ledger.ts:121`).
  - The latched `Btn` prevents duplicate repayments (`:73`, X6).
- **To reach 10/10:**
  1. Load has no catch (`:26`). Add loading, error and not-found states (`:37`).
  2. Warn when received > current remaining, or when the edited remaining is above the previous value (`:40-42`).
  3. Fix X1. "Amount received" and "New remaining" both read as "₹ 0" (`:62`, `:65`).
  4. Remove the unused `Platform` (`:7`).

### `app/finance/reminders.tsx` — Finance Reminders — **6/10**
- **Route:** `/finance/reminders` · **Entry points:** `index.tsx:104`, `index.tsx:155`, `ledger/[id].tsx:114`, `chitti/[id].tsx:154-157`.
- **Purpose:** local-notification reminders that can be one-off or recurring, with snooze, done and delete.
- **Scores:** Function 5 · States 5 · UI 6 · A11y 6 · Security 6 · Code 7
- **Subscreens:**
  - Add-reminder form (inline Card, `:94-110`) — **5/10** — not inside `KeyboardSafe`. The "When" button has no role or label (`:104`). A time in the past is accepted.
  - Date then time picker chain (OS dialogs, `:43-59`) — **5/10** — Android-only (X2).
  - Notification permission prompt (OS, `components/finance/notify.ts:10-19`) — **4/10** — on denial, `scheduleReminder` returns null (`notify.ts:38`), yet the reminder is still saved and listed as active (`:64-71`) with no warning that it will never fire.
- **Strengths:**
  - Loading, error-with-retry and empty states (`:112-118`).
  - Row actions are 44dp with role and row-specific labels (`:133-135`, `:168`).
  - Prefill from a ledger or chitti via params (`:26-30`).
- **To reach 10/10:**
  1. Snooze cancels a recurring notification and schedules a one-shot (`:75-79`), so a monthly reminder silently stops repeating. Reschedule the recurrence after the snooze fires.
  2. Tell the user and mark the row when `notifId === null` (`:64`).
  3. `next_at` is never advanced for recurring reminders, so Calendar and Dashboard "due today" go stale (`calendar.tsx:37`, `index.tsx:73`). Advance it.
  4. Wrap `onAdd`, `onDone`, `onSnooze` and `onDelete` in try/catch (`:61-81`). Confirm before delete (`:81`, `:135`, `:148`).
  5. Offer "Yearly", which `notify.ts:30` supports, in the segment (`:100`). A monthly trigger on day 29–31 (`notify.ts:29`) needs end-of-month handling.
  6. Add `accessibilityRole` to the header toggle (`:89`). Use `KeyboardSafe` around the form.

### `app/finance/reports.tsx` — Reports — **6/10**
- **Route:** `/finance/reports` · **Entry points:** `app/finance/index.tsx:157`.
- **Purpose:** month, year or all-time totals with PDF and Excel export.
- **Scores:** Function 5 · States 3 · UI 8 · A11y 7 · Security 7 · Code 7
- **Subscreens:**
  - Month / Year / All Time segment (Tab, `:100`) — **6/10** — the period filters on `created_at` (`:46`), so "this month" shows repayments on old loans as zero and new loans' entire history.
  - PDF / Excel export (share sheet, `:85-94`) — **6/10** — errors alerted. Excel exports an empty sheet when there are no rows (no guard at `:89-91`).
- **Strengths:**
  - Paise-exact accumulation (`:52-59`).
  - Rows and tiles carry combined a11y labels (`ui.tsx:318`, `ui.tsx:422`).
- **To reach 10/10:**
  1. Add catch, loading, error and empty states (`:43-66`), which have none today.
  2. Interest is always simple (`:51`) even for compound ledgers. Share one interest helper with the dashboard and detail screens.
  3. "Outstanding" uses raw float subtraction (`:78`, `:114`). Use `sumRupees`.
  4. "Overdue loans" is always 0 for app data (X3, `:61`).

### `app/finance/saved.tsx` — Saved & History — **6.5/10**
- **Route:** `/finance/saved` · **Entry points:** `app/finance/index.tsx:158`.
- **Purpose:** combined, date-sorted history of ledgers, interest calculations and chitti groups.
- **Scores:** Function 5 · States 8 · UI 8 · A11y 5 · Security 7 · Code 7
- **Subscreens:**
  - All / Ledger / Interest / Lucky Draw segment (Tab, `:76-79`) — **7/10** — labels shrink to fit and keep tab roles.
- **Strengths:**
  - Loading, error-with-retry and empty states (`:82-87`).
  - Ledger and chitti rows deep-link into their details (`:49`, `:61`).
- **To reach 10/10:**
  1. Interest rows have no `onPress` (`:51-56`) and cannot be deleted. `deleteInterest` (`db/interestHistory.ts:75`) has no callers (grep). Add view and delete.
  2. Show the interest rate with its unit (`:54`).
  3. Add roles and labels to cards (`:91`). Render non-pressable items as `View`, not an inert `TouchableOpacity`.
  4. Use a FlatList (`:81-105`).

### `app/finance/search.tsx` — Finance Search — **6/10**
- **Route:** `/finance/search` · **Entry points:** `app/finance/index.tsx:100`.
- **Purpose:** search ledgers and chitti groups by name, mobile or amount.
- **Scores:** Function 5 · States 5 · UI 7 · A11y 5 · Security 8 · Code 7
- **Subscreens:** None
- **Strengths:**
  - Uses the shared hardened amount parser (`:34-40`).
  - Results are memoised and capped (`:42-58`). The clear button is labelled (`:71`).
- **To reach 10/10:**
  1. An amount query matches every principal ≥ the amount (`:47`, `:56`). A 5-digit mobile prefix therefore matches most ledgers. Use exact or near matching.
  2. Read failures are swallowed (`:28-29`) and then show "No matches" (`:76`). Add an error state.
  3. Give the `TextInput` an `accessibilityLabel` (`:67-70`). Add roles to result cards (`:82`, `:99`).
  4. Search chitti member names and phones too (the header promises phone matching, `:2`). Cap the search bar to `contentMax` like the body (`:117` vs `:119`).

### `app/interest-calculator.tsx` — Legacy interest-calculator redirect — **7/10**
- **Route:** `/interest-calculator` · **Entry points:** **UNWIRED**. I grepped `app/`, `components/`, `lib/` and `utils/` for `interest-calculator` and found no `router.push`/`href` to it. The only references are this file and `INSET_SCREENS` (`app/_layout.tsx:214`). It is reachable only through the custom URL schemes (`app.json:8`).
- **Purpose:** `<Redirect href="/finance" />` for old deep links (`:10`).
- **Scores:** Function 2 · States 8 · UI 7 · A11y 8 · Security 8 · Code 8 (the average is lifted by dimensions that barely apply to an 11-line shim. As a screen it is unwired.)
- **Subscreens:** None
- **Strengths:**
  - Keeps old links working with no duplicate logic (`:1-10`).
- **To reach 10/10:**
  1. Remove the stale `'interest-calculator'` entry in `INSET_SCREENS` (`app/_layout.tsx:214`). A redirect renders nothing that needs inset padding.
  2. If old links no longer matter, delete the route. Otherwise redirect to `/finance/interest`, which is what the old URL named, instead of the hub (`:10`).

### `app/split.tsx` — Split view (two chats) — **7/10**
- **Route:** `/split` · **Entry points:** `app/(tabs)/chats.tsx:572` (selection mode, shown only when `splitReady` at `:109`, `:569`); registered at `app/_layout.tsx:1009`.
- **Purpose:** shows two real chat screens side by side or stacked, with a draggable divider, swap and close.
- **Scores:** Function 8 · States 8 · UI 8 · A11y 4 · Security 7 · Code 7
- **Subscreens:**
  - Refusal "needs two chats" (Overlay, `:93-96`) — **6/10** — a clear message, but the "Go back" button has no role (`:163`).
  - Refusal "not enough room" (Overlay, `:97-101`) — **6/10** — same missing role.
  - Divider resize (drag mode, `:131-144`) — **4/10** — drag-only, with no `accessibilityRole="adjustable"` or `accessibilityActions`, so screen-reader users cannot resize. Fix: add increment and decrement actions that call `clampRatio`.
- **Strengths:**
  - Embeds the real `ChatScreen` (`:126`, `:147`; `app/chat.tsx:235,246`), so there is no duplicated chat code.
  - Re-clamps on rotation or resize and subtracts the bar height on the correct axis (`:55-69`).
  - Uses theme `colors` for surfaces and text (`:38`, `:106-120`).
- **To reach 10/10:**
  1. Add accessibility to the divider (`:131`). Add `accessibilityRole="button"` to Swap and Close (`:114`, `:118`) and to Go back (`:163`).
  2. The PanResponder is rebuilt on every `ratio` change during a drag (`:71-81`, deps include `ratio`). Read the ratio through a ref instead.
  3. Remove the unused `Platform` (`:20`). Type `colors` instead of `any` (`:155`). Take the divider tint from theme tokens rather than `brandAlpha` (`:27`, `:136`).


---

## I2 — Shop Book & Admin Web Pages

| Screen | Route | Wired? | Score |
|---|---|---|---|
| `app/shop-book.tsx` — Shop Book mini-app (36 subscreens) | `/shop-book` (+ `vaultchat://shop-book?shop=<id>`) | Yes | **5.5/10** |
| `admin/index.html` — Admin Console | site root of the admin host (assumed, see below) | Standalone web page (one inbound link) | **6.5/10** |
| `admin/logs.html` — Server log viewer | `/logs.html` on admin.corefinite.com | **UNWIRED** (direct URL only) | **6.5/10** |
| `admin/shopbook.html` — Shop Book admin | unknown (not referenced or deployed anywhere in repo) | **UNWIRED** | **5.5/10** |

Evidence runs (read-only): `npx tsx lib/a11yCoverage.selftest.ts` → "unlabelled: 0 (budget 0)"; `lib/themeCoverage.selftest.ts` → 23 passed; `utils/shopbook.selftest.ts` → all checks passed; `services/khataWalkin.selftest.ts` → all passed. All four pass, but they miss the problems listed below. For example, the a11y scanner treats any `<Text>` inside a touchable as a label (`lib/a11yCoverage.selftest.ts:172-174`), so the unlabelled bell button with a badge `<Text>` (`app/shop-book.tsx:215-218`) passes.

---

### `app/shop-book.tsx` — Shop Book (Customer + Shop Owner mini-app) — **5.5/10**
- **Route:** `/shop-book` · **Entry points:** Mini Apps tile data `app/(tabs)/mini.tsx:53` (`route: '/shop-book'`), pushed at `app/(tabs)/mini.tsx:87-88`. Deep link/QR `vaultchat://shop-book?shop=<id>` (scheme `app.json:8`, generated at `app/shop-book.tsx:1848`, consumed via `useLocalSearchParams` at `app/shop-book.tsx:163-164` → `CustomerApp` effect `:283-286`). I found no `app/_layout.tsx`/`lib/pendingLink.ts` special handling (searched for `shop-book`; the only other hit is a comment at `components/UsageCounter.tsx:21`).
- **Purpose:** A single route with two modes (`app/shop-book.tsx:155-157`, toggle `:220-231`). Customers find shops, order, track orders and see their khata. Owners get a dashboard, orders, products/stock, khata, billing, returns, purchases and verification. Everything goes through `services/shopBookService.ts` (`api()` wrapper, `services/shopBookService.ts:1-5`).
- **Scores:** Function 7 · States 5 · UI 6.5 · A11y 5 · Security 6.5 · Code 4
- **Subscreens:** (line ranges are the component bodies)
  - **Customer › FindShops** (Tab "Shops", `app/shop-book.tsx:362-514`, row `ShopCard` `:516-546`) — **6.5/10** — FlatList (`:505-513`), location requested only when the user taps (`:383-434`), and errors shown (`:491`). The search box has no label (`:451-452`) and the category chips have no selected state (`Chip` `:4835-4842`). Fix: add `accessibilityLabel` to the search input and `accessibilityState={{selected}}` + role to `Chip`.
  - **Customer › ProductSearch** (Overlay, `:548-654`) — **5/10** — A network error is swallowed (`:573`) and then shows as "No shop nearby lists that yet." (`:613-615`). Location uses only a fresh fix (`:559`), unlike the last-known-first approach at `:412-415`. Fix: keep an error state with retry and reuse `positionOf(getLastKnownPositionAsync)`.
  - **Customer › ShopFlow details** (Step `details`, `:657-752`) — **6/10** — Real coupons and ratings, Directions via `navigateTo` (`:4860-4863`). Coupon/rating failures are silent (`:668-669`) and reviews use `key={i}` (`:741`). Fix: use a stable review key and log the failures.
  - **Customer › Catalog + "Type any product" + voice** (Step `catalog`, `:766-1023`) — **6/10** — The qty draft/blur gate is solid (`:848-881`) and Voice listeners are cleaned up (`:797-802`). A load failure shows as "No listed products" (`:792-793`, `:902`). The −/+ steppers and qty input have no labels (`:925-942`). A garbage typed qty silently becomes 1 (`:993`, since `num()` returns 0, `utils/shopbook.ts:137-144`). Fix: add an error state, labels, and an `isNum` gate on `tQty`.
  - **Customer › CartView** (Step `cart`, `:1025-1150`) — **5/10** — The idempotency key is reused across a price-change retry (`:1052-1055`, `:1085`) and there is a double-submit guard (`:1139`). **Bug:** the cart lives in `CustomerApp` (`:270`) and is never cleared on leaving a shop (`:313`) or opening another (`:300`). Items from shop A are then posted to shop B (`:1061-1063`). Fix: key the cart by `shop.id`, or clear/confirm when `selShop` changes.
  - **Customer › MyOrders** (Tab "Orders", `:1161-1203`) — **5.5/10** — FlatList with pull-to-refresh, but the error is swallowed and shown as "No orders yet." (`:1166`, `:1196`). Fix: show an error state with retry.
  - **Customer › OrderTrack** (Overlay, `:1232-1584`) — **6/10** — Realtime refetch on the socket hint (`:1269-1277`), buyer-tax form before invoicing (`:1495-1532`), collect/cancel gates (`:1477-1490`). A load failure leaves a blank body (`:1259`, `:1378-1379`). `decide()` has no busy guard (`:1302-1305`, buttons `:1456-1463`). "Repeat order" drops `productId` and has no idempotency key (`:1334-1339`), so the shop gets catalog items back as free-typed lines (see comment `:813-815`). Fix: pass `productId` plus a `clientKey()`, add an error state, and guard `decide`.
  - **ReasonModal (shared)** (Modal, `:4650-4699`; used at `:1374`, `:2453-2459`, `:4488`) — **6.5/10** — Cross-platform, keyboard-safe (`:4670`), validates input (`:4658-4660`). The reason chips have no selected state (`:4677-4680`). **Bug at the call site:** the owner reject passes only the code, so the free text typed for "other" is dropped (`:2454`). Fix: send `text` when `code === 'other'`.
  - **Customer › InvoiceView** (Overlay, `:4703-4792`) — **5.5/10** — The model is shared with the PDF (`:40`, `:4715`) and shows paid/due (`:4776-4782`). On fetch failure it alerts, then renders an empty body with no retry (`:4707-4708`, `:4726-4727`). The filename sanitiser does not strip backslash (`:4716`, `\:` is just `:`). Fix: add an `ErrorState` with retry (exists at `components/finance/ui.tsx:472`).
  - **Customer › ReturnRequest** (Overlay, `:2790-2871`) — **7/10** — Non-negative gate (`:2810-2815`), required reason (`:2820`), idempotency key (`:2794`, `:2823-2824`), busy spinner (`:2860-2862`). The per-line qty inputs have no labels (`:2851-2854`). Fix: label each input with the item name.
  - **Customer › CustomerLedgerView** (Overlay, `:1586-1624`) — **5/10** — FlatList, but the error is swallowed (`:1591`). `LedgerRow` gets no `currency` (`:1594`), so it defaults to ₹ (`:4992-4993`) even though the stat cards use `shop.currency` (`:1587`). Fix: pass `currency={shop.currency}`.
  - **Customer › CustomerProfile** (Tab "Profile", `:1626-1742`) — **5/10** — Delete-list confirmation (`:1735`), language switch (`:1700-1705`). `addList`/`removeList` have no try/catch (`:1646-1652`), loyalty uses a hard-coded ₹ (`:1676`, `:1679`), and the language chips have no selected state (`:1701`). Fix: wrap the DB calls, use the shop/locale currency, add `accessibilityState`.
  - **NotificationCenter** (Overlay from header bell, `:194-201`, `:4607-4646`) — **4.5/10** — Not virtualized (ScrollView map `:4624-4636`). Rows are not tappable (no link to order). Errors are swallowed (`:4612`, `:4617`). The header icon buttons have no label (bell `:215`, SubHeader right `:4826`). Fix: FlatList, navigate rows to `data.orderId`, label icon buttons.
  - **Owner › load-failure state** (`:1764-1786`) — **8/10** — Correctly refuses to fall through to the create form on a failed lookup, and offers retry. Fix: none significant; reuse `ErrorState`.
  - **Owner › ShopSettings / Create shop** (Overlay, `:4353-4601`; move-request ReasonModal `:4488-4490`) — **6/10** — The location-locked flow turns into a review request (`:4479`, `:4434-4444`), `permissionDenied` gives context (`:4407-4411`). It auto-fires the OS location prompt on mount (`:4448-4451`), which contradicts the "DO NOT PROMPT ON MOUNT" rationale at `:383-395`. Open/close/lunch times are free text with no HH:MM validation (`:4504-4513`), and `prepMins` uses unchecked `num(prep)` (`:4469`). Fix: drop the auto-prompt and validate times and prep.
  - **Owner › OwnerDashboard** (Tab "Dashboard", `:1839-1992`) — **6/10** — Responsive `TileGrid`/`ActionGrid` (`:1918-1923`, `:1964-1989`) and an honest margin-coverage note (`:1937-1943`). A dashboard failure is swallowed and shows zeros (`:1851`, `:1919-1922`). The settings card nests the QR touchable inside a touchable (`:1880-1901`). Fix: add an error state and split the nested touchables.
  - **Owner › Shop QR** (Modal, `:1859-1874`) — **7/10** — Opaque white quiet zone (`:1864`), share link. The QR image has no a11y label, and "Close" is styled as danger (`:1871`). Fix: `accessibilityLabel` on the QR wrapper and a neutral close style.
  - **Owner › OwnerPlans** (Overlay, `:1994-2028`) — **3.5/10** — "Upgrade to Pro" calls `SB.setPlan` (`:2000`, `services/shopBookService.ts:928-930`), which the backend says only sets the *display* column. Gates read the admin-written entitlement (`vaultchat-backend-go/internal/routes/shopbook.go:264-273`). So the app shows "★ PRO" (`:1887`) and unlocks the Advanced Reports UI (`:2078`) for an unpaid shop, and the server-gated fetch then fails silently (`:2044`). The price is hard-coded `₹499` (`:2018`) and Downgrade has no confirmation (`:2015`). Fix: drive the plan from the entitlement and replace self-toggle with a "contact/purchase" flow.
  - **Owner › OwnerReports** (Overlay with Basic/Advanced tabs, `:2033-2150`) — **5/10** — Real data and a 🔒 gate (`:2078-2083`). The error is swallowed (`:2044`). `Bars` is a component declared inside render, so it remounts every render (`:2047`). Keys use `p.name` (`:2114`, `:2136`). Fix: hoist `Bars`, add an error state, add tab a11y state.
  - **Owner › OwnerCoupons** (Overlay, `:2152-2235`) — **6/10** — Validates min-order (`:2174-2178`) and confirms delete (`:2227`). `remove` has no try/catch (`:2187`). A percent value >100 is accepted (`:2168`). Labels hard-code ₹ (`:2203`, `:2209`). Fix: range-check percent, catch delete errors, use shop currency.
  - **Owner › OwnerSuppliers** (Overlay, `:2237-2303`) — **6/10** — Confirms delete (`:2295`). `remove` has no try/catch (`:2262`) and the load error is swallowed (`:2248`). Fix: same as coupons.
  - **Owner › PurchasesScreen + "Record a purchase" step** (Overlay, `:2875-3036`; step `:2944-3006`) — **5.5/10** — Idempotency key plus duplicate-invoice message (`:2888`, `:2929-2940`). Cost price is unvalidated, so garbage becomes 0 cost (`:2920`). Item keys use `key={i}` (`:2958`). The load error is swallowed (`:2896`). Fix: add an `isBlankOrNonNegative(cost)` gate and use stable keys.
  - **Owner › ReturnsScreen + Decline modal** (Overlay `:3040-3147`, Modal `:3113-3133`) — **6.5/10** — Approve confirms with a restock choice (`:3055-3069`) and decline requires a note. With an empty note, "Decline return" is a silent no-op with no busy guard (`:3123-3124`). Fix: disable the button until the note is non-empty and guard on `busy`.
  - **Owner › AuditScreen** (Overlay, `:3150-3210`) — **6/10** — Read-only FlatList (`:3193-3207`). The error is swallowed (`:3155`). Fix: add an error state.
  - **Owner › VerificationScreen** (Overlay, `:3213-3312`) — **4/10** — The hint says "Documents are uploaded from Shop Settings" (`:3300`), but no upload UI exists anywhere in the file (grep "upload" → only `:3167`, `:3212`, `:3274`, `:3287`, `:3292`, `:3300`). `presignDocument`/`saveDocument`/`deleteDocument` exist (`services/shopBookService.ts:230-241`) and are never called. Documents open in the external browser (`:3247`). Fix: build the upload flow, or remove the claim.
  - **Owner › OwnerOrders** (Tab "Orders", `:2312-2377`) — **6.5/10** — FlatList, status filter, realtime refresh (`:2326-2329`). The error is swallowed (`:2320`) and the filter chips have no selected state (`:2357`). Fix: add an error state and chip a11y.
  - **Owner › OwnerOrderDetail** (Overlay, `:2379-2590`; Reject/Cancel/Not-collected ReasonModals `:2453-2459`) — **5.5/10** — A stock shortfall is named per item (`:2424-2431`) and there is a 24h not-collected gate (`:2443-2445`, `:2564-2577`). The reject reason text is dropped (`:2454`). `setAvail` has no busy guard (`:2397-2400`). A load error leaves a blank screen (`:2393`, `:2486`). Fix: send the text, guard availability taps, add an error state.
  - **Owner › Suggest-alternative** (Modal, `:2461-2483`) — **6.5/10** — Keyboard-safe, price gate (`:2408-2412`). Inputs are placeholder-only (`:2470-2473`). Fix: label the inputs.
  - **Owner › BillScreen** (Overlay, `:3320-3532`) — **5.5/10** — Server-authoritative totals (`:3314-3319`, `:3343-3348`) and strong gates (`:3455-3459`, `:3501-3505`). **Bug:** on load failure it alerts, then shows `LoadingState` forever with no retry (`:3337`, `:3352-3358`). Fix: separate the error and loading branches and add a retry.
  - **Owner › Bill "Add an item"** (Modal, `:3364-3414`) — **7/10** — Rejects zero qty and garbage price (`:3386-3401`). Inputs are placeholder-only. Fix: add labels.
  - **Owner › OwnerProducts** (Tab "Products", `:2592-2675`) — **6.5/10** — FlatList, starter catalog with dedup (`:2606-2618`). The error is swallowed (`:2600`). Fix: add an error state.
  - **Owner › ProductEditor** (Overlay, `:2677-2785`) — **5.5/10** — Good numeric gate (`:2711-2718`). **Delete Product has no confirmation** (`:2731-2737`, `:2778-2780`). `ToggleRow` Switch has no label (`:4888-4894`). Fix: `Alert.alert` confirm as at `:2227`, and `accessibilityLabel={label}` on Switch.
  - **Owner › BulkAdd** (Overlay, `:3698-3750`) — **6/10** — Live preview (`:3729-3741`). Lines that fail to parse are dropped without a count, and keys use `key={i}` (`:3733`). Fix: show "N lines not understood".
  - **Owner › StockScreen + item detail** (Overlay `:3537-3696`, detail `:3626-3669`) — **6.5/10** — Reason required and three distinct validation messages (`:3570-3578`). History failure is silent (`:3559`). Fix: add an error state.
  - **Owner › OwnerKhata (+ Add customer panel)** (Tab "Khata", `:3752-3900`, panel `:3826-3847`) — **6.5/10** — Explains walk-in dedup (`:3779-3785`) and the staleness banner (`:3855-3863`). The error is swallowed (`:3766`). Fix: add an error state.
  - **Owner › CounterSale** (Panel, `:3913-4016`) — **6/10** — Validation (`:3931-3941`) and "sale saved even if share fails" (`:3957-3959`). It still uses the share sheet rather than `previewDoc` (ponytail note `:3960-3963`). The "₹ each" placeholder is hard-coded (`:3990`) and rows use `key={i}` (`:3982`). Fix: switch to `previewDoc` and use currency in the placeholder.
  - **Owner › KhataDetail (+ credit-limit panel)** (Overlay `:4018-4351`, panel `:4249-4268`) — **6.5/10** — Idempotency key kept across the over-limit confirm (`:4041`, `:4112-4124`), credit-limit editing (`:4167-4190`), document issuing (`:4135-4149`). `LedgerRow` gets no currency (`:4203`). ₹ is hard-coded (`:4075`, `:4292`, `:4317`). Load failure is silent (`:4035`). Fix: pass currency and use it in the copy.
- **Strengths:**
  - Strong money-input gates across the owner flows (`isBlankOrNonNegative`/`isNum`, `utils/shopbook.ts:53-56`, `:104-108`; e.g. `app/shop-book.tsx:2711-2718`, `:3501-3505`, `:4173-4179`), covered by passing `utils/shopbook.selftest.ts`.
  - Idempotency keys on order/return/purchase/khata writes (`:1055`, `:2794`, `:2888`, `:4041`), plus server-authoritative bill totals (`:3343-3348`).
  - Long lists are virtualized as FlatList with header/footer elements (`:505`, `:1013`, `:2362`, `:2666`, `:3891`, `:4213`). Theme-aware tokens for light/dark come from `constants/financeTheme` (`:116-152`, `:5351-5364`).
- **To reach 10/10:**
  1. Fix the cross-shop cart: scope `cart` to `selShop.id` or clear/confirm on shop change (`app/shop-book.tsx:270`, `:300`, `:313`, `:1061-1063`).
  2. Make OwnerPlans reflect the entitlement, not the self-settable display column, and stop unlocking the Advanced Reports UI on `shop.plan` (`:1805`, `:2000`, `:2042`, `:2078`; backend `vaultchat-backend-go/internal/routes/shopbook.go:264-273`).
  3. Replace the 35 `catch {}` blocks (e.g. `:1166`, `:1259`, `:1851`, `:2044`, `:2320`, `:2393`, `:2600`, `:3049`, `:3766`, `:4035`, `:4612`) with the existing `ErrorState` + `onRetry` (`components/finance/ui.tsx:472`). Fix the BillScreen infinite spinner (`:3337`, `:3352`) and the InvoiceView blank body (`:4707`, `:4726`).
  4. Build the verification document upload with the existing `presignDocument`/`saveDocument` (`services/shopBookService.ts:230-238`), or remove the misleading hint (`app/shop-book.tsx:3300`).
  5. Send the owner's free-text reject reason (`:2454`). Keep `productId` and add an idempotency key on Repeat order (`:1334-1339`).
  6. Confirm before Delete Product (`:2778`) and plan Downgrade (`:2015`). Wrap `removeList`/`addList`/coupon/supplier deletes in try/catch (`:1646-1652`, `:2187`, `:2262`).
  7. Pass `currency` to `LedgerRow` (`:1594`, `:4203`) and remove hard-coded ₹ (`:1676`, `:1679`, `:2018`, `:2203`, `:2209`, `:3990`, `:4075`, `:4292`, `:4317`).
  8. A11y: label the bell and SubHeader right buttons (`:215`, `:4826`), qty steppers/inputs (`:925-942`, `:1105-1107`), Switch (`:4892`), search/Field inputs (`:451`, `:4882`). Add `accessibilityRole`/`accessibilityState` to TabBar (`:4804`), mode toggle (`:222`), Chip (`:4837`), filter chips (`:605`, `:2071`, `:2357`) and star rating (`:1566`). Tighten `lib/a11yCoverage.selftest.ts:172-174` so a badge `<Text>` does not count as a label.
  9. Remove the on-mount location prompt in ShopSettings (`:4448-4451`) and validate the time and prep fields (`:4469`, `:4504-4513`).
  10. Use safe-area insets for the bottom TabBar (`:5248-5251` hard-codes `paddingBottom: 20`). Theme the fixed amber/blue literals (`:5143-5145`, `:5285`).
  11. Split the 5,364-line file into `app/shop-book/` components. Remove the unused `Platform` import (`:16`) and the unused `deliveryBadge` styles (`:5263-5264`). Hoist `Bars` (`:2047`). Replace `key={i}` (`:741`, `:2958`, `:3733`, `:3982`, `:4278`, `:5024`) and the `as any` casts (`:103`, `:937`, `:3461`). Fix the stale "tree is keyed on the scheme" comment (`:5345`, which contradicts `:178-182`).

---

### `admin/index.html` — Admin Console — **6.5/10**
- **Route:** Static page. The only inbound link is `admin/logs.html:59` (`href="/"`, "back to dashboard"), which assumes this page is the admin site root; `admin/LOGS_DEPLOY.md:53` calls it "the dashboard index.html". Actual hosting is not verifiable statically. · **Entry points:** none in-app (grep for `admin/index.html` only hits backend comments, e.g. `vaultchat-backend-go/internal/realtime/admin_sse.go:10`).
- **Purpose:** An operator console that logs in with `x-admin-key` and shows stats/health, users, message metadata, sessions (revoke), broadcast, a live SSE event firehose and a GET API explorer (`admin/index.html:282-285`).
- **Scores:** Function 7.5 · States 7 · UI 7 · A11y 4.5 · Security 6 · Code 7
- **Subscreens:**
  - Login (Overlay, `admin/index.html:111-127`, logic `:258-272`) — **6/10** — Verifies the key against `/api/admin/stats` before storing it (`:265-266`). The `<label>`s are not associated with inputs (`:116`, `:120`) and the button is not disabled while verifying (`:263`). Fix: add `for=` and disable the button.
  - Dashboard (Tab, `:139-143`, `:309-343`) — **6.5/10** — Real stats and health using DOM `textContent` (`:318-321`, `:328-330`). **Bug:** `dashTimer` is created once (`:560-563`) and cleared on Disconnect (`:276`), so auto-refresh never resumes after re-login. Fix: start the interval in `enterApp()`.
  - Users (Tab, `:146-159`, `:346-374`) — **7/10** — Paginated, search, safe `cell()` textContent (`:370`). The search input has no label (`:149`). Fix: add `aria-label`.
  - Messages (Tab, `:162-171`, `:377-396`) — **7/10** — Metadata only, as the heading states (`:163`). The limit `<select>` has no label (`:165`). Fix: label it.
  - Sessions (Tab, `:174-180`, `:399-423`) — **7.5/10** — Revoke asks `confirm` (`:418`) and disables the button (`:419`). Errors use `alert` (`:421`). Fix: show errors inline.
  - Broadcast (Tab, `:183-195`, `:426-433`) — **5/10** — Sends to every online client with no confirmation and no disable during send (`:426-430`). `r.delivered` goes into `innerHTML` unescaped (`:431`). Fix: add `confirm()`, disable the button, use textContent.
  - Live Log (Tab, `:198-206`, `:436-557`) — **7.5/10** — `fetch`+stream keeps the key out of the URL (`:471-474`, `:524-526`). Backoff reconnect (`:553-554`), shows dropped frames (`:496-499`), caps at 500 lines (`:444`). Not `aria-live`. Fix: add `role="log"`.
  - API Explorer (Tab, `:209-216`, `:452-457`) — **7/10** — GET-only, the path must start with `/` (`:454`), output via textContent (`:455`). The input has no label (`:212`). Fix: label it.
- **Strengths:**
  - The admin key travels only in a header and is never put in the URL (`:238-245`, `:471-474`). It lives in `sessionStorage` (`:125`, `:224-226`) and is dropped on disconnect (`:277`). The server compares in constant time (`vaultchat-backend-go/internal/routes/admin.go:55`, `:67`; `admin_sse.go:160`).
  - Untrusted values are rendered with `textContent` via `el()`/`cell()`/`mono()` (`admin/index.html:231`, `:370`, `:395`). `innerHTML` only receives `esc()`'d error text (`:322`, `:341`, `:368`).
  - Responsive table overflow, auto-fill grid and a wider-screen padding breakpoint (`:64`, `:83-84`, `:105`).
- **To reach 10/10:**
  1. Restart `dashTimer` in `enterApp()` (`admin/index.html:276`, `:302-306`, `:560`).
  2. Confirm and double-submit-guard Broadcast, and render `r.delivered` with textContent (`:426-432`).
  3. Add a CSP `<meta>` (none in `:3-106`). Self-host the fonts (`:8-10`) so the admin page does not call Google. Enforce `https:` on the editable Server URL so the key cannot be sent to an arbitrary origin (`:116-117`, `:259-262`, `:240`).
  4. A11y: associate labels (`:116`, `:120`, `:186`, `:189`) and label `#userSearch`/`#msgLimit`/`#apiPath` (`:149`, `:165`, `:212`). Give tabs `role="tablist"`/`role="tab"`/`aria-selected` (`:286-295`). Make the status pill and log `aria-live` (`:132`, `:205`). Add a visible `:focus-visible` style, because inputs set `outline:none` (`:25`), and fix the `select` focus selector (`:26`). Raise the `--faint` contrast (`:15`).
  5. Offer a light theme or at least honour `color-scheme` (dark only, `:6`). Add a link to `logs.html` as `admin/LOGS_DEPLOY.md:53-54` instructs.

---

### `admin/logs.html` — Server log viewer — **6.5/10**
- **Route:** `https://admin.corefinite.com/logs.html` (`admin/LOGS_DEPLOY.md:1`, `:52`) · **Entry points:** **UNWIRED**. `admin/LOGS_DEPLOY.md:53-54` says to add `<a href="/logs.html">` to `index.html`, but `admin/index.html` has no such link (read in full; grep for `logs.html` hits only `LOGS_DEPLOY.md`). Reachable by direct URL only.
- **Purpose:** A read-only, token-gated tail of compose/journal/file logs through nginx → `admin/logserver.py` on 127.0.0.1:9999 (`admin/logs.html:115-116`, `admin/logserver.py:5-14`).
- **Scores:** Function 7.5 · States 6.5 · UI 5.5 · A11y 4.5 · Security 7 · Code 7
- **Subscreens:**
  - Token/setup overlay (Overlay, `admin/logs.html:85-94`) — **6.5/10** — Clear instructions, shown whenever disconnected (`:170`, `:187`). Fix: add a "forget token" control.
  - Source navigator (Panel, `:82`, `:129-146`) — **6.5/10** — Grouped native buttons, persists the last source (`:142`). The selected item is shown by class only, with no `aria-current` (`:141`). Fix: add `aria-current`.
  - Log view + filter/highlight/download (Panel, `:83-84`, `:154-173`, `:233-240`) — **7/10** — `esc()` before `innerHTML`, ANSI stripped (`:126-127`, `:160-161`), sticky scroll (`:241-244`). The full `innerHTML` is rebuilt every refresh (`:169`). Two polling loops can overlap with no in-flight guard (`:222`, `:249`). Fix: add an in-flight flag and append only new lines.
- **Strengths:**
  - Backend hardening: loopback-only bind (`admin/logserver.py:28`), constant-time token check (`:131-139`), fixed source whitelist with argv exec and no shell (`:40-66`, `:85-87`), clamped `lines` and regex-validated `since` (`:157-162`).
  - The token is sent as a header, never in the URL (`admin/logs.html:175-179`). The setup copy points to service diagnostics (`:91-92`).
  - Filter highlight uses an escaped regex over already-escaped text (`:162-165`).
- **To reach 10/10:**
  1. Store the token in `sessionStorage` (as `admin/index.html:125` does) instead of persistent `localStorage` (`admin/logs.html:117`, `:231`), and add a clear-token button. Logs contain IPs and ids (`admin/LOGS_DEPLOY.md:63`).
  2. Add a CSP (no meta in `admin/logs.html:3-54`; no CSP config in repo) and link this page from `admin/index.html`.
  3. Responsive layout: the fixed 210px nav plus `overflow:hidden` body (`:14`, `:33`) has no mobile breakpoint. Collapse the nav under ~700px.
  4. A11y: real `<label>`s for token, selects and filter (`:61-74`, currently `title`/placeholder only). `role="log" aria-live="polite"` on `#log` (`:84`). `aria-current` on the selected source (`:141`).
  5. Add an in-flight guard and incremental render (`:205-217`, `:219-223`, `:249`). Check `r.ok` in `api()` before `r.json()` (`:175-181`).

---

### `admin/shopbook.html` — Shop Book admin — **5.5/10**
- **Route:** unknown · **Entry points:** **UNWIRED**. Grep for `shopbook.html` across the repo returns nothing; it is not linked from `admin/index.html` and not mentioned in any deploy doc. Its backend exists (`vaultchat-backend-go/internal/routes/shopbook_admin.go:2`, guarded by `adminAuth`).
- **Purpose:** Admin for Shop Book: shop approvals, verification queue and documents, location-move decisions, entitlements, country tax JSON, categories/starter catalogs, and read-only orders/returns/audit (`admin/shopbook.html:41-43`).
- **Scores:** Function 7 · States 4 · UI 6 · A11y 4.5 · Security 5 · Code 6
- **Subscreens:**
  - Connect bar (Panel, `admin/shopbook.html:45-49`, `:121-132`) — **6/10** — The key is not persisted, only the base URL is (`:129`, `:407`). Inputs are placeholder-only (`:46-47`). Fix: add labels and require `https:`.
  - Platform stats (Panel, `:52-53`, `:134-142`) — **6/10** — Numbers are interpolated into `innerHTML` unescaped (`:137-141`). Fix: escape them or use textContent.
  - Shop approvals (Panel, `:55-60`, `:144-173`) — **5.5/10** — Names are escaped (`:149`, `:154`). Approve/Grant-badge actions have no confirm (`:156-159`). IDs go raw into inline JS (`:156-159`). After an action it always reloads "pending" (`:166`). Fix: confirm, escape or use event delegation, keep the current filter.
  - Verification queue + Documents (Panel, `:62-69`, `:230-296`) — **6/10** — A note is required for non-grant states (`:255-258`, `:288-291`) and links are short-lived (`:63`). `<a><button>` nests interactive elements (`:277`). The `viewUrl` scheme is not checked (`:277`). Reload ignores the current filter (`:261`). Fix: use a single `<a class=button>` and only allow `https:` URLs.
  - Location changes (Panel, `:71-78`, `:299-331`) — **6/10** — A refusal requires a note (`:323-326`). "Approve move" changes the customer-facing pin with no confirmation (`:313`, `:328`). Fix: add confirm with from/to.
  - Subscriptions / entitlements (Panel, `:80-83`, `:334-366`) — **5.5/10** — Shows display/entitled drift (`:337`, `:343`). Grant Pro and Back to Free have no confirmation, and expiry is free-text RFC3339 via `prompt` with no client validation (`:349-351`, `:357-360`). Fix: confirm and use a date input.
  - Country tax engine (Panel, `:85-88`, `:175-208`) — **5/10** — Raw JSON textarea editing, checked only by `JSON.parse` (`:188`, `:204`). Textareas are unlabeled (`:182`, `:198`). Fix: schema-validate before POST and label the editors.
  - Categories & starter catalogs (Panel, `:90-91`, `:210-225`) — **5/10** — Same raw JSON pattern (`:215`, `:221`). Fix: as above.
  - Support windows (Panel, `:93-101`, `:369-405`) — **5/10** — Read-only. `loadReturns` ignores the shop-id filter the UI offers (`:96` vs `:383`). Load errors are uncaught (`:369-371`, `:383`). Fix: pass `shopId` and add try/catch.
- **Strengths:**
  - `esc()` covers `& < > " '` (`admin/shopbook.html:108`) and is applied to user-supplied text fields (e.g. `:149`, `:154`, `:239`, `:310`, `:390`).
  - The admin key is never written to storage (only `sb_admin_base`, `:129`, `:407`) and is sent as a header (`:114`).
  - Refusals and suspensions require an owner-visible note (`:252-258`, `:288-291`, `:320-326`).
- **To reach 10/10:**
  1. Handle errors on every section loader: the button-triggered calls have no try/catch, so failures are silent unhandled rejections (`:57-58`, `:65-67`, `:75-76`, `:97-99` → `:144-145`, `:230-231`, `:299-300`, `:369-371`, `:383`, `:395-397`). `Promise.all` makes one failing section hide all of them (`:125-128`). Add loading indicators.
  2. Remove inline `onclick` with raw `${id}` interpolation (`:156-159`, `:243-245`, `:279-280`, `:313-314`, `:349-351`) in favour of `addEventListener`/`data-*`. Escape numeric fields (`:137-141`, `:237`, `:308-309`, `:344`, `:376`, `:388`). Add a CSP, which the inline handlers currently make impossible.
  3. Confirm consequential actions: approve, grant/remove verified, approve move, Grant Pro, Back to Free (`:156-159`, `:313`, `:349-351`). Validate the expiry date (`:357-358`).
  4. Fix `loadReturns` ignoring the shop filter (`:383`) and post-action reloads resetting filters (`:166`, `:261`, `:329`).
  5. A11y: labels for `#base`, `#key`, `#auditShop` and the JSON textareas (`:46-47`, `:96`, `:182`, `:215`). Make the `#msg` toast `role="status" aria-live` with a longer display time (`:36`, `:104`, `:109`). Fix the `<a><button>` nesting (`:277`).
  6. Link this page from `admin/index.html` (or document its deployment) so it is discoverable.


---

## J — Settings, Privacy & Vault

| Screen | Route | Wired? | Score |
|---|---|---|---|
| app/settings.tsx | `/settings` | Yes | 6.5 |
| app/privacy-dashboard.tsx | `/privacy-dashboard` | Yes | 4.5 |
| app/ghost-mode.tsx | `/ghost-mode` | Yes | 6.0 |
| app/last-seen-privacy.tsx | `/last-seen-privacy` | Yes | 7.0 |
| app/status-privacy.tsx | `/status-privacy` | Yes | 6.5 |
| app/login-history.tsx | `/login-history` | Yes | 7.5 |
| app/vault.tsx | `/vault` | Yes | 3.5 |
| app/vault-features.tsx | `/vault-features` | Yes | 3.5 |
| app/vaultdrop.tsx | `/vaultdrop` | **UNWIRED** | 2.5 |
| app/vaultcheck.tsx | `/vaultcheck` | Yes | 7.0 |
| app/vaultbeam-settings.tsx | `/vaultbeam-settings` | Yes | 5.5 |
| app/filevault.tsx | `/filevault` (redirect) | Yes | 8.0 |
| app/encrypted-notes.tsx | `/encrypted-notes` | Yes | 5.0 |
| app/d2de-status.tsx | `/d2de-status` | Yes | 5.0 |

Evidence from repo selftests (run read-only, all passed): `lib/a11yCoverage.selftest.ts` (0 unlabelled icon-only buttons; it checks only icon-only touchables, so text/emoji buttons and Switches are not covered), `lib/themeCoverage.selftest.ts` (23 passed, 21 exemptions), `lib/screenBackCoverage.selftest.ts`, `lib/orphanRoutes.selftest.ts` (asserts `/d2de-status` reachable from Settings, line 89), `lib/responsiveCoverage.selftest.ts` (asserts HEADER_TOP use in privacy-dashboard and last-seen-privacy).

Cross-cutting facts used below:
- Android FLAG_SECURE is applied app-wide by the root layout: `app/_layout.tsx:242` (`setSecure(true)`), implemented in `lib/screenGuard.ts:120-131`. iOS cannot block capture (`lib/screenGuard.ts:10-14`).
- `lib/localCache.ts:17-25` is plain AsyncStorage JSON (no encryption).
- The only in-app writer of the local PIN (`services/security/pinStore.setPin`) is `app/backup-pin.tsx:37` via `services/securityService.ts:346-348`, and that screen takes **exactly 6 digits** (`app/backup-pin.tsx:29-31`). `pinStore.setPin` accepts 4–8 digits (`services/security/pinStore.ts:53`).
- Server-side `UserSettings` has only booleans for last-seen and profile photo (`lib/chatService.ts:2626-2633`); there is no "contacts" level for them.

---

### `app/settings.tsx` — Settings — **6.5/10**
- **Route:** `/settings` · **Entry points:** `app/(tabs)/profile.tsx:298`, `app/(tabs)/profile.tsx:429`, deep link `crazzychat://settings` (`lib/pendingLink.selftest.ts:34`); registered via INSET_SCREENS `app/_layout.tsx:219`.
- **Purpose:** Hub for appearance, chat, privacy, security, data/account settings, and blocked users. It is backed by `/user/settings` and `/user/blocks` (`app/settings.tsx:3-7`).
- **Scores:** Function 8 · States 6 · UI 7 · A11y 5 · Security 7 · Code 6
- **Subscreens:**
  - Picker Sheet (media auto-download / group-add / default timer) (Sheet, `app/settings.tsx:482`, `components/ui/Sheet.tsx:35`) — **7/10** — It scrolls all options and has `accessibilityViewIsModal` and button roles (`Sheet.tsx:63-86`). It never shows the current choice because `SheetAction` has no selected state (`Sheet.tsx:20-25`). The media prefs are not awaited and have no error handling (`settings.tsx:272-274`). Fix: add `selected` to SheetAction and render a check.
  - Appearance segmented control (Tab, `app/settings.tsx:514`) — **6/10** — It is wired to the ThemeProvider through `setPref` (`:532`). The pills have no `accessibilityRole`/`accessibilityState` (`:529-536`), the active colour is a hard-coded `#FFFFFF` (`:535-536`), and the hint still says "Light mode is rolling out" (`:542`). Fix: add radio role and selected state.
  - Blocked users section (Section, `app/settings.tsx:451`) — **6.5/10** — It does a real unblock with a confirmation (`:195-208`) and has an empty-state hint (`:454`). The Unblock button has no role and no label naming the user (`:472`). Fix: `accessibilityLabel={\`Unblock ${name}\`}`.
- **Strengths:**
  - Boolean toggles are optimistic with rollback and an in-flight guard (`app/settings.tsx:111-124`).
  - Account deletion goes to a dedicated screen instead of two alerts (`app/settings.tsx:187-193`).
  - Long Android pickers use Sheet instead of the 3-button Alert, and it is mounted as a sibling of the ScrollView, not inside it (`app/settings.tsx:44-49`, `:220-226`).
- **To reach 10/10:**
  1. If `listBlocks()` or `getSettings()` fails, the screen spins forever with only an Alert and no retry (`app/settings.tsx:92-104`, `:210-217`). Load blocks independently and show an inline retry.
  2. Add `accessibilityRole="button"` to `LinkRow` (`:501`), the profile card (`:237`) and Delete account (`:442`). Give each Switch an `accessibilityLabel` (`:293`, `:580`).
  3. Delete the exported data JSON from cache after sharing (`:172-176`); right now the full account export stays in `cacheDirectory`.
  4. Await and handle failures of `setAutoDownload`, `setSaveToGallery` and `setUsageCounterEnabled` (`:272-274`, `:295`, `:146-149`). Add an in-flight guard to `savePref` (`:127-133`).
  5. Fix the misleading subtitle "Direct transfer and pairing state" (`:439`): `/d2de-status` shows encryption layers (`app/d2de-status.tsx:12-18`).
  6. Replace the hard-coded `#374151`/`#fff` switch colours with tokens (`:583-584`). Remove dead styles `backTxt`, `dataBtn`, `dataBtnTxt`, `dataHint` (`:600`, `:638-640`).
  7. Consolidate the duplicate privacy toggles that also live in `app/last-seen-privacy.tsx:30-35` and `app/privacy-dashboard.tsx:174-192`.

### `app/privacy-dashboard.tsx` — Privacy Dashboard — **4.5/10**
- **Route:** `/privacy-dashboard` · **Entry points:** `app/settings.tsx:391`
- **Purpose:** Shows a "security score" ring, a feature checklist, privacy-level chips and suggestions (`app/privacy-dashboard.tsx:1-4`).
- **Scores:** Function 3 · States 3 · UI 7 · A11y 6 · Security 3 · Code 5
- **Subscreens:**
  - Score ring (Section, `:197`) — **4/10** — The score is computed from local AsyncStorage flags that the user can flip freely (`:144-155`, `:174-180`), so it does not measure real protection.
  - Security Features checklist (Section, `:246`) — **3/10** — Face Lock, Biometric Lock, 2FA and Screenshot Protection are only written to AsyncStorage (`:138-141`), and nothing else reads them (no grep hits outside this file). Tapping "PIN Set" or "Trusted Contacts" flips local state only (`:174-180`). The real MFA state in `lib/mfa.ts:13` is ignored.
  - Privacy Controls (Section, `:316`) — **4/10** — Last-seen and profile-photo levels call the server, but "My Contacts" maps to "visible to everyone" (`:186`, `:189`; the backend only has booleans per `lib/chatService.ts:2627-2630`). "About" and "Online Status" are local only (`:182-192`, `:332`, `:340`), and errors are swallowed (`.catch(() => {})`, `:177-178`, `:186`, `:189`).
  - Improve Your Score suggestions (Section, `:365`) — **4/10** — Static text with no action. For example, "Enable Face Lock in Settings" (`:79`) points to a setting that does not exist in `app/settings.tsx`.
- **Strengths:**
  - Overlays real server, PIN and trusted-contact state at load (`:116-132`).
  - The checklist uses `accessibilityRole="switch"` with checked/disabled state (`:257-259`), and the chips use the radio role with state (`:305-306`).
  - Theme tokens and HEADER_TOP are enforced by `lib/responsiveCoverage.selftest.ts` (`:418`).
- **To reach 10/10:**
  1. Remove or wire the placebo toggles (faceLock, biometricLock, twoFactorAuth, screenshotProtection, aboutPrivacy, onlineStatus; `:38-49`, `:77-87`). Derive them from real sources (`lib/mfa.ts` `isMfaEnabled`, FLAG_SECURE at `app/_layout.tsx:242`) and make checklist rows navigate to the real setting instead of toggling local state.
  2. Remove the "My Contacts" chip for Last Seen and Profile Photo, or add backend support (`:287-291`).
  3. Surface `updateSettings` failures and roll back (`:177-178`, `:186`, `:189`).
  4. Use the `loading` state, which is set but never rendered (`:101`). The ring currently animates from `DEFAULT_SETTINGS` before real data arrives.
  5. Do not bind "E2E Encryption" to the `screenshotProtection` key (`:78` vs `:81`, keyed by index `:253`). Read `E2EE_ENABLED` (`constants/flags.ts:13`) instead of hard-coding `score = 10` (`:145`).
  6. Replace `#F59E0B`/`#FFF` with tokens (`:165`, `:265`). Give the Blocked row a button role (`:350`). Increase chip touch targets with paddingVertical 6 and no hitSlop (`:481-488`).

### `app/ghost-mode.tsx` — Ghost Mode — **6.0/10**
- **Route:** `/ghost-mode` (optional `?targetId&targetName`) · **Entry points:** `app/settings.tsx:432`, `app/chat.tsx:2146`, `app/contact-info.tsx:375`, and self-push from the list (`app/ghost-mode.tsx:130`).
- **Purpose:** Per-contact overrides that hide online, typing, read and last-seen signals, via `/user/ghost-mode` (`:3-14`).
- **Scores:** Function 7 · States 5 · UI 5 · A11y 5 · Security 6 · Code 7
- **Subscreens:**
  - List view (Mode, `:63`) — **6/10** — Cache-first, FlatList, empty state. It does not refresh after the pushed editor changes or clears overrides (fetch only on mount `:71-91`; editor pushed on top `:130`; clear calls `router.back()` `:219`). A load error with no cache falls through to "No overrides set" (`:85`, `:114-119`). Fix: refetch on focus.
  - Per-target editor (Mode, `:168`) — **6/10** — Optimistic toggles with rollback and a busy guard (`:195-208`); "Clear" is confirmed (`:211-226`). A load failure with no cache leaves a spinner with no back button (`:187`, `:229-231`). Fix: an error view with retry and back.
- **Strengths:**
  - Local-first painting with an offline fallback (`:74-86`, `:179-188`).
  - The destructive clear is confirmed (`:211-226`).
  - FlatList for the list (`:122`).
- **To reach 10/10:**
  1. Refetch the list on focus, or pass a result back from the editor (`:71-91`, `:219`).
  2. Add an error and retry view, and a back affordance on the spinner state (`:229-231`, `:93-96`).
  3. Label list rows (`accessibilityRole="button"`, name plus summary) at `:127`, and Switches (`:307`). Allow the toggle title to wrap; `numberOfLines={1}` truncates at large font sizes (`:301`).
  4. Use `AppText` instead of RN `Text` (`:29`). Add `AuroraBackground` to the list (`:99`) and editor (`:236`) for sibling consistency. Tokenise `#374151` (`:310`).
  5. Do not cache the override list (who you hide from) in plaintext AsyncStorage (`:82`, `:185`; `lib/localCache.ts:17-25`), or encrypt it.
  6. Remove dead styles `backTxt` and `rowChev` (`:325`, `:340`).

### `app/last-seen-privacy.tsx` — Last Seen & Privacy — **7.0/10**
- **Route:** `/last-seen-privacy` · **Entry points:** `app/settings.tsx:393`
- **Purpose:** Four server-enforced privacy toggles (last seen, read receipts, profile photo, discoverable) (`:3-7`, `:30-35`).
- **Scores:** Function 8 · States 6 · UI 8 · A11y 6 · Security 7 · Code 7
- **Subscreens:** None.
- **Strengths:**
  - Optimistic save with rollback, and the Switch is disabled while saving (`:51-64`, `:105`).
  - The removed fake 3-way radios are documented (`:6-7`); the copy explains read-receipt reciprocity (`:32`).
  - Tokens, HEADER_TOP and AppText throughout (`:11-17`, `:72`, `:120-138`).
- **To reach 10/10:**
  1. A load failure leaves a permanent spinner with only an Alert (`:44-48`, `:81-84`). Add a retry view and an unmount guard.
  2. Give each Switch an `accessibilityLabel={row.title}` (`:102`). Let the card title wrap (`:96`).
  3. Make the header spacer (24, `:77`) match the 40-wide back button (`:124`) so the title is centred.
  4. Deduplicate these four controls with `app/settings.tsx:306-333` (and `app/notifications.tsx` SETTING_DEFS) so one screen owns them.

### `app/status-privacy.tsx` — Status privacy — **6.5/10**
- **Route:** `/status-privacy` · **Entry points:** `app/(tabs)/status.tsx:355`
- **Purpose:** Choose who sees your status: contacts, contacts except…, or only… (`:20-24`).
- **Scores:** Function 7 · States 4 · UI 8 · A11y 7 · Security 6 · Code 7
- **Subscreens:**
  - Contact selector for except/only (List section, `:79-123`) — **6/10** — Checkbox role with state (`:114-115`). There is no empty state when the user has no direct chats, and each tap fires an unserialised save (`:61-65`).
- **Strengths:**
  - Radio and checkbox semantics with state (`:90-91`, `:114-115`).
  - Themed, uses Avatar and FlatList (`:79-123`, `:117`).
  - Clears `userIds` when mode is `contacts` (`:56`).
- **To reach 10/10:**
  1. A swallowed load error (`:51`) leaves the default `contacts` mode on screen. The next tap then overwrites the user's real server list (`:60`), which can reveal status to people they excluded. Block edits and show a retry on load failure.
  2. Roll back mode or selection when `setStatusPrivacy` fails (`:55-58`). Move `save()` out of the `setSelected` updater (`:61-65`) and serialise or debounce saves so out-of-order PUTs cannot win.
  3. Add `ListEmptyComponent` for except/only with no contacts (`:79-123`).
  4. Add an unmount guard to the load effect (`:37-53`).

### `app/login-history.tsx` — Active devices — **7.5/10**
- **Route:** `/login-history` · **Entry points:** `app/settings.tsx:428`
- **Purpose:** Lists active refresh-token sessions and supports single and bulk remote sign-out (`:3-9`).
- **Scores:** Function 8 · States 7 · UI 8 · A11y 8 · Security 7 · Code 8
- **Subscreens:** None (confirmation Alerts only, `:83-98`, `:102-118`).
- **Strengths:**
  - Both destructive actions are confirmed, and the current device is guarded in code and UI (`:82`, `:161`, `:83-118`).
  - Cache-first load, pull-to-refresh, and a cold-load error message (`:51-79`, `:142`, `:147`).
  - Rows carry role, descriptive label and disabled state (`:162-164`).
- **To reach 10/10:**
  1. Add an in-flight guard to revoke and revoke-all; a double tap can fire twice (`:88-91`, `:107-111`).
  2. Move `setError` out of the `setRows` updater (`:59-61`). Add an unmount guard (`:66-73`).
  3. Do not persist session IPs and user agents in plaintext AsyncStorage (`:56`; `lib/localCache.ts:17-25`), or encrypt them.
  4. Add a retry button next to the error text (`:142`), not only pull-to-refresh.

### `app/vault.tsx` — Vault — **3.5/10**
- **Route:** `/vault` · **Entry points:** `app/vault-features.tsx:438`, and via redirect from `/filevault` (`app/filevault.tsx:14`, reached from `app/notifications.tsx:28` and `app/dashboard.tsx:20`).
- **Purpose:** PIN-gated local store of AES-256-GCM-encrypted files with Documents/Photos/Voice/Videos tabs and a manifest "backup" (`:3-9`).
- **Scores:** Function 2 · States 4 · UI 4 · A11y 3 · Security 3 · Code 4
- **Subscreens:**
  - PIN gate (Step, `:78`) — **2/10** — It only verifies at exactly 8 digits (`:95`, 8 dots `:126`). The in-app PIN setter stores **6** digits (`app/backup-pin.tsx:29-31` → `pinStore.setPin`), so a user who sets a Device PIN from Settings (`app/settings.tsx:384`) can never open the vault. Users with no PIN get "Incorrect PIN" with no guidance. During brute-force backoff `verifyPin` returns false (`services/security/pinStore.ts:95`), which also shows "Incorrect PIN". Keys have no a11y labels; ⌫ is unlabelled (`:145-153`). Fix: accept 4–8 digits with an explicit submit, add a "no PIN set" path, and show a backoff message.
  - File tabs and list (Tab, `:455-538`) — **5/10** — Real encrypt, decrypt and delete with confirmation (`:217-258`, `:315-369`). The loading text always says "Encrypting..." even while decrypting (`:486`). Delete errors are swallowed (`:364`). Tabs have no role or selected state (`:459`).
  - Export/backup modal (Modal, `:546`) — **2/10** — It exports only the plaintext manifest of names, sizes and paths, not the files (`:380-382`). The copy claims "Files are AES-256-GCM encrypted… only you can open it" (`:561-563`) and "Auto-backup runs every 30 days" (`:592`), and no auto-backup code exists. Fix: export the encrypted blobs with a key-wrap, or rename the feature honestly and delete the false copy.
- **Strengths:**
  - File bytes really are AES-256-GCM encrypted with a PBKDF2-derived key (`lib/vaultCrypto.ts:44-68`).
  - Permission denial is handled with a settings deep-link helper (`:263-267`, `:280-284`).
  - Deletion is confirmed (`:351-368`).
- **To reach 10/10:**
  1. Fix the 8-vs-6-digit PIN mismatch (`:95` vs `app/backup-pin.tsx:29-31`) and handle no-PIN and backoff states (`services/security/pinStore.ts:95`).
  2. Vault keys are derived from the PIN, so changing the PIN in `app/backup-pin.tsx` silently makes every existing `.enc` file undecryptable (`:232`, `:325`). Wrap a random DEK under the PIN instead of deriving the file key directly.
  3. The KDF uses a single global constant salt (`lib/vaultCrypto.ts:15`) over an 8-digit keyspace. Use a per-install random salt.
  4. Delete the decrypted temp copy after sharing (`:328-339`). Sanitise `file.name` before using it in a path (`:328`).
  5. Re-lock on background and clear `vaultPin`/key cache. `clearVaultKeyCache` has no callers (`lib/vaultCrypto.ts:70`), and the PIN is held in React state (`:176`).
  6. Remove the false backup claims (`:561-563`, `:592`; also header `:8` "email option").
  7. Stream or chunk large files instead of reading whole files as base64 into JS memory (`:227-232`).
  8. A11y: label the keypad keys, the backup button (emoji only, `:426-431`), the file rows (`:505`) and delete (emoji only, `:528-533`). Add tab role and state (`:459`). Replace emoji and hard-coded colours (`:52-57`, `:722`, `:742`). Remove the unused `TextInput` import (`:17`) and dead styles `back`, `backupLabel`, `backupInput`, `fabText` (`:647`, `:761-767`, `:738`).

### `app/vault-features.tsx` — Vault Features — **3.5/10**
- **Route:** `/vault-features` · **Entry points:** `app/settings.tsx:380`
- **Purpose:** "Advanced security": temp invite code, default disappearing timer, auto screen lock, screenshot alerts, incognito keyboard, export links (`:4-12`).
- **Scores:** Function 3 · States 5 · UI 4 · A11y 3 · Security 3 · Code 4
- **Subscreens:**
  - Temp Chat Code (Section, `:246`) — **7/10** — Real `createSyncCode` (`:145`) and a real server-side revoke by re-minting (`:178-207`), with clipboard auto-clear (`:163`). The expiry label is computed once and never ticks (`:210-218`, `:264`), and the buttons have no roles (`:267-288`).
  - Disappearing timer picker (Modal, `:453`) — **2/10** — It saves `disappearTimer` to `vault_features_settings`, which nothing reads (the key appears only in this file). This conflicts with the real server timer at `app/settings.tsx:348-363`.
  - Auto screen lock picker (Modal, `:495`) — **2/10** — `lockTimer` has no consumer anywhere in app/lib/components/services/hooks.
  - Privacy toggles (Section, `:367`) — **2/10** — Screenshot Alerts and Incognito Keyboard are write-only placebo switches (`:370-399`). Only the Notifications link is real (`:401-413`).
  - Export (Section, `:417`) — **3/10** — "Email Encrypted Transcript" is an Alert followed by navigation to chats (`:422-426`). "Vault Backup — Backup vault files to email" (`:443`) opens `/vault`, which only shares a plaintext manifest (`app/vault.tsx:380-382`).
- **Strengths:**
  - The invite code uses the real single-use, 5-minute backend, and the comment fixed a wrong "24 hours" claim (`:143-146`, `:251-256`).
  - Revoke keeps the local copy on failure so a live code is not hidden (`:186-199`).
  - Prior placebo switches were already removed with rationale (`:42-47`).
- **To reach 10/10:**
  1. Delete or wire the four placebo settings: disappearTimer, lockTimer, screenshotAlert, incognitoKeyboard (`:33-41`, `:129-137`). The disappearing timer should call `updateSettings({ defaultDisappearingSeconds })` like `app/settings.tsx:348-357`. Then fix the Settings subtitle advertising them (`app/settings.tsx:380`).
  2. Replace the Export rows with real actions, or route straight to the real chat export or backup (`:420-446`), and fix their descriptions.
  3. Handle `saveSetting` and `loadSettings` errors (`:126`, `:129-137`). Tick the expiry countdown and auto-clear the code on expiry (`:210-218`).
  4. A11y: give the back button hitSlop (`:229`). Add roles to code, picker and export rows (`:267-288`, `:317`, `:352`, `:420`, `:436`). Add radio role and selected state to modal options (`:468-488`, `:510-530`). Label the Switches (`:390`).
  5. Replace the hard-coded colours with tokens (`:326`, `:393-395`, `:591-592`, `:617`, `:676`). Remove dead styles (`:552`, `:613`, `:648`, `:666-700`) and the stale "Fake PIN modal" comment (`:96`).

### `app/vaultdrop.tsx` — VaultDrop — **2.5/10**
- **Route:** `/vaultdrop` · **Entry points:** **UNWIRED**. Its only reference is `components/VaultFeatureSheet.tsx:26`, and `VaultFeatureSheet` is never imported anywhere. I grepped app/, components/, lib/ for `VaultFeatureSheet` and `vaultdrop`; the only other hits are `app/_layout.tsx:979` (stack registration) and `lib/responsiveLayout.selftest.ts:237`.
- **Purpose:** Pick files and "send them encrypted via D2DE" (`:3-5`, `:209`).
- **Scores:** Function 1 · States 3 · UI 4 · A11y 3 · Security 1 · Code 4
- **Subscreens:** None.
- **Strengths:**
  - Document picking works and handles cancel (`:67-93`).
  - Uses safe-area insets (`:62`, `:168`).
  - The remove button is labelled with hitSlop (`:159`).
- **To reach 10/10:**
  1. The "Send" is a 2-second `setTimeout` simulation that then says "File sent with D2DE encryption" (`:98-102`). There is no recipient and no transport. Wire it to the real VaultBeam send path or delete the screen.
  2. Remove the false claim "All files encrypted with AES-256-GCM before sending. Server never sees plaintext." (`:185`) until it is true.
  3. Replace placeholder text such as the literal word "Shield" as an icon (`:183`). Give the "Back" text button a role and label (`:172`). Tokenise the `BRAND_ACCENT`/hex colours (`:221-246`).
  4. Use stable IDs instead of `Math.random` (`:78`). Guard the async timer against unmount (`:99-101`).

### `app/vaultcheck.tsx` — VaultCheck (Verify media) — **7.0/10**
- **Route:** `/vaultcheck` · **Entry points:** `app/chat.tsx:1715` (message action "Verify" on received image or video). The "media viewer" entry claimed in the header comment (`:5`) was not found by grep.
- **Purpose:** On-device authenticity analysis (C2PA plus rPPG) with a shareable report (`:3-12`).
- **Scores:** Function 8 · States 7 · UI 6 · A11y 6 · Security 8 · Code 7
- **Subscreens:**
  - Report view (Section, `:98-169`) — **7/10** — Real `verifyMedia` and `formatReport` (`lib/vaultcheck/index.ts:68`, `:162`). The copy states its limits: "not checked" (`:148-158`), issuer trust not checked (`:125`), and the disclaimer (`:165-168`). The share button has no role (`:160`).
  - Error state (`:90-96`) — **5/10** — Shows the message, but has no retry and no hint on what to do.
- **Strengths:**
  - Cancellation guard on the async work (`:41-62`).
  - Nothing is uploaded: it resolves a local file first (`:44-55`).
  - The native header was fixed to provide a back control (`:76`).
- **To reach 10/10:**
  1. Add a retry action on error (`:90-96`) and a timeout or progress indicator for long video analysis (`:80-88`).
  2. Use theme tokens for verdict and error colours (`:26-28`, `:92`, `:161`, `:217`).
  3. Add `accessibilityRole="button"` to Share (`:160`). Allow `Row` values to wrap beyond 3 lines (`:181`).
  4. Validate the `uri` route param (any string is accepted and read, `:46`), or drop it, since no caller passes it (`app/chat.tsx:1715-1722`). Type `S` instead of `any` (`:177`).

### `app/vaultbeam-settings.tsx` — VaultBeam auto-download — **5.5/10**
- **Route:** `/vaultbeam-settings` · **Entry points:** `app/settings.tsx:423`
- **Purpose:** Preferences for auto-accepting VaultBeam files by network, sender, size and battery (`:1-5`).
- **Scores:** Function 4 · States 6 · UI 5 · A11y 4 · Security 7 · Code 6
- **Subscreens:**
  - Auto-download options (Mode, `:55-81`) — **4/10** — Most values are consumed by `lib/vaultBeamAutoDownload.ts:54-83`, but the whole feature is off (`VB_AUTODOWNLOAD = false`, `constants/flags.ts:165`; disclosed at `:42-46`). "Pause while roaming" is never read (`lib/vaultBeamAutoDownload.ts:75-76`).
- **Strengths:**
  - The screen states honestly that the feature is disabled in this build (`:42-46`).
  - The 2.5 GB manual-approval ceiling is explained (`:73`).
  - Reactive settings store via `useVBSettings` (`:23`).
- **To reach 10/10:**
  1. Remove the "Pause auto-downloads while roaming" toggle, or implement it (`:62` vs `lib/vaultBeamAutoDownload.ts:75-76`).
  2. Fix the double top inset. The screen is in INSET_SCREENS (`app/_layout.tsx:221`), which already pads it per `app/settings.tsx:595-597`, and it also adds `paddingTop: Platform.OS==='ios'?54:40` (`:123`).
  3. A11y: add radio role and selected state to `Radio` (`:99`). Label the Switches (`:116`).
  4. Type the colour props instead of `colors as any` and `any` props (`:26`, `:88-109`). Set a `false` track colour (`:116`).
  5. Surface persistence failures from `patchSettings`; they are swallowed in `lib/vaultBeamSettings.ts:105`.

### `app/filevault.tsx` — File Vault (redirect) — **8.0/10**
- **Route:** `/filevault` · **Entry points:** `app/notifications.tsx:28` (NAV, rendered via `:168`, `:300`), `app/dashboard.tsx:20`
- **Purpose:** Legacy alias that redirects to `/vault` (`:1-14`).
- **Scores:** Function 6 · States 9 · UI 8 · A11y 9 · Security 8 · Code 8
- **Subscreens:** None.
- **Strengths:**
  - Replaces a fake vault with a single real one; the reasoning is documented (`:3-9`).
  - Minimal code (`:13-15`).
- **To reach 10/10:**
  1. The destination gate is unusable for 6-digit PIN holders (`app/vault.tsx:95`), so every "Vault" nav tap dead-ends. Fix the vault itself.
  2. Point the callers directly at `/vault` (`app/notifications.tsx:28`, `app/dashboard.tsx:20`), then drop the alias and its INSET_SCREENS entry (`app/_layout.tsx:212`).

### `app/encrypted-notes.tsx` — Encrypted Notes — **5.0/10**
- **Route:** `/encrypted-notes` · **Entry points:** `app/(tabs)/mini.tsx:54` (Apps tab tile, pushed at `:87-88`); a deep link is referenced in a comment (`:111`).
- **Purpose:** PIN-gated, AES-256-GCM notes vault with categories, markdown, attachments, tags, trash, reminders, password generator and passphrase backup (`:2-15`).
- **Scores:** Function 7 · States 4 · UI 5 · A11y 4 · Security 6 · Code 4
- **Subscreens:**
  - PIN gate (Step, `:588-618`) — **6/10** — Server-verified MPIN (`:49`, `:162`) and fails closed (`:165-166`), but this means local notes cannot be opened offline. PinPad keys have no labels (`components/PinPad.tsx:48`), and Cancel has no role (`:612`).
  - Notes list, search and categories (Main, `:646-712`) — **6/10** — FlatList. Locked notes mask their preview and are excluded from body search (`:578`, `:686-688`). The 🔑 generator button (`:650`) and category chips (`:657-666`) are unlabelled, and the trash action is only on long-press (`:677`).
  - Note editor (Modal, `:725`) — **4/10** — `saveNote` has no try/catch or double-tap guard (`:359-379`). Cancel discards without a prompt (`:729`). Removing an attachment deletes the encrypted file before Save, so Cancel leaves the saved note pointing at a deleted file (`:330-333`). Attachments added and then cancelled are orphaned. The reminder picker is Android-only (`DateTimePickerAndroid`, `:429`). There is no `onRequestClose` (`:725`).
  - Markdown preview mode (Mode, `:757`) — **7/10** — Themed renderer (`:1060-1075`). The toolbar glyph buttons (`‹›`, `❝`, `🔗`) have no labels (`:766-778`).
  - Password generator (Modal, `:881`) — **7/10** — CSPRNG with rejection sampling (`:411-423`) and auto-clear copy (`:563-566`). No `onRequestClose` for the Android back button (`:881`).
  - Image viewer (Modal, `:904`) — **6/10** — Shows the decrypted image. The Close button has no role and colours are hard-coded (`:907-908`, `:1150-1152`).
  - Secure Trash (Modal, `:914`) — **5/10** — Restore re-arms reminders (`:393-399`). "Delete Forever" has no confirmation (`:936`, `:401-406`). No `onRequestClose` (`:914`).
  - Locked-note challenge (Modal, `:948`) — **7/10** — Nothing of the note renders before the PIN passes (`:245-266`). Shares the PinPad a11y gap.
  - Backup & restore (Modal, `:976`) — **6/10** — Passphrase-wrapped DEK with an "occupied" overwrite confirmation (`:503-517`, `:538-551`). The Replace branches have no try/catch (`:511-513`, `:544-548`). "Change passphrase" rewraps without checking the old passphrase (`:1019`).
- **Strengths:**
  - Re-lock on background drops the DEK and the gate (`:140-151`). FLAG_SECURE is applied app-wide (`app/_layout.tsx:242`).
  - The trash 30-day purge, reminders and per-note lock are actually enforced (`:204-228`, `:260-266`).
  - The backup design keeps ciphertext everywhere and documents the restore traps (`:447-453`, `:504-507`).
- **To reach 10/10:**
  1. Prevent data loss after a failed load. `loadNotes` swallows every error (`:234`) and returns early on an undecryptable blob (`:201`), leaving `notes=[]`. The next save then overwrites the sealed blob (`:237-240`, `:373`). Also, `getDEK` silently creates a new key when the old one is missing (`lib/notesCrypto.ts:19-24`). Block writes when load failed and show a recovery prompt.
  2. The AppState listener closes the editor on any non-`active` state (`:141-148`). On Android, launching the image or document picker or share sheet from the editor (`:297`, `:310`, `:339`) likely backgrounds the app, which would discard unsaved edits mid-attach. This needs device verification; preserve the draft or ignore system-picker transitions.
  3. Make attachment removal take effect on Save, not immediately (`:330-333`). Clean up orphaned attachments on Cancel (`:729`). Confirm before Cancel discards edits.
  4. Add a confirmation to "Delete Forever" (`:936`). Add error handling and an in-flight guard to `saveNote` and the Replace branches (`:359-379`, `:511-513`, `:544-548`).
  5. The gate is UI-only: notes are decrypted at mount, before the PIN (`:194`), with a device-stored key that does not depend on the PIN (`lib/notesCrypto.ts:17-29`). Load after unlock and clear `notes` state on re-lock.
  6. A11y: label the PinPad keys (`components/PinPad.tsx:48`). Add roles to back (`:627`), Cancel (`:612`), the generator (`:650`), the md toolbar (`:775`), colour dots (`:823`) and tag chips (`:832`). Use switch role and state on the Sensitive, PIN Lock and Reminder rows (`:841-861`).
  7. Use `HEADER_TOP` instead of the hard-coded 56/44 padding (`:1079`, `:1124`). Use AppText instead of RN `Text` (`:21`). Tokenise `#555` placeholders and `#ff6b6b`/`#EF4444` (`:649`, `:611`, `:812`).
  8. Split this 1180-line single component (around 40 `useState`, `:101-191`) into gate, list, editor and backup components. Provide an iOS reminder picker or hide the row off-Android (`:429`).

### `app/d2de-status.tsx` — Encryption status — **5.0/10**
- **Route:** `/d2de-status` · **Entry points:** `app/settings.tsx:439` (asserted by `lib/orphanRoutes.selftest.ts:89`)
- **Purpose:** Shows which encryption layers are active (`:1-2`), from `getD2DEStatus()` (`services/d2deService.ts:51-60`).
- **Scores:** Function 4 · States 6 · UI 5 · A11y 5 · Security 4 · Code 7
- **Subscreens:** None.
- **Strengths:**
  - Status is derived from the real `E2EE_ENABLED` flag (`services/d2deService.ts:52`, `constants/flags.ts:13`).
  - Themed native header (`:33`).
  - Status is shown as text (ACTIVE/PENDING), not only colour (`:62-64`).
- **To reach 10/10:**
  1. Fix the `LAYER_INFO` key mismatch: `'Android Keystore'` (`:17`) vs the layer name `'Secure Keystore'` (`services/d2deService.ts:58`), which leaves that card's explanation empty (`:68`).
  2. Remove inaccurate copy: "stored in Firestore" (`:14`; the app says "No Firebase, no Firestore" at `app/settings.tsx:9`), the unverifiable "Non-exportable even with root access" (`:17`), the competitor claim (`:76-77`), and "see roadmap below" with no roadmap (`:50`).
  3. The screen is a compile-time flag readout, not "live" (`:2`). Either reflect runtime and session state or retitle it. Align the Settings subtitle (`app/settings.tsx:439`).
  4. Replace the hard-coded `#00FF88`/`#F3F4F6`/`#D1D5DB`/`#FFD16633` with tokens (`:44`, `:57`, `:59`, `:104`).


---

## K — Utilities, Comfort, Games & Productivity

| Screen | Route | Wired? | Score |
|---|---|---|---|
| `app/notifications.tsx` — Alerts & Safety | `/notifications` | Yes (vault-features, dashboard nav) | **6/10** |
| `app/notification-sounds.tsx` — Notifications & Sounds | `/notification-sounds` | Yes (Settings) | **6.5/10** |
| `app/storage-manager.tsx` — Storage Manager | `/storage-manager` | Yes (Settings) | **6/10** |
| `app/cache-cleanup.tsx` — Cache cleanup | `/cache-cleanup` | Yes (Storage Manager) | **7.5/10** |
| `app/offline-mode.tsx` — Offline Mode | `/offline-mode` | Yes (Settings) | **3/10** |
| `app/vision-comfort.tsx` — Vision Comfort | `/vision-comfort` | Yes (Settings, chat menu, Eye Check) | **8/10** |
| `app/eye-check.tsx` — Eye Check | `/eye-check` | Yes (Vision Comfort) | **8/10** |
| `app/perf-debug.tsx` — Diagnostics | `/perf-debug` | Yes (hidden long-press) | **8/10** |
| `app/dashboard.tsx` — Security Hub | `/dashboard` | Weak (only from `/notifications` nav bar) | **6.5/10** |
| `app/games.tsx` — Games hub + 4 boards | `/games` | Yes (Mini tab, push, deep link, chat card) | **7.5/10** |
| `app/email-bridge.tsx` — Encrypted Email | `/email-bridge` | **UNWIRED** | **2.5/10** |
| `app/meeting-scheduler.tsx` — Meeting Scheduler | `/meeting-scheduler` | **UNWIRED** | **4/10** |

Selftests run for evidence (all passed): `lib/a11yCoverage.selftest.ts`, `lib/themeCoverage.selftest.ts` (23 assertions; Rummy/Chess/Ludo exempted at `lib/themeCoverage.selftest.ts:41`), `lib/responsiveCoverage.selftest.ts`, `lib/gamesBackCoverage.selftest.ts` (17 assertions), `lib/games/gamesNative.selftest.ts`, `services/cache/cachePlan.selftest.ts`, `lib/eyeCheckModel.selftest.ts`, `lib/visionComfort.selftest.ts`. A passing theme/a11y guard does **not** clear the hard-coded colours or unlabelled controls cited below; those guards don't flag them.

---

### `app/notifications.tsx` — Alerts & Safety — **6/10**
- **Route:** `/notifications` · **Entry points:** `app/vault-features.tsx:405`, `app/dashboard.tsx:21` (pseudo nav bar), stack registration `app/_layout.tsx:1039`
- **Purpose:** Has three tabs: SOS history, privacy toggles and notification-preview privacy, and a panic button that sends an SOS with location to trusted contacts (`notifications.tsx:53`, `:184`).
- **Scores:** Function 7 · States 6 · UI 6 · A11y 5 · Security 7 · Code 6
- **Subscreens:**
  - SOS HISTORY tab (Tab, `notifications.tsx:194`) — **6.5/10** — Shows real `listSOSHistory` data with cache-first paint (`:86-107`) and an empty state (`:195`), but has no refresh or retry. Fix: add pull-to-refresh that calls `loadSos` (`:71`).
  - PRIVACY tab (Tab, `notifications.tsx:212`) — **6/10** — The switches and preview radios really work (`updateSettings` `:164`; `setNotifPreview` `lib/privacyPrefs.ts:87`). When `settings` is null after a failed fetch with no cache, the tab renders blank with no error (`:212`). The switches have no `accessibilityLabel` (`:222`, `:260`). Fix: add an error row with retry and labelled switches.
  - PANIC tab (Tab, `notifications.tsx:265`) — **6.5/10** — The panic button calls `sendSOS` for real (`:135`), arms with a 3-second countdown and can be cancelled (`:145-158`). The button label stays "Panic alert" in every state (`:272`), and the copy says to add contacts "from a contact's profile" (`:282`) even though `app/trusted-contacts.tsx` exists. Fix: link to `/trusted-contacts` and announce the armed/countdown state.
- **Strengths:**
  - SOS sends whether or not location permission is granted (`:128-136`). `lib/permissionDeadEnd.selftest.ts:47` documents this.
  - Partial-failure merge keeps the cached sections (`:100-106`).
  - The glow loop is now stopped on unmount (`:116-121`).
- **To reach 10/10:**
  1. Give the privacy tab an error and retry state when `settings` is null (`:212`). Right now a failed fetch leaves an empty tab.
  2. Panic tab: when `contacts.length===0` because the fetch failed, the user is told to add contacts (`:155`). Tell "load failed" apart from "none", and link to `/trusted-contacts` (`:282`).
  3. Add `accessibilityLabel` to every `Switch` (`:222`, `:260`). Expose armed and countdown state on the panic button (`:272`, e.g. `accessibilityState`/live region).
  4. Replace 7–9pt text (`:179`, `:202`, `:206`) with type-scale sizes. Replace hard-coded reds `rgba(239,68,68,…)`/`#FFFFFF` (`:169`, `:267`, `:275`) with `colors.danger` tokens.
  5. The bottom nav uses a fixed `bottom:18` (`:333`), unlike dashboard's `SCREEN_BOTTOM` (`dashboard.tsx:216`). It also pushes a new route on every tap (`:168`), so the stack grows when bouncing between Alerts and Shield. Use `SCREEN_BOTTOM`, and use `replace` or drop the duplicated NAV (`:24-30` duplicates `dashboard.tsx:16-22`).
  6. Revert on failure restores the whole stale snapshot (`:165`), which can undo a concurrent successful toggle. Revert only the key that failed.
  7. Remove the unused `colors`/`S` in `NotificationsScreen` (`:316-317`) and the `as any` casts (`:168`, `:185`).

### `app/notification-sounds.tsx` — Notifications & Sounds — **6.5/10**
- **Route:** `/notification-sounds` · **Entry points:** `app/settings.tsx:416`
- **Purpose:** Sets in-app message tones, call vibration and the call ringtone, with a preview. Settings persist via `lib/sounds` (`notification-sounds.tsx:13-15`).
- **Scores:** Function 6 · States 6 · UI 7 · A11y 5 · Security 8 · Code 8
- **Subscreens:** None (the ringtone list is inline, `:82-93`).
- **Strengths:**
  - Message-sound and vibrate prefs are actually honoured (`lib/sounds.ts:71`, `:106`).
  - The preview stops on unmount (`:26`).
  - Small, theme-token styles (`:104-117`).
- **To reach 10/10:**
  1. The ringtone choice is ignored whenever the native ringer is available: `startRingtone` plays the system ringtone (`lib/sounds.ts:96-97`) and reads `p.ringtone` only in the fallback branch (`:100`). Either honour the pick natively or say on screen that Android uses the phone ringtone.
  2. Ringtone rows need `accessibilityRole="radio"` and `accessibilityState.checked` (`:85`). The play icon looks like a separate control but is decorative (`:90`).
  3. Label both `Switch`es (`:58`, `:73`).
  4. While prefs load the screen is an empty `View` (`:36`). Show a spinner or skeleton.
  5. `stopRingtone()` on unmount (`:26`) also cancels vibration and the system ringtone (`lib/sounds.ts:110-113`). If an incoming call rings while the user leaves this screen, the call ring stops. Guard it so it stops only the preview sound.
  6. Use theme tokens instead of `thumbColor="#fff"` (`:62`, `:77`) and use `AppText` like the siblings (`:8`).

### `app/storage-manager.tsx` — Storage Manager — **6/10**
- **Route:** `/storage-manager` · **Entry points:** `app/settings.tsx:430`, stack `app/_layout.tsx:1002`
- **Purpose:** Measures real on-disk usage by type and by chat, and offers clear cache, delete all media and delete old cached media (`storage-manager.tsx:1-12`).
- **Scores:** Function 8 · States 6 · UI 4 · A11y 4 · Security 8 · Code 6
- **Subscreens:**
  - Destructive confirmations (Alert ×3, `storage-manager.tsx:157`, `:190`, `:214`) — **8/10** — Each states clearly what is kept and what is lost. The delete-old flow reports no count (`:225`). Fix: return and show the number removed.
- **Strengths:**
  - Real walk over `measuredRoots()` plus OS free space (`:117`, `:148`).
  - Real `purgeMedia` (`:199`), and per-chat attribution that links to the chat (`:86-89`, `:309`).
  - Every destructive action asks first (`:157`, `:190`, `:214`).
- **To reach 10/10:**
  1. Any measurement error is swallowed and the screen shows "0 B" and "No app files on disk yet." (`:149-151`, `:287-288`). Show an error state with retry.
  2. Every card uses a hard-coded `['#0F2847','#F9FAFB']` gradient, plus `#F9FAFB` in the header, `#112240` borders and `#FF9F43` (`:255`, `:268`, `:285`, `:305`, `:324`, `:340`, `:386`, `:391`, `:401`, `:143`). These are wrong in both light and dark. Use `colors.glass`/`glassStroke`.
  3. Add `accessibilityRole="button"` and labels to the action rows, the day chips and the per-chat rows (`:308`, `:331`, `:343`, `:348`, `:358`).
  4. "Cache cleanup" is not disabled while `clearing` (`:343`). Async `setState` runs after unmount with no guard (`:111-154`).
  5. `walk()` both measures and deletes (`:58-91`) and duplicates `services/cache/cacheManager.ts:47-60`. Reuse the cache manager. Drop `info: any` (`:68`) and the `as any` casts (`:292`, `:309`, `:343`).

### `app/cache-cleanup.tsx` — Cache cleanup — **7.5/10**
- **Route:** `/cache-cleanup` · **Entry points:** `app/storage-manager.tsx:343`
- **Purpose:** A thin UI over the tested cache planner. It clears rebuildable cache by category, offers one-tap Smart cleanup, and sets auto-clean and clear-on-logout (`cache-cleanup.tsx:1-7`).
- **Scores:** Function 8.5 · States 7 · UI 7 · A11y 4 · Security 9 · Code 8.5
- **Subscreens:**
  - Clear confirmation (Alert, `cache-cleanup.tsx:72`) — **8.5/10** — Shows the bytes to be freed and states what is safe. Fine as is.
- **Strengths:**
  - Settings are really enforced: auto-clean runs at boot (`app/_layout.tsx:568`) and logout clears the cache (`app/(constants)/authService.ts:379`).
  - The planner is Node-tested (`services/cache/cachePlan.selftest.ts` passes).
  - Actions are guarded: `busy` and an empty plan disable them (`:119`, `:150`).
- **To reach 10/10:**
  1. Add role and state for checkbox rows and chips (`:135`, `:161`: `accessibilityRole="checkbox"`/`"radio"`, `accessibilityState`). Label the `Switch` (`:173`) and the Smart button (`:119`).
  2. `load()` has no try/finally (`:48-55`). A rejection leaves the spinner on forever. The hero also shows "0 B reclaimable" while loading (`:114`).
  3. `dbCache` is always reported as 0 (`services/cache/cacheManager.ts:72`) yet appears as a selectable category. Hide it or label it "not measured".
  4. Theme the `Switch` track like siblings do (`:173`). Replace `'#fff'` (`:120`, `:162`, `:203`) with an on-primary token.

### `app/offline-mode.tsx` — Offline Mode — **3/10**
- **Route:** `/offline-mode` · **Entry points:** `app/settings.tsx:431`, stack `app/_layout.tsx:1005`
- **Purpose:** Claims to show connection status, the pending message queue, sync progress and cache. Only the NetInfo status is real (`offline-mode.tsx:74-82`).
- **Scores:** Function 2 · States 3 · UI 4 · A11y 4 · Security 3 · Code 3
- **Subscreens:**
  - Sync progress card (Overlay card, `offline-mode.tsx:317`) — **2/10** — Its progress comes from an 800 ms sleep per item (`:152-153`), not real sends. Fix: drive it from `lib/messageQueue` events.
  - Clear cache confirmation (Alert, `offline-mode.tsx:173`) — **3/10** — Deletes every AsyncStorage key whose name contains "cache" or "temp" (`:177-179`). That includes the local-first `vc_cache_*` entries (`lib/localCache.ts:19`) and `chats_paint_cache` (`app/(tabs)/chats.tsx:238`). Fix: route to `/cache-cleanup`.
- **Strengths:**
  - Live NetInfo connection status (`:74-76`).
  - The pulse loop is stopped on unmount (`:90-98`).
- **To reach 10/10:**
  1. Remove the fabricated data: the seeded demo queue "Alice Chen…" written to storage (`:108-115`), "+5_200_000 simulated" cache (`:125`), a fake "last sync 1h ago" (`:129`), and the static "Auto-retry: Active" (`:293`). Read the real queue instead (`lib/messageQueue.ts:286` `pendingForChat`, `:268` `retry`, `:596` `flush`).
  2. `retryAll` empties the queue and alerts "N messages sent successfully" (`:161-169`) without sending anything. This misleads users about delivery. Call `messageQueue.retry/flush` and report real results.
  3. Replace the keyword-match AsyncStorage wipe (`:177-179`) with the cache-cleanup planner, or link to `/cache-cleanup`.
  4. Replace hard-coded gradients and colours with tokens (`:200`, `:214`, `:241`, `:269`, `:404`, `:418`, `:452`). Add roles and labels to the Retry/Clear buttons (`:299`, `:384`).
  5. Delete the dead branch (`:78-81`) and the duplicate `formatBytes` (`:43-49`).

### `app/vision-comfort.tsx` — Vision Comfort — **8/10**
- **Route:** `/vision-comfort` · **Entry points:** `app/settings.tsx:259`, `app/chat.tsx:2007`, `app/eye-check.tsx:229` (replace with params). Status-bar inset is applied by the root (`app/_layout.tsx:222`).
- **Purpose:** Per-glasses display profiles (level, contrast, transparency) with a live chat preview, persisted via `useVisionComfort` (`vision-comfort.tsx:23`).
- **Scores:** Function 8 · States 7.5 · UI 8 · A11y 9 · Security 8.5 · Code 7.5
- **Subscreens:**
  - Eye Check suggestion card (Overlay card, `vision-comfort.tsx:114`) — **8/10** — Prefills a stronger draft from the Eye Check params (`:35-39`) and clearly says it is not a prescription.
  - Live preview + vertical level slider (Mode, `vision-comfort.tsx:131-164`) — **9/10** — An adjustable role with increment/decrement actions and a value (`:148-151`), plus 48 dp +/− buttons (`:262`).
  - Sight-description step (Step, `vision-comfort.tsx:179-200`) — **7/10** — The spectacle-power `TextInput` (`:191`) is never read: `finishSightStep` ignores it and clears it (`:92-96`). The hint logic depends on exact UI strings (`:93`). Fix: remove the input or explain it, and key the options by id.
  - Discard-changes dialog (Alert, `vision-comfort.tsx:45`) — **8/10** — Protects unsaved edits when switching profile, but not when pressing Back (`:106`).
- **Strengths:**
  - Strong accessibility: an adjustable slider (`:148-151`) and minimum targets of 44–52 dp (`:240`, `:247`, `:262`, `:279`).
  - Save has a busy guard and reports partial failure honestly (`:57-71`).
  - Wired app-wide: the provider and model have 39 consumers. `lib/visionComfort.selftest.ts` passes.
- **To reach 10/10:**
  1. Confirm before "Reset this profile" (`:73-84`, `:224`).
  2. Guard Back against unsaved changes, the same way profile switching is guarded (`:106` vs `:44-49`).
  3. Remove or wire the spectacle-power input (`:190-194`). Replace string-matched sight kinds with ids (`:93`, `:183`).
  4. Replace `JSON.stringify` equality (`:44`) with a field comparison, and `'#FFFFFF'` on primary (`:125`, `:198`, `:280`) with an on-primary token.

### `app/eye-check.tsx` — Eye Check — **8/10**
- **Route:** `/eye-check` · **Entry points:** `app/vision-comfort.tsx:172`. Inset is applied by the root (`app/_layout.tsx:223`).
- **Purpose:** A multi-step screening flow (C-gap acuity per eye, colour plates, astigmatism, Amsler grid). The summary hands a suggestion to Vision Comfort (`eye-check.tsx:31`, `:229`).
- **Scores:** Function 8.5 · States 7.5 · UI 8 · A11y 7.5 · Security 9 · Code 6.5
- **Subscreens:**
  - Intro (Step, `eye-check.tsx:121`) — **8.5/10** — Clear disclaimers and urgent-symptom guidance.
  - Screen setup ×4 (Step, `eye-check.tsx:128-155`) — **8/10** — The calibration track is adjustable with actions (`:135-141`).
  - Acuity per eye + switch + result (Step, `eye-check.tsx:157-181`) — **7.5/10** — Direction buttons are labelled (`:174`). Correct/incorrect feedback is an icon only, with no live region (`:176`).
  - Colour plates + result (Step, `eye-check.tsx:183-192`) — **8/10** — The text feedback is visible (`:189`).
  - Astigmatism + result (Step, `eye-check.tsx:194-200`) — **8/10**.
  - Amsler grid + result (Step, `eye-check.tsx:202-209`) — **8/10**.
  - Summary (Step, `eye-check.tsx:211-233`) — **8/10** — Results are not stored (`:230`). Handoff via `router.replace` (`:229`).
- **Strengths:**
  - Logic lives in a tested model (`lib/eyeCheckModel.ts`; selftest passes).
  - A double-answer guard (`:45`, `:62`, `:73`).
  - Documented white test-field exemptions (`:169`, `:186`, `:197`, `:205`), and a responsive ring that switches to a grid when narrow (`:48-52`, `:171`).
- **To reach 10/10:**
  1. Clear the 650 ms `setTimeout`s on unmount (`:65-69`, `:76-82`).
  2. Announce acuity feedback (`accessibilityLiveRegion` or text) instead of the icon-only centre (`:176`). Use the `colors.danger`/success tokens instead of `#15803D`/`#B91C1C` (`:176`, `:189`).
  3. Ask before Back mid-test (`:115`), since all progress is lost.
  4. Split the 100+ character single-line JSX blocks (`:122-232`) into per-phase components.

### `app/perf-debug.tsx` — Diagnostics — **8/10**
- **Route:** `/perf-debug` · **Entry points:** `app/(tabs)/profile.tsx:441` (long-press on the version), stack `app/_layout.tsx:1036`
- **Purpose:** A hidden read-out of transport state, CC-Wire counters, the boot timeline and the last 20 send timings, refreshed every second (`perf-debug.tsx:1-7`, `:30-37`).
- **Scores:** Function 9 · States 8.5 · UI 7.5 · A11y 7 · Security 7 · Code 8
- **Subscreens:** None.
- **Strengths:**
  - Real data from `perf.snapshot()`/`ccwireDiagnostics()` (`:26-28`), and the interval is cleaned up (`:36`).
  - Honest notes on what the counters mean (`:70-77`).
  - Empty states for boot marks and sends (`:100-101`, `:123-124`).
- **To reach 10/10:**
  1. It is reachable by any user through a long-press (`profile.tsx:441`) and shows send ids and the last transport error (`:87`, `:127`). Gate it behind a dev or diagnostics flag.
  2. Replace `#F59E0B` (`:156`, `:178`) with a warning token. Type `Row`'s `S: any` (`:146`).
  3. Give the timing table header and rows an accessible summary (`:117-134`). Add `SCREEN_BOTTOM` padding (`:60`).

### `app/dashboard.tsx` — Security Hub — **6.5/10**
- **Route:** `/dashboard` · **Entry points:** `app/notifications.tsx:26` only (the pseudo nav bar), stack `app/_layout.tsx:986`
- **Purpose:** A security score and six checks derived from `/user/security-overview` (`dashboard.tsx:26-41`, `lib/security.ts:47-51`).
- **Scores:** Function 6.5 · States 6 · UI 6 · A11y 7 · Security 7.5 · Code 7
- **Subscreens:** None.
- **Strengths:**
  - Real overview with a cache-first paint (`:64-77`), and cached shape round-trips are guarded by `lib/securityOverviewNegotiation.selftest.ts`.
  - Wrapped in an `ErrorBoundary` (`:189-195`), and nav uses `SCREEN_BOTTOM` (`:216`).
  - Back, refresh and nav are labelled (`:105`, `:110`, `:174`).
- **To reach 10/10:**
  1. The `Animated.loop`s are never stopped (`:82-86`; the effect returns no cleanup). This is the same leak already fixed in `notifications.tsx:110-121`.
  2. OK and REVIEW use the same colour: `scoreColor` returns `colors.accent` for both branches (`:96`), and so does `col` (`:151`). Use `colors.danger` or a warning token for REVIEW.
  3. Make each REVIEW check actionable: deep-link to the privacy toggles, sessions and devices screens (`:150-168`). The rows are read-only today.
  4. The error state has no retry button (`:149`), and refresh has no in-flight guard (`:110`).
  5. Wire a real entry point (Settings/Security). Today it is reachable only through notifications' bottom bar, and that bar duplicates this NAV (`:16-22`) and pushes on every tap (`:91`).

### `app/games.tsx` — Games hub + boards — **7.5/10**
- **Route:** `/games` (`?game&room&auto&bot&seat`) · **Entry points:** `app/(tabs)/mini.tsx:59`, push-notification tap `app/_layout.tsx:669`, games turn push `app/_layout.tsx:822`, chat invite card `components/chat/MessageBubble.tsx:455`
- **Purpose:** A hub of four server-refereed native games, with quick match, private rooms, bots, live tables, wallet, leaderboard, history and invites. It also hosts each board inside `GameChrome` and an `ErrorBoundary` (`games.tsx:141-171`).
- **Scores:** Function 7 · States 6.5 · UI 8 · A11y 7 · Security 8 · Code 7.5
- **Subscreens:**
  - ModeSheet (Sheet, `games.tsx:582`) — **8/10** — Offers three honest ways to play, with a rummy-specific intent instead of a minted code (`:358-375`).
  - Searching (Overlay, `games.tsx:519`) — **6/10** — The error state offers only Cancel, no retry (`:548-559`). Cancelling while "Connecting…" doesn't stop the socket from opening afterwards: `close()` runs before `wsRef` is set (`lib/games/useQuickMatch.ts:56-62` vs `:69-73`). It is an absolute ScrollView, not a Modal.
  - BotOffer (Overlay, `games.tsx:634`) — **7.5/10** — Clearly says it's a bot and offers an invite. Hardware back leaves the hub instead of closing the overlay (the BackHandler is attached only when a board is open, `:131-135`).
  - LeaderboardSheet (Sheet, `components/games/LeaderboardSheet.tsx:41`) — **8.5/10** — Loading, error with retry, and empty states (`:106-118`). 44 dp tabs (`:90`). Doesn't invent a rank (`:59-69`).
  - HistorySheet (Sheet, `components/games/HistorySheet.tsx:87`) — **7/10** — Local record and expandable chess moves. "Clear" deletes with no confirmation (`:121-126`).
  - InviteSheet (Sheet, `components/games/InviteSheet.tsx:28`) — **7/10** — Posts a real chat card and falls back to a share link (`:51-78`). A failed `listChats` shows "No chats yet." (`:45`, `:103-106`). The sheet closes before the send finishes, with no progress shown (`:53`).
  - RulesSheet (Sheet, `components/games/rules.tsx:98`) — **7/10** — Accurate per-game rules and shown on first run (`:128-145`). It nests a ScrollView inside Sheet's ScrollView (`:105` vs `feedback.tsx:236`), the gesture fight that `HistorySheet.tsx:108-111` and `Chess.tsx:757-760` warn about. It also shows "Got it" plus Sheet's own "Close" (`:116` + `feedback.tsx:239`).
  - VoiceSheet (Sheet, shared, `components/games/feedback.tsx:370`) — **5.5/10** — Join, mute, speaker and leave all work. The privacy copy "Audio goes straight between players' phones — never through the games server" (`:444`) contradicts the implementation: audio "now passes through crazzychat's SFU… no frame encryption on a table room" (`lib/games/useTableVoice.ts:32-35`). Fix the copy.
  - **Chess** (Board, `components/games/Chess.tsx:251`) — **7/10** — Moves come from the server's `legal` list (`:282`, `:389-406`), there is a promotion picker, and rank and file labels are correct when flipped (`:1545-1550`). Resign sends immediately with no confirmation (`:691-692`). Pieces are announced as letters ("white p", `:1547`; "Promote to q", `:1342`). `Square`'s memo is defeated by an inline `onPress={() => onSquare(idx)}` (`:562`), contrary to the comment at `:806-812`.
    - Lobby (Mode, `Chess.tsx:1362`) — **7.5/10** — Shows feedback when add-bot stalls (`:1437`). Start is disabled for a non-host with no explanation (`:1440`).
    - Connecting / failure (State, `Chess.tsx:1448`) — **8/10** — Retry on error.
    - Table settings (Sheet, `Chess.tsx:744`) — **8/10** — Swatches meet the 44 dp target via asymmetric hitSlop (`:1294`). Persisted board choice (`:342-346`).
    - Players (Sheet, `Chess.tsx:1218`) — **8/10** — Doesn't guess sides for 3+ members (`:1231`).
    - Promotion picker (Overlay, `Chess.tsx:1314`) — **6.5/10** — Not a Modal, so hardware back opens the "Leave table?" alert (`games.tsx:133`) instead of cancelling.
    - Draw-offer banner (Overlay, `Chess.tsx:650`) — **6/10** — Triggered by a regex on toast text (`:370-373`) instead of a protocol field.
  - **Ludo** (Board, `components/games/Ludo.tsx:124`) — **7.5/10** — Driven by the server's `movable` list, tokens reach 44 dp through computed hitSlop (`:1019`), shape markers help colour-blind players (`:1075-1078`), and the dice tumble is guarded (`:542`). Token labels don't give board position (`:1022`).
    - Lobby (Mode, `Ludo.tsx:302`) — **7.5/10** — Stake chooser defaults to free (`:327-361`), and deal waits for seats instead of a timer (`:236-243`). "Joining the table…" never times out if the lobby never arrives (`:268-277`).
    - Dice-fairness receipts (Sheet, `Ludo.tsx:673`) — **8.5/10** — Says honestly what wasn't published.
    - Emote (Sheet, `Ludo.tsx:706`) — **7.5/10**.
    - Settings (Sheet, `Ludo.tsx:736`) — **6/10** — A single Sound row; no rules or invite. Add "How to play" here, since rules are reachable only from the lobby (`:401`).
  - **Rummy** (Board, `components/games/Rummy.tsx:160`) — **7/10** — The server owns the deal, a turn lock stops double-taps (`:408-438`), stale selections are filtered (`:458-462`), and drag-to-discard is gated (`:579-593`). DROP forfeits points but sends immediately from the action bar (`:1041`) and from settings (`:1155-1160`), while Declare asks first (`:1109`). Text is unreadably small: 5.5–7.5 pt (`:2375`, `:2443`, `:2521`, `:2602`, `:2711`). The stale comment says voice "rides the GAME socket… no SFU" (`:347-349`).
    - Table list (Mode, `Rummy.tsx:1420`) — **7.5/10** — A typed code is checked against the server's list (`:1456-1468`), and an empty filter is explained (`:1582-1602`). The record fetch uses a hard-coded `https://games.corefinite.com/api/me` and fails silently (`:1477-1485`).
    - Seat failed (State, `Rummy.tsx:1496`) — **8/10**.
    - Room / lobby (Mode, `Rummy.tsx:1723`) — **7.5/10** — Busy lock (`:1805-1813`). Auto-deals after 60 s with a visible countdown (`:1766-1793`). Warns when it substituted a table (`:1849-1856`).
    - Pool & Deals panel (Panel, `Rummy.tsx:1307`) — **7/10** — Renders nothing when the backend is absent (`:1321`).
    - Result (Sheet, `Rummy.tsx:1910`) — **8/10**.
    - Standings (Sheet, `Rummy.tsx:2280`) — **8/10**.
    - Leave confirmation (Sheet, `Rummy.tsx:1073`) — **6/10** — Says leaving means "the round is scored against you" (`:1075`), while the hub's leave dialog says the game keeps running and nothing is forfeited (`games.tsx:107-112`, `:120`). Make the copy consistent.
    - Declare confirmation (Sheet, `Rummy.tsx:1109`) — **8.5/10** — Shows the advisory verdict and the cost (`:1113-1117`).
    - Emote (Sheet, `Rummy.tsx:1087`) — **7.5/10**.
    - Table settings (Sheet, `Rummy.tsx:1125`) — **7/10** — The Drop row has no confirmation (`:1155-1160`).
  - **Tic-Tac-Toe** (Board, `components/games/TicTacToe.tsx:47`) — **7/10** — Cells are labelled with row and column (`:410-414`), and reduced motion is respected (`:286`). "Add a bot" calls raw `send` with no stall feedback and no host gating (`:174`), unlike Chess and Ludo's `useAddBot` (`Chess.tsx:1375`, `Ludo.tsx:162`, `:405`). Rules are not reachable once a game starts.
    - Lobby (Mode, `TicTacToe.tsx:129`) — **6.5/10** — As above.
- **Strengths:**
  - Boards are boundary-wrapped, the exit stays outside the boundary, and back is never a dead end (`games.tsx:99-102`, `:156-164`). `lib/gamesBackCoverage.selftest.ts` passes.
  - The bot offer is never silently swapped for a human match (`:222-231`). Play-coin disclaimers appear everywhere (`:264-266`).
  - The shared `Btn` has role, state and a 44 dp minimum (`components/games/ui.tsx:457-469`). `Sheet` avoids the a11y-collapse bug (`feedback.tsx:213-226`).
- **To reach 10/10:**
  1. "Join a table by code" always opens rummy (`games.tsx:240`), despite the comment saying it opens "the game the player last tapped" (`:238-239`). Rummy then rejects or substitutes non-rummy codes (`Rummy.tsx:1456-1462`), so codes for chess, ludo and tic-tac-toe are dead here. Add a game picker or encode the game in the code.
  2. Fix the VoiceSheet privacy copy (`feedback.tsx:444`) to match the SFU without E2EE (`useTableVoice.ts:32-35`).
  3. Confirm destructive game actions: chess Resign (`Chess.tsx:691`), rummy Drop (`Rummy.tsx:1041`, `:1159`), and History Clear (`HistorySheet.tsx:125`). Align the rummy leave copy with the hub (`Rummy.tsx:1075` vs `games.tsx:120`).
  4. Fix the quick-match cancel race (`useQuickMatch.ts:56-73`; check `aliveRef` or a cancelled token before opening the socket). Add Retry to Searching (`games.tsx:559`). Refresh "Your games" on focus; it loads only on mount (`useLiveTables.ts:52-56`) and failures are silent (`:48`).
  5. Make Searching, BotOffer and PromoPicker real Modals, or handle hardware back for them (`games.tsx:541`, `:640`; `Chess.tsx:1331`).
  6. Accessibility: say piece names instead of letters (`Chess.tsx:1547`, `:1342`). Raise rummy micro text to `T.xs` or higher (`Rummy.tsx:2375`, `:2521`, `:2602`, `:2711`). Show a non-host why Start is disabled (`Chess.tsx:1440`).
  7. Performance: pass `onSquare` plus `sq` instead of an inline closure (`Chess.tsx:562`) so `Square`'s memo holds.
  8. Code health: remove the stale "no SFU" comment (`Rummy.tsx:347-349`) and the duplicate `useReduceMotion` (`Rummy.tsx:1196` vs `./ui`). Centralise the `games.corefinite.com` host, which is repeated in `Rummy.tsx:1477`, `lib/games/useWallet.ts:25`, `useLeaderboard.ts:12` and `gamesSocket.ts:33`. Remove RulesSheet's nested ScrollView and duplicate close (`rules.tsx:105`, `:116`). Use `useAddBot` in TicTacToe (`:174`).

### `app/email-bridge.tsx` — Encrypted Email — **2.5/10**
- **Route:** `/email-bridge` · **Entry points:** **UNWIRED**. The only reference in app/components/lib is the stack registration `app/_layout.tsx:997` (grepped `email-bridge`, `/email-bridge`, `pathname:` forms). It is still reachable by deep link (`app.json:8` schemes).
- **Purpose:** A mock "AES-256-GCM encrypted email" composer and inbox (`email-bridge.tsx:1-2`).
- **Scores:** Function 1 · States 3 · UI 5 · A11y 3 · Security 1 · Code 3
- **Subscreens:**
  - Decrypt modal (Modal, `email-bridge.tsx:277`) — **1.5/10** — "Decrypting" is a 1.2 s `setTimeout` (`:114-120`), and the "Decrypted Successfully" body is hard-coded mock text (`:17-50`, `:344-350`).
- **Strengths:**
  - Basic input validation, including an email regex (`:75-92`).
  - Mostly theme tokens via `makeStyles(c)` (`:362`).
- **To reach 10/10:**
  1. Delete the screen or put it behind a flag. "Send" is a 1.8 s timer that alerts "encrypted with AES-256-GCM and sent successfully" (`:95-104`), and the inbox is `MOCK_INBOX` (`:17-50`). Those are false security claims on a routable URL.
  2. If kept, implement a real backend and key exchange, then label the inputs (`:164-198`) and add roles to the Send/Decrypt buttons (`:201`, `:257`, `:315`).
  3. Remove the dead styles (`backArrow` `:390`, `modalClose` `:624`) and the hard-coded `#3A4A6B` placeholders (`:167`, `:181`, `:192`).

### `app/meeting-scheduler.tsx` — Meeting Scheduler — **4/10**
- **Route:** `/meeting-scheduler` · **Entry points:** **UNWIRED**. The only reference is the stack registration `app/_layout.tsx:995` (grepped `meeting-scheduler` in app/components/lib/constants).
- **Purpose:** A local-only meeting list with natural-language date parsing, a mini calendar and a time picker, stored in AsyncStorage `vc_meetings` (`meeting-scheduler.tsx:1-3`, `:35`).
- **Scores:** Function 4 · States 4 · UI 3 · A11y 3 · Security 6 · Code 4
- **Subscreens:**
  - MiniCalendar (Picker, `meeting-scheduler.tsx:201`) — **3.5/10** — Picking a day writes `formatDateTime(d)` into the text field (`:585-588`), and the `[dateInput]` effect re-parses it (`:378-385`). I ran the copied parser: "Mon, Oct 5 at 3:30 PM" parses to 05:00, because the "5" in "Oct 5" is taken as the time. "Fri, Oct 2 at 11:00 PM" picked today parses to 2 Oct **2027** 02:00 (the month-day path rolls a past date into next year, `:159-160`).
  - TimePicker (Picker, `meeting-scheduler.tsx:297`) — **3/10** — Hits the same re-parse bug (`:593-596`), so the chosen time is overwritten. The AM/PM control has no label (`:340`).
  - Delete confirmation (Alert, `meeting-scheduler.tsx:452`) — **7/10** — Works, but is reachable only by long-press (`:643`).
- **Strengths:**
  - Validates title, date and past dates (`:408-419`).
  - Has an empty state and a loading state (`:630-637`).
- **To reach 10/10:**
  1. Stop round-tripping picker output through the text parser (`:585-596` + `:378-385`). Keep `parsedDate` as the source of truth.
  2. Fix the unreachable "day after tomorrow" branch: `tomorrow` matches first (`:91` before `:100`), so "day after tomorrow 4pm" returns tomorrow. Move the parser to `lib/` with a selftest.
  3. Add reminders or notifications, or sharing to a chat. Today the list is inert local data. Give the screen a real entry point or delete it.
  4. Use `useTheme()` instead of the hard-coded dark palette `C` (`:17-33`).
  5. Add roles and labels to calendar cells, chips, AM/PM and meeting cards (`:260-279`, `:550-556`, `:340`, `:640`). Add a visible delete button instead of long-press only (`:643`, `:669`).
  6. Surface load and save errors (`:398-399`, `:463-466` has no catch). Replace the `any` types (`:369`, `:392-395`).


---

