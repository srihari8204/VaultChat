// terms.go — has this user accepted the terms that are currently in force?
//
// AUDIT F10 (second half). There was no recorded acceptance of anything. A
// store review asks for one, but the reason to want it is simpler than
// compliance: without a record, "they agreed" is an assertion about a screen
// somebody may or may not have seen, and publishing amended terms has no way to
// ask anyone to re-accept.
//
// DELIBERATELY ITS OWN ENDPOINT, not a field on /user/profile. The profile
// handler reads a fixed column list into a positional struct, so every addition
// there is a change in three places and a chance to misalign them. This needs
// two columns and is asked for once per launch; a small dedicated route is the
// cheaper shape and does not put terms plumbing in the path of every profile
// read.
//
// DELIBERATELY ENV-DRIVEN, like the version gate next door. Publishing amended
// terms is an operational act — edit caddy/public/terms.html, set
// VAULTCHAT_TERMS_VERSION to a new label, restart. No migration, and nothing to
// get out of sync between replicas.
//
//	VAULTCHAT_TERMS_VERSION  the label now in force. UNSET MEANS NOBODY IS ASKED.
//	VAULTCHAT_TERMS_URL      where to read them.
//
// Unset is the safe default on purpose: a server with no configuration must not
// put a blocking screen in front of every user because someone forgot an env
// var.
package routes

import (
	"encoding/json"
	"net/http"
	"os"
	"strings"
	"time"

	"vaultchat/backend-go/internal/db"
	"vaultchat/backend-go/internal/httpx"

	"github.com/jackc/pgx/v5"
)

const defaultTermsURL = "https://api.corefinite.com/terms"

func termsRequiredVersion() string {
	return strings.TrimSpace(os.Getenv("VAULTCHAT_TERMS_VERSION"))
}

func termsURL() string {
	if u := strings.TrimSpace(os.Getenv("VAULTCHAT_TERMS_URL")); u != "" {
		return u
	}
	return defaultTermsURL
}

func RegisterTerms(mux *http.ServeMux) {
	mux.HandleFunc("GET /user/terms", httpx.RequireAuth(termsGet))
	mux.HandleFunc("POST /user/terms", httpx.RequireAuth(termsPost))
}

func termsGet(w http.ResponseWriter, r *http.Request) {
	user := httpx.UserFrom(r)
	ctx := r.Context()

	var accepted *string
	var at *time.Time
	err := db.Pool.QueryRow(ctx,
		`SELECT terms_version, terms_accepted_at FROM users WHERE id = $1 LIMIT 1`,
		user.ID).Scan(&accepted, &at)
	if err != nil && err != pgx.ErrNoRows {
		httpx.Err(w, 500, "Could not read terms acceptance")
		return
	}

	required := termsRequiredVersion()
	// Equality, never ordering. The version is an opaque label an operator
	// chooses — "2026-09" and "1.1" are both valid — so anything that tried to
	// compare them as numbers would be wrong for most of the labels a person
	// would reasonably pick.
	outstanding := required != "" && (accepted == nil || *accepted != required)

	httpx.JSON(w, 200, map[string]any{
		"requiredVersion": required,
		"acceptedVersion": accepted,
		"acceptedAt":      at,
		"outstanding":     outstanding,
		"url":             termsURL(),
	})
}

func termsPost(w http.ResponseWriter, r *http.Request) {
	user := httpx.UserFrom(r)
	ctx := r.Context()

	var body struct {
		Version string `json:"version"`
	}
	_ = json.NewDecoder(r.Body).Decode(&body)
	version := strings.TrimSpace(body.Version)
	if version == "" {
		httpx.Err(w, 400, "version required")
		return
	}
	if len(version) > 64 {
		httpx.Err(w, 400, "version too long")
		return
	}

	// Record only the version actually in force. A client that posts a label
	// the server does not recognise is either out of date or making it up, and
	// storing whatever it said would turn the record into a note about what the
	// client believed rather than evidence of what was agreed to.
	required := termsRequiredVersion()
	if required == "" {
		httpx.Err(w, 409, "No terms version is in force")
		return
	}
	if version != required {
		httpx.Err(w, 409, "Those are not the terms currently in force")
		return
	}

	if _, err := db.Pool.Exec(ctx,
		`UPDATE users SET terms_version = $1, terms_accepted_at = NOW() WHERE id = $2`,
		version, user.ID); err != nil {
		httpx.Err(w, 500, "Could not record acceptance")
		return
	}

	httpx.JSON(w, 200, map[string]any{"ok": true, "acceptedVersion": version})
}
