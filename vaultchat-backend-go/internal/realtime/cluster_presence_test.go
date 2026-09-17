package realtime

import (
	"context"
	"crypto/rand"
	"fmt"
	"os"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/redis/go-redis/v9"

	"vaultchat/backend-go/internal/redisx"
)

// testRedis returns a live client or skips. The presence race is a race
// BETWEEN REDIS ROUND TRIPS — there is no honest way to exercise it without a
// Redis, and a fake that applies each script atomically would be asserting its
// own implementation rather than the code under test. So: with a Redis
// (VC_TEST_REDIS, default 127.0.0.1:6379) these tests really run the Lua; with
// none they skip, and only the static assertion at the bottom still guards the
// mechanism.
// scopeKeys points the package's key builders — and the Lua, via ARGV[3] — at an
// exclusive prefix for the duration of one test, then restores the production
// default. `vc:pres:online` is a GLOBAL set: synthetic user ids do not isolate
// it, so without this a run against any shared instance would insert test
// members into live presence.
//
// The run id is random so two concurrent runs, or a re-run after a crash that
// skipped cleanup, cannot collide or adopt each other's keys.
func scopeKeys(t *testing.T) string {
	t.Helper()
	var b [8]byte
	if _, err := rand.Read(b[:]); err != nil {
		t.Fatalf("cannot generate a run id: %v", err)
	}
	prev := keyPrefix
	scoped := fmt.Sprintf("cc-test:%x:presence:", b)
	keyPrefix = scoped
	t.Cleanup(func() { keyPrefix = prev })
	return scoped
}

func testRedis(t *testing.T) *redis.Client {
	t.Helper()
	// NO DEFAULT ENDPOINT, deliberately.
	//
	// This previously fell back to 127.0.0.1:6379. That is the same port a
	// developer's own Redis listens on, and the same port an SSH tunnel to
	// production is conventionally opened on — `internal/routes`'s DB tests
	// carry the identical warning about 15432. A suite that WRITES must never
	// pick its target by default.
	addr := os.Getenv("VC_TEST_REDIS")
	if addr == "" {
		t.Skip("set VC_TEST_REDIS=host:port to run the presence race tests (no default: this suite writes)")
	}
	c := redis.NewClient(&redis.Options{Addr: addr})
	ctx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	if err := c.Ping(ctx).Err(); err != nil {
		c.Close()
		t.Skipf("no Redis at %s (%v) — set VC_TEST_REDIS to run the presence race tests", addr, err)
	}
	prev := redisx.Client
	redisx.Client = c
	t.Cleanup(func() { redisx.Client = prev; c.Close() })
	return c
}

// arm gives two node identities a heartbeat and returns a fresh uid.
func arm(t *testing.T, c *redis.Client, nodes ...string) string {
	t.Helper()
	uid := "test-uid-" + t.Name()
	keys := []string{keyPrefix + "pres:" + uid, keyPrefix + "pres:online"}
	for _, n := range nodes {
		c.Set(bg, keyPrefix+"node:hb:"+n, "1", time.Minute)
		keys = append(keys, keyPrefix+"roster:"+n)
	}
	c.Del(bg, keyPrefix+"pres:"+uid)
	c.SRem(bg, keyPrefix+"pres:online", uid)
	t.Cleanup(func() {
		c.Del(bg, keys...)
		for _, n := range nodes {
			c.Del(bg, keyPrefix+"node:hb:"+n)
		}
	})
	return uid
}

func online(t *testing.T, c *redis.Client, uid string) bool {
	t.Helper()
	in, err := c.SIsMember(bg, keyPrefix+"pres:online", uid).Result()
	if err != nil {
		t.Fatal(err)
	}
	return in
}

// EXECUTED (with Redis): the single-replica path must be untouched — first
// socket flips online, last socket flips offline.
func TestPresenceSingleNodeTransitions(t *testing.T) {
	c := testRedis(t)
	scopeKeys(t)
	uid := arm(t, c, "nodeA")

	if !clusterClaim(uid, "nodeA") {
		t.Fatal("first socket did not report the online transition")
	}
	if !online(t, c, uid) {
		t.Fatal("user not in vc:pres:online after the first socket")
	}
	if !clusterWithdraw(uid, "nodeA") {
		t.Fatal("last socket did not report the offline transition")
	}
	if online(t, c, uid) {
		t.Fatal("user still in vc:pres:online after the last socket")
	}
}

