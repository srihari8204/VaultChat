// lib/socket.transport.selftest.ts — run: npx tsx lib/socket.transport.selftest.ts
//
// §21. Pins ONE promise: with nothing configured, lib/socket.ts opens exactly
// the connection it opens today. The app is live; the rollout branch is only
// acceptable if it is provably inert until somebody deliberately turns it on.
//
// It runs the REAL connect() from lib/socket.ts. socket.ts cannot be imported
// under plain Node (socket.io-client, react-native, NetInfo), so its IMPORT
// BLOCK ONLY is rewritten to point at stubs and the body is used verbatim,
// regenerated on every run so it cannot drift from what ships. Same idiom as
// lib/messageQueue.flush.selftest.ts.
//
// What is checked:
//   1. the real featureFlags module, unconfigured, says OFF — so
//      selectTransport() is 'socketio' for every user today;
//   2. a flag read that THROWS still yields 'socketio' (never a crash, never
//      the new path);
//   3. connect() reaches socket.io with transports:['websocket'] in BOTH flag
//      states — i.e. the ccwire branch falls through and the Socket.IO path
//      stays reachable in every build (precondition P3, the rollback lever);
//   4. no extra await lands ahead of the existing getAccessToken() guard;
//   5. SendTiming.transport is populated, and defaults to 'socketio'.
//
// NOT checked, and cannot be: that the CC-Wire path works. There is no server
// endpoint and no client dialer yet. This file proves the branch is unreachable,
// not that the road behind it is paved.

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';

const HERE = dirname(fileURLToPath(import.meta.url));
(globalThis as any).__DEV__ = false;

let failures = 0;
function check(name: string, ok: boolean, detail?: string) {
  if (!ok) failures++;
  console.log(`  ${ok ? '✓' : '✗'} ${name}${ok || !detail ? '' : `  (${detail})`}`);
}

// ── build a runnable copy of socket.ts: imports rewritten, body untouched ──
const WORK = join(tmpdir(), `vc-socket-transport-selftest-${process.pid}`);
mkdirSync(WORK, { recursive: true });
writeFileSync(join(WORK, 'package.json'), '{"type":"module"}');

writeFileSync(join(WORK, 'stubs.js'), `
const H = () => globalThis.__H;
export const SERVER_URL = 'https://example.invalid';
export const SETTLE_MS = 0;
export function netKeyOf() { return null; }
export function reconnectReason() { return null; }
export function shouldKickOnForeground() { return false; }
export function shouldAbandonPendingConnect() { return false; }
export function useSyncExternalStore() {}
export const AppState = { addEventListener() { return { remove() {} }; } };
export default { addEventListener() { return () => {}; } };   // NetInfo
export async function getAccessToken() { H().order.push('getAccessToken'); return 'tok'; }
export async function refreshAccessToken() { return 'terminal'; }
export function io(url, opts) {
  H().order.push('io');
  H().ioCalls.push({ url, opts });
  const s = {
    io: { on() {} },
    on() {}, off() {}, once() {}, emit() {}, connect() {}, disconnect() {},
  };
  return s;
}
export class Socket {}
`);

writeFileSync(join(WORK, 'perfstub.js'), `
const H = () => globalThis.__H;
const perf = {
  mark(event, meta) { H().order.push('mark:' + event); H().marks.push({ event, meta }); },
  setTransport() {}, setConnState() {}, bumpReconnect() {},
  setSendTransport(n) { H().sendTransport = n; },
  snapshot() { return { transport: 'websocket', connState: 'connected', reconnects: 0 }; },
};
export default perf;
`);

// A controllable stand-in for lib/featureFlags, so the "it threw" case can
// actually be exercised. The REAL module's unconfigured default is asserted
// separately below — both halves matter.
writeFileSync(join(WORK, 'flags.js'), `
export const TRANSPORT_RUST = 'transport.rust';
export function isFeatureEnabled() {
  const m = globalThis.__H.flagMode;
  if (m === 'throw') throw new Error('flag layer exploded');
  return m === 'on';
}
`);

