#!/usr/bin/env bash
# Recompute the Go source fingerprint that the running server reports at /build.
#
# The deployed box builds from a dirty working tree, so a commit SHA cannot
# identify what is live. This hashes the same set the Dockerfile does — every
# non-test .go file plus go.mod/go.sum — so a local checkout can be compared
# against production with one string:
#
#   ./scripts/fingerprint-go.sh
#   curl -s https://api.corefinite.com/build
#
# Equal means prod is running this source. Different means it is not, and no
# amount of git log will tell you that.
#
# CR-stripped and LC_ALL=C sorted, exactly as the Dockerfile does it: this repo
# is developed on Windows and checked out with mixed CRLF/LF, and a fingerprint
# that notices line endings could never match between a checkout and the box.
# Keep the two commands identical — cmd/api/build_test.go asserts they are.
set -euo pipefail
cd "$(dirname "$0")/../vaultchat-backend-go"
LC_ALL=C; export LC_ALL
find . -type f \( -name '*.go' -not -name '*_test.go' \) -o -name 'go.mod' -o -name 'go.sum' \
  | sort \
  | while read -r f; do tr -d '\r' < "$f" | sha256sum | cut -d' ' -f1; echo "$f"; done \
  | sha256sum | cut -c1-16
