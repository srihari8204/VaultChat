#!/usr/bin/env bash
# UPDATE_PRESERVATION_TEST — proves an APK update KEEPS local data.
#
# The mirror of fresh-install-test.sh. That one proves a clean install starts
# empty; this one proves shipping a new build does not wipe the user's history.
# Both matter, and conflating them is how a normal update gets mistaken for a
# restore bug — or worse, how a genuine data-loss regression ships unnoticed
# because "the fresh-install test passed".
#
# This script REQUIRES the app to be signed in with some local history before it
# runs; it cannot create that itself (login needs an SMS OTP). It checks that
# precondition and stops rather than reporting a meaningless pass.
#
# NON-DESTRUCTIVE: only `install -r`, which is the data-preserving path.
set -uo pipefail

ADB="${ADB:-/c/Users/Dell/AppData/Local/Android/Sdk/platform-tools/adb.exe}"
PKG="${PKG:-com.vaultchat.app}"
APK="${APK:-android/app/build/outputs/apk/release/app-release.apk}"
fails=0
ok()  { echo "  [PASS] $1"; }
bad() { echo "  [FAIL] $1"; fails=$((fails+1)); }

chat_rows() {   # names currently rendered in the chat list
  "$ADB" shell "uiautomator dump /sdcard/upd.xml" >/dev/null 2>&1
  "$ADB" shell "cat /sdcard/upd.xml" 2>/dev/null \
    | tr '>' '\n' | grep -oE 'text="[^"]{2,40}"' | sed 's/text="//;s/"$//' \
    | grep -vE '^(Chats|All|Unread|Groups|Pinned|Archive|ALL CHATS|PINNED|)$' | sort -u
}

echo "UPDATE_PRESERVATION_TEST  pkg=$PKG"
[ -f "$APK" ] || { echo "APK not found: $APK"; exit 2; }

echo "== 0. precondition: signed in, with visible history =="
"$ADB" shell monkey -p "$PKG" -c android.intent.category.LAUNCHER 1 >/dev/null 2>&1
sleep 10
before="$(chat_rows)"
if [ -z "$before" ]; then
  echo "  [SKIP] no chats on screen — sign in and open the app first."
  echo "         A pass here would prove nothing: empty before and empty after."
  exit 3
fi
echo "  before: $(echo "$before" | tr '\n' ' ')"

echo "== 1. capture identity of the data directory =="
first_before="$("$ADB" shell dumpsys package "$PKG" 2>/dev/null | grep -m1 firstInstallTime | tr -d '\r' | cut -d= -f2)"

echo "== 2. install -r (the UPDATE path) =="
"$ADB" install -r "$APK" >/dev/null 2>&1
first_after="$("$ADB" shell dumpsys package "$PKG" 2>/dev/null | grep -m1 firstInstallTime | tr -d '\r' | cut -d= -f2)"
last_after="$("$ADB"  shell dumpsys package "$PKG" 2>/dev/null | grep -m1 lastUpdateTime  | tr -d '\r' | cut -d= -f2)"
[ "$first_before" = "$first_after" ] \
  && ok "firstInstallTime preserved ($first_after) — the data dir was not recreated" \
  || bad "firstInstallTime changed ($first_before -> $first_after): this was NOT an update"
[ "$first_after" != "$last_after" ] \
  && ok "lastUpdateTime advanced ($last_after) — a new build really did land" \
  || bad "lastUpdateTime did not move; did the install actually happen?"

echo "== 3. relaunch and compare the chat list =="
"$ADB" shell am force-stop "$PKG" >/dev/null 2>&1
"$ADB" shell monkey -p "$PKG" -c android.intent.category.LAUNCHER 1 >/dev/null 2>&1
sleep 12
after="$(chat_rows)"
echo "  after:  $(echo "$after" | tr '\n' ' ')"

missing="$(comm -23 <(echo "$before") <(echo "$after") 2>/dev/null)"
[ -z "$missing" ] \
  && ok "every chat survived the update" \
  || bad "chats LOST across the update: $(echo "$missing" | tr '\n' ' ')"

echo "$after" | grep -qiE "Sign In|MOBILE NUMBER" \
  && bad "the update logged the user out" \
  || ok "session survived the update"

echo "== 4. and it still works with no network =="
"$ADB" shell svc wifi disable >/dev/null 2>&1
"$ADB" shell svc data disable >/dev/null 2>&1
sleep 5
"$ADB" shell am force-stop "$PKG" >/dev/null 2>&1
"$ADB" shell monkey -p "$PKG" -c android.intent.category.LAUNCHER 1 >/dev/null 2>&1
sleep 12
offline="$(chat_rows)"
echo "  offline: $(echo "$offline" | tr '\n' ' ')"
[ -n "$offline" ] \
  && ok "chat list renders from local cache with no network" \
  || bad "nothing rendered offline — local-first is broken"
"$ADB" shell svc wifi enable >/dev/null 2>&1
"$ADB" shell svc data enable >/dev/null 2>&1

echo
[ "$fails" -eq 0 ] && echo "UPDATE_PRESERVATION_TEST: PASS" || echo "UPDATE_PRESERVATION_TEST: FAIL ($fails)"
exit "$fails"
