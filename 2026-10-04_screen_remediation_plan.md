# VaultChat — Screen Remediation Plan

_Companion to `2026-10-04_screen_ratings.md` (193 screens, mean 6.0/10). Every item below comes from a cited finding in that report; the line references are there._

## How to run this plan

- **Order matters.** Phases go from "users are misled or trapped" to "polish". A later phase must not start until the earlier phase's exit check passes.
- **OpenSpec first (per `AGENTS.md`).** Reuse active changes before proposing new ones:
  - `interaction-integrity`: double-taps, swallowed failures, spinners that never stop. This matches the report's "errors look like empty states" and missing-confirmation patterns.
  - `harden-audit-findings`: decorative security controls and account purge. This matches the vault, lock and key-wipe findings.
  - `glass-screen-polish`: theme, typography and layout. This matches the hard-coded colour and light-mode findings.
  - Items with no matching change get a new proposal per phase. Validate with `openspec validate <change> --strict`.
- **Checks.** Install dependencies first, then record the baseline and run these again after every phase: `npm test`, `npm run lint`, `npm run typecheck`, and `openspec validate --all --strict --no-interactive`. They have not run yet, because `node_modules` was not installed for this review.
- **Written ≠ verified.** Items marked 📱 need a physical-device check before they count as done.

## Phase 0 — Stop misleading or trapping users (1–2 days)

Goal: no screen claims something that didn't happen, and no screen can trap the user.

1. **Decide the fate of each mock or legacy screen.**
   - **Delete:** `scanner`, `email-bridge`, `vaultdrop`, `contact`, `lock`, `security-questions`, `biometric-setup`, `setup-complete`.
   - **Repoint:** where `docscanner`, `broadcast` or `vault` already does the job, point the route there instead.
   - **Rewrite or hide:** for `offline-mode` and `call-recording`, either rewrite against the real outbox and recording services, or remove the entry until they are real.
   - **Cleanup:** remove each deleted route's `Stack.Screen` from `app/_layout.tsx` and update `lib/orphanRoutes.selftest.ts`.
2. **Fix the `/blocked` trap.** Privacy Dashboard should open the blocked-contacts list, not the security block screen (`app/privacy-dashboard.tsx:349`).
3. **Remove the `[sos-probe]` instrumentation** (`app/emergency-sos.tsx:68-76`), and 📱 confirm the route opens on a device.
4. **Correct copy that misstates what the app does:**
   - "notified" in call recording.
   - "on all your devices" in Calls.
   - The privacy claim in contact sync, which sends an unsalted SHA-256 of each number.
   - The "straight between phones" claim in the games voice sheet.
   - The network-call list in Lock settings.
   - The new-login alert promise in Trusted contacts.
   - The "full schedule" claim on the EMI PDF.
   - "THIS MONTH" on the finance dashboard.
5. **Hide toggles that nothing reads, until they work:**
   - Voice effect.
   - Vault-features timers.
   - Left-behind alerts.
   - VaultBeam roaming.
   - "Include videos" in chat backup.
   - The device-command buttons in Spaces.

**Exit check:**
- `orphanRoutes` passes.
- A grep for "sent successfully", "notified" and "encrypted" finds no stub code paths.

## Phase 1 — Security and data-loss fixes (week 1)

1. **Vault**
   - Make the vault accept the same PIN length that `backup-pin` sets (`app/vault.tsx:94` vs `app/backup-pin.tsx:29-31`).
   - Wrap the file key under a per-user salt, so a PIN change doesn't orphan stored files (`lib/vaultCrypto.ts:15`).
   - Delete decrypted cache copies after viewing.
   - Make "Export" honest: either really encrypt it or relabel it.
2. **Locks**
   - Call `checkLockOnResume` from an AppState listener in the root layout.
   - Give `app-lock-chats` a real entry point from chat or contact info.
   - While a chat is locked, suppress read receipts, the reading signal and notification clearing.
   - Gate `in-chat-search` behind the chat lock.
   - Add an attempt limit to the chat PIN, and store it with a salted KDF instead of an unsalted SHA-256 (`lib/chatLock.ts:29`).
3. **PIN and account**
   - Require the current PIN before changing it (`app/backup-pin.tsx:34-38`).
   - Require re-authentication for account deletion.
   - Ask for confirmation before the Alerts "Scan device" action can wipe keys.
