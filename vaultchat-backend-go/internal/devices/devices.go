// Package devices — push-device lookup and registration. Core owns the devices
// table; Calls (internal/routes) and Games (internal/games) both use these
// (openspec: microservices-prepare moved them out of calls.go;
// hexagonal-architecture moved them out of routes so a module's adapters can
// share them without importing routes).
package devices

import (
	"context"

	"github.com/jackc/pgx/v5/pgconn"

	"vaultchat/backend-go/internal/db"
)

// FCMTokens returns the user's live native FCM tokens.
func FCMTokens(ctx context.Context, userID string) []string {
	rows, err := db.Pool.Query(ctx,
		`SELECT fcm_token FROM devices WHERE user_id = $1 AND fcm_token IS NOT NULL`, userID)
	if err != nil {
		return nil
	}
	defer rows.Close()
	out := []string{}
	for rows.Next() {
		var t *string
		if rows.Scan(&t) == nil && t != nil && *t != "" {
			out = append(out, *t)
		}
	}
	return out
}

// Register upserts one device's native FCM token.
//
// ONE ROW PER DEVICE, NOT ONE PER FEATURE. Calls, chat pushes and games turn
// notifications all read `devices.fcm_token` through FCMTokens, so they must
// all WRITE it the same way — a second registration path that inserted its own
// row would hand every sender a duplicate token and every recipient a duplicate
// notification. Shared by POST /call/token and POST /games/device-token.
func Register(ctx context.Context, userID, fcmToken, platform string) error {
	return RegisterWithExec(ctx, db.Pool.Exec, userID, fcmToken, platform)
}

func RegisterWithExec(ctx context.Context, exec func(context.Context, string, ...any) (pgconn.CommandTag, error), userID, fcmToken, platform string) error {
	_, err := exec(ctx,
		`INSERT INTO devices (user_id, push_token, fcm_token, platform, last_seen_at)
		 VALUES ($1, $2, $3, $4, NOW())
		 ON CONFLICT (user_id, push_token) DO UPDATE SET fcm_token = EXCLUDED.fcm_token, last_seen_at = NOW()`,
		userID, "fcm:"+truncRunes(fcmToken, 40), fcmToken, platform)
	if err == nil {
		return nil
	}
	// devices may require a unique push_token; fall back like Node.
	tag, fallbackErr := exec(ctx,
		`UPDATE devices SET fcm_token = $1 WHERE user_id = $2 AND fcm_token = $1`,
		fcmToken, userID)
	if fallbackErr != nil || tag.RowsAffected() == 0 {
		// A successful UPDATE of no rows registered nothing. Preserve the INSERT
		// error so the client retries instead of persisting a false success.
		return err
	}
	return nil
}

func truncRunes(s string, n int) string {
	if runes := []rune(s); len(runes) > n {
		return string(runes[:n])
	}
	return s
}

// ClearDead forgets tokens FCM reported as unregistered, so no sender tries
// them again.
func ClearDead(ctx context.Context, tokens []string) error {
	if len(tokens) == 0 {
		return nil
	}
	_, err := db.Pool.Exec(ctx, `UPDATE devices SET fcm_token = NULL WHERE fcm_token = ANY($1::text[])`, tokens)
	return err
}

// Unregister clears one of the user's own tokens. Scoped to the caller's rows:
// holding a token string is not a capability to silence somebody else's phone.
func Unregister(ctx context.Context, userID, fcmToken string) error {
	_, err := db.Pool.Exec(ctx,
		`UPDATE devices SET fcm_token = NULL WHERE user_id = $1 AND fcm_token = $2`, userID, fcmToken)
	return err
}
