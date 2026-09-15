# CC-Wire migration final verification — 2026-09-15

## Result

The corrected Android build is operational on Honor ELI-NX9 and Redmi Note 8 Pro. Both negotiate the native Rust WebTransport carrier (`rust-wt`) with the CC-Wire cohort enabled. The tested Honor-to-Redmi path passed send, protobuf acknowledgement, durable delivery/read transitions, edit, delete, Wi-Fi loss fallback, and reconnection.

## Automated verification

- Client repository suite: 292/292 passed (214 selftests and 78 embedded checks).
- TypeScript: `tsc --noEmit` passed.
- ESLint: zero errors; 276 existing warnings.
- Go backend: `go test -count=1 -timeout=300s ./...` passed across every package.
- Rust transport core: 102 tests passed; Clippy passed.
- Rust networking with WebTransport: 13 runnable tests passed; Clippy with all targets and `-D warnings` passed after fixing two build-gate findings.
- Go/Rust WebTransport loopback: TLS trust rejection, invalid JWT rejection, authenticated Hello/Ping, fragmented frames and clean cancellation passed.
- OpenSpec strict validation and `git diff --check` passed.
- The repository test runner skipped only its optional local migration invocation because local PostgreSQL credentials are absent. The separate disposable PostgreSQL cursor, delivery and recovery tests passed.

## Physical-device and production evidence

- Both physical devices retain app data and run VaultChat 1.2.13, version code 29.
- Honor diagnostics after send: carrier `rust-wt`, ready, protobuf submits/acks 1/1, HTTP fallback 0; encryption-to-ack 505 ms and total tap-to-ack 562 ms.
- Before Redmi opened Leo, its UI showed one unread message and production cursors showed delivered 69 while read remained 64.
- After Redmi opened the chat, plaintext rendered without a decrypt error and the read cursor advanced to 69.
- The edit rendered as plaintext on Redmi. The delete rendered as `Message deleted` on both phones. Production row 69 contains matching `edited_at` and `deleted_at`.
- Disabling Wi-Fi disconnected the active path and exposed the Rust WebSocket fallback attempt. Restoring Wi-Fi returned the connection to ready `rust-wt`.

## Cold start and WhatsApp comparison

Three Android activity launches were sampled after force-stop.

| Device | VaultChat home | WhatsApp home | VaultChat direct chat |
| --- | ---: | ---: | ---: |
| Honor ELI-NX9 | 1,175 ms average | 632 ms comparable cold average | 792 ms average |
| Redmi Note 8 Pro | 1,954 ms average | 763 ms average | 1,489 ms average |

At a fixed three-second post-draw sample, both VaultChat devices showed cached chat content and the deletion tombstone. Initial history loading is bounded to the newest 50 messages through the SQLite `(chat_id, id DESC)` index; the list renders only visible bubbles and loads older pages in batches of 50.

One memory snapshot, three seconds after launch:

| Device | VaultChat PSS | WhatsApp PSS |
| --- | ---: | ---: |
| Honor | 279,976 KB | 323,598 KB |
| Redmi | 258,671 KB | 268,131 KB |

These are single snapshots and establish current-device behavior, not a general memory guarantee.

## Remaining physical acceptance limits

- Redmi blocks ADB input injection under the requested unchanged MIUI security setting, so an automated Redmi-to-Honor send was not possible.
- The phones had no usable cellular data path when Wi-Fi was disabled, so Wi-Fi-to-cellular continuity is not proven.
- Calls, live location, presence, typing, reactions, groups and VaultBeam have automated facade/backend coverage, but every event was not manually exercised on both physical phones.
- Real iOS build/device testing requires macOS/Xcode or an iOS build runner.
- A direct WhatsApp conversation benchmark was not performed; only its main activity was launched, without opening private conversations.
- Rust `cargo fmt --check` reports the crate's existing repository-wide formatting drift. Functional tests and strict Clippy pass.

