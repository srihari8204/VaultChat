// Package jobs — the periodic background jobs that lived in Node's server.js,
// ported so a Go-only prod (Node API decommissioned) loses nothing:
//
//   - expired-messages sweep   (disappearing messages hard-delete, 5 min)
//   - delete-on-delivery       (env-gated DELETE_ON_DELIVERY, 5 min)
//   - media retention          (purge delivered/TTL attachment bytes, 5 min)
//   - scheduled-messages       (claim + insert + fan-out, 30 s)
//   - expired-stories sweep    (24 h TTL, 5 min)
//
// (The VaultBeam relay sweep already runs from main.go.) SQL is verbatim from
// server.js; cadences and env knobs identical. Each job also fires once at
// boot, like Node, so long downtime doesn't leave stale content visible.
package jobs

import (
	"context"
	"encoding/json"
	"log"
	"os"
	"path/filepath"
	"strconv"
	"time"

	"github.com/jackc/pgx/v5"

	"vaultchat/backend-go/internal/db"
	"vaultchat/backend-go/internal/emitx"
	"vaultchat/backend-go/internal/httpx"
	"vaultchat/backend-go/internal/storage"
)

const sweepInterval = 5 * time.Minute
const schedInterval = 30 * time.Second

func envInt(k string, def int) int {
	if v, ok := httpx.ParseIntPrefix(os.Getenv(k)); ok {
		return int(v)
	}
	return def
}

// StartAll launches every job. ctx cancellation stops them (process lifetime).
func StartAll(ctx context.Context) {
	run := func(name string, every time.Duration, f func(context.Context)) {
		go func() {
			f(ctx) // boot kick, like Node
			t := time.NewTicker(every)
			defer t.Stop()
			for {
				select {
				case <-ctx.Done():
					return
				case <-t.C:
					f(ctx)
				}
			}
		}()
		log.Printf("[jobs] %s every %s", name, every)
	}

	run("sweep-expired-messages", sweepInterval, sweepExpiredMessages)
	run("media-retention", sweepInterval, sweepDeliveredAttachments)
	run("sweep-expired-stories", sweepInterval, sweepExpiredStories)
	run("scheduled-messages", schedInterval, sweepScheduledMessages)
	if os.Getenv("DELETE_ON_DELIVERY") == "true" {
		log.Println("[delete-on-delivery] ENABLED")
		run("delete-on-delivery", sweepInterval, sweepDeliveredMessages)
	}
}

// ── disappearing messages ──────────────────────────────────────────────

func sweepExpiredMessages(ctx context.Context) {
	tag, err := db.Pool.Exec(ctx,
		`DELETE FROM messages
		  WHERE expires_at IS NOT NULL AND expires_at <= NOW()`)
	if err != nil {
		log.Printf("[sweep] failed: %v", err)
		return
	}
	if n := tag.RowsAffected(); n > 0 {
		log.Printf("[sweep] hard-deleted %d expired message(s)", n)
	}
}

// ── delete-on-delivery (WhatsApp model; env-gated) ─────────────────────

func sweepDeliveredMessages(ctx context.Context) {
	grace := envInt("DELETE_ON_DELIVERY_GRACE_SEC", 120)
	maxDays := envInt("DELETE_ON_DELIVERY_MAX_AGE_DAYS", 0)
	tag, err := db.Pool.Exec(ctx,
		`UPDATE messages m
		    SET content = NULL
		  WHERE m.content IS NOT NULL
		    AND m.deleted_at IS NULL
		    AND m.created_at < NOW() - ($1 || ' seconds')::interval
		    AND EXISTS (
		      SELECT 1 FROM chat_members o
		       WHERE o.chat_id = m.chat_id AND o.left_at IS NULL AND o.user_id <> m.sender_id
		    )
		    AND NOT EXISTS (
		      SELECT 1 FROM chat_members cm
		       WHERE cm.chat_id = m.chat_id
		         AND cm.left_at IS NULL
		         AND cm.user_id <> m.sender_id
		         AND (cm.last_delivered_message_id IS NULL OR cm.last_delivered_message_id < m.id)
		    )`, strconv.Itoa(grace))
	if err != nil {
		log.Printf("[delete-on-delivery] failed: %v", err)
		return
	}
	purged := tag.RowsAffected()
	if maxDays > 0 {
		if t2, err := db.Pool.Exec(ctx,
			`UPDATE messages SET content = NULL
			  WHERE content IS NOT NULL AND deleted_at IS NULL
			    AND created_at < NOW() - ($1 || ' days')::interval`, strconv.Itoa(maxDays)); err == nil {
			purged += t2.RowsAffected()
		}
	}
	if purged > 0 {
		log.Printf("[delete-on-delivery] purged %d delivered message bodies", purged)
	}
}

