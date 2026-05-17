# VaultChat backend deploy script (PowerShell)
# Render auto-deploys from GitHub when master is pushed.
# This script syntax-checks, commits, pushes, then polls /health.

param(
  [string]$CommitMessage = 'Deploy backend',
  [string]$HealthUrl = 'https://api.corefinite.com/health',
  [int]$HealthTimeoutSec = 180
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$backend = Join-Path $root 'vaultchat-backend'

function Section($t) { Write-Host ""; Write-Host "── $t ──" -ForegroundColor Cyan }
function Fail($m)    { Write-Host "FAIL: $m" -ForegroundColor Red; exit 1 }

Set-Location $backend

Section 'Syntax check'
node --check server.js;       if ($LASTEXITCODE -ne 0) { Fail 'server.js syntax error' }
node --check firebaseAdmin.js; if ($LASTEXITCODE -ne 0) { Fail 'firebaseAdmin.js syntax error' }
Get-ChildItem routes -Filter *.js | ForEach-Object {
  node --check $_.FullName
  if ($LASTEXITCODE -ne 0) { Fail "routes/$($_.Name) syntax error" }
}
Write-Host 'Backend syntax OK' -ForegroundColor Green

Section 'Git status'
git -C $root status --short

Section 'Commit + push'
git -C $root add vaultchat-backend
$pending = git -C $root diff --cached --name-only
if (-not $pending) {
  Write-Host 'No backend changes to commit. Skipping commit.' -ForegroundColor Yellow
} else {
  git -C $root commit -m $CommitMessage
  if ($LASTEXITCODE -ne 0) { Fail 'git commit failed' }
}
git -C $root push origin master
if ($LASTEXITCODE -ne 0) { Fail 'git push failed' }

Section 'Waiting for Render auto-deploy'
$deadline = (Get-Date).AddSeconds($HealthTimeoutSec)
$ok = $false
while ((Get-Date) -lt $deadline) {
  try {
    $r = Invoke-WebRequest -UseBasicParsing -Uri $HealthUrl -TimeoutSec 10
    if ($r.StatusCode -eq 200) {
      Write-Host "Health OK: $($r.Content)" -ForegroundColor Green
      $ok = $true
      break
    }
  } catch {
    Write-Host "  …health not ready, retrying" -ForegroundColor DarkGray
  }
  Start-Sleep -Seconds 6
}
if (-not $ok) { Fail "Health check did not pass within $HealthTimeoutSec s. Check Render dashboard." }

Section 'Done'
Write-Host 'Backend deploy verified.' -ForegroundColor Green
