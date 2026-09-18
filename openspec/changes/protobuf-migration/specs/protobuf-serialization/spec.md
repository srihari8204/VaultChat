# protobuf-serialization

## ADDED Requirements

### Requirement: One schema source of truth

The `.proto` files SHALL be the authoritative definition of every migrated
boundary, and the codecs used at runtime SHALL be generated from them. No
hand-written codec and no generated codec SHALL be edited by hand.

Today this is false and nothing detects it: `lib/ccwire/codec.ts` and
`vaultchat-backend-go/internal/ccwire/codec.go` are two independently
hand-written codecs, and `proto/ccwire/v1/*.proto` describes them from the side
with no generator, no `go:generate`, and no check that the three agree. A field
number changed in one place is caught by nothing.

#### Scenario: Regeneration is a no-op
- **WHEN** the documented generation command is run against an unchanged
  `.proto` tree
- **THEN** no generated file SHALL change, and a check SHALL fail the build if
  any does

#### Scenario: A schema and a codec disagree
- **WHEN** a hand-written codec is retained for a boundary
- **THEN** a shared cross-language fixture SHALL prove it decodes what the
  generated codec encodes, and encodes what the generated codec decodes

#### Scenario: Hand-edited generated file
- **WHEN** a generated file is modified without a corresponding `.proto` change
- **THEN** regeneration SHALL revert it and the verification check SHALL fail

### Requirement: Field identity is permanent

Published field numbers, types and meanings SHALL be preserved. A retired field
number or name SHALL be reserved, never reused for a different meaning.

`AppEvent.payload_json` is field 2 and carries UTF-8 JSON today. It SHALL NOT be
repurposed to carry a different payload shape under the same number; a typed
payload SHALL occupy a new field number, and the two SHALL be distinguishable
without guessing.

#### Scenario: Typed payload added alongside the legacy field
- **WHEN** a typed event payload is introduced
- **THEN** it SHALL use a new field number, and `payload_json` SHALL retain its
  number, type and meaning for peers that still send it

#### Scenario: Field retired
- **WHEN** a field is removed from a message
- **THEN** its number and name SHALL be added to a `reserved` declaration in the
  same message

### Requirement: Representation is negotiated, never guessed

A peer SHALL send a representation only when the other side has declared it can
decode that representation. A receiver SHALL NOT identify a representation by
attempting parsers in sequence.

#### Scenario: CC-Wire representation selection
- **WHEN** a session is established
- **THEN** the representation SHALL be determined by the existing
  `ClientHello`/`ServerHello` capability intersection, without an additional
  startup round trip, and without changing the meaning of the existing
  `app_events_v1` flag

#### Scenario: HTTP representation selection
- **WHEN** a client wants a binary Protobuf body
- **THEN** it SHALL request it with an explicit `Accept` and send
  `Content-Type: application/protobuf`, and a server that does not support it
  SHALL answer JSON rather than fail

#### Scenario: Ambiguous or malformed input
- **WHEN** a received body is neither a valid instance of the negotiated
  representation nor an explicitly supported legacy format
- **THEN** it SHALL be rejected as malformed, and SHALL NOT be retried under a
  different parser

#### Scenario: Unsupported critical operation
- **WHEN** a receiver cannot decode or does not support a critical operation
- **THEN** it SHALL NOT acknowledge that operation as processed, and SHALL NOT
  advance a delivery or read cursor for it

### Requirement: Value fidelity across languages and boundaries

Migrated boundaries SHALL preserve the exact value of every identifier,
timestamp and monetary amount across TypeScript, Go, SQLite and the native
bridge.

Two constraints are load-bearing and already established in this codebase:
`messages.id` is both sort key and delta-sync cursor, and local-only rows use
NEGATIVE ids (`openspec/config.yaml`); and money is integer paise through
`utils/money.ts`, never a float.

