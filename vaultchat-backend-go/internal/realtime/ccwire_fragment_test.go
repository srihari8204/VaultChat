package realtime

import (
	"bytes"
	"testing"

	"vaultchat/backend-go/internal/ccwire"
)

// frag builds a Fragment the way the decoder would hand one over.
func frag(id string, idx, total uint32, totalBytes uint64, chunk []byte) ccwire.Fragment {
	return ccwire.Fragment{
		FragmentID: id,
		Index:      idx,
		Total:      total,
		TotalBytes: totalBytes,
		Chunk:      chunk,
		Last:       idx == total-1,
	}
}

func newReasm() *fragmentReassembler { return newFragmentReassembler(ccwire.DefaultLimits()) }

// ── happy paths ─────────────────────────────────────────────────────────

func TestFragmentReassembleOrder(t *testing.T) {
	want := []byte("abcdefghi")
	cases := []struct {
		name  string
		order []uint32
	}{
		{"in order", []uint32{0, 1, 2}},
		{"reverse", []uint32{2, 1, 0}},
		{"interleaved", []uint32{1, 2, 0}},
		{"last first", []uint32{2, 0, 1}},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			r := newReasm()
			var got []byte
			for n, idx := range tc.order {
				body, done, err := r.accept(frag("f1", idx, 3, 9, want[idx*3:idx*3+3]), 1000)
				if err != nil {
					t.Fatalf("accept %d: %v", idx, err)
				}
				if done != (n == 2) {
					t.Fatalf("accept %d: done=%v at step %d", idx, done, n)
				}
				got = body
			}
			if !bytes.Equal(got, want) {
				t.Fatalf("got %q want %q", got, want)
			}
			if r.len() != 0 {
				t.Fatalf("slot not released: %d sets", r.len())
			}
		})
	}
}

func TestFragmentSingleFragmentSet(t *testing.T) {
	r := newReasm()
	body, done, err := r.accept(frag("solo", 0, 1, 3, []byte("xyz")), 0)
	if err != nil || !done || !bytes.Equal(body, []byte("xyz")) {
		t.Fatalf("got %q %v %v", body, done, err)
	}
}

func TestFragmentChunkIsCopiedNotAliased(t *testing.T) {
	r := newReasm()
	buf := []byte("AB")
	if _, done, err := r.accept(frag("c", 0, 2, 4, buf), 0); done || err != nil {
		t.Fatalf("first: %v %v", done, err)
	}
	copy(buf, "ZZ") // caller reuses the frame buffer
	body, done, err := r.accept(frag("c", 1, 2, 4, []byte("CD")), 0)
	if err != nil || !done {
		t.Fatalf("second: %v %v", done, err)
	}
	if !bytes.Equal(body, []byte("ABCD")) {
		t.Fatalf("chunk aliased the caller's buffer: %q", body)
	}
}

// ── per-fragment refusals, all decidable before the table is touched ────

func TestFragmentRefusals(t *testing.T) {
	big := make([]byte, 16)
	cases := []struct {
		name string
		f    ccwire.Fragment
		want fragmentError
	}{
		{"empty id", ccwire.Fragment{Total: 1, TotalBytes: 1, Chunk: []byte("a"), Last: true}, fragIDRequired},
		{"total zero", ccwire.Fragment{FragmentID: "a", Total: 0}, fragTotalZero},
		{"total over max", ccwire.Fragment{FragmentID: "a", Total: 17, TotalBytes: 1}, fragTooManyFragments},
		{"index >= total", ccwire.Fragment{FragmentID: "a", Index: 3, Total: 3, TotalBytes: 1}, fragIndexOutOfRange},
		{"last set on non-last", ccwire.Fragment{FragmentID: "a", Index: 0, Total: 3, TotalBytes: 9, Last: true}, fragLastFlagInconsistent},
		{"last clear on last", ccwire.Fragment{FragmentID: "a", Index: 2, Total: 3, TotalBytes: 9, Last: false}, fragLastFlagInconsistent},
		{"total_bytes over max", ccwire.Fragment{FragmentID: "a", Index: 0, Total: 1, TotalBytes: 1048577, Last: true}, fragTotalBytesOverMax},
		{"chunk alone exceeds total_bytes", ccwire.Fragment{FragmentID: "a", Index: 0, Total: 2, TotalBytes: 4, Chunk: big}, fragLengthExceedsTotal},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			r := newReasm()
			_, done, err := r.accept(tc.f, 0)
			if done {
				t.Fatal("refused fragment reported done")
			}
			if err != tc.want {
				t.Fatalf("got %v want %v", err, tc.want)
			}
			if r.len() != 0 {
				t.Fatalf("a refused fragment opened a set: %d", r.len())
			}
		})
	}
}

