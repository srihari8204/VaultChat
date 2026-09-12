# VaultChat full-stack audit — 8 September 2026

The local review found security, session reliability, and financial-data validation defects that should be fixed before expanding usage. Passing unit/selftests currently misses several important failure paths.

## Scope and limits

Reviewed the React Native/Expo application, shared client services, primary Go API and sockets, legacy Node API, SQL/schema boundaries, Rust money core, and deployment/monitoring/backup configuration. This was a risk-focused source review across the stack, with automated checks and isolated reproductions; it is not a claim that every line or feature was exhaustively verified.

Baseline: local checkout at `54133a8687c4bfee947ce9ce2779381635257f8d`, including existing uncommitted workflow/documentation changes. No application fixes or deployments were made.

The live server, deployed file versions, database contents, production overrides, and physical-device behavior remain unverified. Local Docker was unavailable, so database-backed migration tests were skipped. Source findings that depend on database behavior are identified below. Repository configuration says the production API uses a superuser and bypasses RLS; actual deployed roles still need verification.

**Priority:** P1 = fix promptly because of authorization, account availability, or financial integrity; P2 = next-priority functional/operational correction. “Reproduced” means an isolated local harness using the existing implementation, not a production exploit.

## Findings, ranked

### F01 — P1: Link preview follows private-network redirects before checking them