#### Scenario: Large integer identifier
- **WHEN** an identifier exceeds the exact-integer range of a JavaScript number
- **THEN** it SHALL be carried in a representation that preserves it exactly,
  and a boundary test SHALL assert the exact value round-trips

#### Scenario: Negative local identifier
- **WHEN** a locally-created row carries a negative `messages.id`
- **THEN** encoding and decoding SHALL preserve the sign, and validation that
  rejects negatives SHALL be applied only where server-assigned ids are required

#### Scenario: Monetary amount
- **WHEN** a monetary value crosses a migrated boundary
- **THEN** it SHALL remain an exact integer in the minor unit, and SHALL NOT be
  represented as a floating-point value at any boundary

#### Scenario: Timestamp
- **WHEN** a timestamp crosses a migrated boundary
- **THEN** its unit and precision SHALL be unchanged from the current
  representation, and a test SHALL assert the boundary values

### Requirement: Decoding is not authorization

A successfully decoded message SHALL NOT be treated as valid or permitted.
Domain validation, authentication, authorization, rate limiting and idempotency
SHALL be applied after decoding, unchanged, on every representation.

This is the specific risk in the CC-Wire submission path: it currently inherits
eleven distinct gates by routing through the REST handler
(`vaultchat-backend-go/internal/realtime/ccwire_messages.go:106-112`), and no
representation change may reduce that set.

#### Scenario: A second transport reaches the same operation
- **WHEN** a message submission arrives over CC-Wire rather than HTTP
- **THEN** it SHALL pass the same authentication actor binding, membership
  check, block check, rate-limit buckets, slow mode, per-type validation, size
  cap, row-level-security transaction and idempotency key as the HTTP path

#### Scenario: Resource limits
- **WHEN** a body exceeds a declared size, collection count, string length or
  nesting limit
- **THEN** it SHALL be rejected before domain processing, in every language that
  decodes it

#### Scenario: Side effects happen once
- **WHEN** the same operation is submitted twice with the same idempotency key
- **THEN** exactly one durable row SHALL result, matching current behaviour

### Requirement: Stored records coexist rather than being rewritten

A stored record in an older format SHALL remain readable indefinitely. Format
changes to persisted records SHALL be introduced by prefix or version marker
with both readers retained, following the established `enc:v1:` pattern
(`lib/cacheCrypto.ts`).

Old-format rows are immortal in this app: `messages` has no age-based reaper,
and `importAll` can reintroduce old rows from a backup at any time.

#### Scenario: Lazy write-through
- **WHEN** a record in the old format is next written
- **THEN** it MAY be written in the new format, and nothing SHALL bulk-rewrite
  existing rows as a precondition

#### Scenario: Migration interrupted
- **WHEN** a background record migration is interrupted, or the app is killed
- **THEN** it SHALL resume from a durable cursor committed with each page, and
  SHALL NOT replay completed work or skip incomplete work

#### Scenario: Account switch during migration
- **WHEN** the local database is cleared for logout or account switch while a
  migration is in flight
- **THEN** the migration SHALL abort rather than write into the replaced
  database

#### Scenario: Locked cache
- **WHEN** a record cannot be read because the cache key is not loaded
- **THEN** the migration SHALL refuse to advance its durable cursor past that
  record, and SHALL NOT rewrite the still-sealed value

#### Scenario: Unparseable record
- **WHEN** a record cannot be parsed in either format
- **THEN** it SHALL be left untouched, and SHALL NOT be deleted or rewritten

### Requirement: Inner encrypted content changes only behind a capability gate

A new serialization for content inside the E2EE boundary SHALL NOT be emitted
until the sender can establish that every recipient device can decode it.

No such signal exists today: key bundles, sender-key distribution messages and
CC-Wire capabilities all carry no content-format capability, and a format
marker written by the sender says nothing about the reader. The failure mode is
a permanently unreadable message with no retry and no feedback
(`lib/chatService.ts:373`).

#### Scenario: Unknown recipient capability
- **WHEN** a sender cannot establish that a recipient device supports the new
  content format
