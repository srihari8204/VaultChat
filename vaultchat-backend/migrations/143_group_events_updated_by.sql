-- 143_group_events_updated_by.sql — who last wrote a shared calendar event.
--
-- NOT APPLIED ANYWHERE. Written 2026-10-04 (round 4); scratch-DB only.
--
-- group_events.payload is ciphertext sealed with the WRITER's sender key. An
-- admin may edit another member's event (calMayEdit), but clients decrypted
-- with created_by's key, so an admin edit became unreadable; the app therefore
-- kept edit author-only. PATCH /chats/{id}/events/{eventId} now stamps the
-- editor here and GET returns it as updatedBy (falling back to created_by for
-- rows never edited), so the client can pick the right key.
--
-- Additive, nullable, instant. Reverse:
--   ALTER TABLE group_events DROP COLUMN IF EXISTS updated_by;

ALTER TABLE group_events ADD COLUMN IF NOT EXISTS updated_by UUID REFERENCES users(id) ON DELETE SET NULL;
