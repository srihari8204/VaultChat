-- User reports / moderation queue (contact-info "Report"). Idempotent.
--
-- A report is an abuse signal from one user about another, optionally with a
-- reason + context (e.g. the chat id). Reviewed out-of-band; status tracks
-- the moderation lifecycle. Route-enforced; no RLS.

CREATE TABLE IF NOT EXISTS user_reports (
  id          BIGSERIAL PRIMARY KEY,
  reporter_id UUID        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  reported_id UUID        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  reason      TEXT,
  context     TEXT,
  status      TEXT        NOT NULL DEFAULT 'open',   -- 'open' | 'reviewed' | 'dismissed'
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_user_reports_reported ON user_reports(reported_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_user_reports_status   ON user_reports(status, created_at DESC);
