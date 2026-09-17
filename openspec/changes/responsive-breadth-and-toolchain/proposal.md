# Restore the Rust toolchain, and close the responsive gaps it hides

## Why

Two unrelated problems block "works on any device", and one masks the other.

**The build cannot produce a universal APK.** There is no MSVC linker on this host, so
cargo cannot compile its own build scripts. Every release since has been arm64-only —
32-bit armv7 devices, which are exactly the low-end handsets this app targets, get no
build at all. The Android Rust targets and cargo-ndk were already installed; only the
HOST linker was missing.

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
