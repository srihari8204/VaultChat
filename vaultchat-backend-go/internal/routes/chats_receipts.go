// chats_receipts.go — Message Info: per-member delivered/read times for one
// message the caller sent (migration 142, chat_receipt_log).
package routes

import (
	"context"
	"log"
	"net/http"
	"time"

	"github.com/jackc/pgx/v5"

	"vaultchat/backend-go/internal/db"
	"vaultchat/backend-go/internal/httpx"
)

// chatsLogReceipt records that a member's delivered ("d") or read ("r")
// pointer advanced to messageID now. Best-effort: the pointer itself is the
// source of truth for state, this only adds the time, so a failure is logged
// and never fails the receipt POST.
func chatsLogReceipt(ctx context.Context, chatID, userID, kind string, messageID int64) {
	if _, err := db.Pool.Exec(ctx,
		`INSERT INTO chat_receipt_log (chat_id, user_id, kind, message_id)
		 VALUES ($1, $2, $3, $4) ON CONFLICT DO NOTHING`,
		chatID, userID, kind, messageID); err != nil {
		log.Printf("[receipt log] %s: %v", kind, err)
	}
}

type chatsReceiptRow struct {
	UserID      string        `json:"userId"`
	Delivered   bool          `json:"delivered"`
	Read        bool          `json:"read"`
	DeliveredAt *httpx.JSTime `json:"deliveredAt"`
	ReadAt      *httpx.JSTime `json:"readAt"`
}

// GET /chats/{id}/messages/{msgId}/receipts
//
// A pointer only moves forward, so the FIRST log row at or past the message
// (one primary-key range probe per member) is when that member covered it.
//
// Only the message's SENDER, and only while a member: Message Info is the
// sender's view. Rows are the other CURRENT members (left members excluded,
// matching the client's summary tick). Read state and read time obey the same
// reciprocity rule as GET /chats/{id}: in a direct chat where anyone has read
// receipts off, peers' read pointers are withheld, and so are their read times.
func chatsMessageReceipts(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	user := httpx.UserFrom(r)
	chatID := r.PathValue("id")
	mem := chatsRequireMem(w, r, 404, "Chat not found", "Failed to load message info")
	if mem == nil {
		return
	}
	msgID, ok := httpx.ParseIntPrefix(r.PathValue("msgId"))
	if !ok || msgID <= 0 {
		httpx.Err(w, 400, "invalid msgId")
		return
	}
	var senderID *string
	err := db.Pool.QueryRow(ctx,
		`SELECT sender_id::text FROM messages WHERE id = $1 AND chat_id = $2 AND deleted_at IS NULL`,
		msgID, chatID).Scan(&senderID)
	if err != nil && !db.NoRows(err) {
		log.Printf("[receipts GET] %v", err)
		httpx.Err(w, 500, "Failed to load message info")
		return
	}
	// Not found, deleted, another chat's id, or someone else's message: one 404,
	// so the route cannot be used to probe which ids exist.
	if db.NoRows(err) || senderID == nil || *senderID != user.ID {
		httpx.Err(w, 404, "Message not found")
		return
	}

	rows := []chatsReceiptRow{}
	anyReceiptsOff := false
	err = chatsQueryU(ctx, user.ID,
		`SELECT cm.user_id::text,
		        COALESCE(cm.last_delivered_message_id, 0) >= $2 OR COALESCE(cm.last_read_message_id, 0) >= $2,
		        COALESCE(cm.last_read_message_id, 0) >= $2,
		        (SELECT l.at FROM chat_receipt_log l
		          WHERE l.chat_id = $1 AND l.user_id = cm.user_id AND l.kind = 'd' AND l.message_id >= $2
		          ORDER BY l.message_id LIMIT 1),
		        (SELECT l.at FROM chat_receipt_log l
		          WHERE l.chat_id = $1 AND l.user_id = cm.user_id AND l.kind = 'r' AND l.message_id >= $2
		          ORDER BY l.message_id LIMIT 1),
		        COALESCE(u.read_receipts, TRUE),
		        COALESCE(g.hide_read, FALSE)
		   FROM chat_members cm JOIN users u ON u.id = cm.user_id
		   LEFT JOIN ghost_mode g ON g.owner_id = cm.user_id AND g.target_id = $3
		  WHERE cm.chat_id = $1 AND cm.user_id <> $3 AND cm.left_at IS NULL
		  ORDER BY cm.joined_at`,
		[]any{chatID, msgID, user.ID}, func(rs pgx.Rows) error {
			var row chatsReceiptRow
			var dAt, rAt *time.Time
			var receipts, ghostRead bool
			if e := rs.Scan(&row.UserID, &row.Delivered, &row.Read, &dAt, &rAt, &receipts, &ghostRead); e != nil {
				return e
			}
			if !receipts {
				anyReceiptsOff = true
			}
			// Ghost Mode hide_read toward the sender: realtime never sent them
			// this member's message_read, so Message Info must not either.
			if ghostRead {
				row.Read, rAt = false, nil
			}
			row.DeliveredAt, row.ReadAt = httpx.JST(dAt), httpx.JST(rAt)
			rows = append(rows, row)
			return nil
		})
	if err != nil {
		log.Printf("[receipts GET] %v", err)
		httpx.Err(w, 500, "Failed to load message info")
		return
	}
	// The caller's own setting counts too (chatsGet checks every active member).
	if mem.ChatType == "direct" && !anyReceiptsOff {
		var mine *bool
		if e := db.Pool.QueryRow(ctx, `SELECT read_receipts FROM users WHERE id = $1`, user.ID).Scan(&mine); e == nil &&
			mine != nil && !*mine {
			anyReceiptsOff = true
		}
	}
	hidden := mem.ChatType == "direct" && anyReceiptsOff
	for i := range rows {
		if hidden {
			// Withhold read state AND read time; the delivered time stays the
			// delivered ack's own, never the read time standing in for it.
			rows[i].Read, rows[i].ReadAt = false, nil
			continue
		}
		// Reading implies delivery: a read pointer that jumped past M with no
		// separate delivered ack means delivery happened no later than the read.
		if ra := rows[i].ReadAt; ra != nil {
			if da := rows[i].DeliveredAt; da == nil || time.Time(*ra).Before(time.Time(*da)) {
				rows[i].DeliveredAt = ra
			}
		}
	}
	httpx.JSON(w, 200, map[string]any{
		"messageId":          userBigStr(&msgID),
		"readReceiptsHidden": hidden,
		"members":            rows,
	})
}
