// @ts-nocheck
// scripts/coldstart.ts — cold-start + time-to-first-connection, every attached device.
//
//   tsx scripts/coldstart.ts                        all devices, VaultChat only
//   tsx scripts/coldstart.ts --vs com.whatsapp      compare against another app
//   tsx scripts/coldstart.ts --runs 8 --net         more runs, plus network timing
//   tsx scripts/coldstart.ts --device <serial>      one device
//   tsx scripts/coldstart.ts --json out.json        machine-readable too
//
// WHY THIS EXISTS, AND WHAT IT IS NOT
//
// Cold start was first measured by hand on two handsets, with the launcher
// activity and the app uid typed in as literals. Both are device-specific, and
// both were WRONG on the second phone the moment it was tried: `dumpsys package`
// on Android 16 prints `userId=100` (a PROFILE id) above the real `uid=10233`,
// so a uid scraped with the obvious regex measured sockets belonging to nobody
// and every run sat there until it timed out. That class of bug is the reason
// this file exists — not to save typing, but so a third device cannot quietly
// produce numbers that look fine and mean nothing.
//
// WHAT IS MEASURED, STATED PLAINLY:
//
//   cold ms   `am start -W -S` TotalTime — time to the FIRST FRAME. For an
//             Expo/RN app that frame is the SPLASH, not your content. It is
//             comparable between two apps only if both draw real content in
//             their first frame, which WhatsApp roughly does and VaultChat does
//             not. Read it as a floor, never as "time to usable". Builds that
//             print no TotalTime (emulators, some OEMs) fall back to WaitTime,
//             which the row and the JSON both label — the two are close but not
//             the same number, so rows carrying different metrics are never
//             compared against each other.
//
//   conn ms   launch → the app's first ESTABLISHED non-loopback TCP socket,
//             polled on-device from /proc/net/tcp{,6} filtered by uid. That is
//             the first connection of ANY kind (push, analytics, chat socket);
//             it does not prove the chat transport specifically came up.
//
//             NOT AVAILABLE EVERYWHERE. Android 10+ restricts /proc/net/tcp to
//             the caller's own sockets and OEMs differ on how strictly: MIUI 11
//             and Honor's Android 16 still list other uids, a stock android-14
//             emulator lists none. Where they are hidden the row says so rather
//             than reporting a timeout, because "the app never connected" and
//             "I am not allowed to see whether it connected" are different
//             facts and only one of them is about the app.
//
// Time-to-content is NOT measured here, and cannot be from outside the app:
// nothing calls reportFullyDrawn(). lib/perf.ts logs the boot_* marks in release
// builds, so `adb logcat -s ReactNativeJS` alongside this is how you get it.
//
// The parsing helpers are exported and covered by scripts/coldstart.selftest.ts
// against captured real-device output. Importing this file touches no device.

const { execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const PKG = 'com.vaultchat.app';

// ── pure helpers (scripts/coldstart.selftest.ts covers these) ───────────

/** Serials in state `device`. Skips the header, offline and unauthorized rows. */
function parseDevices(out) {
  return String(out || '').split('\n').slice(1)
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('*'))
    .map((l) => l.split(/\s+/))
    .filter((p) => p[1] === 'device')
    .map((p) => p[0]);
}

/**
 * App uid from `dumpsys package <pkg>`.
 *
 * Android 16 prints `userId=100` and `userId=10` (profile ids) above the real
 * `uid=10233`, so first-match-wins on `userId=` silently picks a profile. App
 * uids are >= 10000 — the WIDTH requirement, not the key name, is what makes
 * this portable across OEMs.
 */
function parseUid(out) {
  const m = String(out || '').match(/\b(?:userId|uid)=(\d{5,})\b/);
  return m ? Number(m[1]) : null;
}

/**
 * Launcher activity as `pkg/.Activity`, from either source.
 *
 * `cmd package resolve-activity --brief` is the clean path but is missing on
 * older builds and, on some OEMs, is wrapped in SecurityException noise — hence
 * the dumpsys fallback, which reads the MAIN/LAUNCHER filter block directly.
 */
