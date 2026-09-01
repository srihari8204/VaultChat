#!/usr/bin/env bash
# sfu-load.sh — measure what the SFU actually carries, tier by tier.
#
# WHY THIS EXISTS
#
# 64 is a PRODUCT ceiling. It is enforced at the join (callMaxParticipants in
# internal/routes/call_sessions.go) and it has never been measured. Every
# decision downstream — whether audio can go to 128, what to promise users, how
# many boxes a region needs — is guesswork until someone runs this and reads the
# table it prints.
#
# WHAT IT IS NOT
#
# It does NOT write a load harness. livekit-cli already ships one, purpose-built
# and maintained by the people who wrote the SFU, and the image is already on the
# prod box (livekit/livekit-cli:latest). This is orchestration: run the tiers,
# sample the server while they run, print a table.
#
# WHAT IT MODELS, AND WHAT IT DOES NOT
#
#   IT DOES model server-side cost: publisher upstream, SFU forwarding, and
#   subscriber fan-out, at a chosen participant count.
#
#   IT DOES NOT model our client's visible set. livekit-cli subscribers take
#   EVERY track; our app subscribes video for one page (~9 tiles) plus audio for
#   everyone (lib/call/visibleSet.ts). So subscriber-side numbers here are an
#   UPPER BOUND — pessimistic on the client, honest on the server. Device
#   measurement is a separate task and cannot be faked from here.
#
# Usage:
#   LIVEKIT_URL=ws://127.0.0.1:7880 \
#   LIVEKIT_API_KEY=... LIVEKIT_API_SECRET=... \
#   ./sfu-load.sh 8 16 32 48 64
#
# Defaults to the tiers in the change's task 5.4 when none are given.
set -uo pipefail

TIERS=("$@"); [ ${#TIERS[@]} -eq 0 ] && TIERS=(8 16 32 48 64)
DURATION="${DURATION:-45s}"
COOLOFF="${COOLOFF:-20}"
ROOM_PREFIX="${ROOM_PREFIX:-loadtest}"
CONTAINER="${LIVEKIT_CONTAINER:-vaultchat-livekit-1}"
IMAGE="${CLI_IMAGE:-livekit/livekit-cli:latest}"
# 3x3 matches the app's 9-tile page (PAGE in app/group-call-active.tsx), and
# --simulate-speakers exercises the active-speaker promotion the grid relies on.
LAYOUT="${LAYOUT:-3x3}"

: "${LIVEKIT_URL:?set LIVEKIT_URL}"
: "${LIVEKIT_API_KEY:?set LIVEKIT_API_KEY}"
: "${LIVEKIT_API_SECRET:?set LIVEKIT_API_SECRET}"

# ── PROD GUARD ────────────────────────────────────────────────────────
#
# 64 synthetic publishers against the live SFU is indistinguishable from an
# attack, and it competes for CPU with real calls. This must be a deliberate,
# typed decision, never a default and never an accident of a copied env var.
# Loopback 7880/7890 count as PRODUCTION when run ON the prod box: those ports
# are bound by vaultchat-livekit-1 and vaultchat-golive-livekit-1. A smoke test
# of this very script proved the hazard — a dev SFU failed to bind (port already
# taken under --network host), died, and the load generator silently connected to
# the LIVE SFU instead. Only a credential mismatch stopped it. Never assume
# "localhost" means "not prod".
if echo "$LIVEKIT_URL" | grep -qiE "corefinite\.com|65\.21\.229\.167|(127\.0\.0\.1|localhost|0\.0\.0\.0):(7880|7890)"; then
  if [ "${ALLOW_PROD:-no}" != "yes-i-accept-the-risk" ]; then
    cat >&2 <<'WARN'
REFUSING: LIVEKIT_URL points at PRODUCTION.

A 64-participant run competes with live calls for CPU and uplink on the same
box that serves them. Run it against a bench/staging SFU, or during a window
you have chosen deliberately with:

    ALLOW_PROD=yes-i-accept-the-risk ./sfu-load.sh 8 16

Start small. Check `SELECT count(*) FROM calls WHERE ended_at IS NULL` first.
WARN
    exit 2
  fi
  echo "!! RUNNING AGAINST PRODUCTION — acknowledged via ALLOW_PROD" >&2
fi

# ── PREFLIGHT: prove we can actually reach and authenticate to the target ──
#
# Without this the run "completes" against the wrong server, or against no
# server, and prints a table of zeros that looks like a result. The smoke test
# produced exactly that: every tester refused with `invalid API key`, and the
# report still said MARGINAL.
PRE=$(docker run --rm --network host   -e LIVEKIT_URL="$LIVEKIT_URL" -e LIVEKIT_API_KEY="$LIVEKIT_API_KEY"   -e LIVEKIT_API_SECRET="$LIVEKIT_API_SECRET" "$IMAGE"   load-test --room "preflight-$$" --duration 3s --video-publishers 1 --yes 2>&1)
if echo "$PRE" | grep -qiE "unauthorized|invalid API key|could not connect|connection refused|no such host"; then
  echo "PREFLIGHT FAILED — not running tiers. The target rejected us:" >&2
  echo "$PRE" | grep -iE "unauthorized|invalid API key|could not connect|refused|no such host" | head -3 | sed 's/^/  /' >&2
  echo "  url=$LIVEKIT_URL key=$LIVEKIT_API_KEY" >&2
  exit 3
fi
echo "preflight ok — target reachable and credentials accepted"

have_container=0
docker inspect "$CONTAINER" >/dev/null 2>&1 && have_container=1
[ $have_container -eq 0 ] && echo "note: container '$CONTAINER' not found — server metrics will be blank" >&2

ts=$(date +%Y%m%d-%H%M%S)
OUT="${OUT:-sfu-load-$ts.md}"
{
  echo "# SFU capacity — measured $(date -u '+%Y-%m-%d %H:%MZ')"
  echo
  echo "url=\`$LIVEKIT_URL\` duration=$DURATION layout=$LAYOUT container=\`$CONTAINER\`"
  echo
  echo "| Participants | CPU % (peak) | RAM | Net in | Net out | CLI errors | Result |"
  echo "|---:|---:|---:|---:|---:|---:|---|"
} > "$OUT"

sample_server() {   # $1 = seconds; prints "peakcpu|mem|rxMB|txMB"
  local n=$1 peak=0 mem="-" line cpu
  # NETWORK COMES FROM THE LOOPBACK COUNTERS, NOT docker stats.
  #
  # A --network host container shares the host namespace, so `docker stats`
  # reports 0B/0B for it — the first run of this script produced exactly that
  # and the table looked like no media had flowed at all. All bench traffic is
  # 127.0.0.1, so /proc/net/dev's `lo` delta is the honest measure. On a busy
  # host it would include other loopback traffic; here the alternative was a
  # column of zeros.
  local rx0 tx0 rx1 tx1
  rx0=$(awk '/lo:/{print $2}' /proc/net/dev); tx0=$(awk '/lo:/{print $10}' /proc/net/dev)
  for _ in $(seq 1 "$n"); do
    if [ $have_container -eq 1 ]; then
      line=$(docker stats --no-stream --format '{{.CPUPerc}}|{{.MemUsage}}' "$CONTAINER" 2>/dev/null)
      cpu=$(echo "$line" | cut -d'|' -f1 | tr -d '%' | cut -d. -f1)
      [ -n "${cpu:-}" ] && [ "$cpu" -gt "$peak" ] 2>/dev/null && peak=$cpu
      mem=$(echo "$line" | cut -d'|' -f2 | cut -d/ -f1 | tr -d ' ')
    else sleep 1; fi
  done
  rx1=$(awk '/lo:/{print $2}' /proc/net/dev); tx1=$(awk '/lo:/{print $10}' /proc/net/dev)
  echo "$peak|$mem|$(( (rx1-rx0)/1048576 ))MB|$(( (tx1-tx0)/1048576 ))MB"
}

for N in "${TIERS[@]}"; do
  ROOM="$ROOM_PREFIX-$N-$ts"
  echo
  echo "── tier $N (room $ROOM) ────────────────────────────────"
  LOG=$(mktemp)

  docker run --rm --network host \
    -e LIVEKIT_URL="$LIVEKIT_URL" \
    -e LIVEKIT_API_KEY="$LIVEKIT_API_KEY" \
    -e LIVEKIT_API_SECRET="$LIVEKIT_API_SECRET" \
    "$IMAGE" load-test \
      --room "$ROOM" \
      --duration "$DURATION" \
      --video-publishers "$N" \
      --audio-publishers "$N" \
      --layout "$LAYOUT" \
      --simulate-speakers \
      --num-per-second 4 \
      --yes > "$LOG" 2>&1 &
  CLI_PID=$!

  # Let every tester connect before sampling: --num-per-second 4 means the
  # ramp itself takes N/4 seconds, and sampling through the ramp would report
  # a peak that belongs to connection setup rather than to steady state.
  #
  # DURATION MUST OUTLAST ramp + sample, or the window slides off the end of the
  # run and measures TEARDOWN. That is not hypothetical: tier 128 at DURATION=45s
  # reported 55% CPU — LOWER than tier 96 — and re-running it at 120s gave 87%.
  # A tier that reads cheaper than a smaller tier is the signature of this bug.
  RAMP=$(( N / 4 + 6 ))
  DUR_S=$(echo "$DURATION" | tr -dc '0-9')
  if [ "${DUR_S:-0}" -lt $(( RAMP + 25 )) ]; then
    echo "  !! DURATION=$DURATION is too short for tier $N (needs >= $(( RAMP + 25 ))s)." >&2
    echo "  !! The sample would land in teardown and UNDER-report. Skipping." >&2
    echo "| $N | - | - | - | - | - | SKIPPED (duration too short) |" >> "$OUT"
    rm -f "$LOG"; continue
  fi
  sleep "$RAMP"
  STATS=$(sample_server 20)
  wait $CLI_PID; RC=$?

  # ONE value, and patterns that match how this CLI actually reports failure.
  # "could not connect" contains none of error/failed/timeout, so the original
  # pattern scored a total connection failure as zero errors.
  ERRS=$(grep -ciE "error|failed|timeout|could not connect|unauthorized|refused" "$LOG" 2>/dev/null | head -1)
  ERRS=${ERRS:-0}
  PEAK=$(echo "$STATS" | cut -d'|' -f1); MEM=$(echo "$STATS" | cut -d'|' -f2)
  NIN=$(echo  "$STATS" | cut -d'|' -f3); NOUT=$(echo "$STATS" | cut -d'|' -f4)

  # PASS is deliberately conservative: the CLI exited clean, it logged no
  # errors, and the SFU stayed under 80% CPU. A tier that only just fits is
  # not a tier you should ship a product limit on.
  if [ "$RC" -eq 0 ] && [ "${ERRS:-0}" -eq 0 ] && [ "${PEAK:-0}" -lt 80 ]; then
    RESULT="PASS"
  elif [ "$RC" -ne 0 ] || [ "${ERRS:-0}" -gt 0 ]; then
    RESULT="**FAIL** (rc=$RC errors=$ERRS)"
  else
    RESULT="MARGINAL (cpu ${PEAK}%)"
  fi

  echo "| $N | ${PEAK:-?} | ${MEM:-?} | ${NIN:-?} | ${NOUT:-?} | ${ERRS:-?} | $RESULT |" >> "$OUT"
  echo "  cpu=${PEAK}%  mem=$MEM  net=$NIN/$NOUT  errors=$ERRS  -> $RESULT"
  tail -3 "$LOG" | sed 's/^/    /'
  rm -f "$LOG"

  # Let the SFU settle before the next tier, or tier N+1 inherits N's heat and
  # the table reads as a cliff that is really just accumulated load.
  [ "$N" != "${TIERS[-1]}" ] && { echo "  cooling ${COOLOFF}s"; sleep "$COOLOFF"; }
done

{
  echo
  echo "## Reading this"
  echo
  echo "- PASS = clean exit, no CLI errors, SFU peak CPU < 80%."
  echo "- Subscriber cost here is an UPPER BOUND: livekit-cli subscribes to every"
  echo "  track, our client subscribes one page of video plus all audio."
  echo "- The recommended participant limit is the highest PASS tier, not the"
  echo "  highest tier that merely completed."
} >> "$OUT"

echo
echo "report: $OUT"
cat "$OUT"
