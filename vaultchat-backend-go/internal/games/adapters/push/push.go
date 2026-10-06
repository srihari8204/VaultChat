// Package push implements app.Devices and app.Pusher on the shared devices
// table and FCM (openspec: hexagonal-architecture).
package push

import (
	"context"
	"time"

	"vaultchat/backend-go/internal/devices"
	"vaultchat/backend-go/internal/fcm"
	"vaultchat/backend-go/internal/games/app"
)

type Push struct{}

var (
	_ app.Devices = Push{}
	_ app.Pusher  = Push{}
)

func (Push) Tokens(ctx context.Context, userID string) []string {
	return devices.FCMTokens(ctx, userID)
}

func (Push) Register(ctx context.Context, userID, token, platform string) error {
	return devices.Register(ctx, userID, token, platform)
}

func (Push) Unregister(ctx context.Context, userID, token string) error {
	return devices.Unregister(ctx, userID, token)
}

func (Push) ClearDead(ctx context.Context, tokens []string) { _ = devices.ClearDead(ctx, tokens) }

// Send — ponytail: reuses SendCallMessage, which stamps APNs voip headers.
// Correct on Android (the only shipped platform) and wrong for iOS, where a
// voip push not followed by a CallKit report is an entitlement violation.
// Split the APNs block out of SendCallMessage before an iOS build ships.
func (Push) Send(tokens []string, data map[string]string, ttl time.Duration) app.PushResult {
	res := fcm.SendCallMessage(tokens, data, ttl.Milliseconds())
	return app.PushResult{OK: res.OK, Sent: res.Sent, Dead: res.Dead}
}
