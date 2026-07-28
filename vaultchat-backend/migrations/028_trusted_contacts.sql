-- Trusted (emergency) contacts (trusted-contacts screen). Idempotent.
--
-- Up to 3 contacts who are alerted on duress-PIN / new-device / panic events
-- (the alerting itself lives in the security services). This table just stores
-- the owner→contact links. Route-layer enforced; no RLS.

CREATE TABLE IF NOT EXISTS trusted_contacts (
  owner_id   UUID        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  contact_id UUID        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (owner_id, contact_id)
);

CREATE INDEX IF NOT EXISTS idx_trusted_owner ON trusted_contacts(owner_id, created_at);
