# Restore the Rust toolchain, and close the responsive gaps it hides

## Why

Two unrelated problems block "works on any device", and one masks the other.

**The build cannot produce a universal APK.** ~~There is no MSVC linker on this host, so
cargo cannot compile its own build scripts. Every release since has been arm64-only —
32-bit armv7 devices, which are exactly the low-end handsets this app targets, get no
build at all.~~ The Android Rust targets and cargo-ndk were already installed; only the
HOST linker was missing.

> **CORRECTED 2026-10-01 — the premise above is wrong, and this is the overstated
> half of this proposal.** All four ABIs are the configured default:
> `plugins/withGradleMemory.js:27` sets
> `arm64-v8a,armeabi-v7a,x86,x86_64` and `android/gradle.properties:30` carries the
> same list. A default `assembleRelease` therefore builds armv7, and 32-bit handsets
> are served. The arm64-only artifacts people observed were produced by the
> deliberate `-PreactNativeArchitectures=arm64-v8a` override, which exists because
> all four ABIs take >50 min on this host versus ~2.5 min for one (and is what
> `npm run build:android:apk:arm64` passes).
>
> The missing MSVC linker is real but much narrower than claimed: the `rust/` crates
> are referenced only by `package.json`'s `test:rust`, so the linker blocks
> **`npm run test:rust` on this host** and nothing in the Android build. Fix is to
> run `test:rust` in CI on a Linux runner, not to change the build.
>
> What survives from this proposal is the second problem below — the responsive
> guard that never fires — which is genuine and unaffected.

**The guard that was supposed to catch fixed-height text containers never fired.**
`lib/responsiveLayout.selftest.ts` filters style names with `\b(row|item|cell|btn|...)\b`.
Style keys are camelCase, so there is no word boundary before the keyword: `searchRow`,
`addBtn`, `typeCell` never match. ~18 containers with a hard `height:` therefore pass
today and clip their text at OS font scale 1.5 — including `PhoneField`, which is on the
signup path, so a user with large text cannot read what they are typing to create an
account.

## What changes

- Pin the transport crates to `1.97.1-x86_64-pc-windows-gnu`: same rustc as before, a
  host that brings its own linker. `rust/vaultcore`'s deliberate 1.97.1 pin is untouched.
- Rebuild the three missing ABIs; drop the two build workarounds.
- Make the responsive guard camelCase-aware, then fix what it catches.
- Replace `numberOfLines={1}` on values a user must be able to READ (an outstanding
  balance, a VaultID) with shrink-to-fit.
- Five screens still read `StatusBar.currentHeight ?? 0` instead of the live `HEADER_TOP`.

## Non-goals

- No RTL. 170 physical margin pairs exist and no RTL locale ships; starting that now
  would be a large change with no user today.
- No iOS. It cannot be built on a Windows host at all.
- No protocol or wire-format change.

## Success

A universal APK (4 ABIs) that installs and runs on both handsets, `tsc` clean, every
selftest passing, the responsive guard demonstrated to FAIL on a reverted fix, and no
regression to any working screen.
