# Design

## Context

See proposal.md for why. The facts that shape the approach:

- `cmd/api/main.go` registers every route group, the CC-Wire hub, the
  `/internal/emit` bridge and every background job unconditionally. Family
  Space's nine route groups are registered on the chat router in
  `internal/routes/chats.go`; `/user/sos` and `/contacts/trusted` sit inside
  `RegisterUser` and `RegisterContacts`.
- `internal/emitx` already switches between in-process delivery (hub hooks
  wired) and posting to `NODE_INTERNAL_URL/internal/emit` with
  `INTERNAL_EMIT_KEY` (hooks nil). A process without the hub is therefore
  already a correct emitter, provided core accepts its key.
- Access tokens are HS256 over `JWT_SECRET` (`authSignAccess`,
  `httpx.VerifyAccess`). The app only reads `sub` from the payload
  (`lib/chatService.ts`), never the algorithm.
- Go reaches Postgres through PgBouncer in transaction mode, so session-level
  advisory locks are unsafe; the partition maintainer already uses
  `pg_try_advisory_xact_lock` for this reason.
- RLS is inert in prod; handlers scope by user themselves. The API connects as
  the owning superuser.
- Migration 138 is taken (`138_pet_care_cap.sql`); this change adds 139.

## Goals / Non-Goals

**Goals:**
- One image, one binary, started as any subset of services, with `all` as the
  default so production is unchanged until someone sets the variable.
- Every precondition the plan lists for moving the first feature (Maps) and the
  first cross-server feature (Go Live).

**Non-Goals:**
- Rewriting feature code that reads `users` or writes `devices` to go through
  core. Each feature does that when it moves, against the endpoints added here.
- A separate Go package or module per service (plan phase 4).

## Decisions

### D1. `SERVICES` is parsed once into a set; `all` is the default

A small `internal/services` package parses `SERVICES` at boot and answers
`Enabled(name)`. Unknown names are fatal, because a typo that silently starts
nothing is an outage that looks like a healthy container. `main.go` wraps each
`Register*` call and each job start in `services.Enabled(...)`.

Ownership follows the plan's service table: `golive` gets broadcasts, Go Live,
their webhooks, the broadcast reaper, the host sweep and broadcast retention;
`family` gets the Family Space route groups plus `/user/sos` and
`/contacts/trusted`; `games` gets `/games/*` and its two sweeps; `maps` gets
`/nav/*`; `shopbook` gets every ShopBook group and its hourly tick; `calls`
gets `/calls/*` and `/call/*`. Everything else, the CC-Wire hub, the admin
stream and all core-only jobs are `core`.

Family Space paths live under `/chats/{id}/`. The nine `Register*OnID` calls
move into one `RegisterFamilySpaceOnID(id)`; the chat router calls it when
`family` is enabled, and a family-only process mounts its own `/chats/{id}/`
router holding just those groups. `/user/sos` and `/contacts/trusted` move into
`RegisterFamilySafety(mux)`.

*Alternative considered:* one binary per service now. Rejected: the plan
defers separate binaries until a feature has its own developer, pace or load,
and it would duplicate the shared helpers before they are untangled.

### D2. Feature-only processes emit through core, authenticated per service

Without `core`, the hub, CC-Wire listener, WebTransport and admin SSE are not
started, so `emitx` hooks stay nil and every emit posts to core. Core's
internal guard accepts the legacy `INTERNAL_EMIT_KEY` or any key in
`INTERNAL_SERVICE_KEYS` (`golive=<key>,family=<key>`), compared in constant
time. A feature process sends its own key as `INTERNAL_EMIT_KEY`, so `emitx`
is unchanged.

### D3. Job lock: transaction-scoped advisory lock held for the run

`jobs.RunLocked(ctx, name, fn)` begins a transaction on `db.Pool`, calls
`pg_try_advisory_xact_lock(hash("vc:job:"+name))`, runs `fn` if it got the
lock, then ends the transaction, which releases the lock. `fn` does its own
queries on the pool as before; only the lock lives in the held transaction.
The key is a 64-bit FNV-1a of the job name, so names stay the source of truth.
Every ticker goes through it: the jobs in `jobs.StartAll`, the broadcast
reaper, the Go Live host sweep, the VaultBeam sweep and the ShopBook tick.
ShopBook keeps its Redis `SETNX` too: that guards the whole hour against copies
whose ticks are minutes apart, which a lock held only while running does not.

*Alternative considered:* Redis `SETNX` everywhere. Rejected because Go Live
runs with its own Redis on LIVE-1, and the plan standardises on Postgres locks
so every copy of any service shares one lock space.

### D4. Ed25519 access tokens with a bounded HS256 window

