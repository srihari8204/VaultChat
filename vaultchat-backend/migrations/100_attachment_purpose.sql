-- 100_attachment_purpose.sql — give every stored object an explicit purpose.
-- Idempotent. Additive. Deletes nothing.
--
-- WHY
-- ---
-- `attachments` is a SHARED table. Chat media, profile avatars, group photos
-- and story media all arrive through routes/uploads.go and land in the same
-- rows. Retention was inferred from whether a `messages` row happened to
-- reference the object, which is not a purpose — it is a side effect.
--
-- Inference by reference fails in both directions, and both failures were live:
--
--   FALSE ORPHAN   an avatar is referenced by users.photo_url and by no
--                  message, so the sweep classified it as an orphan and
--                  deleted it 14 days after upload. Silently: purged_at is
--                  stamped, the serve path never reads that column, and the
--                  symptom is a profile picture that stops loading.
--
--   FALSE CHAT     delete-for-everyone sets messages.meta = NULL, which
--                  destroys the only reference to that message's attachment.
--                  The object becomes indistinguishable from an upload that
--                  was never sent.
--
-- So purpose becomes a stored fact, declared by the writer, rather than a
-- guess reconstructed by the reader.
--
-- WHAT THIS MIGRATION DELIBERATELY DOES NOT DO
-- --------------------------------------------
-- It does not default legacy rows to 'chat'. Measured on production before
-- writing this file:
--
--   231 attachments, 95 live
--     unknown 172 (85 live)   chat 57 (8 live)   group 1   profile 1
--
-- 89% of LIVE objects cannot be classified by any reference — retry-storm
-- duplicates (the same video 14 times), encrypted uploads whose message was
-- later deleted, uploads that never became a message. Defaulting those to
-- 'chat' would hand 85 live objects to a three-hour deletion timer.
--
-- They are classified 'unknown', and 'unknown' is never automatically
-- deleted. An object nobody can account for is safer kept than destroyed;
-- reclaiming it is a separate, deliberate, logged decision.

-- ── the column ──────────────────────────────────────────────────────
-- TEXT + CHECK rather than a Postgres ENUM: the rest of this schema uses
-- CHECK constraints for closed sets (messages.type, space_devices.kind), and
-- adding a value to an enum inside a transaction has historically been a
-- migration hazard. Consistency with the existing convention wins.
--
-- No DEFAULT. A default is what lets a new writer forget to classify and
-- still succeed; the backfill below sets every existing row explicitly, and
-- uploads.go sets it explicitly for every new one.
ALTER TABLE attachments
  ADD COLUMN IF NOT EXISTS purpose TEXT;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'attachments_purpose_check') THEN
    ALTER TABLE attachments
      ADD CONSTRAINT attachments_purpose_check
      CHECK (purpose IN ('chat', 'profile', 'group', 'story', 'mini_app', 'unknown'));
  END IF;
END $$;

-- ── evidence-based backfill ─────────────────────────────────────────
-- Ordered most-protective first. A row referenced by two systems takes the
-- class that keeps it longest, never the one that deletes it soonest.
--
-- Only ever fills a NULL purpose, so re-running cannot reclassify a row that
-- a writer has since declared.

UPDATE attachments a SET purpose = 'profile'
 WHERE a.purpose IS NULL
   AND EXISTS (SELECT 1 FROM users u WHERE u.photo_url = a.id::text);

UPDATE attachments a SET purpose = 'group'
 WHERE a.purpose IS NULL
   AND EXISTS (SELECT 1 FROM chats c WHERE c.photo_url = a.id::text);

UPDATE attachments a SET purpose = 'story'
 WHERE a.purpose IS NULL
   AND EXISTS (SELECT 1 FROM stories s WHERE s.attachment_id = a.id);

UPDATE attachments a SET purpose = 'chat'
 WHERE a.purpose IS NULL
   AND EXISTS (SELECT 1 FROM messages m WHERE m.meta->>'attachmentId' = a.id::text);

-- Everything left is genuinely unaccounted for. Named, not guessed.
UPDATE attachments SET purpose = 'unknown' WHERE purpose IS NULL;

ALTER TABLE attachments ALTER COLUMN purpose SET NOT NULL;

-- The sweep filters on purpose and then on age, so purpose leads.
-- Partial: 'unknown' and 'profile'/'group' rows are never swept by age, so
-- indexing them would cost writes to serve a query that is never asked.
CREATE INDEX IF NOT EXISTS idx_attachments_purpose_created
  ON attachments (purpose, created_at)
  WHERE purged_at IS NULL;

-- Operational visibility: what is unaccounted for, and how much does it cost.
-- A view rather than a job — this is a question an operator asks, not a thing
-- the server should act on by itself.
CREATE OR REPLACE VIEW vc_attachment_purpose_summary AS
  SELECT purpose,
         count(*)                                   AS rows,
         count(*) FILTER (WHERE purged_at IS NULL)  AS live,
         COALESCE(sum(size_bytes) FILTER (WHERE purged_at IS NULL), 0) AS live_bytes,
         min(created_at)                            AS oldest,
         max(created_at)                            AS newest
    FROM attachments
   GROUP BY purpose;

DO $$
DECLARE unk BIGINT;
BEGIN
  SELECT count(*) INTO unk FROM attachments WHERE purpose = 'unknown' AND purged_at IS NULL;
  RAISE NOTICE 'attachments.purpose backfilled. % live rows are UNKNOWN and will never be auto-deleted.', unk;
  RAISE NOTICE 'Review them with: SELECT * FROM vc_attachment_purpose_summary;';
END $$;