func TestFragmentEveryErrorCodeIsFragmentInvalid(t *testing.T) {
	for e := fragTotalZero; e <= fragIDRequired; e++ {
		if e.ErrorCode() != 9 {
			t.Fatalf("%v -> code %d, want 9", e, e.ErrorCode())
		}
		if e.Error() == "" || e.Error() == "FRAGMENT_INVALID" {
			t.Fatalf("variant %d has no name", e)
		}
	}
}

// ── refusals that concern an existing set ───────────────────────────────

func TestFragmentDuplicateIndexDestroysSet(t *testing.T) {
	r := newReasm()
	if _, _, err := r.accept(frag("d", 0, 3, 9, []byte("aaa")), 0); err != nil {
		t.Fatal(err)
	}
	if _, _, err := r.accept(frag("d", 0, 3, 9, []byte("bbb")), 0); err != fragDuplicateIndex {
		t.Fatalf("got %v", err)
	}
	if r.len() != 0 {
		t.Fatalf("set survived a duplicate: %d", r.len())
	}
}

func TestFragmentInconsistentDeclaration(t *testing.T) {
	cases := []struct {
		name   string
		second ccwire.Fragment
	}{
		{"total changed", ccwire.Fragment{FragmentID: "m", Index: 1, Total: 2, TotalBytes: 9, Chunk: []byte("bbb"), Last: true}},
		{"total_bytes changed", ccwire.Fragment{FragmentID: "m", Index: 1, Total: 3, TotalBytes: 12, Chunk: []byte("bbb")}},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			r := newReasm()
			if _, _, err := r.accept(frag("m", 0, 3, 9, []byte("aaa")), 0); err != nil {
				t.Fatal(err)
			}
			if _, _, err := r.accept(tc.second, 0); err != fragDeclarationChanged {
				t.Fatalf("got %v", err)
			}
			if r.len() != 0 {
				t.Fatalf("set survived a re-declaration: %d", r.len())
			}
		})
	}
}

func TestFragmentRunningSumExceedsDeclaration(t *testing.T) {
	r := newReasm()
	if _, _, err := r.accept(frag("g", 0, 2, 6, []byte("aaaa")), 0); err != nil {
		t.Fatal(err)
	}
	// 4 + 4 > 6, though each chunk alone is legal.
	if _, _, err := r.accept(frag("g", 1, 2, 6, []byte("bbbb")), 0); err != fragLengthExceedsTotal {
		t.Fatalf("got %v", err)
	}
	if r.len() != 0 {
		t.Fatalf("set survived an overrun: %d", r.len())
	}
}

func TestFragmentShortSetIsRefusedNotTruncated(t *testing.T) {
	r := newReasm()
	if _, _, err := r.accept(frag("s", 0, 2, 9, []byte("aaa")), 0); err != nil {
		t.Fatal(err)
	}
	body, done, err := r.accept(frag("s", 1, 2, 9, []byte("bbb")), 0)
	if err != fragTotalMismatch {
		t.Fatalf("got %v", err)
	}
	if done || body != nil {
		t.Fatal("a short set was delivered")
	}
	if r.len() != 0 {
		t.Fatalf("short set leaked: %d", r.len())
	}
}

func TestFragmentMissingPieceNeverCompletes(t *testing.T) {
	r := newReasm()
	for _, i := range []uint32{0, 2} {
		_, done, err := r.accept(frag("h", i, 3, 9, []byte("aaa")), 0)
		if err != nil || done {
			t.Fatalf("idx %d: %v %v", i, done, err)
		}
	}
	if r.len() != 1 || r.bufferedBytes() != 6 {
		t.Fatalf("sets=%d buffered=%d", r.len(), r.bufferedBytes())
	}
}

