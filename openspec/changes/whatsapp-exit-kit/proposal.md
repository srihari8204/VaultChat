## Why

People will not leave WhatsApp while their history lives there. VaultChat can offer a
migration bridge that a privacy-first app is uniquely able to offer: parse the user's own
WhatsApp export **on the device**, attach it to one existing 1:1 conversation, and never
send a byte of it to a server.

Deliberately **not** a bulk migration tool. Bulk import is what makes competitors' importers
feel like data harvesting — it is also what makes contact matching guess, and a wrong guess
writes one person's private history into another person's chat. One contact, one export, one
confirmation, every time.

## What Changes

- **New `lib/waImport.ts`** — a pure, on-device WhatsApp export parser. Streams the ZIP with
  `fflate`'s `Unzip` class over positional `RNFS.read` chunks so archive size does not become
  memory; inflates only the transcript entry and never the media payloads. Emits messages with
  original timestamp, sender, body, and media filename.
- **New `app/import-chats.tsx`** — the Exit Kit screen. Always scoped to exactly one target
  `chatId` passed in as a route param. Source picker (WhatsApp live; Telegram/Snapchat as
  "Coming next"), file pick, parse with progress, contact verification, preview, confirm,
  import, completion.
- **New local-only message provenance** — imported rows carry
  `meta.origin = 'wa-import'` plus source app, source contact, original sender, original
  timestamp, and an import-session id.
- **`messages.id` for imports is NEGATIVE.** This is the load-bearing decision; see Impact.
- **New `importMessages()` in `lib/localDb.ts`** — the only writer that accepts a non-positive
  id, transactional, idempotent on a deterministic dedupe key.
- **`pruneMessageCache()` gains `AND id > 0`** — imported history has no server copy, so the
  existing cache sweep must never be allowed to reach it.
- **Three entry points**, all landing in the same one-conversation flow: 1:1 chat `⋮ → Exit
  Kit`; a secondary action on `onboard-success.tsx`; a Settings row.
- **Message rendering marks imported content by source** — a day-separator-style divider at the
  boundary, and on every imported message a small **source logo in its own brand colour**
  (WhatsApp green, Telegram blue, Snapchat gold) rather than a word. A word costs a third of the
  bubble's width on every row and stops being readable once three sources exist; a logo is
  recognised without being read. Icons, labels and tints live in one registry,
  `constants/importSources.ts`, shared by the source picker and the bubble.
- Explicitly **out of scope**: any "import all", multi-select, background migration, or
  server-side ingest. No new backend endpoint. No new dependency.
- **Group chats are out of scope entirely** (owner decision, 2026-08-23; §16 of the brief
  withdrawn). Exit Kit imports 1:1 conversations only. The parser detects a group export and
  refuses it before preview, so third parties' messages can never land in a two-person chat.
  `group-info.tsx`, `routes/chats.js`, `invite-link.tsx` and `join/[code].tsx` are untouched.

## Capabilities

### New Capabilities

- `exit-kit`: One-conversation-at-a-time migration of an external messenger export into a
  single existing VaultChat 1:1 chat — entry points, source selection, the state machine,
  contact verification, confirmation, and completion reporting. Owns the "never bulk" rule.
- `wa-import`: On-device parsing of a WhatsApp exported ZIP — streaming archive access,
  transcript line-format detection across WhatsApp's locale/format variants, media metadata
  extraction, malformed-input handling, and archive security (traversal, decompression bombs).
- `imported-message-provenance`: How an imported message is stored, identified, ordered,
  deduplicated, protected from cache pruning, and attributed in the UI — including the
  negative-id contract and the rule that imported content never reaches a server.

### Modified Capabilities

None. There are no existing files under `openspec/specs/`, so all three capabilities above are
new. The behavioural changes to `pruneMessageCache` and the chat scroll-back path are captured
as requirements inside `imported-message-provenance`.

## Impact

**The two traps this change must not spring.** Both were found by reading the sync path, and
both are silent — they produce no error, just missing data:

1. `getGlobalSyncCursor()` ([lib/localDb.ts:739](lib/localDb.ts#L739)) returns
   `max(MAX(id) FROM messages, stored)`, and `syncEngine.catchUp()`
   ([lib/syncEngine.ts:109](lib/syncEngine.ts#L109)) starts its delta at that value. If imported
   messages were given ids above the real server ids, the delta cursor would leap past the head
   and **the device would stop receiving new messages in every chat, permanently.** Negative ids
   keep `MAX(id)` untouched and `noteGlobalSyncCursor` already rejects `id <= 0`.
2. `pruneMessageCache()` ([lib/localDb.ts:610](lib/localDb.ts#L610)) keeps the newest 300 rows
   per chat by `id DESC` and deletes the rest. Imported rows hold the *lowest* ids in the chat,
   so they are the first victims of every sweep — and unlike real messages they cannot be
   re-fetched. Without the `id > 0` guard, a 1,842-message import silently loses ~1,542 messages.

**Why negative ids rather than a timestamp sort.** The chat renders and pages strictly by `id`
(`ORDER BY id DESC`, `WHERE id < ?`), not by `created_at`, across
[getCachedMessages](lib/localDb.ts#L383), [getCachedMessagesBefore](lib/localDb.ts#L405),
[getCachedMessagesAround](lib/localDb.ts#L438) and [chat.tsx:2096](app/chat.tsx#L2096). Server
ids are positive `BIGSERIAL`, so any negative id sorts below all real history — imported
messages land in the past with no change to the ordering model. Re-sorting the chat by
timestamp would touch every reader and every pager; this touches none.

**Affected code**

| File | Change |
|---|---|
| `lib/waImport.ts` | new — parser, pure, Node-testable |
| `lib/waImport.selftest.ts` | new — parser + dedupe-key checks |
| `app/import-chats.tsx` | new — Exit Kit screen |
| `lib/localDb.ts` | `importMessages()`, `importedRange()`, `id > 0` guard in prune |
| `app/chat.tsx` | one `MenuAction` (1:1 only) at [chat.tsx:1467](app/chat.tsx#L1467); skip the server top-up when the oldest loaded id is negative ([chat.tsx:2103](app/chat.tsx#L2103)) |
| `components/chat/MessageBubble.tsx` | imported-origin attribution |
| `app/onboard-success.tsx` | secondary action, after login completes |
| `app/settings.tsx` | one `LinkRow` |
| `constants/importSources.ts` | new — one registry of source label/icon/tint, shared by the picker and the bubble |

**Dependencies** — none added. `fflate` ([already used by lib/archive.ts, lib/docText.ts,
app/archive-viewer.tsx](lib/archive.ts)), `@dr.pogodin/react-native-fs` (`read(path, length,
position, 'base64')` gives positional chunked reads), and `expo-document-picker` are all
present. No prebuild, no Gradle change, no new native module.

**Backend** — untouched. No route, no migration, no schema change. The one server-facing
consequence is negative and defensive: a negative `before` must never be sent to
`GET /chats/:id/messages`.

**Security surface** — a WhatsApp export is an untrusted archive from outside the app. This
change inherits the existing, already-tested `safeEntryPath()` from
[lib/archive.ts:35](lib/archive.ts#L35) for traversal, and adds an uncompressed-size ceiling on
the single entry it inflates.

**Privacy** — the strict requirement. The parser is a pure module with no `lib/api` import and
no network reachability; the import writes only through `localDb`. Enforced by a source-scan
assertion in the self-test rather than by review, so a future edit that adds an upload path
fails the check.
