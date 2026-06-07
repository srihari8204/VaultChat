-- Mutual-consent contact sync (sync-contact screen). Idempotent.
--
-- One party generates a short-lived 6-digit code; the other enters it to
-- consent. On verification both learn each other's public stub and can start
-- a direct chat. Codes are single-use and expire in 5 minutes. Access is
-- enforced at the route layer (routes/contacts.js); no RLS.

CREATE TABLE IF NOT EXISTS sync_codes (
  code         TEXT        PRIMARY KEY,
  initiator_id UUID        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at   TIMESTAMPTZ NOT NULL,
  verified_by  UUID        REFERENCES users(id) ON DELETE SET NULL,
  verified_at  TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_sync_codes_initiator ON sync_codes(initiator_id);
