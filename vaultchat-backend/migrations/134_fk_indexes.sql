-- 134_fk_indexes.sql — index every unindexed foreign key.
--
-- Audited against the real applied schema (133 migrations, fresh cluster,
-- 2026-09-14). pg_constraint had 94 foreign keys with no index whose leading
-- columns match the constraint. Postgres does not create one for you: it
-- requires an index on the PARENT side (the referenced key must be unique) and
-- leaves the CHILD side bare. Each of those 94 is a sequential scan of the
-- child table every time a parent row is deleted or its key updated.
--
-- Measured, not guessed. 200k messages, 2000 users, delete ONE user:
--
--   before   Execution Time: 12440 ms
--            Trigger messages_reply_to_id_fkey on messages: 12265 ms, 100 calls
--   after    Trigger messages_reply_to_id_fkey on messages:     7.4 ms, 100 calls
--
-- That is the quadratic shape. messages.reply_to_id is self-referential and
-- ON DELETE SET NULL, so deleting a user cascades N of their messages and each
-- cascaded row makes Postgres scan the WHOLE messages table looking for replies
-- to it. 100 messages x one full scan = 12 seconds, with row locks held on
-- messages throughout. At production message volume that is an account deletion
-- that never returns and takes the send path down with it.
--
-- ALL 94, not a curated subset. The first draft of this file indexed only FKs
-- pointing directly at users/chats/messages/attachments/invite_links, on the
-- theory that the rest were leaf-to-leaf links whose parents are never deleted.
-- A recursive walk of ON DELETE CASCADE edges out of `users` disproved it:
-- 9 of the 13 skipped are transitively reachable from a single user delete
-- (users -> shopbook_shop -> shopbook_favorite, users -> shopbook_order ->
-- shopbook_payment, users -> shopbook_product -> shopbook_order_item ->
-- shopbook_return_item, ...). Curating the list required a judgement call that
-- was wrong on first attempt, so the rule here is mechanical and has no
-- exceptions: an FK gets an index. It also means this audit does not have to be
-- repeated the next time a cascade edge is added.
--
-- PARTIAL where the column is NULLABLE (51 of 94). A nullable FK column is
-- typically mostly NULL — chat_codes.used_by, chat_invitations.approved_by,
-- messages.reply_to_id — and NULL entries are useless to the referential-
-- integrity check, which is always `WHERE col = $1` with a non-null $1. The
-- planner uses a `WHERE col IS NOT NULL` partial index for that predicate
-- (col = $1 implies col IS NOT NULL), so this costs nothing on lookups and
-- saves the entries nothing would ever read.
--
-- Purely additive: no data rewritten, nothing dropped, no column made NOT NULL.
-- Every statement is IF NOT EXISTS, so a re-run is a no-op. NOT built
-- CONCURRENTLY, because migrate.js runs each file inside one transaction and
-- CREATE INDEX CONCURRENTLY cannot run in a transaction. Each build takes a
-- SHARE lock (blocks writes, not reads) on its table for the duration. On a
-- large production `messages`, build idx_messages_reply_to_id and
-- idx_messages_sender_id by hand with CONCURRENTLY before deploying — the
-- IF NOT EXISTS below will then skip them.

CREATE INDEX IF NOT EXISTS idx_attachment_deliveries_user_id ON attachment_deliveries (user_id);
CREATE INDEX IF NOT EXISTS idx_bookmarks_message_id ON bookmarks (message_id);
CREATE INDEX IF NOT EXISTS idx_broadcast_chat_user_id ON broadcast_chat (user_id);
CREATE INDEX IF NOT EXISTS idx_broadcast_comments_user_id ON broadcast_comments (user_id);
CREATE INDEX IF NOT EXISTS idx_broadcast_invite_links_created_by ON broadcast_invite_links (created_by);
CREATE INDEX IF NOT EXISTS idx_broadcast_invites_inviter_id ON broadcast_invites (inviter_id);
CREATE INDEX IF NOT EXISTS idx_broadcast_likes_user_id ON broadcast_likes (user_id);
CREATE INDEX IF NOT EXISTS idx_broadcast_poll_votes_user_id ON broadcast_poll_votes (user_id);
CREATE INDEX IF NOT EXISTS idx_broadcast_sessions_chat_id ON broadcast_sessions (chat_id)
  WHERE chat_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_broadcast_viewers_user_id ON broadcast_viewers (user_id)
  WHERE user_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_call_invites_invited_by ON call_invites (invited_by);
