// chats_bodies.go — the write half of the ephemeral body store (migration 099).
//
// Reads became body-aware first (chats.go: chatsMsgSelBody / chatsBodyJoin) and
// are unconditional. This file is the WRITER, and it is flagged, because that
// asymmetry is the rollback: a reader that always coalesces stays correct after
// the writer is switched off, so disabling the flag can never orphan a body
// that has already been stored.
//
// WHAT MOVES, AND WHY IT IS NOT JUST `content`
// --------------------------------------------
// Moving the ciphertext alone would have missed the larger leak. `messages.meta`
// is plaintext JSONB and carries a 240-pixel base64 JPEG of every photo and
// video (`meta.thumb`), plus filenames, MIME types, poll option TEXT, and
// mention lists. Measured on production: 22 of 24 image/video messages had a
// server-readable preview, and 57 rows carried a filename.
//
// A thumbnail is message content. Leaving it on a durable spine while carefully
// expiring the ciphertext beside it would have produced a system that expires
// the encrypted payload and keeps a legible picture of it forever.
//
// So meta is split at the boundary of what the SERVER genuinely needs to route,
// authorise and validate a message — everything else travels with the body and
// dies with it.
package routes

import (
	"context"
	"encoding/json"
	"fmt"
	"log"
	"net/http"
	"time"

	"github.com/jackc/pgx/v5"

	"vaultchat/backend-go/internal/db"
	"vaultchat/backend-go/internal/emitx"
	"vaultchat/backend-go/internal/httpx"
	"vaultchat/backend-go/internal/jobs"
	"vaultchat/backend-go/internal/metrics"
)

// bodiesEnabled gates the WRITE side only. Default OFF: applying migration 099
// and deploying this binary changes nothing until it is switched on.
//
// Delegates to jobs.BodyStoreEnabled rather than re-reading the env var, which
// it used to do. Two independent readings of one flag is exactly how the writer
// and the reclaim jobs come to disagree about whether bodies are live — and now
// that the flag can be REFUSED (the store's 3-hour ceiling cannot satisfy the
// 30-day retention floor; see jobs.bodyStoreRefused), a second reading would
// have kept writing bodies that the refused jobs no longer manage.
func bodiesEnabled() bool { return jobs.BodyStoreEnabled() }

// chatsMetaPublicKeys is the allow-list that stays on the durable spine.
//
// An ALLOW-list, never a deny-list. A deny-list fails open: the next feature to
// add a meta field would leave it on the spine by default, and nobody would
// notice until it was auditied. This way a new field is private until someone
// deliberately argues it belongs to the server.
//
// Each entry earns its place by being read by SERVER code:
//
//	attachmentId   uploads.go authorises downloads by joining meta->>'attachmentId'
//	viewOnce       uploads.go gates the one-shot view
//	revoked        uploads.go media revoke
//	announcement   chatsMessagePost enforces PermSendAnnouncement
//	audience       chatsAudienceAllowed validates the addressed subtree
//	silent         chatsSendMessagePush suppresses the push
//	groupId        chatsValidateGroupRef validates the card
//	gifUrl         validated server-side against chatsGifURLRe (a public URL anyway)
//	allowMultiple  poll vote handler
//	optionCount    poll vote handler — see chatsSplitMeta
//	mentionUserIds push override for muted chats — see chatsSplitMeta
//	encrypted      render hint the client needs BEFORE it has the body
var chatsMetaPublicKeys = map[string]bool{
	"attachmentId": true, "viewOnce": true, "revoked": true,
	"announcement": true, "audience": true, "silent": true,
	"groupId": true, "gifUrl": true,
	"allowMultiple": true, "optionCount": true,
	"mentionUserIds": true, "encrypted": true,
}