const IMPORT_REWRITES: [RegExp, string][] = [
  [/^import \{ io as ioClient, Socket \} from 'socket\.io-client';$/m,
   `import { io as ioClient, Socket } from './stubs.js';`],
  [/^import \{ useSyncExternalStore \} from 'react';$/m,
   `import { useSyncExternalStore } from './stubs.js';`],
  [/^import \{ AppState \} from 'react-native';$/m, `import { AppState } from './stubs.js';`],
  [/^import NetInfo from '@react-native-community\/netinfo';$/m, `import NetInfo from './stubs.js';`],
  [/^import \{ SERVER_URL \} from '\.\.\/constants\/server';$/m,
   `import { SERVER_URL } from './stubs.js';`],
  [/^import \{ getAccessToken, refreshAccessToken \} from '\.\/api';$/m,
   `import { getAccessToken, refreshAccessToken } from './stubs.js';`],
  [/^import \{ netKeyOf, reconnectReason, shouldKickOnForeground, shouldAbandonPendingConnect, SETTLE_MS \} from '\.\/socketReconnect';$/m,
   `import { netKeyOf, reconnectReason, shouldKickOnForeground, shouldAbandonPendingConnect, SETTLE_MS } from './stubs.js';`],
  [/^import perf from '\.\/perf';$/m, `import perf from './perfstub.js';`],
  [/^import \{ isFeatureEnabled, TRANSPORT_RUST \} from '\.\/featureFlags';$/m,
   `import { isFeatureEnabled, TRANSPORT_RUST } from './flags.js';`],
];

let src = readFileSync(join(HERE, 'socket.ts'), 'utf8');
for (const [re, to] of IMPORT_REWRITES) {
  if (!re.test(src)) {
    console.log(`  ✗ selftest could not rewrite an import — socket.ts changed its import block (${re})`);
    failures++;
  }
  src = src.replace(re, to);
}
const stray = [...src.matchAll(/^import .*from '([^']+)';$/gm)]
  .map((m) => m[1])
  .filter((p) => !p.startsWith('./') || p.endsWith('.ts'));
check('every socket.ts import is accounted for', stray.length === 0, `unstubbed: ${stray.join(', ')}`);

writeFileSync(join(WORK, 'sock.ts'), src);

const H: any = { order: [], ioCalls: [], marks: [], flagMode: 'off', sendTransport: null };
(globalThis as any).__H = H;

function resetH() { H.order = []; H.ioCalls = []; H.marks = []; H.sendTransport = null; }

