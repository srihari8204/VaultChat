// chats_ops.go — the op index for group notes and tasks (migration 145).
//
// Shared notes and tasks are event logs: each change is one E2EE text message
// in the group thread, and the app shows the fold of every op
// (lib/groups/opThread.ts). The server could not tell an op from chat text, so
// every visit to Notes or Tasks paged back through up to 2,000 messages and
// decrypted each one. Now:
//
//   - POST /chats/{id}/messages takes an optional top-level "opKind"
//     ("notes" | "tasks"), on text messages in a group only, stored in
//     messages.op_kind (chatsOpKindFromBody + chatsTagOp, called from
//     chatsMessagePost).
//   - GET /chats/{id}/ops?kind=&before=&limit= returns only those messages, in
//     the message list's own shape and order, to current members.
//
// METADATA TRADE-OFF. The tag is plaintext: the server learns THAT a message is
// a notes op or a tasks op (so how often, and when, a group changes its notes
// or tasks). It never learns the content — the op (title, body, assignee, due
// date, done, pinned, and even whether it is an add, edit or delete) stays in
// the ciphertext. Nothing else about the message changes.
package routes

import (
	"context"
	"fmt"
	"log"
	"net/http"

	"github.com/jackc/pgx/v5"

	"vaultchat/backend-go/internal/httpx"
	"vaultchat/backend-go/internal/redisx"
)

// The kinds the index carries. The migration's CHECK holds the same two.
var chatOpKinds = map[string]bool{"notes": true, "tasks": true}

// Read budget per user. A visit reads a few pages; this only stops a loop.
const (
	chatOpsReadLimit  = 120
	chatOpsReadWindow = 60
)

// chatsOpsConsume is redisx.Consume (fails open, like the send limiter) behind
// a variable so a test can pin the boundary.
var chatsOpsConsume = redisx.Consume

// RegisterChatOpsOnID mounts the op index read on the /chats/{id}/ router.
func RegisterChatOpsOnID(id *http.ServeMux) {
	id.HandleFunc("GET /chats/{id}/ops", httpx.RequireAuth(chatsOpsGet))
}

// chatsOpKindFromBody validates a send body's optional "opKind". Absent or
// null is "no tag". Anything else must be a known kind, on a text message, in
// a group; otherwise it returns the 400 message and code. mem is the sender's
// membership, already required by the caller.
func chatsOpKindFromBody(b map[string]any, mem *chatsMem, msgType string) (kind, errMsg, errCode string) {
	raw, ok := b["opKind"]
	if !ok || raw == nil {
		return "", "", ""
	}
	s, isStr := raw.(string)
	if !isStr || !chatOpKinds[s] {
		return "", "opKind must be notes or tasks", "invalid_op_kind"
	}
	if mem == nil || mem.ChatType != "group" || msgType != "text" {
		return "", "opKind is only accepted on text messages in a group", "op_kind_not_allowed"
	}
	return s, "", ""
}

// chatsTagOp stamps the tag on the row the send just inserted, in the send's
// transaction. A no-op for an untagged message, so ordinary sends do not touch
// the new column at all.
func chatsTagOp(ctx context.Context, tx pgx.Tx, msgID int64, kind string) error {
	if kind == "" {
		return nil
	}
	_, err := tx.Exec(ctx, `UPDATE messages SET op_kind = $1 WHERE id = $2`, kind, msgID)
	return err
}

// GET /chats/{id}/ops?kind=notes|tasks&before=&limit= — the tagged op messages
// of one kind, newest first, in the GET /chats/{id}/messages element shape.
// Same membership gate, expiry filter, body join, limit default and cap as the
// message list; deleted rows are returned with deletedAt, as there.
func chatsOpsGet(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	user := httpx.UserFrom(r)
	chatID := r.PathValue("id")

	if rl := chatsOpsConsume(ctx, "chat:ops:"+user.ID, chatOpsReadLimit, chatOpsReadWindow); !rl.Allowed {
		httpx.Err(w, http.StatusTooManyRequests, "Too many requests. Try again shortly.",
			map[string]any{"retryAfter": rl.ResetInSec})
		return
	}
	if mem := chatsRequireMem(w, r, 403, "Not a member of this chat", "Failed to load notes or tasks"); mem == nil {
		return
	}

	q := r.URL.Query()
	kind := q.Get("kind")
	if !chatOpKinds[kind] {
		httpx.Err(w, 400, "kind must be notes or tasks", map[string]any{"code": "invalid_op_kind"})
		return
	}
	var before int64
	if s := q.Get("before"); s != "" {
		if n, ok := httpx.ParseIntPrefix(s); ok {
			before = n
		}
	}
	limit := int64(chatsDefaultPage)
	if s := q.Get("limit"); s != "" {
		if n, ok := httpx.ParseIntPrefix(s); ok && n > 0 {
			limit = n
		}
	}
	if limit > chatsMaxPage {
		limit = chatsMaxPage
	}

	// m.-qualified throughout: message_bodies shares column names (see
	// chatsMessagesGet). chat_id + op_kind + id DESC is idx_messages_op_kind.
	args := []any{chatID, kind}
	where := `m.chat_id = $1 AND m.op_kind = $2 AND (m.expires_at IS NULL OR m.expires_at > NOW())`
	if before != 0 {
		args = append(args, before)
		where += fmt.Sprintf(" AND m.id < $%d", len(args))
	}
	args = append(args, limit)

	out := []chatsPublicMsg{}
	err := chatsQueryU(ctx, user.ID,
		`SELECT `+chatsMsgSelBody("m")+` FROM messages m`+chatsBodyJoin+` WHERE `+where+
			fmt.Sprintf(` ORDER BY m.id DESC LIMIT $%d`, len(args)),
		args, func(rows pgx.Rows) error {
			var m chatsMsgRow
			if e := rows.Scan(m.dest()...); e != nil {
				return e
			}
			out = append(out, m.public())
			return nil
		})
	if err != nil {
		log.Printf("[ops GET] %v", err)
		httpx.Err(w, 500, "Failed to load notes or tasks")
		return
	}
	httpx.JSON(w, 200, out)
}
