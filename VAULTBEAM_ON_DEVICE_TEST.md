# VaultBeam On-Device Validation Tests

Run these tests directly on the device to validate VaultBeam seamless transfer functionality.

## Pre-Test Checklist

- [ ] Device: Android 14+ (Android 15 for full user-initiated job test)
- [ ] App: VaultChat installed (check: Settings > Apps > VaultChat)
- [ ] Storage: At least 500 MB free space
- [ ] Network: Both WiFi and mobile data available
- [ ] Time: 30 minutes for full test suite

---

## Test 1: Transfer Initiation (P2P Direct)

**Scenario:** Send file from this device to another device on same WiFi network

**Steps:**
1. Open VaultChat
2. Tap Contacts or Find person
3. Select a contact (or create test account)
4. Tap "+" to send file
5. Select a small file (< 100 MB) from device storage
6. Tap "Send via VaultChat Transfer"

**Expected Result:**
- ✓ Status bar shows "Transferring... [0%]"
- ✓ Notification appears with progress
- ✓ Transfer completes within 10 seconds (local network)
- ✓ Recipient receives file

**Evidence:**
- Take screenshot of progress bar
- Note transfer duration
- Verify file on recipient device

---

## Test 2: Seamless Resume (App Restart)

**Scenario:** Verify transfer resumes from checkpoint after app restart

**Steps:**
1. Start transfer of medium file (100-500 MB)
2. Wait for transfer to reach 30-50% progress
3. **Force stop app:** Settings > Apps > VaultChat > Force Stop
4. Wait 5 seconds
5. Reopen VaultChat
6. **Do NOT retry the transfer**—observe what happens

**Expected Result:**
- ✓ App opens to transfer screen
- ✓ Progress shows previous checkpoint (not 0%)
- ✓ Transfer resumes automatically
- ✓ No file re-upload from beginning
- ✓ Final progress = 100%

**What NOT to see:**
- ✗ Progress bar reset to 0%
- ✗ "Preparing transfer..." message
- ✗ Re-signing or re-negotiation delay

**Evidence:**
- Screenshot before force stop (note % and timestamp)
- Screenshot after reopen (note % is same or higher)
- Note final completion time

---

## Test 3: Seamless Resume (Network Switch)

**Scenario:** Verify transfer survives switching from WiFi to mobile (or vice versa)

**Steps:**
1. Start transfer on WiFi (medium file, 100-500 MB)
2. Wait for transfer to reach 20% progress
3. Turn OFF WiFi (Settings > WiFi > Toggle OFF)
4. Wait 3-5 seconds
5. Observe transfer status

**Expected Result:**
- ✓ Transfer does NOT stop
- ✓ Auto-fallback to relay (may slow down)
- ✓ Progress continues (no reset)
- ✓ Notification still shows progress
- ✓ Transfer completes (may take longer)

**Timing:**
- WiFi transfer: ~2-5 seconds (100 MB)
- Relay fallback: ~10-30 seconds (100 MB)

**Evidence:**
- Screenshot before WiFi toggle
- Screenshot after WiFi toggle (show fallback relay notice)
- Note before/after speeds

---

## Test 4: Durability Watermark (Crash Recovery)

**Scenario:** Verify progress survives app crash mid-transfer

⚠️ **WARNING:** This test force-kills the app. Only run if transfer is > 50 MB.

**Steps:**
1. Start transfer of large file (500 MB+)
2. Wait for transfer to reach 40-60% progress
3. **From ADB (on computer):** `adb shell am force-stop com.vaultchat.app`
   - OR: Go to Settings > Apps > VaultChat > Force Stop
4. Wait 10 seconds
5. Reopen app (tap icon)

**Expected Result:**
- ✓ App restarts cleanly
- ✓ Transfer shows checkpoint (not 0%)
- ✓ No "corrupted" or "error" message
- ✓ Resume option appears (or auto-resumes)
- ✓ Transfer completes without losing progress

**Evidence:**
- Screenshot of progress % before kill
- Screenshot of progress % after restart
- Verify checkpoint was preserved

---

## Test 5: Cancellation Cleanup

**Scenario:** Verify cancel doesn't leave orphaned files

**Steps:**
1. Start transfer of medium file (100-500 MB)
2. Wait for 30% progress
3. Tap Cancel or swipe up to dismiss transfer
4. Open Files app (or Storage)
5. Navigate to Downloads or VaultChat transfer cache
6. Look for partially downloaded files

**Expected Result:**
- ✓ Cancelled transfer stops immediately
- ✓ No ".tmp" or partial files left behind
- ✓ Storage is clean (no orphaned fragments)
- ✓ File size is 0 KB or file doesn't exist

**What NOT to see:**
- ✗ Large ".tmp" or ".partial" file
- ✗ Half-sized version of original file
- ✗ "corrupted" file marker

**Evidence:**
- Screenshot of file cache before/after cancel

---

## Test 6: Android 15 User-Initiated Job

**Scenario:** Verify transfer runs in foreground job (Android 15+ only)

**Requirements:** Android 15+ device

**Steps:**
1. Start transfer of large file (1+ GB)
2. Wait for transfer to start
3. Open **Settings > Apps & Notifications > Notifications**
4. Look for "VaultChat Transfers" notification with progress
5. Swipe up from bottom: Open **Recent Apps**
6. Long-press VaultChat icon
7. Tap **"App info"** → **Notifications & Permissions**

**Expected Result (Android 15+):**
- ✓ Notification shows "Transferring..." with progress bar
- ✓ Foreground service active (Settings > Running Apps shows VaultChat)
- ✓ Notification can be expanded to show speed (MB/s)
- ✓ Killing app stops notification
- ✓ Restarting app resumes from checkpoint

