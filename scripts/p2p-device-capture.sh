#!/usr/bin/env bash
# p2p-device-capture.sh — collect device + server logs while a HUMAN drives the
# P2P test matrix on two phones.
#
# This script observes. It never taps, never installs, never changes a network,
# and never touches production configuration. Installing an APK re-arms the
# Redmi's MIUI INJECT_EVENTS restriction, so nothing here may install anything.
#
#   scripts/p2p-device-capture.sh start     begin capture (safe to leave running)
#   scripts/p2p-device-capture.sh mark ID   stamp a test boundary into every log
#   scripts/p2p-device-capture.sh snap ID   record server/DB/R2 state right now
#   scripts/p2p-device-capture.sh stop      end capture and summarise
#
# WHY TAG-FILTERED AND NOT `adb logcat` RAW
# An unfiltered logcat on these handsets writes ~100 MB in ten minutes (almost
# all MediaTek camera spam) and the USB stream then dies with exit 255, taking
# the capture with it. So the "raw" stream is the full output of the tags that
# can carry VaultBeam evidence, and the "filtered" stream is the keyword subset.
set -u

ADB=/c/Users/Dell/AppData/Local/Android/Sdk/platform-tools/adb.exe
HONOR=AWJDVB4702008616
REDMI=w4eygyinypswrcz9
PROD=srihari@65.21.229.167

ROOT="$(cd "$(dirname "$0")/.." && pwd)/p2p-device-tests"
LATEST="$ROOT/latest"

# Tags that can carry evidence. ReactNativeJS carries the app's own
# [vb]/[vaultbeam]/[call] lines AND livekit-client's ICE trace (setLogLevel
# debug), which is where candidate-pair evidence appears.
TAGS="ReactNativeJS:V AndroidRuntime:E libwebrtc:V WebRTC:V VaultBeam:V ExpoModulesCore:W"

KEYWORDS='VaultBeam|vaultbeam|\[vb\]|P2P|p2p|transport|WEBRTC_DIRECT|WEBRTC_TURN|R2_RELAY|LAN|lan |ICE|ice |candidate|connection|transfer|chunk|bitmap|resume|digest|sha256|SHA-256|relay|upload|download|abort|complete|retry|error|failure|fail'

case "${1:-}" in
start)
  TS="$(date +%Y%m%d-%H%M%S)"
  DIR="$ROOT/$TS"
  mkdir -p "$DIR"
  rm -f "$LATEST"; ln -s "$DIR" "$LATEST" 2>/dev/null || echo "$DIR" > "$ROOT/latest.txt"
  echo "$DIR" > "$ROOT/.current"

  # Device parity is a precondition, not a nicety: two different builds produce
  # two different truths and the whole matrix becomes meaningless.
  APK="$(cd "$(dirname "$0")/.." && pwd)/android/app/build/outputs/apk/release/app-release.apk"
  L=$(md5sum "$APK" | cut -d' ' -f1)
  {
    echo "capture_started      $(date -u +%Y-%m-%dT%H:%M:%SZ)"
    echo "git_commit           $(git -C "$(dirname "$0")/.." rev-parse --short HEAD 2>/dev/null)"
    echo "apk_sha256           $(sha256sum "$APK" | cut -d' ' -f1)"
    echo "apk_md5              $L"
    for D in "$HONOR:Honor" "$REDMI:Redmi"; do
      S="${D%%:*}"; N="${D##*:}"
      P=$("$ADB" -s "$S" shell pm path com.vaultchat.app 2>/dev/null | tr -d '\r' | sed 's/package://')
      M=$("$ADB" -s "$S" shell md5sum "$P" 2>/dev/null | tr -d '\r' | cut -d' ' -f1)
      echo "${N}_apk_md5$(printf '%*s' $((10-${#N})) '')  $M  $([ "$M" = "$L" ] && echo IDENTICAL || echo '*** MISMATCH ***')"
      IN=$("$ADB" -s "$S" shell input tap 1 1 2>&1 | head -1 | tr -d '\r')
      echo "${N}_input$(printf '%*s' $((12-${#N})) '')  $([ -z "$IN" ] && echo CONTROLLABLE || echo 'BLOCKED (MIUI INJECT_EVENTS)')"
    done
  } | tee "$DIR/00-preflight.txt"

  for D in "$HONOR:honor" "$REDMI:redmi"; do
    S="${D%%:*}"; N="${D##*:}"
    "$ADB" -s "$S" logcat -c 2>/dev/null
    ( "$ADB" -s "$S" logcat -v time $TAGS > "$DIR/$N.raw.log" 2>&1 & echo $! > "$DIR/.$N.pid" )
    ( tail -F "$DIR/$N.raw.log" 2>/dev/null | grep -E --line-buffered "$KEYWORDS" > "$DIR/$N.filtered.log" & echo $! > "$DIR/.$N.filt.pid" )
  done

  ( ssh -o BatchMode=yes -o ServerAliveInterval=30 "$PROD" \
      "docker logs -f --since 1m vaultchat-go-api-1 2>&1" > "$DIR/server.raw.log" 2>&1 & echo $! > "$DIR/.server.pid" )
  ( tail -F "$DIR/server.raw.log" 2>/dev/null \
      | grep -E --line-buffered 'relay/|RELAY_CLEANUP|vaultbeam|vb_transfer|403|410|expired|sweep' \
      > "$DIR/server.filtered.log" & echo $! > "$DIR/.server.filt.pid" )

  echo
  echo "capturing into: $DIR"
  echo "  honor.raw.log / honor.filtered.log"
  echo "  redmi.raw.log / redmi.filtered.log"
  echo "  server.raw.log / server.filtered.log"
  ;;

