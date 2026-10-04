# Implementation plan — screen audit remediation

Levels, as elsewhere in this repo:

- **written**: code in the repo, `tsc` clean, focused selftests pass.
- **deployed**: on prod (deploys are FILE COPY, not git). Not applicable to most of this change,
  which is app code shipped by an app release.
- **device-verified**: proven on a physical phone, not inferred from a log.

Per-item detail, with file:line evidence, lives in `2026-10-04_fix_status.md` and the
updated ratings it links. No backend file is changed by this change.

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
      PIN with a per-install salt; v1 files still open; a PIN change re-wraps.
      `lib/vaultCrypto.selftest.ts` proves both formats survive a PIN change — **written**
- [x] 2.2 Relock on resume (`components/ResumeLock`, mounted in `app/_layout.tsx`) — **written**;
      **device-verified: no**
- [x] 2.3 Chat-lock PIN moves to salted scrypt, upgrading on the next correct unlock, with
      persisted backoff. A locked chat sends no receipts and clears no notifications;
      in-chat search is gated by the lock; Chat lock entry points exist — **written**
- [x] 2.4 backup-pin asks for the current PIN. Delete account checks the MPIN (client-side
      only — server check **blocked: needs backend**). Scan device confirms before it can wipe
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
      updates are **blocked: needs backend**
- [x] 3.3 Chat: link previews are sent, failed edits roll back, the dead quick-react modal is
      removed, no Back in split view, search counts visible rows — **written**
- [x] 3.4 Media: video seek, load errors, player remounts, image-editor output — **written**;
      **device-verified: no**
- [x] 3.5 Shop Book: per-shop carts, honest Pro, verification upload, bill retry, product delete
      confirm, shop currency — **written**. The "other" reject note and the admin returns
      filter are **blocked: needs backend**
- [x] 3.6 Finance: iOS date picker, chitti numbering, snooze recurrence, honest PDFs, error
      states — **written**; iOS picker **device-verified: no**
- [x] 3.7 Groups: communities keep their cache, shared permission check, author checks on
      notes and tasks, calendar reminders, privacy save errors, trip end after restart,
      consent-based create-group — **written**
- [x] 3.8 Location: the chosen route is driven; Location Lock marker, arm errors and grace
      state; units in lock history; live-sharing double tap — **written**
- [x] 3.9 Calls and games: back declines an incoming call; the live host can end; call buttons
      expose state; join-by-code asks which game; confirmations; ringtone choice — **written**

## 4. Phase 3–4 — partially in scope

- [x] 4.1 Errors with retry instead of false empty states, and confirmations, on every screen
      touched above — **written**
- [ ] 4.2 App-wide accessibility ratchet over every touchable — deferred to `interaction-integrity`
- [ ] 4.3 Split `app/chat.tsx` and `app/shop-book.tsx` — deferred
- [ ] 4.4 Remove the legacy call bodies behind `CALL_ENGINE_V2` — deferred: `constants/flags.ts`
      keeps them as the rollback until the hardware test pass in `CALLS_README.md`
- [x] 4.5 https intent filter for `vaultchat.app/add` and `/join` (`autoVerify: false`) — **written**;
      `assetlinks.json` hosting is ops work

## 5. Validation

- [x] 5.1 `tsc` 0 errors; `expo lint` 0 errors / 158 warnings; `npm test` 386/390, where the four
      failures are the environmental baseline; 35 new selftest suites — **written**
- [x] 5.2 Independent re-rating of every changed screen, in two rounds (147, then 36 screens).
      Regressions found in round 1 were fixed in round 2. Mean of the 174 remaining screens:
      6.2 → 7.1; 132 up, 42 unchanged, 0 down. Results in `2026-10-04_fix_status.md` — **written**
- [ ] 5.3 Device pass on Android and iOS for the items marked above
- [ ] 5.4 Ship in an app release; sync `screen-integrity` to `openspec/specs` only after 5.3
