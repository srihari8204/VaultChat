# Acceptance criteria — what is actually verified, and what is not

Every §20 acceptance criterion, each in exactly **one** bucket:

| | Bucket | Meaning |
|---|---|---|
| **(a)** | Runnable here | Pure logic, wire formats, bounds, config invariants. Executed by a command in this repo. |
| **(b)** | Needs a **deployed** server | A running instance of this product at a URL — the shipped binary, TLS, the socket layer, production data. This session has no production access. The command is written down; it has **not been run**. |
| **(c)** | Needs real devices | Two physical handsets on a real network. Manual steps only. |
| **(d)** | Needs hardware/credentials nobody here has | A Mac and an Apple Developer account — see [IOS_PARITY.md](IOS_PARITY.md). |

**A criterion marked passing that was never executed is worse than one marked
not run**, because it retires the suspicion without earning it. Nothing below is
marked (a) unless the command was run and its output seen.

---

## Summary

| Bucket | Criteria | Status |
|---|---:|---|
| **(a)** executed here | **22** | green, today |
| (b) blocked on a deployed server | 4 | not run |
| (c) blocked on two handsets | 7 | not run |
| (d) blocked on Mac + Apple account | 4 | not run |
| not mechanisable at all | 1 | see §20.21 |
| **Total** | **38** | **22 verified (58%), 16 outstanding** |

**8 of those 22 were not executed by anything before this file existed**
(§20.4, .8, .9, .13, .14, .15, .19, .20). They are now asserted in
`scripts/acceptance.selftest.ts` — 32 assertions, all passing.

**2 more moved out of (b) on 2026-09-14: §20.23 and §20.18.** Both were listed
as needing a live server. Both needed a *Postgres*, which is not the same thing
— see "the Docker assumption" below. Each was then RUN, and §20.23 failed the
first time; the two defects it found are named in its row.

### Run everything in bucket (a)

```bash
npx tsx scripts/acceptance.selftest.ts                      # the 32 assertions below
node scripts/test-all.js                                    # 273 suites (195 selftest + 78 embedded), all passing today
npx tsc --noEmit
cd vaultchat-backend-go && go build ./... && go vet ./... && go test ./...
cargo test --manifest-path services/transport/rust/Cargo.toml
cargo test --manifest-path rust/vaultcore/Cargo.toml
```

Two of the 22 (§20.18, §20.23) additionally need a Postgres to talk to; their
exact commands are in their own rows, and both **skip cleanly** — they do not
fail — on a machine that has none.

`scripts/acceptance.selftest.ts` **is** now auto-discovered by
`scripts/test-all.js` (`'scripts'` is in its `SEARCH_DIRS`), so a regression in
those 8 criteria does fail `npm test`. The warning that used to live here,
saying otherwise, was true when it was written and is not any more.

### The Docker assumption, and what it cost

Bucket (b) used to read *"Docker Desktop does not start on this machine"*. That
is still true, and it was never the right reason to shelve §20.18 and §20.23.
Neither criterion wants Docker, or a deployed server, or production: they want a
psql and a schema. The tooling had Docker baked in — `scripts/test-migrations.js`
spelled every invocation `docker exec vaultchat-postgres-1 psql …` — so an
unrelated Docker Desktop failure took two database criteria dark, on a machine
with PostgreSQL 18 installed at `C:\Program Files\PostgreSQL\18\bin`.

