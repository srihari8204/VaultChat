-- 048_whatsapp_parity.sql — WhatsApp-parity backend additions.
--
--  * chats.description           — optional group description (admin-editable),
--                                  shown under the group name in Group Info.
--  * users.group_add_policy      — "who can add me to groups": everyone | contacts | nobody.
--  * users.default_disappearing_seconds — the user's default disappearing-messages
--                                  timer, applied to new direct chats they start.

ALTER TABLE chats ADD COLUMN IF NOT EXISTS description TEXT;

ALTER TABLE users ADD COLUMN IF NOT EXISTS group_add_policy TEXT NOT NULL DEFAULT 'everyone';
ALTER TABLE users ADD COLUMN IF NOT EXISTS default_disappearing_seconds INT NOT NULL DEFAULT 0;
