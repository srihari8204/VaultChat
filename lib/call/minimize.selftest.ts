// lib/call/minimize.selftest.ts — run: npx tsx lib/call/minimize.selftest.ts
//
// THE BUG THIS LOCKS DOWN
// -----------------------
// A call took the whole app hostage. The engine has always owned the call
// outside React — media is the SDK's, the session and state machine live in
// engine.ts — but the call screen's unmount effect called leaveScreen(), which
// hung up. So navigating anywhere ended the call, and the only way off the
// screen was Android's system picture-in-picture, which shrinks the entire
// activity and still does not let you open a chat.
//
// The fix is a one-shot flag: minimizeScreen() makes the NEXT leaveScreen() a
// no-op. The two properties that matter are opposites, and both are easy to
// break with a "simplification":
//
//   1. minimise  → unmount must NOT end the call    (the reported bug)
//   2. plain     → unmount MUST end the call        (or a call can never be
//                  ended by closing its screen, which is worse)
//
// engine.ts imports the LiveKit SDK and native modules, so it cannot be loaded
// under Node. This asserts the wiring in the source — enough to catch the
// regression, and honest about being a source-level check.

import fs from 'node:fs';
import path from 'node:path';

const read = (...p: string[]) => fs.readFileSync(path.join(process.cwd(), ...p), 'utf8');
const ENGINE = read('lib', 'call', 'engine.ts');
const BAR = read('components', 'CallBar.tsx');
const LAYOUT = read('app', '_layout.tsx');
const VIDEO = read('app', 'videocall.tsx');
const VOICE = read('app', 'voicecall.tsx');

let failures = 0;
function check(name: string, ok: boolean, detail?: string) {
  if (!ok) failures++;
  console.log(`  ${ok ? '✓' : '✗'} ${name}${ok || !detail ? '' : `  (${detail})`}`);
}

console.log('\nIn-app call minimise self-test\n');

console.log('The engine can be left without being ended:');
check('minimizeScreen() exists', /export function minimizeScreen\(\)/.test(ENGINE));
check('...and only arms when a call is live',
  /export function minimizeScreen\(\)[\s\S]{0,120}?if \(!session\) return;/.test(ENGINE));
check('leaveScreen honours the flag and returns early',
  /if \(detachRequested\) \{[\s\S]{0,220}?return;/.test(ENGINE));
check('the flag is CONSUMED, so it cannot strand a call',
  /if \(detachRequested\) \{\s*\n\s*detachRequested = false;/.test(ENGINE));
check('a plain unmount still hangs up',
  /hangUp\('local_hangup', true, only\);\s*\n\s*release\(\);/.test(ENGINE));
check('hasLiveSession() is exported for the bar', /export function hasLiveSession\(\)/.test(ENGINE));
check('liveSessionRef() is exported for routing back', /export function liveSessionRef\(\)/.test(ENGINE));

console.log('\nThe bar exists, and is mounted where it survives navigation:');
check('CallBar is rendered in the root layout', /<CallBar \/>/.test(LAYOUT));
check('...ABOVE the navigator, not inside it',
  LAYOUT.indexOf('<CallBar />') < LAYOUT.indexOf('<Stack screenOptions'));
check('it subscribes to the live call store',
  /useSyncExternalStore\(subscribe, getSnapshot/.test(BAR));
check('it hides itself on the call screens',
  /CALL_ROUTES/.test(BAR) && /'\/videocall'/.test(BAR) && /'\/voicecall'/.test(BAR));
check('it can end the call without navigating back in', /hangUp\('local_hangup', true\)/.test(BAR));
check('it routes back with resume=1', /resume: '1'/.test(BAR));

console.log('\nBoth call screens minimise instead of ending:');
for (const [name, src] of [['videocall', VIDEO], ['voicecall', VOICE]] as const) {
  check(`${name}: back minimises`, /engine\.minimizeScreen\(\);/.test(src));
  check(`${name}: back no longer hands the app to OS picture-in-picture`,
    !/^\s*enterPipMode\(\);\s*$/m.test(src));
  check(`${name}: re-entry attaches instead of re-dialling`,
    /if \(resuming && engine\.hasLiveSession\(\)\)/.test(src));
  check(`${name}: a NON-connected call still leaves on back`,
    /if \(status !== 'connected'\) \{ engine\.hangUp\('local_hangup', true\); return false; \}/.test(src));
}

console.log(failures ? `\n  ${failures} FAILED\n` : '\n  all call-minimise checks passed\n');
process.exit(failures ? 1 : 0);
