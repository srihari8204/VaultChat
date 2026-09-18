# Design — protobuf-migration

Baseline: branch `hetzner-deploy`, HEAD `3093b42`, clean tree (0 dirty files).
Planning run only. No application source, schema, manifest, lockfile or test was
modified. Nothing installed, built, committed, tagged or pushed.

## 1. Verified findings

Every item below was traced to source in this run. Where an earlier claim was
wrong it is marked RETRACTED, with the correction.

### 1.1 There is no code generation, anywhere

Confirmed: the string `proto` does not appear in `package.json`;
`vaultchat-backend-go/go.mod` has no `google.golang.org/protobuf`; zero
`go:generate` directives; no `buf.yaml`, `Makefile`, `*.pb.go` or `*_pb.ts`; and
the `option go_package` in every `.proto` points at a package that does not
exist. The seven `.proto` files are documentation.

There are **four independent hand-written protobuf readers on the live path**,
with different strictness:

| Reader | Scope | Strictness |
|---|---|---|
| `lib/ccwire/codec.ts` | typed bodies | bounded, unknown-preserving, **fatal** UTF-8 |
| `lib/ccwire/client.ts:196-243` `scanFields` | ClientHello/ServerHello/Ping | **non-fatal** UTF-8 (`:260`) — substitutes U+FFFD |
| `vaultchat-backend-go/internal/ccwire/codec.go` | typed bodies | validates UTF-8 (`bodies.go:29`); **masks** the 10th varint byte (`codec.go:252-254`) |
| `internal/realtime` `pbr` (`ccwire_cursor.go:110-190`) | live handshake, cursor, app-event | does **not** validate UTF-8; **refuses** the 10th varint byte (`:121`) |

The same bytes therefore get different verdicts depending on which door they
enter. This is a pre-existing correctness hazard that a generator removes as a
side effect, and it is the strongest argument for doing Wave 1 even if nothing
else in this plan ships.

### 1.2 The highest-traffic body is typed on one side only

Verified at source: `AppEvent.event` (body 100, field 1) is bounded by
`max_string_field_bytes` = **4096** in TypeScript (`codec.ts:502` via
`readString`), and by a hard-coded **64** in Go
(`internal/realtime/ccwire_app_events.go:157-158`). TS refuses invalid UTF-8 and
drops the whole frame; Go accepts it.

So an event name of 65–4096 bytes is accepted by the client and refused
`PAYLOAD_INVALID` by the server. The repo knows about the asymmetry — it is
pinned as `bodiesTypedByTypescriptOnly:[100]` in
`lib/ccwire/__vectors__/codec.json` — but it records the *fact*, not the
*shape*, and no vector exercises the divergence.

### 1.3 The typed CC-Wire surface is mostly dead, and the live surface is JSON

Bodies actually sent by the client: 16 `client_hello`, 19 `ping`, 20 `pong`,
48 `submit_message` (one call site, `transport.ts:196`), 100 `app_event`,
112 `fragment`. The Go server also serves 32, 33, 50, 51, 52, 64, 81, 82, 84 —
**typed messaging, receipts, typing, viewer and cursor bodies the client never
sends**, because it routes all of them through `app_event` (100) as legacy
string-named JSON instead (`eventsSocket.ts:10-13`).

This reframes the whole project. The migration is not "add protobuf to a JSON
transport" — the typed protobuf surface **already exists on both sides and is
bypassed**. Wave 3/4 is largely about moving client traffic off body 100 onto
bodies that are already defined, already implemented in Go, and already
covered by parity vectors.

### 1.4 D2's premise, inverted

There is **no** reusable application operation. `internal/` contains no
`service/`, `domain/` or `app/` package; `chatsMessagePost`
(`internal/routes/chats_helpers.go:429-891`) is ~460 lines of inline handler.
The CC-Wire loopback (`ccwire_messages.go:88` marshal, `:106-112` serve,
`:115` unmarshal) exists so the second transport inherits eleven gates: JWT
actor binding, membership, block check, two rate-limit buckets, slow mode,
announcement permission, audience, per-type validation, 2 MB body cap, the RLS
transaction, and `ON CONFLICT` idempotency.

Three of those gates (rate limit `:436`, block check `:460`, body cap
`httpx.go:94`) sit *outside* the natural extraction seam. A naive extraction
moves them from "inherited unavoidably" to "each caller must remember" — a
security regression. Any extraction must pull them inside the seam.

