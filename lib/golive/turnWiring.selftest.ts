// turnWiring.selftest.ts — the Go Live TURN fallback wiring.
//
// SCOPE, STATED PLAINLY: these are STATIC/STRUCTURAL tests. They read the
// source and assert the shape of the wiring. They prove NOTHING about real
// relay behaviour — no transport is opened, no candidate is gathered, no packet
// is sent. DEVICE TURN VERIFICATION remains PENDING.
//
// WHY STRUCTURAL RATHER THAN BEHAVIOURAL
//
// joinSfuRoom cannot run in Node: it imports @livekit/react-native and opens a
// real transport. getIceServers cannot either — lib/iceConfig imports
// chatService, which imports react-native. So the only thing that CAN be
// checked off-device is the shape of the call, which is exactly the class of
// mistake worth catching: a second connect(), a lost rtcConfig, a timer
// sneaking in, or the fallback path being removed. lib/decryptReplayCost
// .selftest.ts uses the same technique for the same reason.
//
//   npx tsx lib/golive/turnWiring.selftest.ts

import { readFileSync } from 'fs';
import { join } from 'path';

const ROOT = join(__dirname, '..', '..');
const ROOM = readFileSync(join(ROOT, 'lib', 'golive', 'room.ts'), 'utf8');
const ICE = readFileSync(join(ROOT, 'lib', 'iceConfig.ts'), 'utf8');
const CALL_ROOM = readFileSync(join(ROOT, 'lib', 'call', 'room.ts'), 'utf8');

let failures = 0;
function check(what: string, ok: boolean, detail = ''): void {
  if (!ok) { failures++; console.error('  FAIL', what, detail ? `(${detail})` : ''); }
  else { console.log('  ok  ', what); }
}

/** Strip comments so prose about timers/connect cannot satisfy a code assertion. */
function code(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n').filter(l => !/^\s*(\/\/|\*)/.test(l)).join('\n');
}
const ROOM_CODE = code(ROOM);
const ICE_CODE = code(ICE);

