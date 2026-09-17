# CC-Wire codec benchmark

## Why

Every performance statement about CC-Wire in this repository is currently an
assertion. `docs/PERF_BASELINE.md` has carried **"Results — EMPTY, PENDING A
RUN"** since it was written, and the harness that would fill it
(`scripts/bench/sockets-bench.js`) requires `socket.io-client`, which was
correctly removed — and which the Socket.IO guard now forbids re-adding, even
as a dev dependency.

So there is no way to say whether a proposed optimisation helps. The brief's own
rule — *"Do not call a change an improvement because it sounds theoretically
faster"* — cannot be honoured without a number to compare against.

## What Changes

- Add Go benchmarks on the real `EncodeMessage`/`DecodeMessage` path:
  encode, decode, round-trip, and **rejection cost**, across four traffic shapes
  representative of production (ephemeral typing, small durable message, 4 KiB
  message, control ping).
- Report allocations, not only ns/op: allocation per frame is what decides
  whether a gateway at 100k connections lives in GC.
- No new dependency: `testing.B` is stdlib. **`socket.io-client` is NOT
  reintroduced** in any form.

Explicitly NOT in scope: connection establishment, concurrency, end-to-end
latency, multi-node. Those need infrastructure that cannot be stood up here, and
a codec number must never be reported as a throughput number.

## Capabilities

### New Capabilities
- `ccwire-codec-performance`: a measured, repeatable baseline for CC-Wire frame
  encode/decode, including the cost of refusing hostile input.

### Modified Capabilities
<!-- None. Benchmarks observe; they change no behaviour. -->

## Impact

- **Code**: one new file, `vaultchat-backend-go/internal/ccwire/bench_test.go`.
- **Runtime**: none. Benchmarks do not run under `go test ./...` (they need
  `-bench`), so the existing gate is unaffected in time or outcome.
- **Dependencies**: none.
- **Value**: gives Changes for SACK, compression and backpressure a
  before/after to be judged against, instead of a plausible story.