Independent defect found on the way: **CC-Wire sends produce no HTTP metrics at
all**, because `metrics.Wrap` is applied only to the public mux
(`cmd/api/main.go:447`) while the loopback serves the private `cw` mux
directly. Cheap to fix, unrelated to protobuf, worth doing separately.

### 1.5 D3's presumed blocker, disproved — and replaced

RETRACTED: the earlier plan said an E2EE content migration was gated on an
authenticated-transcript audit. Verified at source that **no signature, MAC,
hash or AAD covers the inner serialization**: `e2ee.ts:203` builds AAD as
`utf8(\`${hex(dh)}|${pn}|${n}\`)`; `senderKey.ts:125-128` uses `u32(iteration)`
as AAD and signs `concat(ad, ciphertext)`. Changing inner content serialization
breaks no transcript.

Four different blockers replace it:

1. **No recipient-device capability signal exists.** Key bundles return
   `{identityKey, signedPreKey, oneTimePreKey, remainingOtpk}`
   (`internal/routes/user.go:2370-2446`); SKDMs carry
   `{chainKeyHex, iteration, signPubHex}` (`senderKey.ts:79-83`); CC-Wire
   `Capabilities` is client↔server and `envelope.proto:274-277` explicitly
   disclaims knowing about the content wrapper. `vc1`/`dr1`/`GSK1:`/`vbm2` are
   sender self-descriptions and prove nothing about the reader.
2. **Groups emit exactly one format for all members** (`senderKey.ts:6-9`), so
   one stale device pins the whole group.
3. **NUL framing.** `services/crypto/messageStore.ts:50-59` frames cached
   plaintext as `<NUL>tag<NUL>plaintext` and decodes by finding the second NUL.
   Any binary payload containing `0x00` is silently truncated.
4. **Both session layers are `string`-typed** (`e2eeSession.ts:508/614`,
   `senderKey.ts:126/180`) and round-trip through `TextDecoder`, which is lossy
   on non-UTF-8. The ratchet core beneath is already binary-clean.

Failure mode if this is got wrong: a permanently unreadable message, no retry,
no feedback (`lib/chatService.ts:373`).

### 1.6 Money — RETRACTED

An earlier note in this run said money was already integer paise and therefore
`int64`-safe. That was wrong. See `proposal.md` for the corrected three-way
picture. For this change: new schemas use exact minor-unit integers; migrating
the existing float boundaries is out of scope and must not be assumed done.

Two genuine defects surfaced and are recorded for a separate change, not this
one: `shopbook.go:1320-1335` accumulates `purchase`/`paid` in `float64` and
emits them unrounded, and `shopbook_jobs.go:190,204-205` scans `float64` money
and formats with `%.0f` — both contradicting `shopbook_money.go:5-10`'s own
stated invariant.

A second, independent money audit corroborated the above and added two findings
that DO bear on schema design:

**Currency scale is hard-coded to two decimals for every currency.** Shop Book
is multi-currency (`069_shopbook_upgrade.sql:124-145` seeds IN/₹/INR,
US/$/USD, GB/£/GBP, AU/A$/AUD) but the scale is not: `shopbook_money.go` uses
`*100` / `/100` / `/10000` throughout (`:42,46,52,76,80`) and every Postgres
money column is `NUMERIC(n,2)`. There is no support for three-minor-unit
currencies (BHD, KWD, JOD, TND) or zero-decimal ones (JPY, KRW, VND).

Verified consequence: `sbRoundOff` (`shopbook_money.go:449-458`) computes
`total % 100` and rounds up at `>= 50` — the Indian round-to-the-rupee rule —
and is gated on `round_off_enabled` alone, **not on country**. A USD shop with
that flag set gets Indian rounding.

This matters for the schema because "exact integer in the minor unit" is not
well-defined without the currency's scale. Any monetary field SHALL therefore
carry, or be reachable from, its currency and scale — not just an integer.

**There is a SECOND native bridge, and money crosses it as JSON.**
`utils/native/MoneyCore.ts:52-53` sends `JSON.stringify({totalRupees, parts})`
through `react-native-nitro-modules` (a JSI HybridObject) and `JSON.parse`s the
reply — decimal rupees, and the probe at `:57` float-compares `s.each !== 142.85`.
So the transport base64 bridge (§1.8) is not the only native boundary: crypto
and money use Nitro/JSI. Both are in the serialization inventory; neither is to
be replaced by this change.

### 1.7 Identifiers — two inconsistent disciplines

CC-Wire is string/BigInt-exact end to end: the ack `message_id` is validated by
regex and never parsed (`transport.ts:190-191`), and arithmetic uses `BigInt`
(`:207`). The REST + SQLite + UI path coerces to a JS number by design
(`lib/msgIds.ts:28-33`), documented and bounded at 2^53. They meet at
`transport.ts:207-209`, which is why that line has to `String()` the REST row
back before comparing.

