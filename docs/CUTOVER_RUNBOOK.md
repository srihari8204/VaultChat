# Cutover — Hetzner → DigitalOcean Kubernetes

The database has real users and sits at migration 126. Everything up to §5 runs
alongside production and changes nothing; §5 is the only step that touches it.

---

## The governing fact

**The domain does not move. The origin does.**

`api.corefinite.com` is already a Cloudflare-*proxied* record, so switching
origin is an edge change that takes effect in seconds with no client-side DNS
TTL exposure. `api.crazzychat.com` is an **additional** hostname on the same
ingress and the same load balancer — never a replacement.

That matters because `constants/server.ts:9` hardcodes
`https://api.corefinite.com` as a **compile-time constant with no environment
override**, and `app.json` pins an Android App Links filter to the same host.
There is no forced-upgrade mechanism. Every APK ever shipped reaches the backend
only by that name, so that name serves from the new cluster **indefinitely**.

---

## 1. Pre-flight audit — run against production before scheduling anything

Run these against the **container**, not the host cluster. `DEPLOY_OPERATIONS.md`
records that the host copy is a stale 2026-07 database at migration 060 and has
already misled one deploy.

```bash
dc exec postgres psql -U vaultchat -d vaultchat
```

```sql
-- 1. Confirm the ledger. Expect 126.
SELECT max(version) FROM schema_migrations;

-- 2. Tables without a primary key: logical replication skips these entirely
--    unless REPLICA IDENTITY FULL is set.
SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
 WHERE n.nspname = 'public' AND c.relkind = 'r'
   AND NOT EXISTS (SELECT 1 FROM pg_index i WHERE i.indrelid = c.oid AND i.indisprimary);

-- 3. How many attachments still live on local disk rather than object storage.
--    Every one of these 404s after the cut unless it is backfilled.
SELECT coalesce(storage_backend,'disk') AS backend,
       count(*), pg_size_pretty(sum(size_bytes))
  FROM attachments GROUP BY 1;

-- 4. Sequences. Logical replication does NOT carry sequence values.
SELECT sequence_schema, sequence_name FROM information_schema.sequences;
```

---

## 2. Build the new stack (no production impact)

1. `terraform apply` in `deploy/terraform`.
2. Bootstrap per `deploy/bootstrap/README.md`.
3. Deploy the app charts against a **restored copy** of the database — not the
   live replica — and run `docs/GO_LIVE_SMOKE_TEST.md` end to end.

---

## 3. Data

### Postgres — logical replication

Enable `wal_level=logical` on the Hetzner container and restart it. **This is
the one unavoidable production restart**: roughly ten seconds, and Socket.IO
clients reconnect on their own. Do it in a quiet window, days ahead, on its own.

Then start DigitalOcean's "migrate from an external database".

Three things generic advice will not tell you:

- **Sequences are not replicated.** Script a `setval()` pass at cutover from
  Hetzner's `last_value`. Miss it and the first insert into any table with a
  serial key collides.
- **Tables without a primary key are not replicated** unless you set
  `REPLICA IDENTITY FULL`. Audit query 2 lists them.
- **`message_bodies` is hourly-partitioned** and needs
  `publish_via_partition_root = true`; even then the publication churns as
  partitions rotate. Given `MESSAGE_BODY_TTL_SECONDS` is ~3 hours and the table
  is ephemeral by design, **exclude it and accept losing up to 3 hours of
  undelivered message bodies**. That is the honest trade; the alternative is a
  replication setup that breaks every hour.

> **Do not reuse `scripts/backup-postgres.sh` for this.** It deliberately passes
> `--exclude-table-data="message_bodies*"`, so a migration built on it would
> silently arrive with no message ciphertext at all.

### Valkey — nothing to migrate

Presence (`vc:pres:*`), rosters, call sets, rate-limit windows and the Socket.IO
adapter's pub/sub are all ephemeral and rebuild on reconnect. `workx` is an
in-memory channel, not a Redis queue. Start empty.

### Objects

- **Chat media stays on Cloudflare R2.** It is already there, egress is free,
  and moving it would re-sign every URL for nothing.
- **Broadcast HLS** → `rclone sync` MinIO into the Spaces bucket, then a delta
  sync at cutover.
- **Legacy disk attachments** → `rclone sync` `uploads-shared/` into the media
  bucket **preserving the exact relative path**, because `storage_path` is used
  as the object key verbatim. Then:
  ```sql
  UPDATE attachments SET storage_backend = 's3'
   WHERE storage_backend IS DISTINCT FROM 's3';
  ```
  Verify **completely**, not by sampling — any row you miss returns
  `404 "File missing on disk"`.

---

## 4. Warm-up (days before the cut)

- `api.crazzychat.com` → the DO load balancer, exercised with a debug build and
  the existing load scripts in `vaultchat-backend/loadtest/`.
- **Move TURN early and separately.** `TURN_HOST` is a server-controlled
  environment variable returned by `GET /user/turn`, so installed apps follow
  whatever the backend says — no new build needed. But credentials carry a
  24-hour TTL and the app caches them, so **keep the Hetzner coturn running for
  at least 48 hours** after the flip or calls started on cached credentials
  fall back to STUN-only and fail behind symmetric NAT.

---

## 5. The cut (~20 minutes)

1. Hetzner nginx → maintenance 503 for `api.corefinite.com`. Clients show
   "reconnecting"; Socket.IO retries indefinitely.
2. Wait for replication lag to reach 0. Stop replication, promote.
3. Run the `setval()` script.
4. `migrate status` against DO must read **126**. Then `migrate up`.
5. Final delta `rclone sync` + the `attachments` backfill UPDATE.
6. Flip the Cloudflare origin records for `api.corefinite.com` and
   `stream.corefinite.com` to the DO load balancer. Proxied, so effectively
   instant.
7. Watch: `vaultchat_sockets_local` climbing across pods, 5xx flat,
   `vaultchat_message_bodies_overdue` at 0.

---

## 6. Rollback, honestly

Rollback is "flip the Cloudflare record back" — **but only while the Hetzner
database is still a valid copy.** The moment DigitalOcean accepts one write, a
flip back silently loses it.

So: **arm reverse logical replication (DO → Hetzner) immediately after step 6**
and keep it for 48 hours. Define a hard point of no return — T+2h is reasonable
— after which rollback is a restore-from-backup with a real RPO, not a DNS
change.

Keep the Hetzner box intact and running, just not serving, for 14 days.
`docker-compose.box.yml` **is not in git** — snapshot it, along with
`vaultchat-backend/.env`, `secrets/` and `/etc/nginx/sites-enabled/`, before
touching anything.

---

## What stays behind

| Thing | Why |
|---|---|
| `games.corefinite.com` | A separate Go binary at `/opt/vaultgames` whose source is not in this repo. Keeps its own droplet; `internal/routes/games.go` only mints launch tokens. |
| `admin.corefinite.com` | `admin/logserver.py` exists to tail `docker compose` logs on a box that will no longer exist. Superseded by Loki + Grafana; retire it. |
| Valhalla | Already non-functional in production — no OSM extract is loaded. Not on the critical path. |