mark)
  DIR=$(cat "$ROOT/.current"); ID="${2:-UNNAMED}"
  STAMP="===== $ID $(date -u +%Y-%m-%dT%H:%M:%SZ) ====="
  for F in honor redmi server; do
    echo "$STAMP" >> "$DIR/$F.raw.log"; echo "$STAMP" >> "$DIR/$F.filtered.log"
  done
  echo "$STAMP" | tee -a "$DIR/10-test-marks.txt"
  ;;

snap)
  DIR=$(cat "$ROOT/.current"); ID="${2:-SNAP}"
  {
    echo "----- $ID  $(date -u +%Y-%m-%dT%H:%M:%SZ) -----"
    ssh -o BatchMode=yes "$PROD" "
      echo -n '  vb_transfer by state: '
      docker exec vaultchat-postgres-1 psql -U vaultchat -d vaultchat -tAc \"SELECT coalesce(string_agg(state||'='||n,', '),'NONE') FROM (SELECT state,count(*) n FROM vb_transfer GROUP BY state) t\"
      echo -n '  expired rows:         '
      docker exec vaultchat-postgres-1 psql -U vaultchat -d vaultchat -tAc 'SELECT count(*) FROM vb_transfer WHERE expires_at < NOW()'
      echo -n '  ledger:               '
      docker exec vaultchat-postgres-1 psql -U vaultchat -d vaultchat -tAc 'SELECT max(version) FROM schema_migrations'
    " 2>/dev/null
    for D in "$HONOR:Honor" "$REDMI:Redmi"; do
      S="${D%%:*}"; N="${D##*:}"
      echo -n "  $N net: "
      "$ADB" -s "$S" shell "ip -4 addr show wlan0 2>/dev/null | awk '/inet /{print \$2}' | tr '\n' ' '; ip -4 addr show rmnet_data0 2>/dev/null | awk '/inet /{print \$2}'" 2>/dev/null | tr -d '\r'
      echo
    done
  } | tee -a "$DIR/20-state-snapshots.txt"
  ;;

stop)
  DIR=$(cat "$ROOT/.current")
  for P in "$DIR"/.*.pid; do [ -f "$P" ] && kill "$(cat "$P")" 2>/dev/null; done
  pkill -f "logcat -v time" 2>/dev/null
  {
    echo "capture_stopped $(date -u +%Y-%m-%dT%H:%M:%SZ)"
    for F in honor redmi server; do
      printf '  %-10s raw=%s lines  filtered=%s lines\n' "$F" \
        "$(wc -l < "$DIR/$F.raw.log" 2>/dev/null || echo 0)" \
        "$(wc -l < "$DIR/$F.filtered.log" 2>/dev/null || echo 0)"
    done
    echo "  --- transport labels observed ---"
    grep -ohE 'LAN|WEBRTC_DIRECT|WEBRTC_TURN|R2_RELAY' "$DIR"/*.filtered.log 2>/dev/null | sort | uniq -c | sed 's/^/    /'
    echo "  --- ICE candidate pairs observed ---"
    grep -ohE '(host|srflx|prflx|relay)-(host|srflx|prflx|relay)' "$DIR"/*.filtered.log 2>/dev/null | sort | uniq -c | sed 's/^/    /'
  } | tee "$DIR/99-summary.txt"
  echo "artifacts in: $DIR"
  ;;

*) echo "usage: $0 start|mark <ID>|snap <ID>|stop"; exit 2;;
esac