One inconsistency LOOKS like a real bug and is not.
`PeerLastReadMessageID` / `PeerLastDeliveredMessageID`
(`internal/routes/chats.go:1216-1217`) are `*int64` emitted as JSON **numbers**,
beside two sibling id fields emitted as **strings**. This paragraph previously
called it a bug and booked a "separate one-line change"; that was **retracted on
2026-09-19**. Both the JSON and the protobuf representation converge to
`number | null` at `lib/ccwire/startupAdapter.ts:142-143` via `wireId()`
(`lib/msgIds.ts:59-63`) before any consumer sees them, and the `*int64` shape is
pinned on purpose by `lib/chatsCacheRollback.selftest.ts:63-66`. The proposed
`,string` fix would have broken that test and created the divergence it claimed
to remove. The three-representations-in-one-object asymmetry is still real and
still deferred — but it lives on `lastMessageId` / `myLastReadId`, which the
adapter passes through as strings (`startupAdapter.ts:112-132,139-140`), not on
these two.

### 1.8 The bridge, and what it means for measurement

The Rust carrier decodes nothing — `carrier.rs:119` sends
`Message::Binary(bytes)` verbatim and `:125` emits received bytes verbatim; the
crate documents the prohibition at `rust-net/src/lib.rs:28-35`. All protobuf
coding is in TypeScript. Bytes cross the bridge as **base64 strings** over the
legacy RN bridge (`nativeSocket.ts:79` out, `TransportCoreModule.kt:59-62` in),
not JSI, not Nitro, not ArrayBuffer.

Crucially for §11 of the work order: base64 expansion applies to the **entire
framed protobuf**, whatever the body encoding is. It is a property of the
carrier, not of the payload, so it does **not** by itself make protobuf's byte
saving smaller in percentage terms. This path is also Android-only and optional
(`nativeSocket.ts:105`); on every other path `client.ts:877` hands the platform
WebSocket a `Uint8Array` with no base64 step.

`services/transport/rust/src/metrics.rs` is entirely unreferenced;
`rust-net/src/client.rs` and `body.rs` are reachable only from a binary the
Gradle `--lib` build does not produce. Do not wire the migration to any of it.

### 1.9 Cold path is safe for a generated codec

`metro.config.js:85` sets `inlineRequires: true`. `lib/socket.ts` has no
module-scope `ccwire` import; every ccwire module is reached through dynamic
`import()` inside `connectCCWire()` (`lib/socket.ts:144-149`). So a generated
codec placed in `lib/ccwire/` costs nothing at boot.

It would **not** be safe in, or transitively required at module scope by, the
five side-effect imports at `app/_layout.tsx:26,63,68,69,72` or the ten
module-scope initializers there. `lib/remoteFlags.ts` and `lib/usageCounter.ts`
are the most exposed, being called at module scope and doing network work.

### 1.9b The one message with the strongest guard cannot follow protobuf
### discipline

`scripts/acceptance.selftest.ts:210-212` asserts that `PublicMeta`'s field
numbers are "1..n with no gap and no reuse". Protobuf's own deprecation
discipline requires a removed field number to be `reserved` — which creates
exactly the gap that assertion forbids. So the single message with the
tightest cross-language guard is structurally unable to retire a field
correctly. Resolve before any `PublicMeta` field is ever removed; it is not
urgent, but it is a trap that will fire at the worst moment.

### 1.10 Scale, corrected

| Measure | Value |
|---|---|
| Unique Go routes (method+path) | **419** (11 domains; ShopBook 96, chats 67, user 60, spaces 60) |
| Unique client HTTP contracts via `api()` | **331** |
| Routes with a request body | ~182 |
| Routes returning a body | ~394 (bodyless ≈ 0 — `httpx.JSON`/`httpx.Err` always write) |
| Client `api()` call sites | 364 |
| Non-test TS JSON sites | 433 — but only **15** are network-boundary |
| Go JSON sites in `internal/` (non-test) | 86 — **11** network-boundary |

The "16 endpoint-contract domains" figure in the work order came from
`vaultchat-backend/contract/endpoints.json`, the **legacy Express** backend's
frozen contract, validated against Node source by `scripts/test-all.js:165`.
Production ships `caddy` → `go-api` only (`docker-compose.prod.yml`), so it does
not describe the live surface.

