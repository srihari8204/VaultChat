# Physical-device investigation — cursor exceeds server allocation history

Observed 2026-09-15; read-only investigation. No source, database or phone state changed by this investigation.

## Direct evidence

- Host nginx access log records repeated `/chats/delta?since=1027` responses with HTTP 200 during the Redmi test window: 13:35:17, 13:36:17, 13:37:32, 13:41:53, 13:50:53, 13:51:32, 13:51:43, 13:52:25, 13:53:29, 13:53:45 and 13:53:46 IST.
- Earlier requests from the other active client also used `since=1063`. Device attribution is correlated with the root agent's device actions, not an identity claim from nginx logs.
- Direct PostgreSQL metadata: database `vaultchat`, message count 59, minimum ID 1, maximum ID 59. `public.messages_id_seq` has `last_value=59` and `is_called=true`.
- Message 59 belongs to the authorized Leo chat (`c4c7fcb3-89fa-41a9-9145-fd0ebcd60a2a`), created at 08:05:13.777852 UTC, with no edit or deletion timestamp.
- Receiver `ebbc19f9-4410-4c14-bfbf-eeb0b4280338` remains a visible active chat member with read/delivered cursors both 57. The root agent independently observed newest local UI message 57.
- Filtered current API logs contained no delta/SQL error. Caddy JSON logs did not expose delta access records; host nginx provided the request evidence.

Only timestamps, route path, `since`, HTTP status and database identifier/cursor metadata were emitted. No tokens, message content or credentials were printed.

## Mechanism

`getGlobalSyncCursor()` takes the maximum of stored cursor and all cached message IDs. Sync subtracts lookback 25; the observed 1027 therefore implies a local high-water of 1052. The current server only has IDs through 59. `chatsDelta` filters `m.id > since`, initializes `nextSince=since`, and returns an empty 200 when nothing matches. The client treats that as success and retains its monotonic cursor. Message 59 can never arrive through this forward query.

This proves an allocation-history mismatch. The logs alone do not establish whether a database restore/reset, a different prior server origin, or another old data source caused it.

## Proposed repair for root review

Detect a client cursor above the server's allocated sequence high-water and serve a bounded, membership-authorized, undelivered-only recovery page independently of that stale cursor. Compare the sequence high-water, not just `MAX(messages.id)`, since legitimate hard deletion can lower the latter. Respect pagination, cold-policy caps and scoped CC-Wire filters explicitly. Keep cached plaintext/tombstones and existing stored cursors intact; acknowledged rows stop repeating through the recovery path.

Do not merely clear/lower the local cursor: retained message IDs raise it again. Do not blindly bump the server sequence to the two observed phones' maximum: other devices' old high-water values are unknown. A lasting allocation-continuity/epoch policy requires verifying the prior allocation history and preserving references. Old/new ID collisions in retained local history must be assessed separately before claiming universal restore recovery.

No repair is implemented in this report; root coordinates any new backend release and physical retest.

## Implemented recovery (local source; release verification pending)

`chats.go` now checks sequence allocation high-water and an authorized, active/nonhidden, nonexpired pending-message gap at or below the requested cursor. The gap condition continues to work after the allocation sequence overtakes the old device cursor. The query retains at most the requested page size (maximum 500).

Recovery returns the union of pending messages and the original ordinary warm window. This matters with multiple devices: another device may already have acknowledged a newer row that this device still needs. Filtering all recovery rows to account-wide undelivered state would incorrectly skip that normal warm window.

The signed recovery continuation binds account, original allocation head, original warm cursor and last returned ID. Even when the client sends its old high cursor again, pagination continues after the last returned row. No receipt acknowledgement is needed to make pagination progress. The continuation clears on the terminal page, including an empty page after late acknowledgements.

Typed `CursorSync` retains its oversized-watermark rejection; it does not accept a future position or emit an unsolicited ServerHello. Its allocation high-water now reads the PostgreSQL sequence rather than relying on surviving rows. The current app already runs canonical REST sync through its connection lifecycle, which is the recovery path repaired here. Gap-driven rewind applies to unscoped REST, preserving valid typed per-chat cursor semantics.

Focused local Go checks passed: `TestRecoveryContinuationAuthentication`, `TestSyncContinuationAuthentication`, and `TestCCWireCursor*`. New `TestCursorRecoveryScratchDB` executes the actual handler against a real PostgreSQL temporary schema and covers 58/59 behind cursor1027, subsequent60, 1141 pending rows across pages without acknowledgements, sequence advancing beyond1027, legitimate hard-deletion sequence behavior, membership/hidden/signed-token boundaries, scoped SQL, late-ack termination and preservation of another device's acknowledged warm window across page boundaries. The root release run must execute that fixture with `SYNC_TEST_DSN`; a test skipped without that environment is not database verification.

This repair does not reconstruct a previous database epoch or resolve reused message-ID collisions in retained historical rows. No client history is cleared and no production sequence is changed.
