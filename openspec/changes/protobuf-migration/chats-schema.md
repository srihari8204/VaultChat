# Batch C — typed schema for `GET /chats`

Derived from the tree as it stands today, re-resolved:

- `vaultchat-backend-go/internal/routes/chats.go` — `chatsListItem` (L1112–1150), `chatsList` (L1152–1286)
- `lib/chatService.ts` — `ChatSummary` (L22–66), `listChats` (L1147–1167)
- `app/(tabs)/chats.tsx` — cache-first paint (L157–205), row render (L783–930)
- `lib/localDb.ts` — `cacheChats` (L1190–1217), `getCachedChats` (L1219–1225)
- `lib/unreadStore.ts` — `applyLocalReadPointers` (L62–72)
- `proto/ccwire/v1/chats_common.proto`, `cursor.proto`, `delivery.proto`, `attachment.proto` — house style

**28 fields.** The response is a **bare JSON array**, not an object — `httpx.JSON(w, 200, out)` on `[]chatsListItem`. The typed reply needs an envelope message (proto3 has no top-level repeated); that is a typed-path-only shape, the JSON stays a bare array.

---

## 1. Field-by-field mapping

`?` = Go pointer. "null on wire" = this endpoint really can emit JSON `null` today.

| # | Go field | json tag | Go type | null on wire? | proto | presence | client TS (`ChatSummary`) |
|---|---|---|---|---|---|---|---|
| 1 | `ID` | `id` | `string` | no | `string id = 1` | implicit; `""` impossible (PK) | `string` |
| 2 | `Type` | `type` | `string` | no | `string type = 2` | implicit; always `direct`\|`group` | `'direct'\|'group'` |
| 3 | `Name` | `name` | `*string` | **yes** | `optional string name = 3` | absent ⇔ null; `""` is a distinct real value | `string \| null` |
| 4 | `PhotoURL` | `photoURL` | `*string` | **yes** | `optional string photo_url = 4` | absent ⇔ null | `string \| null` |
| 5 | `CreatedBy` | `createdBy` | `*string` | **yes** | `optional string created_by = 5` | absent ⇔ null | `string \| null` |
| 6 | `CreatedAt` | `createdAt` | `httpx.JSTime` | no | `string created_at = 6` | implicit; ISO verbatim | `string` |
| 7 | `UpdatedAt` | `updatedAt` | `httpx.JSTime` | no | `string updated_at = 7` | implicit; ISO verbatim | `string` |
| 8 | `LastMessageID` | `lastMessageId` | `*string` (JSON **string**) | **yes** | `optional int64 last_message_id = 8 [jstype = JS_STRING]` | absent ⇔ null | `number \| null` (normalized) |
| 9 | `LastMessageAt` | `lastMessageAt` | `*httpx.JSTime` | **yes** | `optional string last_message_at = 9` | absent ⇔ null | `string \| null` |
| 10 | `MyRole` | `myRole` | `string` | no | `string my_role = 10` | implicit; DB-nonnull | `GroupRole` |
| 11 | `MyLastReadID` | `myLastReadId` | `*string` (JSON **string**) | **yes** | `optional int64 my_last_read_id = 11 [jstype = JS_STRING]` | absent ⇔ null | `number \| null` (normalized) |
| 12 | `Muted` | `muted` | `bool` | no | `bool muted = 12` | implicit | `boolean` |
| 13 | `Pinned` | `pinned` | `bool` | no | `bool pinned = 13` | implicit | `boolean` |
| 14 | `Favourite` | `favourite` | `bool` | no | `bool favourite = 14` | implicit | `boolean` |
| 15 | `Archived` | `archived` | `bool` | no | `bool archived = 15` | implicit | `boolean` |
| 16 | `Hidden` | `hidden` | `bool` | no | `bool hidden = 16` | implicit | `boolean` |
| 17 | `ScreenshotMode` | `screenshotMode` | `string` | no | `string screenshot_mode = 17` | implicit; server defaults NULL→`"block"` **before** serialization (`chatsStrDefault`), so `""` is unreachable | `'allow'\|'allow_notify'\|'block'\|'block_silent'` |
| 18 | `VanishMode` | `vanishMode` | `bool` | no | `bool vanish_mode = 18` | implicit | `boolean` |
| 19 | `UnreadCount` | `unreadCount` | `int64` | no | `int64 unread_count = 19` | implicit; `0` is a real value, never absence | `number` |
| 20 | `PeerUserID` | `peerUserId` | `*string` | **yes** (groups) | `optional string peer_user_id = 20` | absent ⇔ null ⇔ "group, no peer" | `string \| null` |
| 21 | `PeerName` | `peerName` | `*string` | **yes** | `optional string peer_name = 21` | absent ⇔ null | `string \| null` |
| 22 | `PeerPhotoURL` | `peerPhotoURL` | `*string` | **yes** | `optional string peer_photo_url = 22` | absent ⇔ null (masked peers forced null) | `string \| null` |
| 23 | `PeerOnline` | `peerOnline` | `bool` | no — `*bool` is collapsed to `false` in the handler | `bool peer_online = 23` | implicit; **already** two-state in JSON | `boolean` |
| 24 | `PeerLastSeenAt` | `peerLastSeenAt` | `*httpx.JSTime` | **yes** | `optional string peer_last_seen_at = 24` | absent ⇔ null ⇔ hidden-by-privacy | `string \| null` |
| 25 | `PeerLastReadMessageID` | `peerLastReadMessageId` | `*int64` (JSON **number**) | **yes** | `optional int64 peer_last_read_message_id = 25 [jstype = JS_STRING]` | absent ⇔ null ⇔ receipts off | `number \| null` |
| 26 | `PeerLastDeliveredMessageID` | `peerLastDeliveredMessageId` | `*int64` (JSON **number**) | **yes** | `optional int64 peer_last_delivered_message_id = 26 [jstype = JS_STRING]` | absent ⇔ null | `number \| null` |
| 27 | `AnonMasked` | `anonMasked` | `bool` | no | `bool anon_masked = 27` | implicit | `boolean` |
| 28 | `ExpiresAt` | `expiresAt` | `*httpx.JSTime` | **yes** | `optional string expires_at = 28` | absent ⇔ null ⇔ never expires | `string \| null` |

