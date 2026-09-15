# Audit 02: client lifecycle

Reviewed `lib/socket.ts`, `lib/ccwire/eventsSocket.ts`, `lib/ccwire/transport.ts`, and the deferred resync boundary in `lib/syncEngine.ts`. Local source and fake-carrier tests only; no server or device actions.

## Findings and disposition

1. **Fixed: established legacy recovery could create two owners.** Establish Socket.IO, lose its network connection, then call `getSocket()` while its automatic reconnect is pending. The previous implementation constructed another Socket.IO connection without stopping the first. Both could subsequently reconnect and deliver persistent events. `getSocket()` now waits on the existing legacy owner, shares concurrent waiters, preserves held listeners, and cancels those waiters on logout.
2. **Fixed at the sync API boundary: failed or stale catch-up could authorize typed submissions.** Receive `ServerHello(resumed=false)` while `/chats/delta` fails, or while an older response snapshot is already in flight. The previous callback awaited best-effort `catchUp()`, which resolves counts even after failure and could merely join the old snapshot. New `resyncRequired(): Promise<void>` requests a fresh pass when necessary and rejects HTTP/cache/cursor errors and page-limit exhaustion. Each flight owns its result; ordinary callers retain their shared count promise and a later successful flight does not inherit an old error. Socket readiness now invokes this strict API. Transport's existing client/hello-generation checks still prevent stale completion from enabling another carrier.
3. **Reported integration dependency:** `localDb.noteGlobalSyncCursor()` itself swallowed `setMeta()` failures at review time. The localDb owner was notified to propagate that failure so the strict API can observe actual cursor storage failure. The sync regression injects a rejecting cursor write.
4. **Fixed: auth recovery did not reach refresh after a live session, and guards prevented later refreshes.** The executable expiry regression revealed that auth close remained retryable in the supervisor; once `everReady` was set, those closes did not consume pre-handshake strikes. They never reached the facade refresh callback. Auth closes now stop that owner immediately and reach bounded token refresh. Both the CC-Wire facade and legacy socket reset `renewed` after a successful ready/connect, allowing one refresh per healthy connection epoch. Regressions prove two successive expiry/recovery cycles and no refresh loop when authentication is repeatedly refused without a successful connection.

## Checks

Passed with `node node_modules/tsx/dist/cli.mjs <file>`:

- `lib/ccwire/eventsSocket.selftest.ts`
- `lib/ccwire/recovery.selftest.ts`
- `lib/ccwire/transport.selftest.ts` (new executable established-legacy ownership, listener preservation, shared waiting and logout regressions)
- `lib/socket.transport.selftest.ts`
- `lib/socketPersistentListeners.selftest.ts`
- `lib/syncEngine.delta.selftest.ts` (new strict fresh-snapshot, HTTP/cache/cursor failure and subsequent-success regressions)
- `lib/syncEngine.mutations.selftest.ts`
- `lib/syncEngine.hydrateFailure.selftest.ts`

Existing tests also cover capable CC-Wire negotiation with no Socket.IO, capability-removal rollback retaining facade references, persistent listener delivery once after rollback, cancellation of pending legacy login, stale-ready rejection, and teardown of carrier timers.

Changes were kept to the existing shared lifecycle and sync functions; no dependency or additional runtime abstraction was introduced. Full type/lint checking remains with the coordinating agent. Deployment and device verification are not claimed.

An attempted `lib/ccwire/supervisor.selftest.ts` invocation failed because that file does not exist; the actual supervisor recovery suite listed above was then run and passed.