function parseLauncher(resolveOut, dumpsysOut, pkg) {
  const esc = pkg.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const brief = String(resolveOut || '').split('\n')
    .map((l) => l.trim())
    .filter((l) => new RegExp('^' + esc + '/[\\w./$]+$').test(l));
  if (brief.length) return brief[brief.length - 1];

  const lines = String(dumpsysOut || '').split('\n');
  const main = lines.findIndex((l) => l.includes('android.intent.action.MAIN'));
  if (main < 0) return null;
  for (const l of lines.slice(main, main + 6)) {
    const m = l.match(new RegExp('(' + esc + '/[\\w./$]+)'));
    if (m) return m[1];
  }
  return null;
}

/**
 * Timing + LaunchState out of `am start -W`. Missing fields come back null.
 *
 * NOT every build prints TotalTime. An android-14 emulator prints only
 * `WaitTime: 1548` and `LaunchState: UNKNOWN (0)` — no TotalTime line at all —
 * so a parser that requires TotalTime silently reports "no COLD launch
 * captured" on every emulator and on the OEM builds that behave the same way.
 * WaitTime is therefore accepted as a fallback and the row says which metric it
 * is, because WaitTime also covers the starting-window teardown and is NOT the
 * same number: the two must never be averaged together or compared as equals.
 */
function parseStart(out) {
  const s = String(out || '');
  const total = s.match(/^TotalTime:\s*(\d+)/m);
  const wait = s.match(/^WaitTime:\s*(\d+)/m);
  const state = s.match(/^LaunchState:\s*(\w+)/m);
  return {
    totalMs: total ? Number(total[1]) : (wait ? Number(wait[1]) : null),
    metric: total ? 'TotalTime' : (wait ? 'WaitTime' : null),
    launchState: state ? state[1] : null,
  };
}

/**
 * Did this launch actually start from a dead process?
 *
 * WARM/HOT mean the process outlived `force-stop` (OEM keep-alive, foreground
 * service) and the run would flatter the median. UNKNOWN is NOT warm — it is
 * the platform declining to classify, which is what emulators report for every
 * launch; rejecting it throws away every sample on those devices.
 */
function isCold(launchState) {
  return launchState !== 'WARM' && launchState !== 'HOT';
}

