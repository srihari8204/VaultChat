// ping.go — is the Go Live LiveKit reachable, right now?
//
// Deliberately a plain GET on the server root rather than a Twirp RPC. LiveKit
// answers "OK" there unauthenticated, so this reports REACHABILITY without
// needing a credential — which is the property a health check wants: a failure
// here means the network or the process, never "the key expired".
//
// It never touches the calling cluster. That is the whole point of the endpoint
// this feeds (/golive/health): a Go Live outage must not be able to report the
// calling LiveKit as unhealthy, and vice versa.
package golive

import (
	"context"
	"errors"
	"net/http"
	"time"
)

// pingTimeout is short on purpose: a health endpoint that blocks for fifteen
// seconds is itself an outage when a monitor polls it every ten.
const pingTimeout = 3 * time.Second

// HTTPBase is the Go Live LiveKit's REST origin AS THIS SERVER ADDRESSES IT —
// exactly what livekit.twirp will use, which is the only address whose
// reachability this process can act on.
//
// It must track RPCBase() and not URL. Once the two were allowed to differ
// (livekit.Config.RPCURL), a probe of the client's public URL stopped saying
// anything about whether egress could start: /golive/health could report a
// healthy Go Live while every StartRoomCompositeEgress was failing on the
// internal path, or — worse for an operator at 3am — go red over an edge
// problem that broadcasting no longer depends on.
//
// Still a plain GET on the server root rather than a Twirp RPC, for the reason
// at the top of this file: reachability without needing a credential.
func (c Config) HTTPBase() string { return c.RPCBase() }

// Ping reports whether the Go Live media server answers.
func (c Config) Ping(ctx context.Context) error {
	if !c.Configured() {
		return errors.New("golive: livekit is not configured")
	}
	base := c.HTTPBase()
	if base == "" {
		return errors.New("golive: GOLIVE_LIVEKIT_URL is not set")
	}
	ctx, cancel := context.WithTimeout(ctx, pingTimeout)
	defer cancel()

	req, err := http.NewRequestWithContext(ctx, http.MethodGet, base+"/", nil)
	if err != nil {
		return err
	}
	res, err := http.DefaultClient.Do(req)
	if err != nil {
		return err
	}
	defer res.Body.Close()
	// Any answer at all proves the process is up and listening. LiveKit returns
	// 200 on / — but a 404 from a proxy in front of it still means "something is
	// there", and treating that as down would make the check report the proxy's
	// routing table rather than the media server's health. 5xx is the real
	// failure signal.
	if res.StatusCode >= 500 {
		return errors.New("golive: livekit answered " + res.Status)
	}
	return nil
}
