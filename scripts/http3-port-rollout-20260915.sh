#!/usr/bin/env bash
set -Eeuo pipefail
umask 077
cd /home/srihari/vaultchat-clean
cp -an .env .env.pre-http3-8443-20260915
cp -an caddy/Caddyfile.http3 caddy/Caddyfile.http3.pre-8443-20260915
install -m 644 /tmp/Caddyfile.http3.8443 caddy/Caddyfile.http3
install -m 644 /tmp/docker-compose.http3.8443.yml docker-compose.http3.yml
sed -i '/^HTTP3_UDP_BIND=/d' .env
printf '\nHTTP3_UDP_BIND=0.0.0.0:8443\n' >> .env
compose=(docker compose -p vaultchat -f docker-compose.yml -f docker-compose.prod.yml -f docker-compose.http3.yml)
"${compose[@]}" config --quiet
ufw allow 8443/udp
"${compose[@]}" up -d --no-deps --no-build --pull never h3-edge
nginx -t
curl --fail --silent --show-error https://api.corefinite.com/health
ss -lunp | grep ':8443 '
iptables -t nat -S PREROUTING | grep -- '--dport 443'
printf '\nHTTP3 moved to UDP8443; TURN redirects preserved; external acceptance pending.\n'
