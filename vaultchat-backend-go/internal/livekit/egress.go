// egress.go — start and stop LiveKit Egress (WebRTC -> HLS).
//
// This is the piece that makes a broadcast watchable. Without it a session is
// created, a room exists, and nothing ever writes a playlist — the viewer waits
// on a URL that will not appear.
//
// WHY THIS CALLS THE HTTP API DIRECTLY
// ------------------------------------
// The official Go SDK pulls in the full protobuf/Twirp stack for what is, from
// here, two RPCs with small JSON bodies. LiveKit's Twirp endpoints accept JSON
// when Content-Type says so, and the auth is the same JWT this package already
// mints. Two hand-written calls are less to keep in step than a dependency.
//
// AUTH IS A DIFFERENT GRANT
// -------------------------
// Egress is not a participant. Its token carries roomRecord — NOT roomJoin —
// so a leaked egress credential cannot be used to join a call and listen. That
// separation is the reason this does not reuse GrantFor().
//
// E2EE: egress cannot record an encrypted call. With RTCFrameCryptor active the
// payloads are ciphertext, and no encoder can read them. That is why broadcast
// is documented as NOT end-to-end encrypted (migration 079) — the recording
// capability and the encryption guarantee are mutually exclusive by
// construction, not by configuration.

package livekit

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"strings"
	"time"

	"github.com/golang-jwt/jwt/v5"
)

// ErrEgressNotConfigured means no S3 target is set, so segments would have
// nowhere to land. Distinct from ErrNotConfigured so the caller can say which
// half of the setup is missing.
var ErrEgressNotConfigured = errors.New("livekit: egress storage not configured")

// S3Target is where segments are written. Mirrors the egress service config;
// the values come from the same env the compose file feeds MinIO.
type S3Target struct {
	AccessKey string
	Secret    string
	Bucket    string
	Endpoint  string
	Region    string
}

func s3FromEnv() S3Target {
	return S3Target{
		AccessKey: firstNonEmpty(os.Getenv("S3_ACCESS_KEY"), os.Getenv("MINIO_USER")),
		Secret:    firstNonEmpty(os.Getenv("S3_SECRET_KEY"), os.Getenv("MINIO_PASS")),
		Bucket:    firstNonEmpty(os.Getenv("BROADCAST_BUCKET"), "vaultchat-broadcast"),
		Endpoint:  firstNonEmpty(os.Getenv("S3_ENDPOINT"), "http://minio:9000"),
		// "auto" matches storage.go:50, user.go and vaultbeam.go. R2 requires
		// it; MinIO ignores region entirely, so this is safe in both. Left at
		// us-east-1 the two halves would sign segment writes under different
		// SigV4 credential scopes against the same bucket.
		Region:    firstNonEmpty(os.Getenv("S3_REGION"), "auto"),
	}
}

func firstNonEmpty(v ...string) string {
	for _, s := range v {
		if strings.TrimSpace(s) != "" {
			return s
		}
	}
	return ""
}

func (t S3Target) ok() bool { return t.AccessKey != "" && t.Secret != "" && t.Bucket != "" }

// PlaybackBase is the public origin Cloudflare fronts. Segments are written to
// <bucket>/<broadcastID>/… and served from <base>/<broadcastID>/index.m3u8 —
// the bucket name is hidden by the proxy so storage layout can change without
// breaking links already given to viewers.
func PlaybackBase() string {
	return strings.TrimRight(firstNonEmpty(os.Getenv("BROADCAST_CDN_BASE"), "https://stream.corefinite.com"), "/")
}

// PlaybackURL is deterministic, so it can be stored the moment egress starts
// rather than waiting for a callback that may never arrive.
func PlaybackURL(broadcastID string) string {
	return fmt.Sprintf("%s/%s/index.m3u8", PlaybackBase(), broadcastID)
}