`scripts/test-migrations.js` now tries a **local psql first** (PATH, or the
Windows installer's directory, which is never on PATH), falls back to
`docker exec`, and still skips with exit 0 when neither answers — a developer
with no Postgres at all is not blocked, which was always the contract. Probes
are bounded and pass `-w`, because psql reads a password prompt from the
terminal rather than stdin and will otherwise hang a build forever.

### The throwaway cluster — how both DB criteria were run

No Docker, no production, nothing left behind. Destroyed at the end of the
session it was made in.

```bash
PGBIN='/c/Program Files/PostgreSQL/18/bin'
"$PGBIN/initdb"  -D /tmp/pgdata -U postgres --auth=trust
"$PGBIN/pg_ctl"  -D /tmp/pgdata -o "-p 55434 -c listen_addresses=127.0.0.1" -l /tmp/pg.log start
"$PGBIN/psql" -h 127.0.0.1 -p 55434 -U postgres -d postgres \
  -c "CREATE ROLE vaultchat LOGIN SUPERUSER PASSWORD 'vaultchat'" \
  -c "CREATE DATABASE vaultchat OWNER vaultchat"

cd vaultchat-backend && DB_HOST=127.0.0.1 DB_PORT=55434 DB_USER=vaultchat \
  DB_NAME=vaultchat DB_PASS=vaultchat node migrate.js up      # §20.23, first half

# …run §20.23 and §20.18 (their rows below), then:
"$PGBIN/pg_ctl" -D /tmp/pgdata -m immediate stop && rm -rf /tmp/pgdata
```

---

## (a) Executed here

Run and seen green. The "where" column names the file that does the asserting.

### Wire format — CC-Wire v1

| # | Criterion | Where |
|---|---|---|
| 20.1 | Framing constants (version, header size, hard ceiling) agree TypeScript ↔ Go | `lib/ccwire/parity.selftest.ts` |
| 20.2 | Frame encode/decode/stream vectors round-trip identically TS ↔ Go | `lib/ccwire/parity.selftest.ts` (fixture `__vectors__/frame.json`, generated by Go) |
| 20.3 | `ccwire.v1.Frame` vectors agree TypeScript ↔ Rust | `lib/ccwire/codecParity.selftest.ts` + `services/transport/rust/tests/codec.rs` (fixture `__vectors__/codec.json`, hand-written from the protobuf spec) |
| 20.4 | **All three implementations are one set** — the Go-generated fixture and the Rust-asserted fixture are consistent with each other, so Go and Rust agree transitively through TS. The negotiated frame limit (256 KiB, Rust side) fits inside the hard framing ceiling (2 MiB, Go side); that relationship lived only in a code comment. | **`scripts/acceptance.selftest.ts` §A2 — new** |
| 20.10 | `BODY_NAMES` matches the 27 `oneof body` field numbers in `envelope.proto` | `lib/ccwire/codec.selftest.ts` |
| 20.11 | `LIMITS` matches every value in `capabilities.proto`'s `Limits` | `lib/ccwire/codec.selftest.ts` |

### Bounds — the decoder refuses what it must

| # | Criterion | Where |
|---|---|---|
| 20.5 | A declared length above the ceiling is refused **before any allocation** | `lib/ccwire/frame.selftest.ts`; re-asserted end-to-end in `scripts/acceptance.selftest.ts` §A3 |
| 20.6 | A negotiated limit may only tighten; a peer proposing a *larger* bound does not get it | `lib/ccwire/codec.selftest.ts` |
| 20.7 | An `EPHEMERAL` frame carrying `crypto_control`/`device_event` is refused at **decode** with `ERROR_CODE_PROTOCOL_VIOLATION` (11) | `lib/ccwire/codec.selftest.ts` |
| 20.8 | …and at **encode**, so this process cannot emit one either — while `typing_state` in an EPHEMERAL frame still encodes | **`scripts/acceptance.selftest.ts` §A3 — new** |
| 20.9 | The limit set is **collectively** satisfiable: `max_fragments_per_message × max_frame_bytes ≥ max_message_body_bytes` (16 × 256 KiB ≥ 1 MiB), opaque < frame, string < opaque, negotiated < hard ceiling. Individually-correct limits can still make a legal message unsendable; nothing checked the arithmetic between them. | **`scripts/acceptance.selftest.ts` §A3 — new** |

### Metadata privacy — the allow-list has one definition in four places

`proto/ccwire/v1/envelope.proto` states, inside `message PublicMeta`:

> *"The cross-language assertion in msgEnvelope.selftest.ts (which reads the Go
> source) MUST be extended to read this .proto as a third source of truth —
> otherwise CC-Wire becomes the drift path the selftest exists to prevent."*

It had not been. 20.13–20.15 are that extension.

| # | Criterion | Where |
|---|---|---|
| 20.12 | `META_PUBLIC_KEYS` (TS, what is sent) = `jobs.MetaPublicKeys` (Go, what is kept) | `lib/msgEnvelope.selftest.ts` |
| 20.13 | `PublicMeta` in `envelope.proto` = `META_PUBLIC_KEYS`, exactly — 14 keys, snake↔camel. A field added to the `.proto` alone is a server-visible metadata leak that ships silently. | **`scripts/acceptance.selftest.ts` §A4 — new** |
| 20.14 | The CC-Wire decoder (`codec.ts` `interface PublicMeta`) types exactly those fields, so none can survive the `.proto` and the allow-list yet vanish on the wire | **`scripts/acceptance.selftest.ts` §A4 — new** |
| 20.15 | `PublicMeta` field numbers are `1..n`, contiguous, no gap and no reuse | **`scripts/acceptance.selftest.ts` §A4 — new** |
| 20.16 | The server stamps the authenticated uid on typing and on every peer relay, and re-reads neither from the client payload | `go test ./internal/realtime/` (`payload_bounds_test.go`) |
| 20.17 | Server-side payload bounds are enforced on the live Socket.IO path | `go test ./internal/realtime/` |

