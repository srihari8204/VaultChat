# Deploy: migration 121 + vanish-mode fix

> ## ✅ BOTH SHIPPED — verified on prod 2026-09-12
> | Item | Evidence |
> |---|---|
> | Migration 121 | `schema_migrations` row `121 / 121_run_delay_threshold.sql` applied `2026-09-12 07:35:20 UTC`; `chats.run_delay_threshold_minutes` present (`integer NOT NULL DEFAULT 10`); versions 100–127 = 28 rows, no gap |
> | Vanish fix | `vaultchat-go-api` image built 13:06 IST 2026-09-12 (source patched 11:22); running `/bin/api` binary contains the `cm3` guard; container up on that image |
> | Health | `https://api.corefinite.com/health` → 200 |
>
> Nothing below needs running again. The SQL and the compose rebuild are both
> idempotent, but re-running the rebuild is a pointless prod restart. Kept as
> the record of what was wrong and how it was fixed.
>
> `vaultchat-backend` (Node) does **not** run in prod — only `vaultchat-go-api-1`
> serves the API — so the `routes/chats.js` / `routes/user.js` fixes listed at the
> bottom are reference/rollback only, not a pending deploy.

## ~~🔴 MIGRATION 121 IS MISSING FROM PRODUCTION~~ — fixed, see banner above

```
prod schema_migrations : 100…120, [121 ABSENT], 122…127   (125 rows)
local                  : 100…127                          (126 rows)
prod chats.run_delay_threshold_minutes : MISSING
```

The live **Go** backend queries that column in three places:

| File | Line | Statement |
|---|---|---|
| `internal/routes/spaces_runs.go` | 329 | `SELECT run_delay_threshold_minutes FROM chats WHERE id = $1` |
| `internal/routes/spaces_runs.go` | 1384 | subquery inside the run-delay evaluator |
| `internal/routes/spaces_ops.go` | 617 | `UPDATE … run_delay_threshold_minutes = COALESCE(…)` |

So every one of those paths fails with **42703 undefined_column** on production today. That is the
Family Space "run delayed beyond threshold" feature — the driver-heartbeat evaluator that notifies
a guardian when the bus is late. It is broken in prod right now.

### Why nothing caught it

- `SELECT max(version)` returns `127` because `version` is **TEXT** — `'127' > '120'` lexically, so a
  gap at 121 is invisible to a max() check. (This is what made my earlier "127 is pending" report
  wrong: I compared max values, not set membership.)
- `migrate.js status` on the box reports **`0 pending`** — but the box's `vaultchat-backend/migrations/`
  holds only **106** files vs **126** locally, and the `api` service **bakes migrations into the image**
  (`build: context: ./vaultchat-backend`, no volume mount). The runner cannot see a file that is not
  in the image, so a missing migration reads as "nothing to do".

### The fix — one idempotent statement

`ALTER TABLE chats ADD COLUMN IF NOT EXISTS run_delay_threshold_minutes INT NOT NULL DEFAULT 10;`

Safe: PostgreSQL 16.14, constant default ⇒ metadata-only, no table rewrite. `chats` has **46 rows**.
`DEFAULT 10` matches the client's `isDelayed(…, thresholdMinutes = 10)`, so both sides agree
immediately.

```bash
ssh srihari@65.21.229.167
docker exec -i vaultchat-postgres-1 psql -U vaultchat -d vaultchat -v ON_ERROR_STOP=1 <<'SQL'
BEGIN;
ALTER TABLE chats ADD COLUMN IF NOT EXISTS run_delay_threshold_minutes INT NOT NULL DEFAULT 10;
INSERT INTO schema_migrations (version, filename, checksum)
VALUES ('121', '121_run_delay_threshold.sql', 'c8efb148bf98e65d')
ON CONFLICT (version) DO NOTHING;
SELECT 'column' AS what, count(*) FROM information_schema.columns
 WHERE table_name='chats' AND column_name='run_delay_threshold_minutes';
SELECT 'ledger' AS what, count(*) FROM schema_migrations WHERE version='121';
COMMIT;
SQL
```