`peerBlocksCapture` / `peerWantsCaptureNotice` are declared optional on `ChatSummary` but **this endpoint never sends them** — they come from `chats_helpers.go:224-225` on the detail route. Out of scope for Batch C; do not add fields for them.

---

## 2. The presence problem

proto3 flattens null to the zero value, so every field where null and the zero value are *different domain states* needs explicit presence. `optional` (proto3 field presence) buys exactly **two**: absent, or a value. That is enough here only because every three-state case below is really "absent, or one of the value states" — the third state is a *value*, not a second flavour of absence.

Fields where `null` ≠ `""` / `0` / `false` today, and the encoding:

| field | the three states | encoding |
|---|---|---|
| `name`, `photoURL`, `createdBy`, `peerUserId`, `peerName`, `peerPhotoURL` | null (no value) / `""` (set-to-empty) / non-empty | `optional string` — absent = null, present+`""` = empty, present+text = value. Three states, distinguished. The handler already treats these apart: `if peerUserID != nil && *peerUserID != ""` (chats.go L1264). |
| `lastMessageId`, `myLastReadId`, `peerLastReadMessageId`, `peerLastDeliveredMessageId` | null (no message / read nothing / receipts off) / `0` / `N>0` | `optional int64 [jstype = JS_STRING]` — absent = null, present+`0` = a genuine zero, present+N = value. `0` is not currently produced by the sequence, but absent≠0 must survive on the wire regardless, because `applyLocalReadPointers` treats them differently (`mine >= (r.lastMessageId ?? Infinity)`: null ⇒ never clear, 0 ⇒ always clear). |
| `lastMessageAt`, `peerLastSeenAt`, `expiresAt` | null (none / hidden / never) / epoch-ish value / real value | `optional string` — absent = null. Kept as ISO string, so there is no "0 means both epoch and absent" hazard at all (see §4). |
| `unreadCount` | `0` is a **real** count, never absence | plain `int64`. No `optional` — adding it would invent an absence state the JSON has never had. |
| `peerOnline` | `*bool` from SQL, but the handler collapses NULL→`false` at chats.go L1260-1262 **before** serialization | plain `bool`. The flattening already happened in the JSON contract; encoding it as `optional` would make the typed path carry a state the JSON path cannot. |
| `screenshotMode` | NULL→`"block"` via `chatsStrDefault` before serialization | plain `string`. Same reasoning as `peerOnline`. |