- **THEN** it SHALL emit the existing format

#### Scenario: Group send
- **WHEN** a group message is encrypted once for all members
- **THEN** the format SHALL be the one supported by every member device, and a
  single unsupported device SHALL pin the group to the existing format

#### Scenario: Server never translates
- **WHEN** peers support different content formats
- **THEN** the server SHALL NOT decrypt content to translate between them

#### Scenario: Binary content and the plaintext cache
- **WHEN** an inner content format can contain a NUL byte
- **THEN** it SHALL NOT be stored through the current `<NUL>tag<NUL>` plaintext
  cache framing (`services/crypto/messageStore.ts:50-59`) until that framing is
  made length-prefixed or otherwise NUL-safe

### Requirement: Migrated paths are provably not JSON

A migrated first-party boundary SHALL be covered by a check that fails if JSON
serialization is reintroduced on that path, and that check SHALL be
demonstrated to fail when the migration is reverted.

The check SHALL be scoped to active serialization boundaries. Ordinary
in-memory object handling, external provider payloads, standardized formats,
configuration, and retained legacy readers SHALL NOT be treated as violations.

#### Scenario: JSON reintroduced on a migrated path
- **WHEN** a JSON encode or decode is added to a migrated boundary
- **THEN** the guard SHALL fail

#### Scenario: Guard proven
- **WHEN** a guard is added
- **THEN** reverting the corresponding fix SHALL be shown to make that guard
  fail, in a disposable copy rather than the shared working tree

#### Scenario: Exception recorded
- **WHEN** a JSON site is retained on a first-party path
- **THEN** it SHALL carry an exact boundary, a reason, an owner, and either a
  permanent standard justification or a named retirement condition

#### Scenario: Directory-wide exemption
- **WHEN** an exemption would cover a whole directory or package
- **THEN** it SHALL be rejected in favour of per-boundary entries

### Requirement: A server message id is validated before it is narrowed

A server-supplied message id SHALL be validated as a canonical positive decimal
within the exact-integer range BEFORE any conversion that can lose or change its
value, and a value outside that range SHALL be rejected rather than rounded.

The id path is proto `string`, not `int64` (`design.md` §8a) — `message_id` and
`chat_id` are length-delimited in `envelope.proto` and `delivery.proto`, so the
adapter problem is decimal-string to number, and no `bigint` appears on this
path. The device store is number-keyed, so a number is what downstream consumers
must receive; the 2^53 ceiling is documented and deliberate
(`lib/msgIds.ts:28-33`). Three id bands are disjoint and load-bearing
(`lib/localDb.ts:528-558`): `> 0` is a server row, `0` is the optimistic outbox
bubble, `< 0` is Exit-Kit imported history written only by `importMessages()`.
Nothing negative comes from the wire. The precedent to copy already exists —
`lib/transport.ts:190-192` validates an ack id with `/^[1-9][0-9]*$/` and never
converts to a double. The conversion itself SHALL route through
`normalizeMsgIds` (`lib/msgIds.ts:28`), which `msgIds.selftest.ts:78` enforces
by failing the build on any unmarked `.id = Number(`.

#### Scenario: Canonical decimal id
- **WHEN** the server sends a message id as a canonical positive decimal string
- **THEN** it SHALL be accepted and the adapted row SHALL carry the same value

#### Scenario: Largest exactly-representable id
- **WHEN** the id is `"9007199254740991"` (2^53 - 1)
- **THEN** it SHALL be accepted and SHALL adapt to exactly 9007199254740991

#### Scenario: First unrepresentable id
- **WHEN** the id is `"9007199254740992"` (2^53)
- **THEN** it SHALL be rejected as out of range, and SHALL NOT be rounded to a
  nearby representable value

#### Scenario: int64 maximum
- **WHEN** the id is `"9223372036854775807"`
- **THEN** it SHALL be rejected for any consumer that requires a number, and
  SHALL NOT be rounded to 9223372036854775808