**Expected Result (Android 14 and below):**
- ✓ Transfer uses dataSync service (older API)
- ✓ Still shows progress in notification
- ✓ Still resumes from checkpoint on restart

**Evidence:**
- Screenshot of notification with progress bar
- Screenshot of Settings > Running Apps (shows VaultChat service)

---

## Test 7: Memory & Performance

**Scenario:** Verify transfer doesn't crash with large files

**Steps:**
1. Check available RAM: Settings > About Phone > Available Memory
2. Start transfer of very large file (size = 50% of available RAM)
   - Example: If device has 4 GB RAM, transfer 2 GB file
3. Transfer should run continuously for 30+ seconds
4. Monitor device responsiveness

**Expected Result:**
- ✓ Transfer progresses at expected speed
- ✓ Device remains responsive (can open other apps)
- ✓ No OOM (Out of Memory) crash
- ✓ No "Low Memory" warnings
- ✓ Battery usage remains normal

**What NOT to see:**
- ✗ App crash after 30-60 seconds
- ✗ "Unfortunately VaultChat has stopped" error
- ✗ Device becomes unresponsive
- ✗ System reboot or restart

**Evidence:**
- Screenshot of Settings > Apps > VaultChat > Memory usage during transfer
- Note transfer speed (MB/s) remained constant

---

## Test 8: Fallback Transports

**Scenario:** Verify relay works when P2P unavailable

**Steps:**
1. Open Settings > WiFi
2. Disconnect from WiFi network (turn OFF WiFi)
3. If possible, disable mobile data or switch to metered WiFi
4. Start transfer to a contact (force relay-only mode)
5. Observe transfer behavior

**Expected Result:**
- ✓ Transfer initiates via relay (slower but works)
- ✓ Notification shows "Using secure relay"
- ✓ Transfer completes (may take 5-30 seconds per 100 MB)
- ✓ No error message about "unavailable transport"

**Evidence:**
- Screenshot showing relay being used
- Note relay speed vs P2P speed

---

## Test 9: Metrics & Dashboard

**Scenario:** Verify canary metrics are recorded (production only)

**Steps:**
1. Complete at least 3 transfers (any size)
2. Wait 1 minute
3. Contact VaultChat ops: Ask to check `/internal/metrics`
4. Look for counters:
   - `vaultbeam_started_v2` — should increment by 3
   - `vaultbeam_completed_v2` — should be 3
   - `vaultbeam_staged_blocks_v2` — ratio should be < v1 cohort

**Expected Result:**
- ✓ All counters increase
- ✓ Dashboard shows v2 cohort separate from v1
- ✓ v2 staged_blocks ratio < v1 ratio (proving seamless resume is working)

**Evidence:**
- Screenshot of dashboard metrics
- Note device in v2 cohort (not v1 legacy)

---

## Test 10: Kill Switch Verification

**Scenario:** Verify VB_ENABLED kill switch prevents transfers

**Steps (Operator Only):**
1. In Firebase Console: Navigate to Remote Config
2. Set `VB_ENABLED` = `false`
3. Force app refresh (kill and reopen VaultChat)
4. Try to start a new transfer

**Expected Result:**
- ✓ "Transfer unavailable" or "Service disabled" message
- ✓ Transfer button is disabled/grayed out
- ✓ No transfer attempted
- ✓ Set `VB_ENABLED` = `true` again to re-enable

**Evidence:**
- Screenshot with kill switch OFF (transfer disabled)
- Screenshot with kill switch ON (transfer available)

---

## Troubleshooting

### Transfer won't start
- [ ] Check network is available (WiFi or mobile data)
- [ ] Check recipient device is online
- [ ] Check recipient has same VaultChat version
- [ ] Check storage has free space (minimum 500 MB)
- [ ] Force stop app and restart

### Transfer stalls or hangs
- [ ] Switch network: turn off WiFi, use mobile (tests fallback)
- [ ] Check if recipient is still connected
- [ ] Check CPU/RAM not maxed out (Settings > Apps > VaultChat)
- [ ] Cancel and retry (should resume if supported)

### Progress bar doesn't update
- [ ] Wait 5 seconds (updates every few seconds)
- [ ] Check notification if transfer is in background
- [ ] Verify file size is reasonable (not a tiny file that completes too fast)

### Crashes or errors
- [ ] Note exact error message
- [ ] Collect logs: `adb logcat | grep -i vaultbeam` (on computer)
- [ ] Report with device model, Android version, file size

---

## Final Checklist

After completing all tests:

- [ ] Test 1: Initiation ✓
- [ ] Test 2: Resume (app restart) ✓
- [ ] Test 3: Resume (network switch) ✓
- [ ] Test 4: Durability (crash recovery) ✓
- [ ] Test 5: Cancellation cleanup ✓
- [ ] Test 6: Android 15 job (if applicable) ✓
- [ ] Test 7: Memory & performance ✓
- [ ] Test 8: Fallback to relay ✓
- [ ] Test 9: Metrics recorded ✓
- [ ] Test 10: Kill switch (operator) ✓

---

## Report Results

Once testing is complete, provide:

1. **Device info:**
   - Model: [e.g., Pixel 8 Pro]
   - Android version: [e.g., 15]
   - RAM: [e.g., 12 GB]

2. **Transfer stats:**
   - Total tests: [#]
   - Passed: [#]
   - Failed: [#]

3. **Notable findings:**
   - Any crashes or errors: [list]
   - Performance observations: [notes]
   - Network fallback working: [yes/no]

4. **Go/No-Go:**
   - Ready for production rollout: [YES/NO]
   - Blocking issues: [none/list]

---

**Estimated test time: 30-45 minutes**  
**Required for production launch: ALL TESTS PASS**
