-- VaultChat: favourite per chat member (WhatsApp parity, 2026-09-13).
-- Idempotent.
--
-- Favourite is per-(chat,user) on chat_members for the same reason pin, mute
-- and archive are (002, 012): these are one person's view of a conversation,
-- not a property of the conversation. A chat-level column would leak — marking
-- a chat a favourite would silently announce it to every other member, and in
-- a group it would let any member reorder everyone else's list.
--
-- Deliberately NOT reusing `pinned`. They look alike and they are not: pin is
-- a sort key (pinned chats ride the top of the list, ordered by pinned_at),
-- favourite is a FILTER (the Favourites chip narrows the list, order unchanged).
-- WhatsApp lets a chat be both, so one column could not express it, and a chat
-- unfavourited would have lost its pin position.
--
-- No favourite_at: nothing orders by it. Pin needed a timestamp because pins
-- sort among themselves; the Favourites filter keeps the list's own order, so
-- a timestamp here would be a column nobody reads. Add it if the UI ever grows
-- "recently favourited".

ALTER TABLE chat_members
  ADD COLUMN IF NOT EXISTS favourite BOOLEAN NOT NULL DEFAULT FALSE;

-- No index. Unlike 012's pinned/archived indexes, the Favourites chip is not a
-- separate query: GET /chats already returns the whole 200-row list with the
-- flag on each row and the client filters in place. An index here would be
-- written on every toggle and read by nothing.
