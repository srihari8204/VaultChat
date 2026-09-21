// scripts/coldstart.selftest.ts — run: npx tsx scripts/coldstart.selftest.ts
//
// Covers the PARSING half of scripts/coldstart.ts, and only that half.
//
// SCOPE, STATED PLAINLY. No device is touched here and none is needed. What is
// asserted is that the parsers survive the output real handsets actually
// produce — every fixture below was captured verbatim from a physical device or
// emulator, not written from memory of what adb "should" print. The measurement
// itself (does `am start -W` report a truthful TotalTime) is not checkable from
// a checkout and is not claimed here.
//
// WHY IT EXISTS
//
// The hand-rolled version of this measurement read the app uid with
// /userId=(\d+)/ and produced numbers on a Redmi. On an Honor running Android 16
// the same regex matched `userId=100` — a PROFILE id printed above the real
// `uid=10233` — so the socket poll watched a uid that owns nothing, every run
// ran to its 25s timeout, and the output still looked like a measurement. The
// uid fixture below is that exact dumpsys text. A parser that regresses to
// first-match-wins fails here instead of on someone's desk.

const { parseDevices, parseUid, parseLauncher, parseStart, isCold, median } = require('./coldstart.ts');

let failed = 0;
function A(ok: boolean, what: string): void {
  if (ok) { console.log('  ok   ' + what); return; }
  failed++;
  console.log('  FAIL ' + what);
}

console.log('\ncoldstart parsers — against captured device output\n');

// ── 1. device list ────────────────────────────────────────────────────
{
  // Three attached devices, as printed with two physical handsets + an emulator.
  const real = 'List of devices attached\nAWJDVB4702008616\tdevice\nw4eygyinypswrcz9\tdevice\nemulator-5554\tdevice\n';
  A(JSON.stringify(parseDevices(real)) === '["AWJDVB4702008616","w4eygyinypswrcz9","emulator-5554"]',
    '1. all three attached devices are returned, header dropped');

  // A device mid-handshake or with USB debugging unauthorised must NOT be
  // measured: adb accepts the serial and then every shell command fails, which
  // would land as a row of nulls rather than as an error anyone notices.
  const mixed = 'List of devices attached\nGOOD1\tdevice\nBAD1\toffline\nBAD2\tunauthorized\n';
  A(JSON.stringify(parseDevices(mixed)) === '["GOOD1"]',
    '1a. offline and unauthorized devices are excluded');

  const daemon = '* daemon not running; starting now at tcp:5037\n* daemon started successfully\nList of devices attached\nX\tdevice\n';
  A(JSON.stringify(parseDevices(daemon)) === '["X"]', '1b. adb daemon banner lines are not read as devices');
  A(JSON.stringify(parseDevices('List of devices attached\n')) === '[]', '1c. no devices → empty list, not a crash');
  A(JSON.stringify(parseDevices('')) === '[]' && JSON.stringify(parseDevices(null)) === '[]',
    '1d. empty/absent output is tolerated');
}

// ── 2. app uid — the bug this file was written for ────────────────────
{
  // Verbatim from Honor ELI-NX9, Android 16. The profile ids come FIRST.
  const android16 = [
    'Package [com.whatsapp] (7e3f1a):',
    '  userId=100',
    '  userId=10',
    '    uid=10233 gids=[] type=0 prot=signature',
    '    uid=10233 gids=[] type=0 prot=signature',
  ].join('\n');
  A(parseUid(android16) === 10233,
    '2. Android 16: the app uid wins over the profile ids printed above it');

  // Verbatim shape from Redmi Note 8 Pro, Android 11 — here userId= IS the uid.
  const android11 = 'Package [com.vaultchat.app] (c54273b):\n    userId=11396\n    pkg=Package{...}\n';
  A(parseUid(android11) === 11396, '2a. Android 11: userId= carries the app uid and is accepted');

  A(parseUid('  userId=0\n  userId=100\n') === null,
    '2b. a dump with only profile/system ids yields null, never a plausible-looking wrong number');
  A(parseUid('') === null && parseUid(null) === null, '2c. empty dump → null');
}

