# ============================================
# VAULTCHAT — Full Environment Fix
# Fixes: Node 22 → Node 20 LTS
# Cleans: node_modules, cache
# Restores: all packages
# Starts: Expo on Android emulator
# ============================================

Write-Host ""
Write-Host "========================================" -ForegroundColor Cyan
Write-Host "  VAULTCHAT — Full Environment Fix" -ForegroundColor Cyan
Write-Host "========================================" -ForegroundColor Cyan
Write-Host ""

# ── Step 1: Check current Node version ───────────────────────────────────────
$nodeVer = node --version
Write-Host "Current Node version: $nodeVer" -ForegroundColor Yellow

if ($nodeVer -match "v20") {
    Write-Host "Node 20 already installed. Skipping download." -ForegroundColor Green
} else {
    Write-Host ""
    Write-Host "STEP 1: Downloading Node 20 LTS..." -ForegroundColor Cyan
    Write-Host "(Node 22 breaks Metro + Expo CLI)" -ForegroundColor Gray

    $nodeInstaller = "$env:TEMP\node20-installer.msi"
    $nodeUrl = "https://nodejs.org/dist/v20.19.0/node-v20.19.0-x64.msi"

    Write-Host "Downloading from nodejs.org..." -ForegroundColor White
    Invoke-WebRequest -Uri $nodeUrl -OutFile $nodeInstaller -UseBasicParsing

    Write-Host "Installing Node 20 LTS..." -ForegroundColor White
    Write-Host "(This will replace Node 22 — takes ~1 minute)" -ForegroundColor Gray

    Start-Process msiexec.exe -ArgumentList "/i `"$nodeInstaller`" /quiet /norestart" -Wait

    # Refresh PATH
    $env:PATH = [System.Environment]::GetEnvironmentVariable("Path","Machine") + ";" +
                [System.Environment]::GetEnvironmentVariable("Path","User")

    $newVer = node --version 2>$null
    Write-Host ""
    Write-Host "Node version now: $newVer" -ForegroundColor Green

    if ($newVer -notmatch "v20") {
        Write-Host ""
        Write-Host "WARNING: Node version did not update in this session." -ForegroundColor Yellow
        Write-Host "Please:" -ForegroundColor Yellow
        Write-Host "  1. Close this PowerShell window" -ForegroundColor White
        Write-Host "  2. Open a NEW PowerShell window" -ForegroundColor White
        Write-Host "  3. Run this script again" -ForegroundColor White
        Write-Host ""
        Write-Host "Or manually install Node 20 from:" -ForegroundColor Yellow
        Write-Host "  https://nodejs.org/en/download" -ForegroundColor Cyan
        exit 0
    }
}

# ── Step 2: Go to VaultChat ───────────────────────────────────────────────────
Write-Host ""
Write-Host "STEP 2: Navigating to VaultChat..." -ForegroundColor Cyan
cd C:\Users\ADMIN\Desktop\VaultChat

if (-not (Test-Path "package.json")) {
    Write-Host "ERROR: VaultChat folder not found." -ForegroundColor Red
    Write-Host "Check path: C:\Users\ADMIN\Desktop\VaultChat" -ForegroundColor Yellow
    exit 1
}
Write-Host "Found VaultChat project." -ForegroundColor Green

# ── Step 3: Clean everything ──────────────────────────────────────────────────
Write-Host ""
Write-Host "STEP 3: Cleaning all caches..." -ForegroundColor Cyan

Write-Host "  Deleting node_modules..." -ForegroundColor White
if (Test-Path "node_modules") {
    Remove-Item -Recurse -Force "node_modules"
    Write-Host "  Deleted node_modules." -ForegroundColor Green
}

Write-Host "  Deleting package-lock.json..." -ForegroundColor White
if (Test-Path "package-lock.json") {
    Remove-Item -Force "package-lock.json"
    Write-Host "  Deleted package-lock.json." -ForegroundColor Green
}

Write-Host "  Clearing npm cache..." -ForegroundColor White
npm cache clean --force 2>$null
Write-Host "  npm cache cleared." -ForegroundColor Green

Write-Host "  Clearing Metro cache..." -ForegroundColor White
if (Test-Path "$env:TEMP\metro-*") {
    Remove-Item -Recurse -Force "$env:TEMP\metro-*" 2>$null
}
if (Test-Path "$env:LOCALAPPDATA\Temp\metro-*") {
    Remove-Item -Recurse -Force "$env:LOCALAPPDATA\Temp\metro-*" 2>$null
}
Write-Host "  Metro cache cleared." -ForegroundColor Green

# ── Step 4: Reinstall packages ────────────────────────────────────────────────
Write-Host ""
Write-Host "STEP 4: Reinstalling packages..." -ForegroundColor Cyan
Write-Host "(This takes 3-5 minutes)" -ForegroundColor Gray
Write-Host ""

npm install --legacy-peer-deps

if ($LASTEXITCODE -ne 0) {
    Write-Host ""
    Write-Host "npm install failed. Trying without legacy flag..." -ForegroundColor Yellow
    npm install
}

Write-Host ""
Write-Host "Packages installed." -ForegroundColor Green

# ── Step 5: Fix Expo package versions ────────────────────────────────────────
Write-Host ""
Write-Host "STEP 5: Aligning Expo package versions..." -ForegroundColor Cyan
npx expo install --fix 2>$null
Write-Host "Expo packages aligned." -ForegroundColor Green

# ── Step 6: Verify key packages ───────────────────────────────────────────────
Write-Host ""
Write-Host "STEP 6: Verifying key packages..." -ForegroundColor Cyan

$checks = @(
    "node_modules\expo",
    "node_modules\expo-router",
    "node_modules\react-native",
    "node_modules\expo-linear-gradient",
    "node_modules\react-native-webview",
    "node_modules\socket.io-client"
)

$allGood = $true
foreach ($pkg in $checks) {
    if (Test-Path $pkg) {
        Write-Host "  ✅ $($pkg.Split('\')[1])" -ForegroundColor Green
    } else {
        Write-Host "  ❌ $($pkg.Split('\')[1]) — MISSING" -ForegroundColor Red
        $allGood = $false
    }
}

if (-not $allGood) {
    Write-Host ""
    Write-Host "Some packages missing. Installing..." -ForegroundColor Yellow
    npm install react-native-webview socket.io-client --legacy-peer-deps
    npx expo install expo-linear-gradient expo-router
}

# ── Step 7: Show versions ─────────────────────────────────────────────────────
Write-Host ""
Write-Host "========================================" -ForegroundColor Green
Write-Host "  Environment Summary" -ForegroundColor Green
Write-Host "========================================" -ForegroundColor Green
Write-Host ""

$nodeVersion = node --version
$npmVersion  = npm --version
$expoVersion = node -e "try{console.log(require('./node_modules/expo/package.json').version)}catch(e){console.log('unknown')}" 2>$null
$rnVersion   = node -e "try{console.log(require('./node_modules/react-native/package.json').version)}catch(e){console.log('unknown')}" 2>$null

Write-Host "  Node:          $nodeVersion" -ForegroundColor White
Write-Host "  npm:           $npmVersion"  -ForegroundColor White
Write-Host "  expo:          $expoVersion" -ForegroundColor White
Write-Host "  react-native:  $rnVersion"   -ForegroundColor White
Write-Host ""

# ── Step 8: Check emulator ────────────────────────────────────────────────────
Write-Host "STEP 7: Checking Android emulator..." -ForegroundColor Cyan

$sdkRoot    = "$env:LOCALAPPDATA\Android\Sdk"
$adbExe     = "$sdkRoot\platform-tools\adb.exe"
$emulatorOn = $false

if (Test-Path $adbExe) {
    $devices = & "$adbExe" devices 2>$null
    if ($devices -match "emulator") {
        $emulatorOn = $true
        Write-Host "  Emulator is running ✅" -ForegroundColor Green
    } else {
        Write-Host "  No emulator detected." -ForegroundColor Yellow
        Write-Host "  Starting emulator..." -ForegroundColor White

        $emulatorExe = "$sdkRoot\emulator\emulator.exe"
        if (Test-Path $emulatorExe) {
            $avd = & "$emulatorExe" -list-avds 2>$null | Select-Object -First 1
            if ($avd) {
                Start-Process "$emulatorExe" -ArgumentList "-avd `"$avd`"" -WindowStyle Normal
                Write-Host "  Emulator starting: $avd" -ForegroundColor Green
                Write-Host "  Waiting 30 seconds for boot..." -ForegroundColor Gray
                Start-Sleep -Seconds 30
            } else {
                Write-Host "  No AVD found. Open Android Studio → Device Manager → create one." -ForegroundColor Yellow
            }
        }
    }
} else {
    Write-Host "  Android SDK not found — open emulator manually." -ForegroundColor Yellow
}

# ── Step 9: Start Expo ────────────────────────────────────────────────────────
Write-Host ""
Write-Host "========================================" -ForegroundColor Green
Write-Host "  Starting VaultChat..." -ForegroundColor Green
Write-Host "========================================" -ForegroundColor Green
Write-Host ""
Write-Host "Press 'a' to open on Android emulator." -ForegroundColor Yellow
Write-Host "Press 'r' to reload if needed." -ForegroundColor Yellow
Write-Host ""

npx expo start --clear --android