// ── lifetime ────────────────────────────────────────────────────────────

func TestFragmentExpiry(t *testing.T) {
	r := newReasm()
	if _, _, err := r.accept(frag("e", 0, 2, 6, []byte("aaa")), 1_000); err != nil {
		t.Fatal(err)
	}
	// Exactly at the lifetime is still inside it.
	if _, done, err := r.accept(frag("e", 1, 2, 6, []byte("bbb")), 1_000+ReassemblyLifetimeMS); err != nil || !done {
		t.Fatalf("at the boundary: %v %v", done, err)
	}

	r = newReasm()
	if _, _, err := r.accept(frag("e", 0, 2, 6, []byte("aaa")), 1_000); err != nil {
		t.Fatal(err)
	}
	if _, _, err := r.accept(frag("e", 1, 2, 6, []byte("bbb")), 1_001+ReassemblyLifetimeMS); err != fragExpired {
		t.Fatalf("one ms past the lifetime was accepted")
	}
	if r.len() != 0 {
		t.Fatalf("expired set leaked: %d", r.len())
	}
}

func TestFragmentAbandonedSetIsReclaimed(t *testing.T) {
	r := newReasm()
	for i := 0; i < 4; i++ {
		if _, _, err := r.accept(frag(string(rune('a'+i)), 0, 2, 6, []byte("aaa")), 0); err != nil {
			t.Fatal(err)
		}
	}
	if got := r.sweep(ReassemblyLifetimeMS); got != 0 {
		t.Fatalf("swept %d live sets", got)
	}
	if got := r.sweep(ReassemblyLifetimeMS + 1); got != 4 {
		t.Fatalf("swept %d, want 4", got)
	}
	if r.len() != 0 || r.bufferedBytes() != 0 {
		t.Fatalf("abandoned sets leaked: %d sets %d bytes", r.len(), r.bufferedBytes())
	}
}

func TestFragmentClockGoingBackwardsDoesNotExpire(t *testing.T) {
	r := newReasm()
	if _, _, err := r.accept(frag("b", 0, 2, 6, []byte("aaa")), 10_000); err != nil {
		t.Fatal(err)
	}
	if got := r.sweep(5_000); got != 0 {
		t.Fatalf("a backwards clock expired %d sets", got)
	}
}

func TestFragmentDrop(t *testing.T) {
	r := newReasm()
	if _, _, err := r.accept(frag("x", 0, 2, 6, []byte("aaa")), 0); err != nil {
		t.Fatal(err)
	}
	if !r.drop("x") || r.len() != 0 {
		t.Fatal("drop did not release the slot")
	}
	if r.drop("x") {
		t.Fatal("drop reported a set that was not there")
	}
}

// ── concurrency and the session byte budget ─────────────────────────────

func TestFragmentConcurrencyCap(t *testing.T) {
	r := newReasm()
	for i := 0; i < MaxConcurrentReassemblies; i++ {
		id := string(rune('a' + i))
		if _, _, err := r.accept(frag(id, 0, 2, 6, []byte("aaa")), 0); err != nil {
			t.Fatalf("set %d: %v", i, err)
		}
	}
	if _, _, err := r.accept(frag("overflow", 0, 2, 6, []byte("aaa")), 0); err != fragTooManyConcurrent {
		t.Fatalf("the 9th set was accepted: %v", err)
	}
	if r.len() != MaxConcurrentReassemblies {
		t.Fatalf("cap changed the set count: %d", r.len())
	}
	// The newcomer loses; the incumbents must be untouched and still completable.
	if _, done, err := r.accept(frag("a", 1, 2, 6, []byte("bbb")), 0); err != nil || !done {
		t.Fatalf("an incumbent was evicted: %v %v", done, err)
	}
	// And the freed slot is usable.
	if _, _, err := r.accept(frag("overflow", 0, 2, 6, []byte("aaa")), 0); err != nil {
		t.Fatalf("freed slot unusable: %v", err)
	}
}