// egressToken mints a credential for the egress service itself.
func egressToken(cfg Config, room string) (string, error) {
	if !cfg.Configured() {
		return "", ErrNotConfigured
	}
	now := time.Now()
	// roomRecord ONLY. No roomJoin, no publish, no subscribe: this credential
	// may record the room and nothing else.
	claims := jwt.MapClaims{
		"iss": cfg.APIKey,
		"sub": "egress",
		"nbf": now.Add(-30 * time.Second).Unix(),
		"exp": now.Add(10 * time.Minute).Unix(),
		"video": map[string]any{
			"room":       room,
			"roomRecord": true,
		},
	}
	return jwt.NewWithClaims(jwt.SigningMethodHS256, claims).SignedString([]byte(cfg.APISecret))
}

// roomCreateToken mints a credential that may create a room and nothing else.
//
// Kept separate from egressToken on purpose: that one grants roomRecord ONLY,
// and widening it so a single call can create a room would hand every recording
// credential the power to create rooms for the rest of its ten-minute life.
func roomCreateToken(cfg Config, room string) (string, error) {
	if !cfg.Configured() {
		return "", ErrNotConfigured
	}
	now := time.Now()
	claims := jwt.MapClaims{
		"iss": cfg.APIKey,
		"sub": "egress-roomcreate",
		"nbf": now.Add(-30 * time.Second).Unix(),
		"exp": now.Add(1 * time.Minute).Unix(),
		"video": map[string]any{
			"room":       room,
			"roomCreate": true,
		},
	}
	return jwt.NewWithClaims(jwt.SigningMethodHS256, claims).SignedString([]byte(cfg.APISecret))
}

// ensureRoom creates the room if it does not already exist.
//
// LiveKit creates rooms LAZILY, on first participant join. Egress was started
// from POST /broadcasts — before the host connects — so the composite had
// nothing to attach to and every broadcast died on:
//
//	StartRoomCompositeEgress: 404 "requested room does not exist"
//
// Six consecutive broadcasts failed this way on 2026-08-10, with egress_id NULL
// on every row, so hls_url never populated and status never left 'starting'.
//
// CreateRoom is idempotent — an existing room is returned, not an error — so
// this is safe when the host happens to have connected first.
func ensureRoom(ctx context.Context, cfg Config, room string) error {
	tok, err := roomCreateToken(cfg, room)
	if err != nil {
		return err
	}
	// empty_timeout must outlast the gap between this call and the host
	// joining; the server's own room.empty_timeout is 60s and this matches it.
	return twirp(ctx, cfg, "livekit.RoomService", "CreateRoom", tok,
		map[string]any{"name": room, "empty_timeout": 60}, nil)
}