// ── 3. launcher activity ──────────────────────────────────────────────
{
  const pkg = 'com.whatsapp';
  // Honor/Android 16 wraps the answer in multi-user SecurityException noise on
  // the same stream. The activity line still has to be found in it.
  const noisy = [
    'Error: java.lang.SecurityException: Shell does not have permission to access user 10',
    ' com.android.server.am.ActivityManagerService.handleIncomingUser:15257',
    'Error: java.lang.SecurityException: Shell does not have permission to access user 100',
    'com.whatsapp/.Main',
  ].join('\n');
  A(parseLauncher(noisy, '', pkg) === 'com.whatsapp/.Main',
    '3. the activity is recovered from SecurityException-wrapped output');

  // Old builds have no `cmd package resolve-activity`; dumpsys is the fallback.
  const dumpsys = [
    '      android.intent.action.MAIN:',
    '        c54273b com.vaultchat.app/.MainActivity filter 66ade58',
    '          Action: "android.intent.action.MAIN"',
    '          Category: "android.intent.category.LAUNCHER"',
  ].join('\n');
  A(parseLauncher('', dumpsys, 'com.vaultchat.app') === 'com.vaultchat.app/.MainActivity',
    '3a. with no resolve-activity, the MAIN/LAUNCHER filter block is used');

  A(parseLauncher('', '', 'com.vaultchat.app') === null,
    '3b. nothing resolvable → null, so the caller skips the app instead of launching a guess');

  // A package name is a regex if you forget to escape it: `com.whatsapp` would
  // otherwise also match `comXwhatsapp`, and `com.whatsapp.w4b` lines must not
  // be mistaken for the plain package's activity.
  A(parseLauncher('com.whatsapp.w4b/.Main', '', 'com.whatsapp') === null,
    '3c. a sibling package (w4b) is not accepted as this package\'s activity');
}

// ── 4. am start -W ────────────────────────────────────────────────────
{
  const cold = 'Status: ok\nLaunchState: COLD\nActivity: com.vaultchat.app/.MainActivity\nTotalTime: 1106\nWaitTime: 1110\n';
  const r = parseStart(cold);
  A(r.totalMs === 1106 && r.launchState === 'COLD', '4. TotalTime and LaunchState are read');

  // WaitTime > TotalTime and both present: TotalTime is the one that means
  // "time to first frame", so a parser must not drift onto the larger number.
  A(parseStart(cold).totalMs !== 1110, '4a. WaitTime is not mistaken for TotalTime');

  // Some OEMs omit LaunchState entirely; that must not be read as a warm launch.
  const noState = 'Status: ok\nActivity: com.whatsapp/.Main\nTotalTime: 548\n';
  A(parseStart(noState).totalMs === 548 && parseStart(noState).launchState === null,
    '4b. a missing LaunchState is null, and the timing is still usable');

  A(parseStart('Error: Activity not started, unable to resolve Intent').totalMs === null,
    '4c. a failed launch yields null rather than a zero that averages in');

  // Verbatim from an android-14 emulator (sdk_gphone64_x86_64): NO TotalTime
  // line exists at all, and LaunchState is UNKNOWN. Requiring TotalTime made the
  // run report "no COLD launch captured" five times out of five — output that
  // looks like a device problem and is actually a parser problem.
  const emu = [
    'Stopping: com.vaultchat.app',
    'Starting: Intent { cmp=com.vaultchat.app/.MainActivity }',
    'Status: ok',
    'LaunchState: UNKNOWN (0)',
    'Activity: com.vaultchat.app/.MainActivity',
    'WaitTime: 1548',
    'Complete',
  ].join('\n');
  const e = parseStart(emu);
  A(e.totalMs === 1548 && e.metric === 'WaitTime',
    '4d. emulator with no TotalTime falls back to WaitTime, and says so');
  A(parseStart(cold).metric === 'TotalTime',
    '4e. when TotalTime exists it is preferred and labelled as such');
  A(e.launchState === 'UNKNOWN', '4f. "UNKNOWN (0)" parses to UNKNOWN, not to "(0)"');
}

// ── 5. cold vs warm ───────────────────────────────────────────────────
{
  A(isCold('COLD') === true, '5. COLD counts');
  // UNKNOWN is the platform declining to classify, not evidence of a warm start.
  // We force-stop with -S before every run; rejecting UNKNOWN discards every
  // sample an emulator can ever produce.
  A(isCold('UNKNOWN') === true, '5a. UNKNOWN counts — it is not a warm launch');
  A(isCold(null) === true, '5b. a build that prints no LaunchState still counts');
  A(isCold('WARM') === false && isCold('HOT') === false,
    '5c. WARM and HOT are dropped — the process survived force-stop and would flatter the median');
}

// ── 6. median ─────────────────────────────────────────────────────────
{
  A(median([1006, 1014, 1014, 1018, 1031, 1214]) === 1016, '6. even count averages the middle pair');
  A(median([548, 550, 556, 592, 600]) === 556, '6a. odd count takes the middle');
  A(median([5, 1, 3]) === 3, '6b. input is sorted first, not assumed sorted');
  A(median([]) === null && median(null) === null, '6c. no samples → null, not NaN');
  const input = [3, 1, 2];
  median(input);
  A(JSON.stringify(input) === '[3,1,2]', '6d. the caller\'s array is not sorted in place');
}

console.log(failed
  ? `\n  ${failed} FAILED — a coldstart parser regressed\n`
  : '\n  all coldstart parsers hold against captured device output\n');
process.exit(failed ? 1 : 0);