**Rule applied:** `optional` where the JSON emits `null`; plain field where the handler has already collapsed the null. Never the reverse — the typed response must not be able to express a state the JSON response cannot, and vice versa.

---

## 3. The id fields

The inconsistency is real and stays: `LastMessageID` / `MyLastReadID` go through `userBigStr` (`user.go:179`) and land in JSON as **strings**; `PeerLastReadMessageID` / `PeerLastDeliveredMessageID` are `*int64` and land as **JSON numbers**. All four originate as `*int64` scanned off the same rows (chats.go L1226, L1237).

Decision:

1. **Legacy JSON is untouched.** No `json:",string"`, no type change on `chatsListItem`, no removal of `userBigStr`. Two of them stay strings, two stay numbers, exactly as today.
2. **All four are `optional int64 [jstype = JS_STRING]` in proto** — one uniform typed representation, matching house style (`cursor.proto:10-11`, `delivery.proto:13`, `attachment.proto:22-24`). JS_STRING keeps them out of the JS double range hazard on the way into the client.
3. **The typed builder reads the scanned `*int64`, not the serialized form.** `LastMessageID` in the typed path never passes through `userBigStr` — the string hop exists only for JSON. Same pointer, two serializers.
4. **Normalization at the opted-in client boundary only.** The typed decoder hands back JS strings (JS_STRING) and the adapter coerces to `number | null` — preserving null, never `Number(null) === 0`. This is the existing `lib/msgIds.ts` `normalizeMsgIds` contract; extend that module rather than writing a second coercer, since it already documents the null-preservation rule and has a runnable selftest.
5. **This makes the typed path stricter, not different.** `ChatSummary` already declares `lastMessageId: number | null`, and `unreadStore.ts:69` and `chats.tsx:915` compare these numerically. Today a *string* `lastMessageId` reaches a `number`-typed field and only works because JS `>=` coerces. The typed path delivers what the type claims. Consumers of the JSON path are unaffected.

Cache note: `cacheChats` stores `JSON.stringify(c)` of the already-normalized in-memory row, so an opted-in device persists numeric ids and a non-opted-in one persists a string `lastMessageId`. Both survive `getCachedChats` → `applyLocalReadPointers` identically (relational coercion), but a device that flips its opt-in mid-life will read back rows of the other shape — the adapter must normalize on the cache-read path too, not only the network path.

---

## 4. Timestamps

`createdAt`, `updatedAt`, `lastMessageAt`, `peerLastSeenAt`, `expiresAt` are `httpx.JSTime`, which marshals as `"2006-01-02T15:04:05.000Z"` — fixed-width UTC ISO-8601, millisecond precision (`httpx` L26-28).

**Wire representation: `string`, carrying byte-identical output of `JSTime.MarshalJSON` minus the quotes.** Nullable ones get `optional string`.

Justification:

- The client types these `string` and feeds them straight to `new Date(...)` (`chats.tsx:889`) and `formatRelative` (`chats.tsx:787`). ISO-in, ISO-out is zero conversion on both sides.
- House style's `int64 *_ms [jstype = JS_STRING]` (`cursor.proto`, `delivery.proto`) applies to fields that are **already numbers in JSON**. These are not. Converting to epoch-ms would be a representation change — the exact thing this migration forbids — and would reintroduce the `0 == epoch == absent` ambiguity that `optional string` sidesteps entirely.
- `google.protobuf.Timestamp` is unused in this repo and would add a WKT import plus a lossy ms↔ns round trip for no gain.
- The legacy JSON representation does not change.

---

## 5. Field numbering

Numbers **1–28** in `chatsListItem` declaration order (table above). All fit in the 1-byte tag range (1–15 get the cheap tag; the hot booleans 12–16 land there, which is fine but not load-bearing). **Nothing is reserved** — no field has ever been removed from this struct, so there is no retired number to protect.

Rule for future additions:

