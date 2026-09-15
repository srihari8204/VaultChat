# Audit 06: native transport and fragmentation interoperability

No new blocking defect found in this bounded review. Production source was not changed.

## Executed interoperability check

Ran the normally ignored Rust WebTransport test against the repository's real Go loopback fixture, using a temporary test-only CA and JWT:

1. `go test ./internal/realtime -run '^TestCCWireWebTransportInteropServer$' -count=1 -v` in `vaultchat-backend-go`, with `CCWIRE_WT_INTEROP_DIR` set to a temporary fixture directory.
2. `cargo test --manifest-path services/transport/rust-net/Cargo.toml --features webtransport go_webtransport_interop -- --ignored --nocapture` with the same directory.

Both passed. Rust rejected the untrusted fixture CA through the production root configuration, rejected an invalid token after trusting the fixture CA, and then exchanged ServerHello and Pong over the real local QUIC/WebTransport connection. The exchange deliberately split a frame header across writes and pipelined the remainder with another frame. Cancellation completed with code 1000; the Go fixture observed the done marker and exited successfully. Expected rejection diagnostics were `UnknownIssuer` and `SessionRejected`.

## Ownership and bounds reviewed

- `rust-net/src/carrier.rs`: each queued outbound allocation owns an `OwnedSemaphorePermit`; the per-socket 2 MiB + framing-header budget includes queued and active writes. Failed `try_send` drops its owned value/permit. Scope exit, cancellation, write failure and channel teardown drop outstanding permits. The count cap is 32; registry creation is limited to two sockets. The active write remains cancellable and has a ten-second deadline.
- `rust-net/src/webtransport.rs`: one reliable bidirectional stream transports opaque CC-Wire bytes. Authentication precedes `Open`; trusted roots and certificate validation remain enabled. Reads use a fixed 16 KiB buffer. Connection setup and active writes are bounded and cancellable. WebTransport failure is handed to the existing coordinator for sequential WebSocket fallback.
- JNI/Kotlin bridge: native byte bounds are checked before borrowing/copying outbound arrays; inbound callback allocations are released after synchronous callbacks. Four outstanding JS payload permits bound inbound handoff, and close releases waiters. JS acknowledges delivered binary callbacks in `finally`. JNI callback exceptions close the associated native carrier.
- Rust `parse.rs` recognizes event body field 100 as the oneof body, so duplicate-body rejection still applies. The production Android carrier does not introduce a second protobuf decoder/session: JS retains negotiation, event decoding, fragment reassembly and reconnect ownership. The standalone Rust typed-body helper intentionally leaves untyped event payloads opaque.
- TS application fragments and Go server fragments bound count, declared length, aggregate received bytes, concurrency and lifetime; they copy received data rather than allocate from a peer's declaration. Duplicate/changed declarations are refused, partial sets do not survive connection teardown, and field-100 JSON limits remain separate from physical frame limits.

## Additional focused checks

- `node node_modules/tsx/dist/cli.mjs lib/ccwire/appEventFragments.selftest.ts` — passed escaped legacy payload, physical limits, out-of-order assembly, duplicate/expiry rejection, aggregate byte limits and disconnect cleanup.
- `node node_modules/tsx/dist/cli.mjs lib/ccwire/nativeSocket.selftest.ts` — passed native adapter lifecycle and byte-bound checks.

Already completed ordinary Cargo suites were not rerun. This verifies desktop loopback Go/Rust interoperability and source-level Android bridge ownership, not Android JNI execution, device networking or production deployment. No external server, production credential or device was used.
