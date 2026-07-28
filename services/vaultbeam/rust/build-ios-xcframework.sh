#!/usr/bin/env bash
# build-ios-xcframework.sh — package the vaultbeam-core Rust staticlib as
# VaultBeamCore.xcframework (device + simulator, arm64) for the Swift RN module.
#
# One-time toolchain setup:
#   rustup target add aarch64-apple-ios aarch64-apple-ios-sim
#   (Xcode + command line tools installed; run on macOS.)
#
# Output: plugins/vaultbeam-core-ios/VaultBeamCore.xcframework
# The podspec (plugins/vaultbeam-core-ios/VaultBeamCore.podspec) vendors it.
#
# Re-run whenever services/vaultbeam/rust changes. The wire format is FROZEN, so
# a rebuilt framework stays byte-compatible with existing Android/relay peers.
set -euo pipefail
cd "$(dirname "$0")"                      # services/vaultbeam/rust

HEADERS="../../../plugins/vaultbeam-core-ios/include"   # dir containing VaultBeamCore.h
OUT="../../../plugins/vaultbeam-core-ios/VaultBeamCore.xcframework"
LIB="libvaultbeam_core.a"                 # [lib] name = "vaultbeam_core"

rustup target add aarch64-apple-ios aarch64-apple-ios-sim >/dev/null 2>&1 || true

echo "› cargo build (device: aarch64-apple-ios)"
cargo build --release --lib --target aarch64-apple-ios
echo "› cargo build (simulator: aarch64-apple-ios-sim)"
cargo build --release --lib --target aarch64-apple-ios-sim

rm -rf "$OUT"
echo "› xcodebuild -create-xcframework → $OUT"
xcodebuild -create-xcframework \
  -library "target/aarch64-apple-ios/release/${LIB}"     -headers "$HEADERS" \
  -library "target/aarch64-apple-ios-sim/release/${LIB}" -headers "$HEADERS" \
  -output "$OUT"

echo "✓ built $OUT"