Both SELECTs must return `1`.

The checksum `c8efb148bf98e65d` is not invented — it is `sha256(content with CRLF→LF).slice(0,16)`,
migrate.js's own algorithm, and it matches byte-for-byte what the local ledger recorded when the
runner applied this same file. So the ledger stays consistent and the existing drift check keeps
passing.

`121_run_delay_threshold.sql` has already been copied to the box's migrations directory, so a future
`api` image rebuild will also see it (and re-running it is harmless — `IF NOT EXISTS`).

### Also worth fixing

The box's migrations directory is 20 files behind the repo. Migrations are evidently applied from a
different checkout, which is exactly how 121 got skipped. Syncing that directory — or applying
migrations from one canonical place — would stop this recurring.

---

# Vanish-mode fix

> **Corrected 2026-09-12.** An earlier version of this file warned that migration 127 was pending
> on production and that rebuilding `go-api` would cause an auth outage. **That was wrong.**
> It came from seeing the *local* DB at 126 and inferring production matched. Verified directly:
>
> ```
> prod schema_migrations max(version) = 127
> refresh_tokens         → token_lookup, revoked_reason both present
> idx_refresh_lookup     → present
> VAULTCHAT_LOOKUP_PEPPER set on vaultchat-go-api-1 → yes
> ```
>
> Production is fully migrated. There is no ordering hazard and no pending-migration step.
> The only outstanding change is the vanish-mode fix below.

---

## The bug

`internal/routes/chats_helpers.go`, the `POST /chats/{id}/read` handler.

```sql
AND NOT EXISTS (
  SELECT 1 FROM chat_members cm2
   WHERE cm2.chat_id = m.chat_id
     AND cm2.user_id <> m.sender_id
     AND cm2.left_at IS NULL
     AND COALESCE(cm2.last_read_message_id, 0) < m.id
)
```

`NOT EXISTS` over an **empty set is vacuously TRUE**. In a chat with no other active member —
a self/saved-messages chat, or one whose only peer has `left_at` set — "every non-sender member
has read it" is satisfied trivially. The sender's own message gets `expires_at = NOW()` the moment
they mark the chat read, and the 5-minute sweep hard-deletes it. **Permanent data loss, with
nobody having read anything.**

Proven against a real Postgres (transaction rolled back):

| Scenario | message destroyed |
|---|---|
| OLD SQL, chat with no other active member | `t` |
| NEW SQL, same chat | `f` |
| NEW SQL, real peer who has read it | `t` (feature intact) |

## The fix

Add an `EXISTS` guard requiring at least one non-sender member before the all-read test can retire
a message. Applied locally to both backends; verified `go build` / `go vet` / `go test ./...`
(all 10 packages) and `node --check`.

---

## Deploying it

**The box's `chats_helpers.go` is locally modified and differs from git HEAD**, so do **not** scp
the workstation copy over it — that would discard those changes. Its vanish block is byte-identical
to the pre-fix version, so a surgical patch is safe.

A patch script is already uploaded to the box at **`/tmp/patch_vanish.py`**. It refuses to run
unless the anchor matches exactly once, refuses if already patched (`cm3` present), and writes a
`.bak` beside the file.

**STATUS: patch applied AND rebuilt — nothing remains.** The patch was applied on the box (verified — 4 `cm3` references present,
`chats_helpers.go.bak` written). Only the container rebuild remains.

### All THREE compose files are mandatory

`docker-compose.box.yml` is root-only (`0600`), so the rebuild needs `sudo` — `docker` group
membership is not enough to read it.

Do **not** shortcut to `-f docker-compose.yml -f docker-compose.prod.yml`. That parses and would
appear to work, but measured against the running container it drops **18 env vars** that only
`box.yml` supplies:

```
S3_ACCESS_KEY  S3_SECRET_KEY  S3_ENDPOINT  S3_BUCKET  S3_REGION  S3_PUBLIC_ENDPOINT
BROADCAST_S3_ACCESS_KEY  BROADCAST_S3_SECRET_KEY  BROADCAST_S3_ENDPOINT
VAULTBEAM_S3_ACCESS_KEY  VAULTBEAM_S3_SECRET_KEY  VAULTBEAM_S3_ENDPOINT
VAULTBEAM_S3_BUCKET  VAULTBEAM_S3_REGION  VAULTBEAM_S3_PUBLIC_ENDPOINT
MESSAGE_BODIES  TURN_HOST6  PATH
```

(70 env vars on the running container vs 51 from base+prod.) A `go-api` built that way comes up
with **no S3 configuration at all** — media upload/download, broadcasts and VaultBeam transfers
break. That is much worse than the bug being fixed.

### The rebuild command (already run 2026-09-12 13:06 IST — do not re-run)

```bash
ssh srihari@65.21.229.167
cd /home/srihari/vaultchat

sudo docker compose \
  -f docker-compose.yml -f docker-compose.prod.yml -f docker-compose.box.yml \
  up -d --build go-api
```

**Never add `--remove-orphans`** — `livekit-egress` runs on that box but is not in the compose file,
so compose treats it as an orphan and deletes the live transcoder.

### Verify

```bash
docker compose -f docker-compose.prod.yml logs --tail=50 go-api
curl -sS -o /dev/null -w '%{http_code}\n' https://api.corefinite.com/health
```

Then on a device: turn Vanish Mode on in a chat, send a message, and confirm it does **not**
disappear until the other person actually reads it.

### Rollback

```bash
cp vaultchat-backend-go/internal/routes/chats_helpers.go.bak \
   vaultchat-backend-go/internal/routes/chats_helpers.go
docker compose -f docker-compose.prod.yml up -d --build go-api
```

---

## Other fixes made locally, NOT yet on the box

These are in the workstation tree only. None is urgent; ship them whenever convenient.

| File | Change |
|---|---|
| `vaultchat-backend/routes/chats.js` | same vanish guard (rollback target) |
| `vaultchat-backend/routes/user.js` | `/user/export` no longer queries `message_reactions`, dropped by migration 056 — the endpoint 500s without this |
| `vaultchat-backend/migrations/127_refresh_token_lookup.sql` | a comment named `REFRESH_LOOKUP_PEPPER`; the code uses `VAULTCHAT_LOOKUP_PEPPER`. Comments only — DDL untouched, and 127 is already applied so no checksum impact |
| `vaultchat-backend/.env.example` | documents `VAULTCHAT_MASTER_KEY` + `VAULTCHAT_LOOKUP_PEPPER` and their blast radius |
| `.gitattributes` | widened `scripts/*.sh` → `*.sh`; two deploy scripts had no eol attribute |
| `DEPLOY_OPERATIONS.md` | removed three commands referencing a service deleted 29 migrations ago |

## Client side — already shipped

The other half of "my message disappears" is a client bug: the socket echo of your own message
beats the HTTP ack, producing a `content: null` row that the send-dedup then preferred over the
real bubble. Fixed in **APK 1.2.8 / versionCode 24**, already installed on the Honor.

Both halves were needed. The server bug deletes permanently; the client bug only blanked the live
screen (text returned on reopen).

## Still open, needs a decision

1. **`firestore.rules` is wide open** — `allow read, write: if request.auth != null` on all chat
   messages, plus a duplicate `users/{userId}` block that ORs away the owner-only rule. Firestore
   looks dead (zero Firebase client deps; Go uses Firebase for FCM only), but confirm the database
   is empty and delete it, or tighten the rules.
2. **No guardrail catches a pending migration.** `auth_session_identity_test.go` asserts the
   migration *file* exists — nothing asserts it was *applied*. It happened to be applied this time.
   A startup assertion in `go-api` would make that structural rather than lucky.
3. **`S3_PUBLIC_ENDPOINT` compose default is `http://…:19000`** — plaintext HTTP on a bare IP for
   presigned media, while nginx already proxies it over HTTPS. One `docker inspect` settles whether
   prod actually serves media unencrypted.
