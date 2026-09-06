// turnWiring.selftest.ts — the game-table-voice TURN wiring.
//
// SCOPE, STATED PLAINLY: these are STATIC/STRUCTURAL tests. They read the
// source and assert the shape of the wiring. They prove NOTHING about real
// relay behaviour — no transport is opened, no candidate is gathered, no packet
// is sent. DEVICE VERIFICATION OF TWO-WAY GAME VOICE REMAINS PENDING, and is
// blocked on the second phone (MIUI refuses adb input; that account fails
// `409 User has no VaultID`).
//
// WHY STRUCTURAL RATHER THAN BEHAVIOURAL
//
// useTableVoice cannot run in Node: it imports @livekit/react-native and
// react-native. getIceServers cannot either — lib/iceConfig imports
// chatService, which imports react-native. So the only thing checkable
// off-device is the shape of the call. That is exactly the mistake class worth
// catching here, because this bug WAS that mistake: the games server's
// STUN-only list was fetched and used, VaultChat's own TURN was never asked
// for, and every test in the suite still passed. The sibling
// lib/golive/turnWiring.selftest.ts pins the identical rule for Go Live.
//
//   npx tsx lib/games/turnWiring.selftest.ts

import { readFileSync } from 'fs';
import { join } from 'path';

const ROOT = join(__dirname, '..', '..');
const VOICE = readFileSync(join(ROOT, 'lib', 'games', 'useTableVoice.ts'), 'utf8');
const ICE = readFileSync(join(ROOT, 'lib', 'iceConfig.ts'), 'utf8');

let failures = 0;
function check(what: string, ok: boolean, detail = ''): void {
  if (!ok) { failures++; console.error('  FAIL', what, detail ? `(${detail})` : ''); }
  else { console.log('  ok  ', what); }
}

/** Strip comments so prose about TURN cannot satisfy a code assertion. */
function code(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n').filter(l => !/^\s*(\/\/|\*)/.test(l)).join('\n');
}
const VOICE_CODE = code(VOICE);
const ICE_CODE = code(ICE);

console.log('\nGame table voice — TURN wiring (STATIC STRUCTURAL TESTS)\n');

// 1. The relay comes from the EXISTING implementation, not a new one.
check('1. useTableVoice imports getIceServers from the existing lib/iceConfig',
  /import\s*\{[^}]*getIceServers[^}]*\}\s*from\s*['"]\.\.\/iceConfig['"]/.test(VOICE_CODE));
check('1b. and actually calls it',
  /getIceServers\(\)/.test(VOICE_CODE),
  'an import nothing calls is the bug this file exists to catch');
check('1c. no second TURN/credential implementation was added',
  !/TURN_SECRET|createHmac|turn:.*transport=/i.test(VOICE_CODE));

// 2. The games server stays a source — it is the authority on its own deployment.
check('2. the games /config.js list is still read',
  /GAMES_CONFIG/.test(VOICE_CODE) && /config\.js/.test(VOICE_CODE));
check('2b. and is MERGED, not assigned over the top of ours',
  !/iceServers\.current\s*=\s*cfg\.iceServers/.test(VOICE_CODE),
  'a bare assignment discards the TURN servers this change adds');

// 3. Neither source may be able to leave the list empty or unset.
check('3. a first-frame fallback still exists',
  /const DEFAULT_ICE/.test(VOICE_CODE) && /stun:/.test(VOICE_CODE));
check('3b. the ref is seeded with it',
  /useRef<any\[\]>\(DEFAULT_ICE\)/.test(VOICE_CODE));
check('3c. both fetches swallow their failures',
  (VOICE_CODE.match(/\.catch\(\(\)\s*=>\s*\{\}\)/g) ?? []).length >= 2,
  'a rejected TURN fetch must not stop a player joining voice over STUN');

// 4. One read, so there is no path that builds a connection from a stale list.
check('4. the peer connection is the single consumer of the merged list',
  (VOICE_CODE.match(/iceServers:\s*iceServers\.current/g) ?? []).length === 1);

// 5. The contract we are leaning on must still be the one iceConfig offers.
check('5. iceConfig still defines a STUN-only fallback',
  /const STUN_ONLY/.test(ICE_CODE) && /stun:/.test(ICE_CODE));
check('6. getIceServers still resolves rather than throwing on failure',
  /\.catch\(err\s*=>/.test(ICE_CODE) && /cached\s*\?\?\s*STUN_ONLY/.test(ICE_CODE));
check('7. concurrent callers still share one request (a 6-seat table opens 5 at once)',
  /if\s*\(inFlight\)\s*return\s+inFlight/.test(ICE_CODE));

console.log(failures ? `\n  ${failures} FAILED\n` : '\n  all TURN wiring checks passed\n');
process.exit(failures ? 1 : 0);
