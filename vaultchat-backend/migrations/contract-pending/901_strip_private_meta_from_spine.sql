-- 901_strip_private_meta_from_spine.sql — CONTRACT PHASE. NOT APPLIED.
--
-- ══════════════════════════════════════════════════════════════════════════
-- DESTRUCTIVE, AND THAT IS THE INTENT. REVIEW BEFORE RUNNING.
--
-- This statement PERMANENTLY DELETES data from `messages.meta` on rows that
-- already exist. There is no undo inside the database. Take a verified backup
-- first and keep it until you are satisfied — see contract-pending/README.md.
--
-- It is in contract-pending/ precisely so the migration runner does not pick it
-- up. Do not move it into migrations/ to "just apply it".
-- ══════════════════════════════════════════════════════════════════════════
--
-- WHAT IT REMOVES, AND WHY
--
-- `messages.meta` is plaintext JSONB that the server reads and stores forever.
-- Until the fix that accompanies this file, the whole client-supplied meta
-- object landed there, including `thumb` — a base64 JPEG preview of every photo
-- and video sent through the service. A production sample found 22 of 24
-- image/video messages carrying a server-readable preview, and 57 rows carrying
-- a filename.
--
-- The write path is now fixed (routes.chatsSpineMeta applies the allow-list
-- unconditionally, on every send, regardless of the MESSAGE_BODIES flag), so no
-- NEW row can carry a preview. This file is the one-off for rows written before
-- that fix. Without it the leak is frozen, not closed.
--
-- THE ALLOW-LIST IS THE SAME ONE THE CODE USES
--
-- jobs.MetaPublicKeys, copied here as a literal because a migration cannot call
-- into Go. If you change one, change the other — the whole point of the single
-- definition in internal/jobs/meta_public.go is that the writer, the
-- delete-on-delivery sweep and this backfill cannot disagree about what is
-- private. Verify before running:
--
--   grep -A14 'var MetaPublicKeys' vaultchat-backend-go/internal/jobs/meta_public.go
--
-- Two keys are DERIVED rather than kept, exactly as chatsSplitMeta derives them,
-- so features keep working after the text they were computed from is gone:
--
--   optionCount     the poll vote handler bounds-checks optionIndex against it
--                   and falls back to length(options). Strip `options` without
--                   deriving this and voting breaks on every existing poll.
--   mentionUserIds  chatsSendMessagePush overrides a MUTED chat for mentioned
--                   users and reads only userId, so the ids survive and the
--                   display names do not.
--
-- PRE-FLIGHT — run these first, and record the numbers.
--
--   -- How many rows are about to lose data, and what the leak actually is.
--   SELECT count(*) FROM messages WHERE meta ? 'thumb';
--   SELECT count(*) FROM messages WHERE meta ?| ARRAY['thumb','filename','mime','options','mentions'];
--   SELECT count(*) FROM messages
--    WHERE meta IS NOT NULL
--      AND EXISTS (SELECT 1 FROM jsonb_each(meta) e
--                   WHERE e.key <> ALL (ARRAY[ /* the allow-list below */ ]));
--
--   -- Sanity: polls and mentions must survive the derivation.
--   SELECT count(*) FROM messages WHERE jsonb_typeof(meta->'options')  = 'array';
--   SELECT count(*) FROM messages WHERE jsonb_typeof(meta->'mentions') = 'array';
--
-- RUN IT IN BATCHES. A single UPDATE rewrites every matching row in one
-- statement: one lock, one WAL burst, and a long transaction on the hottest
-- table in the database. The LIMIT below is the batch; repeat until it reports
-- 0 rows. This mirrors sweepDeliveredMessages, which batches for the same reason.

BEGIN;

UPDATE messages m
   SET meta = (
         SELECT COALESCE(jsonb_object_agg(e.key, e.value), '{}'::jsonb)
           FROM jsonb_each(m.meta) AS e
          WHERE e.key = ANY (ARRAY[
                  'attachmentId','viewOnce','revoked',
                  'announcement','audience','silent',
                  'groupId','gifUrl',
                  'allowMultiple','optionCount',
                  'mentionUserIds','encrypted',
                  'game','room'
                ])
       )
       || CASE WHEN jsonb_typeof(m.meta->'options') = 'array'
               THEN jsonb_build_object('optionCount', jsonb_array_length(m.meta->'options'))
               ELSE '{}'::jsonb END
       || CASE WHEN jsonb_typeof(m.meta->'mentions') = 'array'
               THEN jsonb_build_object('mentionUserIds', (
                      SELECT COALESCE(jsonb_agg(x->>'userId'), '[]'::jsonb)
                        FROM jsonb_array_elements(m.meta->'mentions') AS x
                       WHERE x->>'userId' IS NOT NULL))
               ELSE '{}'::jsonb END
 WHERE m.ctid IN (
   SELECT m2.ctid FROM messages m2
    WHERE m2.meta IS NOT NULL
      AND jsonb_typeof(m2.meta) = 'object'
      -- Only rows that actually carry something private. Without this the
      -- statement rewrites every row in the table on every batch and never
      -- converges.
      AND EXISTS (
        SELECT 1 FROM jsonb_each(m2.meta) AS e
         WHERE e.key <> ALL (ARRAY[
                 'attachmentId','viewOnce','revoked',
                 'announcement','audience','silent',
                 'groupId','gifUrl',
                 'allowMultiple','optionCount',
                 'mentionUserIds','encrypted',
                 'game','room'
               ])
      )
    LIMIT 5000);

COMMIT;

-- POST-FLIGHT — both must be 0 once the batches converge.
--
--   SELECT count(*) FROM messages WHERE meta ? 'thumb';
--   SELECT count(*) FROM messages
--    WHERE jsonb_typeof(meta) = 'object'
--      AND EXISTS (SELECT 1 FROM jsonb_each(meta) e
--                   WHERE e.key <> ALL (ARRAY[ /* the allow-list above */ ]));
--
-- A non-object `meta` (a JSON array — typeof [] === 'object' in JS, which is how
-- some rows acquired one) is NOT touched by this statement: jsonb_each would
-- error on it. Those rows are legacy and few; inspect and delete them by hand:
--
--   SELECT id, meta FROM messages WHERE meta IS NOT NULL AND jsonb_typeof(meta) <> 'object';