// chatsSplitMeta divides message metadata into what the server keeps forever and
// what expires with the body.
//
// Two fields are DERIVED rather than copied, because the server needs an
// answer without needing the content:
//
//   - optionCount: the poll vote handler validated `optionIndex` against the
//     option TEXT array. Storing the count instead lets it keep enforcing
//     0 <= index < n while the options themselves become ephemeral — polls keep
//     working after the body expires, and the server never holds what the
//     choices say.
//
//   - mentionUserIds: chatsSendMessagePush overrides a muted chat for mentioned
//     users, reading only `userId` from each mention. Reducing the array to bare
//     ids preserves that exactly while the display text goes private.
//
// Both are computed here, server-side, from whatever an existing client already
// sends — so no client change is required for either to work.
func chatsSplitMeta(meta map[string]any) (pub map[string]any, priv map[string]any) {
	if meta == nil {
		return nil, nil
	}
	pub = map[string]any{}
	priv = map[string]any{}
	for k, v := range meta {
		if chatsMetaPublicKeys[k] {
			pub[k] = v
			continue
		}
		priv[k] = v
	}
	// Derive optionCount from the poll options before they leave the spine.
	if opts, ok := meta["options"].([]any); ok {
		pub["optionCount"] = len(opts)
	}
	// Derive the bare mention ids from the full mention objects.
	if arr, ok := meta["mentions"].([]any); ok {
		ids := []any{}
		for _, m := range arr {
			if mm, ok := m.(map[string]any); ok {
				if uid, ok := mm["userId"].(string); ok && uid != "" {
					ids = append(ids, uid)
				}
			}
		}
		if len(ids) > 0 {
			pub["mentionUserIds"] = ids
		}
	}
	if len(pub) == 0 {
		pub = nil
	}
	if len(priv) == 0 {
		priv = nil
	}
	return pub, priv
}

// chatsJSONParam marshals a map for a jsonb bind. nil stays nil so the column is
// NULL rather than the string "null". Mirrors the existing metaParam handling in
// chatsMessagePost — under exec-mode/PgBouncer pgx cannot infer a type for a raw
// map, so every value must go over as text and be cast by the column type.
func chatsJSONParam(m map[string]any) any {
	if m == nil {
		return nil
	}
	j, err := json.Marshal(m)
	if err != nil {
		return nil
	}
	return string(j)
}

// chatsInsertBody writes the ephemeral half inside the SAME transaction as the
// spine row. Same transaction is the whole integrity story: message_bodies
// deliberately has no foreign key to messages (an FK would make DROP PARTITION
// expensive to validate), so atomicity here is what stops a spine row from ever
// existing without its body, or the reverse.
//
// body_expires_at comes from the row's own SERVER-generated created_at via
// jobs.BodyExpiresAt — never from time.Now() at call time, and never from
// anything a client sent. That is what makes the deadline identical on the
// original insert and on every retry, edit or reconnect that recomputes it.
func chatsInsertBody(
	ctx context.Context, tx pgx.Tx,
	msgID int64, chatID string, createdAt time.Time,
	content any, metaPrivate map[string]any,
) error {
	_, err := tx.Exec(ctx,
		`INSERT INTO message_bodies (message_id, chat_id, created_at, content, meta_private, body_expires_at)
		      VALUES ($1, $2, $3, $4, $5, $6)
		 ON CONFLICT (message_id, created_at) DO UPDATE
		    SET content = EXCLUDED.content, meta_private = EXCLUDED.meta_private`,
		msgID, chatID, createdAt, content, chatsJSONParam(metaPrivate),
		jobs.BodyExpiresAt(createdAt))
	if err == nil {
		metrics.Inc("message_bodies_written_total")
		return nil
	}
	// The only expected failure is a missing partition — the maintenance job
	// keeps 48 hours ahead, so this means it has been failing unnoticed. A
	// message send must not 500 for that reason, so create the partition and
	// retry ONCE. Any other error is real and propagates.
	if !chatsIsMissingPartition(err) {
		return err
	}
	metrics.Inc("message_bodies_partition_miss_total")
	if e := jobs.EnsurePartitionFor(ctx, createdAt); e != nil {
		return err // surface the ORIGINAL failure, not the repair's
	}
	_, err = tx.Exec(ctx,
		`INSERT INTO message_bodies (message_id, chat_id, created_at, content, meta_private, body_expires_at)
		      VALUES ($1, $2, $3, $4, $5, $6)
		 ON CONFLICT (message_id, created_at) DO UPDATE
		    SET content = EXCLUDED.content, meta_private = EXCLUDED.meta_private`,
		msgID, chatID, createdAt, content, chatsJSONParam(metaPrivate),
		jobs.BodyExpiresAt(createdAt))
	if err == nil {
		metrics.Inc("message_bodies_written_total")
	}
	return err
}

