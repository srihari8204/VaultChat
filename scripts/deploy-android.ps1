# VaultChat Android production deploy script (PowerShell)
# Usage:
#   pwsh scripts/deploy-android.ps1 -Mode eas        # EAS cloud build (default)
#   pwsh scripts/deploy-android.ps1 -Mode local      # Local gradle APK
#   pwsh scripts/deploy-android.ps1 -Mode aab        # Local gradle AAB (Play Store)
#   pwsh scripts/deploy-android.ps1 -SkipChecks      # Skip prod-precheck (NOT recommended)

param(
  [ValidateSet('eas', 'local', 'aab')]
  [string]$Mode = 'eas',
  [switch]$SkipChecks
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
Set-Location $root

function Section($title) {
  Write-Host ""
  Write-Host "── $title ──" -ForegroundColor Cyan
}

function Fail($msg) {
  Write-Host "FAIL: $msg" -ForegroundColor Red
  exit 1
}

Section 'Pre-flight checks'
if (-not $SkipChecks) {
  node scripts/prod-precheck.js
  if ($LASTEXITCODE -ne 0) { Fail 'prod-precheck failed. Fix the blockers or pass -SkipChecks.' }
} else {
  Write-Host 'Skipping pre-checks (NOT recommended for real prod release).' -ForegroundColor Yellow
}

Section 'Typecheck'
npx tsc --noEmit
if ($LASTEXITCODE -ne 0) {
  Write-Host 'Typecheck reported errors. These do not block bundling but should be reviewed.' -ForegroundColor Yellow
}

Section "Build ($Mode)"
switch ($Mode) {
  'eas'   {
    npx eas build --platform android --profile production --non-interactive
    if ($LASTEXITCODE -ne 0) { Fail 'EAS build failed.' }
  }
  'local' {
    npx expo prebuild --platform android --clean
    if ($LASTEXITCODE -ne 0) { Fail 'expo prebuild failed.' }
    Set-Location android
    .\gradlew assembleRelease
    if ($LASTEXITCODE -ne 0) { Fail 'gradle assembleRelease failed.' }
    Set-Location $root
    Write-Host "APK: android/app/build/outputs/apk/release/app-release.apk" -ForegroundColor Green
  }
  'aab'   {
    npx expo prebuild --platform android --clean
    if ($LASTEXITCODE -ne 0) { Fail 'expo prebuild failed.' }
    Set-Location android
    .\gradlew bundleRelease
    if ($LASTEXITCODE -ne 0) { Fail 'gradle bundleRelease failed.' }
    Set-Location $root
    Write-Host "AAB: android/app/build/outputs/bundle/release/app-release.aab" -ForegroundColor Green
  }
}

Section 'Done'
Write-Host 'Android build complete.' -ForegroundColor Green
