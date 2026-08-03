-- 064_delta_mutation_indexes.sql — index the delta mutation scan (P4.3).
--
-- GET /chats/delta's mutation query filters
--   WHERE (m.edited_at > $2 OR m.deleted_at > $2) AND m.id <= $since
-- and previously had NO index on either column: every catch-up ran a scan
-- over the candidate set and sorted it. Two small partial B-trees let the
-- planner BitmapOr them; the partial predicates keep the indexes tiny (the
-- overwhelming majority of messages are never edited or deleted, so both
-- indexes contain only the mutated slice of the table).
--
-- (An expression index on GREATEST(edited_at, deleted_at) would NOT match
-- the OR filter — the planner only uses expression indexes when the query
-- repeats the expression, and the filter is a plain OR of the two columns.)

CREATE INDEX IF NOT EXISTS idx_messages_edited_at
  ON messages (edited_at)
  WHERE edited_at IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_messages_deleted_at
  ON messages (deleted_at)
  WHERE deleted_at IS NOT NULL;
