# Audit 03 — local message durability

Reviewed `lib/localDb.ts`, its hydration/cache callers, deletion, backups, and cache pruning. Applied the Ponytail implementation and diff-review guidance. No server or device changes were made.

## Confirmed and fixed

- **High: delivery could acknowledge an unrecoverable message.** Failed hydration leaves a wire envelope, but `cacheMessages` previously converted that envelope to null. A new sealed `pending_envelope` column stores the envelope in the same message transaction while keeping displayable plaintext separate. `getPendingEncryptedMessages` supplies bounded decrypt retry inputs without exposing ciphertext in normal message reads. Parent integration owns the chat-screen retry hook.
- **High: stale writes could replace a remote tombstone's type/content.** The upsert now refuses changes to already deleted rows. Both local deletion and remote deletion erase pending ciphertext; a later stale fetch cannot requeue it.
- **Medium: failed decrypt dropped the existing blind search index.** Envelope-only updates now preserve the searchable plaintext/index. Tombstones still remove the index, and stale plaintext cannot restore it.
- **High: automatic pruning could erase an acknowledged pending message's only recoverable copy.** Pending envelopes are excluded from ordinary cache pruning. Explicit chat clearing/logout still erase them. Portable backups export and reseal pending envelopes on import.
- **Medium: global cursor writes silently failed.** `noteGlobalSyncCursor` now propagates persistence failures so strict resync cannot falsely report completion.

## Verification

- `npx tsx lib/localDb.pending.selftest.ts` — passed. Executes the production localDb implementation against real on-disk Node SQLite, including close/reopen durability, AES-GCM sealed-field adapter, locked retry readback, server-purge preservation, successful retry cleanup, readable plaintext and FTS preservation, deletion stickiness, backup/import, automatic pruning, explicit wipes, and a real SQLite trigger abort proving cursor-write rejection. Native database and keystore adapters are replaced only to run on Node; SQL is executed, not simulated.
- `npx tsx lib/localDb.staleData.selftest.ts` — passed; updated SQL extraction for the additive column and pruning predicate.
- `npx tsx lib/messageDeletion.selftest.ts` — passed.
- `npx tsx lib/lastMessageQuery.selftest.ts` — passed.
- `npx eslint lib/localDb.ts lib/localDb.pending.selftest.ts` — zero errors; three existing `Array<T>` style warnings in localDb.

No E2EE algorithm, wire format, identity reset, or key derivation was changed. Ponytail review: the added column avoids a second queue/table and makes deletion and backup lifecycle follow the existing message row. Device unlock/restart verification remains separate from these local checks.
