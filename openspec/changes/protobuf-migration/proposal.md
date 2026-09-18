# Typed binary Protobuf for first-party serialization boundaries

## Why

Every first-party structured boundary in this app is JSON today, including the
ones that already look like Protobuf. CC-Wire's frame envelope *is* protobuf,
but `AppEvent.payload_json` (field 2) carries UTF-8 JSON bytes, so every realtime
event is a JSON document inside a protobuf field inside a binary frame
(`lib/ccwire/eventsSocket.ts:63` encodes, `lib/ccwire/transport.ts:320` parses).
The result is a typed-looking transport with an untyped interior: no schema
governs what an event body contains, and a field-name typo is a runtime bug on
one side and silence on the other.

The goal is typed binary Protobuf for first-party runtime boundaries, so the
contract is checked by a schema rather than by convention.

## What is already built, versus what is new

**Already built — and better than expected:**

- A hand-written protobuf codec in TypeScript (`lib/ccwire/codec.ts`) and an
  independent one in Go (`vaultchat-backend-go/internal/ccwire/codec.go`), both
  live on the app path.
- Length-prefixed framing (`lib/ccwire/frame.ts`): u8 version + u32be length.
- Seven `.proto` files under `proto/ccwire/v1/`.
- Real capability negotiation by intersection, client↔server
  (`proto/ccwire/v1/capabilities.proto`, `ClientHello`/`ServerHello`).
- Cross-language parity fixtures (`lib/ccwire/__vectors__/adversarial.json`)
  and fuzz tests on both sides.
- Lazy background migration machinery that already solves paged durable
  cursors, restart resume, account-switch invalidation, locked-cache refusal
  and fail-open: `ensureFtsReadyLocked` (`lib/localDb.ts:318-397`).
- Lazy write-through format coexistence by prefix: `enc:v1:`
  (`lib/cacheCrypto.ts:18-19`) — the proven pattern for "both formats readable,
  new format written on next write, nothing bulk-rewritten".

**Corrected — money is NOT already integer-paise.** An earlier note in this
planning run said it was; that was wrong and is retracted here. The true
picture, verified at source, is three different representations:

- `utils/money.ts` computes *internally* in paise but its public surface is
  RUPEES as a 2-dp double (`tsFromPaise` returns `Math.round(paise)/100`;
  `Split.each` is documented "rupees"). There is no branded `Paise` type.
- Vault Finance persists money in **eleven `REAL` (IEEE-754) columns**
  (`db/financeDb.ts:52,53,58,69,70,90,91,117,129,130,131`).
- Shop Book has a real `type money int64` server-side over Postgres
  `NUMERIC(n,2)` (`shopbook_money.go:38,42,46`), but `money.Float()` is
  "for JSON output only" (`:52`) — the wire is decimal, deliberately, because
  the shipped client parses a number and changing it would break every build
  in the field. That round-trip is exact for ≤2dp inside 2^53, so the wire
  itself is defensible; arithmetic performed ON those floats is not.

Consequence for this change: money is a REPRESENTATION DECISION, not a
solved problem. Any monetary field in a new schema SHALL be an exact integer
in the minor unit. Migrating the existing float boundaries is explicitly out
of scope here — it is a separate correctness change with its own risk — but
this plan must not assume it was already done.

**New:**

- A code-generation pipeline. There is none today (verified: no protobuf
  runtime in `package.json`, no `google.golang.org/protobuf` in `go.mod`, no
  generate script, no `go:generate`). The `.proto` files are *documentation*;
  nothing enforces that the two hand-written codecs agree with them or with
  each other.
- Domain schemas for HTTP bodies, typed CC-Wire event variants, and
  application errors.
- A recipient-capability signal, which does not exist in any form today.

## Non-goals — Not building

- **Not** replacing CC-Wire, the framing, the connection lifecycle, the
  authentication gate, or the Rust carrier.
- **Not** touching the React Native bridge architecture, adding UniFFI, or
  changing how bytes cross into native.
- **Not** enabling or disabling QUIC/WebTransport.
- **Not** adding gRPC, Connect, a schema registry, or any RPC framework.
- **Not** creating a database, a schema migration, a broker, or any
  infrastructure. Existing tables and columns only.
- **Not** changing crypto algorithms, keys, nonces, or key lifecycle.
- **Not** migrating the legacy Express backend in `vaultchat-backend/`. It is
  not deployed — `docker-compose.prod.yml` ships `caddy` → `go-api` only — so
  the live HTTP surface is Go. Its frozen `contract/endpoints.json` describes
  the legacy app, not the live surface.
- **Not** ProtoJSON, JSON hidden inside `bytes`/`string` fields, or
  `map<string, string>` standing in for a designed schema.
- **Not** promising a cold-start improvement. See below.

## This does not fix cold start

Stated plainly because the opposite was assumed earlier in this work and had to
be retracted. The measured cold-start blockers are not serialization:

- `shouldCheckRestore()` opens SQLite on the critical path to the chat list on
  every cold start for any user who has never opened the restore screen
  (`app/index.tsx:46` → `lib/restoreGate.ts:49-58`; `markRestorePromptSeen` is
  only ever called from `app/restore-backup.tsx`).
- The CC-Wire readiness ladder is 18s / 15s / 15s
  (`lib/ccwire/eventsSocket.ts:144`, `lib/ccwire/transport.ts:78`,
  `lib/ccwire/client.ts:94`).

Protobuf may reduce bytes and parse cost. Whether that is visible at startup is
a measurement, not a premise, and it must be measured with the instrumentation
already added under `coldstart-evidence` rather than a second framework. First
frame, authorized cached-list readiness, authenticated CC-Wire readiness and
catch-up stay separate milestones.

## Compatibility strategy

Three independent compatibility problems, deliberately not conflated:

1. **Transport/HTTP representation** — negotiated. CC-Wire extends the existing
   `Capabilities` intersection; HTTP negotiates explicitly through `Accept` /
   `Content-Type` with `application/protobuf`. Old peers keep JSON. Nothing is
   guessed by trying parsers in sequence.

2. **Stored records** — coexistence, not rewrite. Follow `enc:v1:`: a format
   prefix, both readers retained, new format written on next write. Old-format
   readers can never be removed, because `messages` has no reaper and
   `importAll` can reintroduce old rows from any backup at any time.

3. **E2EE inner content** — blocked on a capability signal that does not exist.
   Confirmed at source that no signature, MAC, hash or AAD covers the inner
   serialization (`services/crypto/e2ee.ts:203` builds AAD as
   `utf8(hex(dh)|pn|n)`; `services/crypto/senderKey.ts:125-128` uses
   `u32(iteration)` as AAD and signs `concat(ad, ciphertext)`). So the
   *transcript* is not the obstacle. The obstacles are: no per-recipient-device
   capability data anywhere; groups emit one format for all members
   (`senderKey.ts:6-9`); and `services/crypto/messageStore.ts:50-59` frames
   cached plaintext as `<NUL>tag<NUL>plaintext`, which silently truncates any
   payload containing a NUL byte. Inner content is specified here and
   implemented only behind its own gate.

## Success

- One schema source of truth, with generated codecs in TS and Go, and a
  reproducible verification that regeneration is a no-op.
- The two hand-written codecs either replaced by generated ones or proven
  equivalent to them by shared fixtures — never left drifting.
- Migrated boundaries provably carrying typed protobuf, with a guard that fails
  when JSON is reintroduced, and the guard proven to fail on revert.
- Every remaining JSON site classified with a reason and either a permanent
  standard justification or a named retirement condition.
- No regression in authentication, authorization, rate limits, ordering,
  receipts, idempotency, or account isolation.
