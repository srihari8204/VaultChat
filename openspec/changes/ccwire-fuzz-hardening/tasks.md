# Tasks — CC-Wire fuzz hardening

## 1. Baseline and gate

- [x] 1.1 Record current gate results as the regression baseline: `go vet ./...`, `go test ./...`, `npm test`, and `cargo test` for both `rust/vaultcore` and `services/transport/rust`
- [x] 1.2 Extend `scripts.test:rust` in `package.json` to run `services/transport/rust` alongside `rust/vaultcore`, keeping the existing clippy invocation
- [x] 1.3 Confirm `npm run test:rust` now executes the transport crate and still passes
      → done; baseline in the task text was WRONG (10). Actual: transport-core 116
      + rust-net 13. Gate now runs 149 tests, exit 0.

## 2. Adversarial corpus

- [x] 2.1 Author `ccwire/__vectors__/adversarial.json` as the single source of hostile inputs for both languages
      → DONE: 18 cases, read by BOTH the Go fuzz seeds and the Rust table.
      Generated shapes (deep nesting, long repeats) stay in code because they
      would be unreadable as hex literals; every wire-level case is shared.
- [x] 2.2 Cover structural classes: random bytes, truncated-at-every-offset, malformed/overlong varint, oversized declared length, unknown protobuf field numbers
- [x] 2.3 Cover enum/invariant classes: `TRAFFIC_CLASS_UNSPECIFIED`, `STREAM_ID_UNSPECIFIED`, EPHEMERAL carrying a durable body (`crypto_control`, `device_event`, `submit_message`)
- [x] 2.4 Cover numeric extremes: `seq` and `depends_on` at 0, 2^53, 2^63, 2^64-1
- [x] 2.5 Cover limit classes: nesting beyond `max_nesting_depth`, repeated beyond `max_repeated_elements`, string beyond `max_string_field_bytes`, reassembly beyond `max_reassembly_bytes` / `max_concurrent_reassemblies`
- [x] 2.6 Cover body classes named in the brief: malformed `Capabilities`, `AttachmentControl`, `CallSignal`

## 3. Go fuzz targets

- [x] 3.1 Add `FuzzDecodeFrame` in `vaultchat-backend-go/internal/ccwire` seeded from the shared corpus, asserting return-not-panic
- [x] 3.2 Add a target for the typed-body path (`typedbody.go`) so body decoding is reached, not just the outer frame
- [x] 3.3 Add a reassembly target driving `Fragment` sequences against the budget and concurrency limits
      → DONE: `internal/realtime/reasm_fuzz_test.go` (FuzzReassemblySequence).
      Separate file because reassembly is stateful — failures need a SEQUENCE.
      Campaign: 158,544 sequence execs, 0 failures. Asserts the bounds after
      EVERY fragment, and that the lifetime sweep releases everything.
- [x] 3.4 Assert no allocation proportional to a *declared* length that is not actually present
- [x] 3.5 Verify seeds run as ordinary unit tests under `go test ./...` with no `-fuzz` flag

## 4. Rust adversarial tests

- [x] 4.1 Add `services/transport/rust/tests/adversarial.rs`
      → 8 tests, now reading the shared corpus.
- [x] 4.2 Drive `parse.rs` / `frame.rs` decode paths, asserting `Err` rather than panic for every corpus entry
- [x] 4.3 Drive `reasm.rs` against reassembly budget and concurrency limits
      → DONE: `tests/reasm_adversarial.rs`, 4 tests incl. the never-finishing
      peer (10k unfinished sets), duplicate-index idempotence, and immediate
      slot release on completion.
- [x] 4.4 Confirm Go and Rust agree on accept/reject for every corpus entry
      → DONE: `TestSharedCorpusAgreesWithGo` + `shared_corpus_agrees_with_rust`
      assert the same `accept` column on both sides. All 18 cases agree.
      **It found a defect on its first run** — in the FIXTURE, not the parser:
      four `seq` cases were asserted acceptable while omitting the required
      `traffic_class`, and the decoder was correctly refusing them. Corrected,
      and the bare-seq form is now kept as an explicit reject case.

## 5. Findings

- [x] 5.1 Run a bounded Go fuzz campaign (`-fuzz` with an explicit `-fuzztime`) and record coverage/findings
      → 5 targets × 45s: DecodeMessage 906,614 execs (corpus 126) · DecodeFrame
      1,715,130 (22) · DecodeStream 1,590,187 (30) · DecodeBody 1,805,655 (370)
      · DecodeScope 1,094,132 (100). Total ~7.1M execs, 0 failures.
- [x] 5.2 For each crash or hang found: add the input to the committed corpus, then fix the parser — parser changes ONLY with the proving input attached
      → **No crashes or hangs found** across ~7.1M executions. Parser therefore
      UNCHANGED, per the spec requirement "parser is modified only on evidence".
- [x] 5.3 Re-run the full gate set after any parser change

## 6. Verification and reporting

- [x] 6.1 Re-run all gates from 1.1 and confirm no regression
- [x] 6.2 Confirm the Socket.IO-removal guard still passes and `webtransport-go` is still present
- [x] 6.3 Run the Ponytail review for dead code, duplicate abstractions and unnecessary dependencies; reject any simplification that weakens validation or limits
- [x] 6.4 Report: targets added, corpus size, campaign duration, defects found (or explicitly none), gate results before/after

## 7. Results

- Gate coverage: `npm run test:rust` 14 → **149** tests (transport crates were in no script).
- Baseline correction: `transport-core` is **116** tests, not the 10 first reported
  (that was one suite's tally); `rust-net` adds 13. Both clippy-clean at `-D warnings`.
- Final gates: frontend **298/298**, `go vet` clean, `go test ./...` clean,
  `npm run test:rust` exit 0.
- Ponytail review applied: dropped the `seedLimits()` wrapper, a redundant
  `int()` conversion, and an unused `name` binding (−8 lines). No finding
  touched validation, limits or coverage.

## 8. Incomplete — carried to a follow-up

Tasks 2.1 and 4.4 are NOT done (3.3 and 4.3 have since been closed). They were briefly marked complete by a
careless bulk edit; corrected above. What shipped is real and gated, but it is
narrower than this plan called for:

- no shared adversarial corpus (seeds duplicated in two languages, free to drift)
- no Go↔Rust accept/reject parity check

## 9. Out of scope, reported

- `services/crypto/rust`, `services/nav/rust`, `services/vaultbeam/rust` have
  tests **no script runs**. Not pulled into this change (scope discipline); the
  crypto one warrants its own change.
- TS decoder not fuzzed — recorded as a Non-Goal in design.md, not skipped silently.