The TS census result is the good news and it should steer sequencing: there is
exactly **one** network-boundary `JSON.stringify` (`lib/api.ts:246`) and **one**
network-boundary `JSON.parse` (`:553`) for all 331 contracts. The client HTTP
migration is one funnel plus six documented bypasses, not 364 edits.

## 2. Decisions

### D1 — Toolchain

**TypeScript runtime: `@bufbuild/protobuf`, already shipped.** It resolves today
at `node_modules/@bufbuild/protobuf@1.10.1`, pulled by `@livekit/protocol@^1.10.0`
via `livekit-client@2.19.2` / `@livekit/react-native@^2.12.0` — runtime
dependencies, genuinely imported (`lib/call/room.ts:25`). Choosing it adds
**zero shipped bytes**. It must be declared as a direct dependency pinned to
`1.10.1` rather than relied on transitively, and generated code must target the
**v1** API (`@bufbuild/protoc-gen-es@^1.x`), since v2 is a different API and
would either duplicate the runtime or break LiveKit.

Risk, recorded: this couples us to LiveKit's protobuf major. If LiveKit moves to
v2, both move together. The alternative — a second runtime — is worse.

`protobufjs` was already evaluated and rejected in this repo for stated reasons
(`lib/ccwire/codec.ts:15-38`): it drops unknown fields, needs `new Function`
which Hermes lacks, and costs ~250 KB. Those reasons still hold; unknown-field
preservation in particular is load-bearing (`envelope.proto:105` reserves 6-15
and both codecs re-emit unknowns verbatim).

**Go: `google.golang.org/protobuf` + `protoc-gen-go`** — a genuine addition; the
module cache has none. Pin exact versions in `go.mod`.

**Generator: `buf` as a dev-only npm dependency**, because `protoc` is not on
PATH and a CLI that installs with the repo is reproducible where a system
install is not. Dev-only in both languages; nothing new ships except what is
already shipped.

**Unresolved and deliberately not guessed:** whether `@bufbuild/protoc-gen-es`
v1 output runs unmodified under Hermes with `inlineRequires`. That is a
build-and-run check, and no build is authorized in this run. Wave 1 task 1
resolves it before anything depends on it.

### D2 — The Go loopback

**Keep the loopback for now; do not extract in this change.**

Rationale: extraction's benefit is removing one marshal/unmarshal round trip
that crosses no network. Its cost is moving three security gates out of the
inherited set, in a 460-line handler with **no test against the real handler at
all** (every CC-Wire test uses `fakeRoutes`; the DB-backed REST tests are opt-in
behind `CALL_TEST_DB=1`). The correct order is: characterization tests first,
extraction second, and only if the seam can be drawn to include the rate limit,
block check and body cap.

This is tracked as transition debt with an explicit retirement condition
(Wave 2 exit criteria), not waved through. Recorded per §8 of the work order:
boundary `ccwire_messages.go:88/:115`, owner = Go operation owner, reason =
gate inheritance, retirement = characterization suite green + seam includes the
three outer gates.

### D3 — E2EE content

**Specify now, implement behind a gate.** The transcript is not the obstacle
(1.5). The capability signal is, and it does not exist. Sequenced to Wave 6,
entry-gated on: a per-recipient-device capability signal existing and tested;
group intersection over all member devices; NUL-safe plaintext-cache framing;
binary-clean session-layer APIs. Until all four hold, senders emit the existing
format. This blocks only inner content — not HTTP, not CC-Wire event bodies,
not schema work.

### D4 — Working tree

**Resolved.** HEAD `3093b42`, 0 dirty files, `hetzner-deploy` in sync with
origin. The ~312-file hazard the work order describes no longer exists.

Preservation procedure for implementation batches, since a tag or branch from
HEAD is not a snapshot of uncommitted work: before editing, copy each owned
file to a per-batch local directory outside the repo with its SHA-256 recorded;
verify the hash still matches immediately before writing; on conflict,
reconcile rather than overwrite. Keep those copies local and unshared. Nothing
sensitive goes into OpenSpec artifacts.

## 3. Ownership

Planning (this run) used four independent read-only auditors: schema/codec, Go
operation/middleware, client/bridge/ID-money, and E2EE/storage. The lead
integrated and owns every file under `openspec/changes/protobuf-migration/`.

For implementation, single-owner files — no concurrent edits, ever:

| File / area | Owner |
|---|---|
| `proto/**`, generator config, generated output | Schema owner |
| `lib/ccwire/codec.ts`, `frame.ts`, `client.ts` | Schema owner |
| `internal/ccwire/**`, `ccwire_messages.go` | Go operation owner |
| `lib/api.ts` and HTTP adapters | Client owner |
| `package.json`, `go.mod`, lockfiles | Lead only |

