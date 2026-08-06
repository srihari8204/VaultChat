-- VaultChat: shared group calendar (Groups & Circles, G4.3). Idempotent.
--
-- WHY THIS TABLE EXISTS WHEN TASKS DID NOT NEED ONE
-- Group tasks ride the encrypted message thread and are rebuilt by folding
-- every task event, which is fine because a task list is small and always
-- wanted in full. A calendar is asked "what is on in March?", and answering
-- that from a message log means scanning every message the group ever sent. So
-- events get a table with something queryable.
--
-- WHAT THE SERVER LEARNS — stated plainly, because it is a real disclosure
-- A range query needs a plaintext column to filter on. Storing exact start
-- times would tell the server "this group has an event on Tuesday at 15:00",
-- which is more than a server that claims to learn nothing should hold. So the
-- ONLY plaintext column is a MONTH BUCKET ('2026-03'). The server learns which
-- months a group has events in. It does not learn the day, the time, the title,
-- the location, the notes, the duration, or who is going — all of that lives in
-- `payload`, which is ciphertext the server cannot read.
--
-- Month granularity costs nothing functionally: "show me March" is exactly the
-- query the UI makes, and the client filters and orders precisely after
-- decrypting.
--
-- RECURRING EVENTS carry month_key = NULL and are always returned. A weekly
-- event would otherwise need a row in every month forever, and materialising
-- them server-side would require the server to understand the recurrence — i.e.
-- to read the event. They are expanded on-device instead (lib/groups/calendar.ts).

CREATE TABLE IF NOT EXISTS group_events (
  id          BIGSERIAL PRIMARY KEY,
  chat_id     UUID        NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
  created_by  UUID        REFERENCES users(id) ON DELETE SET NULL,

  -- 'YYYY-MM' for a one-off; NULL for a recurring event (always fetched).
  month_key   TEXT,

  -- The whole event, sealed. Title, notes, location, exact start, duration,
  -- all-day flag, recurrence rule and reminder all live in here. The server
  -- treats this as opaque bytes and MUST NOT attempt to parse it.
  payload     TEXT        NOT NULL,

  -- Set only for recurring events, so a repeat that has ended can be filtered
  -- out server-side instead of being shipped to every client forever. It is a
  -- coarse bound, not the event's real schedule.
  repeat_until TIMESTAMPTZ,

  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  deleted_at  TIMESTAMPTZ,

  -- Shape of month_key: 'YYYY-MM', or NULL for a recurring event. Checked
  -- because a malformed bucket would silently make an event unfindable — the
  -- row would exist, the UI would never ask for that key, and the event would
  -- simply never appear.
  CONSTRAINT group_events_month_key_shape
    CHECK (month_key IS NULL OR month_key ~ '^[0-9]{4}-(0[1-9]|1[0-2])$')
);

-- The one query the UI makes: this group, these months, plus recurring.
CREATE INDEX IF NOT EXISTS idx_group_events_lookup
  ON group_events(chat_id, month_key)
  WHERE deleted_at IS NULL;

-- Recurring events are fetched on every range query, so they get their own
-- partial index rather than scanning the bucketed rows.
CREATE INDEX IF NOT EXISTS idx_group_events_recurring
  ON group_events(chat_id)
  WHERE deleted_at IS NULL AND month_key IS NULL;

DROP TRIGGER IF EXISTS group_events_set_updated_at ON group_events;
CREATE TRIGGER group_events_set_updated_at
  BEFORE UPDATE ON group_events
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
