# VaultChat go-api deploy — PowerShell entry point.
#
# This is a WRAPPER, not a reimplementation. scripts/deploy.sh owns the deploy:
# backup-before-touch, fingerprint gating, tar-over-ssh with --delete semantics,
# migrations, and an automatic rollback that is defined before the destructive
# step. Rewriting eight stages of that in PowerShell would mean a second,
# unproven copy of the one script whose failure mode is "production is down".
#
# What this file actually fixes is the two things that bite on Windows:
#   1. `bash` in PowerShell resolves to C:\Windows\System32\bash.exe (WSL),
#      which is not the Git Bash the script needs. We call Git's bash by path.
#   2. MSYS paths (/c/Users/...) are not PowerShell paths (C:\Users\...).
#
# Usage:
#   .\scripts\deploy.ps1            # interactive, asks before deploying
#   .\scripts\deploy.ps1 -Yes       # skip the prompt (CI only — see below)
#
# -Yes also skips the live-call count deploy.sh prints before asking. That
# number is how many people's sockets a go-api restart is about to drop. Do not
# pass it just because the prompt is inconvenient.

param(
  [switch]$Yes
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot

function Section($t) { Write-Host ""; Write-Host "== $t" -ForegroundColor Cyan }
function Fail($m)    { Write-Host "FAIL: $m" -ForegroundColor Red; exit 1 }

Section 'locating Git Bash'

# Explicitly NOT `Get-Command bash` — on a machine with WSL that finds
# System32\bash.exe, which launches a Linux distro with no checkout in it.
$bash = @(
  'C:\Program Files\Git\bin\bash.exe',
  'C:\Program Files (x86)\Git\bin\bash.exe',
  "$env:LOCALAPPDATA\Programs\Git\bin\bash.exe"
) | Where-Object { Test-Path $_ } | Select-Object -First 1

if (-not $bash) {
  Fail 'Git Bash not found. Install Git for Windows, or run scripts/deploy.sh from a Git Bash window.'
}
Write-Host "  $bash" -ForegroundColor Green

Section 'handing off to scripts/deploy.sh'
Write-Host "  repo: $root"
Write-Host ""

Set-Location $root

# Relative path on purpose: deploy.sh does `[ -f scripts/fingerprint-go.sh ]`
# to prove it is running from the repo root, so the cwd is what matters.
if ($Yes) {
  & $bash 'scripts/deploy.sh' '--yes'
} else {
  & $bash 'scripts/deploy.sh'
}

$code = $LASTEXITCODE
if ($code -ne 0) {
  # deploy.sh rolls itself back on failure and says so on its own output; do not
  # restate an outcome this wrapper did not observe.
  Fail "deploy.sh exited $code — read its output above for what it did or undid"
}

Write-Host ""
Write-Host "deploy.sh finished cleanly. It proved the BINARY is running." -ForegroundColor Green
Write-Host "It did NOT prove content negotiation works — run:" -ForegroundColor Yellow
Write-Host "  .\scripts\verify-protobuf.ps1" -ForegroundColor Yellow
