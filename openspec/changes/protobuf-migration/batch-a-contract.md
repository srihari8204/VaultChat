# Batch A — field-adapter contract (startup path)

Scope: the decode adapter for the startup batch (`GET /chats`, `GET /chats/delta`,
`GET /chats/{id}/messages` first page) when those bodies become protobuf.
Everything here is derived from source and cites the line that forces it.

Non-goals: `seq`, `depends_on`, `causal_epoch`, `server_ts_ms`, `edit_seq`,
`last_delivered_seq`. They are `[jstype = JS_STRING]` deliberately
(`proto/ccwire/v1/envelope.proto:47,56,142,144,248,249,293`) and stay strings.

---

## 1. Field table

`wireId()` = the strict parser in §2. `str` = pass through unchanged.

| Field | Wire representation | Accepted inputs | Null / absence rule | Sign / zero rule | Domain representation | Validation | Consumer that forces it |
|---|---|---|---|---|---|---|---|
| message `id` | proto `string` (`envelope.proto:140`, `:247`; Go emits `fmt.Sprintf("%d")`, `chats.go:316`) | canonical positive decimal only | never absent on a server row; empty string ⇒ **drop the row**, do not synthesise 0 | `> 0` only. `0` and negative are REJECTED from the wire | `number` | `wireId()`, reject ⇒ drop row | `lib/localDb.ts:425` `typeof m.id !== 'number' \|\| m.id <= 0` skips the row silently; `lib/syncEngine.ts:110` `b.id - a.id` |
| message `replyToId` | proto `string`, optional (`chats.go:307` `*string`) | canonical positive decimal, or absent | **absent ⇒ `null`. Never 0.** Proto3 `string` has no null: absence is the empty string ⇒ `null` | `> 0` only | `number \| null` | `wireId()`, reject ⇒ `null` (not a dropped row) | `lib/msgIds.ts:26` (`Number(null) === 0` points every message at message 0); `msgIds.selftest.ts:54` |
| `chatId` | proto `string` (`envelope.proto:139`, `delivery.proto:6`) | opaque UUID text | required; empty ⇒ drop row (`syncEngine.ts:52` `if (!c) continue`) | n/a — **never numeric** | `string` | non-empty string; **no `wireId()`, no `Number()`** | `lib/chatService.ts:23` `id: string`; `localDb.ts` binds it as a TEXT column |
| `lastMessageId` | proto `string`, optional — mirrors today's JSON `*string` (`chats.go:1120`, via `userBigStr`, `user.go:179-185`) | canonical positive decimal, or absent | absent / empty ⇒ `null`. **`null` means "chat has no messages"** and must stay `null` | `> 0` only | `number \| null` | `wireId()`, reject ⇒ `null` | `lib/unreadStore.ts:69` `mine >= (r.lastMessageId ?? Infinity)` — `0` here would clear every badge; `chats.tsx:791,808` |
| `myLastReadId` | proto `string`, optional (`chats.go:1123`, `*string`) | canonical positive decimal, or absent | absent ⇒ `null` | `> 0`; `null` ≠ `0` at the wire, though the consumer applies its own `?? 0` | `number \| null` | `wireId()`, reject ⇒ `null` | `app/chat.tsx:1453-1455` unread-divider boundary; `lib/chatService.ts:33` |
| `peerLastReadMessageId` | **today a JSON `number`** (`chats.go:1137` `*int64`) — inconsistent with its sibling ids | after migration: proto `string`, same as the others | absent ⇒ `null` | `> 0` only | `number \| null` | `wireId()`, reject ⇒ `null` | `app/(tabs)/chats.tsx:915,917` tick state `(chat.peerLastReadMessageId ?? 0) >= lastMsg.id` |
| `peerLastDeliveredMessageId` | same as above (`chats.go:1138`) | same | absent ⇒ `null` | `> 0` only | `number \| null` | `wireId()`, reject ⇒ `null` | `app/(tabs)/chats.tsx:915` |
| delta cursor `nextSince` | **today a JSON `number`** (Go `int64`, `chats.go:846,935`). If it becomes `string`, see the hazard below | canonical positive decimal | required; absent ⇒ abort the page, do not advance | `> 0` and strictly `> since` | `number` | `wireId()`; then the existing `nextSince <= since` check at `syncEngine.ts:283` | `lib/localDb.ts:1157` `noteGlobalSyncCursor` uses `Number.isFinite(id)`, which is **false for a string** — a stringified cursor makes the durable write a silent no-op forever (`syncEngine.ts:294` passes `r.nextSince` raw, not the coerced local) |
| `syncContinuation`, `nextMutationCursor` | proto `string` | **opaque bytes-as-text** | absent ⇒ `null` / `''` | n/a | `string \| null` | length bound only. **Never parsed, never compared numerically, never fed to `wireId()`** | `syncEngine.ts:226-227,289-290` echoes it verbatim; `nextMutationCursor` is `"<iso>\|<n>"` (`ccwire_cursor_test.go:454`) — not an id |
| `createdAt`, `editedAt`, `deletedAt`, `expiresAt`, `lastMessageAt`, `updatedAt`, `peerLastSeenAt` | proto `string` (RFC3339), matching today's `httpx.JSTime` (`chats.go:310-312,1118-1119`) | ISO-8601 text | optional ones absent ⇒ `null`; `createdAt`/`updatedAt` required | n/a | `string` (ISO), **not** a number | non-empty, parses via `Date.parse` | `lib/chatService.ts:28-31` types them `string`; `localDb` stores ISO text (`localDb.ts:1171` writes `new Date().toISOString()`) |
| `server_ts_ms` and friends | `int64 [jstype = JS_STRING]` | decimal text | — | — | **string, unchanged** | none — do not narrow | `design.md:565-567`; narrowing reintroduces the replay-window bug |