CREATE INDEX IF NOT EXISTS idx_calls_started_by ON calls (started_by);
CREATE INDEX IF NOT EXISTS idx_channel_posts_author_id ON channel_posts (author_id);
CREATE INDEX IF NOT EXISTS idx_channels_admin_id ON channels (admin_id);
CREATE INDEX IF NOT EXISTS idx_chat_codes_used_by ON chat_codes (used_by)
  WHERE used_by IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_chat_invitations_approved_by ON chat_invitations (approved_by)
  WHERE approved_by IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_chat_invitations_inviter_id ON chat_invitations (inviter_id);
CREATE INDEX IF NOT EXISTS idx_chat_invitations_link_id ON chat_invitations (link_id)
  WHERE link_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_chat_join_requests_user_id ON chat_join_requests (user_id);
CREATE INDEX IF NOT EXISTS idx_chats_created_by ON chats (created_by)
  WHERE created_by IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_chats_last_message_id ON chats (last_message_id)
  WHERE last_message_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_communities_created_by ON communities (created_by);
CREATE INDEX IF NOT EXISTS idx_contact_verifications_contact_id ON contact_verifications (contact_id);
CREATE INDEX IF NOT EXISTS idx_family_relations_member_id ON family_relations (member_id);
CREATE INDEX IF NOT EXISTS idx_family_relations_viewer_id ON family_relations (viewer_id);
CREATE INDEX IF NOT EXISTS idx_game_matches_winner_id ON game_matches (winner_id)
  WHERE winner_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_group_audit_log_actor_id ON group_audit_log (actor_id)
  WHERE actor_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_group_audit_log_target_id ON group_audit_log (target_id)
  WHERE target_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_group_events_created_by ON group_events (created_by)
  WHERE created_by IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_group_removals_removed_by ON group_removals (removed_by)
  WHERE removed_by IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_group_removals_user_id ON group_removals (user_id);
CREATE INDEX IF NOT EXISTS idx_group_sender_keys_recipient_id ON group_sender_keys (recipient_id);
CREATE INDEX IF NOT EXISTS idx_group_sender_keys_sender_id ON group_sender_keys (sender_id);
CREATE INDEX IF NOT EXISTS idx_invite_links_created_by ON invite_links (created_by);
CREATE INDEX IF NOT EXISTS idx_messages_reply_to_id ON messages (reply_to_id)
  WHERE reply_to_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_messages_sender_id ON messages (sender_id);
CREATE INDEX IF NOT EXISTS idx_poll_votes_user_id ON poll_votes (user_id);
CREATE INDEX IF NOT EXISTS idx_run_events_actor_id ON run_events (actor_id)
  WHERE actor_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_run_riders_actor_id ON run_riders (actor_id)
  WHERE actor_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_run_riders_stop_id ON run_riders (stop_id)
  WHERE stop_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_runs_created_by ON runs (created_by)
  WHERE created_by IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_scheduled_messages_chat_id ON scheduled_messages (chat_id);
CREATE INDEX IF NOT EXISTS idx_scheduled_messages_message_id ON scheduled_messages (message_id)
  WHERE message_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_scheduled_messages_reply_to_id ON scheduled_messages (reply_to_id)
  WHERE reply_to_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_shopbook_audit_actor_user_id ON shopbook_audit (actor_user_id)
  WHERE actor_user_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_shopbook_credit_note_return_id ON shopbook_credit_note (return_id)
  WHERE return_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_shopbook_customer_customer_user_id ON shopbook_customer (customer_user_id);
CREATE INDEX IF NOT EXISTS idx_shopbook_document_uploaded_by ON shopbook_document (uploaded_by)
  WHERE uploaded_by IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_shopbook_favorite_shop_id ON shopbook_favorite (shop_id);