- New field ⇒ next unused number, starting at **29**. Never renumber, never reuse.
- Any field ever deleted ⇒ `reserved <n>;` and `reserved "<name>";` in the same commit as the deletion.
- A field's type or presence never changes in place. A changed representation is a new number plus a `reserved` on the old one.
- The number is assigned when the Go field is added, in the same PR, so the proto can't drift behind `chatsListItem`.

---

## 6. What the handler must not do

- **No JSON marshal/unmarshal as an intermediate step.** Not `json.Marshal(item)` → `protojson.Unmarshal`, not a `map[string]any` hop. That would make the typed response a *derivative* of the JSON response, so any JSON bug is reproduced verbatim and the equivalence test proves nothing.
- The typed message is built from **the same scanned row variables** the `chatsListItem` literal is built from (chats.go L1222-1248) — same `*int64`, same `*time.Time`, same `*string`.
- Therefore the two serializers must be fed by one shared step. Either the row-scan closure populates both, or it populates a single intermediate domain struct that both serializers consume. Do **not** build `chatsListItem` and then walk it into proto: `userBigStr` and `chatsStrDefault` have already run by then, and the typed path must see the pre-collapse values for ids (§3.3) while seeing the post-collapse values for `screenshotMode`/`peerOnline` (§2).
- The masking step (`maskedChats[id]`, L1265-1271) and the identity resolve (`vault.IdentityFromRow`) run **once**, before either serializer. A second masking implementation on the typed path is a privacy bug waiting to happen.
- Content negotiation decides only *which bytes go out*. No query shape, no ordering, no `LIMIT`, no field set varies by representation.

---

## 7. Equivalence test design

Goal: prove both representations yield the same **domain outcome**, without an oracle produced by the adapter under test.