// chatsIsMissingPartition recognises "no partition of relation ... found for row"
// (SQLSTATE 23514, check_violation). Matched on the code rather than the message
// so a localised or reworded server string cannot turn the on-demand repair path
// into a hard send failure.
func chatsIsMissingPartition(err error) bool {
	var pgErr interface{ SQLState() string }
	if ok := asPgError(err, &pgErr); ok {
		return pgErr.SQLState() == "23514"
	}
	return false
}

func asPgError(err error, target *interface{ SQLState() string }) bool {
	for e := err; e != nil; {
		if s, ok := e.(interface{ SQLState() string }); ok {
			*target = s
			return true
		}
		u, ok := e.(interface{ Unwrap() error })
		if !ok {
			return false
		}
		e = u.Unwrap()
	}
	return false
}

// chatsDeleteBody removes the ephemeral half. Used by delete-for-everyone, which
// must take the ciphertext with it IMMEDIATELY rather than waiting for the
// retention sweep.
//
// The tombstone on the spine keeps the full 60-hour product window; the
// ciphertext does not, and does not need to — there is nothing to delete later
// if it is already gone. That split is the reason the 60-hour delete window and
// the 3-hour body ceiling can coexist without one weakening the other.
func chatsDeleteBody(ctx context.Context, tx pgx.Tx, msgID int64, createdAt time.Time) error {
	_, err := tx.Exec(ctx,
		`DELETE FROM message_bodies WHERE message_id = $1 AND created_at = $2`, msgID, createdAt)
	if err == nil {
		metrics.Inc("message_bodies_deleted_on_action_total")
	}
	return err
}

// chatsBodyCreatedAt fetches a message's immutable created_at — the partition
// key needed to address its body. Bound to the caller so RLS applies.
func chatsBodyCreatedAt(ctx context.Context, uid string, msgID int64, chatID string) (time.Time, error) {
	var t time.Time
	err := chatsQRow(ctx, uid,
		`SELECT created_at FROM messages WHERE id = $1 AND chat_id = $2`,
		[]any{msgID, chatID}, &t)
	return t, err
}

