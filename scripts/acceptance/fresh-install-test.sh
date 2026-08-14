#!/usr/bin/env bash
# FRESH_INSTALL_TEST — proves a clean installation starts with ZERO local data.
#
# WHY THIS EXISTS SEPARATELY
# --------------------------
# `adb install -r` is an UPDATE. It preserves /data/data/<pkg> by design, so a
# run that starts with it can never prove anything about a fresh install — the
# previous session's chats, cursor, outbox and E2EE cache are all still there.
# Calling that a fresh-install test is how "the new build showed old chats" gets
# misdiagnosed as a restore bug when it is really an update, or a normal sync.
#
# The distinction this script enforces:
#   uninstall  -> data directory is REMOVED   (verified, not assumed)
#   install    -> new data directory, empty
#   launch     -> login screen, no chats, no sync traffic
#
# It deliberately refuses to run `install -r`. Use update-preservation-test.sh
# for the other half.
#
# DESTRUCTIVE: uninstalling erases the device's E2EE identity. Any history that
# account holds becomes undecryptable, exactly as an uninstall should. Do not
# run this against a device whose account you care about.
set -uo pipefail

ADB="${ADB:-/c/Users/Dell/AppData/Local/Android/Sdk/platform-tools/adb.exe}"
PKG="${PKG:-com.vaultchat.app}"
APK="${APK:-android/app/build/outputs/apk/release/app-release.apk}"
fails=0
ok()   { echo "  [PASS] $1"; }
bad()  { echo "  [FAIL] $1"; fails=$((fails+1)); }

echo "FRESH_INSTALL_TEST  pkg=$PKG"
[ -f "$APK" ] || { echo "APK not found: $APK"; exit 2; }

echo "== 1. remove the app and PROVE the data directory is gone =="
"$ADB" uninstall "$PKG" >/dev/null 2>&1
[ -z "$("$ADB" shell pm path "$PKG" 2>/dev/null | tr -d '\r')" ] \
  && ok "package removed" || bad "package still installed"
[ -z "$("$ADB" shell pm list packages -u 2>/dev/null | grep "$PKG" | tr -d '\r')" ] \
  && ok "no retained-data record (hasFragileUserData=false)" \
  || bad "Android retained app data across uninstall"
# The decisive one: the directory itself.
case "$("$ADB" shell "ls -d /data/data/$PKG 2>&1" | tr -d '\r')" in
  *"No such file"*) ok "/data/data/$PKG does not exist" ;;
  *)                bad "data directory survived uninstall: $("$ADB" shell "ls -d /data/data/$PKG 2>&1")" ;;
esac

echo "== 2. can Android restore anything into it? =="
# Ask the Backup Manager directly rather than reading the manifest and hoping.
res="$("$ADB" shell "bmgr backupnow $PKG" 2>&1 | tr -d '\r')"
echo "$res" | grep -q "Backup is not allowed" \
  && ok "backup refused by the platform (allowBackup=false)" \
  || bad "THIS APP IS BACKED UP — a fresh install may restore old data: $res"

echo "== 3. install clean (never -r) =="
"$ADB" install "$APK" >/dev/null 2>&1
first="$("$ADB" shell dumpsys package "$PKG" 2>/dev/null | grep -m1 firstInstallTime | tr -d '\r' | cut -d= -f2)"
last="$("$ADB"  shell dumpsys package "$PKG" 2>/dev/null | grep -m1 lastUpdateTime  | tr -d '\r' | cut -d= -f2)"
[ -n "$first" ] && [ "$first" = "$last" ] \
  && ok "genuine fresh install (firstInstallTime == lastUpdateTime = $first)" \
  || bad "this looks like an UPDATE, not a fresh install (first=$first last=$last)"

echo "== 4. launch and prove there is nothing to show =="
"$ADB" logcat -c >/dev/null 2>&1
"$ADB" shell monkey -p "$PKG" -c android.intent.category.LAUNCHER 1 >/dev/null 2>&1
sleep 12
"$ADB" shell "uiautomator dump /sdcard/fresh.xml" >/dev/null 2>&1
ui="$("$ADB" shell "cat /sdcard/fresh.xml" 2>/dev/null)"

# Screenshots are blocked by FLAG_SECURE, so the view hierarchy is the evidence.
echo "$ui" | grep -qiE 'text="(Sign In|Continue|MOBILE NUMBER)' \
  && ok "first screen is login" || bad "did not land on the login screen"

# No chat list, and specifically none of the previous session's rows.
if echo "$ui" | grep -qiE 'text="(ALL CHATS|PINNED|Unread|Archive)"'; then
  bad "a chat list rendered before login"
else
  ok "no chat list before login"
fi

log="$("$ADB" logcat -d -v time -s ReactNativeJS:V 2>/dev/null)"
echo "$log" | grep -q "NOT_SIGNED_IN" \
  && ok "app reports NOT_SIGNED_IN (no restored session)" \
  || echo "  [warn] no NOT_SIGNED_IN line — check the app actually started"
n="$(echo "$log" | grep -cE "predate the plaintext cache|ghash|sender key|chats/delta")"
[ "$n" -eq 0 ] \
  && ok "zero history/decrypt/sync activity before login" \
  || bad "$n history-processing lines before login — something restored state"

echo
[ "$fails" -eq 0 ] && echo "FRESH_INSTALL_TEST: PASS" || echo "FRESH_INSTALL_TEST: FAIL ($fails)"
exit "$fails"
