#!/usr/bin/env node
// @ts-nocheck
/**
 * scripts/device-map-test.js — prove the MAPS AND SPACE SCREENS WORK INSIDE THE
 * APP, on real phones. Runs every connected device by default (both test phones).
 *
 * WHY THIS EXISTS
 * ---------------
 * These screens are WebView pages and deep-linked routes, so tsc, lint and the
 * selftest suite cannot tell you whether anything actually came up on a device.
 * And the app sets FLAG_SECURE, so `screencap` is black — there are no pixels to
 * check, and lowering FLAG_SECURE to get them is never the answer.
 *
 * WHAT PROVES WHAT
 * ----------------
 *   "[NavMap|FamilyMap] basemap provider: <host>"
 *        THE map assertion. Each page posts this from inside map.on('load') — an
 *        event MapLibre fires only after the style has been fetched, parsed and
 *        rendered — so the host named IS the provider that served that map.
 *        Deterministic, and independent of the accessibility tree.
 *        NOTE the log shape: React Native prints console.warn args quoted and
 *        comma-separated, so the line reads
 *            '[NavMap] basemap provider:', 'tiles.openfreemap.org'
 *        A naive \S+ after the colon captures "'," — parse past the punctuation.
 *   "[FamilyMap] any-routing ready"   corroboration: the page reached that same
 *        load handler.
 *   "falling back to Leaflet"         the engine downgraded. With no raster
 *        provider we are allowed to use, that means NO BASEMAP. Must be absent.
 *   FATAL EXCEPTION                   per route, so a crash names its screen.
 *
 * A WebView also publishes its DOM text to the ACCESSIBILITY TREE, so
 * `uiautomator dump` can read a map's own attribution control even on a
 * FLAG_SECURE screen. Kept as corroboration only: MIUI dies intermittently
 * inside ThemeCompatibility, the Honor returns "null root node", and MapLibre's
 * compact attribution collapses behind an (i) button. A check that flakes must
 * SKIP, never FAIL — a device gate scored as a product failure is how a suite
 * stops meaning anything.
 *
 * Usage:
 *   node scripts/device-map-test.js [--no-install] [--serial <id>]
 *                                   [--maps-only | --space-only]
 */
const { execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const ADB = process.env.ADB || path.join(
  process.env.LOCALAPPDATA || '', 'Android', 'Sdk', 'platform-tools',
  process.platform === 'win32' ? 'adb.exe' : 'adb');
const PKG = 'com.vaultchat.app';
const APK = path.join(__dirname, '..', 'android', 'app', 'build', 'outputs', 'apk', 'release', 'app-release.apk');

const ID1 = '00000000-0000-0000-0000-000000000001';
const ID2 = '00000000-0000-0000-0000-000000000002';
// Every space screen takes these as OPTIONAL params; passing a consistent dummy
// set makes each render its real branch instead of a "pick a space" placeholder.
const SP = 'spaceId=' + ID1 + '&name=Test&groupType=school&perms=all&runId=' + ID2;

/** kind 'map'   — assert the basemap provider the app reports.
 *  kind 'space' — assert the screen mounts without crashing.
 *  mapExpected:false — probed on-device: the screen needs a real household or
 *  history on the signed-in account and shows an empty state without one, so its
 *  map legitimately never mounts. Listed anyway, so it starts asserting the day
 *  that data exists. */
const MAP_ROUTES = [
  { label: 'location-lock', route: 'location-lock', kind: 'map', mapExpected: true, settle: 30 },
  { label: 'navigate', route: 'navigate?lat=17.4065&lng=78.4772&name=Test', kind: 'map', mapExpected: true, settle: 30 },
  { label: 'family-map', route: 'family-map?circleId=' + ID1 + '&circleName=Test', kind: 'map', mapExpected: true, settle: 30 },
  { label: 'space-ops-map', route: 'space-ops-map?' + SP, kind: 'map', mapExpected: true, settle: 30 },
  { label: 'family-history', route: 'family-history?circleId=' + ID1 + '&userId=' + ID2 + '&name=Test', kind: 'map', mapExpected: false, settle: 20 },
  { label: 'family', route: 'family', kind: 'map', mapExpected: false, settle: 20 },
];

const SPACE_ROUTES = [
  'space-admin', 'space-attendance', 'space-checkin', 'space-devices',
  'space-incidents', 'space-leave', 'space-overview', 'space-pending',
  'space-people', 'space-roster', 'space-run', 'space-run-driver',
  'space-runs-admin', 'space-tasks', 'space-transport', 'space-visitors',
].map((r) => ({ label: r, route: r + '?' + SP, kind: 'space', settle: 10 }));

const argv = process.argv.slice(2);
const noInstall = argv.includes('--no-install');
const onlySerial = argv.includes('--serial') ? argv[argv.indexOf('--serial') + 1] : null;
const ROUTES = argv.includes('--space-only') ? SPACE_ROUTES
  : argv.includes('--maps-only') ? MAP_ROUTES
    : MAP_ROUTES.concat(SPACE_ROUTES);

const results = [];
const skipped = [];
const check = (dev, name, ok, detail) => {
  results.push({ dev, name, ok });
  console.log('  ' + (ok ? 'PASS' : 'FAIL') + '  ' + name + (detail ? '  — ' + detail : ''));
};
const skip = (dev, name, why) => {
  skipped.push({ dev, name, why });
  console.log('  SKIP  ' + name + '  — ' + why);
};

function adbFor(serial) {
  return (...a) => execFileSync(ADB, ['-s', serial, ...a], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
}

function runDevice(serial, model) {
  const adb = adbFor(serial);
  // Sleep on the DEVICE, inside one adb call — a host-side sleep is just a second
  // clock that can drift from what the phone is actually doing.
  const settle = (s) => adb('shell', 'sleep ' + s);

  /** uiautomator dump, retried. MIUI intermittently dies inside
   *  ThemeCompatibility and the Honor can return "null root node"; a failed dump
   *  also leaves the PREVIOUS ui.xml in place, so every later read would describe
   *  a screen that is no longer there. Delete first, insist it wrote one. */
  const dumpUi = () => {
    for (let i = 0; i < 3; i++) {
      try {
        adb('shell', 'rm', '-f', '/sdcard/vc-ui.xml');
        if (/dumped to/i.test(adb('shell', 'uiautomator', 'dump', '/sdcard/vc-ui.xml'))) {
          return adb('shell', 'cat', '/sdcard/vc-ui.xml');
        }
      } catch { /* these phones throw rather than return non-zero; retry */ }
    }
    return null;
  };

  console.log('\n' + '='.repeat(70) + '\n' + model + '  (' + serial + ')\n' + '='.repeat(70));

  // These phones sleep aggressively, and a sleeping screen makes every dump
  // describe systemui instead of the app. stayon needs no INJECT_EVENTS, which
  // matters because installing revokes that on MIUI.
  try { adb('shell', 'svc', 'power', 'stayon', 'true'); } catch { /* exits non-zero even when it works */ }

  if (!noInstall) {
    if (!fs.existsSync(APK)) throw new Error('no APK — run: tsx scripts/gradlew.ts assembleRelease -PreactNativeArchitectures=arm64-v8a');
    console.log('installing...');
    adb('install', '-r', APK);
    // Verify by md5, never by timestamp: the phones' clocks run minutes behind the
    // host, so a genuinely fresh install can read as stale.
    const local = crypto.createHash('md5').update(fs.readFileSync(APK)).digest('hex');
    const remote = adb('shell', 'md5sum $(pm path ' + PKG + ' | head -1 | sed "s/package://")').trim().split(/\s+/)[0];
    check(serial, model + ': installed APK is the local build (md5)', local === remote, local.slice(0, 12));
  }

  // Warm the process before any assertion: a first launch after an install
  // routinely gets killed mid DB-migration + E2EE init. That is the system, not a
  // defect, and scoring it as one wastes the whole run.
  adb('shell', 'am', 'force-stop', PKG);
  console.log('warming the app...');
  adb('shell', 'monkey', '-p', PKG, '-c', 'android.intent.category.LAUNCHER', '1');
  settle(25);

  // CAN THIS DEVICE EVEN SHOW US APP LOGS? The basemap assertion reads
  // "basemap provider: <host>" out of logcat, so on a device that suppresses
  // third-party logs the check can never pass — and reporting that as a
  // product FAILURE is a lie about the app. Measured on the Honor (ELI-NX9):
  // EMUI returns an essentially empty buffer (1 line total, zero
  // ReactNativeJS) unless logging is enabled in its hidden Project Menu
  // (*#*#2846579#*#* -> Background Settings -> Log settings), while the same
  // APK on the Redmi logs normally and passes every check. The app warmed
  // above always logs something on a device that permits it, so an empty
  // ReactNativeJS buffer here means "cannot observe", not "did not happen".
  let logsVisible = true;
  try {
    logsVisible = /ReactNativeJS/.test(adb('logcat', '-d', '-v', 'brief', '-s', 'ReactNativeJS:V'));
  } catch { logsVisible = false; }
  if (!logsVisible) {
    console.log('  NOTE  this device is not surfacing app logs (ReactNativeJS buffer empty).');
    console.log('        Log-based assertions will SKIP, not fail. On Honor/EMUI enable logging via');
    console.log('        *#*#2846579#*#* -> Project Menu -> Background Settings -> Log settings.');
  }

  let allLog = '';

  for (const r of ROUTES) {
    const name = model + ' ' + r.label;
    console.log('\n' + r.label + ': vaultchat://' + r.route);

    // Force-stop between routes: one modal Alert left over from a previous screen
    // swallows every later deep link, and a dozen screens then fail identically
    // for one reason.
    adb('shell', 'am', 'force-stop', PKG);
    adb('logcat', '-c');
    // Quote the URL for the DEVICE shell — an unquoted & backgrounds the command
    // there and the activity never starts.
    adb('shell', "am start -a android.intent.action.VIEW -d 'vaultchat://" + r.route + "' " + PKG);
    settle(r.settle);

    const log = adb('logcat', '-d', '-v', 'brief', '-s', 'ReactNativeJS:V', 'AndroidRuntime:E');
    allLog += log;

    const focus = adb('shell', 'dumpsys', 'window').match(/mCurrentFocus=\S+ \S+ ([^}]+)/);
    const foreground = !!focus && focus[1].includes(PKG);
    if (!foreground) {
      // Nothing this test can assert around: with input injection revoked there is
      // no way to dismiss whatever stole focus.
      skip(serial, name + ': reached', 'app not foreground (' + (focus ? focus[1].trim() : 'no focus') + ')');
      continue;
    }
    // Per route, so a crash names the screen that caused it.
    check(serial, name + ': mounts without crashing', !/FATAL EXCEPTION/.test(log),
      (log.match(/FATAL EXCEPTION[^\n]*/) || [''])[0].slice(0, 90));

    if (r.kind === 'map') {
      // THE assertion: the app naming the provider that actually served its map.
      // Parse past React Native's quote/comma formatting of console.warn args.
    // One patient re-read before failing: the Honor's first style fetch can
    // outlast the settle (the failure moved between routes across runs while
    // every route passed on retest), and logcat is cumulative — a late report
    // arrives, it does not vanish.
    let mapLog = log;
      let host = (mapLog.match(/basemap provider:[',\s]*([^'\s]+)/) || [])[1] || '';
    if (!host && r.mapExpected) {
      settle(15);
      mapLog = adb('logcat', '-d', '-v', 'brief', '-s', 'ReactNativeJS:V', 'AndroidRuntime:E');
      allLog += mapLog;
        host = (mapLog.match(/basemap provider:[',\s]*([^'\s]+)/) || [])[1] || '';
    }
      if (host) {
        check(serial, name + ': basemap = OpenFreeMap',
          /openfreemap/i.test(host) && !/carto/i.test(host), host);
      } else if (r.mapExpected && !logsVisible) {
        // Cannot observe. The a11y corroboration below still runs, so a real
        // regression is not invisible — it just is not THIS check's to claim.
        skip(serial, name + ': basemap', 'device does not surface app logs — see NOTE above');
      } else if (r.mapExpected) {
        check(serial, name + ': basemap = OpenFreeMap', false, 'no basemap report — the map never finished loading');
      } else {
        skip(serial, name + ': basemap', 'screen shows an empty state on this account (no household/history data)');
      }
    }

    // Corroboration only, from the accessibility tree.
    const ui = dumpUi() || '';
    if (!ui) {
      skip(serial, name + ': screen content readable', 'accessibility dump unavailable on this device');
    } else {
      const texts = (ui.match(/text="[^"]+"/g) || []).length;
      check(serial, name + ': rendered content', texts > 0, texts + ' text nodes');
      const attrib = (ui.match(/text="([^"]*(?:OpenFreeMap|OpenMapTiles|CARTO)[^"]*)"/) || [])[1];
      if (attrib) {
        check(serial, name + ': on-screen attribution agrees',
          /OpenFreeMap|OpenMapTiles/.test(attrib) && !/CARTO/.test(attrib), attrib);
      }
    }
  }
  try { adb('shell', 'rm', '-f', '/sdcard/vc-ui.xml'); } catch { /* best effort */ }

  fs.writeFileSync(path.join(os.tmpdir(), 'vc-device-test-' + serial + '.log'), allLog);
  console.log('');
  check(serial, model + ': MapLibre stayed up (no basemap-less Leaflet fallback)',
    !/falling back to Leaflet/.test(allLog),
    (allLog.match(/falling back to Leaflet[^\n]*/) || [''])[0].slice(0, 110));
  if (/any-routing/.test(allLog)) {
    check(serial, model + ': any-routing reports ready', /any-routing ready/.test(allLog),
      /any-routing FAILED/.test(allLog) ? 'routing bundle reported FAILED' : '');
  }
}