Keys are PEM files, the same format as the games key:
`ACCESS_TOKEN_PRIVATE_KEY_FILE` (PKCS#8, core only) and
`ACCESS_TOKEN_PUBLIC_KEY_FILE` (PKIX, feature services; core derives it from
the private key). `httpx.LoadAccessKeys()` runs at boot and is fatal on a bad
file. Signing uses EdDSA when the private key is loaded, else HS256 as today.

Verification accepts EdDSA whenever a public key is loaded. It accepts HS256
only if the process holds no public key (legacy mode), or it holds the private
key and less than one access-token lifetime (`JWT_ACCESS_TTL`, 15 minutes by
default) has passed since start, and `ACCESS_TOKEN_HS256` is not `off`. Every
token issued before the switch has expired by then, so the window closes on
its own. A process with only the public key never accepts HS256.

Boot checks: a process running `core` still requires `JWT_SECRET` (it also
keys the invitation and pairing HMACs). A process without `core` requires
`ACCESS_TOKEN_PUBLIC_KEY_FILE`, since otherwise every authenticated request
would fail.

The Go Live HLS ticket HMAC currently uses `JWT_SECRET`. It now prefers
`HLS_TICKET_SECRET` and falls back to `JWT_SECRET`, so a Go Live process never
needs the login secret. Core and Go Live must share the same value while Caddy
can fall back between them.

### D5. Core internal endpoints

Registered only with `core`, beside `/internal/emit`:

- `POST /internal/notify` `{userIds, event, payload, push?{title, body, data},
  socket?}`: the body `emitx.NotifyUsers` already sends. Emits locally when
  `socket` is true (the caller had no hub). Sends the push to the users'
  registered Expo tokens through the existing `chatsSendExpoPush`, the same path
  `sbNotify` uses. At most 1,000 user ids per call.
- `POST /internal/users/cards` `{userIds}` → `{cards: [{id, vaultId, name}]}`,
  names decrypted with `vault.IdentityFromRow`, deleted users omitted. At most
  500 ids per call.

### D6. Per-service roles in migration 139

Roles `svc_golive`, `svc_family`, `svc_games`, `svc_maps`, `svc_shopbook` and
`svc_calls` are created NOLOGIN, NOSUPERUSER, BYPASSRLS, the same shape as
`vaultchat_sys` in 133. BYPASSRLS keeps today's semantics, since handlers scope
by user themselves; the isolation this adds is table grants. Each role gets
SELECT, INSERT, UPDATE and DELETE on its tables and USAGE on their sequences:

- golive: the nine `broadcast_*` tables
- family: the twelve `space_*` tables, `runs`, `run_events`, `run_riders`,
  `run_stops`, `family_relations`, `visitor_passes`, `sos_events`,
  `trusted_contacts`
- games: `games_matches`, `games_live_tables`, `games_notify_seen`
- shopbook: the 31 `shopbook_*` tables
- calls: `calls`, `call_invites`, `call_participants`
- maps: none

`chat_membership` is a view over `chat_members WHERE left_at IS NULL`
exposing `chat_id, user_id, role, joined_at`, granted SELECT to `svc_family`
and `svc_calls`. Passwords stay a manual step, as in 133. The migration
refuses to finish if any `svc_*` role is a superuser or owns a table.

### D7. Shared helpers stay in package `routes`, in neutral files

The plan says "shared packages". Moving the helpers into another Go package
would rename several hundred call sites for no runtime difference while every
service still builds from one package. So they move to neutral files instead:
`shared_db.go` (`chatsQRow`, `chatsExecU`, `chatsExecAffected`,
`chatsQueryU`, `isUniqueViolation`), `shared_text.go` (`chatsStrOr`,
`truncRunes`, `orEmpty`, and `isUUID`, which core's new endpoints share with
Go Live), `devices_push.go` (`fcmTokensFor`,
`registerFcmDevice`, which Games borrows from Calls) and `shared_valhalla.go`
(`valhallaMatrix`, which ShopBook borrows from Maps). `spaceName` and
`chatsAudienceAllowed` move from Family Space files into
`chats_helpers.go`. Names stay the same, so the diff is pure moves.

## Risks / Trade-offs

- [Each running job holds one pooled connection, and one PgBouncer server
  connection, for its lock] → Jobs are short except the retention sweeps. The
  lock is taken on `db.Pool` while the work runs on `db.SysPool`, so a split
  system pool of 8 can never be filled by lock holders waiting on themselves;
  on the default shared pool of 30, the fifteen or so jobs fit with room left,
  and PgBouncer's 40 server connections cover them.
- [Core restarts reopen the 15-minute HS256 window] → Only a holder of
  `JWT_SECRET` can use it, and after this change only core has that. Set
  `ACCESS_TOKEN_HS256=off` once the first Ed25519 deploy has run 15 minutes.
- [A feature-only process started without `NODE_INTERNAL_URL` drops live
  events silently] → The boot check requires `NODE_INTERNAL_URL` and
  `INTERNAL_EMIT_KEY` when `core` is not enabled.
- [Mis-assigned route or job] → The `services` unit test pins the ownership
  table, and `SERVICES=all` stays the default until each move is verified.

## Migration Plan

1. Deploy with no new env: behaviour is identical (verify `/health`, a login,
   and a message send).
2. Apply migration 139 (inert: roles cannot log in).
3. Generate the access-token key pair; mount the private key on core and the
   public key on future feature services; restart core. After 15 minutes set
   `ACCESS_TOKEN_HS256=off`.
4. Set `INTERNAL_SERVICE_KEYS` on core when the first feature service starts.

Rollback: unset the new env and restart. Migration 139 needs no rollback while
the roles cannot log in.
