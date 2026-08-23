## Context

VaultChat's local store ([lib/localDb.ts](lib/localDb.ts)) is a **cache of a server-owned
log**, not an independent database. Three properties follow from that, and all three are
hostile to importing local-only history:

1. **`messages.id` is the sort key AND the sync cursor.** Rows render `ORDER BY id DESC` and
   page with `WHERE id < ?`. `created_at` is displayed but never ordered by. The same column
   feeds `getGlobalSyncCursor()` → `syncEngine.catchUp()`.
2. **The cache is disposable.** `pruneMessageCache()` keeps 300 rows per chat and deletes the
   surplus, because anything deleted can be re-fetched. Imported rows cannot.
3. **Bodies are sealed at rest.** `content` and `meta` pass through `encField`/`decField`
   ([lib/cacheCrypto.ts](lib/cacheCrypto.ts)), and `cacheMessages()` is the single choke point
   that also maintains the blind FTS index.

The design's whole job is to insert local-only history into that store without disturbing any
of it. Everything else — the parser, the screen — is ordinary work.

Two further constraints come from the product rule and the platform:

- **One conversation at a time.** The screen is always entered with a target `chatId`. There
  is no code path that iterates conversations, which is a structural guarantee rather than a
  UI convention.
- **A phone with 2 GB of usable RAM must survive a 2 GB export.** WhatsApp exports are
  ZIPs that are mostly media; the transcript is a rounding error inside them.

## Goals / Non-Goals

**Goals:**

- Import one WhatsApp conversation into one existing VaultChat 1:1 chat, on-device, with
  original timestamps, senders and ordering preserved.
- Bounded memory regardless of archive size.
- Idempotent: re-running an import never duplicates, and a crash mid-import never corrupts.
- Imported messages are permanently distinguishable from native ones, and survive cache pruning.
- Provably no network path for imported data — enforced by a check, not by review.
- Zero new dependencies, zero backend change, zero prebuild.

**Non-Goals:**

- Bulk or multi-conversation import, in any form, including "queue several and run them".
- Importing into groups, and group porting of any kind. Exit Kit is 1:1 only (owner decision,
  2026-08-23). A group export is detected and refused before preview.
- Round-tripping imported messages to the server, or making them visible to the peer. The
  peer's copy of the history is their own business; this is a local archive.
- Telegram and Snapchat parsers (separate change: `exit-kit-expansion`).
- Reconstructing WhatsApp media *content* fidelity beyond what the export contains — an
  export excluding media contains filenames and `<Media omitted>` markers only, and the UI
  must say so rather than imply the media was migrated.

## Decisions

### D1 — Imported messages get NEGATIVE ids, allocated descending

**Decision.** An imported row's `messages.id` is negative, and is **derived from the original
timestamp** rather than from a counter:

```
id = (unixSeconds − 4102444800) × 65536 + seq        // seq = in-second sequence, transcript order
```

*(Revised during implementation. The original design allocated ids from a monotonically
decreasing counter persisted in `kv`. That fails the "Extended export re-imported" scenario:
a later export's new messages are newer in time but would be allocated **lower** ids than the
existing block, so a year of new history would render as the oldest messages in the
conversation. Deriving from the timestamp makes ordering-by-id identical to
ordering-by-original-time for free, removes the persisted allocator entirely, and makes the ids
fully deterministic — a re-import computes exactly the ids it computed the first time. Budget:
`4.10e9 × 65536 ≈ 2.69e14`, comfortably inside `Number.MAX_SAFE_INTEGER` (9.01e15).)*

Ordering therefore matches the export's own order, including at WhatsApp's minute-level
timestamp granularity, where every message in a minute shares one timestamp and is separated
only by `seq`.

**Why.** It is the only choice that satisfies all four readers of `id` at once:

| Reader | With negative ids |
|---|---|
| `ORDER BY id DESC` render | imported history sorts below all server ids → renders as the past ✅ |
| `WHERE id < ?` scroll-back | pages naturally into the imported block ✅ |
| `getGlobalSyncCursor()` = `max(MAX(id), stored)` | `MAX(id)` unaffected; `stored` ≥ 0 always wins ✅ |
| `noteGlobalSyncCursor()` | already returns early on `id <= 0` ✅ |

**Alternatives considered.**

- *Positive ids above the server head.* Rejected — this is the trap. `catchUp()` would begin
  its delta past the real head and the device would stop receiving messages **in every chat**,
  with no error surfaced. The failure is silent and total.
