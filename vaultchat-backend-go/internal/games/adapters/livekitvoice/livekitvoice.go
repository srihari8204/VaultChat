// Package livekitvoice implements app.VoiceTokens on the LiveKit SFU this app
// already runs for calls (openspec: hexagonal-architecture). One upload per
// phone instead of the O(n²) mesh table voice used to be.
package livekitvoice

import (
	"vaultchat/backend-go/internal/games/app"
	"vaultchat/backend-go/internal/livekit"
)

type Tokens struct{}

var _ app.VoiceTokens = Tokens{}

func (Tokens) Configured() bool { return livekit.ConfigFromEnv().Configured() }

// Mint grants speaker, never host/cohost — those carry RoomAdmin, the power to
// mute and remove other players. A spectator gets audience, which cannot
// publish AT THE MEDIA SERVER.
func (Tokens) Mint(identity, name, room string, spectator bool) (app.VoiceGrant, error) {
	cfg := livekit.ConfigFromEnv()
	role := livekit.RoleSpeaker
	if spectator {
		role = livekit.RoleAudience
	}
	tok, err := livekit.Mint(cfg, livekit.MintArgs{Identity: identity, Name: name, Room: room, Role: role})
	if err != nil {
		return app.VoiceGrant{}, err
	}
	return app.VoiceGrant{Token: tok, URL: cfg.URL, Role: string(role)}, nil
}
