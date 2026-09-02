-- 124_game_invite_message.sql
-- Idempotent.
--
-- Extend messages.type to allow 'game_invite' — a card in a chat thread saying
-- "come and play this table", carrying the game and the room id the games
-- server minted.
--
-- WHY A MESSAGE TYPE AND NOT A LINK
--
-- Until now the only way to invite someone to a game table was the OS share
-- sheet: the invite LEFT VaultChat and had to find its way back. VaultChat is
-- the messaging app the invite was going to be pasted into anyway, so the card
-- belongs in the thread, where it inherits delivery, E2EE and retention from
-- the message it already is. No new table, no new delivery path.
--
-- WHAT IT CARRIES, AND WHAT IT CANNOT
--
-- meta is {game, room} and nothing else. Unlike 'group_ref' the server cannot
-- enrich it — the games server is a separate deployment whose rooms this
-- database has never heard of — so the server VALIDATES rather than rewrites:
-- the game must be one of the four the app ships, and the room must be a plain
-- slug. That slug goes into a URL other people open, so anything with a slash,
-- a quote, a '?' or a '#' in it would rewrite the link rather than fill it in
-- (chats_helpers.go, and the same rule gamesNotifySlug already applies to the
-- notification path).
--
-- The card admits nobody to anything in VaultChat. It points at a table on a
-- games server that does its own seating, and it carries NO token: the same
-- "a pointer, never a credential" rule migration 075 wrote down for group_ref.
--
-- The body (`content`) stays E2EE like any message and holds the human-readable
-- fallback line, so a client too old to know this type still renders something
-- a person can read instead of an empty bubble.
--
-- Strict SUPERSET of 075: this can only ACCEPT previously-rejected rows, never
-- reject a currently-valid one.

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.table_constraints
     WHERE constraint_name = 'messages_type_check'
       AND table_name = 'messages'
  ) THEN
    ALTER TABLE messages DROP CONSTRAINT messages_type_check;
  END IF;
  ALTER TABLE messages ADD CONSTRAINT messages_type_check
    CHECK (type IN ('text','image','video','audio','file','location','system',
                    'sticker','poll','reaction','vaultbeam','group_ref',
                    'game_invite'));
END $$;

-- scheduled_messages deliberately does NOT gain the type, for the same reason
-- 075 withheld group_ref: a table is a live thing. Between scheduling and
-- sending, the room empties, the game finishes, or the server forgets it — and
-- a card that arrives pointing at a table that is gone is worse than no card,
-- because the recipient taps it and lands nowhere.
