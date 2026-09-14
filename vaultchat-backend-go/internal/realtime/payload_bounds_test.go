package realtime

import (
	"os"
	"strings"
	"testing"
	"time"
)

// The realtime layer accepts attacker-controlled data and, for ~15 events,
// forwards it VERBATIM into another user's event handlers. Before this, the
// only bound anywhere was the 2 MB socket frame — so "2 MB of arbitrary JSON,
// injected into any account's handlers" was the actual limit.
//
// These tests run without a database or a socket, matching this package's
// existing style (see join_authz_test.go): the bounds gate is pure, and the
// authorisation gates are exercised through their cached path, which returns
// before touching the DB.

// ── the bounds gate drops rather than relays ─────────────────────────

func TestArgMapAcceptsRealPayloads(t *testing.T) {
	ok := []map[string]any{
		{"chatId": "c1", "uid": "u1"},
		{"to": "u2", "chatId": "c1", "sdp": strings.Repeat("a=candidate\r\n", 500)},
		{"chatId": "c1", "blob": strings.Repeat("x", 4096), "until": float64(1700000000)},
		{"chatId": "c1", "messageId": float64(12), "reactions": map[string]any{
			"thumbsup": []any{"u1", "u2"},
		}},
		{"chatId": "c1", "tripId": "t1", "plain": map[string]any{
			"remainingM": float64(1200), "etaS": float64(90), "arrived": false,
		}},
	}
	for i, m := range ok {
		if argMap("t", []any{m}) == nil {
			t.Fatalf("case %d: a legitimate payload was dropped — this breaks a deployed client", i)
		}
	}
}

func TestArgMapDropsOversizedAndMalformed(t *testing.T) {
	deep := any("leaf")
	for i := 0; i < maxDepth+2; i++ {
		deep = map[string]any{"n": deep}
	}
	wide := map[string]any{}
	for i := 0; i < maxEventFields+1; i++ {
		wide[string(rune('a'+i%26))+strings.Repeat("x", i)] = 1.0
	}
	longArr := make([]any, maxArrayLen+1)
	for i := range longArr {
		longArr[i] = "x"
	}
	// Many medium strings: under every individual limit, over the total budget.
	fat := map[string]any{}
	for i := 0; i < 8; i++ {
		fat[string(rune('a'+i))] = strings.Repeat("x", 64<<10)
	}

	// NOTE: the element type must be written out. Go only lets a composite
	// literal elide its type when the map's value type is itself a concrete
	// composite type; here the value type is `any`, so a bare {...} does not
	// compile ("invalid composite literal element type any").
	bad := map[string]map[string]any{
		"one huge string":  {"blob": strings.Repeat("x", maxStringLen+1)},
		"too many fields":  wide,
		"too deep":         deep.(map[string]any),
		"array too long":   {"reactions": longArr},
		"over the budget":  fat,
		"absurd key":       {strings.Repeat("k", maxKeyLen+1): "v"},
		"unrelayable type": {"blob": make(chan int)},
	}
	for name, m := range bad {
		if argMap("t", []any{m}) != nil {
			t.Fatalf("%s: was accepted and would have been relayed verbatim", name)
		}
	}

	// Non-object and absent payloads are drops too, not panics.
	if argMap("t", nil) != nil || argMap("t", []any{"not an object"}) != nil {
		t.Fatal("a non-object payload must drop")
	}
}

// A drop must be a DROP: nil, which every handler already treats as "return".
// If mstr ever panicked on a nil map, dropping would become a crash.
func TestADroppedPayloadIsInertNotFatal(t *testing.T) {
	m := argMap("t", []any{map[string]any{"blob": strings.Repeat("x", maxStringLen+1)}})
	if m != nil || mstr(m, "chatId") != "" {
		t.Fatal("a dropped payload must read as empty, so handlers return instead of relaying")
	}
}

// ── identity comes from the session, never the payload ────────────────

// typing_start fanned out a CLIENT-SUPPLIED uid to every member of the chat, so
// any account could make any other account appear to be typing. Worse than
// cosmetic: delivery.go's senderOfEvent reads the same field to pick whose
// hide_typing ghost-mode applies, so the spoof also chose the victim's privacy
// settings.
//
// Asserted against the source because the fan-out itself needs a database. What
// must never come back is the payload ever being the identity input.
func TestTypingUsesTheAuthenticatedUid(t *testing.T) {
	// Strip line comments first. The fix left a comment quoting the old code
	// verbatim to explain what must never come back, and a raw substring search
	// matches that prose and fails on a file that is correct — the assertion has
	// to look at what compiles, not at what is written about it.
	src := stripLineComments(mustRead(t, "handlers.go"))
	if strings.Contains(src, `m["uid"]`) {
		t.Fatal(`a handler reads the client-supplied "uid" again — typing identity is spoofable`)
	}
	if !strings.Contains(src, `"uid": d.uid`) {
		t.Fatal("typing no longer stamps the socket's authenticated uid")
	}
}

