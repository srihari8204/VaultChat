# Audit 05 — receipt ownership and asynchronous account changes

Status: implemented and checked locally. Deployment and two-phone verification belong to the release run; they are not implied by these tests.

## Confirmed defect

The old `vc_receipts_v1` store and process-global receipt map had no account identity. Signing out while disk hydration or a receipt request was pending could carry another user's chat cursor into a later login. A stale HTTP 401 could also refresh or terminate the account that replaced the request's original login.

## Fix

- Receipts use `vc_receipts_v2:<JWT subject>` and a separate active session object. Async work retains its original object and key. Session switches await outstanding disk writes; old network completions cannot persist into the current map. Idle memory retains one account map, one writer, and one coalesced pending snapshot.
- Durable read/delivery calls accept an expected owner. API requests check the token actually selected for fetch against that owner, including refresh/retry and terminal-session handling.
- Refresh responses are checked against the token revision captured before refresh. A login/logout while refresh is pending prevents that response from replacing credentials or ending the newer receipt owner's session.
- Disk read/write failures propagate. Failed local writes do not report durability. Invalid HTTP 400 cursors still roll back to the acknowledged cursor; offline failures retain their retry pointer; delivery never creates read intent.
- Sync captures the owner before requesting pages, checks ownership after fetch and decryption, and forwards that identity with delivered receipts. Background push sync also carries its original owner to the final API acknowledgement.

The unscoped v1 store is intentionally not imported: its owner cannot be established safely. Existing acknowledged server receipts remain intact. New sync rebuilds delivery intent; genuinely viewing the chat rebuilds read intent. An old offline-only read intent in v1 cannot safely be attributed after upgrade.

## Validation

Executed production modules with deferred storage/network and controlled account switching:

- `lib/receipts.selftest.ts`: hydration race, coalesced in-flight advancement, read/write failure, account switch during hydration/request, no import from v1, same-owner retry, stale 401, stale refresh response and stale refresh rejection.
- `lib/outboxRecovery.selftest.ts`: rejected monotonic cursor recovery, transient retry and persistent acknowledged state, existing outbox behavior.
- `lib/syncEngine.delta.selftest.ts`, `lib/syncEngine.hydrateFailure.selftest.ts`, `lib/syncEngine.mutations.selftest.ts`: cold/warm sync, mutation continuation, decryption failure retention, concurrent wakeups, strict resync errors; added account-switch rejection during fetch and decrypt before cache/ack.
- `lib/syncBackground.selftest.ts`: durable-before-ack ordering, failure paths and account switch during sync.
- `lib/refreshOutcome.selftest.ts`, `lib/sessionEnded.selftest.ts`: retained refresh/session behavior.

Full typecheck reported errors in concurrently edited app pending-retry typing and localDb pending-envelope test fixtures, communicated to the root agent; no errors were reported in this audit's receipt/API/sync files. Root must complete the consolidated release checks after these concurrent fixes.

Ponytail review: reused AsyncStorage, existing API ownership option, current single-flight sync and the existing receipt writer; no new package, scheduler or offline event queue. No removable abstraction found beyond the session object required to isolate async closures.
