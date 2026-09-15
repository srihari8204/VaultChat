#!/bin/sh
# Install as /etc/letsencrypt/renewal-hooks/deploy/vaultchat-http3.sh after
# deploying h3-edge. This does not replace nginx's existing renewal behavior.
set -eu
case "${RENEWED_LINEAGE:-}" in
  */api.corefinite.com) ;;
  *) exit 0 ;;
esac
cd /home/srihari/vaultchat-clean
docker compose -p vaultchat -f docker-compose.yml -f docker-compose.prod.yml -f docker-compose.http3.yml \
  exec -T h3-edge caddy reload --config /etc/caddy/Caddyfile --adapter caddyfile --force
