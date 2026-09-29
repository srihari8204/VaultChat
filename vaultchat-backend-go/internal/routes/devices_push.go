// devices_push.go — push-device lookup and registration (openspec:
// microservices-prepare). Core owns the devices table; Calls and Games both
// use these, so they moved here from calls.go. Names are unchanged.
package routes

import (
	"context"
	"vaultchat/backend-go/internal/db"

	"github.com/jackc/pgx/v5/pgconn"
)

func fcmTokensFor(ctx context.Context, userID string) []string {
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

// registerFcmDevice upserts one device's native FCM token.
//
// ONE ROW PER DEVICE, NOT ONE PER FEATURE. Calls, chat pushes and games turn
// notifications all read `devices.fcm_token` through fcmTokensFor, so they must
// all WRITE it the same way — a second registration path that inserted its own
// row would hand every sender a duplicate token and every recipient a duplicate
// notification. Shared by POST /call/token and POST /games/device-token.
func registerFcmDevice(ctx context.Context, userID, fcmToken, platform string) error {
	return registerFcmDeviceWithExec(ctx, db.Pool.Exec, userID, fcmToken, platform)
}

func registerFcmDeviceWithExec(ctx context.Context, exec func(context.Context, string, ...any) (pgconn.CommandTag, error), userID, fcmToken, platform string) error {
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