- *Positive ids interleaved below the chat's oldest server id.* Rejected — the gap is finite
  and unknowable (the chat's oldest cached id is not its oldest *server* id), so an import
  larger than the gap collides with real history.
- *Re-sort the chat by `created_at`.* Rejected as scope: it changes `getCachedMessages`,
  `getCachedMessagesBefore/After/Around`, `hasCachedOlder/NewerMessages`, the keyset contract
  with `GET /chats/:id/messages`, and `chat.tsx`'s paging loop. Nine readers changed to avoid
  one sign bit.

**Consequences that must be handled.**

- `cacheMessages()` skips `id <= 0` ([localDb.ts:317](lib/localDb.ts#L317)). This is a feature:
  imports get their own writer, `importMessages()`, and no ordinary sync path can ever write or
  re-upload a negative id. Do **not** relax that guard.
- `chat.tsx` `onEndReached` tops up from the server on a short cached page
  ([chat.tsx:2103](app/chat.tsx#L2103)). Once paging reaches the imported block, `oldest` is
  negative and the request becomes `before=-17559…`. The server's `Number.isFinite(before)`
  check accepts it and returns empty, which happens to be correct — but it is a wasted
  round-trip per scroll and a negative id crossing the network boundary. Guard client-side:
  skip the server top-up when `Number(oldest) < 0`, and set `hasMore` from whether older
  *imported* rows exist. Imported history is by definition the start of the conversation.

### D2 — Prune must not reach imported rows

`pruneMessageCache()`'s victim query gains `AND id > 0`. Without it, every sweep targets the
imported block *first* (it holds the lowest ids), and there is no server to re-fetch from.

The 300-row-per-chat budget is a cache policy for re-fetchable data; imported history is not
cache. It is bounded instead by the import itself — the user chose to import it, and the
completion screen reports exactly how many rows that was. If local storage becomes a real
problem, the correct control is a user-visible "remove imported history" action per chat, not
a silent sweep. Not building that now.

```
-- ponytail: imported rows are exempt from the cache budget entirely.
-- If import sizes ever threaten storage, add an explicit per-chat
-- "delete imported history" action — never extend the silent sweep.
```

### D3 — Dedupe via a partial UNIQUE index, not application logic

Add one nullable column `import_key TEXT` to `messages`, plus:

```sql
CREATE UNIQUE INDEX IF NOT EXISTS idx_messages_import_key
  ON messages(import_key) WHERE import_key IS NOT NULL;
```

Insert with `ON CONFLICT(import_key) WHERE import_key IS NOT NULL DO NOTHING`. Re-import is then
idempotent by construction — the database refuses the duplicate, and the import loop counts the
refusals as "skipped duplicates" for the completion screen.

**The repeated `WHERE` is mandatory, not decoration.** SQLite refuses to target a *partial* index
in an upsert unless the conflict target restates the index predicate — a bare
`ON CONFLICT(import_key)` fails at prepare time with "ON CONFLICT clause does not match any
PRIMARY KEY or UNIQUE constraint". `INSERT OR IGNORE` would prepare and be wrong: it also
swallows PRIMARY KEY violations, silently dropping the very message the id-probe exists to
place. A primary-key clash (a row from another import already in that second's slot) must still
raise, so the writer can probe forward for a free slot.

**The key** is `sha256(source ‖ chatId ‖ sourceConvKey ‖ originalTsMs ‖ sender ‖ sha256(body) ‖ n)`
truncated to 128 bits, where `n` is the 0-based occurrence index of an otherwise-identical
tuple *within this parse*. WhatsApp exports carry no message ids, so `n` is what keeps a
genuinely repeated "ok" in the same minute from collapsing into one row, while still being
stable across re-parses of the same file.

**Why a DB constraint over app-side checking.** A `SELECT` before each `INSERT` is one query
per message and is not atomic against a concurrent import; the index is one B-tree probe inside
the same transaction and cannot be forgotten by a future caller. It also makes "safe to retry"
(spec §11) a property of the schema rather than of the loop.

**Alternative considered.** Deriving the id deterministically from the key, avoiding the extra
column. Rejected — ids must be *ordered*, and a hash is not. Deriving a contiguous block from
`hash(chatId, source, conv)` plus a positional offset works until the user re-exports a chat
with a message deleted in the middle, after which every subsequent offset shifts and the whole
tail re-imports as duplicates.

**Migration.** Follows the pattern already in [lib/lock/lockStore.ts:97](lib/lock/lockStore.ts#L97):
`try { ALTER TABLE messages ADD COLUMN import_key TEXT } catch {}`, then the `CREATE UNIQUE
INDEX IF NOT EXISTS`. Additive, throws harmlessly on installs that already have it, and needs
no version counter. `import_key` is a hash — no plaintext — so it is stored unencrypted and is
therefore usable in an index, unlike `content`.

### D4 — Streaming ZIP: `fflate.Unzip` fed by positional `RNFS.read`

`fflate`'s `unzip`/`unzipSync` inflate **the whole archive into JS memory** — which is why
[lib/archive.ts:118](lib/archive.ts#L118) has a 256 MB refusal ceiling. That ceiling is right
for the archive *viewer* (it shows every entry) and wrong here: a 2 GB WhatsApp export is
normal, and we need exactly one small entry out of it.

`fflate` also ships the streaming `Unzip` class, which is push-driven: you feed it chunks and
it hands you one `UnzipFile` per entry, *before* reading that entry's data. An entry is only
decompressed if you call `.start()` on it. So:

```
for each 512 KiB chunk from RNFS.read(path, len, pos, 'base64'):
    unzip.push(chunk, isLast)
      → onfile(f):  f.name is the transcript?  f.ondata = collect; f.start()
                    otherwise                   record {name, size}; never start()
```

Peak memory = one chunk + the inflated transcript. Media entries are enumerated (name, size)
but never inflated, which is exactly what the preview needs and all the import needs, since
media is copied out later and only on demand.

**Why not `RNFS` + a native unzip.** Would need a new native dependency and a prebuild, to gain
nothing: we do not want the archive expanded to disk, and expanding it is precisely the
decompression-bomb exposure we are trying to avoid.

**Why base64 for the chunk reads.** `RNFS.read` returns a string; base64 is the only lossless
encoding available for arbitrary bytes. Cost is 4/3 transfer and one decode per chunk, which at
512 KiB is negligible against the inflate. `Buffer.from(s, 'base64')` is already a dependency.

**Security ceilings applied to the one entry we inflate**: refuse if the transcript's declared
uncompressed size exceeds 64 MB (a transcript that large is not a conversation), refuse a
compression ratio above 200:1, and abort the whole parse if actual inflated bytes exceed the
declared size — a lying header is the classic bomb. Entry names run through the existing,
already-tested `safeEntryPath()` ([lib/archive.ts:35](lib/archive.ts#L35)) before touching the
filesystem. Nothing from the archive is ever executed or evaluated.

### D5 — Media: reference, then copy on demand; reuse `meta.localUri`

An imported media message stores `meta.localUri` pointing at a file copied out of the archive
into `${APP_DOCS}/VaultChat/Imported/<sessionId>/`, plus `meta.origin`. `MessageBubble` already
renders `meta.localUri` for images and video
([MessageBubble.tsx:1223](components/chat/MessageBubble.tsx#L1223)) — so imported media needs
**no new rendering path, no attachment id, no `mediaStore` key, and no server round-trip**.

Copying happens during the import pass, not the parse pass, and only for entries the transcript
actually references. Orphan media in the archive is counted and reported as "unsupported items"
rather than silently copied.

**Trade-off.** This duplicates media bytes (archive + app storage). Alternative — keep the ZIP
and inflate on view — was rejected: it makes every media view depend on a user-chosen file URI
that Android may revoke, and it keeps a multi-GB file pinned as a dependency of the chat.

### D6 — Contact matching: three tiers, and the third one always asks

Imported history is written into a chat the user already opened, so matching is a **verification**
step, not a search. In descending confidence:

1. **Phone.** `findContactByVaultId(peerUserId, await getCachedContacts())`
   ([lib/contactSync.ts:127](lib/contactSync.ts#L127)) returns the peer's number *from the local
   contact cache*, normalised through the existing `normalizePhoneForHash()`
   ([lib/chatService.ts:2443](lib/chatService.ts#L2443)). If the WhatsApp export's counterpart
   number normalises to the same string → **confirmed**.
2. **Name.** Case- and diacritic-folded comparison of the export's counterpart name against
   `member.name` and the local contact's saved name → **probable**, and the confirmation screen
   states it matched on name only.
3. **Anything else** → **unverified**: the screen stops and requires an explicit "Yes, this is
   Ravi's conversation" acknowledgement naming both sides. Never auto-proceeds.

**Note for the spec:** the peer's phone number is **not** in `ChatMember` — the server holds
phone numbers only as hashes and never returns them
([chatService.ts:1973](lib/chatService.ts#L1973)). Tier 1 is therefore available only when the
peer is in the device's synced contacts. This is a correctness point, not a limitation to work
around: attempting to recover the number from the server would be both a new endpoint and a
privacy regression.

**Group exports are rejected outright.** A WhatsApp export with three or more distinct senders
is a group export; importing it into a 1:1 chat would write third parties' messages into a
two-person conversation. Detected during parse, refused before preview.

### D7 — Provenance in `meta`, never in the body

```ts
meta.origin      = 'wa-import'
meta.importedAt  = <iso>        // when we imported
meta.source      = { app: 'whatsapp', contact: '<export name>', conv: '<conv key>' }
meta.orig        = { sender: '<export sender label>', ts: '<original iso>' }
meta.importId    = '<session uuid>'
```

`content` holds the message body **byte-for-byte as exported**. Rewriting the body to carry
attribution (`"[WhatsApp] Ravi: hi"`) would corrupt search, break the dedupe key's meaning, and
make the transformation irreversible — the "no silent data transformation" rule.

`createdAt` is the original timestamp; `senderId` is VaultChat's own id for whichever side sent
it (self vs peer), resolved once at import. That keeps every existing bubble-alignment,
grouping and day-separator behaviour working with no changes.

### D8 — Transaction safety: batched commits + a resumable session record

Batches of 500 messages per `withTransactionAsync`. Between batches an `import_sessions` row
(in `kv`, not a new table) records `{ chatId, source, fileHash, cursor, total, state }`.

- Crash mid-import → committed batches are intact and consistent (each is atomic); the session
  row says `running` with a cursor.
- Retry → the unique index makes re-processing committed rows free, so a retry can simply
  restart from the beginning and land only the missing rows. **The cursor is an optimisation,
  not a correctness requirement** — which is what makes this safe.
- Partial imports are identifiable: session `state` plus a count comparison, surfaced on the
  chat's Exit Kit entry as "Import incomplete — resume?".

**Why batches of 500 rather than one transaction.** One transaction over 100k rows holds a
write lock long enough to stall the socket writer on the same connection (transactions are
already serialised through `txLock`, [localDb.ts:60](lib/localDb.ts#L60)) and loses everything on
a crash. 500 keeps each commit short and bounds the loss to one batch.

**FTS.** Imported rows go through the same blind-token indexing as `cacheMessages`, so imported
history is searchable. Indexed inside the same transaction, keyed by rowid = the negative id;
`msg_fts` is an FTS5 table with an INTEGER rowid and accepts negatives.

### D9 — "No upload" is enforced by a test, not by discipline

`lib/waImport.ts` is a **pure module**: no `react-native` import, no `./api`, no `fetch`. That
makes it Node-testable, matching the convention `lib/archive.ts` already follows.
`lib/waImport.selftest.ts` asserts by source-scan that neither `waImport.ts` nor
`app/import-chats.tsx` references `fetch(`, `lib/api`, `socket`, or `upload`.

The scan lives in the `.selftest.ts` file and **not** inside the shipped module — an embedded
`require('fs')` breaks `assembleRelease` under Metro. This repo has been bitten by exactly that
before; the convention exists for a reason.

## Risks / Trade-offs

**[Negative ids leak into a server request]** → Two independent stops: the `Number(oldest) < 0`
guard in `chat.tsx`'s paging, and `cacheMessages()`'s existing `id <= 0` skip, which prevents an
imported row ever entering a sync/upload path. A self-test asserts the guard's presence.

**[A future `pruneMessageCache` edit drops the `id > 0` guard]** → The guard is asserted by
source-scan in `localDb.staleData.selftest.ts`, which already scans this function's SQL by regex
([localDb.staleData.selftest.ts:155](lib/localDb.staleData.selftest.ts#L155)). Adding one line
there is the cheapest durable protection available.

**[WhatsApp transcript format varies by locale, platform and version]** — 12h vs 24h clocks,
`DD/MM/YY` vs `MM/DD/YY` vs `YYYY-MM-DD`, `[` `]` vs bare brackets, LTR marks and narrow
no-break spaces around AM/PM, `~` prefixes on non-contact senders. → Detect the format from a
sample of the first 200 parsed lines rather than assuming, and resolve DD/MM vs MM/DD by finding
a day value > 12 in the sample. When the sample is genuinely ambiguous (every day ≤ 12), **ask
the user** which order their export uses instead of guessing — a silent 50 % chance of shifting
every date by months is worse than one question. Unparseable lines are counted and reported as
"unsupported items", never dropped silently.

**[Multi-line messages]** → A line that does not begin with a timestamp header is a continuation
of the previous message. This is also how system lines ("Messages are end-to-end encrypted") and
`<Media omitted>` markers are distinguished.

**[Timestamps have no timezone]** — WhatsApp exports local wall-clock time with no offset. → Parse
as device-local, and record `meta.orig.ts` as the raw exported string alongside the resolved ISO
value so a future correction is possible without re-import. State on the completion screen that
timestamps are as-exported.

**[Import of 100k+ messages on a low-end device]** → Batched commits, the in-memory window cap in
`chat.tsx` already handles rendering, and the progress screen must remain responsive and
cancellable. Cancellation stops at a batch boundary and leaves a resumable partial session.

**[Storage exhaustion mid-import]** → Check free space against the archive's declared media size
before starting, and fail the batch cleanly (rolling back that batch only) with "not enough
space" rather than a SQLite error.

**[Onboarding entry point has no chat to import into]** — `onboard-success.tsx` runs *before*
`verifyMpinRemote()` completes login, and a brand-new user has no conversations. → The secondary
action completes login first, then routes to a contact picker, then into the same per-chat Exit
Kit flow. It never becomes a bulk step, and it stays visually secondary to "Continue to Chats".

**[The Settings entry drifting into a dashboard]** → The Settings row routes to a contact picker
and then into the identical per-chat flow. `app/import-chats.tsx` is written to **require** a
`chatId` param and error without one, so a bulk surface cannot be built on top of it by accident.

**[A group export imported into a 1:1 chat]** → Refused by the parser, not by the UI: three or
more distinct senders means the export is a group's, and importing it here would write third
parties' private messages into a two-person conversation. Detected during parse, before anything
is previewed or written.

## Migration Plan

Additive and reversible, in this order:

1. `ALTER TABLE messages ADD COLUMN import_key TEXT` + partial unique index, in `getLocalDb()`'s
   init, wrapped in try/catch per the `lockStore` precedent. Safe on every existing install; the
   column is null for all pre-existing rows, so the partial index covers nothing until an import
   happens.
2. `pruneMessageCache` guard + `chat.tsx` paging guard. Both are no-ops until an import exists.
3. Parser and screen — new files, reachable only from the new entry points.
4. Entry points last, so nothing is user-visible until the path beneath it works.

**Rollback.** Removing the entry points fully disables the feature; the column and index are inert
without imported rows. To reverse an import itself: `DELETE FROM messages WHERE chat_id = ? AND
id < 0 AND import_key IS NOT NULL` — no server state to reconcile, because there never was any.
Worth exposing as the per-chat "remove imported history" action mentioned in D2 if the feature
ships beyond a first cohort.

**No backend deploy.** Nothing in this change reaches `vaultchat-backend`.

## Open Questions

1. **Ambiguous date order.** Design says ask the user when the sample can't disambiguate. Is one
   extra question acceptable, or should it default to device locale order and let the user
   correct it on the preview screen? *(Recommend: ask — it is rare, and a silent months-wide
   shift is unrecoverable without re-import.)*
2. **Media-less exports.** WhatsApp's "Without media" export is the common case and contains only
   `<Media omitted>` markers. Should those become visible placeholder rows, or be counted as
   unsupported and skipped? *(Recommend: placeholder rows — a gap in a conversation is more
   confusing than a labelled "photo, not included in this export".)*
3. **Retention interaction.** Does the delivery-bound purge apply to imported rows? They are
   never "delivered", so on a literal reading they would be kept forever, which is the intended
   outcome — but it should be confirmed against the retention model rather than assumed.
4. **Storage attribution.** `getAttachmentChatMap()` keys off `meta.attachmentId`, which imported
   media does not have, so imported media will not appear in the Storage Manager's per-chat
   totals. Acceptable for v1, or add `meta.importedBytes` so the numbers stay honest?
   *(Recommend: report it — a storage screen that under-counts by gigabytes is a bug report
   waiting to happen.)*