Domain workers start only after the schema and the generation command are
stable, and are partitioned by domain with no shared files.

## 4. Ponytail review of this plan

No Ponytail plugin or skill is installed (`~/.claude/skills/` holds only the
five `openspec-*` skills; `installed_plugins.json` lists `frontend-design`,
`code-review`, `figma`). Ponytail is active as a session-level mode. AGENTS.md
covers this case explicitly, so its principles are applied and recorded here
rather than claimed as plugin execution.

**Avoided:** a new protobuf runtime (one is already shipped); a second timing
framework (extend `lib/perf.ts`); a new migration mechanism (reuse
`ensureFtsReadyLocked`); a new format-coexistence scheme (reuse the `enc:v1:`
prefix pattern); gRPC/Connect/schema registry; extracting the Go operation
before it has tests; a documentation framework beyond the four standard files.

**Reused:** `@bufbuild/protobuf`, the existing `Capabilities` intersection, the
existing `__vectors__` cross-language fixtures, the existing typed Go bodies
that the client bypasses, `lib/api.ts` as the single HTTP funnel, and the
repo's source-scanning selftest pattern for guards.

**Complexity kept deliberately:** the loopback's eleven gates; unknown-field
preservation; the fatal-UTF-8 strictness in `codec.ts`; both readers retained
forever for stored records; per-boundary rather than directory-wide guard
exemptions.

**Rejected:** "migrate all 419 routes" as a single unit — it is not a unit.
"Extract the Go operation now" — no tests. "Use protobufjs" — already evaluated
and rejected here for reasons that still hold.

## 5. Wave 1 outcome — a decision the plan did not anticipate

Wave 1 was executed. The reconciliation it called for (task 1.5/1.6) produced a
result that changes how the generated code may be used.

**The generated codec is a CONFORMANCE REFERENCE, not a replacement for
`lib/ccwire/codec.ts`.** Proven, not assumed:

Running the existing `__vectors__/codec.json` fixtures through both codecs,
semantics agree on 15 of 18 accepted body vectors and all six typed bodies —
including `crypto_control epoch = u64 max`, `geo_relay until_ms = -1`, and a
two-deep nested `submit_message` distinguishing absent from defaulted. Thirteen
frame byte strings round-trip byte-identically, `seq = 2^53+1` included.

Three divergences remain, all with one root cause: **the generated codec
enforces the .proto and nothing else, while `codec.ts` also enforces the
negotiated CC-Wire profile.**

1. **Invalid UTF-8 in a string field is accepted** by `@bufbuild/protobuf` v1
   (decoded lossily to U+FFFD); `codec.ts` answers `INVALID_UTF8`. proto3
   requires valid UTF-8, so this is the generated reader being more permissive
   than the spec it implements — precisely the parser differential
   `codec.ts:358-364` exists to prevent.
2. **An over-long length varint is accepted**; `codec.ts` answers
   `VARINT_OVERFLOW`.
3. **`Frame.fromBinary` cannot carry an opaque body.** This is the
   architectural one. `codec.ts` knows 28 oneof arms, decodes 7, and keeps every
   other body as opaque bytes with unknown fields preserved — which is what
   lets a client relay a frame whose body it does not implement, and what makes
   `reserved 6 to 15` in `envelope.proto` survive a round trip. A generated
   oneof has no equivalent: it MUST parse the body, so a frame carrying a body
   this build does not implement is rejected outright.

Consequence, and it is a real constraint on Waves 3–4: **the generated `Frame`
must never front the transport.** Body-level message types remain valid
references and may be used for conformance and for typed payload work. Any
future attempt to "just swap in the generated codec" would silently drop
forward-compatibility for unknown bodies and break relay behaviour.

This also settles the earlier open question about reusing the hand-written
codecs: they stay, and now for a demonstrated reason rather than caution.

**Not resolvable from the fixtures:** the recorded `max_message_body_bytes`
32-bit-mask divergence. `codec.ts` never decodes a `Limits` message off the
wire — `LIMITS` is a constant table — so no fixture exercises it. Confirming it
needs a `Limits` vector, which task 1.7 adds.

**Coverage gap now measured rather than estimated:** 22 of 28 oneof arms have no
fixture at all, including `Ack`, `ClientHello`, `ServerHello`, `Limits`,
`Capabilities` and `AppEvent`. `Ack` is live traffic.

## 6. The capability bit — added, and HALF-WIRED on purpose to be honest about it

