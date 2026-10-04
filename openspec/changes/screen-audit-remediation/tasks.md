# Implementation plan — screen audit remediation

Levels, as elsewhere in this repo:

- **written**: code in the repo, `tsc` clean, focused selftests pass.
- **deployed**: on prod (deploys are FILE COPY, not git). Not applicable to most of this change,
  which is app code shipped by an app release.
- **device-verified**: proven on a physical phone, not inferred from a log.

Per-item detail, with file:line evidence, lives in `2026-10-04_fix_status.md` and the
updated ratings it links. Rounds 1–2 changed no backend file. Round 3 wrote the server
changes the app was blocked on (commit `3353236`, `vaultchat-backend-go` plus migrations
140 and 141). Rounds 4–5 added contracts C1–C19, the visitor-pass revoke route,
`GET /stories/audience?base=1` and the `order_status` side tag (commits `730e5b9`, `433030b`,
`4910069`, `db1d68b`, `2a05e46`; migrations 142, 143 and 144). All of it is **written, not
deployed**; the copy list and order are in `2026-10-04_fix_status.md` §4.

## 0. Baseline

- [x] 0.1 Record the pre-change state. `tsc` exit 0; `expo lint` 0 errors / 267 warnings;
      `npm test` 351/355. The four failures are environmental: `lib/call/minimize`,
      `lib/layoutMetrics` and `services/securityEmulatorFlag` need the generated `android/`
      folder, and `utils/moneySeam` needs Node 24. `openspec validate --all --strict`:
      48/50, with `fix-presence-publish-stall` and `responsive-breadth-and-toolchain`
      failing — **written**

## 1. Phase 0 — stop misleading or trapping users

- [x] 1.1 Delete 19 mock, legacy or unwired routes. Remove their `Stack.Screen`
      registrations, the unrendered `VaultFeatureSheet` and `ChatRow`, and their entries in
      the coverage selftests. `orphanRoutes` asserts the deletions — **written**
- [x] 1.2 Privacy Dashboard no longer opens the security block screen; `blocked.tsx` has an
      exit when it shows no threat verdict — **written**
- [x] 1.3 Remove the `[sos-probe]` instrumentation — **written**; route opening — **device-verified: no**
- [x] 1.4 Correct copy that claimed outcomes the code does not produce (call removal, contact
      sync, games voice, lock-settings network list, trusted contacts, EMI PDF, finance
      hero, vault export, d2de, VaultBeam) — **written**
- [x] 1.5 Hide or remove toggles with no reader (voice effect, vault-features timers,
      left-behind alerts, VaultBeam roaming, chat-backup "Include videos", custom vibration,
      unsupported device commands) — **written**

## 2. Phase 1 — security and data loss

- [x] 2.1 Vault accepts the 4–8 digit Device PIN. Vault key v2: a random key wrapped under the
      PIN with a per-install salt; v1 files still open; a PIN change re-wraps (staged; commits
      only after the PIN is saved — `lib/vaultKeyStore.selftest.ts`).
      `lib/vaultCrypto.selftest.ts` proves both formats survive a PIN change — **written**
- [x] 2.2 Relock on resume (`components/ResumeLock`, mounted in `app/_layout.tsx`) — **written**;
      **device-verified: no**
- [x] 2.3 Chat-lock PIN moves to salted scrypt, upgrading on the next correct unlock, with
      persisted backoff. A locked chat sends no receipts and clears no notifications;
      in-chat search is gated by the lock; Chat lock entry points exist — **written**
- [x] 2.4 backup-pin asks for the current PIN. Delete account checks the MPIN on the phone and
      sends it to the server; the server check is **written, not deployed** (round 3). Remove
      the phone pre-check once it is deployed. Scan device confirms before it can wipe
      keys — **written**
- [x] 2.5 No plaintext copies in AsyncStorage for bookmarks, scheduled messages, the ghost
      list and session IPs. Reminders honour tray privacy. Decrypted temp files are cleaned
      on exit, boot and logout. The chat-export file is deleted after sharing — **written**
- [x] 2.6 View-once and ink content: not offered for forwarding, refused by `forwardMessage`,
      excluded from the shelf and gallery — **written**
- [x] 2.7 Encrypted notes refuse to save over a failed load or to regenerate a lost key;
      status privacy does not overwrite after a failed load — **written**
- [x] 2.8 Archive viewer checks declared sizes first. Finance CSV escapes formulas,
      de-duplicates, and restores in one transaction. Admin pages use a hash-pinned CSP,
      no inline handlers, a session-only token and confirmations — **written**; admin pages
      **browser-verified: no**