(async () => {
  console.log('\nGo Live TURN wiring — STATIC STRUCTURAL TESTS\n');

  // 1. The ICE list comes from the EXISTING implementation, not a new one.
  check('1. room.ts imports getIceServers from the existing lib/iceConfig',
    /import\s*\{[^}]*getIceServers[^}]*\}\s*from\s*['"]\.\.\/iceConfig['"]/.test(ROOM_CODE));
  check('1b. and calls it exactly once',
    (ROOM_CODE.match(/getIceServers\(\)/g) ?? []).length === 1,
    `${(ROOM_CODE.match(/getIceServers\(\)/g) ?? []).length} call sites`);
  check('1c. no second TURN/credential implementation was added',
    !/TURN_SECRET|hmac|HMAC|createHmac|turn:.*transport=/i.test(ROOM_CODE));

  // 2-4. The existing fallback contract must still be the one we rely on.
  check('2. iceConfig still defines a STUN-only fallback',
    /const STUN_ONLY/.test(ICE_CODE) && /stun:/.test(ICE_CODE));
  check('3. iceConfig returns the served list when it is non-empty',
    /cfg\?\.iceServers\?\.length\s*\?\s*cfg\.iceServers\s*:\s*STUN_ONLY/.test(ICE_CODE));
  check('4. a credential failure resolves rather than throwing',
    /\.catch\(/.test(ICE_CODE) && /return cached \?\? STUN_ONLY/.test(ICE_CODE));
  check('4b. and room.ts does not wrap it in its own error handling that could swallow the join',
    !/getIceServers\(\)\s*\.catch/.test(ROOM_CODE));

  // 5. rtcConfig actually reaches connect().
  const connectCall = ROOM_CODE.match(/room\.connect\([^;]*\)/)?.[0] ?? '';
  check('5. rtcConfig with iceServers is passed to room.connect()',
    /rtcConfig:\s*\{\s*iceServers\s*\}/.test(connectCall), connectCall.slice(0, 90));
  check('5b. autoSubscribe is preserved alongside it',
    /autoSubscribe:\s*true/.test(connectCall));

  // 6-7. Exactly one of each — a second would be the duplicate-publisher bug.
  check('6. room.connect() is called exactly once',
    (ROOM_CODE.match(/room\.connect\(/g) ?? []).length === 1,
    `${(ROOM_CODE.match(/room\.connect\(/g) ?? []).length} call sites`);
  check('7. exactly one Room is constructed',
    (ROOM_CODE.match(/new Room\(/g) ?? []).length === 1);

  // 8. No NEW publishing path. Go Live legitimately publishes two tracks — the
  // microphone and the camera — so the baseline is two, not zero. Pinning the
  // exact count is what would catch a third appearing: a second publisher is
  // the failure mode a relay/reconnect change is most likely to introduce.
  const publishes = (ROOM_CODE.match(/publishTrack\(/g) ?? []).length;
  check('8. no additional publish path was introduced (mic + camera only)',
    publishes === 2, `${publishes} publishTrack call sites, expected 2`);

  // No scheduler of any kind — the SDK owns reconnection and TURN is a
  // candidate, not a retry strategy.
  check('9. no timer/poll was introduced',
    !/setTimeout|setInterval|requestAnimationFrame/.test(ROOM_CODE));
  check('9b. and no retry/backoff logic',
    !/\bbackoff\b|\bmaxRetries\b|retryDelay/i.test(ROOM_CODE));

  // 10-12. Phase 3's connection-state handling must survive this change.
  check('10. wireConnectionEvents is still called with the join args',
    /wireConnectionEvents\(room,\s*a\)/.test(ROOM_CODE));
  check('11. the three connection callbacks are still on JoinArgs',
    /onReconnecting\?:/.test(ROOM) && /onReconnected\?:/.test(ROOM) && /onDisconnected\?:/.test(ROOM));
  check('12. the SDK event-name drift guard is still asserted',
    /assertConnectionEventNames\(RoomEvent\)/.test(ROOM_CODE));
  check('12b. Reconnected still re-attaches the frame cryptor',
    /RoomEvent\.Reconnected[\s\S]{0,80}crypto\?\.attach\(\)/.test(ROOM_CODE));

  // 13. Calls WERE out of scope for the phase this check was written in, and
  // this asserted their absence from lib/call/room.ts to keep the change
  // contained. They are in scope now, and for a measured reason: connecting
  // without rtcConfig left livekit-client using only the servers the LiveKit
  // SERVER advertises, and livekit.yaml sets `turn: enabled: false` to reuse
  // the host's coturn. On device that gathered 42 host, 19 srflx and ZERO
  // relay candidates — fine on a friendly network, and unable to connect at
  // all behind a symmetric NAT. So the check now pins the opposite: the
  // calling path gets the same line golive has always had.
  check('13. lib/call/room.ts passes rtcConfig with iceServers to connect()',
    /rtcConfig:\s*(\{\s*iceServers\s*\}|\w+)/.test(code(CALL_ROOM)),
    'no rtcConfig means no relay candidates, which is a call that cannot cross a symmetric NAT');

  // 14. The fetch must not sit in front of the join as a blocking round trip
  // before any other setup work — it is started early and awaited at connect.
  const startIdx = ROOM_CODE.indexOf('getIceServers()');
  const roomIdx = ROOM_CODE.indexOf('new Room(');
  const connIdx = ROOM_CODE.indexOf('room.connect(');
  check('14. the ICE fetch starts before the Room is built and is awaited at connect',
    startIdx > -1 && roomIdx > -1 && connIdx > -1 && startIdx < roomIdx && roomIdx < connIdx,
    `ice@${startIdx} room@${roomIdx} connect@${connIdx}`);
  check('14b. it is not awaited at the point it is started',
    !/await\s+getIceServers\(\)/.test(ROOM_CODE));

  console.log(failures === 0
    ? '\nALL GO LIVE TURN-WIRING CHECKS PASSED ✓  (structural only — device PENDING)\n'
    : `\n${failures} CHECK(S) FAILED ✗\n`);
  process.exit(failures === 0 ? 0 : 1);
})();
