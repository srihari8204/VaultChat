#!/bin/sh
# Read-only evidence for the user-authorized Leo two-phone test. No bodies/tokens.
set -eu
docker exec -i vaultchat-postgres-1 sh -c 'exec psql -X -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d "$POSTGRES_DB"' <<'SQL'
BEGIN READ ONLY;
SELECT user_id, last_delivered_message_id, last_read_message_id
FROM chat_members WHERE chat_id='c4c7fcb3-89fa-41a9-9145-fd0ebcd60a2a' AND left_at IS NULL;
SELECT id, sender_id, created_at, edited_at, deleted_at
FROM messages WHERE chat_id='c4c7fcb3-89fa-41a9-9145-fd0ebcd60a2a'
ORDER BY id DESC LIMIT 5;
COMMIT;
SQL
