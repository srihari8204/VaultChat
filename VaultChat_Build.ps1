# ╔══════════════════════════════════════════════════════════════╗
# ║         VaultChat — Full Setup & Build Script               ║
# ║         Writes facescan.tsx then builds for Android         ║
# ╚══════════════════════════════════════════════════════════════╝

$BASE = "C:\Users\ADMIN\Desktop\Vaultchat backup"

Write-Host "" 
Write-Host "  VaultChat Build Script" -ForegroundColor Cyan
Write-Host "  ──────────────────────────────────────" -ForegroundColor DarkCyan
Write-Host ""

# ── Step 1: Write facescan.tsx ─────────────────────────────────
Write-Host "[1/3] Writing app/facescan.tsx..." -ForegroundColor Yellow

$dest = "$BASE\app\facescan.tsx"
$b64  = ""
$bytes = [System.Convert]::FromBase64String($b64)
[System.IO.File]::WriteAllBytes($dest, $bytes)

$lines = (Get-Content $dest).Count
Write-Host "    Done — $lines lines written to $dest" -ForegroundColor Green

# ── Step 2: Verify key dependencies ───────────────────────────
Write-Host ""
Write-Host "[2/3] Checking node_modules..." -ForegroundColor Yellow

$required = @(
  "expo-camera",
  "expo-face-detector",
  "expo-secure-store",
  "expo-file-system",
  "react-native-svg"
)

$missing = @()
foreach ($pkg in $required) {
  $path = "$BASE\node_modules\$pkg"
  if (Test-Path $path) {
    Write-Host "    OK  $pkg" -ForegroundColor Green
  } else {
    Write-Host "    !!  $pkg  MISSING" -ForegroundColor Red
    $missing += $pkg
  }
}

if ($missing.Count -gt 0) {
  Write-Host ""
  Write-Host "    Installing missing packages..." -ForegroundColor Yellow
  Set-Location $BASE
  npm install $($missing -join " ")
}

# ── Step 3: Build ──────────────────────────────────────────────
Write-Host ""
Write-Host "[3/3] Building for Android..." -ForegroundColor Yellow
Write-Host "    (make sure your Huawei P30 Pro is connected via USB)"
Write-Host ""

Set-Location $BASE
npx expo run:android
