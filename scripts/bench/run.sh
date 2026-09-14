#!/usr/bin/env bash
#
# scripts/bench/run.sh — the ONE command that produces the §19 performance
# baseline. There is no baseline today; running this is how the first one
# comes into existence.
#
#   bash scripts/bench/run.sh
#
# It refuses to produce a number it cannot stand behind. Every precondition
# below is checked, and a failure stops the run rather than degrading it,
# because a wrong performance number does not stay in the terminal — it gets
# quoted in a capacity decision six months later by someone who was not here.
#
# ─────────────────────────────────────────────────────────────────────────
# WHAT IS MEASURED, AND BY WHAT
# ─────────────────────────────────────────────────────────────────────────
#   1. send→delivered latency      loadtest/fanout.js   (existing)
#   2. connect + handshake         scripts/bench/sockets-bench.js connect
#      reconnect storm             scripts/bench/sockets-bench.js storm
#   3. fan-out cost, 50-member     loadtest/fanout.js   (existing)
#   4. memory / connection ceiling scripts/bench/sockets-bench.js ceiling
#   +  HTTP floor (/health,/chats) loadtest/http.js     (existing)
#
# vaultchat-backend/loadtest/ was written for the Node backend but every tool
# there takes --base, so they are pointed at Go rather than reimplemented.
# Only the three things they genuinely do not measure are new code.
#
# ─────────────────────────────────────────────────────────────────────────
# THE SHAPE PROBLEM — read this before trusting any output
# ─────────────────────────────────────────────────────────────────────────
# docker-compose.bench.yml exists to force the api into PROD shape. It was
# written in the Node era and overrides the `api` service (REDIS_ADAPTER=0,
# EVENT_BUS=""). Today `api` is profile-gated LEGACY and serves nothing: Go
# owns every route and every socket. The override is still included — it also
# sets go-api's ADMIN_KEY — but it does NOT by itself put go-api in prod shape.
#
# Production's go-api shape, per docs/SECOND_REPLICA_READINESS.md ("REDIS_ADAPTER
# is on in production — confirmed") and docs/ENV_INVENTORY.md, is:
#     REDIS_ADAPTER=1, no EVENT_BUS, ONE replica, no Kafka, no legacy Node.
# That is compose's default for go-api, so the default stack is already the
# right shape — but this script ASSERTS it rather than assuming it, and records
# what it found in the result file. A latency number whose shape is unrecorded
# is an anecdote.
#
# ─────────────────────────────────────────────────────────────────────────
# PRECONDITIONS (all enforced)
# ─────────────────────────────────────────────────────────────────────────
#   * docker + docker compose, stack up from THIS repo
#   * go-api healthy; go-api's own port reachable for /internal/metrics
#   * JWT_SECRET identical to the one go-api is running with
#   * node >= 18 (fetch), repo-root node_modules present (socket.io-client)
#   * vaultchat-backend/node_modules present (pg + jsonwebtoken, for seeding)
#   * exactly ONE go-api container; no legacy Node api; no fanout-worker
#   * the send rate limiter (60 msg / 10 s per user) not tripped — the sender
#     count is derived from the rate so it cannot be, and any send error at all
#     fails the run
#
# ─────────────────────────────────────────────────────────────────────────
# KNOBS (all optional)
# ─────────────────────────────────────────────────────────────────────────
#   BENCH_BASE=http://127.0.0.1:18080   through Caddy — the prod path
#   BENCH_DIRECT=http://127.0.0.1:14000 go-api direct (metrics; proxy isolation)
#   BENCH_USERS=5000  BENCH_MEMBERS=50
#   BENCH_RATES=10,25,50  BENCH_STAGE_SECS=30  BENCH_WARMUP_SECS=15
#   BENCH_CONNECT_SAMPLES=200  BENCH_STORM_CLIENTS=500
#   BENCH_CEILING_STEPS=250,500,1000,2500,5000
#   BENCH_SKIP_SEED=1                   reuse an existing loadtest/bench-state.json
#   BENCH_ONLY=latency|connect|storm|ceiling|http   run one phase
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"

BASE="${BENCH_BASE:-http://127.0.0.1:18080}"
DIRECT="${BENCH_DIRECT:-http://127.0.0.1:14000}"
USERS="${BENCH_USERS:-5000}"
MEMBERS="${BENCH_MEMBERS:-50}"
RATES="${BENCH_RATES:-10,25,50}"
STAGE_SECS="${BENCH_STAGE_SECS:-30}"
WARMUP_SECS="${BENCH_WARMUP_SECS:-15}"
CONNECT_SAMPLES="${BENCH_CONNECT_SAMPLES:-200}"
STORM_CLIENTS="${BENCH_STORM_CLIENTS:-500}"
CEILING_STEPS="${BENCH_CEILING_STEPS:-250,500,1000,2500,5000}"
ONLY="${BENCH_ONLY:-}"

STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
OUT="$ROOT/scripts/bench/results/$STAMP"
mkdir -p "$OUT"

fail() { printf '\n\033[1;31mBENCH ABORTED\033[0m — %s\n\n' "$1" >&2
         printf 'No number was produced. That is deliberate: a measurement from a\n' >&2
         printf 'broken setup is worse than no measurement, because it gets quoted.\n\n' >&2
         exit 2; }
step() { printf '\n\033[1;36m── %s\033[0m\n' "$1"; }
note() { printf '   %s\n' "$1"; }

want() { [ -z "$ONLY" ] || [ "$ONLY" = "$1" ]; }

# ═══════════════════════════════════════════════════════════════════════
step "preconditions"
# ═══════════════════════════════════════════════════════════════════════
command -v docker >/dev/null 2>&1 || fail "docker not on PATH"
docker compose version >/dev/null 2>&1 || fail "\`docker compose\` (v2) not available"
command -v node    >/dev/null 2>&1 || fail "node not on PATH"
command -v curl    >/dev/null 2>&1 || fail "curl not on PATH"

NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
[ "$NODE_MAJOR" -ge 18 ] || fail "node $NODE_MAJOR is too old; the bench tools use global fetch (node >= 18)"

[ -d "$ROOT/node_modules/socket.io-client" ] || \
  fail "repo-root node_modules/socket.io-client missing. socket.io-client is ALREADY a
  dependency of this repo — run \`npm ci\` at the root. Do not add a dependency for the bench."

for m in pg jsonwebtoken; do
  node -e "require.resolve('$m',{paths:['$ROOT/vaultchat-backend']})" >/dev/null 2>&1 || \
    fail "vaultchat-backend/node_modules/$m missing — loadtest/seed.js needs it to seed and
  mint tokens. Run \`npm ci\` inside vaultchat-backend/. (Set BENCH_SKIP_SEED=1 to reuse an
  existing loadtest/bench-state.json instead.)"
done

[ -n "${JWT_SECRET:-}" ] || fail "JWT_SECRET is unset. It must be byte-identical to the secret
  go-api is running with, or every socket handshake is rejected and the run reads as a
  capacity failure. Read it from the container:
    docker compose exec -T go-api sh -lc 'echo \$JWT_SECRET'"

node scripts/bench/sockets-bench.js --selftest >/dev/null || fail "sockets-bench selftest failed"
note "node $(node -p 'process.versions.node'), docker $(docker --version | awk '{print $3}' | tr -d ,)"

# ═══════════════════════════════════════════════════════════════════════
step "stack shape (this is the half of a baseline people forget to record)"
# ═══════════════════════════════════════════════════════════════════════
DC=(docker compose -f docker-compose.yml -f docker-compose.bench.yml)

RUNNING="$("${DC[@]}" ps --services --filter status=running 2>/dev/null || true)"
[ -n "$RUNNING" ] || fail "no services running for this compose project. Bring the stack up first:
    docker compose -f docker-compose.yml -f docker-compose.bench.yml up -d --build go-api caddy"

echo "$RUNNING" | grep -qx go-api || fail "go-api is not running — it serves every route and every socket"

for legacy in api fanout-worker kafka; do
  if echo "$RUNNING" | grep -qx "$legacy"; then
    fail "the LEGACY service '$legacy' is running. Production does not run it (Go owns the
  client surface, in-process fan-out, no Kafka). Measuring alongside it measures a shape
  that does not exist. Stop it:  ${DC[*]} stop $legacy"
  fi
done

GO_API_REPLICAS="$("${DC[@]}" ps -q go-api | grep -c . || true)"
[ "$GO_API_REPLICAS" = "1" ] || fail "found $GO_API_REPLICAS go-api containers; production runs ONE.
  Fan-out cost and the socket ceiling are both per-process numbers."

shape_env() { "${DC[@]}" exec -T go-api sh -lc "printenv $1 2>/dev/null || true" | tr -d '\r\n'; }
REDIS_ADAPTER_ACTUAL="$(shape_env REDIS_ADAPTER)"
EVENT_BUS_ACTUAL="$(shape_env EVENT_BUS)"
: "${REDIS_ADAPTER_ACTUAL:=<unset>}"

# Production is REDIS_ADAPTER=1 (docs/SECOND_REPLICA_READINESS.md, confirmed on
# the box; docs/ENV_INVENTORY.md lists prod=1). Anything else is a different
# delivery path and the numbers do not transfer.
if [ "$REDIS_ADAPTER_ACTUAL" != "1" ] && [ "${BENCH_ALLOW_SHAPE_DRIFT:-0}" != "1" ]; then
  fail "go-api has REDIS_ADAPTER=$REDIS_ADAPTER_ACTUAL but production runs 1
  (docs/SECOND_REPLICA_READINESS.md: 'REDIS_ADAPTER is on in production — confirmed').
  With the adapter off, room emits never touch Redis and delivery latency is measured on a
  code path production does not use. Set BENCH_ALLOW_SHAPE_DRIFT=1 only if you are
  deliberately measuring the rollback shape, and say so next to the number."
fi
if [ -n "$EVENT_BUS_ACTUAL" ] && [ "${BENCH_ALLOW_SHAPE_DRIFT:-0}" != "1" ]; then
  fail "go-api has EVENT_BUS=$EVENT_BUS_ACTUAL; production leaves it empty (in-process fan-out)."
fi
note "REDIS_ADAPTER=$REDIS_ADAPTER_ACTUAL  EVENT_BUS='${EVENT_BUS_ACTUAL}'  go-api replicas=$GO_API_REPLICAS"

curl -fsS --max-time 10 "$BASE/health"   >/dev/null || fail "$BASE/health did not answer (proxy entry)"
curl -fsS --max-time 10 "$DIRECT/health" >/dev/null || fail "$DIRECT/health did not answer (go-api direct;
  compose maps 14000:4000). It is needed for /internal/metrics, which Caddy 404s on purpose."
curl -fsS --max-time 10 "$DIRECT/internal/metrics" | grep -q vaultchat_sockets_local || \
  fail "$DIRECT/internal/metrics carried no vaultchat_sockets_local — wrong process, or a build
  without metrics.Handler. The ceiling phase has no server-side numbers without it."

# ── the environment, recorded with the numbers ─────────────────────────
"${DC[@]}" ps --format json > "$OUT/compose-ps.json" 2>/dev/null || true
docker version --format '{{json .}}'   > "$OUT/docker-version.json" 2>/dev/null || true
docker info   --format '{{json .}}'    > "$OUT/docker-info.json"    2>/dev/null || true
"${DC[@]}" images go-api               > "$OUT/go-api-image.txt"    2>/dev/null || true
{
  echo "host=$(uname -a 2>/dev/null || echo unknown)"
  echo "date_utc=$(date -u +%FT%TZ)"
  echo "base=$BASE"
  echo "direct=$DIRECT"
  echo "redis_adapter=$REDIS_ADAPTER_ACTUAL"
  echo "event_bus=$EVENT_BUS_ACTUAL"
  echo "go_api_replicas=$GO_API_REPLICAS"
  echo "node=$(node -p 'process.versions.node')"
  echo "git_rev=$(git -C "$ROOT" rev-parse HEAD 2>/dev/null || echo 'not-a-git-checkout')"
  echo "git_dirty=$(git -C "$ROOT" status --porcelain 2>/dev/null | wc -l | tr -d ' ')"
} > "$OUT/environment.txt"
note "environment recorded → $OUT/environment.txt"

# ═══════════════════════════════════════════════════════════════════════
step "seed"
# ═══════════════════════════════════════════════════════════════════════
STATE="$ROOT/vaultchat-backend/loadtest/bench-state.json"
if [ "${BENCH_SKIP_SEED:-0}" = "1" ]; then
  [ -f "$STATE" ] || fail "BENCH_SKIP_SEED=1 but $STATE does not exist"
  note "skipped (reusing $STATE)"
else
  ( cd "$ROOT/vaultchat-backend" \
    && DB_HOST="${DB_HOST:-127.0.0.1}" DB_PORT="${DB_PORT:-15432}" \
       DB_NAME="${DB_NAME:-vaultchat}" DB_USER="${DB_USER:-vaultchat}" \
       DB_PASS="${DB_PASS:-vaultchat_dev}" JWT_SECRET="$JWT_SECRET" \
       node loadtest/seed.js --users "$USERS" --group-members "$MEMBERS" ) \
    || fail "seeding failed. The bench database must be migrated first:
    cd vaultchat-backend && DB_HOST=127.0.0.1 DB_PORT=15432 node migrate.js up"
fi
[ -f "$STATE" ] || fail "seed produced no $STATE"

# One authed HTTP call with a minted token. If JWT_SECRET is wrong this is where
# it is caught — cheaply, and with an unambiguous message — instead of surfacing
# later as "the server cannot hold sockets".
TOKEN="$(node -p "require('$STATE').users[0].jwt")"
CODE="$(curl -s -o /dev/null -w '%{http_code}' --max-time 15 -H "Authorization: Bearer $TOKEN" "$BASE/chats")"
[ "$CODE" = "200" ] || fail "GET /chats with a freshly minted bench token returned HTTP $CODE.
  401 means JWT_SECRET here differs from go-api's. Compare:
    docker compose exec -T go-api sh -lc 'echo \$JWT_SECRET'"
note "token accepted by $BASE (HTTP 200)"

# ═══════════════════════════════════════════════════════════════════════
# Phase 1 + 3 — send→delivered latency and fan-out cost.
#
# SENDER COUNT IS DERIVED, NOT CHOSEN. chats_helpers.go rate-limits sends to 60
# per 10 s per user. At R msg/s across S senders each sender does 10R/S per
# window, so S must exceed R/6. Under-provisioning senders turns the limiter on
# and the run silently measures 429s instead of delivery. Doubled for margin,
# and capped at the group size because fanout.js draws senders from members.
# ═══════════════════════════════════════════════════════════════════════
MAX_RATE="$(echo "$RATES" | tr ',' '\n' | sort -n | tail -1)"
SENDERS="$(( (MAX_RATE + 5) / 6 * 2 ))"
# `[ ... ] && x=y` would exit the whole script under `set -e` when the test is
# false. if/fi, deliberately.
if [ "$SENDERS" -lt 2 ]; then SENDERS=2; fi
if [ "$SENDERS" -gt "$MEMBERS" ]; then SENDERS="$MEMBERS"; fi

if want latency || want fanout; then
  step "warmup (DISCARDED — JIT, pools, membership cache, Redis adapter subscriptions)"
  ( cd "$ROOT/vaultchat-backend" && node loadtest/fanout.js --base "$BASE" \
      --members "$MEMBERS" --senders "$SENDERS" --rates "$(echo "$RATES" | cut -d, -f1)" \
      --stage-secs "$WARMUP_SECS" ) > "$OUT/warmup-discarded.log" 2>&1 \
    || fail "warmup run failed — see $OUT/warmup-discarded.log"
  note "warmup output kept for inspection only, excluded from every statistic"

  step "send→delivered latency + fan-out (${MEMBERS}-member group, rates ${RATES}, ${SENDERS} senders)"
  ( cd "$ROOT/vaultchat-backend" && node loadtest/fanout.js --base "$BASE" \
      --members "$MEMBERS" --senders "$SENDERS" --rates "$RATES" \
      --stage-secs "$STAGE_SECS" ) 2>&1 | tee "$OUT/fanout.log"
  # fanout.js writes into its own directory; copy it out so the result set is
  # self-contained (and so a later run of that tool cannot rewrite our history).
  cp "$ROOT/vaultchat-backend/loadtest/fanout-results.json" "$OUT/fanout.json" \
    || fail "fanout.js produced no results file"

  node -e '
    const r = require(process.argv[1]);
    const bad = r.results.filter(s => s.sendErrors > 0);
    if (bad.length) {
      console.error("\nSEND ERRORS in stage(s) " + bad.map(s=>s.rate).join(", ") +
        " — almost certainly HTTP 429 from the per-user send limiter (60/10s).");
      console.error("Delivery percentiles computed across rejected sends are not a baseline.");
      console.error("Raise the sender count (BENCH_MEMBERS) or lower BENCH_RATES, then re-run.");
      process.exit(1);
    }
    const lossy = r.results.filter(s => s.deliveryRatio < 0.999);
    if (lossy.length) {
      console.error("\nINCOMPLETE DELIVERY at rate(s) " + lossy.map(s=>`${s.rate} (${(s.deliveryRatio*100).toFixed(2)}%)`).join(", "));
      console.error("That is a real finding, not a setup problem — but a latency percentile");
      console.error("over only the messages that ARRIVED flatters the tail. Record both.");
    }
  ' "$OUT/fanout.json" || fail "fan-out run is not usable as a baseline (see above)"
fi

# ═══════════════════════════════════════════════════════════════════════
if want connect; then
  step "socket connect + handshake (${CONNECT_SAMPLES} samples, sequential)"
  node scripts/bench/sockets-bench.js connect --base "$BASE" \
    --samples "$CONNECT_SAMPLES" --warmup 20 --out "$OUT/connect.json" | tee "$OUT/connect.log"
fi

if want storm; then
  step "reconnect storm (${STORM_CLIENTS} clients at once — the deploy case)"
  node scripts/bench/sockets-bench.js storm --base "$BASE" \
    --clients "$STORM_CLIENTS" --rounds 3 --warmup-rounds 1 \
    --out "$OUT/storm.json" | tee "$OUT/storm.log"
fi

if want ceiling; then
  step "memory + connection ceiling (steps ${CEILING_STEPS})"
  node scripts/bench/sockets-bench.js ceiling --base "$BASE" --metrics "$DIRECT/internal/metrics" \
    --steps "$CEILING_STEPS" --out "$OUT/ceiling.json" | tee "$OUT/ceiling.log"
fi

if want http; then
  step "HTTP floor (/health @200 VUs, /chats @100 VUs)"
  ( cd "$ROOT/vaultchat-backend" && node loadtest/http.js --base "$BASE" --vus 200 --duration 60 --mode health ) \
    2>&1 | tee "$OUT/http-health.log"
  ( cd "$ROOT/vaultchat-backend" && node loadtest/http.js --base "$BASE" --vus 100 --duration 60 --mode chats ) \
    2>&1 | tee "$OUT/http-chats.log"
fi

# ═══════════════════════════════════════════════════════════════════════
step "result"
# ═══════════════════════════════════════════════════════════════════════
node -e '
  const fs = require("fs"), path = require("path");
  const dir = process.argv[1];
  const read = (f) => { try { return JSON.parse(fs.readFileSync(path.join(dir, f), "utf8")); } catch { return null; } };
  const env = Object.fromEntries(fs.readFileSync(path.join(dir, "environment.txt"), "utf8")
    .trim().split("\n").map((l) => { const i = l.indexOf("="); return [l.slice(0, i), l.slice(i + 1)]; }));
  const out = {
    schema: "vaultchat-perf-baseline/1",
    // Everything needed to decide whether a later run is comparable to this one.
    environment: env,
    phases: { fanout: read("fanout.json"), connect: read("connect.json"),
              storm: read("storm.json"), ceiling: read("ceiling.json") },
  };
  const p = path.join(dir, "result.json");
  fs.writeFileSync(p, JSON.stringify(out, null, 2));

  const f = out.phases.fanout, c = out.phases.connect, s = out.phases.storm, k = out.phases.ceiling;
  const L = [];
  L.push("");
  L.push("  environment : " + env.host);
  L.push("  shape       : REDIS_ADAPTER=" + env.redis_adapter + "  EVENT_BUS=\"" + (env.event_bus||"") +
         "\"  replicas=" + env.go_api_replicas + "  via " + env.base);
  L.push("  revision    : " + env.git_rev + (env.git_dirty !== "0" ? "  (DIRTY — " + env.git_dirty + " files)" : ""));
  L.push("");
  if (f) for (const st of f.results)
    L.push(`  send→delivered @${st.rate}/s  p50 ${st.p50}ms  p95 ${st.p95}ms  p99 ${st.p99}ms  max ${st.max}ms  (n=${st.deliveries}, ${(st.deliveryRatio*100).toFixed(2)}% delivered, ${st.deliveriesPerSec}/s)`);
  if (c) { const h = c.handshakeMs;
    L.push(`  handshake            p50 ${h.p50}ms  p95 ${h.p95}ms  p99 ${h.p99}ms  max ${h.max}ms  (n=${h.n})`); }
  if (s) for (const r of s.rounds_)
    L.push(`  storm ${r.clients} clients     p50 ${r.handshakeMs.p50}ms  p95 ${r.handshakeMs.p95}ms  p99 ${r.handshakeMs.p99}ms  all-back-in ${r.wallMsToAllConnected}ms  (${r.failed} failed, n=${r.handshakeMs.n})`);
  if (k) { for (const r of k.table)
    L.push(`  ceiling ${String(r.heldSockets).padStart(5)} sockets  heap ${(r.server.heapAllocBytes/1048576).toFixed(1)}MiB  ${r.heapBytesPerSocket}B/socket  goroutines ${r.server.goroutines}  handshake p95 ${r.handshakeMsDuringRamp.p95}ms  (${r.connectFailures} failed)`);
    L.push("  ceiling stopped: " + k.stoppedBecause); }
  L.push("");
  L.push("  machine-readable : " + p);
  L.push("");
  L.push("  Record this run in docs/PERF_BASELINE.md WITH the environment line above.");
  L.push("  A latency number without its host, shape and revision is an anecdote.");
  console.log(L.join("\n"));
  fs.writeFileSync(path.join(dir, "summary.txt"), L.join("\n") + "\n");
' "$OUT"
