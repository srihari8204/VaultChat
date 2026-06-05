-- VaultChat: add 'sticker' to allowed message types.
-- Idempotent.
--
-- A sticker message stores the emoji/asset id in `content` and an
-- optional pack name in meta.stickerPack. Renders as a large emoji
-- with no chat-bubble background.

DO $$
BEGIN
  -- Drop and recreate the messages.type CHECK if it exists with the old set
  IF EXISTS (
    SELECT 1 FROM information_schema.check_constraints
     WHERE constraint_name LIKE 'messages_type_check'
  ) THEN
    ALTER TABLE messages DROP CONSTRAINT messages_type_check;
  END IF;
  ALTER TABLE messages ADD CONSTRAINT messages_type_check
    CHECK (type IN ('text','image','video','audio','file','location','system','sticker'));
END $$;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.check_constraints
     WHERE constraint_name LIKE 'scheduled_messages_type_check'
  ) THEN
    ALTER TABLE scheduled_messages DROP CONSTRAINT scheduled_messages_type_check;
  END IF;
  ALTER TABLE scheduled_messages ADD CONSTRAINT scheduled_messages_type_check
    CHECK (type IN ('text','image','video','audio','file','location','system','sticker'));
END $$;
