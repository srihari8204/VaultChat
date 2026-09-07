# vaultcore — the Rust core, via UniFFI

**Status: verified, and NOT wired into the app.** Nothing in `package.json`,
gradle, Xcode or any `.ts` file references this crate. `cargo test` is the only
thing that runs it today. That is deliberate — see *Cost of switching it on*.

```bash
cd rust/vaultcore
cargo test                                # 13 tests, incl. a 2.2M-case sweep
cargo clippy --all-targets -- -D warnings # clean
```

## What UniFFI is, and what it is not

UniFFI generates Kotlin/Swift bindings for a Rust library. **It draws nothing.**
There is no UniFFI path to a board, a glass panel or a dice tray — everything
visible in this app is React Native and stays React Native. What a Rust core can
carry is pure, deterministic **logic** that Android and iOS would otherwise
implement twice, and that benefits from being exactly the same on both.

## What is in here

### `money` — exact money arithmetic (the live payload)

A port of `utils/money.ts`. Chosen because the algorithm is **ours**, it is pure,
it has no I/O and no threads — the safest possible FFI surface — and it already
carries a real bug in its history: `round2((bid - commission) / members)` rounded
each share, so ₹1000 across 7 members paid out ₹1000.02. Money appearing from
nowhere in an organizer's book is the worst class of bug this app can have, and
it is worth having exactly one implementation of.

**The TypeScript is still the live implementation.** `tests/parity.rs` proves the
Rust answers identically, using the vectors from `utils/money.selftest.ts` plus
that file's exhaustive property (every pot ₹0–₹2000 in 1-paise steps across 11
member counts, asserting `each × parts + remainder == total` in paise). A
divergence would otherwise stay invisible until the day someone switches the
call site over — the worst possible moment to find it.

**The rounding trap**, which is the only real hazard in the port:

| | half-way values |
|---|---|
| JS `Math.round(x)` | `floor(x + 0.5)` — rounds toward **+∞**. `Math.round(-2.5) === -2` |
| Rust `f64::round()` | rounds **away from zero**. `(-2.5f64).round() == -3.0` |

`sum_rupees` is documented as handling negatives (reports do `principal -
remaining`), so `f64::round` would have silently disagreed with shipped
behaviour on every negative half-paise. `money::js_round` is the JS definition,
and a test asserts the two *still* disagree — if that test ever goes green by
matching, someone has swapped the implementation back.

### `verify_commit` — a spike that is blocked, on purpose

Verifies a commit-reveal dice roll. It is the right shape for a Rust core, and
it is **unusable in production** for a documented reason: the games server
(`games.corefinite.com` — not ours; `internal/routes/games.go` only mints its
launch token) never publishes its seed. `lib/games/fairness.ts` says so outright,
and `gamesNative.selftest.ts` asserts the hub does not claim provably-fair dice
"because the claim outran the server".

So the verifier can only ever answer `NotPublished`. That is the honest default
and the reason this stays a spike: **the blocker is the protocol, not the
language.** Unblocking it needs the commit-reveal spec from corefinite — how
`commit` derives from `serverSeed`, and how the die derives from both seeds.

## Safety configuration

| Setting | Why |
|---|---|
| `#![forbid(unsafe_code)]` | UniFFI generates the only FFI boundary and it is already audited. Hand-written `unsafe` would be a second, unreviewed one inside a library that handles money. |
| `overflow-checks = true` **in release** | This does money. A silent `i64` wraparound is worse than a crash; the cost is a branch per add, unmeasurable next to a JNI hop. |
| `panic = "unwind"` (not `abort`) | UniFFI wraps every export in `catch_unwind` and turns a panic into a host-language error. Under `abort`, a rounding bug in here would kill the whole chat client. |
| `rust-toolchain.toml` pinned to 1.97.1 | A money core that compiles differently on two machines is not a money core, and a shifting FFI ABI is worse. |
| 3 dependencies (`uniffi`, `sha2`, `hex`) | Everything added here ships inside the app. |
| Saturating casts | `f64 as i64` saturates rather than wrapping, so absurd input cannot produce a negative balance. |

## Cost of switching it on

Not paid yet, and it is not small. Before anyone wires this in:

1. **RN cannot call UniFFI output directly.** The chain is Rust → `uniffi-bindgen`
   → Kotlin/Swift → a TurboModule/JSI wrapper → JS. That wrapper does not exist.
2. **Android:** NDK cross-compile for 4 ABIs (`arm64-v8a`, `armeabi-v7a`, `x86`,
   `x86_64`). NDK 27 is installed on this machine.
3. **iOS:** an `xcframework`, plus a matching Xcode build phase.
4. **Expo:** a config plugin and a prebuild / custom dev client.
5. **APK size:** four more `.so` files. This runs straight into the
   uncompressed-`.so` problem already logged against emulator support — check
   that before committing to it.

**Recommended order if it goes ahead:** wire `money` first (pure, already at
proven parity, trivially reversible), keep `utils/money.ts` as the live path
behind a flag, compare both on device, and only then consider removing the TS.
Do not start with the dice verifier — it is blocked upstream.
