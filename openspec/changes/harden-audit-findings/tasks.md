# Tasks

Ownership is by FILE. No two workstreams touch the same file — the repo has no git,
so a lost edit cannot be recovered.

## A. Account lifecycle  (findings 1, 2, 5, 6, 12)
- [x] Extract `purgeAccountData()` from `logoutUser` and call it from `endSessionAndBounce`
- [x] Add `clearIdentity()` to e2eeSession; include `vc_e2ee_*` in the purge
- [x] Add the per-user keys (story feed, drafts, call log, notes DEK, view-once, DID)
- [x] Move `pinAttempts.record*` into `pinStore.verifyPin`
- [x] Make `wipeAllKeys()` call the real purge instead of its stale list
- Files: app/(constants)/authService.ts, lib/api.ts, services/securityService.ts,
  services/security/pinStore.ts, services/security/pinAttempts.ts, services/crypto/e2eeSession*.ts

## B. Lock semantics  (findings 3, 4)
- [x] `lockMethod === 'both'` requires BOTH factors, in chat and in export
- [x] `verifyBiometric` must not return true on web
- Files: lib/chatLock.ts, app/chat.tsx, app/chat-export.tsx

## C. Shop money  (finding 8)
- [x] Give shop-book the finance thousands-separator rule (`1,200` and `1,00,000` parse)
- [x] Gate the seven unguarded writes with `isNum`
- Files: utils/shopbook.ts, utils/shopbook.selftest.ts, app/shop-book.tsx

## D. Finance money  (findings 9, 10, 11)
- [x] Flip the two `<=` guards NaN walks through
- [x] Bound the interest duration so Infinity is never persisted
- [x] Fix the CSV `remaining` round-trip
- Files: utils/finance.ts, app/finance/emi.tsx, app/finance/interest.tsx, app/finance/io.tsx

## E. Egress + dead code  (findings 7, 13, 14, 15)
- [x] Gate the permission BEFORE the track fetch in family-member and group-insights
- [x] Delete lib/breachCheck.ts and utils/notifications.ts (zero importers)
- [x] Remove the lib → app import in cloudBackup
- Files: app/family-member.tsx, app/group-insights.tsx, lib/breachCheck.ts,
  utils/notifications.ts, lib/cloudBackup.ts

## F. Integration (me, after A–E)
- [x] tsc + full suite, every new guard demonstrated to fail on revert
- [ ] finding 16 (useAuthHeader) — deferred, touches 19 files owned by B and E
- [ ] release APK