function main() {
  const raw = execFileSync(ADB, ['devices', '-l'], { encoding: 'utf8' });
  // Anchor on "<serial> device" — a loose /device/ match also hits the header and
  // the `device:` field, which is how a two-phone run silently became one phone.
  let devices = raw.split('\n').slice(1)
    .map((l) => l.match(/^(\S+)\s+device\s/))
    .filter(Boolean)
    .map((m) => ({
      serial: m[1],
      model: ((raw.split('\n').find((l) => l.startsWith(m[1])).match(/model:(\S+)/) || [])[1] || 'device').replace(/_/g, ' '),
    }));
  if (onlySerial) devices = devices.filter((d) => d.serial === onlySerial);
  if (!devices.length) throw new Error('no devices attached');

  console.log('testing ' + devices.length + ' device(s): ' + devices.map((d) => d.model + ' (' + d.serial + ')').join(', '));
  console.log('routes: ' + ROUTES.length + ' per device');
  // One phone dropping off USB must not destroy the other's results. These
  // handsets disconnect mid-run in practice (observed repeatedly: an `adb
  // shell sleep` simply fails), and an unguarded throw here abandoned the
  // WHOLE matrix — including the device that was working perfectly. Each
  // device is isolated now, and a lost one is reported as a device fault.
  const lost = [];
  for (const d of devices) {
    try {
      runDevice(d.serial, d.model);
    } catch (e) {
      lost.push(d);
      console.log('  LOST  ' + d.model + ' (' + d.serial + ') disconnected mid-run — '
        + String((e && e.message) || e).split(String.fromCharCode(10))[0].slice(0, 100));
      console.log('        Its results are PARTIAL. Reseat the cable and re-run with --serial ' + d.serial + '.');
    }
  }

  const failed = results.filter((r) => !r.ok);
  console.log('\n' + '='.repeat(70));
  for (const d of devices) {
    const mine = results.filter((x) => x.dev === d.serial);
    const bad = mine.filter((x) => !x.ok).length;
    const sk = skipped.filter((x) => x.dev === d.serial).length;
    console.log('  ' + d.model + ': ' + (mine.length - bad) + '/' + mine.length + ' passed, ' + sk + ' skipped');
  }
  if (lost.length) {
    console.log('  ' + lost.length + ' DEVICE(S) LOST MID-RUN: ' + lost.map((d) => d.model).join(', ')
      + ' — that coverage is incomplete, not clean.');
  }
  if (failed.length) {
    console.log('\n' + failed.length + ' CHECK(S) FAILED:');
    for (const f of failed) console.log('  - ' + f.name);
  } else {
    // Never claim a clean sweep when a device was lost — partial coverage
    // reported as success is the exact failure this script exists to prevent.
    console.log(lost.length
      ? '\nNO CHECK FAILED — but coverage is INCOMPLETE (see LOST above)'
      : '\nALL DEVICE CHECKS PASSED');
  }
  // A lost device must NOT exit 0 — that would read as full coverage.
  process.exit(failed.length || lost.length ? 1 : 0);
}

try { main(); } catch (e) { console.error('device-map-test: ' + e.message); process.exit(2); }
