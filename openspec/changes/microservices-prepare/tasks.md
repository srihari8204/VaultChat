# Tasks

Levels: **written** = in the repo with its checks passing; **deployed** = the
files are on prod and running; **device-verified** = checked on two phones.
A task is done only at the level it states.

## 1. SERVICES setting (written)

- [x] 1.1 Add `internal/services` (parse `SERVICES`, `all` default, unknown name fatal) with a unit test pinning parsing and the ownership table; verify with `go test ./internal/services/`
- [x] 1.2 Group route registration and job starts in `cmd/api/main.go` by service; move the nine Family Space groups into `RegisterFamilySpaceOnID` and `/user/sos` + `/contacts/trusted` into `RegisterFamilySafety`; verify with `go build ./...` and a test that `SERVICES=golive` serves `/golive/health` and 404s `/chats`
- [x] 1.3 Boot checks per mode: `JWT_SECRET` when core runs; public key, `NODE_INTERNAL_URL` and `INTERNAL_EMIT_KEY` when it does not; verify by starting the binary with `SERVICES=maps` and no key and seeing it refuse

## 2. Every job runs once (written)

- [x] 2.1 Add `jobs.RunLocked` (transaction-scoped advisory lock, FNV-1a key of the job name) with a test for the key and a DB-backed test that a second holder skips; verify with `go test ./internal/jobs/`
- [x] 2.2 Route every ticker through it: `jobs.StartAll`, broadcast reaper, Go Live host sweep, VaultBeam sweep, ShopBook tick; verify with `go build ./...` and `go vet ./...`

## 3. Ed25519 access tokens (written)

- [x] 3.1 Load `ACCESS_TOKEN_PRIVATE_KEY_FILE` / `ACCESS_TOKEN_PUBLIC_KEY_FILE` in `httpx`; sign EdDSA in `authSignAccess` when the private key is loaded; verify EdDSA with the public key and HS256 only in the window; verify with `go test ./internal/httpx/` covering legacy, core-in-window, core-after-window, `ACCESS_TOKEN_HS256=off` and public-key-only
- [x] 3.2 `hlsSecret` prefers `HLS_TICKET_SECRET`; verify with the existing broadcast HLS tests

## 4. Core internal endpoints (written)

- [x] 4.1 Per-service internal keys (`INTERNAL_SERVICE_KEYS`), constant-time compare, shared by `/internal/emit`, `/internal/chat-event` and the new endpoints; verify with a guard unit test
- [x] 4.2 `POST /internal/notify` and `POST /internal/users/cards`, core only; verify with handler tests for 403, bad input and the size caps

## 5. Migration 139 (written)

- [ ] 5.1 Write `vaultchat-backend/migrations/139_service_roles.sql` (roles, grants, sequences, `chat_membership` view, refusal checks) and `migrations/tests/139_service_roles_test.sql`; verify on a scratch Postgres by applying 001–139 and running the test

## 6. Shared helpers out of feature files (written)

- [ ] 6.1 Move the DB, text, device-push and Valhalla helpers to neutral files and `spaceName` / `chatsAudienceAllowed` into `chats_helpers.go`, names unchanged; verify with `go build ./...` and `go test ./internal/routes/`

## 7. Review and validation (written)

- [ ] 7.1 Ponytail review of the whole diff; `go vet ./...`, `go test ./...`, `openspec validate microservices-prepare --strict`

## 8. Deploy (deployed)

- [ ] 8.1 Copy to prod: `vaultchat-backend-go/cmd/api/main.go`, `internal/services/`, `internal/jobs/jobs.go`, `internal/jobs/lock.go`, `internal/httpx/httpx.go`, `internal/httpx/accesskeys.go`, and the changed `internal/routes/*.go` files; apply migration 139; rebuild go-api; confirm `GET /build` shows the new fingerprint, the migration ledger shows 139, and `/health`, a login and a message send work
- [ ] 8.2 Generate the Ed25519 key pair, mount the private key on core, restart, and after 15 minutes set `ACCESS_TOKEN_HS256=off`

## 9. Device verification (device-verified)

- [ ] 9.1 Two-phone smoke test after 8.1 and again after 8.2: log in, message, call, open a Family Space, open ShopBook; a phone logged in before 8.2 keeps working through the switch
