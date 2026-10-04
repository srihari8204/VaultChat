// lib/permissionDeadEnd.selftest.ts — run: npx tsx lib/permissionDeadEnd.selftest.ts
//
// A REFUSED PERMISSION MUST LEAVE A WAY FORWARD.
//
// Android stops showing the system dialog after two refusals. request*() then
// returns denied instantly, with no prompt. A screen that answers that with a
// single-OK "Permission needed" alert is a dead end: the next tap runs the same
// code, gets the same silent refusal, and shows the same alert. Nothing the
// user can do inside the app changes the outcome, and nothing tells them that.
//
// Before 17 September, 43 of 45 permission sites were built that way. The fix
// is lib/permissionDenied.ts, which offers "Open settings" exactly when
// canAskAgain is false.
//
// The rule: a file that requests a permission must import permissionDenied, or
// appear in EXEMPT below with a reason. Proximity scanning for "an Alert near a
// permission call" was tried first and is not honest — 'Saved!' and
// 'Location set' sit within a few lines of a permission request and are not
// dead ends — so this checks the import, which is unambiguous.

import fs from 'node:fs';
import path from 'node:path';

let n = 0;
function ok(what: string, cond: boolean): void {
  if (!cond) { console.error('FAIL: ' + what); process.exit(1); }
  n++;
}

function walk(dir: string, out: string[] = []): string[] {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (/[.]tsx?$/.test(e.name) && !e.name.includes('selftest')) out.push(p.split(path.sep).join('/'));
  }
  return out;
}

// Each of these requests a permission and deliberately does NOT alert. The
// reason matters more than the entry: a wrong exemption here reintroduces the
// exact dead end this guard exists to catch.
const EXEMPT: Record<string, string> = {
  'app/permissions.tsx':
    'the dedicated permissions screen — it renders per-permission state as its own UI',
  'app/emergency-sos.tsx':
    'SOS must send WITHOUT a fix rather than stop for a dialog; sosFix() falls back and the screen shows an amber no-location warning',
  'app/notifications.tsx':
    'same SOS path — sends with lat/lng null rather than blocking on a prompt',
  'app/location-lock.tsx':
    'runs in a mount effect, not from a tap; an alert on arrival would fire before the user asked for anything',
  'app/contacts.tsx':
    'already branches on canAskAgain and renders the guidance inline as screen state',
  'app/location.tsx':
    'already has its own permDenied state and openSettings route',
  'components/finance/notify.ts':
    'returns granted to its caller and shows no UI of its own',
  'lib/family/background.ts': 'service layer — returns a boolean to its caller',
  'lib/family/presence.ts': 'service layer — returns a boolean to its caller',
  'lib/lock/background.ts': 'service layer — returns a boolean to its caller',
  'lib/lock/lockService.ts': 'service layer — returns a boolean to its caller',
  'lib/nav/navigationService.ts': 'service layer — returns a boolean to its caller',
  'lib/push.ts': 'service layer — returns a status to its caller',
  'lib/voiceRecorder.ts': 'service layer — returns a boolean to its caller',
  'lib/galleryExport.ts': 'service layer — returns a result to its caller',
  'lib/items/scanner.ts': 'service layer — returns a boolean to its caller',
  'lib/games/useTableVoice.ts': 'surfaces the refusal as hook error state with a Retry',
  // utils/notifications.ts deleted 2026-09-17 — zero importers, and importing it
  // would have silently replaced the global notification handler and added a
  // duplicate 'messages' channel next to lib/push.ts's NOTIF_CHANNELS.
};

const REQUESTS = /request(?:Foreground|Background|Camera|Microphone|MediaLibrary)?PermissionsAsync|PermissionsAndroid[.]request/;

const offenders: string[] = [];
for (const dir of ['app', 'components', 'lib', 'utils']) {
  for (const f of walk(dir)) {
    const src = fs.readFileSync(f, 'utf8');
    if (!REQUESTS.test(src)) continue;
    if (f in EXEMPT) continue;
    if (/permission-exempt:/.test(src)) continue;
    if (src.includes("lib/permissionDenied'")) continue;
    offenders.push(f);
  }
}

ok(
  offenders.length === 0
    ? 'every permission request offers a route out of a refusal'
    : 'permission requests with no way forward when the OS stops asking\n      ' +
        offenders.join('\n      ') +
        '\n      (use permissionDenied from lib/permissionDenied, or add a reason to EXEMPT)',
  offenders.length === 0,
);

// The helper itself is the thing every one of those files depends on, so its
// two branches are asserted directly rather than trusted.
const helper = fs.readFileSync('lib/permissionDenied.ts', 'utf8');
ok('permissionDenied offers Settings when the OS will not ask again', /Linking[.]openSettings[(][)]/.test(helper));
ok('permissionDenied stays a plain notice while canAskAgain is true', /if \(canAskAgain\) \{\s*\n\s*Alert\.alert\(title, body\);/.test(helper));
ok('permissionDenied treats an unknown canAskAgain as cannot-ask', /canAskAgain = false/.test(helper));

// Stale exemptions are their own failure: an entry for a file that no longer
// requests a permission is a reason nobody will re-check.
const stale = Object.keys(EXEMPT).filter(
  (f) => !fs.existsSync(f) || !REQUESTS.test(fs.readFileSync(f, 'utf8')),
);
ok(
  stale.length === 0 ? 'no stale exemptions' : 'EXEMPT lists files that no longer request a permission: ' + stale.join(', '),
  stale.length === 0,
);

console.log(`permissionDeadEnd.selftest: ${n} assertions passed`);
