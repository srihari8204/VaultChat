#!/bin/sh
# Root-run deploy hook for the optional nonroot Go WebTransport listener.
set -eu
case "${RENEWED_LINEAGE:-}" in
  */api.corefinite.com) ;;
  *) exit 0 ;;
esac
destination=/home/srihari/vaultchat-clean/secrets/ccwire-wt
install -d -o 1000 -g 1000 -m 700 "$destination"
temporary=$(mktemp "$destination/.tls.pem.XXXXXX")
trap 'rm -f "$temporary"' EXIT HUP INT TERM
cat "$RENEWED_LINEAGE/fullchain.pem" "$RENEWED_LINEAGE/privkey.pem" > "$temporary"
chown 1000:1000 "$temporary"
chmod 600 "$temporary"
mv -f "$temporary" "$destination/tls.pem"
