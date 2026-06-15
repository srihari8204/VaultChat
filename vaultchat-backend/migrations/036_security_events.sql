-- Security audit-chain backup (Alerts tab #41). Idempotent.
--
-- ZERO-KNOWLEDGE: the server stores ONLY a client-encrypted blob plus the
-- opaque chain hashes. There is no readable content column here — the event's
-- type/title/detail live exclusively inside `blob`, which is AES-256-GCM
-- ciphertext the client encrypts under a device-held key the server never sees.
-- `hash`/`prev_hash` are SHA-256 hex (one-way; reveal nothing about content) and
-- exist only so the on-device tamper-evident chain can be restored in order.
--
-- The device's local SQLite chain remains the source of truth and the
-- tamper-evidence layer; this table is a durable, reinstall-surviving mirror.

CREATE TABLE IF NOT EXISTS security_events (
  id          BIGSERIAL    PRIMARY KEY,
  user_id     UUID         NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  blob        TEXT         NOT NULL,        -- client AES-256-GCM ciphertext (opaque)
  hash        TEXT         NOT NULL,        -- SHA-256 of the event (opaque chain id)
  prev_hash   TEXT         NOT NULL,        -- previous event's hash (chain link)
  client_ts   BIGINT,                       -- client event time (ms) for ordering
  created_at  TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  UNIQUE (user_id, hash)                     -- idempotent push: dedupe by chain hash
);

CREATE INDEX IF NOT EXISTS idx_security_events_user ON security_events(user_id, id);