func TestFragmentCapDrainsByExpiry(t *testing.T) {
	r := newReasm()
	for i := 0; i < MaxConcurrentReassemblies; i++ {
		if _, _, err := r.accept(frag(string(rune('a'+i)), 0, 2, 6, []byte("aaa")), 0); err != nil {
			t.Fatal(err)
		}
	}
	// A new set opened after the lifetime reclaims the stale ones itself.
	if _, _, err := r.accept(frag("late", 0, 2, 6, []byte("aaa")), ReassemblyLifetimeMS+1); err != nil {
		t.Fatalf("stale sets held the cap closed: %v", err)
	}
	if r.len() != 1 {
		t.Fatalf("sets=%d want 1", r.len())
	}
}

func TestFragmentSessionByteBudget(t *testing.T) {
	r := newReasm()
	mib := make([]byte, 1048576)
	// Two full sets: 2 MiB held, exactly the advertised max_reassembly_bytes.
	for i := 0; i < 2; i++ {
		if _, _, err := r.accept(frag(string(rune('a'+i)), 0, 2, 1048576, mib), 0); err != nil {
			t.Fatalf("set %d: %v", i, err)
		}
	}
	if r.bufferedBytes() != 2*1048576 {
		t.Fatalf("buffered %d", r.bufferedBytes())
	}
	// One byte more than the budget, even though the per-set bound and the
	// concurrency cap both still have room.
	if _, _, err := r.accept(frag("c", 0, 2, 1048576, []byte("x")), 0); err != fragSessionBudget {
		t.Fatalf("budget not enforced: %v", err)
	}
	if r.bufferedBytes() != 2*1048576 {
		t.Fatalf("budget refusal changed what is held: %d", r.bufferedBytes())
	}
}

// ── isolation ───────────────────────────────────────────────────────────

func TestFragmentStateIsPerSession(t *testing.T) {
	a, b := newReasm(), newReasm()
	// Same fragment_id on both sessions: they must not see each other.
	if _, _, err := a.accept(frag("same", 0, 2, 6, []byte("aaa")), 0); err != nil {
		t.Fatal(err)
	}
	if _, done, err := b.accept(frag("same", 0, 2, 6, []byte("zzz")), 0); err != nil || done {
		t.Fatalf("b: %v %v", done, err)
	}
	// b filling the cap must not refuse a's traffic.
	for i := 0; i < MaxConcurrentReassemblies; i++ {
		b.accept(frag("pad"+string(rune('a'+i)), 0, 2, 6, []byte("aaa")), 0)
	}
	body, done, err := a.accept(frag("same", 1, 2, 6, []byte("bbb")), 0)
	if err != nil || !done || !bytes.Equal(body, []byte("aaabbb")) {
		t.Fatalf("session a was affected by session b: %q %v %v", body, done, err)
	}
}

// ── the decoder is the shared one: field layout parity ──────────────────

// Bytes from lib/ccwire/__vectors__/codec.json, "fragment canonical".
func TestFragmentDecoderFieldLayout(t *testing.T) {
	body := []byte{
		0x0a, 0x02, 'f', '1', // 1: fragment_id "f1"
		0x10, 0x01, // 2: index 1
		0x18, 0x03, // 3: total 3
		0x20, 0x09, // 4: total_bytes 9
		0x2a, 0x03, 0xaa, 0xbb, 0xcc, // 5: chunk
	}
	v, err := ccwire.DecodeBody(ccwire.BodyFragment, body, ccwire.DefaultLimits(), 1)
	if err != nil {
		t.Fatal(err)
	}
	f := v.(ccwire.Fragment)
	if f.FragmentID != "f1" || f.Index != 1 || f.Total != 3 || f.TotalBytes != 9 || f.Last {
		t.Fatalf("layout mismatch: %+v", f)
	}
	if !bytes.Equal(f.Chunk, []byte{0xaa, 0xbb, 0xcc}) {
		t.Fatalf("chunk %x", f.Chunk)
	}
}

// ── session wiring ──────────────────────────────────────────────────────