// This repo compiles as CJS under tsx, so no top-level await.
async function main() {
const S: any = await import(pathToFileURL(join(WORK, 'sock.ts')).href);

// ── 1. The real flag module, unconfigured, is OFF ──────────────────────────
console.log('\nWith no configuration the real flag layer says OFF:');
const FF: any = await import(pathToFileURL(join(HERE, 'featureFlags.ts')).href);
delete process.env.EXPO_PUBLIC_FLAG_TRANSPORT_RUST_PCT;
FF.__resetFeatureFlagsForTest();
check('isFeatureEnabled(transport.rust) is false with nothing set',
  FF.isFeatureEnabled(FF.TRANSPORT_RUST) === false,
  'this is the value selectTransport() reads in the shipped app');
FF.__resetFeatureFlagsForTest('some-install-id');
check('having an install id does not enable it either',
  FF.isFeatureEnabled(FF.TRANSPORT_RUST) === false);

// ── 2. selectTransport is total and defaults to the live path ──────────────
console.log('\nselectTransport() defaults to the live path, and on every error:');
H.flagMode = 'off';
check("flag off ⇒ 'socketio'", S.selectTransport() === 'socketio');
H.flagMode = 'throw';
check("a flag read that THROWS ⇒ 'socketio', not a crash", S.selectTransport() === 'socketio');
H.flagMode = 'on';
check("flag deliberately on ⇒ 'ccwire'", S.selectTransport() === 'ccwire',
  'the branch must be reachable when someone means it, or the rollout is a lie');

// ── 3. connect() opens the SAME connection in every flag state ─────────────
// This is the whole point of the file. The ccwire branch must fall through.
console.log('\nconnect() opens the same Socket.IO connection in every flag state:');
for (const mode of ['off', 'throw', 'on']) {
  H.flagMode = mode;
  resetH();
  // getSocket() is the only exported way in; it delegates to connect() and,
  // like connect(), never settles under these stubs. Do not await it.
  S.getSocket().catch(() => {});
  await new Promise((r) => setTimeout(r, 10));
  const call = H.ioCalls[0];
  check(`flag=${mode}: exactly one socket.io connection is opened`, H.ioCalls.length === 1,
    `opened ${H.ioCalls.length}`);
  check(`flag=${mode}: url is SERVER_URL`, call?.url === 'https://example.invalid');
  check(`flag=${mode}: transports is ['websocket'] — unchanged`,
    JSON.stringify(call?.opts?.transports) === '["websocket"]');
  check(`flag=${mode}: auth is still a function, not a captured token`,
    typeof call?.opts?.auth === 'function',
    'a captured token breaks every reconnect after 15 minutes');
  check(`flag=${mode}: reconnect options unchanged`,
    call?.opts?.reconnection === true && call?.opts?.reconnectionDelay === 500
    && call?.opts?.reconnectionDelayMax === 5000 && call?.opts?.timeout === 10000);
  check(`flag=${mode}: sends are tagged 'socketio'`, H.sendTransport === 'socketio',
    'the branch falls through, so Socket.IO is what carries them');
  // 4. Ordering: the flag decision adds no await ahead of the session guard.
  check(`flag=${mode}: getAccessToken still runs before the socket is built`,
    H.order.indexOf('getAccessToken') >= 0
    && H.order.indexOf('getAccessToken') < H.order.indexOf('io'));
  S.disconnect();
}

console.log('\nOnly a deliberately-on flag leaves a trace:');
H.flagMode = 'off'; resetH();
S.getSocket().catch(() => {}); await new Promise((r) => setTimeout(r, 10));
check('flag off ⇒ no ccwire mark at all',
  !H.marks.some((m: any) => m.event === 'transport_ccwire_unavailable'));
S.disconnect();
H.flagMode = 'on'; resetH();
S.getSocket().catch(() => {}); await new Promise((r) => setTimeout(r, 10));
check('flag on ⇒ the cohort is marked, and still falls through',
  H.marks.some((m: any) => m.event === 'transport_ccwire_unavailable') && H.ioCalls.length === 1);
S.disconnect();

// ── 5. The metric P4 asks for is actually populated ────────────────────────
console.log('\nSendTiming.transport is populated (P4):');
const perf: any = (await import(pathToFileURL(join(HERE, 'perf.ts')).href)).default;
perf.recordSend({ id: 'a', totalMs: 1, at: Date.now() });
check("an untagged send defaults to 'socketio'", perf.recentSends(1)[0].transport === 'socketio');
perf.recordSend({ id: 'b', totalMs: 1, transport: 'websocket', at: Date.now() });
check('the engine name is normalised to the cohort vocabulary',
  perf.recentSends(1)[0].transport === 'socketio',
  'callers pass snapshot().transport; §4 wants socketio|ccwire');
perf.setSendTransport('ccwire');
perf.recordSend({ id: 'c', totalMs: 1, at: Date.now() });
check("once a session is on CC-Wire its sends say so", perf.recentSends(1)[0].transport === 'ccwire');
perf.setSendTransport('socketio');

console.log(failures === 0 ? '\nAll transport-selection checks passed.\n' : `\n${failures} check(s) FAILED.\n`);
process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });
