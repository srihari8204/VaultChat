#!/usr/bin/env bash
# Move Maps into its own container (openspec: microservices-maps-pilot).
#
# Run ON THE BOX, in the tree the live stack runs from, one step at a time:
#
#   cd /home/srihari/vaultchat-clean
#   ./deploy/maps-split.sh preflight   checks only, changes nothing
#   ./deploy/maps-split.sh keys        core signs logins with Ed25519 (recreates go-api once)
#   ./deploy/maps-split.sh hs256-off   15+ minutes after keys (recreates go-api once)
#   ./deploy/maps-split.sh start       build and start maps-api (Caddy may not route yet)
#   ./deploy/maps-split.sh route       reload Caddy so /nav/* goes to maps-api, go-api as fallback
#   ./deploy/maps-split.sh stop        stop maps-api; Caddy falls back to go-api within 5 s
#   ./deploy/maps-split.sh status      where things stand
#   ./deploy/maps-split.sh keys-rollback   go-api back to HS256 (stops maps-api first)
#
# The config (both compose files, the Caddyfile, prometheus.yml) is NOT copied
# by this script: scripts/deploy.sh ships it, from your machine, like every
# other change. Run that first; preflight checks it landed. Migration 139 must
# be applied (deploy.sh does it unless SKIP_MIGRATIONS=1).
#
# Everything this writes is backed up in .deploy-maps-split/ first; the root
# .env gets new lines only.
set -euo pipefail

ROOT=/home/srihari/vaultchat-clean
STATE=.deploy-maps-split
cd "$(dirname "$0")/.."
[ "$(pwd -P)" = "$(cd "$ROOT" 2>/dev/null && pwd -P)" ] \
  || { echo "STOP: run this from $ROOT (the live stack's tree), not $(pwd)" >&2; exit 1; }
[ -f docker-compose.box.yml ] || { echo "STOP: docker-compose.box.yml is missing" >&2; exit 1; }

# -p vaultchat, exactly as scripts/deploy.sh: this directory is not named
# "vaultchat", and without -p compose would act on a NEW project called
# vaultchat-clean instead of the containers that are live.
dc()  { docker compose -p vaultchat -f docker-compose.yml -f docker-compose.prod.yml -f docker-compose.box.yml "$@"; }
dcs() { dc --profile split "$@"; }
say() { printf '\n== %s\n' "$*"; }
die() { echo "STOP: $*" >&2; exit 1; }
mkdir -p "$STATE"

KEY_DIR=secrets/access-token          # mounted into go-api only
PUB_DIR=secrets/access-token-pub      # mounted into maps-api only
KEY_IN_CONTAINER=/run/secrets/access-token/access-token.key

# ── helpers ────────────────────────────────────────────────────────────
psql_q() { dc exec -T postgres psql -U vaultchat -d vaultchat -tAq -v ON_ERROR_STOP=1 "$@"; }

# Root .env: compose reads it for ${VAR} interpolation; no container loads it.
# Values written here are hex or URLs, so sed needs no escaping.
env_get() { if [ -f .env ]; then sed -n "s/^$1=//p" .env | tail -1; fi; }
env_set() {
  [ -f "$STATE/env.orig" ] || { if [ -f .env ]; then cp -p .env "$STATE/env.orig"; else : > "$STATE/env.orig"; fi; }
  touch .env && chmod 600 .env
  if grep -q "^$1=" .env; then sed -i "s|^$1=.*|$1=$2|" .env; return; fi
  # A last line without a newline would swallow the new entry.
  if [ -s .env ] && [ -n "$(tail -c1 .env)" ]; then echo >> .env; fi
  echo "$1=$2" >> .env
}
env_unset() { if [ -f .env ]; then sed -i "/^$1=/d" .env; fi; }

wait_go_api() {
  for _ in $(seq 1 45); do
    case "$(curl -s -m 5 http://127.0.0.1:8095/health 2>/dev/null || true)" in *'"status":"ok"'*) return 0 ;; esac
    sleep 2
  done
  return 1
}
maps_running() { [ -n "$(dcs ps -q --status running maps-api 2>/dev/null || true)" ]; }
maps_livez() { dcs exec -T maps-api wget -qO- http://127.0.0.1:4000/livez >/dev/null 2>&1; }
maps_401s() {
  local m; m=$(dcs exec -T maps-api wget -qO- http://127.0.0.1:4000/internal/metrics 2>/dev/null || true)
  sed -n 's/^vaultchat_http_requests_total{method="POST",code="401"} \([0-9]*\)$/\1/p' <<<"$m" | head -1
}

# ── steps ──────────────────────────────────────────────────────────────
preflight() {
  say "preflight"
  grep -q '^  maps-api:' docker-compose.yml \
    || die "docker-compose.yml has no maps-api; ship this change with scripts/deploy.sh first"
  grep -q 'ACCESS_TOKEN_PRIVATE_KEY_FILE: \${ACCESS_TOKEN_PRIVATE_KEY_FILE:-}' docker-compose.prod.yml \
    || die "docker-compose.prod.yml is not this change's; ship it with scripts/deploy.sh first"
  grep -q '@maps path /nav/\*' caddy/Caddyfile \
    || die "caddy/Caddyfile has no @maps block; ship it with scripts/deploy.sh first"
  [ -n "$(dc ps -q --status running go-api)" ] || die "go-api is not running under project vaultchat"
  echo "go-api /build: $(curl -s -m 5 http://127.0.0.1:8095/build || echo unreachable)"
  [ "$(psql_q -c "SELECT 1 FROM pg_roles WHERE rolname = 'svc_maps'")" = 1 ] \
    || die "role svc_maps is missing: migration 139 is not applied (run scripts/deploy.sh without SKIP_MIGRATIONS)"
  dcs config -q || die "compose config does not validate"
  [ -n "$(dc ps -q --status running valhalla 2>/dev/null || true)" ] \
    || echo "note: valhalla is not running; /nav/route fails the same way on go-api and maps-api"
  command -v openssl >/dev/null || die "openssl is needed for the keys"
  echo "preflight OK"
}

keys() {
  preflight
  say "1/3 key pair"
  if [ ! -f "$KEY_DIR/access-token.key" ]; then
    mkdir -p "$KEY_DIR" "$PUB_DIR"
    ( umask 077; openssl genpkey -algorithm ed25519 -out "$KEY_DIR/access-token.key" )
    openssl pkey -in "$KEY_DIR/access-token.key" -pubout -out "$PUB_DIR/access-token.pub"
    # uid 1000 is the containers' `app` user (see docker-compose.prod.yml).
    chown -R 1000:1000 "$KEY_DIR" "$PUB_DIR"
    chmod 700 "$KEY_DIR"; chmod 600 "$KEY_DIR/access-token.key"
    chmod 755 "$PUB_DIR"; chmod 644 "$PUB_DIR/access-token.pub"
    echo "created $KEY_DIR/access-token.key and $PUB_DIR/access-token.pub"
    echo ">>> copy BOTH into the password manager now; the Utho move needs the same pair"
  else
    echo "$KEY_DIR/access-token.key exists; keeping it"
  fi

  say "2/3 settings in .env"
  if [ -z "$(env_get MAPS_INTERNAL_KEY)" ]; then
    local k cur; k=$(openssl rand -hex 32); cur=$(env_get INTERNAL_SERVICE_KEYS)
    env_set MAPS_INTERNAL_KEY "$k"
    env_set INTERNAL_SERVICE_KEYS "${cur:+$cur,}maps=$k"
  fi
  env_set ACCESS_TOKEN_PRIVATE_KEY_FILE "$KEY_IN_CONTAINER"
  echo "ACCESS_TOKEN_PRIVATE_KEY_FILE, MAPS_INTERNAL_KEY and INTERNAL_SERVICE_KEYS set"

  say "3/3 recreate go-api (phones reconnect once)"
  dc up -d --no-build --no-deps go-api
  wait_go_api || die "go-api is not healthy: run ./deploy/maps-split.sh keys-rollback"
  sleep 2
  # Captured first, not piped: under pipefail a `| grep -q` that stops reading
  # early can fail the pipeline with SIGPIPE even when it matched.
  local logs; logs=$(dc logs go-api --since 3m 2>&1 || true)
  grep -q 'access tokens: signing Ed25519' <<<"$logs" \
    || die "go-api did not log 'signing Ed25519': run ./deploy/maps-split.sh keys-rollback"
  date +%s > "$STATE/keys_at"
  cat <<'EOF'
go-api now signs Ed25519; HS256 tokens from before stay valid for 15 minutes.

Next: on a phone that was ALREADY logged in, open a chat and send a message.
In 15 minutes: ./deploy/maps-split.sh hs256-off
EOF
}

keys_rollback() {
  say "keys rollback: go-api back to HS256"
  # maps-api verifies EdDSA only; with core back on HS256 it would refuse everyone.
  if maps_running; then stop; fi
  env_unset ACCESS_TOKEN_PRIVATE_KEY_FILE
  env_unset ACCESS_TOKEN_HS256
  dc up -d --no-build --no-deps go-api
  wait_go_api && echo "go-api healthy on HS256; phones refresh their tokens once"
}

hs256_off() {
  [ -f "$STATE/keys_at" ] || die "run keys first"
  local age=$(( $(date +%s) - $(cat "$STATE/keys_at") ))
  [ "$age" -ge 900 ] || [ "${FORCE:-}" = 1 ] || die "only $((age / 60)) minutes since keys; wait until 15"
  say "close HS256"
  env_set ACCESS_TOKEN_HS256 off
  dc up -d --no-build --no-deps go-api
  wait_go_api || die "go-api is not healthy: remove ACCESS_TOKEN_HS256 from .env and run: dc up -d --no-build --no-deps go-api"
  if [ "$(dc exec -T go-api printenv ACCESS_TOKEN_HS256)" = off ]; then echo "HS256 closed"
  else die "go-api does not see ACCESS_TOKEN_HS256=off"; fi
}

start() {
  [ -f "$PUB_DIR/access-token.pub" ] || die "run keys first"
  [ "$(dc exec -T go-api printenv ACCESS_TOKEN_PRIVATE_KEY_FILE 2>/dev/null)" = "$KEY_IN_CONTAINER" ] \
    || die "go-api is not signing Ed25519 yet; run keys first"

  say "1/4 svc_maps login"
  if [ -z "$(env_get SVC_MAPS_DB_PASS)" ]; then
    local p; p=$(openssl rand -hex 24)
    # Through stdin, so the password is never on a command line.
    printf "ALTER ROLE svc_maps LOGIN PASSWORD '%s';\n" "$p" | psql_q
    env_set SVC_MAPS_DB_PASS "$p"
    echo "svc_maps can log in (password in .env as SVC_MAPS_DB_PASS)"
  else
    echo "SVC_MAPS_DB_PASS already set"
  fi

  say "2/4 same Valhalla as go-api"
  local v; v=$(dc exec -T go-api printenv VALHALLA_URL 2>/dev/null || true)
  if [ -n "$v" ]; then env_set VALHALLA_URL "$v"; echo "VALHALLA_URL=$v"; else echo "go-api uses the default http://valhalla:8002"; fi

  say "3/4 build and start maps-api"
  dcs build --pull maps-api
  dcs up -d --no-build --no-deps maps-api
  for _ in $(seq 1 30); do maps_livez && break; sleep 2; done
  maps_livez || die "maps-api does not answer /livez; see: docker logs vaultchat-maps-api-1"

  say "4/4 checks"
  local logs probe
  logs=$(dcs logs maps-api --since 3m 2>&1 || true)
  grep -E '\[boot\] (services|access tokens)' <<<"$logs" || true
  grep -q 'services: maps$' <<<"$logs" || die "maps-api did not log 'services: maps'; run ./deploy/maps-split.sh stop"
  # busybox wget exits non-zero on a 401, so capture instead of piping.
  probe=$(dc exec -T caddy wget -S -O /dev/null --post-data='{}' http://maps-api:4000/nav/route 2>&1 || true)
  grep -q ' 401' <<<"$probe" || die "maps-api did not answer /nav/route with 401; run ./deploy/maps-split.sh stop"
  echo "maps-api is up. Next: ./deploy/maps-split.sh route"
}

route() {
  maps_livez || die "maps-api is not up; run start first"
  say "1/3 validate and reload Caddy"
  dc exec -T caddy caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile >/dev/null \
    || die "Caddy rejects /etc/caddy/Caddyfile; nothing was reloaded"
  dc exec -T caddy caddy reload --config /etc/caddy/Caddyfile --adapter caddyfile
  local p; p=$(dc ps -q --status running prometheus 2>/dev/null || true)
  if [ -n "$p" ]; then docker kill -s HUP "$p" >/dev/null && echo "prometheus reloaded"; fi

  say "2/3 wait one health-check interval"
  sleep 6

  say "3/3 prove /nav/* reaches maps-api"
  local before after code
  before=$(maps_401s); before=${before:-0}
  code=$(curl -s -o /dev/null -w '%{http_code}' -X POST http://127.0.0.1:8095/nav/route)
  sleep 1
  after=$(maps_401s); after=${after:-0}
  echo "POST /nav/route through Caddy: $code; maps-api 401 count $before -> $after"
  [ "$code" = 401 ] || die "expected 401 through Caddy; run ./deploy/maps-split.sh stop"
  [ "$after" -gt "$before" ] || die "the request did not reach maps-api; run ./deploy/maps-split.sh stop and check: dc logs caddy"
  cat <<'EOF'

Routed: /nav/* goes to maps-api, and to go-api whenever maps-api is down.
On a phone: open the map, get a route and a road distance, search an address.
Undo at any time: ./deploy/maps-split.sh stop
EOF
}

stop() {
  say "stop maps-api (Caddy falls back to go-api within 5 s)"
  dcs stop maps-api
}

status() {
  say "status"
  echo "go-api /build: $(curl -s -m 5 http://127.0.0.1:8095/build || echo unreachable)"
  echo "go-api ACCESS_TOKEN_PRIVATE_KEY_FILE: $(dc exec -T go-api printenv ACCESS_TOKEN_PRIVATE_KEY_FILE 2>/dev/null || echo unset)"
  echo "go-api ACCESS_TOKEN_HS256: $(dc exec -T go-api printenv ACCESS_TOKEN_HS256 2>/dev/null || echo unset)"
  if maps_running && maps_livez; then echo "maps-api: up"; else echo "maps-api: down (Caddy serves /nav/* from go-api)"; fi
}

case "${1:-}" in
  preflight) preflight ;;
  keys) keys ;;
  keys-rollback) keys_rollback ;;
  hs256-off) hs256_off ;;
  start) start ;;
  route) route ;;
  stop) stop ;;
  status) status ;;
  *) sed -n '4,15p' "$0"; exit 2 ;;
esac
