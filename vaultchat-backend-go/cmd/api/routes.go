package main

import (
	"net/http"

	"vaultchat/backend-go/internal/routes"
	"vaultchat/backend-go/internal/services"
)

// registerRoutes mounts the paths of every service this process runs
// (SERVICES; openspec: microservices-prepare). A path is served by exactly one
// service; everything else falls through to main's 404 catch-all, which is what
// lets Caddy send a moved feature's paths to its own container and fall back to
// core while that container is down. Route registration here is still the
// Go-side counterpart of the Caddyfile blocks.
func registerRoutes(mux *http.ServeMux) {
	if services.Enabled(services.Core) {
		routes.RegisterContacts(mux)
		routes.RegisterAppVersion(mux) // GET /app/version — the minimum-build gate
		routes.RegisterTerms(mux)      // GET/POST /user/terms — recorded acceptance (F10)
		routes.RegisterAppFlags(mux)   // GET /app/flags — the kill switch (F11)
		routes.RegisterUsage(mux)      // POST /app/usage — aggregate screen counts (F9)
		routes.RegisterLink(mux)
		routes.RegisterGif(mux)
		routes.RegisterStories(mux)
		routes.RegisterCommunities(mux)
		routes.RegisterAuth(mux)
		routes.RegisterUploads(mux)
		routes.RegisterChannels(mux)
		routes.RegisterVaultbeam(mux)
		routes.RegisterUser(mux)
		routes.RegisterAdmin(mux)
		// Also mounts Family Space's groups on the chat router while this
		// process runs family too (routes.RegisterFamilySpaceOnID).
		routes.RegisterChats(mux)
		routes.RegisterChatInvitations(mux) // Groups & Circles: /invitations (invitee side)
		// Chat codes: open a direct chat with someone whose number you do not have.
		// Redeeming goes through directChatEnsure, the same path POST /chats uses.
		routes.RegisterChatCodes(mux)
		routes.RegisterChatMembership(mux) // Groups & Circles: in-app accept (invitee side)
	}

	if services.Enabled(services.Family) {
		routes.RegisterFamilySafety(mux) // /user/sos and /contacts/trusted
		if !services.Enabled(services.Core) {
			routes.RegisterFamilySpace(mux) // its own /chats/{id}/ router
		}
	}

	if services.Enabled(services.Maps) {
		routes.RegisterNav(mux)
	}

	if services.Enabled(services.Games) {
		routes.RegisterGames(mux) // VaultGames mini-app launch token
	}

	if services.Enabled(services.Calls) {
		routes.RegisterCalls(mux)
		routes.RegisterCallSessions(mux)
	}

	if services.Enabled(services.GoLive) {
		routes.RegisterBroadcasts(mux)
		routes.RegisterBroadcastSocial(mux)
		// Egress lifecycle → broadcast status. Under /internal/, which Caddy 404s
		// from outside, and signature-verified on top of that.
		routes.RegisterBroadcastWebhook(mux)
		// Go Live runs its OWN LiveKit deployment (internal/golive), so it needs its
		// own receiver — deliveries are signed with a different project's secret and
		// the calling receiver above would reject them, correctly. Also carries the
		// host-presence events the calling one has no reason to handle.
		routes.RegisterGoLiveWebhook(mux)
		// GET /golive/health — Go Live's own liveness. Reports the Go Live LiveKit
		// only; a failure here can never mark the calling LiveKit unhealthy.
		routes.RegisterGoLive(mux)
		// Polls: the one thing the UNBOUNDED audience writes to. Live tallies come
		// from Redis sets, the durable record from Postgres — same split the viewer
		// and like counts already use.
		routes.RegisterGoLivePolls(mux)
		// Shareable Private Live invitations. The link IS the access mechanism —
		// the host does not pick invitees up front. Redeeming writes an ordinary
		// broadcast_invites row, so every existing gate applies unchanged.
		routes.RegisterGoLiveInvites(mux)
	}

	if services.Enabled(services.ShopBook) {
		routes.RegisterShopBook(mux)
		routes.RegisterShopBookStock(mux)
		routes.RegisterShopBookBilling(mux)
		routes.RegisterShopBookDocuments(mux)
		routes.RegisterShopBookPayments(mux)
		routes.RegisterShopBookKhata(mux) // walk-in customers (migration 111)
		routes.RegisterShopBookPurchases(mux)
		routes.RegisterShopBookReturns(mux)
		routes.RegisterShopBookVerify(mux)
		routes.RegisterShopBookAdmin(mux)
		routes.RegisterShopBookAdmin2(mux)
	}
}
