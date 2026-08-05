// vaultbeam_mask_test.go — the pure logic behind seamless resume.
//
// These need no database, so they run everywhere. The DB-backed route behaviour
// (409 on a stale version, 410 after completion, completion idempotence) lives
// in vaultbeam_routes_test.go behind CALL_TEST_DB=1, like the other route tests.
//
// What is asserted here is the part that must never be wrong: the recv_mask
// merge. It is the mechanism that lets a sender skip chunks the peer already
// holds, so a merge that could LOSE a bit would silently re-upload, and a merge
// that could INVENT a bit would silently skip data the receiver never got —
// corruption. Union-only makes both impossible regardless of ordering.
package routes

import (
	"testing"
)

func maskOf(chunkCount int, bits ...int) []byte {
	m := make([]byte, vbMaskWidth(chunkCount))
	for _, b := range bits {
		if b >= 0 && b < chunkCount {
			m[b>>3] |= 1 << uint(b&7)
		}
	}
	return m
}

func setBits(m []byte, chunkCount int) []int {
	var out []int
	for i := 0; i < chunkCount; i++ {
		if vbTestBit(m, i) {
			out = append(out, i)
		}
	}
	return out
}

func eqBits(t *testing.T, got []byte, chunkCount int, want ...int) {
	t.Helper()
	g := setBits(got, chunkCount)
	if len(g) != len(want) {
		t.Fatalf("bits = %v, want %v", g, want)
	}
	for i := range want {
		if g[i] != want[i] {
			t.Fatalf("bits = %v, want %v", g, want)
		}
	}
}

func TestUnionMaskIsMonotone(t *testing.T) {
	const n = 20

	// merging into an empty mask keeps everything
	eqBits(t, vbUnionMask(nil, maskOf(n, 1, 5, 19), n), n, 1, 5, 19)

	// union adds without removing
	got := vbUnionMask(maskOf(n, 1, 2), maskOf(n, 2, 7), n)
	eqBits(t, got, n, 1, 2, 7)

	// idempotent
	eqBits(t, vbUnionMask(got, maskOf(n, 2, 7), n), n, 1, 2, 7)

	// A STALE post — the receiver's older, smaller bitmap — must not clear a
	// bit. This is the ordering guarantee the whole sync protocol rests on.
	eqBits(t, vbUnionMask(got, maskOf(n, 1), n), n, 1, 2, 7)

	// an empty post changes nothing
	eqBits(t, vbUnionMask(got, nil, n), n, 1, 2, 7)
}

func TestUnionMaskOrderIndependent(t *testing.T) {
	const n = 40
	a, b, c := maskOf(n, 0, 3, 9), maskOf(n, 3, 4), maskOf(n, 39)

	forward := vbUnionMask(vbUnionMask(a, b, n), c, n)
	backward := vbUnionMask(vbUnionMask(c, b, n), a, n)
	if string(forward) != string(backward) {
		t.Fatalf("merge is order-dependent: %v vs %v", setBits(forward, n), setBits(backward, n))
	}
	eqBits(t, forward, n, 0, 3, 4, 9, 39)
}

func TestUnionMaskWidthAndTailMasking(t *testing.T) {
	// chunkCount not a multiple of 8: bits past the end must be dropped, or the
	// popcount used by the completion guard would overcount and let an
	// incomplete transfer claim completion.
	const n = 12 // 2 bytes, 4 spare bits
	wide := []byte{0xFF, 0xFF}
	got := vbUnionMask(nil, wide, n)
	if len(got) != 2 {
		t.Fatalf("width = %d, want 2", len(got))
	}
	if c := vbCountSet(got, n); c != 12 {
		t.Fatalf("popcount = %d, want 12 (spare bits must be masked off)", c)
	}
	if got[1]&0xF0 != 0 {
		t.Fatalf("spare high bits survived: %08b", got[1])
	}

	// a narrower stored mask is widened, not truncated
	narrow := vbUnionMask([]byte{0x01}, maskOf(n, 11), n)
	eqBits(t, narrow, n, 0, 11)

	// an over-wide incoming mask cannot overflow the output
	over := vbUnionMask(nil, []byte{0xFF, 0xFF, 0xFF, 0xFF}, n)
	if len(over) != 2 || vbCountSet(over, n) != 12 {
		t.Fatalf("over-wide input mishandled: len=%d pop=%d", len(over), vbCountSet(over, n))
	}
}

func TestUnionMaskCompletionGuard(t *testing.T) {
	// The completion guard is popcount(merged) == chunkCount. Verify it only
	// fires when the mask genuinely covers every chunk.
	const n = 10
	partial := maskOf(n, 0, 1, 2, 3, 4, 5, 6, 7, 8)
	if vbCountSet(vbUnionMask(nil, partial, n), n) == n {
		t.Fatal("a 9/10 mask must not satisfy the completion guard")
	}
	full := maskOf(n, 0, 1, 2, 3, 4, 5, 6, 7, 8, 9)
	if vbCountSet(vbUnionMask(nil, full, n), n) != n {
		t.Fatal("a full mask must satisfy the completion guard")
	}
	// …and it is reachable by ACCUMULATION, which is how a real transfer gets
	// there: many partial posts, never one big one.
	acc := []byte(nil)
	for i := 0; i < n; i++ {
		acc = vbUnionMask(acc, maskOf(n, i), n)
	}
	if vbCountSet(acc, n) != n {
		t.Fatalf("accumulated mask = %d bits, want %d", vbCountSet(acc, n), n)
	}
}

func TestStaleVersion(t *testing.T) {
	// absent ⇒ not stale (pre-vbm3 clients do not send it)
	if vbStaleVersion(nil, 3) {
		t.Fatal("absent version must not be treated as stale")
	}
	// garbage ⇒ not stale, same reason (never reject on unparseable input)
	if vbStaleVersion("not-a-number", 3) {
		t.Fatal("unparseable version must not be treated as stale")
	}
	// equal ⇒ current
	if vbStaleVersion(float64(3), 3) {
		t.Fatal("equal version must be accepted")
	}
	// older ⇒ stale (a resurrected session after a crash)
	if !vbStaleVersion(float64(2), 3) {
		t.Fatal("older version must be rejected")
	}
	// newer ⇒ also rejected: the server is authoritative, a client cannot
	// invent a version
	if !vbStaleVersion(float64(4), 3) {
		t.Fatal("newer version must be rejected — the server is authoritative")
	}
	// JSON numbers arrive as float64; a string number is accepted by vbNum too
	if vbStaleVersion("3", 3) {
		t.Fatal("numeric string version must compare equal")
	}
}
