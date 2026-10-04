// lib/gateReentry.selftest.ts — a visit to '/' after the launch gate decided
// must never sit on the splash.
//
// Round-4 regression: the launch scan REPLACED /app-lock (or /onboard) with
// /blocked, so after a clean "Check again" there was nothing to go back to.
// /blocked replaced onto '/', app/index.tsx awaited launchAllowed — `false`
// for that launch, and it settles once per process — and returned without
// routing. The user was left on the logo with a spinner and no retry.
//
// Pinned here: the decision (lib/pendingLink.splashNext / edgeAfterReset), the
// state the root gate and resetTo record, and the wiring in the four files.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { authEdge, edgeAfterReset, noteAuthEdge, splashNext } from './pendingLink';

let failures = 0;
function ok(label: string, cond: boolean, detail?: string) {
  if (!cond) failures++;
  console.log(`  ${cond ? '✓' : '✗'} ${label}${cond || !detail ? '' : `  (${detail})`}`);
}

console.log('gateReentry — routing a visit to "/" after the launch gate\n');

console.log('The cold-start visit (before the gate decided):');
ok('allowed → route on into the app', splashNext(true, true, null) === 'route');
ok('refused → wait: the root has already replaced this screen', splashNext(false, true, '/app-lock') === 'wait');
ok('…even before the edge is recorded', splashNext(false, true, null) === 'wait');

console.log('\nA later visit (blocked\'s exit, a bare app link):');
ok('launch sent to the lock → back to the lock, not the splash',
  splashNext(false, false, '/app-lock') === '/app-lock');
ok('launch sent to sign-in → back to sign-in', splashNext(false, false, '/onboard') === '/onboard');
ok('refused launch, but an unlock has since crossed the user in → route on',
  splashNext(false, false, null) === 'route');
ok('allowed launch, then signed out → sign-in, not Chats',
  splashNext(true, false, '/onboard') === '/onboard');
ok('allowed launch, still inside → route on', splashNext(true, false, null) === 'route');
ok('never "wait" on a later visit (that is the dead end)',
  [true, false].every(a => ['/app-lock', '/onboard', null].every(e => splashNext(a, false, e) !== 'wait')));

console.log('\nWhat a resetTo records:');
ok('into the tabs → inside', edgeAfterReset('/(tabs)/chats') === null);
ok('another in-app screen → inside', edgeAfterReset('/import-chats') === null);
ok('sign-out → /onboard', edgeAfterReset('/onboard') === '/onboard');
ok('a sign-in step with a query is still the edge',
  edgeAfterReset('/mpin-entry?userId=u1') === '/mpin-entry?userId=u1');

console.log('\nThe recorded state:');
ok('no edge at load', authEdge() === null);
noteAuthEdge('/app-lock');
ok('the gate\'s redirect is recorded', authEdge() === '/app-lock');
noteAuthEdge(null);
ok('a crossing into the app clears it', authEdge() === null);
// "Has the gate decided" is per root mount: lib/launchGateRemount.selftest.ts.

console.log('\nThe wiring:');
const read = (...p: string[]) => readFileSync(join(__dirname, '..', ...p), 'utf8');
const layout = read('app', '_layout.tsx');
ok('the root gate records the edge on both redirect branches and the catch',
  (layout.match(/noteAuthEdge\('\/onboard'\);\s*\n\s*settleLaunchGate\(false\);/g) || []).length === 2
  && /noteAuthEdge\('\/app-lock'\);\s*\n\s*settleLaunchGate\(false\);/.test(layout));
ok('…and clears it on the allow branch, before settling', /noteAuthEdge\(null\);\s*\n\s*settleLaunchGate\(true\);/.test(layout));
const nav = read('lib', 'authNav.ts');
ok('resetTo records every crossing', /noteAuthEdge\(edgeAfterReset\(href\)\)/.test(nav));
const index = read('app', 'index.tsx');
ok('index reads "cold" once, on its first render', /useState\(launchGatePending\)/.test(index));
ok('index routes by splashNext instead of returning on false',
  /splashNext\(await decision, coldVisit, authEdge\(\)\)/.test(index)
  && !/if \(!\(await (launchAllowed|decision)\)\) return;/.test(index));
const lock = read('app', 'app-lock.tsx');
ok('the lock records itself however it was raised (ResumeLock, the sealed relock)',
  /useEffect\(\(\) => \{ noteAuthEdge\('\/app-lock'\); \}, \[\]\);/.test(lock));
ok('…and a resume unlock clears it before going back', /noteAuthEdge\(null\);[^\n]*\n\s*router\.back\(\);/.test(lock));
const blocked = read('app', 'blocked.tsx');
ok('blocked leaves to the edge, not to "/", when nothing is underneath',
  /router\.replace\(\(authEdge\(\) \?\? '\/'\) as Href\)/.test(blocked)
  && !/router\.replace\('\/' as any\)/.test(blocked));

console.log(failures ? `\n${failures} FAILED` : '\nall passed');
process.exit(failures ? 1 : 0);
