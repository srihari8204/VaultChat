-- 130 — which of the 195 screens are actually used?
--
-- AUDIT F9. There is no answer today, and that is the missing instrument behind
-- the largest finding in the September review: the product carries an enormous
-- feature surface against a handful of users, and nothing can be retired
-- because nothing can say what is unused. "Cut this" is currently an opinion.
--
-- WHAT THIS DELIBERATELY DOES NOT HOLD
-- -----------------------------------
-- No user id. No device id. No session id. No timestamp finer than a DAY. No
-- message content, no chat id, no navigation sequence.
--
-- That is not caution for its own sake — it is what makes the table answerable
-- to the product's own privacy policy. A per-user event log in a messenger
-- whose entire pitch is that the operator cannot see your activity would be a
-- contradiction sitting in the same database as the ciphertext. An aggregate
-- counter answers "does anybody open the Shelf" without being able to answer
-- "does SRIHARI open the Shelf", and only the first question is anyone's
-- business here.
--
-- The consequence is stated so nobody expects otherwise later: this can never
-- produce funnels, retention cohorts, or per-user behaviour. Those need
-- identity, and identity is the thing being refused. If the product ever needs
-- them, that is a policy decision and a new conversation, not a column.
--
-- ROWS ARE (screen, day). A client posts counts; the server adds them in. Two
-- devices reporting the same screen on the same day become one row with a
-- larger number, which is exactly the resolution the question needs.

CREATE TABLE IF NOT EXISTS screen_usage (
  -- The route path as the client knows it: "/chat", "/shop-book", "/family".
  -- Bounded and validated server-side; an unknown name is dropped rather than
  -- stored, so this cannot be turned into free-text storage by a hostile client.
  screen TEXT NOT NULL,
  day    DATE NOT NULL,
  views  BIGINT NOT NULL DEFAULT 0,
  PRIMARY KEY (screen, day)
);

COMMENT ON TABLE screen_usage IS
  'Audit F9. Aggregate screen-open counts, (screen, day). Deliberately holds no user, device, session or sub-day timestamp — it can answer "is this screen used" and can never answer "who used it".';
COMMENT ON COLUMN screen_usage.views IS
  'Summed across all clients. Incremented by POST /app/usage; never set directly.';

-- The retention question answered up front rather than left to whoever notices
-- the table in a year. Daily aggregates for two years is ~150 KB per screen and
-- is enough to see a feature die; anything older answers nothing a decision
-- needs. The sweep lives with the other retention jobs.
CREATE INDEX IF NOT EXISTS idx_screen_usage_day ON screen_usage (day);
