-- 077_invite_accept_joins.sql — one yes per person. Idempotent.
--
-- 073 made 'strict' the default approval mode, which means:
--     owner invites Priya -> Priya ACCEPTS -> owner APPROVES -> Priya joins
--
-- That second approval asks the owner to re-confirm a decision they already
-- made by naming Priya in the first place. In practice it reads as a bug: the
-- invitee taps Accept, is told an admin still has to approve, and the owner has
-- no reason to expect a queue to check. Nobody joins.
--
-- 'user_approval' is the correct default for an INVITATION:
--     owner invites Priya -> Priya accepts -> Priya joins
--
-- The consent that matters is the invitee's, and it is still required — this
-- does not auto-add anyone. What it removes is the redundant second yes from
-- the side that initiated the invite.
--
-- 'admin_approval' (user REQUESTS to join -> owner approves) is untouched: a
-- stranger asking to come in is a different question from a named person being
-- asked in, and that one genuinely needs the owner's judgement.
--
-- 'strict' remains selectable for a group that deliberately wants both gates;
-- only the DEFAULT changes, plus a one-time move of existing groups that never
-- chose strict — they inherited it.

ALTER TABLE chats ALTER COLUMN approval_mode SET DEFAULT 'user_approval';

-- Existing groups: everyone on 'strict' is there by inheritance, not by choice
-- (no UI has ever offered the setting). Move them so invitations already sitting
-- in 'accepted' can be completed by the invitee re-accepting, rather than
-- waiting on an approval screen their owner cannot find.
UPDATE chats SET approval_mode = 'user_approval' WHERE approval_mode = 'strict';