// EXECUTED (with Redis): a second replica's claim does not re-fire "online",
// and the first replica's withdrawal does not fire "offline" while the second
// still holds a live socket.
func TestPresenceSecondNodeDoesNotDoubleFire(t *testing.T) {
	c := testRedis(t)
	scopeKeys(t)
	uid := arm(t, c, "nodeA", "nodeB")

	if !clusterClaim(uid, "nodeA") {
		t.Fatal("nodeA should own the online transition")
	}
	if clusterClaim(uid, "nodeB") {
		t.Fatal("nodeB re-fired an online transition for an already-online user")
	}
	if clusterWithdraw(uid, "nodeA") {
		t.Fatal("nodeA fired offline while nodeB still holds a live socket")
	}
	if !online(t, c, uid) {
		t.Fatal("user dropped out of vc:pres:online while still connected on nodeB")
	}
}

// EXECUTED (with Redis): THE BUG. nodeB takes uid's first local socket at the
// same moment nodeA loses uid's last one. With the old HGETALL→decide→HSET
// sequence, B could read "A is live" (so skip the online SADD and report no
// transition) while A ran its whole withdrawal inside that gap — leaving the
// user connected on B but offline in Postgres and to every contact, with
// nothing to heal it (the janitor only sweeps DEAD nodes).
//
// Atomic scripts make the two operations serialize in one order or the other,
// and both orders are consistent: the user ends up online, and an offline
// transition is only ever reported when an online one follows it.
func TestPresenceConcurrentHandoffLeavesUserOnline(t *testing.T) {
	c := testRedis(t)
	scopeKeys(t)
	for i := 0; i < 200; i++ {
		uid := arm(t, c, "nodeA", "nodeB")
		clusterClaim(uid, "nodeA")

		var wg sync.WaitGroup
		var firedOffline, firedOnline bool
		wg.Add(2)
		start := make(chan struct{})
		go func() { defer wg.Done(); <-start; firedOffline = clusterWithdraw(uid, "nodeA") }()
		go func() { defer wg.Done(); <-start; firedOnline = clusterClaim(uid, "nodeB") }()
		close(start)
		wg.Wait()

		if !online(t, c, uid) {
			t.Fatalf("iteration %d: user connected on nodeB but missing from vc:pres:online", i)
		}
		n, err := c.HLen(bg, keyPrefix+"pres:"+uid).Result()
		if err != nil || n != 1 {
			t.Fatalf("iteration %d: vc:pres hash has %d claims (err %v), want just nodeB's", i, n, err)
		}
		// If A announced "offline" it must have run first, so B's claim must
		// have announced the matching "online" — otherwise contacts were told
		// the user left and never told they came back.
		if firedOffline && !firedOnline {
			t.Fatalf("iteration %d: offline announced with no compensating online — user is stuck offline", i)
		}
	}
}

// EXECUTED (with Redis): a dead node's claim never keeps a user online, and the
// janitor path shares the same atomic withdrawal.
func TestPresenceIgnoresDeadNodeClaims(t *testing.T) {
	c := testRedis(t)
	scopeKeys(t)
	uid := arm(t, c, "nodeA")
	c.HSet(bg, keyPrefix+"pres:"+uid, "ghostNode", "1") // no heartbeat key

	if !clusterClaim(uid, "nodeA") {
		t.Fatal("a dead node's stale claim suppressed the online transition")
	}
	if n, _ := c.HLen(bg, keyPrefix+"pres:"+uid).Result(); n != 1 {
		t.Fatalf("dead node's field was not swept (hash len %d)", n)
	}
	if !clusterWithdraw(uid, "nodeA") {
		t.Fatal("offline transition suppressed by an already-swept dead node")
	}
}

// SUPPLEMENT (static, always runs): the tests above skip without a Redis, so
// this pins the mechanism — the fix IS the atomicity, and a re-introduced
// read-decide-write would pass every behavioural test that runs one operation
// at a time.
func TestPresenceTransitionsAreAtomic(t *testing.T) {
	src, err := os.ReadFile("cluster.go")
	if err != nil {
		t.Fatal(err)
	}
	stripped := stripLineComments(string(src))
	from, to := strings.Index(stripped, "func clusterClaim"), strings.Index(stripped, "func clusterHasLive")
	if from < 0 || to <= from {
		t.Fatal("could not locate the presence transition functions")
	}
	fns := stripped[from:to]
	for _, bad := range []string{"HGetAll", "HSet(", "SAdd(", "SRem(", "HDel("} {
		if strings.Contains(fns, bad) {
			t.Fatalf("presence transition does %s outside the script — the read-decide-write race is back", bad)
		}
	}
	for _, want := range []string{"trackFirstScript.Run(", "untrackLastScript.Run("} {
		if !strings.Contains(fns, want) {
			t.Fatalf("presence transition no longer goes through %s", want)
		}
	}
	// The janitor made the same decision the same racy way.
	jan := stripped[strings.Index(stripped, "func (h *Hub) janitor"):]
	if strings.Contains(jan, "clusterHasLive(") || strings.Contains(jan, "SRem(bg, \"vc:pres:online\"") {
		t.Fatal("janitor decides offline outside the atomic script again")
	}
}
