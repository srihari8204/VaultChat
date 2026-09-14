#!/usr/bin/env bash
# Fails when generated build output is tracked by git.
#
# Exists because 313d13b committed 2522 files from
# services/transport/rust-net/target/. A .gitignore rule only stops the NEXT
# mistake; this check is what notices the current one, and it is cheap enough to
# run in CI on every change.
#
# Deliberately matches directories, not extensions: a .so that is a real shipped
# native asset must stay tracked, and an extension list would either miss the
# artifacts or delete the assets.
set -u
fail=0
for d in target build/outputs .gradle node_modules/.cache; do
  n=$(git ls-files | grep -cE "(^|/)${d}/" || true)
  if [ "$n" -gt 0 ]; then
    echo "FAIL: $n tracked files under a '$d' directory"
    git ls-files | grep -E "(^|/)${d}/" | sed 's|/'"${d}"'/.*|/'"${d}"'/|' | sort -u | sed 's/^/      /'
    fail=1
  fi
done
[ "$fail" = 0 ] && echo "ok   no tracked build output"
exit $fail
