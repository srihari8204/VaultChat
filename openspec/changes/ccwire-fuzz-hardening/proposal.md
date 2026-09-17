# CC-Wire fuzz hardening

## Why

CC-Wire is now the sole application realtime protocol — Socket.IO was removed
from the app, the Go backend and the admin console. Every realtime byte a phone
sends now reaches a parser that runs *before* authentication decisions are fully
applied, and that parser has **zero fuzz coverage**: `grep -rc 'func Fuzz'`
across the Go backend returns 0, and `services/transport/rust` has no `fuzz/`
directory.

The protocol already declares strict bounds (`Limits`: 13 fields covering frame
size, nesting depth, repeated elements, reassembly budget and lifetime). Those
bounds are exactly the kind of invariant that holds under hand-written tests and
fails on the one input nobody thought of. They are asserted today only by
example-based tests, never by adversarial input.

A second, narrower problem surfaced while measuring: **the Rust CC-Wire runtime
is not in any test gate.** `npm run test:rust` runs
`cargo test --manifest-path rust/vaultcore/Cargo.toml` — a crate containing only
`lib.rs` and `money.rs`. The transport crates — `services/transport/rust` (frame parsing, reassembly,
outbound scheduling) and `services/transport/rust-net` (WebTransport carrier) —
have **129 passing tests between them that no scripted gate ever ran**. Fuzz
targets added there would have been equally unguarded.

## What Changes

- Add Go fuzz targets against the existing `internal/ccwire` decode path
  (`codec.go`, `frame.go`, `typedbody.go`). Native `testing.F` — no framework.
- Add Rust fuzz coverage for `services/transport/rust` (`parse.rs`, `frame.rs`,
  `reasm.rs`) using the crate's existing test stack where it suffices.
- Wire `services/transport/rust` into `npm run test:rust` so the CC-Wire runtime
  is actually gated alongside `rust/vaultcore`.
- Add seed corpora covering the adversarial classes named in the brief:
  truncated frames, malformed varints, invalid enums, oversized length
  declarations, EPHEMERAL carrying a durable body, sequence extremes, malformed
  `depends_on`, repeated/nesting limit violations, reassembly budget violations,
  malformed capability/attachment/call bodies.
- Add regression corpus entries for any crash or hang fuzzing discovers.
- **Parser changes only if fuzzing demonstrates a concrete defect.** No parser
  rewrite, no new abstraction, no new dependency.

Not breaking: no wire format change, no capability change, no behaviour change
for any existing client.

## Capabilities

### New Capabilities
- `ccwire-protocol-safety`: adversarial-input guarantees for the CC-Wire frame
  parser and reassembler — what must never happen regardless of input bytes, and
  which test gate enforces it.

### Modified Capabilities
<!-- None. No existing spec in openspec/specs/ covers CC-Wire, and this change
     alters no application requirement: same wire format, same events, same
     limits. It adds adversarial verification of behaviour that is already
     specified in the protobuf comments and Limits message. -->

## Impact

- **Code**: new `*_fuzz_test.go` under `vaultchat-backend-go/internal/ccwire/`;
  new fuzz targets + corpus under `services/transport/rust`; one line of
  `package.json` `scripts.test:rust`.
- **Runtime**: none. Fuzz targets are test-only and ship in no binary.
- **Dependencies**: none added. Go fuzzing is stdlib (`testing.F`); Rust uses
  the crate's existing test stack.
- **Gates**: `npm run test:rust` begins covering a crate it silently skipped,
  so it may surface pre-existing failures there. Measured before changing
  anything: both transport crates pass and are clippy-clean at `-D warnings`,
  so the gate starts green. Gated test count rises 14 → 143.
- **Risk if not done**: a malformed frame from any authenticated — or
  pre-authentication — client is the highest-value crash surface in the system,
  and the only realtime protocol left has no adversarial coverage of it.