`Capabilities.typed_app_bodies = 9` was added
(`proto/ccwire/v1/capabilities.proto`), regenerated in both languages, and
means: "this peer ACCEPTS typed app-domain bodies inbound". It is NOT
`app_events_v1` inverted — a peer may set both, and `app_event` stays the
fallback until typed coverage is complete.

Wired so far:

| Direction | State |
|---|---|
| Server advertises 9 → client reads it → client gates typed EMIT | **wired** |
| Client advertises 9 → server reads it → server gates typed SEND | **NOT wired** |

The second row is the finding. Go has no hand-written reader for a client's
field 9: the `pbr` capability readers each model exactly one bit —
`helloAppEvents` (`ccwire_app_events.go:27`) reads fields 1 and 8,
`helloWantsResumption` (`ccwire_resume.go:724`) reads field 2. The generated
Go codec knows `TypedAppBodies`; the hand-written handshake path does not.
Verified: nothing under `internal/` outside `gen/` references it except the
advertise line and its test.

**Why this is safe TODAY:** the client sets `requireAppEvents: true`
(`eventsSocket.ts`), so every session it opens negotiates `app_events_v1`, and
the server sends typing as `app_event` to such sessions. The server never
emits a typed body to this client, so an unread client bit costs nothing now.

**Why it must not stay this way:** the moment anyone makes the server emit
typed bodies to app-events sessions, it would be sending them WITHOUT checking
whether the client decodes them — which is exactly the guess the spec forbids,
and the failure is silent (an old client drops the frame). That change is
therefore gated on adding a hand-written reader for inbound field 9 first.

The server advertising unconditionally is correct and was checked, not assumed:
`serveBody` (`ccwire_messages.go:865-896`) has no flag on 48/50/51/52/64/81/
82/84, and 32/33 route through `handle` → `s.scope` equally ungated. Only 100
`app_event` is gated (by `CCWIRE_APP_EVENTS`), which is precisely why field 8
stays conditional and field 9 does not.

## 7. Wave 4.1 — scope corrected, and subscribe REFUSED on evidence

### The task list overstated the scope

4.1 listed bodies 32, 33, 50, 51, 52, 64, 81, 82, 84. Four are a NO-OP for the
client, verified by looking at what it actually emits:

| Body | Reality |
|---|---|
| 50 edit_message, 51 delete_message | sent over HTTP, never as app_event |
| 52 receipt | `markReadDurable` -> HTTP |
| 64 cursor_sync | never emitted by the client |

The client's ENTIRE app_event emit surface is: typing_start/typing_stop (done,
body 81), join_chat/leave_chat + call/channel/run variants, chat_view, and the
vaultbeam_* relay events.

**vaultbeam_* has no typed body at all.** It stays app_event permanently unless
someone designs a schema for it. "Zero JSON on the realtime path" is therefore
not reachable by migration alone — it needs new schema work, and that should be
a decision rather than a surprise at the end of Wave 7.

### Subscribe/Unsubscribe (32/33): NOT MIGRATED, deliberately

`SUBSCRIPTION_KINDS` (`eventsSocket.ts:10-13`) routes eight event names through
ONE path covering four kinds. chat and channel are equivalent between the two
transports — same registry (`s.subs`), same room key, same gate. Two are not:

**kind=call — would break calls outright.** The app_event `join_call`
(`handlers.go:772-841`) additionally registers the uid in the Redis call roster
(`clusterCallJoin`), emits `call_roster` back to the caller with the existing
peers, broadcasts `call_peer_joined`, and emits `call_full` on a mesh-cap
refusal. Typed Subscribe does none of these and answers only an `Ack`
(`ccwire.go:914-926`). A client would join a call and never dial anybody,
existing participants would never learn of the joiner, and "call is full" would
become silence. `leave_call` likewise skips `call_peer_left` and
`clusterCallLeave`, leaving ghost peers for `callTTL`.

**kind=run — the two paths check different things, and the wire type cannot
express the difference.** `Subscribe` is `{ScopeKind kind = 1; string id = 2;}`
(`envelope.proto:267`) — there is no `chatId` field. app_event `run_subscribe`
(`handlers.go:404-416`) requires `chatMemberAllowed(chatID)` AND
`runAllowed(runID)`; typed `subscribeAllowed` (`ccwire.go:793`) can only check
`runAllowed`.