// ── media retention ────────────────────────────────────────────────────

func uploadDir() string {
	if d := os.Getenv("UPLOAD_DIR"); d != "" {
		return d
	}
	cwd, _ := os.Getwd()
	return filepath.Join(cwd, "uploads")
}

func sweepDeliveredAttachments(ctx context.Context) {
	ttlDays := envInt("MEDIA_TTL_DAYS", 14)
	rows, err := db.Pool.Query(ctx,
		`SELECT a.id, a.storage_path, a.storage_backend
		   FROM attachments a
		  WHERE a.purged_at IS NULL
		    AND a.storage_path IS NOT NULL
		    AND (
		      a.created_at < NOW() - ($1 || ' days')::INTERVAL
		      OR (
		        (SELECT COUNT(*) FROM attachment_deliveries d WHERE d.attachment_id = a.id) > 0
		        AND (SELECT COUNT(*) FROM attachment_deliveries d WHERE d.attachment_id = a.id)
		            >= (SELECT COUNT(DISTINCT cm.user_id)
		                  FROM messages m
		                  JOIN chat_members cm ON cm.chat_id = m.chat_id
		                                      AND cm.left_at IS NULL
		                                      AND cm.user_id <> a.owner_user_id
		                 WHERE m.meta->>'attachmentId' = a.id::text)
		      )
		    )
		  LIMIT 500`, strconv.Itoa(ttlDays))
	if err != nil {
		log.Printf("[media-retention] failed: %v", err)
		return
	}
	type att struct {
		id, path string
		backend  *string
	}
	var list []att
	for rows.Next() {
		var a att
		if rows.Scan(&a.id, &a.path, &a.backend) == nil {
			list = append(list, a)
		}
	}
	rows.Close()

	purged := 0
	for _, a := range list {
		if a.backend != nil && *a.backend == "s3" {
			storage.DeleteObject(ctx, a.path)
		} else {
			_ = os.Remove(filepath.Join(uploadDir(), filepath.FromSlash(a.path)))
		}
		if _, err := db.Pool.Exec(ctx,
			`UPDATE attachments SET purged_at = NOW() WHERE id = $1`, a.id); err == nil {
			purged++
		}
	}
	if purged > 0 {
		log.Printf("[media-retention] purged %d delivered/expired attachment(s)", purged)
	}
}

// ── stories 24h TTL ────────────────────────────────────────────────────

func sweepExpiredStories(ctx context.Context) {
	tag, err := db.Pool.Exec(ctx, `DELETE FROM stories WHERE expires_at <= NOW()`)
	if err != nil {
		log.Printf("[sweep stories] failed: %v", err)
		return
	}
	if n := tag.RowsAffected(); n > 0 {
		log.Printf("[sweep] hard-deleted %d expired stor(y/ies)", n)
	}
}

// ── scheduled messages ─────────────────────────────────────────────────

func sweepScheduledMessages(ctx context.Context) {
	const batch = 50
	type claim struct {
		id                      int64
		userID, chatID, msgType string
		content                 *string
		meta                    []byte
		replyToID               *int64
	}
	// Claim in a tx so FOR UPDATE SKIP LOCKED actually holds across the batch
	// (multi-replica safe; single instance behaves like Node).
	tx, err := db.Pool.Begin(ctx)
	if err != nil {
		log.Printf("[sched sweep] %v", err)
		return
	}
	defer tx.Rollback(ctx) //nolint:errcheck

	rows, err := tx.Query(ctx,
		`SELECT id, user_id, chat_id, type, content, meta, reply_to_id
		   FROM scheduled_messages
		  WHERE sent_at IS NULL AND send_at <= NOW()
		  ORDER BY send_at
		  FOR UPDATE SKIP LOCKED
		  LIMIT $1`, batch)
	if err != nil {
		log.Printf("[sched sweep] %v", err)
		return
	}
	var claims []claim
	for rows.Next() {
		var c claim
		if rows.Scan(&c.id, &c.userID, &c.chatID, &c.msgType, &c.content, &c.meta, &c.replyToID) == nil {
			claims = append(claims, c)
		}
	}
	rows.Close()

	delivered := 0
	for _, c := range claims {
		if err := deliverScheduled(ctx, tx, c.id, c.userID, c.chatID, c.msgType, c.content, c.meta, c.replyToID); err != nil {
			log.Printf("[sched %d] %v", c.id, err)
		} else {
			delivered++
		}
	}
	// Prune sent rows older than 30 d (same statement as Node).
	_, _ = tx.Exec(ctx,
		`DELETE FROM scheduled_messages
		  WHERE sent_at IS NOT NULL AND sent_at < NOW() - INTERVAL '30 days'`)
	if err := tx.Commit(ctx); err != nil {
		log.Printf("[sched sweep] commit: %v", err)
		return
	}
	if delivered > 0 {
		log.Printf("[sched] delivered %d scheduled message(s)", delivered)
	}
}

