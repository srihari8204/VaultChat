# Tasks — CC-Wire codec benchmark

## 1. Implementation

- [x] 1.1 Add `vaultchat-backend-go/internal/ccwire/bench_test.go` using stdlib `testing.B`, no new dependency
- [x] 1.2 Cover four representative traffic shapes: ephemeral typing, small durable message, 4 KiB message, control ping
- [x] 1.3 Add encode, decode and round-trip benchmarks with `ReportAllocs` and `SetBytes`
- [x] 1.4 Add a rejection benchmark over hostile inputs (truncated, overlong varint, oversized declaration, deep nesting, long repeats)
- [x] 1.5 Confirm benchmarks do NOT run under plain `go test ./...`

## 2. Measurement

- [x] 2.1 Run the full suite and record results with the environment
- [x] 2.2 Measure whether rejection cost scales with attacker-controlled input size (1 KiB → 128 KiB)
- [x] 2.3 State the rejection-to-acceptance cost ratio

## 3. Verification

- [x] 3.1 `go vet ./...` and `go test ./...` clean
- [x] 3.2 Socket.IO guard still passes; `socket.io-client` absent from deps, devDeps and lockfile
- [x] 3.3 Frontend suite unaffected

## 4. Results

Environment: `goos windows · goarch amd64 · Intel i7-10610U @ 1.80GHz · 8 logical CPUs`.
Single machine, relative baseline — NOT a production capacity claim.

### Encode

| shape | ns/op | B/op | allocs/op |
|---|---:|---:|---:|
| typing/ephemeral | 212.6 | 24 | 2 |
| message/small | 383.9 | 152 | 3 |
| message/4KiB | 2608 | 5016 | 4 |
| control/ping | 251.9 | 32 | 2 |

### Decode

| shape | ns/op | MB/s | B/op | allocs/op |
|---|---:|---:|---:|---:|
| typing/ephemeral | 112.1 | 115.9 | **0** | **0** |
| message/small | 263.8 | 310.9 | 48 | 1 |
| message/4KiB | 248.5 | 16692.9 | 48 | 1 |
| control/ping | 86.4 | 196.9 | **0** | **0** |

**Decode allocates nothing for ephemeral and control frames.** Those are the
highest-frequency shapes, so the codec is already doing the thing that matters
most at connection scale.

### Round-trip (decode + re-encode)

| shape | ns/op | B/op | allocs/op |
|---|---:|---:|---:|
| typing/ephemeral | 373.6 | 24 | 2 |
| message/small | 697.7 | 200 | 4 |
| message/4KiB | 2888 | 5064 | 5 |
| control/ping | 316.7 | 32 | 2 |

### Rejection cost

| hostile input | ns/op | B/op | allocs/op |
|---|---:|---:|---:|
| truncated | 32.3 | **0** | **0** |
| overlong varint | 51.1 | **0** | **0** |
| oversized declaration | 44.8 | **0** | **0** |
| deep nesting | 205.9 | 128 | 1 |
| long repeats | 54150 | 59368 | 11 |

Four of five rejection paths are cheaper than decoding a valid frame and
allocate nothing — including the ~4 GiB oversized declaration, which is refused
in 44.8 ns without allocating, confirming the declaration is treated as a claim
and never as a capacity.

### Does rejection cost scale with attacker input?

| input size | ns/op | B/op | allocs/op |
|---|---:|---:|---:|
| 1 KiB | 31456 | 32104 | 10 |
| 8 KiB | 52882 | 59368 | 11 |
| 64 KiB | 56535 | 59368 | 11 |
| 128 KiB | 53179 | 59368 | 11 |

**It plateaus.** Time and allocation stop growing after ~8 KiB and are identical
at 64 KiB and 128 KiB. `max_repeated_elements = 1024` bounds the work, so a
larger hostile frame buys an attacker nothing. This is the limit behaving
exactly as specified, measured rather than assumed.

### The one asymmetry worth knowing

Repeated-field rejection costs **~54 µs and ~59 KB**, against **248 ns and 48 B**
to decode a valid 4 KiB message — roughly **200x the time and 1200x the
allocation**. It is bounded and does not scale, so it is not an amplification
vector; but it IS the most expensive frame the codec can be asked to process,
and worth remembering when connection-level rate limits are set.
