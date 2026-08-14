-- 099_message_bodies.sql — the ephemeral ciphertext store. Idempotent.
--
-- WHY A SECOND TABLE, AND NOT PARTITIONING `messages`
-- ---------------------------------------------------
-- `messages` is the application's durable SPINE, not a mailbox. Six foreign
-- keys point at messages(id) — chats.last_message_id, messages.reply_to_id
-- (self), scheduled_messages.{message_id,reply_to_id}, bookmarks.message_id
-- (CASCADE) and poll_votes.message_id (CASCADE) — plus four non-FK pointers
-- (chat_members.last_read_message_id / last_delivered_message_id,
-- chats.pinned_message_id, chat_device_delivery.last_delivered_message_id).
--
-- Three facts make partitioning `messages` itself the wrong move:
--
--   1. Every unique constraint on a partitioned table must contain the
--      partition key, so messages_pkey(id) would become (id, created_at) and
--      all six FKs would have to become composite — a schema change to four
--      other tables.
--   2. PARTIAL unique indexes are not supported on partitioned tables at all.
--      ux_messages_client_dedup (chat_id, sender_id, client_id) WHERE
--      client_id IS NOT NULL is the clientId send-idempotency guarantee (F7).
--      Partitioning `messages` would DELETE that guarantee.
--   3. DROP TABLE on a partition does NOT fire FK actions. The CASCADE on
--      bookmarks/poll_votes and the SET NULL on chats.last_message_id would be
--      silently bypassed by the very mechanism the retention policy relies on.
--
-- So the ciphertext moves out instead. `messages` keeps its shape, its FKs and
-- its idempotency index; this table holds the part that must not survive, has
-- NO inbound foreign keys (which is exactly what makes DROP PARTITION legal),
-- and is partitioned hourly so expiry is a catalog operation rather than a
-- DELETE sweep.
--
-- Why that distinction matters more than it looks: the current mechanism
-- (UPDATE messages SET content = NULL) leaves the OLD heap tuple — ciphertext
-- and all — in the table until autovacuum gets to it. DROP PARTITION removes
-- the bytes. The table split is a security improvement, not just a schema one.
--
-- WHAT THIS MIGRATION DOES NOT DO
-- -------------------------------
-- It does not backfill. Existing messages keep their content in
-- `messages.content` and drain through the retention path that already exists
-- (DELETE_ON_DELIVERY_MAX_AGE_DAYS). Nothing is destroyed here, and this file
-- is reversible with DROP TABLE.
--
-- It also does not switch any writer over. Bodies are written only once
-- MESSAGE_BODIES=1 is set on go-api (a later, separately-gated step). Applying
-- this migration alone changes no behaviour whatsoever.

-- ── the ephemeral body ──────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS message_bodies (
  -- Deliberately NOT a foreign key to messages(id).
  --
  -- An FK here would make the child partition depend on the parent row, and
  -- Postgres would then have to validate on DROP — which is the operation this
  -- whole design exists to keep cheap. Referential integrity is instead
  -- one-directional and enforced by the writer: a body is only ever inserted
  -- in the same transaction as its spine row.
  message_id      BIGINT      NOT NULL,

  -- Denormalised from messages.chat_id so the RLS policy below can be the SAME
  -- predicate as messages_select (vc_is_chat_member) rather than a subquery
  -- join back to messages on every read. Also lets a per-chat purge run without
  -- touching the spine.
  chat_id         UUID        NOT NULL,

  -- The partition key. Copied verbatim from messages.created_at, which is
  -- server-generated (DEFAULT NOW()) and never updated — an edit stamps
  -- edited_at and leaves created_at alone. That immutability is what makes
  -- partition routing deterministic and expiry predictable.
  created_at      TIMESTAMPTZ NOT NULL,

  -- The opaque E2EE ciphertext. The server never reads it.
  content         TEXT,

  -- Private message metadata that must NOT outlive the body: thumbnail,
  -- filename, mime, poll options, mentions, waveform, dimensions. The spine
  -- keeps only routing metadata (attachmentId, replyToId, announcement,
  -- audience, silent, size). Populated by a later step; NULL until then.
  meta_private    JSONB,

  -- The hard server-side lifetime of this ciphertext.
  --
  -- SEPARATE FROM messages.expires_at ON PURPOSE. That column means
  -- "disappearing / vanish-after-read" — a USER-VISIBLE product feature that
  -- hides the message from everyone, is NULL for ordinary messages, and is
  -- filtered in every read path. This column is an INFRASTRUCTURE retention
  -- bound on the server's copy only. Conflating them would make every message
  -- vanish from the user's chat at the 3-hour mark, which is the exact opposite
  -- of the requirement.
  --
  -- Set by the server from created_at. Never accepted from client input.
  body_expires_at TIMESTAMPTZ NOT NULL,

  PRIMARY KEY (message_id, created_at)
) PARTITION BY RANGE (created_at);