---

## 2. The validation rule

One function, `wireId`, in `lib/msgIds.ts`. Canonical positive decimal only.

```ts
/** Wire id (decimal string) -> number, or null if it is not one we can hold. */
export function wireId(s: unknown): number | null {
  if (typeof s !== 'string' || !/^[1-9][0-9]*$/.test(s)) return null;
  const n = Number(s);
  return Number.isSafeInteger(n) ? n : null;
}
```

The regex is the precedent already in-tree at `lib/ccwire/transport.ts:191`
(`/^[1-9][0-9]*$/` on the ack id). The `Number.isSafeInteger` gate is the
precedent at `lib/receipts.ts:52,77`.

**Rejected, explicitly:**

| Input | Why rejected |
|---|---|
| `" 42"`, `"42 "`, `"42\n"` | `Number()` trims; the regex does not. Whitespace never appears in a `strconv.FormatInt` output (`user.go:183`), so its presence means the producer is not the one we think. |
| `"4.0"`, `"4.5"` | `Number("4.0")` is a clean `4` — accepting it would let a non-integer producer look correct until it emits `4.5`. |
| `"1e3"`, `"0x2a"`, `"0b1"`, `"Infinity"`, `"NaN"` | all parse under `Number()`; none is a `BIGSERIAL` rendering. |
| `"42abc"`, `"42,43"` | trailing characters. |
| `"042"`, `"0"` (leading zeros) | not canonical; two strings for one id breaks any string-keyed dedupe. |
| `""` | proto3 `string` absence. Means *null*, handled by the caller's null rule — never `0`. |
| `"-1"`, `"-9007"` | **negative from the wire is a corruption, not a value.** Negative ids are the Exit-Kit import band and `importMessages()` is their only writer (`localDb.ts:531-543`). A negative from the server would pass `MAX(id)` unnoticed and poison the global cursor contract (`localDb.ts:537-540`). |
| `"0"` | the optimistic-bubble band. Written only by `app/chat.tsx`, never persisted (`localDb.ts:425`). A server row of 0 is a bug. |
| `"9007199254740992"` and above | exceeds `Number.MAX_SAFE_INTEGER`. **This branch is load-bearing and reachable.** `BIGSERIAL` is int64; it can exceed 2^53. An earlier note claimed this check "will never fire" — that claim is retracted here. Silently rounding 2^53+1 to 2^53 creates a *collision* with a real row in an `ON CONFLICT(id)` upsert (`localDb.ts:432`), which overwrites a different message. Rejecting is the only safe outcome; the app degrades, it does not corrupt. |
| `"9223372036854775807"` (int64 max) | same branch. Rejected, never rounded. |

`wireId` returns `null`, never throws. The caller decides what `null` means per
§1 (drop the row for `id`; `null` for every pointer field).

---

## 3. Where the adapter sits

**Exactly one boundary: a new `lib/ccwire/startupAdapter.ts`**, the sole module
that turns decoded protobuf startup messages into `Message` / `ChatSummary`
objects. Nothing downstream of it may see a wire-shaped value.

Why there and nowhere else:

