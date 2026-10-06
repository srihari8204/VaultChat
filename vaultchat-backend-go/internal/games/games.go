// Package games is the composition root of the Games module (openspec:
// hexagonal-architecture): the VaultGames mini-app's launch token, turn/invite
// pushes from the games server, the live-tables list, Pool/Deals matches and
// table voice.
//
//	adapters/httpapi ──▶ app (use cases, ports) ──▶ domain
//	                         ▲ implemented by
//	adapters/postgres, launchtoken, notifykey, livekitvoice, push
package games

import (
	"net/http"
	"time"

	"vaultchat/backend-go/internal/games/adapters/httpapi"
	"vaultchat/backend-go/internal/games/adapters/launchtoken"
	"vaultchat/backend-go/internal/games/adapters/livekitvoice"
	"vaultchat/backend-go/internal/games/adapters/notifykey"
	"vaultchat/backend-go/internal/games/adapters/postgres"
	"vaultchat/backend-go/internal/games/adapters/push"
	"vaultchat/backend-go/internal/games/app"
)

// Register mounts every /games/* route.
func Register(mux *http.ServeMux) {
	store, p := postgres.Store{}, push.Push{}
	httpapi.Register(mux, &app.Service{
		Players:  store,
		Signer:   &launchtoken.Signer{},
		Verifier: &notifykey.Verifier{},
		Voice:    livekitvoice.Tokens{},
		Tables:   store,
		Dedupe:   store,
		Devices:  p,
		Pusher:   p,
		Matches:  store,
		Now:      time.Now,
	})
}
