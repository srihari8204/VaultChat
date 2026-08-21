// reconnectBudget.selftest.ts — the client's reconnect budget must fit inside
// the server's host grace, or the two recovery halves cannot meet.
//
// WHY THIS IS ARITHMETIC AND NOT A FEELING
//
// Go Live recovery is one budget split across two processes:
//
//   client   livekit-client retries for N seconds, then gives up (Disconnected)
//   server   golive_reaper.go holds the broadcast for hostGrace(), then ends it
//
// The host must REJOIN before the server gives up, because the rejoin is what
// triggers the transcoder restart (goliveRestartEgress). If the client stops
// trying first, the server has nothing to recover and the grace expires unused.
// That is exactly what was measured on device with the stock policy:
// 44s of retries against a 90s grace, Disconnected, no participant_joined,
// broadcast ended.
//
// So the two numbers are coupled, and this file is where that coupling is
// checked. Change hostGrace() and this fails until the budget is recomputed.
//
// STRUCTURAL: reads source, opens no transport. Device verification is separate.
//
//   npx tsx lib/golive/reconnectBudget.selftest.ts

import { readFileSync } from 'fs';
import { join } from 'path';

const ROOT = join(__dirname, '..', '..');
const ROOM = readFileSync(join(ROOT, 'lib', 'golive', 'room.ts'), 'utf8');
const REAPER = readFileSync(
  join(ROOT, 'vaultchat-backend-go', 'internal', 'routes', 'golive_reaper.go'), 'utf8');

let failures = 0;
const check = (what: string, ok: boolean, detail = ''): void => {
  if (!ok) { failures++; console.error('  FAIL', what, detail ? `(${detail})` : ''); }
  else console.log('  ok  ', what);
};

/** Strip comments so prose about delays cannot satisfy a code assertion. */
const code = (s: string) => s
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .split('\n').filter(l => !/^\s*(\/\/|\*)/.test(l)).join('\n');
const ROOM_C = code(ROOM);

(async () => {
  console.log('\nGo Live reconnect budget vs server host grace\n');

  // 1. The SDK's own policy, configured — not a bespoke one.
  check('1. uses livekit-client DefaultReconnectPolicy',
    /reconnectPolicy:\s*new DefaultReconnectPolicy\(/.test(ROOM_C));
  check('1b. imported from livekit-client, not hand-rolled',
    /import\s*\{[^}]*DefaultReconnectPolicy[^}]*\}\s*from\s*'livekit-client'/.test(ROOM_C));

  // 2. Read the configured delays straight out of the source and add them up.
  const m = ROOM_C.match(/new DefaultReconnectPolicy\(\[([0-9,\s]+)\]\)/);
  check('2. the delay table is readable from source', !!m);
  if (!m) { console.log(`\n${failures} CHECK(S) FAILED\n`); process.exit(1); }

  const delays = m[1].split(',').map(s => Number(s.trim())).filter(n => Number.isFinite(n));
  const nominalMs = delays.reduce((a, b) => a + b, 0);
  // nextRetryDelayInMs adds Math.random()*1000 for every attempt after the
  // second, so the worst case is the sum plus 1000 per jittered attempt.
  const jittered = Math.max(0, delays.length - 2);
  const worstMs = nominalMs + jittered * 1000;

  console.log(`      attempts=${delays.length}  nominal=${nominalMs}ms  worst=${worstMs}ms`);

  // 3. The server's grace, read from ITS source — not copied here.
  const g = REAPER.match(/defaultHostGrace\s*=\s*([0-9]+)\s*\*\s*time\.Second/)
    ?? REAPER.match(/defaultHostGrace\s*=\s*([0-9]+)\s*\*\s*time\.Minute/);
  check('3. server hostGrace is readable from golive_reaper.go', !!g);
  const graceMs = g
    ? Number(g[1]) * (/Minute/.test(g[0]) ? 60_000 : 1_000)
    : 90_000;
  console.log(`      server grace=${graceMs}ms`);

  // 4. THE COUPLING. Worst-case retries must finish inside the grace, with room
  // left for the rejoin, the participant_joined webhook and StartHLS.
  const marginMs = graceMs - worstMs;
  check('4. worst-case reconnect budget fits inside the server grace',
    worstMs < graceMs, `worst=${worstMs}ms grace=${graceMs}ms`);
  check('4b. at least 10s of margin for rejoin + webhook + egress restart',
    marginMs >= 10_000, `margin=${marginMs}ms`);

  // 5. It must be LONGER than the stock policy, or nothing changed.
  const STOCK_MS = 44_000; // [0,300,1200,2700,4800,7000x5]
  check('5. budget exceeds the stock 44s that lost the broadcast',
    nominalMs > STOCK_MS, `nominal=${nominalMs}ms`);

  // 6. NO SECOND RECONNECT SYSTEM. The whole architectural rule.
  check('6. no reconnect timer was introduced',
    !/setTimeout|setInterval/.test(ROOM_C));
  check('6b. no bespoke retry/backoff bookkeeping',
    !/\bretryCount\b|\bbackoff\b|\bmaxRetries\b|reconnectAttempt/i.test(ROOM_C));
  check('6c. exactly one Room is constructed',
    (ROOM_C.match(/new Room\(/g) ?? []).length === 1);
  check('6d. room.connect() is called exactly once — no manual re-connect loop',
    (ROOM_C.match(/room\.connect\(/g) ?? []).length === 1);
  check('6e. Reconnecting still does not tear the room down',
    !/RoomEvent\.Reconnecting[\s\S]{0,200}?(disconnect\(|leave\(\))/.test(ROOM_C));

  console.log(failures === 0
    ? `\nALL RECONNECT-BUDGET CHECKS PASSED ✓  (margin ${marginMs}ms — device separate)\n`
    : `\n${failures} CHECK(S) FAILED ✗\n`);
  process.exit(failures === 0 ? 0 : 1);
})();