**Evidence:** [link.go](../../vaultchat-backend-go/internal/routes/link.go#L150), lines 141–160. Initial validation rejects private hosts, but `http.DefaultClient.Do` follows redirects before the final hostname is validated. The legacy [Node route](../../vaultchat-backend/routes/link.js#L90) has the same ordering.

**Impact:** An authenticated caller can supply a public URL that redirects to an internal HTTP service. Rejecting the final response happens after the internal request has already been made. This establishes an SSRF request path; the audit did not attempt internal data retrieval or production access.

**Reproduced:** A mocked transport recorded a request to loopback on a nonstandard port, followed by the handler's rejection. No outbound request was sent.

**Fix and acceptance:** Use a dedicated HTTP client that rejects redirects or validates every hop before following it, including scheme, port, and resolved address. Dial the validated address to avoid a separate DNS resolution bypass. Test public-to-private and multi-hop redirects. This matches the redirect precautions in the [OWASP SSRF guidance](https://cheatsheetseries.owasp.org/cheatsheets/Server_Side_Request_Forgery_Prevention_Cheat_Sheet.html).

### F02 — P1: Removing a group member leaves their connected socket authorized

**Evidence:** [handlers.go](../../vaultchat-backend-go/internal/realtime/handlers.go#L337), lines 337–359, caches membership for the socket's lifetime. [delivery.go](../../vaultchat-backend-go/internal/realtime/delivery.go#L99), lines 99–102, invalidates only the Redis member-list cache. Existing sockets are not evicted from chat rooms on removal. Live-location and call handlers reuse the cached permission. Run permissions have a similar lifetime cache.

**Impact:** A removed member can retain access to room events and continue sending authorized-looking location events until the connection is replaced. Access to newly encrypted message plaintext was not established.

**Reproduced:** Normal member-list invalidation left a previously authorized socket's membership result true without consulting the database.

**Fix and acceptance:** Invalidate socket authorization and remove affected sockets from chat/call/run rooms across all instances when permissions change. Test removal while the former member remains connected, including attempts to rejoin and publish.

### F03 — P1: An unrelated user can consume someone else's view-once media

**Evidence:** [uploads.go](../../vaultchat-backend-go/internal/routes/uploads.go#L803), lines 803–845. `uploadsViewed` looks up an attachment by ID and checks view-once state and ownership, but never checks whether the caller is a permitted recipient. `WithUser` does not enforce access when the connection bypasses RLS.

**Impact:** An authenticated user who knows an attachment ID can mark another user's view-once media as viewed, denying its intended recipient access. This finding concerns consuming the media, not downloading its contents.

**Verification:** Source/schema review under the documented database-role configuration; a two-user database reproduction is pending.

**Fix and acceptance:** Validate the applicable chat/story audience and update the receipt atomically. An unrelated user must receive a rejection with the attachment unchanged.

### F04 — P1: Shop payments can credit one customer and another customer's invoice

**Evidence:** [shopbook_payment.go](../../vaultchat-backend-go/internal/routes/shopbook_payment.go#L99), lines 99–159. The handler validates the customer relationship with the shop, then separately selects an invoice using only order ID and shop ID. It never establishes that the order/invoice belongs to the supplied customer. A missing invoice lookup is ignored while the supplied order ID is still written.

**Impact:** A payment recorded for customer A with customer B's order can credit A's ledger while reducing B's invoice balance. The relevant schema has separate foreign keys rather than a constraint tying this complete relationship together.

**Verification:** Source/schema review; no real payment was created. Database integration reproduction is pending.

**Fix and acceptance:** Resolve and validate shop, customer, order, and invoice together inside the transaction. Reject a supplied order that belongs to another customer or shop. Test two customers and two shops and verify both ledger and invoice totals remain unchanged on rejection.

### F05 — P1: Refresh authentication searches only 500 sessions across all users

**Evidence:** [auth.go](../../vaultchat-backend-go/internal/routes/auth.go#L719), lines 719–755. Refresh selects the latest 500 eligible rows globally and bcrypt-compares the supplied token against each. Logout also searches an unordered maximum of 500 rows at line 810.

**Impact:** Once more than 500 eligible token rows exist, a still-valid older token can be rejected. This is a token-row limit, not a 500-user limit; rotation and multiple devices affect it. Invalid refresh attempts can also cause hundreds of expensive bcrypt comparisons. Logout can report success without finding the intended token.

**Verification:** Direct query/control-flow evidence; no production load test was run.

**Fix and acceptance:** Give opaque tokens an indexed identifier or keyed digest so lookup selects one candidate, and rotate transactionally. Test valid tokens outside the newest 500 rows and logout of an older session. Do not solve this merely by increasing the limit.

### F06 — P1: “Sign out other devices” also revokes the current device

**Evidence:** [user.go](../../vaultchat-backend-go/internal/routes/user.go#L1961), lines 1961–1971, creates a new salted bcrypt hash of the current refresh token. Lines 1997 and 2067 compare that new hash with stored hashes using SQL equality/inequality.

**Impact:** The current device is not marked current, and “sign out others” includes it in revocation. This contradicts [login-history.tsx](../../app/login-history.tsx#L105).

**Reproduced:** A fresh hash differs from the stored hash of the same token, although bcrypt verification succeeds.

**Fix and acceptance:** Identify the current session using token verification or the indexed token design in F05, then compare session IDs. Test that exactly one session is current and remains usable after all others are revoked.

### F07 — P1: A manually revoked session can refresh during the rotation grace window

**Evidence:** [auth.go](../../vaultchat-backend-go/internal/routes/auth.go#L719) accepts every token revoked in the previous 30 seconds, without distinguishing rotation from explicit device revocation. [user.go](../../vaultchat-backend-go/internal/routes/user.go#L2032) uses the same `revoked_at` field for manual revocation.

**Impact:** A revoked device that refreshes during that interval can receive fresh credentials. Separately, access JWTs have no session ID, [RequireAuth](../../vaultchat-backend-go/internal/httpx/httpx.go#L137) checks no revocation state, and socket authentication runs at the [initial handshake](../../vaultchat-backend-go/internal/realtime/server.go#L115). Existing access lasts until JWT expiry (15 minutes by default), and connected sockets are not terminated by session revocation. The UI's immediate-signout promise is therefore unsupported.

**Verification:** Source trace; no live device/session revocation was attempted.

**Fix and acceptance:** Distinguish rotation grace from explicit revocation and revoke an entire session/token family. Associate JWTs and sockets with a revocable session. Test immediate refresh after revocation, remaining access-token requests, and an already-connected socket.

### F08 — P1: A temporary refresh failure deletes valid login credentials

**Evidence:** [api.ts](../../lib/api.ts#L236), lines 236–251, maps network errors, server errors, and malformed responses to the same false result. Lines 279–286 then clear tokens/profile and navigate to onboarding.

**Impact:** A brief outage or failed network resume becomes an unexpected logout.

**Reproduced:** The unchanged client API module, loaded with mocked native/network dependencies, received an initial 401 and refresh 503. It deleted credentials and redirected to onboarding.

**Fix and acceptance:** Preserve credentials for network errors, timeouts, and 5xx responses; end the session only on an explicit terminal authentication failure. Test offline resume, 503, recovery, and a genuinely revoked token separately.

### F09 — P1: Authentication failure can permanently stall message sending and sync

**Evidence:** [api.ts](../../lib/api.ts#L299) returns a promise that never settles after ending a session. [messageQueue.ts](../../lib/messageQueue.ts#L591) and [syncEngine.ts](../../lib/syncEngine.ts#L116) await this API; their busy flags are cleared only in `finally`. Refresh also uses an unbounded fetch at api.ts line 240, outside the normal request timeout.

**Impact:** Cleanup never runs. Queue/sync workers can remain busy after another sign-in in the same app process. A hung refresh can also block all requests sharing `refreshInFlight`.

**Reproduced:** The API promise remained pending and the caller's `finally` was never reached. The refresh request had no abort signal or deadline. The worker consequence follows from the existing await/finally control flow.

**Fix and acceptance:** Reject a typed session-ended error, suppress its presentation at UI alert boundaries, and give refresh a bounded deadline. Reset/cancel account-scoped workers on account transitions. Test send/sync recovery after reauthentication without restarting the app.

### F10 — P1: IP rate limits combine different users behind the reverse proxy

**Evidence:** [auth.go](../../vaultchat-backend-go/internal/routes/auth.go#L101) derives client IP only from `RemoteAddr`. The configured path is nginx → [Caddy](../../caddy/Caddyfile#L107) → Go, so Go sees the proxy address. Forwarded client information is not used by this helper.

**Impact:** In the checked-in deployment topology, unrelated users share per-IP limits, including OTP issuance at 10/hour and account lookup at 20/minute. A small amount of traffic can block other users' login flows.

**Reproduced:** Requests with distinct forwarded client IPs but the same proxy address generated the same rate-limit identity. Live overrides still need checking.

**Fix and acceptance:** Resolve client IP through an explicit trusted-proxy policy across both hops. Test that real clients receive distinct limits and that an untrusted direct request cannot spoof its identity with a header.

### F11 — P1: Redis failure disables PIN guessing limits

**Evidence:** [redisx.go](../../vaultchat-backend-go/internal/redisx/redisx.go#L39) allows requests when Redis is absent or INCR fails. MPIN authentication and recovery use this limiter in [auth.go](../../vaultchat-backend-go/internal/routes/auth.go#L1621).

**Impact:** An outage of the rate-limit store removes the intended five-attempt PIN restriction.

**Reproduced:** With Redis unavailable, ten attempts were allowed against a five-attempt limit.

**Fix and acceptance:** Use a durable fallback or return a temporary-unavailable response for security-sensitive authentication limits. Test both a missing client and runtime Redis failure. This need not impose the same policy on unrelated low-risk endpoints.

### F12 — P2: Face-scan route calls a React hook during module initialization

**Evidence:** [facescan.tsx](../../app/facescan.tsx#L33) calls `useWindowDimensions` inside `buildGrid`; line 47 invokes that function at module scope.

**Impact:** Loading this route executes a hook outside a component and can fail with an invalid-hook error. This is a demo UI, so it should also be clearly separated from any real biometric authentication flow.

**Verification:** Lint reports the hook-rule error; source establishes the module-level call. Physical-device route loading was not tested.

**Fix and acceptance:** Remove the unused hook in this helper or obtain dimensions in the component and pass them into a pure grid builder. Verify lint and opening/rotating the screen on a device.

### F13 — P2: Socket reconnect reuses an expired access token

**Evidence:** [socket.ts](../../lib/socket.ts#L98) captures a token once in `auth: { token }`. HTTP token refresh does not update that socket's auth, and reconnect/error handlers do not refresh credentials. Server middleware rejects expired tokens.

**Impact:** After token expiry and a connection loss, HTTP can be authenticated while live messaging/calls remain disconnected until another path creates a fresh socket or updates credentials.

**Verification:** Client/server source trace; expiry and network-switch device testing remains pending. Socket.IO documents that middleware rejection does not automatically reconnect the socket: [connection-error behavior](https://socket.io/docs/v4/client-socket-instance/).

**Fix and acceptance:** Supply current credentials on every handshake and implement controlled refresh/reconnect for token expiry. Test expiry followed by Wi-Fi/mobile switching without screen navigation.

### F14 — P2: Health checks can report success during dependency outages

**Evidence:** [main.go](../../vaultchat-backend-go/cmd/api/main.go#L57), lines 57–67, always returns HTTP 200. Redis failure alone still produces `status: "ok"`. Dependency probes have no dedicated deadline. The checked-in primary Go service has no Compose healthcheck.

**Impact:** Status-code-based monitoring can stay green while authentication limits or database-dependent requests fail.

**Verification:** Source/configuration review; actual monitoring rules and server health are pending.

**Fix and acceptance:** Separate liveness and readiness, return an unhealthy readiness status for required dependencies, bound probe duration, and wire checks and alerts into deployment. Test database and Redis failure independently.

## Automated verification

| Check | Result | Limits |
| --- | --- | --- |
| Root `npm test` | 232/232 passed: 155 suites + 77 embedded checks | Database migration tests skipped because local Docker was unavailable |
| Root `npm run typecheck` | Passed | Includes LiveKit version-alignment check |
| Root `npm run lint` | Failed: 1 error, 296 warnings | Error is F12; warnings include hook/dependency and cleanup issues |
| Go `go test ./...` | Passed | Does not establish production DB or multi-device behavior |
| Rust vaultcore `cargo test --locked` | 14 passed | Money core only; not every native/Rust service |
| Legacy Node syntax check | Passed | `server.js` and route JavaScript files |
| Isolated audit reproductions | Five Go tests passed; client API failure reproduced | Mocked network/native dependencies; no production changes |

Audit logs and reproduction harnesses are saved locally at:
`C:/Users/Dell/AppData/Local/Temp/vaultchat-audit-20260908`.

Go reproductions: `go test -v ./internal/routes` from that directory's `go-repro` subdirectory.
Client reproduction: run `node C:/Users/Dell/AppData/Local/Temp/vaultchat-audit-20260908/api-repro.cjs` from the repository.

## Dependency findings

Scans are dated 8 September 2026 and describe local resolved dependencies. Counts are affected dependency entries, not a count of demonstrated runtime exploits.

| Scan | Result |
| --- | --- |
| App `npm audit --omit=dev` | 56 entries: 3 critical, 22 high, 30 moderate, 1 low |
| Legacy Node `npm audit --omit=dev` | 67 entries: 3 critical, 25 high, 37 moderate, 2 low |
| Go `govulncheck` v1.7.0 | 11 symbol-level advisory results; also 5 imported-package and 22 module-only results |

App critical entries include shell-quote, tar, and xmldom; legacy Node critical entries include protobufjs, tar, and websocket-driver. Some app dependencies are build tooling pulled through Expo, and the Node API is under the legacy Compose profile. Determine actual runtime/build exposure before assigning remediation priority.

The Go scan used local Go 1.26.5; its standard-library findings list 1.26.6 as fixed. Module findings identify updates including pgx/v5 5.9.2, x/net 0.55.0, x/text 0.39.0, and quic-go 0.59.1. Validate compatible upgrades and re-scan, rather than applying an indiscriminate forced update. The production image uses a floating Go build tag, so its actual toolchain/version must be inspected separately.

For example, the pgx advisory requires simple protocol plus a particular dollar-quoted SQL construction; this project defaults to `DB_QUERY_EXEC_MODE=exec`. It is an upgrade item, not a confirmed SQL-injection path here. See the [official pgx advisory](https://pkg.go.dev/vuln/GO-2026-5004). HTTP/3 and other indirect call-graph results likewise need deployment-specific triage.

## Improvements

1. **Add behavioral integration coverage for the findings.** A significant portion of the selftests reads source text (72 of 155 files contain source-reading operations). Such checks catch wiring regressions but do not replace requests against PostgreSQL/Redis. Prioritize two-user authorization tests, token rotation beyond 500 rows, concurrent refresh/revocation, connected-member removal, and payment relationship validation.
2. **Make database authorization enforceable in depth.** Follow the existing RLS enforcement plan with separate application/system roles and endpoint tests. Keep explicit user checks; do not switch roles blindly on production.
3. **Distinguish location fix age from heartbeat age.** [presence.ts](../../lib/family/presence.ts#L209) republishes the last coordinates with the current timestamp. This keeps stationary presence alive but can make old coordinates appear newly measured when the sensor stops producing fixes. Preserve separate measurement and heartbeat timestamps and test GPS loss. The existing presence-stall proposal records a code fix on 6 September and an outstanding device matrix; this audit does not reclassify that older defect as unfixed.
4. **Make deployments reproducible and observable.** Record deployed file hashes, image digests, build/toolchain versions, and applied migrations. Use lockfile-strict Node installs where that service is built. Add bounded readiness checks, actionable alerts, and graceful shutdown handling.
5. **Verify recovery, not just backup configuration.** Backup/offsite-encryption scripts already exist. Check recent successful scheduled runs, offsite copies, availability of the recovery key outside the server, and a restore into an isolated database.
6. **Update architecture/runbook documentation against the live deployment.** Some documents describe an older Node/Go division and migration inventory. Confirm what runs under optional Compose profiles and reconcile production's migration ledger before editing “deployed” claims.

### Ponytail complexity pass

`delete:` Remove the misplaced 323-line mobile face-scan demo and its Expo/React/React Native dependency declarations from the legacy backend after confirming it has no separate supported mobile target. The main application already owns its UI; Node runtime JavaScript does not import these three mobile packages. Replacement: the existing main app. [backend demo](../../vaultchat-backend/app/facescan.tsx), [backend package](../../vaultchat-backend/package.json).

Estimated net: -323 lines, -3 direct dependencies possible, excluding further lockfile shrinkage. This is a recommendation; nothing was deleted.

## Recommended repair order

1. Close SSRF and socket/media authorization gaps (F01–F03), then validate payment relationships (F04).
2. Fix session identity, lookup, and revocation together (F05–F07), with client failure/recovery and socket refresh behavior (F08–F09, F13).
3. Correct proxy-aware and outage-safe authentication limits (F10–F11).
4. Resolve the invalid hook and readiness behavior (F12, F14), triage dependency upgrades, and add the integration/device checks above.

Use OpenSpec changes for the behavioral work, reusing relevant existing changes where possible. Each fix needs written, deployed, and device-verified status kept separate.

## Remaining live-server and device review

Server access is needed to verify:

- Actual deployed source/binary versions and Compose overrides against this checkout.
- Running services, restarts, recent sanitized error logs, CPU/RAM/disk, database connections/slow queries, and Redis memory/evictions.
- Actual exposed ports, firewall/TLS configuration, proxy headers, and media endpoints. Checked-in production overrides already bind Go/Redis to loopback and omit a public database port; these are not findings of public exposure.
- Database roles/RLS and applied migration ledger.
- Backup freshness, offsite recovery-key availability, and restore readiness.
- Monitoring/alerts, job execution, and main versus Go Live SFU isolation.

Device checks still need two accounts/devices for locked/background location, token expiry and network switching, session revocation, message/call delivery, and view-once behavior. No native release build or physical-device end-to-end test was completed during this local audit.

