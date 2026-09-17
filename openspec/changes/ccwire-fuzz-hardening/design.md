# Design — CC-Wire fuzz hardening

## Context

CC-Wire decoding lives in three places, measured from the repository:

| Where | Files | Role |
|---|---|---|
| `vaultchat-backend-go/internal/ccwire/` | `codec.go`, `frame.go`, `bodies.go`, `typedbody.go` | server-side decode of client frames |
| `services/transport/rust/src/` | `parse.rs`, `frame.rs`, `body.rs`, `reasm.rs` | on-device decode of server frames |
| `lib/ccwire/` | `codec.ts`, `frame.ts` | JS fallback path when the native module is unavailable |

Go and TS already agree via golden vectors (`lib/ccwire/__vectors__/{codec,frame}.json`,
`codec_parity_test.go`). That proves the three encoders agree on *valid* input.
Nothing today probes *invalid* input.

Existing test gates:

- `npm test` → 220 suites, 298 checks, includes the TS CC-Wire selftests
- `go test ./...` → passes, includes `internal/ccwire` example-based tests
- `npm run test:rust` → **`rust/vaultcore` only** (14 tests). The CC-Wire Rust
  crates were in no scripted gate: `services/transport/rust` (116 tests) and
  `services/transport/rust-net` (13 tests). Measured baseline: all pass, both
  clippy-clean at `-D warnings`

## Goals / Non-Goals

**Goals:**
- Adversarial coverage of the Go and Rust decode paths, using the toolchains
  already present.
- Close the gate hole so the Rust CC-Wire runtime is actually executed by
  `npm run test:rust`.
- Turn any discovered defect into a permanent regression corpus entry.

**Non-Goals:**
- No parser rewrite. Fixes only on demonstrated defects.
- No new fuzzing framework. Go has `testing.F` in stdlib; Rust has its existing
  test stack.
- No wire-format, capability, or limit changes.
- Not fuzzing the TS decoder in this change. It is the fallback path, not the
  one a hostile client reaches first, and JS fuzzing would need tooling the repo
  does not have. Recorded as a follow-up rather than silently skipped.
- No SACK, compression, backpressure or benchmark work — those are separate
  OpenSpec changes, deliberately sequenced after this one.

## Decisions

**Go: native `testing.F`, colocated with the package.**
Go 1.18+ fuzzing is stdlib and integrates with `go test`. A seeded `FuzzDecode`
in `internal/ccwire` runs as an ordinary unit test during `go test ./...`
(seed corpus only) and as a fuzz campaign under `-fuzz`. That means CI gains
regression value with no CI change at all — the same property that makes the
existing `*.selftest.ts` files cheap.

**Rust: seeded property tests first, `cargo-fuzz` only if justified.**
`cargo-fuzz` requires a nightly toolchain and a separate crate. The repo pins a
toolchain (`rust-toolchain.toml`) and the brief says not to introduce a large
framework where native tooling suffices. A table-driven adversarial test in the
existing `tests/` directory reaches the same decoder with the same inputs and
runs under the gate we are about to fix. If that proves insufficient — e.g. we
need coverage-guided exploration to reach a branch — `cargo-fuzz` becomes its
own follow-up with evidence attached.

**Shared corpus, one source of truth.**
The adversarial inputs are protocol-level, not language-level. They are authored
once as a JSON corpus alongside the existing golden vectors, so Go and Rust are
fed identical hostile bytes. A divergence between them is then itself a finding
— exactly the class of bug parity vectors exist to catch.

**Gate fix is one line.**
`scripts.test:rust` gains the transport manifest. No new script, no new runner,
no CI file change.

**Assertion is liveness plus bounds, not exact error codes.**
Fuzz targets assert the decoder returns rather than crashes, and that it does
not allocate on a declared-but-absent length. They deliberately do not assert
specific error codes: that would freeze internal classification and make the
tests brittle against honest refactors.

## Risks / Trade-offs

- **Fixing the Rust gate may surface pre-existing failures.** Measured first:
  both crates green and clippy-clean, so it starts clean — but a future failure
  there will now block the gate, which is the point. Gate coverage 14 → 143.
- **Other Rust crates remain ungated**: `services/crypto/rust`,
  `services/nav/rust`, `services/vaultbeam/rust` all have tests no script runs.
  Out of scope here (this change is CC-Wire) but reported — the crypto one
  especially deserves its own change.
- **Seeded tests are weaker than coverage-guided fuzzing.** Accepted for this
  increment: the goal is to go from *zero* adversarial coverage to *bounded,
  gated* coverage. Escalation path is recorded above rather than assumed away.
- **Fuzz campaigns are unbounded in time.** Committed corpus runs in seconds;
  long campaigns are run on demand, never in the default gate.
- **A discovered defect expands scope.** If fuzzing finds a real crash, fixing
  it is in scope and the fix is a parser change — the one case where the
  no-rewrite rule yields. Any such fix is reported with the input that proved it.
- **Not fuzzing the TS path leaves a gap.** Mitigated by it being the fallback
  carrier, not the primary one, and by Go being the side a hostile client
  actually reaches. Stated as a known limit rather than a claim of completeness.