#### Scenario: Negative id from the wire
- **WHEN** a server response carries a negative message id
- **THEN** it SHALL be rejected, because the negative band belongs to imported
  local history and a negative from the server corrupts the `MAX(id)` sync
  cursor contract (`lib/localDb.ts:537-540`)

#### Scenario: Zero id from the wire
- **WHEN** a server response carries message id `0`
- **THEN** it SHALL be rejected, because `0` is the optimistic outbox bubble and
  is never a persisted server row

#### Scenario: Absent id
- **WHEN** an id field is `null` or absent
- **THEN** it SHALL remain `null`, and SHALL NOT become `0`

#### Scenario: Downstream consumers still see a number
- **WHEN** an adapted row reaches `lib/syncEngine.ts:68`, `lib/localDb.ts:500`
  or `lib/games/invite.ts:60`
- **THEN** `typeof id === 'number'` SHALL hold, and the arithmetic sort at
  `lib/syncEngine.ts:110` SHALL NOT throw

### Requirement: The chat list is representation-independent

The chat list SHALL produce the same domain outcome under either
representation, and the caller SHALL NOT be able to observe which one was used
except through the declared negotiation.

`GET /chats` is the startup body that decides whether the app has anything to
show. Its caller (`lib/chatService.ts`) already has a cache-first path and an
offline path; a representation change may not alter either.

#### Scenario: Caller that has not opted in
- **WHEN** a caller does not request the typed representation
- **THEN** it SHALL receive the existing JSON body, byte-compatible with today's
  contract

#### Scenario: Caller that has opted in
- **WHEN** a caller requests the typed representation and the server supports it
- **THEN** it SHALL receive and decode the typed body, and the resulting chat
  list SHALL equal the list the JSON body produces for the same server state

#### Scenario: Empty, absent and zero are distinct
- **WHEN** a chat carries an absent field, an empty collection or an empty
  string, and a numeric field that is legitimately zero
- **THEN** each SHALL survive the round trip as itself, and an absent value
  SHALL NOT arrive as an empty one nor a zero as an absent one

#### Scenario: Cache-first startup
- **WHEN** a cached chat list exists at startup
- **THEN** it SHALL still be rendered before the network response, and the typed
  response SHALL replace it on the same schedule as the JSON response

#### Scenario: Offline
- **WHEN** the chat list request fails or the device is offline
- **THEN** behaviour SHALL be unchanged from today, with no additional retry
  introduced by the representation change

### Requirement: Delta sync never reports progress it did not make

Delta sync SHALL NOT advance its cursor, report completion, or acknowledge
delivery for any record it did not successfully decode and apply.

This is the highest-consequence path in the change. Its existing failure mode is
already documented in the code: one undecryptable message used to drop an entire
page, so nothing was stored, no ack was sent, the cursor never advanced, and the
same page failed again on every reconnect (`lib/syncEngine.ts`). A decode-level
version of the same bug is worse, because a silently dropped record looks like a
successful empty page.

#### Scenario: One malformed record in a page
- **WHEN** a record in a delta page fails to decode
- **THEN** the failure SHALL surface, and the record SHALL NOT be silently
  filtered out of the page

#### Scenario: Cursor and unprocessed data
- **WHEN** any record in a page was not applied
- **THEN** the sync cursor SHALL NOT advance past that record

#### Scenario: Completion reporting
- **WHEN** a page was not fully applied
- **THEN** sync SHALL NOT be reported as complete for that chat or account

#### Scenario: Delivery acknowledgement
- **WHEN** a record was not stored
- **THEN** no delivery acknowledgement SHALL be generated for it

#### Scenario: Failure does not loop
- **WHEN** a page fails to decode
- **THEN** retries SHALL be bounded and SHALL NOT be reattempted under a
  different parser, so a permanently malformed page cannot produce an unbounded
  retry or decode-fallback loop

