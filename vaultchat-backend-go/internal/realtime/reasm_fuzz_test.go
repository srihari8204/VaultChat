package realtime

// reasm_fuzz_test.go — adversarial coverage of fragment reassembly.
//
// WHY THIS FILE EXISTS SEPARATELY
//
// internal/ccwire/fuzz_test.go fuzzes decoding: bytes in, structure out. It
// cannot reach reassembly, because a reassembler is STATEFUL — the interesting
// failures need a SEQUENCE of fragments, not one malformed buffer. Body field
// 112 (Fragment) decodes fine on its own; the damage is done by what a peer
// sends next.
//
// This is the remote memory-exhaustion surface. A decoder that refuses a bad
// frame still refuses it in constant space. A reassembler holds bytes across
// calls, on a peer's promise that the rest is coming — so the bound that
// matters is not "is this fragment well formed" but "how much can a peer make
// me hold, and for how long, by never finishing".
//
// The limits under test are the ones the handshake advertises:
//
//	max_fragments_per_message     16
//	max_message_body_bytes         1 MiB   — one message
//	max_reassembly_bytes           2 MiB   — ALL in-progress sets, one session
//	max_concurrent_reassemblies    8
//	reassembly_lifetime_ms        30_000
//
// max_reassembly_bytes is the load-bearing one. Without it the real ceiling is
// concurrency x body = 8 MiB, four times what the handshake promises — and a
// promise the server does not keep is worse than a smaller promise.

import (
	"testing"

	"vaultchat/backend-go/internal/ccwire"
)

// FuzzReassemblySequence drives a whole fragment SEQUENCE from fuzzer bytes.
// Each 16-byte group becomes one fragment, so the fuzzer explores orderings,
// duplicate indices, absent finals and interleaved ids — the shapes a single
// malformed frame cannot express.
func FuzzReassemblySequence(f *testing.F) {
	// Seeds are shapes worth starting from, not an exhaustive list.
	f.Add([]byte{})
	f.Add([]byte{0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0, 1}) // single complete
	f.Add(make([]byte, 16*40))                                    // many zero fragments
	f.Add([]byte{
		0, 0, 0, 0, 0, 0, 0, 2, 0, 0, 0, 0, 0, 0, 0, 0, // index 0 of 2, not last
		0, 0, 0, 0, 0, 0, 0, 2, 0, 0, 0, 0, 0, 0, 0, 0, // same index again
	})
	// A set that declares far more than it ever sends: the never-finished case.
	f.Add([]byte{0, 0, 0, 0, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0, 0, 0, 0})

	lim := ccwire.DefaultLimits()

	f.Fuzz(func(t *testing.T, data []byte) {
		r := newFragmentReassembler(lim)

		const stride = 16
		now := int64(0)

		for off := 0; off+stride <= len(data); off += stride {
			g := data[off : off+stride]

			// A tiny id alphabet on purpose: it forces COLLISIONS between sets,
			// which is where cross-set confusion would show. A wide id space
			// would mostly test the map.
			id := string(rune('a' + int(g[0]%4)))

			frag := ccwire.Fragment{
				FragmentID: id,
				Index:      uint32(g[1]) | uint32(g[2])<<8,
				Total:      uint32(g[3]) | uint32(g[4])<<8,
				TotalBytes: uint64(g[5]) | uint64(g[6])<<8 | uint64(g[7])<<16,
				Chunk:      g[8:15],
				Last:       g[15]&1 == 1,
			}

			// The assertion is that this RETURNS. A panic propagates and fails.
			_, _, _ = r.accept(frag, now)

			// Bounds must hold after EVERY fragment, not merely at the end. A
			// reassembler that exceeds its budget and then trims has already
			// allocated the memory an attacker was aiming for.
			if got := r.len(); got > MaxConcurrentReassemblies {
				t.Fatalf("%d concurrent sets exceeds MaxConcurrentReassemblies=%d",
					got, MaxConcurrentReassemblies)
			}
			if got := r.bufferedBytes(); got > uint64(MaxReassemblyBytes) {
				t.Fatalf("buffered %d bytes exceeds MaxReassemblyBytes=%d",
					got, uint64(MaxReassemblyBytes))
			}

			// Advance time sometimes so the lifetime sweep is exercised in the
			// same run rather than needing its own target.
			if g[15]&2 == 2 {
				now += 1000
				r.sweep(now)
			}
		}

		// Sweeping past the lifetime must release everything. A set that
		// survives its own expiry is a slow leak: memory a peer parked and
		// walked away from.
		r.sweep(now + int64(ReassemblyLifetimeMS) + 1)
		if got := r.len(); got != 0 {
			t.Fatalf("%d sets survived the lifetime sweep", got)
		}
		if got := r.bufferedBytes(); got != 0 {
			t.Fatalf("%d bytes still buffered after the lifetime sweep", got)
		}
	})
}