4. **Plaintext at rest**
   - Move the bookmarks and scheduled-message caches, the ghost-mode list and login-history IPs to the sealed store.
   - Make message reminders respect the tray-privacy setting.
   - Extend `lib/mediaCacheGC.ts` to cover the decrypted temp files left by the file viewer, archive viewer and file preview.
   - Delete the chat-export file after sharing, and decrypt messages (`hydrateMessages`) before export.
5. **View-once and Invisible Ink**
   - Pass the `viewOnce` and `encrypted` flags through `listAllAttachments`, so Shelf opens files with protection.
   - Filter view-once media out of the gallery.
   - Remove Forward and Copy from the action sheet for these messages.
6. **Data-loss guards**
   - In encrypted notes, block saving after a load failure, never silently regenerate a missing key, and defer deleting an attachment until Save.
   - In status privacy, don't save over the server list after a failed load.
7. **Input and size limits**
   - Archive viewer: check the declared size before inflating, to stop zip bombs.
   - Finance CSV: escape cells against formula injection, add an import de-duplication key, and confirm before restore.
8. **Telemetry and web**
   - `UsageCounter`: send the route pattern, not the raw pathname that contains invite codes.
   - Admin pages: add a CSP, and store the log token in `sessionStorage`.
   - `shopbook.html`: escape values placed in inline handlers, and confirm before Approve or Grant Pro.

**Exit check:**
- New selftests pass: vault PIN length parity, chat lock blocking read receipts, UsageCounter path normalisation.
- 📱 Lock on resume works on Android.

## Phase 2 — Broken core flows (week 2)

| Area | Fix |
|---|---|
| Emergency SOS | Send the SOS message before `toggleShare` (`app/family.tsx:969`). Show an error with retry when contacts fail to load. Take the "notified" count from the server reply. Stop shake detection while the screen is not focused. |
| Spaces transport | Run builder: assign riders to stops and send stop coordinates and times (`app/space-runs-admin.tsx:121,151`). Upload driver safety alerts. Add device-command polling, acknowledgement and heartbeat on the device side. Add a guardian phone to the roster for "Call guardian". Give the parent view a live map. Pass `canManage` to the Roster. |
| Chat | Add `composerLp` to the `onSend` dependency list (`:1605`). Wire or delete the quick-react modal. Roll back a failed edit. Hide Back in split view. Add a "Slide to cancel" gesture or change that text. |
| Media | Video player: read duration from a ref in the `PanResponder`, add an `onError` state, and throttle resume saves. Media viewer: hoist the player components out of render. Image editor: apply brush, brightness and contrast to the output, and fix text drift. |
| Shop Book | Keep a separate cart per shop. Route Pro through a real entitlement purchase, or hide the button. Build the verification-document upload. Keep the "other" reject reason. Add retry when a bill fails to load. Pass the shop's currency to `LedgerRow`. |
| Finance | Add an iOS date-picker branch. Number chitti members by max number + 1. Keep recurrence on snooze. Warn when notification permission is denied. Build the interest PDF from the calculated result. Use real `overdue` and chitti status transitions. |
| Groups | Make `listCommunities` throw instead of returning `[]` (`lib/chatService.ts:2671`). Check that the author of a note or task edit matches the sender. Schedule calendar reminders. Report a failed privacy save. Make "End trip" persist. Give `group-info` a back button and retry. |
| Location | Pass the chosen alternative route to `startNavigation`. Keep the Location Lock "you" marker live, add a catch on `arm()`, and show the correct alarm-bar state. Send the stop event when live sharing ends. Prevent a second "start live location" tap from leaking a watcher. Show imperial units in lock history. |
| Family | Create typed circles from `/family-setup`. Make leave and delete report failures. Show per-member tracks in history. Remove the overlap between map overlays. |
| Calls & live | Decline the call on Android back in the incoming-call screen, and guard accept and decline against double taps. Let the host end a broadcast from the starting and failed states. Make network-test show "failed" instead of invented speeds. |
| Other | Give message requests a real data source, or remove the screen. Make games join-by-code open the right game. Fix the Meeting Scheduler date parser, or remove the screen. Give TermsGate a fresh re-check on foreground. Offer the restore step in the mpin-entry flow. |