### The database — schema and row-level security

These two need a Postgres, and nothing more than a Postgres. They were in
bucket (b) until 2026-09-14 on the mistaken grounds that a database means a
live server. Both were run against the throwaway cluster above.

| # | Criterion | Where |
|---|---|---|
| 20.23 | Every migration applies cleanly, and every `vaultchat-backend/migrations/tests/*.sql` passes. **Run: all 132 migration files applied with no error (the numbering runs to 133; `schema_migrations` holds 132), then 17/17 test files PASS.** | `node vaultchat-backend/migrate.js up`, then `MIGRATION_TESTS=1 MIGRATION_TEST_PORT=55434 MIGRATION_TEST_PASS=… node scripts/test-migrations.js` |
| 20.18 | Row-level security denies cross-tenant reads. **Run: PASS.** With the app role connecting as non-owner `vaultchat_app`, the refusal arrives as a 404 — the row is *invisible*, the handler's own check never runs — on attachments, view-once burn, attachment revoke, chat fetch, another member's message edit/delete, and another user's session. On the chat-member list endpoints the handler's 403 fires first; the test asserts "Alice gets no 2xx" and names which gate answered, so both outcomes are recorded rather than assumed. | `psql … -v app_pass=… -v sys_pass=… -f scripts/rls-roles.sql`, then `CALL_TEST_DB=1 DB_USER=vaultchat_app … CALL_TEST_ADMIN_DSN=… go test ./internal/routes/ -run 'TestCrossTenant\|TestBookmark\|TestCallSession' -v` |

> **§20.23 did not pass on the first run, and that is the whole argument for
> moving it.** Two defects, both invisible to a criterion nobody executes:
>
> * `migrations/tests/111_khata_walkin_test.sql` caught `foreign_key_violation`
>   (23503) around a delete it expects `ON DELETE RESTRICT` to refuse. RESTRICT
>   raises `restrict_violation` (**23001**); 23503 is what NO ACTION raises. So
>   the error the section exists to prove escaped the handler and aborted the
>   whole file. The constraint was doing its job perfectly. **Fixed** — the
>   handler now names both sqlstates, and the `RAISE EXCEPTION` guarding a
>   delete that *succeeds* is P0001 and still uncaught, so the assertion is
>   exactly as strong as before.
> * `internal/routes/cross_tenant_test.go` seeded `attachments` without
>   `purpose`, which a later migration made `NOT NULL` with no default: the
>   fixture failed 23502 before any assertion ran. **Fixed** (`'chat'`).
>
> Neither was a schema bug. Both were tests that had never been executed, which
> is precisely what an acceptance criterion in the wrong bucket produces.

### App shell

| # | Criterion | Where |
|---|---|---|
| 20.19 | Every one of the 193 files under `app/` has a default export — expo-router mounts by filename, so a file without one is a route that crashes on arrival | **`scripts/acceptance.selftest.ts` §A5 — new** |
| 20.20 | All 132 statically-written navigation targets (`router.push/replace/navigate`, `pathname:`, `<Link href>`) resolve against the 190-route filesystem table, honouring group segments `(tabs)`, dynamic `[id]`, catch-all `[...rest]` and query strings | **`scripts/acceptance.selftest.ts` §A5 — new** |
| 20.22 | The frozen backend contract (`contract/endpoints.json`, `socket-events.json`) still matches source | `node scripts/test-all.js` (final step) |

> **Every source-reading assertion above strips comments first.** This repo
> writes each rule next to the code implementing it, so a raw substring search
> matches the *prose describing* the rule and passes on a file that has lost it.
> The bug has bitten repeatedly — see `stripLineComments` in
> `vaultchat-backend-go/internal/realtime/payload_bounds_test.go`. §A1 of the
> selftest asserts the stripper still strips, because everything after it is only
> as strong as that.

---

## Not mechanisable

| # | Criterion | Why not |
|---|---|---|
| 20.21 | *No screen is orphaned* — every route has something linking to it | The inverse of 20.20, and it is a judgement call, not a check. Tab screens are reached by the tab bar, `app/i/[token]`, `app/join/[code]` and `app/live/join/[code]` by deep link, and a real fraction of targets are built from variables (`router.push(next)`) and are unknowable statically. An assertion here would either be a frozen allow-list of "known orphans" that nobody prunes, or a wall of false positives that gets skipped. Listed as **not run** rather than asserted with a weaker proxy. |

---