| Reason | Source |
|---|---|
| Downstream is number-keyed and fails **silently** — a string id renders fine and is then never persisted | `lib/localDb.ts:425`; `lib/msgIds.selftest.ts:6-13` (measured: 7 messages shown, 1 survived a restart) |
| One site fails **loudly, mid-sync, uncatchably**: `b.id - a.id` inside a `try/finally` with no catch | `lib/syncEngine.ts:110` |
| The same mistake has already been made five times, once per ingest site, each remembering only `id` | `lib/msgIds.ts:16-22`; `msgIds.selftest.ts:14-22,67-70` |
| The HTTP path keeps its own boundary unchanged during coexistence | `chatService.ts:1376,1420,1486`; `syncEngine.ts:144-145`; `messageQueue.ts:507`; `app/chat.tsx:1037` |

**How it relates to `normalizeMsgIds` without tripping the build guard:**

- `wireId` is added **to `lib/msgIds.ts`**, the sanctioned normalization module.
  That file is excluded from the guard's scan by name
  (`msgIds.selftest.ts:88`, `e.name !== 'msgIds.ts'`), so no marker is needed
  and no exemption is being claimed.
- The adapter assigns ids at object construction — `id: wireId(m.messageId)` —
  which is not the shape the guard matches
  (`/\.(?:id|replyToId)\s*=\s*Number\(/`, `msgIds.selftest.ts:78`) and, more to
  the point, contains no `Number(` on an id at all. **No `msgid-exempt:`
  marker is to be added anywhere in this batch.**
- `normalizeMsgIds` is **not modified** and is **not called on adapter output**.
  Its output is already `number`, and the selftest proves numbers pass through
  unchanged (`msgIds.selftest.ts:60-63`) — calling it would be a no-op that
  implies a validation it does not perform. It remains the boundary for the
  JSON paths, which Batch A does not touch.

---

## 4. Test matrix

New file `lib/startupAdapter.selftest.ts`, same shape as the existing
`ok(label, cond)` runners (`msgIds.selftest.ts:29-36`). No framework.

### 4a. `wireId`

| Input | Expected |
|---|---|
| `"1"` | `1` |
| `"42"` | `42` |
| `"9007199254740991"` | `9007199254740991` (MAX_SAFE_INTEGER, **accepted**) |
| `"9007199254740992"` | `null` (**rejected, not rounded**) |
| `"9223372036854775807"` | `null` (int64 max — rejected, not rounded to `9223372036854775808`) |
| `"0"` | `null` |
| `"-1"` | `null` |
| `"042"` | `null` |
| `" 42"` / `"42 "` | `null` |
| `"4.5"` / `"4.0"` | `null` |
| `"1e3"` / `"0x2a"` | `null` |
| `"42abc"` | `null` |
| `""` | `null` |
| `null` / `undefined` / `42` (number) | `null` (non-string input) |

### 4b. Row-level rules

| Case | Expected |
|---|---|
| message with `messageId: "7"`, `replyToId: "3"` | `{ id: 7, replyToId: 3 }`, both `typeof === 'number'` |
| message with `replyToId: ""` (proto absence) | `replyToId === null`, **strictly not `0`** |
| message with `messageId: ""` | row **dropped** before it reaches `cacheMessages`; no row with `id: 0` is ever constructed |
| message with `messageId: "-5"` (server-negative) | row **dropped** — the import band is not reachable from the wire (`localDb.ts:541-543`) |
| `importedIdFor(Date.UTC(2024,0,1), 0)` | negative, and still accepted by the *local* path — the adapter is not on that path at all (`localDb.ts:564`) |
| optimistic `id === 0` | produced only by `app/chat.tsx`; assert the adapter never emits it |
| summary with `lastMessageId` absent | `null`; assert `applyLocalReadPointers` does **not** clear a badge (`unreadStore.ts:69`) |
| summary with `lastMessageId: "0"` | `null` (rejected value collapses to absence, never `0`) |
| summary with `myLastReadId: "88"` | `88` |
| summary with `peerLastReadMessageId: "88"` | `88`, `typeof === 'number'` |
| `chatId: "018f-…"` | passed through as the same string; assert no numeric coercion |
| `syncContinuation: "2026-09-14T02:00:00Z\|9"` | passed through verbatim; assert `wireId` was not applied |
| `createdAt: "2026-09-18T10:00:00.000Z"` | stays an ISO **string** |

### 4c. Downstream consumers receive the right type