CORRECTION TO THE INVESTIGATION THAT FOUND THIS: it reported the difference as
"migrating drops the chat-membership half of the gate", implying a privilege
escalation. That conclusion is NOT established. `vc_run_visible`
(`086_runs.sql:191-206`) is itself chat-scoped — every one of its three
branches derives from the run's own `r.chat_id` (`driver_id = me`,
`vc_space_ops_viewer(r.chat_id)`, or a rider via
`space_can_view_roster(r.chat_id, …)`). The typed path therefore re-derives the
chat SERVER-SIDE from the run row instead of trusting a client-supplied
`chatId`, which is arguably the stronger source.

What remains genuinely unresolved: whether run visibility can ever exceed
membership of the chat the client names — that depends on
`vc_space_ops_viewer` and `space_can_view_roster`, which were not read. So the
divergence is real, the security impact is UNPROVEN in either direction, and it
needs a reviewer who owns the runs authz model. Not a migration decision.

**Outcome:** no migration, no files edited. A chat+channel-only subset would be
safe on this evidence, but it was not taken: `codec.ts` has no
`TYPED_BODY_WRITER` for 32/33 (`codec.ts:805-813`), so the body would have to
be hand-rolled as raw bytes — trading a hand-written JSON path for a
hand-written protobuf path, for a handful of frames at connect time. That is
not worth the risk to the path that decides whether a chat receives messages.

## 8a. RETRACTION — §8 below aimed at a field type the schema does not use

§8 argued that choosing `int64` for message ids would decode as `bigint`,
fail the `typeof id === 'number'` guards, and silently break catch-up. The
premise is false and the section is retracted as written.

**`message_id` and `chat_id` are proto `string`, not `int64`** —
`envelope.proto:139-140`, `:247`, `:297-298`; `delivery.proto:7,27`. They are
length-delimited and always have been. There is NO bigint anywhere on the id
path. The only bigint the generated tree can produce is
`AppVersionGate.minBuild/adviseBuild` (the two 64-bit fields without
`[jstype = JS_STRING]`), and both are already narrowed at their call site.

So the adapter problem is **decimal-string -> number**, not int64 -> number.
The consumer hazards in §8's table are real and still apply — a STRING fails
`typeof id === 'number'` exactly as a bigint would — but the cause is different
and so is the fix. Read §8 for the consumer list, not for the diagnosis.

### What is actually true, and load-bearing

**Three disjoint id bands** (`localDb.ts:528-558`):

| Band | Meaning | Writer |
|---|---|---|
| `id > 0` | real server row | Postgres `BIGSERIAL` |
| `id === 0` | optimistic outbox bubble, never persisted | `app/chat.tsx` |
| `id < 0` | Exit-Kit imported local history | `importMessages()`, the ONLY writer |

Nothing negative comes from the wire; nothing negative may be sent to it. A
negative from the server corrupts the global sync cursor's `MAX(id)` contract
(`localDb.ts:537-540`).

**One site hard-crashes rather than degrading:** `syncEngine.ts:110` does
`b.id - a.id` with no guard — a bigint there is `TypeError: Cannot mix BigInt
and other types`, mid-sync, inside a `try/finally` with no catch. Every other
consumer fails SILENTLY (dropped row, stalled cursor, uncached history).

**The adapter may not hand-roll its coercion.** `msgIds.selftest.ts:78` fails
the build on any `.id = Number(` without a `msgid-exempt:` marker. Route
through `normalizeMsgIds`, which also preserves `null` — `Number(null) === 0`
would point every message at message 0.

**Precedent to copy, already in-tree:** `transport.ts:190-192` validates an ack
id with `/^[1-9][0-9]*$/` and never converts to a double.

**Do NOT narrow** `seq`, `depends_on`, `causal_epoch`, `server_ts_ms`. Those
genuinely are JS_STRING, for a documented reason, and narrowing them
reintroduces the replay-window bug.

**And `jstype` does not change the wire.** Verified in the runtime, not
inferred: `binary-format.js:383-386` passes only `field.T` to
`scalarTypeInfo`, which defaults INT64/UINT64 to Varint; `L: 1` is a
post-decode `.toString()`. A JS_STRING int64 and a plain int64 are
byte-identical on the wire.

## 8. The id-width trap — as originally written (see the retraction above)

Choosing `int64` for a message id is the "correct" protobuf answer and it is
the one that breaks messaging SILENTLY.

`@bufbuild/protobuf` v1 decodes an `int64` WITHOUT `[jstype = JS_STRING]` as a
JavaScript `bigint`. This codebase filters message ids on their runtime type in
at least four places:

