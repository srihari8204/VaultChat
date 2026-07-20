-- 060_vaultbeam_plan.sql
-- VaultBeam v2 (adaptive mid-transfer geometry). The segment PLAN — content-free
-- per-segment chunk/block sizes + byte offsets — is hosted here so the sender can
-- GROW it reactively as it measures throughput, and an OFFLINE recipient can still
-- read the geometry it needs to decrypt each block. Still no plaintext, filename,
-- mime, or key: those ride the E2EE channel, exactly as before. The relay only
-- ever sees ciphertext + sizes it already knew (total_bytes/block_count).
ALTER TABLE vb_transfer ADD COLUMN IF NOT EXISTS plan TEXT;
