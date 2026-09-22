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
- [x] finding 16 (useAuthHeader) — **DONE.** `hooks/useAuthHeader.ts` now owns the one
      pattern: `getAccessToken()` → `Bearer <tok>` → null while it resolves. 17 screens
      migrated (`app/(tabs)/{calls,chats,profile,status}`, `contact-info`, `create-group`,
      `family-add`, `ghost-mode`, `group-calls`, `group-info`, `hidden-chats`,
      `media-gallery`, `new-chat`, `search`, `settings`, `status-privacy`, `story-viewer`):
      each lost its `authHeader` state, its `setAuthHeader` line, the `getAccessToken()`
      folded into its own `Promise.all`, and the now-unused import.
      `components/chat/{MessageBubble,SharedMediaThumb}` keep taking it as a prop — they are
      leaves and must not each open their own token read.
      `app/media-viewer.tsx` deliberately NOT migrated: it wants a `{ Authorization }`
      OBJECT and only when `needsAuth`, which is a different shape; forcing one hook over
      two shapes would have been the abstraction this finding is complaining about.
      **Behaviour note:** the header used to be set inside each screen's data-fetch `try`,
      so a failed fetch left avatars headerless. It now resolves independently of that
      fetch, which is strictly better and is why no caller needed a render change.
      `npx tsc --noEmit` exit 0; `npx expo lint` 0 errors (268 pre-existing warnings,
      unchanged) — **written**
- [x] release APK — **BUILT 2026-09-22.** `npm run build:android:apk:arm64`
      (`assembleRelease -PreactNativeArchitectures=arm64-v8a`), BUILD SUCCESSFUL in 4m17s,
      exit 0. `android/app/build/outputs/apk/release/app-release.apk`, 95,265,291 bytes,
      md5 `6d12ac7bd88cdb01bd30801481c41191`.
      Deliberately NOT `build:android:apk`, which runs `expo prebuild --clean` first: that
      regenerates `android/` and would put the config-plugin Kotlin (the `isGroup` call
      routing from `calls-64-participant` 7.5) through a full re-apply for no reason this
      change needs.
      Bundle checked the way 9.3 says to — `assets/index.android.bundle` carries
      `seats free`, `Add people` and `Speaking`, so the group-call paging and invite UI are
      genuinely in this APK. (The bundle's zip entry timestamp reads 1981; that is the
      normalised entry time, not a stale asset — the APK itself is today's.)
      NOT claimed: that finding 16 is verifiable by string search. The `useAuthHeader`
      refactor adds no user-facing string, so its evidence is `tsc` exit 0, lint 0 errors
      and the suite at 350/351, not the bundle — **written**