-- The hard ceiling, enforced by the database rather than by the caller.
--
-- A CHECK rather than a GENERATED column: generated would pin the window in the
-- schema, and the rollout deliberately starts with a generous window and
-- tightens to 3h only once ACK deletion and the sender outbox are proven. This
-- caps the maximum while leaving a shorter window legal, so no code path —
-- including a buggy one, a replayed request, or a client-supplied timestamp —
-- can produce a body that outlives its message by more than three hours.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'message_bodies_ttl_cap'
  ) THEN
    ALTER TABLE message_bodies
      ADD CONSTRAINT message_bodies_ttl_cap
      CHECK (body_expires_at <= created_at + INTERVAL '3 hours');
  END IF;
END $$;

-- ── partition management ────────────────────────────────────────────
-- One function, used by BOTH this migration and the Go worker
-- (internal/jobs/partitions.go), so the naming and bounds can never drift
-- between "what the migration created" and "what the worker expects".
--
-- Hour bounds are computed in UTC explicitly. date_trunc('hour', ts) alone
-- truncates in the SESSION TimeZone, so a server whose timezone changed would
-- silently start producing partitions on a different boundary than the ones
-- already there — and the overlap would only surface as a failed INSERT during
-- a message send.
CREATE OR REPLACE FUNCTION vc_message_bodies_ensure_partition(p_ts TIMESTAMPTZ)
RETURNS TEXT
LANGUAGE plpgsql
AS $fn$
DECLARE
  lo TIMESTAMPTZ;
  hi TIMESTAMPTZ;
  nm TEXT;
BEGIN
  lo := (date_trunc('hour', p_ts AT TIME ZONE 'UTC')) AT TIME ZONE 'UTC';
  hi := lo + INTERVAL '1 hour';
  nm := 'message_bodies_' || to_char(lo AT TIME ZONE 'UTC', 'YYYYMMDDHH24');
  BEGIN
    EXECUTE format(
      'CREATE TABLE IF NOT EXISTS public.%I PARTITION OF public.message_bodies '
      'FOR VALUES FROM (%L) TO (%L)', nm, lo, hi);
  EXCEPTION WHEN duplicate_table THEN
    -- Two workers (or a worker and an on-demand insert) raced. IF NOT EXISTS
    -- checks the NAME, and the name is derived from the bounds, so whoever won
    -- created exactly the partition we wanted. Nothing to repair.
    NULL;
  END;
  RETURN nm;
END;
$fn$;

-- Seed a window around now so the table is immediately usable: one hour behind
-- (a message committing across the hour boundary), and 48 hours ahead so a
-- worker outage of up to two days cannot stall message sends.
DO $$
DECLARE
  h INT;
BEGIN
  FOR h IN -1..48 LOOP
    PERFORM vc_message_bodies_ensure_partition(NOW() + (h || ' hours')::INTERVAL);
  END LOOP;
END $$;

-- ── row level security ──────────────────────────────────────────────
-- Same predicate as messages_select, which is why chat_id is denormalised
-- above. Writes are sender-bound exactly like messages_insert.
--
-- Note this is defence in depth, not the primary control: the API currently
-- connects as a superuser, so every policy in this database is bypassed until
-- DB_SYSTEM_USER + scripts/enable-rls-force.sql are in place (see
-- internal/db/db.go). The handler check is authoritative either way.
ALTER TABLE message_bodies ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS message_bodies_select ON message_bodies;
DROP POLICY IF EXISTS message_bodies_insert ON message_bodies;
DROP POLICY IF EXISTS message_bodies_update ON message_bodies;
DROP POLICY IF EXISTS message_bodies_delete ON message_bodies;

CREATE POLICY message_bodies_select ON message_bodies FOR SELECT
  USING (vc_is_chat_member(chat_id));
CREATE POLICY message_bodies_insert ON message_bodies FOR INSERT
  WITH CHECK (vc_is_chat_member(chat_id));
CREATE POLICY message_bodies_update ON message_bodies FOR UPDATE
  USING (vc_is_chat_member(chat_id));
CREATE POLICY message_bodies_delete ON message_bodies FOR DELETE
  USING (vc_is_chat_member(chat_id));

DO $$
BEGIN
  RAISE NOTICE 'message_bodies created (hourly partitions, no inbound FKs).';
  RAISE NOTICE 'No backfill performed — existing messages.content is untouched.';
  RAISE NOTICE 'No writer switched over — set MESSAGE_BODIES=1 on go-api to begin writing bodies.';
END $$;