func encodeFragment(f ccwire.Fragment) []byte {
	var b []byte
	b = ccwire.AppendStringField(b, 1, f.FragmentID)
	b = ccwire.AppendVarintField(b, 2, uint64(f.Index))
	b = ccwire.AppendVarintField(b, 3, uint64(f.Total))
	b = ccwire.AppendVarintField(b, 4, f.TotalBytes)
	b = ccwire.AppendBytesField(b, 5, f.Chunk)
	if f.Last {
		b = ccwire.AppendBoolField(b, 6, true)
	}
	return b
}

func fragMsg(f ccwire.Fragment) ccwire.Message {
	return ccwire.Message{
		RequestID:    "r1",
		TrafficClass: ccwire.TrafficClassControl,
		Stream:       1,
		BodyField:    ccwire.BodyFragment,
		Body:         encodeFragment(f),
	}
}

func TestServeFragmentPendingThenComplete(t *testing.T) {
	s, f := newSession("u1", nil)
	s.hello = true
	r := newFragmentReassembler(s.lim)

	// A Ping is the inner payload: serveBody does not route it, so the assertion
	// is about reassembly and re-dispatch, not about any handler's database.
	inner, err := ccwire.EncodeMessage(ccwire.Message{
		RequestID:    "inner",
		TrafficClass: ccwire.TrafficClassControl,
		Stream:       1,
		BodyField:    ccwire.BodyPing,
		Body:         nil,
	}, s.lim, 0)
	if err != nil {
		t.Fatal(err)
	}
	half := len(inner) / 2
	n := uint64(len(inner))

	handled, alive := serveFragment(s, r, fragMsg(frag("w", 0, 2, n, inner[:half])))
	if !handled || !alive {
		t.Fatalf("first: handled=%v alive=%v", handled, alive)
	}
	if got := f.last(t).BodyField; got != ccwire.BodyAck {
		t.Fatalf("a held fragment was not acked, body %d", got)
	}

	handled, alive = serveFragment(s, r, fragMsg(frag("w", 1, 2, n, inner[half:])))
	if handled || !alive {
		// serveBody does not route Ping, so it reports unhandled — which proves
		// the reassembled bytes were decoded and dispatched as a Message.
		t.Fatalf("second: handled=%v alive=%v", handled, alive)
	}
	if r.len() != 0 {
		t.Fatalf("completed set leaked: %d", r.len())
	}
}

func TestServeFragmentRefusals(t *testing.T) {
	nested, err := ccwire.EncodeMessage(ccwire.Message{
		RequestID:    "x",
		TrafficClass: ccwire.TrafficClassControl,
		Stream:       1,
		BodyField:    ccwire.BodyFragment,
		Body:         encodeFragment(frag("inner", 0, 1, 1, []byte("a"))),
	}, ccwire.DefaultLimits(), 0)
	if err != nil {
		t.Fatal(err)
	}

	cases := []struct {
		name string
		body []byte
	}{
		{"undecodable fragment body", []byte{0x2a, 0x05, 0xaa, 0xbb}}, // truncated chunk
		{"bounds refusal", encodeFragment(ccwire.Fragment{FragmentID: "a", Index: 5, Total: 2, TotalBytes: 1})},
		{"reassembled payload is not a message", encodeFragment(frag("j", 0, 1, 3, []byte{0xff, 0xff, 0xff}))},
		{"reassembled payload is another fragment", encodeFragment(frag("k", 0, 1, uint64(len(nested)), nested))},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			s, f := newSession("u1", nil)
			s.hello = true
			r := newFragmentReassembler(s.lim)
			handled, alive := serveFragment(s, r, ccwire.Message{
				RequestID:    "r1",
				TrafficClass: ccwire.TrafficClassControl,
				Stream:       1,
				BodyField:    ccwire.BodyFragment,
				Body:         tc.body,
			})
			if !handled || !alive {
				t.Fatalf("handled=%v alive=%v", handled, alive)
			}
			m := f.last(t)
			if m.BodyField != ccwire.BodyError {
				t.Fatalf("body %d, want Error", m.BodyField)
			}
			if !bytes.Contains(m.Body, []byte{0x08, byte(errFragmentInvalid)}) {
				t.Fatalf("error body %x carries no FRAGMENT_INVALID code", m.Body)
			}
			if r.len() != 0 {
				t.Fatalf("refusal left %d sets", r.len())
			}
		})
	}
}
