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

	ccwirev1 "vaultchat/backend-go/internal/ccwire/gen/ccwire/v1"
	"vaultchat/backend-go/internal/db"
	"vaultchat/backend-go/internal/httpx"

	"github.com/jackc/pgx/v5"
	"google.golang.org/protobuf/proto"
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

	termsGetWrite(w, r, termsGetData{
		RequiredVersion: required,
		AcceptedVersion: accepted,
		AcceptedAt:      at,
		Outstanding:     outstanding,
		URL:             termsURL(),
	})
}

// termsGetData is exactly what the handler above scanned and computed — no JSON
// intermediate. Both representations are built from these values directly, so
// neither can drift from the other through a marshal/unmarshal round trip.
type termsGetData struct {
	RequiredVersion string
	AcceptedVersion *string
	AcceptedAt      *time.Time
	Outstanding     bool
	URL             string
}

// termsGetWrite answers GET /user/terms in whichever representation the caller
// asked for (protobuf-migration, following userBackupMetaWrite). Same route,
// method, RequireAuth and 200 — a request that does not name
// application/protobuf gets the same JSON object, byte for byte as before,
// including the fact that a user who has never accepted gets two explicit
// nulls and not two missing keys.
//
// THE TIMESTAMP IS NOT httpx.JSTime. AcceptedAt is a *time.Time handed straight
// to encoding/json below, and time.Time.MarshalJSON writes RFC3339 with trailing
// zeros trimmed — which is exactly time.RFC3339Nano, offset included. pgx can
// hand back a non-UTC location, so the offset is part of the string and must not
// be normalised away here; formatting with anything else (JSTime's
// "2006-01-02T15:04:05.000Z" in particular) would make the two representations
// disagree on a value the client caches.
//
// PRESENCE: nil stays nil. `optional` in terms.proto is what lets absence be
// told apart from an accepted version that is literally the empty string, and
// the TS decoder turns that absence back into the JSON's `null`.
func termsGetWrite(w http.ResponseWriter, r *http.Request, d termsGetData) {
	if acceptsProtobuf(w, r) {
		reply := &ccwirev1.TermsState{
			RequiredVersion: d.RequiredVersion,
			AcceptedVersion: d.AcceptedVersion,
			Outstanding:     d.Outstanding,
			Url:             d.URL,
		}
		if d.AcceptedAt != nil {
			at := d.AcceptedAt.Format(time.RFC3339Nano)
			reply.AcceptedAt = &at
		}
		// A marshal failure is not a reason to fail the request: fall through to
		// JSON, which every client understands either way.
		if b, err := proto.Marshal(reply); err == nil {
			w.Header().Set("Content-Type", protobufMediaType)
			w.WriteHeader(200)
			_, _ = w.Write(b)
			return
		}
	}

	httpx.JSON(w, 200, map[string]any{
		"requiredVersion": d.RequiredVersion,
		"acceptedVersion": d.AcceptedVersion,
		"acceptedAt":      d.AcceptedAt,
		"outstanding":     d.Outstanding,
		"url":             d.URL,
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
