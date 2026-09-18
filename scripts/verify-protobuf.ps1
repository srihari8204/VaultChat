# Phase 4 - prove content negotiation actually works after a deploy.
#
# scripts/deploy.sh proves the right BINARY is running (/health, /ready, /build).
# It does not prove negotiation. These checks do, and none of them needs a token:
# /app/version and /app/flags are deliberately unauthenticated.
#
# Usage:
#   .\scripts\verify-protobuf.ps1
#   .\scripts\verify-protobuf.ps1 -Fingerprint 45cb100cdc2f0338
#
# Run scripts/capture-baseline.ps1 BEFORE deploying - the JSON comparison below
# needs a "before" body and you cannot take one after the fact.

param(
  [string]$VmHost      = 'root@65.21.229.167',
  [string]$Loopback    = 'http://127.0.0.1:8095',
  # Caddy REFUSES /internal/* from outside (caddy/Caddyfile:25-26), so the
  # metrics scrape has to go straight at go-api. Through :8095 it is a 404,
  # which reads exactly like "the counter does not exist" and is not that.
  [string]$GoApi       = 'http://127.0.0.1:14000',
  [string]$Edge        = 'https://api.corefinite.com',
  [string]$Fingerprint = ''          # expected /build source; blank = just report it
)

$ErrorActionPreference = 'Stop'
$fail = 0
$warn = 0

function Section($t) { Write-Host ""; Write-Host "== $t" -ForegroundColor Cyan }
function Pass($m)    { Write-Host "  [ok]   $m" -ForegroundColor Green }
function Bad($m)     { Write-Host "  [FAIL] $m" -ForegroundColor Red;    $script:fail++ }
function Warn($m)    { Write-Host "  [warn] $m" -ForegroundColor Yellow; $script:warn++ }
function Box($cmd)   { ssh -o BatchMode=yes -o ConnectTimeout=10 $VmHost $cmd }

# --- 1. the right binary --------------------------------------------------
Section '1. which binary is serving'
$build = Box "curl -s -m 10 $Loopback/build"
Write-Host "  $build"
if ($Fingerprint) {
  if ($build -match [regex]::Escape($Fingerprint)) { Pass "fingerprint $Fingerprint" }
  else { Bad "expected $Fingerprint - the deploy did not land, nothing below is meaningful"; exit 1 }
}

# --- 2. protobuf is actually served ---------------------------------------
Section '2. protobuf negotiation (/app/version)'
#
# ALWAYS take the size, never content-type alone. /app/flags with
# VAULTCHAT_REMOTE_FLAGS unset marshals to a legitimate ZERO-byte body (proto3
# elides an empty repeated field), so content-type prints "application/protobuf"
# for a healthy response and a broken one alike. /app/version can never be empty
# - update_url always has a default - which is why it is the check that counts.
$r = Box "curl -s -m 10 -H 'Accept: application/protobuf, application/json' -o /dev/null -w '%{content_type} %{size_download}' $Loopback/app/version"
Write-Host "  $r"
$ct, $sz = $r -split '\s+', 2
if     ($ct -notmatch 'protobuf') { Bad "content-type is '$ct', not protobuf - negotiation is not live" }
elseif ([int]$sz -le 0)           { Bad "protobuf content-type with a $sz-byte body" }
else                              { Pass "application/protobuf, $sz bytes" }

# Prove the bytes are really protobuf and not something merely claiming to be.
# update_url is field 3 (app_version.proto:26) and always has a default, so the
# URL appears as readable text inside the encoded body.
Section '3. the bytes are really protobuf'
$od = Box "curl -s -m 10 -H 'Accept: application/protobuf, application/json' $Loopback/app/version | od -c | head -4"
$od | ForEach-Object { Write-Host "  $_" }
if ($od -match 'p\s+l\s+a\s+y' -or $od -match 'play') { Pass 'update_url present in the encoded body' }
else { Warn 'could not spot update_url - read the dump above yourself' }

# --- 4. the JSON path did not move ----------------------------------------
Section '4. JSON path unchanged (byte-identical to the pre-deploy capture)'
$diff = Box "test -s /tmp/app-flags.before.json && curl -s -m 10 -H 'Accept: application/json' $Loopback/app/flags | diff - /tmp/app-flags.before.json && echo VC_SAME || echo VC_DIFF"
if     ($diff -match 'VC_SAME') { Pass 'JSON body identical to before the deploy' }
elseif ($diff -match 'VC_DIFF') { Bad  'JSON body CHANGED - every installed build reads this path' }
else   { Warn 'no baseline at /tmp/app-flags.before.json - this check proved nothing' }

