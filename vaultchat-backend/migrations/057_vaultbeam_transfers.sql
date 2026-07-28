-- 057_vaultbeam_transfers.sql
-- VaultBeam Tier-3 (R2 relay) bookkeeping. CONTENT-FREE by design: this table
-- holds only opaque routing + size + per-block upload state. The filename, mime
-- type, and the per-transfer key K_t are NEVER stored here — they ride the E2EE
-- channel (delivered as a normal ratchet-encrypted message). R2 objects under
-- vault_relay/<transfer_id>/ are AES-256-GCM ciphertext the relay cannot read.
--
-- size_bytes is BIGINT on purpose: 12 GB (12884901888) overflows the INTEGER
-- ~2.1 GB ceiling used by attachments.size_bytes, so we must NOT reuse that.

CREATE TABLE IF NOT EXISTS vb_transfer (
  transfer_id   TEXT PRIMARY KEY,                       -- client ULID
  sender_id     UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  recipient_id  UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  chat_id       UUID,                                   -- optional routing hint
  total_bytes   BIGINT NOT NULL,                        -- BIGINT (>2.1GB INT ceiling)
  block_count   INT NOT NULL,                           -- ~4 MiB relay blocks on R2
  chunk_count   INT NOT NULL,                           -- 512 KiB logical chunks (bitmask width)
  uploaded_mask BYTEA NOT NULL,                         -- bit i set = relay block i is on R2
  state         TEXT NOT NULL DEFAULT 'pending',        -- pending | ready | complete | aborted
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at    TIMESTAMPTZ NOT NULL DEFAULT NOW() + INTERVAL '24 hours'
);

-- Recipient's "incoming transfers" lookup + resume.
CREATE INDEX IF NOT EXISTS idx_vb_transfer_recipient ON vb_transfer (recipient_id, state);
-- Expiry sweep (a periodic DELETE ... WHERE expires_at < NOW(); R2 lifecycle purges
-- the objects, this reaps the stale rows).
CREATE INDEX IF NOT EXISTS idx_vb_transfer_expires   ON vb_transfer (expires_at);