/** Median of a numeric list; null when empty. Even counts average the middle pair. */
function median(xs) {
  if (!xs || !xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 ? s[mid] : Math.round((s[mid - 1] + s[mid]) / 2);
}

module.exports = { parseDevices, parseUid, parseLauncher, parseStart, isCold, median };

// ── everything below needs a device, and runs only under require.main ───

// Device-side loop: launch, then poll the app's own sockets. A host round-trip
// costs 30-80 ms, which would swamp the thing being measured — so the timing
// happens on the device and only the answer crosses the wire.
const NET_SH = `#!/system/bin/sh
PKG=$1; ACT=$2; U=$3
am force-stop $PKG >/dev/null 2>&1
sleep 3
T0=$(date +%s%N)
am start -n $ACT >/dev/null 2>&1
while :; do
  NOW=$(date +%s%N); MS=$(( (NOW-T0)/1000000 ))
  if cat /proc/net/tcp /proc/net/tcp6 2>/dev/null | awk -v u=$U '$4=="01" && $8==u && $3!~/^0100007F/ && $3!~/^0{32}/ {f=1} END{exit !f}'; then
    echo "CONN $MS"; break
  fi
  if [ $MS -gt 25000 ]; then
    # Android 10+ restricts /proc/net/tcp to the caller's own sockets, and how
    # far that goes is OEM-dependent: MIUI 11 and Honor's Android 16 still list
    # other uids, a stock android-14 emulator lists almost nothing. If no app
    # uid (>=10000) appears at all, the kernel is hiding them and this is NOT a
    # slow app -- reporting it as a timeout would be a measurement that lies.
    if cat /proc/net/tcp /proc/net/tcp6 2>/dev/null | awk '$8+0 >= 10000 {f=1} END{exit !f}'; then
      echo "CONN TIMEOUT"
    else
      echo "CONN HIDDEN"
    fi
    break
  fi
done
am force-stop $PKG >/dev/null 2>&1
`;

/** adb from PATH, else the standard SDK locations. Returns null, never exits. */
function findAdb() {
  const home = process.env.ANDROID_HOME || process.env.ANDROID_SDK_ROOT
    || path.join(os.homedir(), 'AppData', 'Local', 'Android', 'Sdk');
  const exe = 'adb' + (process.platform === 'win32' ? '.exe' : '');
  for (const c of ['adb', path.join(home, 'platform-tools', exe)]) {
    try { execFileSync(c, ['version'], { stdio: 'pipe' }); return c; } catch { /* next candidate */ }
  }
  return null;
}

function main() {
  const ADB = findAdb();
  if (!ADB) {
    console.error('adb not found — put platform-tools on PATH or set ANDROID_HOME.');
    process.exit(1);
  }

  // Never throws: OEM shells write SecurityException noise and exit nonzero even
  // when the output we want is present, so the output is what gets returned.
  const adb = (serial, args, timeout = 60000) => {
    try {
      return execFileSync(ADB, ['-s', serial, ...args], { encoding: 'utf8', timeout, stdio: 'pipe' });
    } catch (e) {
      return String((e.stdout || '') + (e.stderr || ''));
    }
  };
  const sh = (serial, cmd, timeout) => adb(serial, ['shell', cmd], timeout);
  const prop = (serial, p) => sh(serial, 'getprop ' + p).trim();
  // Synchronous sleep, no child process. The script is sequential by design:
  // two apps launching at once on one device is not a cold start.
  const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

  const argv = process.argv.slice(2);
  const flag = (name, dflt) => {
    const i = argv.indexOf('--' + name);
    return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : dflt;
  };
  const RUNS = Math.max(1, Number(flag('runs', 6)) || 6);
  const WANT_NET = argv.includes('--net');
  const ONLY = flag('device', null);
  const JSON_OUT = flag('json', null);
  const VS = flag('vs', null);
  const PKGS = VS ? [PKG, VS] : [PKG];

  const appInfo = (serial, pkg) => {
    const dump = sh(serial, `dumpsys package ${pkg}`, 90000);
    if (!/versionName=|android\.intent\.action\.MAIN/.test(dump)) return null;
    const activity = parseLauncher(sh(serial, `cmd package resolve-activity --brief ${pkg}`), dump, pkg);
    if (!activity) return null;
    const v = dump.match(/versionName=(\S+)/);
    return { pkg, activity, uid: parseUid(dump), version: v ? v[1] : '?' };
  };

  const coldRuns = (serial, app) => {
    const times = [];
    let warmed = 0;
    let metric = null;
    for (let i = 0; i < RUNS; i++) {
      sh(serial, `am force-stop ${app.pkg}`);
      sleep(2000);
      const r = parseStart(sh(serial, `am start -W -S -n ${app.activity}`, 90000));
      if (!isCold(r.launchState)) { warmed++; sleep(3000); continue; }
      if (r.totalMs != null) { times.push(r.totalMs); metric = r.metric; }
      sleep(3000);
    }
    sh(serial, `am force-stop ${app.pkg}`);
    return { times, warmed, metric };
  };

  const pushNetScript = (serial) => {
    const local = path.join(os.tmpdir(), 'vc-coldnet.sh');
    fs.writeFileSync(local, NET_SH, { encoding: 'utf8' });
    const remote = '/data/local/tmp/vc-coldnet.sh';
    adb(serial, ['push', local, remote]);
    sh(serial, `chmod 755 ${remote}`);
    return remote;
  };

  // Returns ms, or the string 'timeout'/'no-uid' — never a bare null that the
  // row would then silently omit. An app that never connects is a RESULT, and
  // printing nothing for it is how a broken measurement passes for a clean one.
  const netRun = (serial, app, remote) => {
    if (app.uid == null) return 'no-uid';
    // 180s, not the device-side 25s cap: an emulator under load forks `cat |
    // awk` far slower than a handset, and a host timeout mid-probe reads as a
    // result rather than as the tooling giving up.
    const out = sh(serial, `sh ${remote} ${app.pkg} ${app.activity} ${app.uid}`, 180000);
    const m = out.match(/^CONN (\d+)$/m);
    if (m) return Number(m[1]);
    if (/^CONN HIDDEN$/m.test(out)) return 'hidden';
    return /^CONN TIMEOUT$/m.test(out) ? 'timeout' : 'no-reading';
  };

  let list = '';
  try { list = execFileSync(ADB, ['devices'], { encoding: 'utf8' }); } catch { list = ''; }
  const devices = parseDevices(list).filter((d) => !ONLY || d === ONLY);

  if (!devices.length) {
    console.error(ONLY ? `device ${ONLY} is not attached` : 'no devices attached (check: adb devices)');
    process.exit(1);
  }

  console.log(`\ncold start — ${devices.length} device(s), ${RUNS} runs each${WANT_NET ? ', +network' : ''}\n`);
  const report = [];

  for (const serial of devices) {
    const dev = {
      serial,
      model: prop(serial, 'ro.product.model') || '?',
      brand: prop(serial, 'ro.product.brand') || '?',
      release: prop(serial, 'ro.build.version.release') || '?',
      sdk: prop(serial, 'ro.build.version.sdk') || '?',
      abi: prop(serial, 'ro.product.cpu.abi') || '?',
      apps: [],
    };
    console.log(`${dev.brand} ${dev.model} — android ${dev.release} (sdk ${dev.sdk}, ${dev.abi}) — ${serial}`);

    const remote = WANT_NET ? pushNetScript(serial) : null;

    for (const pkg of PKGS) {
      const app = appInfo(serial, pkg);
      if (!app) { console.log(`  ${pkg.padEnd(22)} not installed — skipped`); continue; }

      const { times, warmed, metric } = coldRuns(serial, app);
      const row = {
        ...app,
        runs: times,
        coldMedian: median(times),
        coldMin: times.length ? Math.min(...times) : null,
        coldMax: times.length ? Math.max(...times) : null,
        metric,
        warmedSkipped: warmed,
        connMs: remote ? netRun(serial, app, remote) : null,
      };
      dev.apps.push(row);

      if (!times.length) {
        console.log(`  ${pkg.padEnd(22)} no cold launch captured (${warmed} warm/hot) — is the device unlocked?`);
        continue;
      }
      console.log(
        `  ${pkg.padEnd(22)} v${String(row.version).padEnd(9)}`
        + ` cold ${String(row.coldMedian).padStart(5)} ms (${row.coldMin}-${row.coldMax}, n=${times.length}${metric === 'WaitTime' ? ', WaitTime' : ''})`
        + (typeof row.connMs === 'number' ? `   first conn ${String(row.connMs).padStart(5)} ms`
          : row.connMs === 'timeout' ? '   first conn none in 25s'
            : row.connMs === 'hidden' ? '   first conn n/a (kernel hides app sockets)'
            : row.connMs === 'no-uid' ? '   first conn n/a (uid unreadable)'
              : row.connMs === 'no-reading' ? '   first conn no reading (probe did not return)'
                : row.connMs ? `   first conn ${row.connMs}` : '')
        + (warmed ? `   [${warmed} non-cold dropped]` : ''),
      );
    }
    report.push(dev);
    console.log('');
  }

  for (const d of report) {
    const mine = d.apps.find((a) => a.pkg === PKG);
    const other = d.apps.find((a) => a.pkg !== PKG);
    if (mine && other && mine.coldMedian && other.coldMedian && mine.metric === other.metric) {
      console.log(`${d.model}: VaultChat ${(mine.coldMedian / other.coldMedian).toFixed(2)}x ${other.pkg}`
        + ` to first frame (${mine.coldMedian} vs ${other.coldMedian} ms)`
        + ' — both SPLASH-to-frame, not time-to-content');
    }
  }

  if (JSON_OUT) {
    fs.writeFileSync(JSON_OUT, JSON.stringify({ at: new Date().toISOString(), runs: RUNS, devices: report }, null, 2));
    console.log(`\nwrote ${JSON_OUT}`);
  }
  console.log('');
}

if (require.main === module) main();