1. **Independent fixtures.** A hand-written table of chat rows as literal Go values — including, per field: null, zero-value, and a non-zero value; `""` vs null for every `*string`; `0` vs null vs large (> 2^53) for every id; a group row (peer fields all null); a masked-anon row; a row with `expiresAt` set. Committed as data, not generated by any serializer.
2. **Hand-written expected JSON**, as literal strings in the test file, authored by reading the current handler — not captured from it. This is the legacy-contract lock: it fails if `userBigStr` is "fixed", if a null becomes `""`, or if `JSTime` drops its milliseconds.
3. **Hand-written expected proto**, as literal `ccwirev1.ChatListItem` values in the test file, authored from §1's table. Not derived from the JSON fixture and not produced by the builder.
4. **Both serializers run against the same fixture rows**, each compared to its own independent expectation. Neither expectation is derived from the other.
5. **Domain equivalence, field by field**, as a third assertion over a declared correspondence list: for each of the 28 fields, `jsonValue` and `protoValue` map to the same domain value under the documented normalization. Presence is asserted explicitly — for every nullable field, one case where JSON is `null` **and** the proto field is absent, and (for strings) one where JSON is `""` **and** the proto field is present-and-empty. A test that only checks non-null values passes on a schema that has lost null entirely.
6. **Client side:** feed the hand-written JSON fixture through the existing JSON path and the hand-written proto fixture through the adapter, and assert both produce the same `ChatSummary[]`, with `lastMessageId`/`myLastReadId` as `number | null` on the typed path (§3.5 is a deliberate, asserted difference from the JSON path's string — record it as expected, do not assert byte-equality there).
7. **One behavioural check downstream**, not just shape: run both resulting arrays through `applyLocalReadPointers` with the same read-pointer map and assert identical `unreadCount`. That is the one place a null→0 flattening would silently clear a badge.

No golden-file capture. No `protojson` round-trip as the comparison mechanism.

---

## 8. Open questions

1. **`lastMessageId` / `myLastReadId` becoming real numbers on the typed path** is a behaviour difference between the two representations on the same device, even though `ChatSummary` has always *claimed* `number`. Accept it (typed path matches the declared type), or keep the typed path bug-compatible and hand back strings? §3 assumes the former.
2. **Mixed-shape cache.** `cacheChats` persists whatever shape the row had. A device that opts in, or loses the opt-in on a rollback, reads back rows of the other shape. Normalize on `getCachedChats` for everyone (safe, touches the non-opted-in path), or only inside the adapter (narrower, leaves stale-shape rows on a rollback)?
3. **Envelope naming and whether the typed reply should stay a bare repeated field in an envelope** (`ChatListReply { repeated ChatListItem chats = 1; }`) while the JSON stays a bare array — confirming nobody expects the two to be structurally identical.
4. **`peerOnline` and `screenshotMode` null-collapse**: encoded as plain (non-optional) per §2, which freezes today's lossy behaviour into the new schema. Is that intentional forever, or should a later change surface "unknown" distinctly? Deciding now avoids a `reserved` later.
5. **`peerBlocksCapture` / `peerWantsCaptureNotice`** are on `ChatSummary` but never sent by this endpoint. Leave them absent from the schema (current plan), or is some caller silently relying on `undefined` here?
6. **`type` and `myRole` as `string` vs `enum`.** String is the lazy, representation-preserving choice; an enum would need an `UNSPECIFIED = 0` and a decision about unknown values from a newer server. Recommend string; confirm.

---

## Proposed schema (design only — not a file)

```proto
syntax = "proto3";
package ccwire.v1;
option go_package = "vaultchat/backend-go/internal/ccwire/v1;ccwirev1";

// GET /chats (Batch C). The legacy JSON response is a BARE ARRAY of these and
// does not change: two of the four id fields stay JSON strings, two stay JSON
// numbers, and the timestamps stay ISO. This message is the typed alternative,
// built from the same scanned row — never by re-parsing the JSON.
//
// PRESENCE. `optional` appears on exactly the fields whose JSON emits null.
// Fields the handler already collapses before serialization (peer_online from
// *bool, screenshot_mode defaulted to "block") are plain, so the typed reply
// cannot express a state the JSON reply cannot — nor the reverse.
//
// IDS. All four are optional int64 + JS_STRING here even though the legacy JSON
// splits them across string and number. The typed path reads the *int64 the row
// was scanned into, skipping userBigStr; the opted-in client coerces to
// `number | null` (lib/msgIds.ts), preserving null rather than Number(null)===0.
//
// TIMESTAMPS. string, byte-identical to httpx.JSTime's ISO-8601 millisecond
// output. NOT int64 *_ms: those are for fields already numeric in JSON, and an
// epoch would make 0 ambiguous with absent.
message ChatListItem {
  string id                     = 1;
  string type                   = 2;  // "direct" | "group"
  optional string name          = 3;  // absent <=> null; "" is a distinct value
  optional string photo_url     = 4;
  optional string created_by    = 5;
  string created_at             = 6;  // ISO-8601, ".000Z", never null
  string updated_at             = 7;

  optional int64  last_message_id = 8 [jstype = JS_STRING]; // JSON: string|null
  optional string last_message_at = 9;                      // ISO|null

  string my_role                  = 10;
  optional int64 my_last_read_id  = 11 [jstype = JS_STRING]; // JSON: string|null

  bool muted      = 12;
  bool pinned     = 13;
  bool favourite  = 14;
  bool archived   = 15;
  bool hidden     = 16;

  string screenshot_mode = 17; // NULL already defaulted to "block" server-side
  bool   vanish_mode     = 18;
  int64  unread_count    = 19; // 0 is a real count — never optional

  optional string peer_user_id  = 20; // absent <=> group / no live peer
  optional string peer_name     = 21;
  optional string peer_photo_url = 22;
  bool   peer_online            = 23; // *bool already collapsed to false
  optional string peer_last_seen_at = 24; // absent <=> hidden by privacy

  // absent <=> read receipts off or no pointer. JSON emits these as NUMBERS
  // while 8/11 emit strings; that inconsistency stays in the JSON and is
  // normalized only at the opted-in client boundary.
  optional int64 peer_last_read_message_id      = 25 [jstype = JS_STRING];
  optional int64 peer_last_delivered_message_id = 26 [jstype = JS_STRING];

  bool anon_masked        = 27; // migration 119 — trust this, not the name
  optional string expires_at = 28; // absent <=> never expires (migration 120)

  // Next free field number: 29. Never renumber, never reuse; a deleted field
  // gets `reserved <n>;` and `reserved "<name>";` in the same commit.
}

// Envelope, matching CommonGroupsReply's reasoning: the reply is a message so a
// later addition needs no new top-level type. The JSON stays a bare array.
message ChatListReply {
  repeated ChatListItem chats = 1;
}
```
