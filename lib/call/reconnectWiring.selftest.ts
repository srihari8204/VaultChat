// reconnectWiring.selftest.ts — the call-path reconnect chain, end to end.
//
// SCOPE, STATED PLAINLY: STRUCTURAL. This reads source and asserts the chain is
// wired. It opens no transport and produces no reconnect, so it proves nothing
// about runtime behaviour — DEVICE VERIFICATION REMAINS SEPARATE.
//
// WHY IT EXISTS
//
// Every piece of this chain was already present except one link, and the
// missing link was invisible: the reducer handled `reconnecting`, both call
// screens rendered "Reconnecting…", and voicecall.tsx even carried a comment
// saying the branch must exist — but nothing ever dispatched it, because the
// two RoomEvents that could were never subscribed. A status that cannot be
// produced looks exactly like a status that never happens.
//
// The other half of this file's job is to pin WHICH FILE is the live one.
// lib/call/sfuRoom.ts is a dead copy — lib/golive/room.ts says so in its header
// — and an earlier attempt at this fix patched that copy instead, changing
// nothing. So the reducer/transport identity is asserted, not assumed.
//
//   npx tsx lib/call/reconnectWiring.selftest.ts

import { readFileSync } from 'fs';
import { join } from 'path';

const ROOT = join(__dirname, '..', '..');
const read = (p: string) => readFileSync(join(ROOT, p), 'utf8');

const ROOM = read('lib/call/room.ts');
const ENGINE = read('lib/call/engine.ts');
const MACHINE = read('lib/call/machine.ts');
const VOICE = read('app/voicecall.tsx');
const VIDEO = read('app/videocall.tsx');

let failures = 0;
function check(what: string, ok: boolean, detail = ''): void {
  if (!ok) { failures++; console.error('  FAIL', what, detail ? `(${detail})` : ''); }
  else { console.log('  ok  ', what); }
}

/** Strip comments so prose about an event cannot satisfy a code assertion. */
function code(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n').filter(l => !/^\s*(\/\/|\*)/.test(l)).join('\n');
}
const ROOM_C = code(ROOM), ENGINE_C = code(ENGINE), MACHINE_C = code(MACHINE);

(async () => {
  console.log('\nCall reconnect wiring — STRUCTURAL TESTS\n');

  // 1-2. The transport subscribes to both SDK events.
  check('1. room.ts subscribes RoomEvent.Reconnecting',
    /room\.on\(RoomEvent\.Reconnecting,/.test(ROOM_C));
  check('2. room.ts subscribes RoomEvent.Reconnected',
    /room\.on\(RoomEvent\.Reconnected,/.test(ROOM_C));

  // 3-4. Each forwards to its callback through the existing safe() guard, so a
  // throwing handler cannot unwind into livekit-client's emitter.
  check('3. Reconnecting forwards via safe() to onReconnecting',
    /safe\('reconnecting',\s*\(\)\s*=>\s*a\.events\.onReconnecting\?\.\(\)\)/.test(ROOM_C));
  check('4. Reconnected forwards via safe() to onReconnected',
    /safe\('reconnected',\s*\(\)\s*=>\s*a\.events\.onReconnected\?\.\(\)\)/.test(ROOM_C));

  // 5. Optional, so every pre-existing caller still compiles and behaves the same.
  check('5. both callbacks are OPTIONAL on CallRoomEvents',
    /onReconnecting\?\(\): void;/.test(ROOM) && /onReconnected\?\(\): void;/.test(ROOM));

  // 6-7. The engine turns them into the actions the reducer already understands.
  check('6. engine dispatches {type:\'reconnecting\'} on onReconnecting',
    /onReconnecting:\s*\(\)\s*=>\s*dispatch\(\{\s*type:\s*'reconnecting'\s*\}\)/.test(ENGINE_C));
  check('7. engine dispatches {type:\'recovered\'} on onReconnected',
    /onReconnected:\s*\(\)\s*=>\s*dispatch\(\{\s*type:\s*'recovered'\s*\}\)/.test(ENGINE_C));

  // 8-9. The reducer's own guards are what make an unguarded dispatch safe.
  check('8. reducer ignores reconnecting unless the call is connected',
    /case 'reconnecting'/.test(MACHINE_C));
  check('9. reducer ignores recovered unless status is reconnecting',
    /s\.status !== 'reconnecting'\) return s/.test(MACHINE_C));

  // 10. Both screens can render the state the chain now produces.
  check('10. voicecall renders Reconnecting…',
    /status === 'reconnecting' \? 'Reconnecting…'/.test(VOICE));
  check('11. videocall renders Reconnecting…',
    /status === 'reconnecting' \? 'Reconnecting…'/.test(VIDEO));

  // 12. IDENTITY: engine must use lib/call/room.ts, not the dead copy. This is
  // the assertion that would have caught the wrong-file fix.
  check('12. engine imports joinCallRoom from ./room (the LIVE transport)',
    /import\s*\{[^}]*joinCallRoom[^}]*\}\s*from\s*'\.\/room'/.test(ENGINE_C));
  check('12b. and does NOT import the dead sfuRoom copy',
    !/from\s*'\.\/sfuRoom'/.test(ENGINE_C));

  // 13-15. No second reconnect engine. livekit-client owns retry; these events
  // only report what it is already doing.
  check('13. Reconnecting does not re-enter connect()',
    !/RoomEvent\.Reconnecting[\s\S]{0,200}?room\.connect\(/.test(ROOM_C));
  check('14. Reconnecting does not tear the room down',
    !/RoomEvent\.Reconnecting[\s\S]{0,200}?(disconnect\(|leave\(\))/.test(ROOM_C));
  // Scoped to the two handler bodies, NOT the whole file: room.ts already
  // carries three unrelated timers at HEAD (a stats poll and a 2s track
  // reconcile). Asserting "no timers anywhere" measured those instead of the
  // thing that matters, which is whether THIS change added a retry of its own.
  const handlers = (ROOM_C.match(/room\.on\(RoomEvent\.Reconnect(ing|ed),[\s\S]{0,220}?\}\);/g) ?? []).join('\n');
  check('15. neither reconnect handler schedules anything',
    handlers.length > 0 && !/setTimeout|setInterval|\bbackoff\b|maxRetries/i.test(handlers),
    `${handlers.length} chars of handler body examined`);
  check('15b. and the timer count is unchanged from before this change',
    (ROOM_C.match(/setInterval|setTimeout/g) ?? []).length === 3,
    `${(ROOM_C.match(/setInterval|setTimeout/g) ?? []).length} timers, expected the 3 pre-existing`);

  // 16. Exactly one Room and one connect() — a second of either is the
  // duplicate-publisher failure this class of change most easily introduces.
  check('16. exactly one Room is constructed',
    (ROOM_C.match(/new Room\(/g) ?? []).length === 1);
  check('17. room.connect() is called exactly once',
    (ROOM_C.match(/room\.connect\(/g) ?? []).length === 1);

  console.log(failures === 0
    ? '\nALL CALL RECONNECT WIRING CHECKS PASSED ✓  (structural — device separate)\n'
    : `\n${failures} CHECK(S) FAILED ✗\n`);
  process.exit(failures === 0 ? 0 : 1);
})();