// ─── PUT /chats/{id}/messages/{msgId}/body — sender recovery ──────────
//
// The recovery half of the ephemeral store: a sender re-seals an EXISTING
// message and re-uploads its body, without minting a new message.
//
// WHY IT IS NOT A RESEND
// ----------------------
// A plain resend cannot work here. The outbox persists a stable `clientId`, and
// ux_messages_client_dedup + ON CONFLICT DO NOTHING mean re-POSTing it returns
// the original row and writes nothing — a silent no-op. Using a FRESH clientId
// would write a second row, and the recipient would see the message twice.
//
// So recovery reuses the durable spine identity: same message id, same clientId,
// same bubble, same ordering, new ciphertext. The recipient receives an id it has
// never seen and treats it as an ordinary message.
//
// SECURITY — this is a write onto an existing message id, so it is treated as a
// forgery primitive unless every one of these holds:
//
//	authenticated caller           (RequireAuth)
//	caller IS the original sender  (sender_id = $uid in the WHERE clause)
//	message is not deleted         (deleted_at IS NULL)
//	message is inside its window   (see the 410 below)
//	body write is idempotent       (ON CONFLICT DO UPDATE)
//	server never sees plaintext    (content is an opaque blob, as on send)
//
// The ownership test is a WHERE clause, not a check beside the query, for the
// same reason the edit window is: a predicate cannot be routed around.
func chatsMessageBodyPut(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	user := httpx.UserFrom(r)
	chatID := r.PathValue("id")
	if mem := chatsRequireMem(w, r, 403, "Not a member", "Failed to restore message"); mem == nil {
		return
	}
	if !bodiesEnabled() {
		httpx.Err(w, 503, "Message body storage is not enabled on this server")
		return
	}
	msgID, ok := httpx.ParseIntPrefix(r.PathValue("msgId"))
	if !ok {
		httpx.Err(w, 400, "invalid msgId")
		return
	}
	var b map[string]any
	_ = httpx.Body(r, &b)
	content, isStr := b["content"].(string)
	if !isStr || content == "" {
		httpx.Err(w, 400, "content required")
		return
	}
	if len([]rune(content)) > 1_000_000 {
		httpx.Err(w, http.StatusRequestEntityTooLarge, "content too large (max 1 MB)")
		return
	}

	var createdAt time.Time
	err := chatsQRow(ctx, user.ID,
		`SELECT created_at FROM messages
		  WHERE id = $1 AND chat_id = $2 AND sender_id = $3 AND deleted_at IS NULL`,
		[]any{msgID, chatID, user.ID}, &createdAt)
	if db.NoRows(err) {
		httpx.Err(w, 404, "Message not found, not yours, or deleted")
		return
	}
	if err != nil {
		log.Printf("[message body PUT] %v", err)
		httpx.Err(w, 500, "Failed to restore message")
		return
	}

	// PAST THE WINDOW: FAIL EXPLICITLY.
	//
	// The body's deadline is anchored to the message's own created_at, so a
	// re-body after that instant would write a row that is already expired and
	// the very next sweep would remove it — recovery theatre.
	//
	// Granting a FRESH window instead would mean this message's ciphertext could
	// sit on the server for another full TTL each time the sender retried, which
	// is a sliding retention window (§22) reached by a different route. Making
	// that safe needs the partition key to become the BODY's creation time
	// rather than the message's — a schema change with real consequences for
	// pruning and for the read join, and not one to make silently.
	//
	// So this returns 410 and says why. The caller keeps its local copy and its
	// message identity; nothing is duplicated and nothing is lost on the sender
	// side. Recovery beyond the window is the one genuinely blocked case, and it
	// is blocked loudly rather than by writing a row that quietly evaporates.
	if !time.Now().Before(jobs.BodyExpiresAt(createdAt)) {
		metrics.Inc("message_rebody_expired_total")
		httpx.Err(w, http.StatusGone,
			"This message's server retention window has passed and it cannot be re-delivered",
			map[string]any{"code": "body_window_expired", "messageId": msgID})
		return
	}

	if err := db.WithUser(ctx, user.ID, func(tx pgx.Tx) error {
		return chatsInsertBody(ctx, tx, msgID, chatID, createdAt, content, nil)
	}); err != nil {
		log.Printf("[message body PUT] %v", err)
		httpx.Err(w, 500, "Failed to restore message")
		return
	}
	metrics.Inc("message_rebody_total")

	// Re-deliver over the SAME event the original send used, so a recipient
	// needs no new code path: it is a message id they have not seen, arriving
	// normally.
	emitx.ChatEvent(chatID, "message_rebodied", map[string]any{
		"id": fmt.Sprintf("%d", msgID), "chatId": chatID, "content": content,
	})
	httpx.JSON(w, 200, map[string]any{"ok": true, "id": fmt.Sprintf("%d", msgID)})
}

// ─── metrics registration ─────────────────────────────────────────────

// RegisterBodyGauges exposes the two numbers that say whether retention is
// actually working: how many bodies exist, and how many are past their
// deadline. A live body count that grows without bound, or an overdue count
// that is not ~0, means the reclaim path has stopped and the 3-hour guarantee
// is not being met — which is otherwise invisible until someone audits the DB.
func RegisterBodyGauges() {
	var (
		last            time.Time
		liveN, overdueN float64
	)
	sample := func() {
		if time.Since(last) < 30*time.Second {
			return
		}
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		var live, overdue int64
		if err := db.SysPool.QueryRow(ctx,
			`SELECT count(*), count(*) FILTER (WHERE body_expires_at <= NOW()) FROM message_bodies`,
		).Scan(&live, &overdue); err != nil {
			return
		}
		liveN, overdueN = float64(live), float64(overdue)
		last = time.Now()
	}
	metrics.SetGauge("message_bodies_live", func() float64 { sample(); return liveN })
	metrics.SetGauge("message_bodies_overdue", func() float64 { sample(); return overdueN })
}
