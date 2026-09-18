# Phase 3 preconditions - run this BEFORE scripts/deploy.ps1.
#
# Everything here is read-only. The point is the two "before" bodies: section 5
# of the runbook requires the JSON responses to be byte-identical after the
# deploy, and you cannot capture a "before" once the deploy has happened.
#
# The baselines are written on the BOX (/tmp), because that is where
# verify-protobuf.ps1 diffs them.
#
# Usage:
#   .\scripts\capture-baseline.ps1

param(
  [string]$VmHost   = 'root@65.21.229.167',
  [string]$Loopback = 'http://127.0.0.1:8095'
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot

function Section($t) { Write-Host ""; Write-Host "== $t" -ForegroundColor Cyan }
function Note($m)    { Write-Host "  $m" }
function Warn($m)    { Write-Host "  [warn] $m" -ForegroundColor Yellow }
function Box($cmd)   { ssh -o BatchMode=yes -o ConnectTimeout=10 $VmHost $cmd }

Section '1. what the box is running now'
Note (Box "curl -s -m 10 $Loopback/build")

Section '2. local fingerprint (deploy.sh gates on this matching)'
$bash = @('C:\Program Files\Git\bin\bash.exe',
          'C:\Program Files (x86)\Git\bin\bash.exe') |
        Where-Object { Test-Path $_ } | Select-Object -First 1
if ($bash) {
  Push-Location $root
  Note ("fingerprint: " + (& $bash 'scripts/fingerprint-go.sh'))
  Pop-Location
} else {
  Warn 'Git Bash not found - cannot read the local fingerprint'
}

Section '3. migration ledger vs the repo'
#
# max(version) below the repo's highest file means deploy.sh WILL apply
# migrations at its step 5, and from that point rollback stops being total:
# it restores the binary and the source tree, never the schema.
$ledger = Box "docker exec vaultchat-postgres-1 psql -U vaultchat -d vaultchat -tAc 'SELECT count(*), max(version) FROM schema_migrations;'"
$files  = (Get-ChildItem (Join-Path $root 'vaultchat-backend\migrations') -Filter *.sql).Count
Note "box (applied|max): $ledger"
Note "repo .sql files:   $files"
if ($ledger -match '^\s*(\d+)\|') {
  $applied = [int]$Matches[1]
  if ($applied -lt $files) {
    Warn "$($files - $applied) migration(s) pending - deploy.sh will apply them. Read each one first; there is no automatic down."
  } else {
    Note 'ledger level with the repo - nothing to apply'
  }
}

Section '4. before-bodies (the byte-identical comparison depends on these)'
Box "curl -s -m 10 -H 'Accept: application/json' $Loopback/app/flags   > /tmp/app-flags.before.json"
Box "curl -s -m 10 -H 'Accept: application/json' $Loopback/app/version > /tmp/app-version.before.json"
$sizes = Box 'wc -c /tmp/app-flags.before.json /tmp/app-version.before.json'
$sizes | ForEach-Object { Note $_ }
#
# A zero-byte PROTOBUF /app/flags is legitimate later (proto3 elides an empty
# repeated field). A zero-byte JSON capture here is not - it means the port or
# the endpoint is wrong, and the post-deploy diff would then "pass" against
# nothing at all.
if ($sizes -match '(^|\s)0\s+/tmp/') { Warn 'a baseline is EMPTY - fix that before deploying, or check 4 proves nothing' }

Section '5. metrics baseline'
$m = Box "curl -s -m 10 $Loopback/internal/metrics | grep responses_total"
if ($m) { $m | ForEach-Object { Note $_ } }
else    { Note 'absent - this box predates the counter. Expected; you get a post-deploy reading, not a diff.' }

Section '6. blast radius of a restart'
Note ("live calls: " + (Box "docker exec vaultchat-postgres-1 psql -U vaultchat -d vaultchat -tAc 'SELECT count(*) FROM calls WHERE ended_at IS NULL;'"))
Note 'go-api recreation drops and reconnects every CC-Wire socket. Deploy when this is low.'

Write-Host ""
Write-Host "Baselines captured. Next: .\scripts\deploy.ps1" -ForegroundColor Green