- [x] 2.9 UsageCounter sends route patterns, never invite codes — **written**

## 3. Phase 2 — broken core flows

- [x] 3.1 SOS: the message is sent before sharing or permission prompts, contact errors show a
      retry, and the notified count comes from the server — **written**; **device-verified: no**
- [x] 3.2 Spaces runs: stops carry place and time, riders are assigned to stops, and drivers can
      mark unassigned riders. Driver alerts are sealed space alerts. The device agent rings
      and shows messages — **written**. Guardian calls, a shift read-back and in-place stop
      updates are wired in the app and the server; the server side is **written, not deployed**,
      and the app falls back against today's server
- [x] 3.3 Chat: link previews are sent, failed edits roll back, the dead quick-react modal is
      removed, no Back in split view, search counts visible rows — **written**
- [x] 3.4 Media: video seek, load errors, player remounts, image-editor output — **written**;
      **device-verified: no**
- [x] 3.5 Shop Book: per-shop carts, honest Pro, verification upload, bill retry, product delete
      confirm, shop currency — **written**. The "other" reject note, the admin returns
      filter and Request Pro are wired in the app and the server; the server side is
      **written, not deployed** (migrations 140 and 141 first)
- [x] 3.6 Finance: iOS date picker, chitti numbering, snooze recurrence, honest PDFs, error
      states — **written**; iOS picker **device-verified: no**
- [x] 3.7 Groups: communities keep their cache, shared permission check, author checks on
      notes and tasks, calendar reminders, privacy save errors, trip end after restart,
      consent-based create-group — **written**
- [x] 3.8 Location: the chosen route is driven; Location Lock marker, arm errors and grace
      state; units in lock history; live-sharing double tap — **written**
- [x] 3.9 Calls and games: back declines an incoming call; the live host can end; call buttons
      expose state; join-by-code asks which game; confirmations; ringtone choice — **written**
- [x] 3.10 Round 3: every remaining screen's "Still needed for 10/10" list, plus a per-file pass
      for roles, labels and state, theme tokens, error states and confirmations, in 16
      packages (launch and auth, tabs and links, chat, chat tools, groups, calls and live,
      media, family, location and safety, spaces, finance, Shop Book and admin, settings and
      vault, utilities and games) — **written**; items marked 📱 in `2026-10-04_fix_status.md`
      **device-verified: no**
- [x] 3.11 Round 3 security and data-loss items: background family-alert taps routed through the
      lock; resume relock for Device-PIN users; Doc Scanner scans encrypted at rest without
      losing a key on migration; hidden-chats attempt counter persisted; finance full backup
      sealed with a password; Invisible Ink kept out of the reply bar, quotes, Memory banner and
      search — **written**
- [x] 3.12 Fixes for regressions the round-3 re-raters found (delete-account MPIN pre-check
      restored, yearly finance reminders, status lock answer reveal, Location Lock save copy,
      reminder list reset, battery-exemption "can't tell", Khata share reachability, one status
      history row per transition, and others listed in the fix-status §3) — **written**; scored
      by the round-4 re-raters
- [x] 3.13 Round 4 (`0dcfb48` … `4910069`, 19 packages): the round-3 open items and every
      remaining "Still needed for 10/10" item that can be done in this repo — palette tokens
      `onPrimary`/`onDanger`/`warning`/`caution`/`scrim` and an app-themed `useDatePicker`;
      splits of `app/_layout.tsx`, Chats, `MessageBubble`, live-view, file-viewer, the family
      hub and map, encrypted notes, import chats and the Rummy, Chess and Ludo boards; GIF and
      Forward through the outbox; a screen-reader pass on the games boards; client wiring with
      honest fallbacks for every new server contract — **written**; items marked 📱
      **device-verified: no**
- [x] 3.14 OTP-first sign-in: the app sends the SMS code before any MPIN sign-in or recovery
      and carries the phone ticket (`app/phone-verify.tsx`, renamed from `email-verify`,
      `lib/otpFirstRoute.ts`). Server enforcement (`AUTH_REQUIRE_PHONE_TICKET`, C15) is
      **written, not deployed**, and stays off until this client is the minimum version —
      **written**; **device-verified: no**