# --- 5. negotiation must not over-match -----------------------------------
Section '5. plain clients still get JSON'
#
# Every currently installed build sends `Accept: application/json`. If either of
# these answers protobuf, those builds just started receiving bytes they did not
# ask for.
foreach ($h in @(@{n='Accept: application/json'; a="-H 'Accept: application/json'"},
                 @{n='no Accept header (*/*)';   a=''})) {
  $c = Box "curl -s -m 10 $($h.a) -o /dev/null -w '%{content_type}' $Loopback/app/version"
  if ($c -match 'json') { Pass "$($h.n) -> $c" }
  else { Bad "$($h.n) -> $c  (MUST be json - installed builds cannot read this)" }
}

# --- 6. metrics - the only check covering the 7 AUTHENTICATED endpoints ---
Section '6. metrics (you have no token, so this is the only view of the other 7)'
$m = Box "curl -s -m 10 $GoApi/internal/metrics | grep responses_total"
if ($m) {
  $m | ForEach-Object { Write-Host "  $_" }
  Pass 'counter exists - on its own that proves the new binary is up'
  Write-Host '  Re-run in a few minutes: repr="protobuf" must rise AND repr="json"' -ForegroundColor DarkGray
  Write-Host '  must keep rising. A flat json series means you are matching clients' -ForegroundColor DarkGray
  Write-Host '  that never opted in.' -ForegroundColor DarkGray
} else {
  Bad 'no responses_total on go-api:14000 - the old binary is still serving'
  Write-Host '  (a 404 here through :8095 instead would be Caddy doing its job,' -ForegroundColor DarkGray
  Write-Host '   not a missing counter - see caddy/Caddyfile:25-26)' -ForegroundColor DarkGray
}

# --- 7. the edge, where a proxy can silently demote everyone --------------
Section '7. through the edge (size matters, not just content-type)'
$e = Box "curl -s -m 10 -H 'Accept: application/protobuf, application/json' -o /dev/null -w '%{content_type} %{size_download}' $Edge/app/version"
Write-Host "  loopback: $r"
Write-Host "  edge:     $e"
$ect, $esz = $e -split '\s+', 2
if ($ect -match 'protobuf' -and $esz -eq $sz) {
  Pass 'edge matches loopback'
} elseif ($ect -match 'json' -and $esz -ne $sz) {
  Warn 'edge stripped Accept - harmless, every client falls back to JSON. Caddy issue, not a rollback trigger.'
} elseif ($ect -match 'json' -and $esz -eq $sz) {
  Bad 'edge rewrote ONLY the Content-Type: clients see json, receive protobuf, JSON.parse throws. Silent total demotion that no metric shows.'
} else {
  Warn "unexpected: edge '$e' vs loopback '$r'"
}

# --- 8. the money migration actually converted ----------------------------
Section '8. migration 137 sanity (delivery_fee_minor = delivery_fee x 100, INR)'
$money = Box "docker exec vaultchat-postgres-1 psql -U vaultchat -d vaultchat -tAc 'SELECT delivery_fee, delivery_fee_minor FROM shopbook_shop;'"
Write-Host "  $money"
if ($money -match '^\s*([\d.]+)\|(\d+)\s*$') {
  $major = [decimal]$Matches[1]; $minor = [long]$Matches[2]
  if ($minor -eq [long][math]::Round($major * 100)) { Pass "$major -> $minor" }
  else { Bad "$major should be $([long][math]::Round($major*100)), got $minor" }
} elseif ($money -match 'does not exist') {
  Bad 'delivery_fee_minor missing - migrations 136/137 never applied'
} else {
  Warn 'could not parse - read the row above'
}

# --- verdict --------------------------------------------------------------
Write-Host ""
if ($fail -gt 0) {
  Write-Host "$fail FAILED, $warn warning(s)." -ForegroundColor Red
  Write-Host "Rollback is section 6 of openspec/changes/protobuf-migration/deploy-runbook.md." -ForegroundColor Red
  Write-Host "It restores the binary and the source tree. It does NOT undo applied migrations." -ForegroundColor Red
  exit 1
}
Write-Host "All checks passed ($warn warning(s))." -ForegroundColor Green
Write-Host ""
Write-Host "Still unproven by this script - it only looked at the server:" -ForegroundColor DarkGray
Write-Host "  cold start on a handset. Measure it, do not assume it:" -ForegroundColor DarkGray
Write-Host "    adb shell am start -W -S com.vaultchat.app/.MainActivity" -ForegroundColor DarkGray
Write-Host "    adb logcat -s ReactNativeJS | Select-String '\[perf\]'" -ForegroundColor DarkGray
Write-Host "  Report four milestones SEPARATELY: first frame, chats_paint_cache," -ForegroundColor DarkGray
Write-Host "  CC-Wire authenticated, catch-up complete. Blending a first-draw" -ForegroundColor DarkGray
Write-Host "  number with a readiness number is what produced the bogus 859ms" -ForegroundColor DarkGray
Write-Host "  vs 13.4s comparison." -ForegroundColor DarkGray
