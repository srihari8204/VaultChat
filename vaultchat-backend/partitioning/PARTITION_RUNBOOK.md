# Partitioning `messages` — staged runbook (P4.1)

**These files are NOT auto-run migrations.** Partitioning a live `messages`
table is a data-rewriting operation with a constraint conflict that must be
resolved first. Auto-running it from `migrate.js` on deploy would either lock
the table for the duration of a full copy or — worse — silently drop the
send-dedup guarantee. Run the stages manually, in order, in a maintenance
window, after testing on a copy of production data.

## Why this cannot be a blind migration

Analysis of the live schema (migrations 001–064):

1. **Seven inbound foreign keys reference `messages(id)`:**
   `messages.reply_to_id` (self), `chats.last_message_id`,
   `reactions.message_id` (CASCADE), `scheduled_messages.reply_to_id`,
   `scheduled_messages.message_id`, `bookmarks.message_id` (CASCADE),
   `poll_*.message_id` (CASCADE). Postgres 16 supports FKs *to* a partitioned
   table, so these survive **only** if `id` remains a global unique key —
   which forces `PARTITION BY RANGE (id)` (the partition key must be part of
   the primary key).

2. **The idempotency index conflicts with any partition scheme except one.**
   Migration 055 creates `UNIQUE (chat_id, sender_id, client_id) WHERE
   client_id IS NOT NULL`, and the hot insert path relies on it directly:
   `chats_helpers.go` sends `ON CONFLICT (chat_id, sender_id, client_id)
   WHERE client_id IS NOT NULL DO NOTHING`. On a partitioned table every
   unique index must include the partition key:
   - Range-by-`id` keeps the PK and all FKs, but **cannot host this unique
     index** (it lacks `id`… and adding `id` to it destroys its meaning).
   - Hash-by-`chat_id` could host it, but **breaks every inbound FK** (no
     global unique on bare `id`).

   Resolution: move dedup into a small dedicated table (Stage 1) so the
   unique constraint no longer lives on `messages` at all. Then range-by-`id`
   partitioning is pure DDL + copy (Stage 2).

## Stage 1 — dedup side-table (safe online; ship first)

`stage1_dedup_table.sql` creates:

```sql
message_client_ids (
  chat_id, sender_id, client_id, message_id,
  PRIMARY KEY (chat_id, sender_id, client_id)
)
```

backfills it from existing rows, and keeps it small with a retention sweep
(dedup only matters across retry windows — days, not forever).

**Requires a code change in `chats_helpers.go` `chatsMessagePost`:** insert
into `message_client_ids` first (`ON CONFLICT DO NOTHING`); on conflict fetch
the existing message by `message_id` — instead of the current `ON CONFLICT`
against the 055 index. Both orders (side-table first vs message first) were
considered: side-table-first inside the same transaction is race-free (two
concurrent retries serialize on the PK) and leaves no orphan on rollback.
Only after that code change is deployed and soaked may the 055 index be
dropped (`stage1` includes the DROP, commented out — uncomment on the second
pass).

## Stage 2 — the partition swap (maintenance window)

`stage2_partition_swap.sql`, parameterized by `:span` (rows per partition,
default 10 M):

1. `messages` → `messages_old` (rename, instant).
2. Create `messages` as `PARTITION BY RANGE (id)`, same columns, PK `(id)`,
   partitions covering `[0 .. max(id) + 2×span)`, plus a `DEFAULT` partition
   as a safety net.
3. Recreate every index (`chat_id, id DESC`; `expires_at` partial;
   edited/deleted partials from 064; vanish partial) — partitioned indexes,
   built per-partition.
4. `INSERT INTO messages SELECT * FROM messages_old` (the copy — this is the
   window; ~1–5 min/GB on typical hardware).
5. Re-point the sequence, revalidate FKs, re-apply RLS policies (RLS does
   not follow a rename), `ANALYZE`.
6. Keep `messages_old` until verification passes, then drop.

Rollback (any point before the old table is dropped): rename back.

## Stage 3 — steady state

- `vc_ensure_message_partitions()` (in `stage2`) creates the next range
  partition when `max(id)` approaches the current ceiling. Wire it into the
  Go jobs ticker (one `SELECT vc_ensure_message_partitions()` per hour) —
  see the `jobs.go` TODO marker.
- Partition pruning now serves the hot paths: keyset history reads
  (`chat_id, id DESC LIMIT n`) touch only the newest partitions; delta
  catch-up (`id > since`) prunes to the tail; the disappearing-message sweep
  batches stay inside a partition.
- Old-partition archival (DETACH + dump) becomes possible when retention
  policy allows.

## When to actually do this

Not before the table hurts: partitioning below ~50–100 GB of messages buys
little and costs a maintenance window. The bounded sweeps + 064 indexes
(shipped as normal migrations) keep the unpartitioned table healthy until
then. Revisit when `pg_total_relation_size('messages')` crosses ~50 GB or
autovacuum on `messages` becomes visible in monitoring.