- [x] 3.15 Round 5 (`5492453` … `2a05e46`, 14 packages): fixes for the round-4 regressions
      (blocked "Check again" dead-end, identical read ticks, backup key-mode collision, vault
      "New key" archive, calculator vs ledger compounding, and others in fix-status §3), plus
      privacy fixes for protected and locked text in global search and chat previews, a
      verification bound to the safety number, a Doc Scanner list that cannot drop keys, and
      view-once images kept out of the disk cache — **written**; scored by the round-5
      re-raters
- [x] 3.16 Fixes after the round-5 re-rating (`bf68b93` and round 6, `076e098` … `166d207`,
      7 packages): finance one-off and snoozed reminders schedule; all-or-nothing vault PIN
      re-wrap; scan key never replaced silently; hidden and locked chats masked in search and
      every cross-chat list; a new phone cannot overwrite the online backup and E2EE restores
      stay E2EE; saved family places never overwritten after a failed read; per-mount launch
      gate — **written**, **not re-scored**; items marked 📱 **device-verified: no**

## 4. Phase 3–4 — partially in scope

- [x] 4.1 Errors with retry instead of false empty states, and confirmations, on every screen
      touched above — **written**
- [ ] 4.2 App-wide accessibility ratchet over every touchable. `lib/uiDebtRatchet.selftest.ts`
      exists and runs in `npm test`: for each `.tsx` under `app/` and `components/` it counts
      touchables with no `accessibilityRole` and hex colour literals, and fails when a file's
      count goes up against `lib/uiDebtRatchet.baseline.json`. It only stops new debt; it does
      not require roles everywhere. The totals went from 45 / 955 when it was added to 5 / 281
      at `166d207`. The games boards had a screen-reader pass in round 4, still 📱. The
      app-wide pass is not complete (5 unroled touchables remain, in
      `components/WritingAssistant.tsx`, `components/ChainLinkIcon.tsx` and
      `app/videocall.tsx`), so this stays open for `interaction-integrity` — ratchet **written**
- [x] 4.3 Split `app/chat.tsx` and `app/shop-book.tsx`. `app/chat.tsx` went from 4,674 to 2,500
      lines, with the moved parts in `components/chat/` (header, search bar, banners, rows,
      composer, modals, lock gate and six hooks). `app/shop-book.tsx` went from about 5,800 lines
      to a 344-line shell plus 12 files in `components/shopbook/`. The round-3 re-raters found
      no behaviour lost in either split. Rounds 4–6 split more files (see 3.13); `app/chat.tsx`
      is now 2,576 lines, with its socket effect kept in place because four selftests read it
      there — **written**
- [ ] 4.4 Remove the legacy call bodies behind `CALL_ENGINE_V2` — deferred: `constants/flags.ts`
      keeps them as the rollback until the hardware test pass in `CALLS_README.md`
- [x] 4.5 https intent filter for `vaultchat.app/add` and `/join` (`autoVerify: false`) — **written**;
      `assetlinks.json` / `apple-app-site-association` hosting is ops work; templates are in
      `deploy/well-known/`, but the Play app-signing SHA-256 and Apple Team ID are not in the
      repo

## 5. Validation

- [x] 5.1 At `166d207`: `tsc` 0 errors; `expo lint` 0 errors / 27 warnings; `npm test` 471/475,
      where the four failures are the environmental baseline (`lib/call/minimize`,
      `lib/layoutMetrics`, `services/securityEmulatorFlag`, `utils/moneySeam`); `openspec
      validate --all --strict` 49/51 (the same two no-delta changes). Earlier: 158 warnings and
      386/390 after round 2; 55 and 413/417 after round 3 (`a72296b`); 26 and 441/445 at
      `4910069`; 30 and 460/464 at `2a05e46` — **written**
- [x] 5.2 Independent re-rating, in five rounds: 147 screens, then 36, then all 174 remaining
      screens in 13 batches three times (rounds 3, 4 and 5; round 5 scored `2a05e46`). Mean of
      the 174 remaining screens: 6.2 → 7.1 after round 2 → 7.8 after round 3 → 8.2 after
      round 4 → 8.4 after round 5. Against the baseline: 174 up, 0 unchanged, 0 down; against
      round 3: 150 up, 24 unchanged, 0 down; 169 screens at 8 or above, 12 at 9 or above; none
      below 5; highest real screen 9 (10 screens). The fixes after `2a05e46` (133 screens) are
      not re-scored. Results in `2026-10-04_fix_status.md` — **written**
- [ ] 5.3 Device pass on Android and iOS for the items marked above
- [ ] 5.4 Ship in an app release; sync `screen-integrity` to `openspec/specs` only after 5.3
