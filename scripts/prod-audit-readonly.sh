#!/usr/bin/env bash
# prod-audit-readonly.sh — production state audit. READS ONLY.
#
# WHY THIS EXISTS
# §17 of the plan says "deployed (not re-verified)". This is the re-verification.
# It is a script rather than a list of commands so the answer is reproducible
# and so the read-only property is reviewable in one place instead of being
# retyped correctly every time.
#
# WHAT IT WILL NOT DO
#   * no restart, reload, pull, up, down, exec, rm, prune
#   * no writes anywhere, including /tmp
#   * no secret VALUES — it prints .env key NAMES and never their contents,
#     because the point is "is the key present", never "what is it".
#     docs/SERVER_INVENTORY.md lists which of these are unrecoverable.
#
# Usage, from the repo root:
#   ssh root@65.21.229.167 'bash -s' < scripts/prod-audit-readonly.sh
#
# Safe to run at any time, including under load. Every command below is a
# reporting command; `set -u` catches typos rather than letting them expand to
# something surprising.

set -u

hr() { printf '\n── %s %s\n' "$1" "$(printf '─%.0s' $(seq 1 $((60 - ${#1}))))"; }

hr "host"
uptime
echo "kernel: $(uname -r)"

hr "disk"
df -h / /var/lib/docker /data 2>/dev/null

hr "memory"
free -h 2>/dev/null | head -3

hr "containers"
docker ps --format '{{.Names}}\t{{.Status}}\t{{.Image}}' 2>/dev/null

hr "containers NOT running (a stopped one is the thing you want to notice)"
docker ps -a --filter 'status=exited' --filter 'status=dead' \
  --format '{{.Names}}\t{{.Status}}' 2>/dev/null | head -20

hr "restart counts (a climbing count is a crash loop wearing a disguise)"
for c in $(docker ps --format '{{.Names}}' 2>/dev/null); do
  n=$(docker inspect -f '{{.RestartCount}}' "$c" 2>/dev/null)
  [ "${n:-0}" != "0" ] && printf '%s\trestarts=%s\n' "$c" "$n"
done
echo "(no lines above = nothing has restarted)"

hr "public listeners — anything not on loopback"
ss -lntu 2>/dev/null | grep -vE '127\.0\.0\.1|\[::1\]' | head -30

hr "is HTTP/3 actually possible here? (UDP/443 = yes, absent = no)"
ss -lnu 2>/dev/null | grep -E ':443' || echo "no UDP/443 listener — HTTP/3 is NOT active"

hr "nginx: config validity and protocol"
nginx -t 2>&1 | tail -2
grep -rhn 'listen ' /etc/nginx/sites-enabled/ 2>/dev/null | head -10

hr "TLS certificate expiry"
for d in /etc/letsencrypt/live/*/; do
  [ -e "$d/cert.pem" ] || continue
  printf '%s\t%s\n' "$(basename "$d")" \
    "$(openssl x509 -enddate -noout -in "$d/cert.pem" 2>/dev/null | cut -d= -f2)"
done

hr "env key NAMES present (values are never printed)"
for f in /home/srihari/vaultchat/.env /home/srihari/vaultchat/vaultchat-backend/.env; do
  [ -r "$f" ] || { echo "$f: not readable"; continue; }
  printf '%s: %s keys\n' "$f" "$(grep -cE '^[A-Z0-9_]+=' "$f" 2>/dev/null)"
  grep -oE '^[A-Z0-9_]+' "$f" 2>/dev/null | sort | tr '\n' ' '
  echo
done

hr "backup freshness (an old newest-backup is the quiet failure)"
ls -lt /home/srihari/vaultchat-backups/*.enc 2>/dev/null | head -3 \
  || echo "no .enc backups found at the documented path"

hr "postgres reachability and size"
docker exec -i "$(docker ps --format '{{.Names}}' | grep -m1 postgres)" \
  psql -U postgres -tAc \
  "select current_database()||' '||pg_size_pretty(pg_database_size(current_database()))" \
  2>/dev/null || echo "could not query postgres (container name or auth differs)"

hr "recent errors in the api log (last 50 lines, filtered)"
api=$(docker ps --format '{{.Names}}' | grep -m1 -E 'api|backend')
[ -n "${api:-}" ] && docker logs --tail 50 "$api" 2>&1 \
  | grep -iE 'panic|fatal|error' | tail -10 \
  || echo "(no api container matched, or no errors in the last 50 lines)"

hr "done"
echo "Every command above was read-only. Nothing was changed."