// Every other place the server could have believed a client-declared identity.
// `from`/`fromUid` on the peer relays were already stamped from the socket;
// this pins that, and that nothing re-reads them from the payload.
func TestRelaysStampTheSenderFromTheSocket(t *testing.T) {
	src := mustRead(t, "handlers.go")
	for _, want := range []string{`out["from"] = d.uid`, `out["fromUid"] = d.uid`} {
		if !strings.Contains(src, want) {
			t.Fatalf("a relay stopped stamping the authenticated sender (%s)", want)
		}
	}
	if strings.Contains(src, `mstr(m, "from")`) {
		t.Fatal(`a relay is reading "from" out of the client payload again`)
	}
}

// ── a sender must be entitled to reach the recipient ──────────────────

// The cached path returns before any DB call, which is what lets this run here.
func cached(uid string, peers map[string]bool) *sockData {
	d := &sockData{uid: uid, peerOk: map[string]cachedPerm{}}
	for p, ok := range peers {
		d.peerOk[p] = cachedPerm{ok: ok, gen: 0, at: time.Now()}
	}
	return d
}

// `to` was ANY uid on the platform: a stranger could push a call offer, a
// rekey, a VaultBeam invite or an in-call chat envelope into any account's
// handlers with nothing but a uid.
func TestRelayRefusesAPeerWithNoSharedChat(t *testing.T) {
	h := &Hub{}
	d := cached("u1", map[string]bool{"stranger": false, "friend": true})

	if h.peerAllowed(d, "stranger") {
		t.Fatal("a relay to an account sharing no chat must be refused")
	}
	if !h.peerAllowed(d, "friend") {
		t.Fatal("a relay to a real peer must go through, or calls stop working")
	}
	if !h.peerAllowed(d, "u1") {
		t.Fatal("a user's own other devices must stay addressable")
	}
	if h.peerAllowed(d, "") || h.peerAllowed(nil, "friend") {
		t.Fatal("an empty recipient must be refused")
	}
}

// The entitlement must expire — chat generations are keyed by chat id and this
// decision is keyed by peer, so nothing can bump it; permTTL is the only bound.
func TestPeerEntitlementExpires(t *testing.T) {
	h := &Hub{}
	d := &sockData{uid: "u1", peerOk: map[string]cachedPerm{
		"friend": {ok: true, gen: 0, at: time.Now().Add(-permTTL - time.Second)},
	}}
	if d.peerOk["friend"].fresh(0) {
		t.Fatalf("a peer decision older than permTTL (%s) is still trusted", permTTL)
	}
	_ = h
}

// The chat-scoped publishers must all be behind the membership check. Both
// message_delivered and reaction_updated used `s.To(room)`, which broadcasts
// whether or not the socket is IN the room — so join_chat's check never
// covered them, and any account could publish into any chat it could name.
func TestChatPublishersAreGatedOnMembership(t *testing.T) {
	src := mustRead(t, "handlers.go")
	for _, event := range []string{"new_message", "reaction_updated", "typing_start"} {
		if !strings.Contains(src, event) {
			t.Fatalf("%s handler vanished", event)
		}
	}
	// One gate, every publisher: count the call sites rather than the events, so
	// adding a publisher without a gate shows up as a shortfall.
	if n := strings.Count(src, "h.chatMemberAllowed(d,"); n < 8 {
		t.Fatalf("only %d chat-membership gates left in handlers.go; a publisher lost its check", n)
	}
	if !strings.Contains(src, "h.peerAllowed(d, to)") {
		t.Fatal("the per-peer relays no longer authorise their recipient")
	}
}

func mustRead(t *testing.T, name string) string {
	t.Helper()
	b, err := os.ReadFile(name)
	if err != nil {
		t.Fatal(err)
	}
	return string(b)
}

// stripLineComments removes `//` comments so a source assertion tests the code
// rather than the prose describing it. Deliberately naive — it does not know
// about strings containing "//" — which is safe here because it is only ever
// used to make a substring search stricter, never to accept something.
func stripLineComments(src string) string {
	var b strings.Builder
	for _, line := range strings.Split(src, "\n") {
		if i := strings.Index(line, "//"); i >= 0 {
			line = line[:i]
		}
		b.WriteString(line)
		b.WriteByte('\n')
	}
	return b.String()
}