// twirp calls one LiveKit RPC. `service` is the twirp service segment
// ("livekit.Egress", "livekit.RoomService") — parameterised because creating a
// room is a RoomService call while everything else here is Egress.
func twirp(ctx context.Context, cfg Config, service, method string, tok string, body any, out any) error {
	base := strings.TrimRight(cfg.URL, "/")
	// The token is minted for ws://; the REST API is the same host over http(s).
	base = strings.Replace(strings.Replace(base, "wss://", "https://", 1), "ws://", "http://", 1)

	raw, err := json.Marshal(body)
	if err != nil {
		return err
	}

	req, err := http.NewRequestWithContext(ctx, "POST",
		base+"/twirp/"+service+"/"+method, bytes.NewReader(raw))
	if err != nil {
		return err
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Authorization", "Bearer "+tok)

	res, err := (&http.Client{Timeout: 15 * time.Second}).Do(req)
	if err != nil {
		return err
	}
	defer res.Body.Close()
	payload, _ := io.ReadAll(io.LimitReader(res.Body, 1<<20))
	if res.StatusCode != 200 {
		// Carry the body: LiveKit explains refusals ("no response from egress")
		// in a way a bare status code does not.
		return fmt.Errorf("livekit egress %s: %d %s", method, res.StatusCode, strings.TrimSpace(string(payload)))
	}
	if out != nil {
		return json.Unmarshal(payload, out)
	}
	return nil
}

// StartHLS begins a room-composite egress writing HLS into object storage.
// Returns the egress id, which is needed to stop it.
func StartHLS(ctx context.Context, cfg Config, room, broadcastID string) (string, error) {
	s3 := s3FromEnv()
	if !s3.ok() {
		return "", ErrEgressNotConfigured
	}

	// The room must exist before anything can composite it — see ensureRoom.
	if err := ensureRoom(ctx, cfg, room); err != nil {
		return "", fmt.Errorf("ensure room %q: %w", room, err)
	}

	body := map[string]any{
		"room_name": room,
		// "speaker" follows whoever is talking. For a single-publisher stream it
		// behaves as a full-frame layout, and it degrades sensibly if a second
		// speaker is ever promoted, which "grid" would not.
		"layout": "speaker",
		"segment_outputs": []map[string]any{{
			"filename_prefix": broadcastID + "/segment",
			"playlist_name":   broadcastID + "/index.m3u8",
			// 4s balances latency against request volume: shorter means more
			// requests through the CDN for the same minute of video, and HLS
			// players buffer ~3 segments before starting either way.
			"segment_duration": 4,
			"s3": map[string]any{
				"access_key":       s3.AccessKey,
				"secret":           s3.Secret,
				"bucket":           s3.Bucket,
				"endpoint":         s3.Endpoint,
				"region":           s3.Region,
				"force_path_style": true,
			},
		}},
	}

	// Simulcast to YouTube / Twitch / anywhere that speaks RTMP.
	//
	// The same egress that writes HLS also pushes RTMP, so this costs one extra
	// output on a transcode that is already running rather than a second
	// encoder. Adding it as a separate egress would double the CPU for the same
	// stream, which on a box that also runs Postgres is the difference between
	// a broadcast and an incident.
	//
	// The stream key is a SECRET and lives in env, never in the database and
	// never in a response: anyone holding it can broadcast to that channel.
	if urls := rtmpTargets(); len(urls) > 0 {
		body["stream_outputs"] = []map[string]any{{
			"protocol": "rtmp",
			"urls":     urls,
		}}
	}

	var res struct {
		EgressID string `json:"egress_id"`
	}
	tok, err := egressToken(cfg, room)
	if err != nil {
		return "", err
	}
	if err := twirp(ctx, cfg, "livekit.Egress", "StartRoomCompositeEgress", tok, body, &res); err != nil {
		return "", err
	}
	return res.EgressID, nil
}

// rtmpTargets reads restream destinations from env.
//
// BROADCAST_RTMP_URLS is comma-separated and already includes the stream key,
// e.g. rtmp://a.rtmp.youtube.com/live2/xxxx-xxxx-xxxx. Empty means no
// restreaming, which is the default: pushing a user's stream to a third party
// must be something the operator switched on deliberately.
func rtmpTargets() []string {
	raw := strings.TrimSpace(os.Getenv("BROADCAST_RTMP_URLS"))
	if raw == "" {
		return nil
	}
	var out []string
	for _, u := range strings.Split(raw, ",") {
		if u = strings.TrimSpace(u); strings.HasPrefix(u, "rtmp://") || strings.HasPrefix(u, "rtmps://") {
			out = append(out, u)
		}
	}
	return out
}

// StopHLS ends a running egress. Best-effort by design: the caller is ending a
// broadcast, and a failure here must not prevent that. An orphaned egress stops
// on its own when the room empties.
func StopHLS(ctx context.Context, cfg Config, egressID string) error {
	if strings.TrimSpace(egressID) == "" {
		return nil
	}
	tok, err := egressToken(cfg, "")
	if err != nil {
		return err
	}
	return twirp(ctx, cfg, "livekit.Egress", "StopEgress", tok,
		map[string]any{"egress_id": egressID}, nil)
}