| Consumer | Assertion |
|---|---|
| `syncEngine.ts:68` filter | every adapter-produced id survives `typeof id === 'number' && id > 0` |
| `syncEngine.ts:110` sort | `[...rows].sort((a,b) => b.id - a.id)` returns a number and does not throw |
| `localDb.ts:425` guard | no adapter-produced row is skipped by `typeof m.id !== 'number' \|\| m.id <= 0` |
| `localDb.ts:500` max-id | `maxId > 0` for a non-empty page, so the sync cursor advances |
| `localDb.ts:1157` cursor | `Number.isFinite(cursor)` is `true` for whatever the adapter hands `noteGlobalSyncCursor` |
| reply-target map | `new Map([[3, 'x']]).get(row.replyToId) === 'x'` (`msgIds.selftest.ts:47`) |

---

## 5. What the adapter must not do

| Prohibited | Why |
|---|---|
| Scattered `Number(...)` / `parseInt(...)` on an id anywhere outside `lib/msgIds.ts` | This is the exact bug the guard exists to prevent: five sites, each remembering only `id` (`msgIds.selftest.ts:67-70`). `parseInt("42abc")` is `42`, which is precisely the silent acceptance §2 rejects. |
| Changing `normalizeMsgIds`'s behaviour | Six live callers on the JSON paths; making it strict would start dropping rows that ship today. Batch A adds a sibling, it does not retune the shared one. |
| Adding a `msgid-exempt:` marker | Nothing in this batch needs one (§3). An exemption added here becomes the template for the next one added carelessly. |
| Treating `syncContinuation` / `nextMutationCursor` as an id | They are opaque server tokens, one of them not even numeric (`"<iso>\|<n>"`). Parsing them couples the client to a format the server is free to change (`ccwire_cursor.go:576-586`). |
| Converting `null` / absent to `0` | `Number(null) === 0` points every message at message 0 (`msgIds.ts:26`), and `lastMessageId: 0` clears every unread badge (`unreadStore.ts:69`). |
| Describing the safe-integer branch as unreachable, or removing it | `BIGSERIAL` is int64. Rounding past 2^53 collides with a real row under `ON CONFLICT(id)` (`localDb.ts:432`). |
| Narrowing `seq` / `depends_on` / `causal_epoch` / `server_ts_ms` to `number` | `[jstype = JS_STRING]` is deliberate; narrowing reintroduces the replay-window bug. |
| Emitting a negative or zero id into the cache | `importMessages()` is the only negative writer; `cacheMessages` skips `<= 0` (`localDb.ts:541-543`). |

---

## 6. Open questions

1. **`PeerLast*` must be fixed before `GET /chats` is migrated.** `chats.go:1137-1138`
   emits `*int64` (a JSON number) while its sibling ids are strings
   (`:1120,:1123`). Freezing that into a schema makes a one-line inconsistency
   permanent. Decision needed: does Batch A carry the server-side fix to
   `userBigStr`, or does it block on it? (`design.md:611-615` says block.)

2. **`nextSince` representation.** It is a JSON number today
   (`chats.go:846,935`) but the CC-Wire cursor proxy's own fixtures already
   carry it as a string (`ccwire_cursor_test.go:281,350,420`). If protobuf makes
   it a string, `syncEngine.ts:294` hands the raw value to
   `noteGlobalSyncCursor`, whose `Number.isFinite` (`localDb.ts:1157`) is
   **false for a string** — the durable cursor write becomes a silent permanent
   no-op. Decide the wire type, and fix `syncEngine.ts:294` to pass the
   validated local `nextSince` either way. This is a live latent bug, not a
   migration-only one.

3. **Existing type lie on `ChatSummary`.** `lib/chatService.ts:30,33` declare
   `lastMessageId`/`myLastReadId` as `number | null`, but the server sends
   strings today (`chats.go:1120,1123`) and `listChats` (`chatService.ts:1147-1167`)
   normalizes neither. It works only because every consumer happens to use a
   mixed-type relational comparison (`unreadStore.ts:69`, `app/chat.tsx:1455`).
   Should Batch A's adapter make these genuinely `number` (and so change
   behaviour on the JSON path too), or hold the lie until the whole endpoint
   moves?

4. **Rejected id: drop or surface?** §1 says drop the row. A dropped row is
   invisible, which is the failure mode this whole document exists to prevent.
   Proposal: `metric('adapter.rejected_id', n)` alongside the existing
   `metric('delta.duplicates', …)` (`syncEngine.ts:82`) so a rejecting server is
   visible. Needs sign-off that a metric is the right surface, not a throw.