**Exit check:**
- Focused selftests are added for each pure-logic fix: chitti numbering, the scheduler parser, run stop assignment, and listCommunities error handling.
- 📱 Device pass for SOS, video seek, image editor output, and a Spaces driver run.

## Phase 3 — App-wide quality (weeks 3–4)

1. **Errors vs empty.** Have services throw on failure, and render a shared error state with retry. One candidate is `components/finance/ui.tsx:472`; move it to `components/ui` first. This fits `interaction-integrity`. Start with Shop Book's 35 empty `catch {}` blocks and the Spaces screens.
2. **Confirmations.** Add one confirm helper and use it for every destructive action:
   - Delete Product.
   - Chess Resign and Rummy Drop.
   - Clearing game history.
   - "Delete Forever" in notes.
   - Admin broadcast.
   - Delete account, if not covered in Phase 1.
3. **Accessibility.** Extend `lib/a11yCoverage.selftest.ts`:
   - Require `accessibilityRole` on every `Touchable`/`Pressable`/`<Text onPress>`.
   - Require `accessibilityState` on toggles and selectable chips.
   - Stop counting glyph-only text as a label.
   - Fix what it finds, and give the finance `Field` a real label instead of its placeholder.
4. **Theme.** Tighten `lib/themeCoverage.selftest.ts` to flag literal colours in style objects, then fix:
   - Media-viewer code view.
   - Video controls.
   - SOS text.
   - "Remove lock" button.
   - The light-theme contrast of the crash modal's "I'm OK" button.

   This fits `glass-screen-polish`.
5. **Code health.**
   - Split `app/chat.tsx` (4,588 lines) and `app/shop-book.tsx` (5,364 lines) into per-subscreen modules.
   - Remove the legacy call code that never runs while `CALL_ENGINE_V2` is on.
   - Clear unused imports with lint, and reduce `as any` casts.

**Exit check:**
- The stricter a11y and theme selftests pass.
- Lint is clean on the touched files.

## Phase 4 — Wiring and consolidation (week 5)

1. **Merge duplicates.**
   - `create-group` into `group-create`, which uses invite-based consent.
   - The `group-admin` and `group-members` role and remove logic, into one permission check.
2. **Make the group tools reachable for all groups.** Calendar, notes, tasks, insights, trip and privacy are reachable only from Family; link them from `group-info` for ordinary groups too.
3. **Deep links.** Add https intent filters (and iOS associated domains) for the `/add`, `/join` and `/channel` links the app already shares. Add a confirmation step to `/add`, `/join` and `/i`, as the in-app scanner has.
4. **Unwired screens to keep.** Wire them in or delete them, with no orphans left: `stickers`, `slideshow`, `voice-transcribe`, `voice-speed`, `current-location`, `location-sharing` and `sync-contact`. Delete `components/VaultFeatureSheet.tsx` and `components/ui/ChatRow.tsx` if nothing uses them.
5. **Redirect shims.** Keep the `filevault` and `interest-calculator` redirects for old links. Delete `group-chat` and `creator-channels` if no old links depend on them.

**Exit check:**
- `orphanRoutes` passes, with an empty allowlist apart from the intentional redirects.

## Phase 5 — Re-rate and verify (week 6)

- Re-run the same six-dimension rubric on every screen, and compare against the 2026-10-04 baseline.
- Physical-device checklist on Android (Redmi and Honor are in the repo's cold-start logs) and iOS:
  - SOS and Location Lock.
  - Calls.
  - The video player.
  - View-once.
  - The encrypted-notes picker.
  - A Spaces run.
  - A Shop Book order.
- Sync the delta specs and archive the OpenSpec changes only when `openspec/config.yaml` delivery conditions are met.

## Expected score movement (estimate, not a measurement)

| After phase | Effect on scores |
|---|---|
| 0 | Unwired and mock screens are removed or fixed. The worst 20 scores leave the table. |
| 1–2 | Most "Function", "States" and "Security" sub-scores rise by 1–3 points on the affected screens. |
| 3 | "A11y", "UI" and "Code" rise across the app. These are the dimensions that cap most screens at 6–7 today. |
| 4–5 | Remaining gaps are mostly the per-screen "To reach 10/10" items in the report. |

A screen reaches 10/10 only when every item in its own "To reach 10/10" list in `2026-10-04_screen_ratings.md` is done and device-verified.