#### Scenario: Non-contiguous ids
- **WHEN** a page's message ids contain gaps
- **THEN** the page SHALL be applied normally; ids are `BIGSERIAL` and are not
  required to be contiguous, and a gap SHALL NOT be treated as missing data

#### Scenario: Page cursor is opaque
- **WHEN** a paging cursor is carried in a response
- **THEN** it SHALL be treated as opaque, and SHALL NOT be parsed, compared or
  stored as a message id

#### Scenario: Account switch mid-response
- **WHEN** the signed-in account changes while a delta response is in flight
- **THEN** the in-flight work SHALL abort without writing into the replaced
  database, as the existing `tokenSubject(...) !== owner` guard already does

### Requirement: Only the chat kind changes on the join path

Subscription join SHALL use the typed body only for `kind = chat`, and the
`channel`, `call` and `run` kinds SHALL keep their existing app_event path
unchanged.

`design.md` §7 establishes why: typed `Subscribe` carries no `chatId`, and
`join_call` does work the typed path does not — it registers the uid in the
Redis call roster, emits `call_roster` to the caller, broadcasts
`call_peer_joined`, and emits `call_full` on a mesh-cap refusal. `run` is
excluded because its authz divergence is unresolved, not because it is known
unsafe.

#### Scenario: Chat join under negotiation
- **WHEN** a `kind = chat` join is made and the typed representation is
  negotiated
- **THEN** the typed body SHALL be used, and the resulting subscription registry
  entry, room key and gate SHALL match the app_event path

#### Scenario: Other kinds
- **WHEN** a `channel`, `call` or `run` join or leave is made
- **THEN** it SHALL continue to use the existing app_event body, under any
  negotiation outcome

#### Scenario: Call roster still works
- **WHEN** a user joins a call
- **THEN** the roster registration, the `call_roster` reply, the
  `call_peer_joined` broadcast and the `call_full` refusal SHALL all occur as
  they do today, and `call_peer_left` SHALL still fire on leave

#### Scenario: Reconnect
- **WHEN** the socket reconnects and subscriptions are re-established
- **THEN** each subscription SHALL be registered once, with no duplicate entry
  produced by the two paths coexisting

### Requirement: Which representation was used is observable in tests

A path intended to be typed SHALL be observable as typed at test time, and a
test SHALL fail when such a path silently falls back to JSON.

"It still works" is not evidence of migration: every path in this change has a
working JSON implementation behind it, so a negotiation bug is invisible to
functional tests.

#### Scenario: Silent JSON fallback on an intended typed path
- **WHEN** an integration test exercises a path that is intended to be typed and
  the exchange is JSON
- **THEN** the test SHALL fail

#### Scenario: Supported old server
- **WHEN** a server that does not support the typed representation answers JSON
- **THEN** the client SHALL accept it as the negotiated outcome, without a retry
  and without reporting an error

#### Scenario: Malformed typed body
- **WHEN** a body declared as the typed representation fails to decode
- **THEN** it SHALL be rejected as malformed, and SHALL NOT be re-parsed as
  legacy JSON

#### Scenario: Authentication failure
- **WHEN** a request fails authentication or authorization
- **THEN** it SHALL NOT be retried under a different representation

#### Scenario: Mutation whose response could not be decoded
- **WHEN** a request with side effects succeeds on the server but its response
  cannot be decoded
- **THEN** the request SHALL NOT be replayed, so no duplicate side effect is
  produced

### Requirement: Retained JSON on the startup path is declared

Every startup boundary that deliberately remains JSON SHALL be named with its
reason, and the outcome of this batch SHALL be described by that exact scope
rather than as the absence of JSON.

#### Scenario: Flags stays JSON
- **WHEN** the startup batch is summarised
- **THEN** `/app/flags` SHALL be listed as a retained JSON boundary with its
  reason, and the outcome SHALL be described as "Protobuf-first startup
  networking with documented JSON exceptions", never as JSON-free