CREATE INDEX IF NOT EXISTS idx_shopbook_khata_customer_linked_user_id ON shopbook_khata_customer (linked_user_id)
  WHERE linked_user_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_shopbook_ledger_customer_user_id ON shopbook_ledger (customer_user_id)
  WHERE customer_user_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_shopbook_ledger_khata_customer_id ON shopbook_ledger (khata_customer_id)
  WHERE khata_customer_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_shopbook_location_request_requested_by ON shopbook_location_request (requested_by)
  WHERE requested_by IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_shopbook_order_item_product_id ON shopbook_order_item (product_id)
  WHERE product_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_shopbook_payment_actor_user_id ON shopbook_payment (actor_user_id)
  WHERE actor_user_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_shopbook_payment_customer_user_id ON shopbook_payment (customer_user_id);
CREATE INDEX IF NOT EXISTS idx_shopbook_payment_ledger_id ON shopbook_payment (ledger_id)
  WHERE ledger_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_shopbook_payment_order_id ON shopbook_payment (order_id)
  WHERE order_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_shopbook_purchase_actor_user_id ON shopbook_purchase (actor_user_id)
  WHERE actor_user_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_shopbook_purchase_supplier_id ON shopbook_purchase (supplier_id)
  WHERE supplier_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_shopbook_rating_customer_user_id ON shopbook_rating (customer_user_id);
CREATE INDEX IF NOT EXISTS idx_shopbook_return_decided_by ON shopbook_return (decided_by)
  WHERE decided_by IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_shopbook_return_item_order_item_id ON shopbook_return_item (order_item_id);
CREATE INDEX IF NOT EXISTS idx_shopbook_return_item_product_id ON shopbook_return_item (product_id)
  WHERE product_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_shopbook_stock_movement_actor_user_id ON shopbook_stock_movement (actor_user_id)
  WHERE actor_user_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_space_attendance_user_id ON space_attendance (user_id);
CREATE INDEX IF NOT EXISTS idx_space_device_commands_chat_id ON space_device_commands (chat_id);
CREATE INDEX IF NOT EXISTS idx_space_device_commands_issued_by ON space_device_commands (issued_by)
  WHERE issued_by IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_space_device_events_chat_id ON space_device_events (chat_id);
CREATE INDEX IF NOT EXISTS idx_space_devices_owner_id ON space_devices (owner_id)
  WHERE owner_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_space_incidents_reporter_id ON space_incidents (reporter_id)
  WHERE reporter_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_space_incidents_run_id ON space_incidents (run_id)
  WHERE run_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_space_items_last_seen_by ON space_items (last_seen_by)
  WHERE last_seen_by IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_space_items_owner_id ON space_items (owner_id);
CREATE INDEX IF NOT EXISTS idx_space_leave_decided_by ON space_leave (decided_by)
  WHERE decided_by IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_space_leave_user_id ON space_leave (user_id);
CREATE INDEX IF NOT EXISTS idx_space_links_created_by ON space_links (created_by)
  WHERE created_by IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_space_links_object_id ON space_links (object_id);
CREATE INDEX IF NOT EXISTS idx_space_links_subject_id ON space_links (subject_id);
CREATE INDEX IF NOT EXISTS idx_space_locations_user_id ON space_locations (user_id);
CREATE INDEX IF NOT EXISTS idx_space_roster_user_id ON space_roster (user_id)
  WHERE user_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_space_tasks_assigned_by ON space_tasks (assigned_by)
  WHERE assigned_by IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_space_tasks_assignee_id ON space_tasks (assignee_id)
  WHERE assignee_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_space_trips_ended_by ON space_trips (ended_by)
  WHERE ended_by IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_space_trips_leader_id ON space_trips (leader_id)
  WHERE leader_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_space_trips_started_by ON space_trips (started_by);
CREATE INDEX IF NOT EXISTS idx_status_audience_user_id ON status_audience (user_id);
CREATE INDEX IF NOT EXISTS idx_stories_attachment_id ON stories (attachment_id)
  WHERE attachment_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_sync_codes_verified_by ON sync_codes (verified_by)
  WHERE verified_by IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_trusted_contacts_contact_id ON trusted_contacts (contact_id);
CREATE INDEX IF NOT EXISTS idx_user_reports_reporter_id ON user_reports (reporter_id);
CREATE INDEX IF NOT EXISTS idx_vb_transfer_sender_id ON vb_transfer (sender_id);
CREATE INDEX IF NOT EXISTS idx_visitor_passes_created_by ON visitor_passes (created_by)
  WHERE created_by IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_visitor_passes_host_id ON visitor_passes (host_id)
  WHERE host_id IS NOT NULL;
