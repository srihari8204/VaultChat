package realtime

import (
	"os"
	"testing"
)

// The autoscaler reads sockets_local, not sockets_online, and this is the test
// that keeps them from being confused again.
//
// OnlineCount() is fleet-wide under REDIS_ADAPTER=1 — it returns a Redis SCARD
// over vc:pres:online, so every replica reports the same number. Averaged
// across pods by a Pods-type HPA metric, the average of N identical fleet
// totals is the fleet total, and the HPA jumps straight to maxReplicas. The
// trap is that it looks correct in a one-pod test, where "local" and "fleet"
// are the same value, so the assertion below is deliberately about the SHAPE of
// the count rather than a number: sockets are counted, not users.
func TestLocalSocketsCountsConnectionsNotUsers(t *testing.T) {
	h := &Hub{userSockets: map[string]map[string]struct{}{
		"u1": {"s1": {}, "s2": {}, "s3": {}}, // one user, three devices
		"u2": {"s4": {}},
	}}

	if got, want := h.LocalUsers(), 2; got != want {
		t.Errorf("LocalUsers() = %d, want %d", got, want)
	}
	// The cost of a pod is open connections. A user with three devices is three
	// file descriptors, three read loops and three write buffers — so scaling on
	// LocalUsers would under-provision by exactly the multi-device ratio.
	if got, want := h.LocalSockets(), 4; got != want {
		t.Errorf("LocalSockets() = %d, want %d", got, want)
	}
}

func TestLocalCountsAreSafeOnAZeroValueHub(t *testing.T) {
	// Gauges are registered in New() and sampled at scrape time, so a scrape
	// that races construction must not panic on a nil map.
	h := &Hub{}
	if got := h.LocalSockets(); got != 0 {
		t.Errorf("LocalSockets() on empty hub = %d, want 0", got)
	}
	if got := h.LocalUsers(); got != 0 {
		t.Errorf("LocalUsers() on empty hub = %d, want 0", got)
	}
}

// OnlineCount falls back to the local map when the cluster is off, which is the
// only mode in which it and LocalUsers agree. Pinning this documents why a
// single-replica staging test cannot catch the HPA bug above.
func TestOnlineCountIsLocalOnlyWhenClusterIsDisabled(t *testing.T) {
	t.Setenv("REDIS_ADAPTER", "0")
	if os.Getenv("REDIS_ADAPTER") != "0" {
		t.Fatal("env not applied")
	}
	h := &Hub{userSockets: map[string]map[string]struct{}{"u1": {"s1": {}}}}
	if got, want := h.OnlineCount(), 1; got != want {
		t.Errorf("OnlineCount() with cluster off = %d, want %d", got, want)
	}
}
