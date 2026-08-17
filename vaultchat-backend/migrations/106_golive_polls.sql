-- 106_golive_polls.sql — polls on a Go Live broadcast. Idempotent.
--
-- WHY A DEDICATED TABLE AND NOT THE CHAT POLL
-- -------------------------------------------
-- Chat already has polls (lib/chatService.ts sends message type 'poll' with the
-- question and options in the message meta). That shape is right for a chat: a
-- poll is one message among many, in a room with a known, bounded membership.
--
-- A broadcast poll is a different problem. The audience is UNBOUNDED — the whole
-- point of the HLS tier — so the vote is a write from an unknown number of
-- people arriving in the same few seconds, and the result is read by all of them
-- at once. Putting that in the message stream would mean a message row per vote
-- and a scan to tally. This is one row per voter and an O(1) count.
--
-- ONE VOTE PER PERSON, ENFORCED BY THE SCHEMA
-- -------------------------------------------
-- PRIMARY KEY (poll_id, user_id). Idempotence lives in the key, exactly as it
-- does for broadcast_likes (082): a double tap cannot double count, and a retry
-- after a flaky response is a no-op rather than a second vote. The same reason
-- the like table has no `id` column.
--
-- Votes are FINAL. There is no UPDATE policy below, so a vote cannot be changed
-- once cast — which is what makes the Redis tally (a set per option) safe to
-- treat as authoritative for the live number: a set only ever grows, so it can
-- never disagree with Postgres about a vote that was already counted.
--
-- WHERE THE LIVE NUMBER LIVES
-- ---------------------------
-- Redis, like the viewer count and the like count before it. These tables are
-- the durable record; the number moving on ten thousand screens comes from a set
-- cardinality. See routes/golive_polls.go.

-- ── polls ─────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS broadcast_polls (
  id           BIGSERIAL PRIMARY KEY,
  broadcast_id UUID NOT NULL REFERENCES broadcast_sessions(id) ON DELETE CASCADE,
  question     TEXT NOT NULL,
  -- 2..10 options, positional. TEXT[] rather than a child table: options are
  -- fixed at creation, never edited, and always read as a whole — a join per
  -- poll would buy nothing. The vote stores the INDEX into this array.
  options      TEXT[] NOT NULL,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- Set when the host closes voting. A closed poll still shows its result.
  closed_at    TIMESTAMPTZ,
  CONSTRAINT broadcast_polls_options_ck
    CHECK (array_length(options, 1) BETWEEN 2 AND 10)
);

-- "What polls are on this broadcast" is the only query, newest first.
CREATE INDEX IF NOT EXISTS broadcast_polls_stream_idx
  ON broadcast_polls (broadcast_id, id DESC);

-- ── votes ─────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS broadcast_poll_votes (
  poll_id    BIGINT NOT NULL REFERENCES broadcast_polls(id) ON DELETE CASCADE,
  user_id    UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  -- Index into broadcast_polls.options. SMALLINT because it can never exceed 9.
  option_idx SMALLINT NOT NULL CHECK (option_idx >= 0 AND option_idx < 10),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (poll_id, user_id)
);

-- Tallying is "count votes per option for one poll". The PK covers lookup by
-- (poll_id, user_id) for "did I vote"; this covers the aggregate.
CREATE INDEX IF NOT EXISTS broadcast_poll_votes_tally_idx
  ON broadcast_poll_votes (poll_id, option_idx);

-- ── RLS ───────────────────────────────────────────────────────────────
-- Same shape as 079/105: a poll is visible to exactly the people who may watch
-- the broadcast it belongs to, so a private stream's polls are not world
-- readable. Only the HOST may create or close one.
--
-- As always on this deployment, RLS is the second gate — docs/RLS_ENFORCEMENT.md
-- records that the API role can bypass policies, so routes/golive_polls.go
-- performs the same checks in Go.
ALTER TABLE broadcast_polls      ENABLE ROW LEVEL SECURITY;
ALTER TABLE broadcast_polls      FORCE  ROW LEVEL SECURITY;
ALTER TABLE broadcast_poll_votes ENABLE ROW LEVEL SECURITY;
ALTER TABLE broadcast_poll_votes FORCE  ROW LEVEL SECURITY;

DROP POLICY IF EXISTS broadcast_polls_select ON broadcast_polls;
DROP POLICY IF EXISTS broadcast_polls_insert ON broadcast_polls;
DROP POLICY IF EXISTS broadcast_polls_update ON broadcast_polls;

CREATE POLICY broadcast_polls_select ON broadcast_polls FOR SELECT USING (
  EXISTS (
    SELECT 1 FROM broadcast_sessions b
     WHERE b.id = broadcast_polls.broadcast_id
       AND (b.visibility = 'public'
            OR b.host_id = vc_current_user_id()
            OR EXISTS (SELECT 1 FROM broadcast_invites i
                        WHERE i.broadcast_id = b.id
                          AND i.invitee_id = vc_current_user_id()))
  )
);

-- Only the host runs a poll on their own stream.
CREATE POLICY broadcast_polls_insert ON broadcast_polls FOR INSERT WITH CHECK (
  EXISTS (SELECT 1 FROM broadcast_sessions b
           WHERE b.id = broadcast_id AND b.host_id = vc_current_user_id())
);
-- Closing is the only update.
CREATE POLICY broadcast_polls_update ON broadcast_polls FOR UPDATE USING (
  EXISTS (SELECT 1 FROM broadcast_sessions b
           WHERE b.id = broadcast_polls.broadcast_id AND b.host_id = vc_current_user_id())
);

DROP POLICY IF EXISTS broadcast_poll_votes_select ON broadcast_poll_votes;
DROP POLICY IF EXISTS broadcast_poll_votes_insert ON broadcast_poll_votes;

-- A voter may see their OWN vote; the host sees them all, which is what makes
-- per-option tallying possible for the person running the poll. Nobody else can
-- read who voted for what — a public tally is a count, not a roll call.
CREATE POLICY broadcast_poll_votes_select ON broadcast_poll_votes FOR SELECT USING (
  user_id = vc_current_user_id()
  OR EXISTS (SELECT 1 FROM broadcast_polls p
               JOIN broadcast_sessions b ON b.id = p.broadcast_id
              WHERE p.id = broadcast_poll_votes.poll_id
                AND b.host_id = vc_current_user_id())
);

-- Vote AS yourself, on an OPEN poll, and only on a broadcast you may watch.
-- Deliberately NOT restricted to the 20 stage members: unlimited viewers
-- answering is the entire point of a broadcast poll.
CREATE POLICY broadcast_poll_votes_insert ON broadcast_poll_votes FOR INSERT WITH CHECK (
  user_id = vc_current_user_id()
  AND EXISTS (
    SELECT 1 FROM broadcast_polls p
      JOIN broadcast_sessions b ON b.id = p.broadcast_id
     WHERE p.id = poll_id
       AND p.closed_at IS NULL
       AND (b.visibility = 'public'
            OR b.host_id = vc_current_user_id()
            OR EXISTS (SELECT 1 FROM broadcast_invites i
                        WHERE i.broadcast_id = b.id
                          AND i.invitee_id = vc_current_user_id()))
  )
);
