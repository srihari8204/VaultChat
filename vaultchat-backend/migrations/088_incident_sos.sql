-- VaultChat: Spaces & Operations — an SOS is not a category of incident.
-- Idempotent — safe to re-run.
--
-- 087 gave incidents six categories and the panic control had to file under
-- 'other', which meant a driver's emergency arrived on an ops phone looking
-- exactly like a blocked road: same title, same body, same priority, same
-- notification channel. That is the failure mode where an alert system stops
-- being read.
--
-- So 'sos' becomes its own category. It is deliberately a category rather than a
-- separate table: an SOS IS an incident — it has a reporter, a run, a status and
-- a resolution — and a parallel table would need its own policies, its own
-- endpoints and its own list screen to say the same things.
--
-- What differs is downstream: opsNotifyStaff gives it its own wording and its
-- own Android notification channel, so it can carry a different sound and
-- bypass a muted "incidents" channel without being able to bypass Do Not
-- Disturb dishonestly.

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'space_incidents'::regclass
       AND conname = 'space_incidents_category_check'
  ) THEN
    ALTER TABLE space_incidents DROP CONSTRAINT space_incidents_category_check;
  END IF;

  ALTER TABLE space_incidents
    ADD CONSTRAINT space_incidents_category_check
    CHECK (category IN
      ('sos', 'breakdown', 'accident', 'route_blocked', 'medical', 'behaviour', 'other'));
END $$;

-- An open SOS is the one thing an ops dashboard must never have to scan for.
CREATE INDEX IF NOT EXISTS idx_space_incidents_sos
  ON space_incidents(chat_id, created_at DESC)
  WHERE category = 'sos' AND status <> 'resolved';
