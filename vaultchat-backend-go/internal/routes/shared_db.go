// shared_db.go — per-user query helpers every feature uses (openspec:
// microservices-prepare). Moved here from chats.go and call_sessions.go so no
// feature file calls another feature's code; names are unchanged.
//
// RLS plumbing: Node's req.dbQuery was one withUser tx per query.
package routes

import (
	"context"
	"errors"
	"vaultchat/backend-go/internal/db"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
)

func chatsQRow(ctx context.Context, uid, q string, args []any, dest ...any) error {
	return db.WithUser(ctx, uid, func(tx pgx.Tx) error {
		return tx.QueryRow(ctx, q, args...).Scan(dest...)
	})
}

func chatsExecU(ctx context.Context, uid, q string, args ...any) error {
	return db.WithUser(ctx, uid, func(tx pgx.Tx) error {
		_, err := tx.Exec(ctx, q, args...)
		return err
	})
}

// chatsExecAffected is chatsExecU for writes whose guard lives in the SQL —
// an `INSERT ... SELECT ... WHERE EXISTS` that legitimately matches nothing.
//
// chatsExecU discards the command tag, so "wrote one row" and "the WHERE EXISTS
// rejected it" are indistinguishable, and the handler answers 200 either way.
// That turned a mistyped roster id into a link that reported success and did
// nothing — the parent then saw no child, forever, with nothing to look at.
// Callers that guard in SQL must use this and check the count.
func chatsExecAffected(ctx context.Context, uid, q string, args ...any) (int64, error) {
	var n int64
	err := db.WithUser(ctx, uid, func(tx pgx.Tx) error {
		tag, err := tx.Exec(ctx, q, args...)
		n = tag.RowsAffected()
		return err
	})
	return n, err
}

func chatsQueryU(ctx context.Context, uid, q string, args []any, each func(pgx.Rows) error) error {
	return db.WithUser(ctx, uid, func(tx pgx.Tx) error {
		rows, err := tx.Query(ctx, q, args...)
		if err != nil {
			return err
		}
		defer rows.Close()
		for rows.Next() {
			if err := each(rows); err != nil {
				return err
			}
		}
		return rows.Err()
	})
}

func isUniqueViolation(err error) bool {
	var pgErr *pgconn.PgError
	return errors.As(err, &pgErr) && pgErr.Code == "23505"
}