| Site | What it does |
|---|---|
| `lib/syncEngine.ts:68` | `.filter(id => typeof id === 'number' && id > 0)` — **the delta-sync cursor** |
| `lib/localDb.ts:500` | `typeof m.id === 'number' && m.id > a` — the max-id computation |
| `lib/games/invite.ts:60` | `typeof msg.id === 'number'` |
| `lib/msgIds.ts:19` | documents the pattern in its own header |

A `bigint` passes none of those. Every message would be filtered out, catch-up
would stop advancing, and `tsc` would report nothing — `bigint` and `number`
are both assignable to the `any` these flow through. That is a silent,
whole-app messaging failure produced by picking the textbook-correct field type.

Two further constraints on the same decision:
- `lib/msgIds.ts:28-33` deliberately coerces `Number(x.id)` because the device
  is number-keyed; the ceiling at 2^53 is documented and intentional.
- `openspec/config.yaml`: local-only rows use **NEGATIVE** ids, so the sign is
  load-bearing and an unsigned type is wrong.

**Consequence:** message ids must be `int64 [jstype = JS_STRING]` (decoding to a
string, as `Limits.max_message_body_bytes` already does and as CC-Wire already
does for `message_id`), or the four type guards must all change first. This is
a decision, not an implementation detail, and it blocks every message-carrying
contract.

### Other decisions the inventory surfaced that need a human

- **Money** blocks 65 ShopBook contracts. No option represents BHD/KWD/JOD/TND
  (3 minor digits) or JPY/KRW/VND (0) while the scale stays hard-coded at 2.
- **Timestamps**: three live conventions in one backend — ISO via
  `httpx.JSTime`, epoch-ms `int64`, and epoch-ms as a *string* (`calls.go:177`).
- **Error envelope**: two live shapes. Unifying them changes behaviour at every
  `catch` that reads `e.body`, invisibly to `tsc`. This one blocks the FIRST
  batch, not a later one.
- **Free-form JSON** (message `meta`, merged from two jsonb columns): `Struct`
  costs more bytes than the JSON it replaces, and `bytes` reproduces exactly the
  `payload_json` outcome this project exists to escape.

~~**`GET /chats` must not be migrated before the `PeerLast*` fix**~~ —
**retracted 2026-09-19.** There is no `PeerLast*` fix to wait for; see §1.7.
`chats.go:1216-1217` does emit int64 as a JSON number while sibling ids are
strings, but `startupAdapter.ts:142-143` normalizes both paths to
`number | null` and `chatsCacheRollback.selftest.ts:63-66` pins that shape
deliberately. `GET /chats` is gated by batch 8 (cold start) like the other six,
and by nothing else.

### A note on line numbers in this document

`internal/routes/chats.go` shifted by ~23 lines DURING this session while an
agent added metrics instrumentation. References here were re-resolved on
2026-09-18. Method+path and handler file are stable; line numbers are not.
Treat them as a starting point, not an address.

## 9. Two Batch C hazards found while designing the /chats schema

### 9.1 The client type already disagrees with the wire

`ChatSummary.lastMessageId` is declared `number | null` (`lib/chatService.ts:30`)
but the server emits a JSON **string**: `LastMessageID *string`
(`chats.go:1120`), produced by `userBigStr` -> `strconv.FormatInt`
(`user.go:179-185`).

So the declared type is wrong TODAY, and it only works because the one consumer
does a relational compare — `mine >= (r.lastMessageId ?? Infinity)`
(`unreadStore.ts:69`) — and JS coerces `"123"` numerically.

This is not a typed-path problem to solve; it is a pre-existing mismatch the
typed path would EXPOSE, because protobuf would deliver what the type claims.
The two representations would then legitimately differ on this field.

**Decision required before Batch C ships:** make the typed path deliver the
declared `number`, and normalise the legacy JSON path to match — or keep the
typed path bug-compatible with the string. The first is correct and is a
behaviour change on the legacy path; the second preserves today's behaviour and
bakes the mismatch into a schema. Do not let an implementer pick silently.

### 9.2 The cache persists whatever shape memory held — a ROLLBACK hazard

`cacheChats` stores the whole row verbatim:
`encField(JSON.stringify(c))` (`lib/localDb.ts:1213`).

So an opted-in device caches ids in the typed path's shape and a non-opted-in
device caches them in the JSON path's shape. A device that flips the opt-in —
or **rolls back**, which is the case that matters — reads back the other shape
from its own cache.

Consequence for the batch: normalisation must sit on the **cache-read** path,
not only the network path. A network-only adapter leaves the rollback case
broken, and rollback is exactly when nobody is watching.

Ponytail note: the fix is one normalisation boundary that both the network
decode and `getCachedChats` pass through — not two adapters that must agree.
