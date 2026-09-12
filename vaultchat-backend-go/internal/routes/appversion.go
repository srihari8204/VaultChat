// appversion.go — the minimum client version the server will talk to.
//
// WHY THIS EXISTS
// ---------------
// Without it, a build that is in a user's hands can talk to this server
// forever. That matters more here than in most apps because so much of this
// system is VERSIONED FORMATS: message envelopes, sender keys, backup files,
// the frozen REST/socket contract. A client that predates a format change does
// not fail loudly — it misreads, and the damage lands in someone's message
// history rather than in a log.
//
// It is also the only lever that works AFTER a security fix ships. A fix in a
// release nobody installs protects nobody, and there is otherwise no way to
// tell an old client to stop.
//
// DELIBERATELY UNAUTHENTICATED. The client asks this before it has decided
// whether it can talk to the server at all, and a blocked client may be too old
// to hold a valid token. It reveals nothing: two integers and a store URL.
//
// DELIBERATELY ENV-DRIVEN, not a database table. Raising the floor is an
// operational act taken in a hurry, usually during an incident — an env var and
// a container restart beats a migration, and there is nothing to get out of
// sync between replicas.
//
//	VAULTCHAT_MIN_BUILD      hard floor. Below this the app refuses to run.
//	VAULTCHAT_ADVISE_BUILD   soft floor. Below this the app nags but works.
//	VAULTCHAT_UPDATE_URL     where to send them.
//
// Unset means 0, which blocks nobody — so a server with no configuration keeps
// every client working. The gate can only ever be armed deliberately.
package routes

import (
	"net/http"
	"os"
	"strconv"

	"vaultchat/backend-go/internal/httpx"
)

const defaultUpdateURL = "https://play.google.com/store/apps/details?id=com.vaultchat.app"

func appVersionEnvInt(key string) int64 {
	n, err := strconv.ParseInt(os.Getenv(key), 10, 64)
	if err != nil || n < 0 {
		return 0
	}
	return n
}

// RegisterAppVersion mounts GET /app/version.
func RegisterAppVersion(mux *http.ServeMux) {
	mux.HandleFunc("GET /app/version", appVersionGet)
}

func appVersionGet(w http.ResponseWriter, r *http.Request) {
	minBuild := appVersionEnvInt("VAULTCHAT_MIN_BUILD")
	advise := appVersionEnvInt("VAULTCHAT_ADVISE_BUILD")
	// An advisory floor below the hard floor is a configuration slip, not a
	// policy: anything below minBuild is already blocked, so nagging about it
	// is noise. Lift it rather than serve a contradiction.
	if advise < minBuild {
		advise = minBuild
	}

	url := os.Getenv("VAULTCHAT_UPDATE_URL")
	if url == "" {
		url = defaultUpdateURL
	}

	httpx.JSON(w, 200, map[string]any{
		"minBuild":    minBuild,
		"adviseBuild": advise,
		"updateUrl":   url,
		// Shown on the blocking screen. Kept server-side so the reason can be
		// specific to whatever forced the floor up, rather than a generic
		// string frozen into a client that is by definition out of date.
		"message": os.Getenv("VAULTCHAT_UPDATE_MESSAGE"),
	})
}
