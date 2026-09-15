# CC-Wire event migration release — 2026-09-15

## Written and re-audited

Ten additional scoped audit assignments are recorded in `audit01` through `audit10` reports. The tool limited concurrent workers and eventually refused new threads, so completed workers handled later assignments. File ownership was kept separate.

The app event facade negotiates `app_events_v1`, uses a single primary CC-Wire carrier on capable servers, and retains lazy Socket.IO fallback for older servers. Shared server handlers retain authorization and mixed-carrier fanout. Games WebSockets and LiveKit media remain independent connections. Generic compatibility events contain JSON inside protobuf; this is not a claim that every application field is typed protobuf.

Fixes include bounded fragmentation and native byte budgets, cancellation of server commands, repeat token-expiry recovery, pending-handshake listener cleanup, strict sync completion, account-owned receipts, delivery cursor validation, monotonic visible receipt state, and durable encrypted retry storage. Read intent requires an active focused chat. Undecryptable incoming ciphertext is retained separately from readable cached plaintext.

## Verified checks

- Complete Go suite passed inside the candidate image with shared repository fixtures mounted read-only. The first attempt lacked these fixtures; no production-code failure remained after correcting the test context.
- Actual isolated PostgreSQL handler tests passed: `TestDeliveryCursorScratchDB` and `TestSyncPaginationScratchDB`. The temporary container was removed; production data was not used for these tests.
- Real on-disk SQLite pending-envelope, reopen, deletion, backup, pruning and storage-failure tests passed.
- Rust networking and protocol suites passed. Explicit Go/Rust WebTransport interoperability passed with TLS/JWT rejection and framed Hello/Ping exchange.
- Full frontend run: 290/291 initially passed. The remaining stale source-pattern assertion was corrected; it and the behavioral sync-coalescing suite then passed. The subsequently added actual receipt-handler regression passed separately.
- Typecheck passed. Lint passed with zero errors and 278 existing warnings. OpenSpec change strict validation passed; repository-wide validation passed 32/33 with the pre-existing unrelated `fix-presence-publish-stall` artifact failure.

## Deployed

Production source fingerprint: `a87ebdea3825f347`.

Candidate source archive SHA256: `cef105598e8187d74b24d0e13c4ebf5588359c02a86b511d8ec7bc7e63663ed4`.

Source/image are retained under `/home/srihari/vaultchat-releases/ccwire-events-20260915`. The six existing Compose overlays remain in effect, plus `docker-compose.ccwire-events-20260915.yml`. Only `go-api` was recreated. No database migration was applied.

Direct/public build, health, DB/Redis readiness and unauthenticated CC-Wire rejection passed. External HTTP/3 probe passed HTTP/3.0, ALPN h3, status 200 after deployment.

Rollback: `sudo bash /home/srihari/vaultchat-releases/ccwire-events-20260915/rollback.sh`. The pre-migration API image and source remain retained. Git checkpoint `740e498` was pushed to `hetzner-deploy`; this migration has not been pushed.

## APK and physical-device acceptance — in progress

Release 1.2.11/code27 ARM64 build succeeded (25m46s), APK signature v2 verified. Packaged Expo runtime is also 1.2.11. APK size 102,775,358 bytes; SHA256 `23f06e092310f3679d73cff9f1bc77cb97d450fb735772525598d1cc1d6248a7`. The Hetzner copy matches this hash. The source map confirms the final receipt monotonicity and pending-envelope retry changes are included.

Redmi installation succeeded with `adb install -r`, preserving app data. Its Diagnostics screen reports transport `rust-wt`, state connected, cohort Enabled, CC-Wire ready, zero HTTP fallbacks. This verifies the native Rust WebTransport carrier on a physical phone. No protobuf message submissions have been observed on that phone (counter 0/0).

Honor disconnected during the build and reconnection was requested; it still has the previous APK. Redmi's additional input-injection permission remains unchanged as requested. Before disconnecting, Honor sent labelled message59 through the new server using its old APK, verifying that send path's backward compatibility.

Physical acceptance uncovered a remaining server/data-history mismatch: Redmi requests `since=1027`, while PostgreSQL contains IDs1–59 and `messages_id_seq` is59. Its pending message59 is therefore skipped by the existing forward delta, leaving delivery/read at57. The cause of the allocation-history discontinuity is not established. Server-side undelivered-message recovery is being implemented and tested; receipt device acceptance remains incomplete.

Old APK activity-launch baselines: Honor 1396 ms; Redmi 1548 ms. New Redmi APK: first launch reported WARM1654ms; explicit force-stop then launch reported COLD2350ms. These are Android activity launch measurements, not full chat readiness. New Redmi PSS after visiting chat/Diagnostics was260861KiB; this differs from the earlier baseline lifecycle and does not establish savings. The APK is larger than the saved previous build. No lower-memory or faster-startup claim is supported yet. Blocked UDP may add the WebTransport deadline before WSS fallback. Multi-node Redis integration and production-scale load remain unverified.
