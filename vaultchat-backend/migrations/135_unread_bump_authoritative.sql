-- 135_unread_bump_authoritative.sql — make the unread bump respect the read cursor.
--
-- NOT YET APPLIED TO PRODUCTION. Prepared for approval; see the evidence below.
--
-- THE DEFECT, REPRODUCED
-- ----------------------
-- vc_bump_unread (034_unread_count.sql) is an unconditional `unread_count + 1`
-- for every active member except the sender. It is submitted to a workx
-- goroutine AFTER the message has already gone out on the socket
-- (internal/routes/chats_helpers.go), so it lands at an unspecified later time.
--
-- A recipient with the chat open acknowledges the read about 800ms after
-- delivery. When the queued bump lands after that acknowledgement, the row ends
-- up holding unread_count = 1 with last_read_message_id already at the chat's
-- newest message. Nothing can then bring it down: the badge is lit on a chat
-- with nothing unread in it, and re-opening and re-reading the chat cannot help
-- because the read cursor is already at the top and there is nothing left to
-- advance it past.
--
-- Executed against a disposable Postgres 16 cluster, not argued from the source:
--
--   internal/routes/chats_unread_concurrency_test.go
--   TestUnreadSurvivesABumpThatLandsAfterTheRead
--     DEFECT REPRODUCED: unread_count = 1 for a chat whose cursor (2) is
--     already at its newest message.
--
-- WHY THE READ-SIDE FIX IS NOT ENOUGH
-- -----------------------------------
-- POST /chats/{id}/read now recomputes unread_count on every read instead of
-- only when the cursor advances, so a drifted counter self-heals on the NEXT
-- read. That is a real improvement and it stays. It does not close this case:
-- self-healing requires a subsequent read, and the user has already read
-- everything there is to read. The counter has to stop drifting at the source.
--
-- THE CHANGE
-- ----------
-- An ADDITIVE three-argument overload that takes the message the bump is for
-- and skips any member who has already read past it. The two-argument function
-- from 034 is deliberately LEFT IN PLACE and unmodified, so a server binary
-- that has not been redeployed keeps working exactly as before — this migration
-- is safe to apply ahead of the code that calls the new form.
--
-- Not a recompute. A COUNT(*) per member per message is correct too, but it is
-- O(members x unread depth) on every insert, and this table is written for every
-- active member of a 500-member group on each message. The guard gets the same
-- correctness for this case at O(members) with no subquery.
--
-- LOCK BUDGET: CREATE OR REPLACE FUNCTION takes no table lock and rewrites no
-- rows. It is a catalogue entry. There is no rebuild, no ACCESS EXCLUSIVE on
-- chat_members, and no blocking of concurrent sends or reads.
--
-- SECURITY DEFINER matches 034: this is a cross-user write (the sender's request
-- updates other members' rows) and the application role is RLS-bound to its own
-- chat_members row. search_path is pinned so a caller cannot shadow `messages`
-- with a temp table — 034 predates that habit and should be tightened the same
-- way when someone next touches it.
--
-- Idempotent — safe to re-run.

CREATE OR REPLACE FUNCTION vc_bump_unread(p_chat_id UUID, p_sender_id UUID, p_message_id BIGINT)
RETURNS VOID AS $$
  UPDATE chat_members
     SET unread_count = unread_count + 1
   WHERE chat_id = p_chat_id
     AND user_id <> p_sender_id
     AND left_at IS NULL
     -- The whole point. A member whose cursor is already at or past this
     -- message has read it, however late this statement runs.
     AND COALESCE(last_read_message_id, 0) < p_message_id;
$$ LANGUAGE sql SECURITY DEFINER SET search_path = public, pg_temp;
