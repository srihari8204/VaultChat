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
	"strings"

	ccwirev1 "vaultchat/backend-go/internal/ccwire/gen/ccwire/v1"
	"vaultchat/backend-go/internal/httpx"

	"google.golang.org/protobuf/proto"
)

const defaultUpdateURL = "https://play.google.com/store/apps/details?id=com.vaultchat.app"

// The one media type this server answers in binary, and only where a client
// asks for it by name. No wildcard: an Accept of `*/*` is not a request for
// protobuf.
const protobufMediaType = "application/protobuf"

// acceptsProtobuf reports whether the caller asked for protobuf BY NAME, and
// records that this URL answers differently depending on Accept.
//
// NOT strings.Contains, which is what every negotiated handler used to do at
// six separate sites. A substring test says yes to three things that are not a
// request for protobuf:
//
//   - "application/protobuf;q=0" — an explicit REFUSAL. RFC 9110 §12.5.1: "a
//     qvalue of 0 means 'not acceptable'". Answering it with the very bytes the
//     client said it could not take is the worst of the three, because the
//     client has no reason to check: lib/appVersion.ts calls res.json() and a
//     protobuf body throws at cold start, in front of the blocking screen.
//   - "application/protobuf-text", "application/protobuffer", and anything else
//     that merely BEGINS with those characters. They are different media types.
//   - the same characters appearing inside a parameter value of some other
//     media range.
//
// Written once, here, because six copies of a negotiation rule is six places to
// fix it and five places to forget.
//
// VARY. Set on every call, refusals included: one URL, two bodies, chosen by a
// request header. /app/version and /app/flags are unauthenticated GETs served
// through Caddy, so a shared cache that does not know Accept is significant can
// store the protobuf body and hand it to the next JSON client — the same
// cold-start failure as above, but for someone who did everything right. The
// header costs 13 bytes and is the only thing that makes the negotiation safe
// to cache at all.
func acceptsProtobuf(w http.ResponseWriter, r *http.Request) bool {
	w.Header().Set("Vary", "Accept")
	for _, part := range strings.Split(r.Header.Get("Accept"), ",") {
		media, params, _ := strings.Cut(part, ";")
		if !strings.EqualFold(strings.TrimSpace(media), protobufMediaType) {
			continue
		}
		if acceptRefused(params) {
			continue // named it only to say no; keep looking for another offer
		}
		return true
	}
	return false
}

// acceptRefused reports whether a media range's parameters carry q=0.
// Anything unparseable is NOT a refusal: a malformed qvalue is a broken client,
// and the safe reading of a broken client is the one it would have got before
// it sent the parameter at all.
func acceptRefused(params string) bool {
	for _, p := range strings.Split(params, ";") {
		k, v, ok := strings.Cut(p, "=")
		if !ok || !strings.EqualFold(strings.TrimSpace(k), "q") {
			continue
		}
		f, err := strconv.ParseFloat(strings.TrimSpace(v), 64)
		return err == nil && f <= 0
	}
	return false
}

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

	// Shown on the blocking screen. Kept server-side so the reason can be
	// specific to whatever forced the floor up, rather than a generic
	// string frozen into a client that is by definition out of date.
	message := os.Getenv("VAULTCHAT_UPDATE_MESSAGE")

	// CONTENT NEGOTIATION, OPT-IN ONLY (protobuf-migration task 3.1). Same
	// route, same method, same (absent) authorization, same status code. A
	// request that does not name application/protobuf — every client shipped
	// so far, every browser, every `*/*` — takes the branch below and gets
	// bytes identical to what this handler has always written.
	if acceptsProtobuf(w, r) {
		b, err := proto.Marshal(&ccwirev1.AppVersionGate{
			MinBuild:    minBuild,
			AdviseBuild: advise,
			UpdateUrl:   url,
			Message:     message,
		})
		// A marshal failure here is not a reason to lock anyone out: fall
		// through to JSON, which the client understands either way.
		if err == nil {
			w.Header().Set("Content-Type", protobufMediaType)
			w.WriteHeader(200)
			_, _ = w.Write(b)
			return
		}
	}

	httpx.JSON(w, 200, map[string]any{
		"minBuild":    minBuild,
		"adviseBuild": advise,
		"updateUrl":   url,
		"message":     message,
	})
}
