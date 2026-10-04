/**
 * lib/launchVeil.selftest.ts — the root veil latches down once its redirect lands.
 *   run with: npx tsx lib/launchVeil.selftest.ts
 *
 * THE BUG THIS PINS, observed on a device 2026-09-19.
 *
 * app/_layout.tsx paints an opaque full-screen veil over the navigator while
 * launchReady is false. It used to be
 *
 *     launchReady = launchGate === 'allow' || launchGate === pathname
 *
 * `launchGate` is set ONCE per launch (that effect has deps [router]);
 * `pathname` changes on every navigation. The equality is only meant to bridge
 * the frames between the gate's decision and its router.replace() landing — but
 * it was re-evaluated forever after, so the FIRST navigation inside the auth
 * flow (onboard → mpin-entry, onboard → phone-verify, app-lock → chats) made
 * the two unequal and put the veil back up over a screen the user was typing
 * into. Nothing threw, so logcat showed nothing. The veil is colors.bg, so it
 * was reported as a WHITE screen and then a BLACK one.
 *
 * Two earlier attempts patched the symptom by signalling "auth succeeded" from
 * the screens that enter the app. Both shipped blank to a real device, because
 * the veil went up on the way TO those screens, not after them. This file pins
 * the root-level latch that replaced them, and pins that the symptom patch is
 * gone so nobody re-adds it believing it is the fix.
 *
 * Source-scan, deliberately: the real thing needs a mounted navigator and
 * expo-router; what matters is structural and visible in the text.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const read = (p: string) => readFileSync(resolve(process.cwd(), p), 'utf8');
const layout = read('app/_layout.tsx');
const gate = read('lib/launchGate.ts');

let failures = 0;
function ok(name: string, cond: boolean, detail = '') {
  if (!cond) failures++;
  console.log(`  ${cond ? '✓' : '✗'} ${name}${cond ? '' : `  ${detail}`}`);
}

console.log('\nThe veil latches down once the redirect target has been on screen:');
ok('a `landed` latch exists', /const \[landed, setLanded\] = useState\(false\);/.test(layout));
ok('it is set when the gate has decided AND pathname matches the decision',
  /if \(launchGate !== 'checking' && launchGate === pathname\) setLanded\(true\);/.test(layout));
ok('it re-runs on both inputs, not once', /\}, \[launchGate, pathname\]\);/.test(layout));
ok('launchReady includes the latch',
  /const launchReady = launchGate === 'allow' \|\| landed \|\| launchGate === pathname;/.test(layout));

console.log('\nThe veil is otherwise UNCHANGED — the fix must not weaken it:');
// 'checking' never equals a pathname and never sets the latch, so a launch
// whose gate has not decided is still fully veiled. If someone "fixes" a future
// wedge by dropping the pathname bridge or the allow branch, this fails.
ok('the allow branch survives', /launchGate === 'allow' \|\|/.test(layout));
ok('the pathname bridge survives (no flash before the redirect lands)',
  /\|\| launchGate === pathname;/.test(layout));
ok('the veil is still opaque and on top', /zIndex: 100000, backgroundColor: colors\.bg/.test(layout));
ok('protected content is still hidden from a11y while veiled',
  /importantForAccessibility=\{launchReady \? 'auto' : 'no-hide-descendants'\}/.test(layout));
ok('the splash still hides only once ready', /if \(launchReady\) SplashScreen\.hideAsync/.test(layout));

console.log('\nThe symptom patch is gone (it shipped blank twice):');
ok('launchGate.ts no longer exports clearLaunchGate', !/clearLaunchGate/.test(gate.replace(/\/\/.*$/gm, '')));
for (const f of ['app/_layout.tsx', 'app/app-lock.tsx', 'app/mpin-entry.tsx', 'app/onboard-success.tsx']) {
  ok(`${f} does not call clearLaunchGate`, !/clearLaunchGate\(\)/.test(read(f)));
}

console.log(failures === 0
  ? `\n  All launch-veil checks passed\n`
  : `\n  ${failures} FAILED\n`);
process.exit(failures === 0 ? 0 : 1);
