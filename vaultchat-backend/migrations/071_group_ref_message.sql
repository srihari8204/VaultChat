-- VaultChat: the in-app replacement for a group invite link. Idempotent.
--
-- Membership v2 removed every way of TELLING someone a group exists. That was
-- the point — a link is a forwardable credential — but it left admin_approval
-- mode unreachable: a user can request to join a group, and had no way to learn
-- of one.
--
-- A 'group_ref' message closes that without bringing the credential back.
--
-- WHAT IT IS: a card posted into a chat saying "this group exists, and you may
-- ask to join it". It carries a group id, a name and the type's presentation —
-- and NOTHING ELSE. No token, no code, no signature. Tapping it does not admit
-- anyone; it opens a request, which an admin still has to approve.
--
-- WHAT IT COSTS, stated plainly because it is a real cost: this card can be
-- forwarded to another VaultChat user, and doing so discloses that the group
-- exists and what it is called. Two things bound that. The card can only be
-- created for a group in 'admin_approval' mode, which is a group that has
-- explicitly opted into receiving requests from people it did not invite; and
-- the sharer must hold invite_members there, so it is the same authority that
-- could have invited the person directly. What it can never do is let the
-- holder in. That is the line a link crossed and this does not.
--
-- Both checks are enforced in the route, not here — the constraint below only
-- makes the type storable.

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
                    'sticker','poll','reaction','vaultbeam','group_ref'));
END $$;

-- scheduled_messages deliberately does NOT gain the type. A group reference
-- asserts that a group is open to requests, and that can stop being true
-- between scheduling and sending — a card that arrives pointing at a group
-- which has since closed is worse than no card, because the recipient taps it
-- and is refused with no explanation.

COMMENT ON CONSTRAINT messages_type_check ON messages IS
  'group_ref (migration 071) is a pointer to a group, never a credential: it '
  'carries no token and grants nothing. Admission still runs through '
  'POST /chats/{id}/membership/request and an admin''s approval.';