func deliverScheduled(ctx context.Context, tx pgx.Tx, schedID int64, userID, chatID, msgType string, content *string, meta []byte, replyToID *int64) error {
	// Skip if the sender left after scheduling — stamp sent, no message.
	var one int
	if err := tx.QueryRow(ctx,
		`SELECT 1 FROM chat_members WHERE chat_id = $1 AND user_id = $2 AND left_at IS NULL`,
		chatID, userID).Scan(&one); err != nil {
		if db.NoRows(err) {
			_, e := tx.Exec(ctx, `UPDATE scheduled_messages SET sent_at = NOW() WHERE id = $1`, schedID)
			return e
		}
		return err
	}

	var (
		msgID                             int64
		mChatID, mSenderID, mType         string
		mContent                          *string
		mMeta                             []byte
		mReplyToID                        *int64
		mEditedAt, mDeletedAt, mExpiresAt *time.Time
		mCreatedAt                        time.Time
	)
	if err := tx.QueryRow(ctx,
		`INSERT INTO messages (chat_id, sender_id, type, content, meta, reply_to_id, expires_at)
		 SELECT $1, $2, $3, $4, $5, $6,
		        CASE WHEN c.disappearing_seconds IS NOT NULL
		             THEN NOW() + (c.disappearing_seconds || ' seconds')::INTERVAL
		             ELSE NULL END
		   FROM chats c WHERE c.id = $1
		 RETURNING id, chat_id, sender_id, type, content, meta, reply_to_id,
		           edited_at, deleted_at, created_at, expires_at`,
		chatID, userID, msgType, content, meta, replyToID).
		Scan(&msgID, &mChatID, &mSenderID, &mType, &mContent, &mMeta, &mReplyToID,
			&mEditedAt, &mDeletedAt, &mCreatedAt, &mExpiresAt); err != nil {
		return err
	}
	if _, err := tx.Exec(ctx,
		`UPDATE chats SET last_message_id = $1, last_message_at = $2 WHERE id = $3`,
		msgID, mCreatedAt, chatID); err != nil {
		return err
	}
	if _, err := tx.Exec(ctx,
		`UPDATE scheduled_messages SET sent_at = NOW(), message_id = $2 WHERE id = $1`,
		schedID, msgID); err != nil {
		return err
	}

	// Broadcast — same key set as Node's scheduled worker payload; BIGINT ids
	// as strings + JS-shaped timestamps (node-pg parity).
	var metaVal any
	if len(mMeta) > 0 {
		_ = json.Unmarshal(mMeta, &metaVal)
	}
	var replyVal any
	if mReplyToID != nil {
		replyVal = jsonBigStr(*mReplyToID)
	}
	payload := map[string]any{
		"id":        jsonBigStr(msgID),
		"chatId":    mChatID,
		"senderId":  mSenderID,
		"type":      mType,
		"content":   mContent,
		"meta":      metaVal,
		"replyToId": replyVal,
		"editedAt":  httpx.JST(mEditedAt),
		"deletedAt": httpx.JST(mDeletedAt),
		"createdAt": httpx.JSTime(mCreatedAt),
		"expiresAt": httpx.JST(mExpiresAt),
	}
	emitx.ChatNewMessage(chatID, payload)
	return nil
}

// node-pg returns BIGINT columns as strings; keep that shape.
func jsonBigStr(n int64) string { return strconv.FormatInt(n, 10) }
