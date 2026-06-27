-- 051_status_privacy.sql — WhatsApp "Status privacy" (who can see my status).
--
-- mode: 'contacts'  → everyone I share a chat with (default)
--       'except'    → contacts EXCEPT the listed users
--       'only'      → ONLY the listed users (intersected with contacts)

ALTER TABLE users ADD COLUMN IF NOT EXISTS status_privacy TEXT NOT NULL DEFAULT 'contacts';

CREATE TABLE IF NOT EXISTS status_audience (
  owner_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  user_id  UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  PRIMARY KEY (owner_id, user_id)
);