## (b) Needs a **deployed** server — NOT RUN

Four left. Every one of them needs the shipped binary answering at a URL — not a
database, which is what §20.18 and §20.23 turned out to need and why they are
now in (a). This session has no production access.

| # | Criterion | Exact command |
|---|---|---|
| 20.24 | `/auth/mpin/set` refuses an unauthenticated MPIN set — the account-takeover gate | `curl -sS -o /dev/null -w '%{http_code}\n' -X POST https://api.corefinite.com/auth/mpin/set -H 'Content-Type: application/json' -d '{"userId":"00000000-0000-0000-0000-000000000000","mpin":"246813"}'` → must be **401**. 200 or 404 means the old binary is live. |
| 20.25 | The policy pages Google fetches during review are served | `curl -sI https://api.corefinite.com/privacy \| head -1` and `curl -sI https://api.corefinite.com/delete-account \| head -1` → both **200** |
| 20.26 | Socket authorization rejects an unentitled sender | deploy `scripts/deploy-socket-authz.sh`, then the socket probes in `vaultchat-backend/loadtest/` |
| 20.27 | The realtime layer holds at target concurrency | `node vaultchat-backend/loadtest/diag.js` against a deployed stack — prior results in `loadtest/P1_LIVEWS_SCALABILITY_REPORT.md`, which is a **record of a past run, not evidence about the current build** |

---

## (c) Needs two real handsets — NOT RUN

Manual, and deliberately so: this project's history is emphatic that reading the
code produces the wrong answer where devices are involved. The steps are already
written and are **not duplicated here** — follow them in place:

* **[GO_LIVE_SMOKE_TEST.md](GO_LIVE_SMOKE_TEST.md)** — twenty minutes, two phones, run after
  `scripts/deploy-auth-fix.sh` and before promoting the Play release.
* **[MIUI_TEST_CHECKLIST.md](MIUI_TEST_CHECKLIST.md)** — Redmi Note 8 Pro / MIUI V125 / Android 11.
  **Phase 0 first**: four later steps cannot pass without it and MIUI reports no
  error when they fail, it simply does nothing.

| # | Criterion | Steps |
|---|---|---|
| 20.28 | Fresh signup end to end on a new install: email OTP → profile → 5 security questions → MPIN → Chats; force-quit, reopen, unlock | GO_LIVE_SMOKE_TEST §1 |
| 20.29 | Messaging survives the re-key loop: both directions, 5 minutes idle, then force-quit both and again; no wall of "unable to decrypt" in scrollback. `adb logcat \| grep -i e2ee` — alternating resets on a repeating cycle is the old bug | GO_LIVE_SMOKE_TEST §2 |
| 20.30 | Call teardown: with A↔B connected, a third caller reaches B; the first call ends and **the second stays connected ≥ 30 s** | GO_LIVE_SMOKE_TEST §3 |
| 20.31 | Locked-screen ringing shows a full call screen, not a banner; the amber "Full-screen calls" onboarding row self-clears once granted | GO_LIVE_SMOKE_TEST §4, MIUI Phase 4 |
| 20.32 | Back during a call goes to picture-in-picture rather than hanging up | GO_LIVE_SMOKE_TEST §3 |
| 20.33 | MIUI autostart / battery / lock-screen / pop-up / notification-channel gates, then cold launch, login, messaging, calls | MIUI_TEST_CHECKLIST Phases 0–4 |
| 20.34 | Account deletion is irreversible — the account cannot be logged back into or recovered via security questions. **Throwaway account only.** | GO_LIVE_SMOKE_TEST §5 |

---

## (d) Needs a Mac and an Apple Developer account — NOT RUN

Neither exists in this session. Full dependency order, with estimates, in
[IOS_PARITY.md](IOS_PARITY.md); the backend is already iOS-ready (`internal/fcm/fcm.go`
sends APNs VoIP headers), so every gap below is device plus credentials.

| # | Criterion | Blocked on |
|---|---|---|
| 20.35 | An iOS build exists and launches | Apple Developer account; `eas build -p ios` (EAS cloud needs no Mac, the account is still required) — IOS_PARITY §1–2 |
| 20.36 | A backgrounded 1:1 call keeps its audio session | CallKit, needs a Mac — IOS_PARITY §3 |
| 20.37 | A killed app receives an incoming call | PushKit, needs a Mac — IOS_PARITY §3 |
| 20.38 | The Rust crypto core runs on iOS (today iOS falls back to the TypeScript backend — correct and vector-proven, slower on large media) | `plugins/withCryptoCore.js` has no iOS branch; needs a Mac — IOS_PARITY §4 |
