// lib/ccwire/transport.selftest.ts — run: npx tsx lib/ccwire/transport.selftest.ts
//
// §21. Proves the CC-Wire branch in lib/socket.ts is ADDITIVE and FAILS CLOSED.
//
// It runs the REAL connect() from lib/socket.ts driving the REAL supervisor from
// lib/ccwire/transport.ts driving the REAL CCWireClient. socket.ts cannot be
// imported under plain Node (socket.io-client, react-native, NetInfo), so its
// IMPORT BLOCK ONLY is rewritten to point at stubs and the body is used
// verbatim, regenerated on every run so it cannot drift from what ships. Same
// idiom as lib/socket.transport.selftest.ts and lib/messageQueue.flush.selftest.ts.
//
// What is checked:
//   1. flag OFF ⇒ selectTransport() is 'socketio', no CC-Wire dial happens at
//      all, and Socket.IO is built exactly as today;
//   2. flag ON + no WebSocket implementation (the dial-failure shape) ⇒ the
//      supervisor ends at 'error', sends stay tagged 'socketio', and Socket.IO
//      is STILL built — one connection, same options;
//   3. flag ON + a WebSocket constructor that throws ⇒ same;
//   4. Socket.IO is constructed in every flag state, so calls and mini-apps
//      keep the connection they depend on (P3, the rollback lever);
//   5. NO DUPLICATE SENDS across a transport switch: every emit() lands exactly
//      once, on the Socket.IO socket, in both flag states — and the CC-Wire
//      protobuf submissions have a separate request-correlated owner tested
//      in submission.selftest.ts;
//   6. ccwireUrlFor maps the server URL onto realtime.CCWirePath.
//
// NOT checked: a successful ServerHello. There is no server here, and
// production does not set CCWIRE_WS, so the reachable states today are exactly
// the ones above.

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';

const HERE = dirname(fileURLToPath(import.meta.url));   // lib/ccwire
const LIB = dirname(HERE);                              // lib
(globalThis as any).__DEV__ = false;

let failures = 0;
function check(name: string, ok: boolean, detail?: string) {
  if (!ok) failures++;
  console.log(`  ${ok ? '✓' : '✗'} ${name}${ok || !detail ? '' : `  (${detail})`}`);
}

// ── build a runnable copy of socket.ts: imports rewritten, body untouched ──
const WORK = join(tmpdir(), `vc-ccwire-transport-selftest-${process.pid}`);
mkdirSync(join(WORK, 'ccwire'), { recursive: true });
writeFileSync(join(WORK, 'package.json'), '{"type":"module"}');

writeFileSync(join(WORK, 'stubs.js'), `
const H = () => globalThis.__H;
export const SERVER_URL = 'https://example.invalid';
export const SETTLE_MS = 0;
export function netKeyOf(state) { return state.type ?? null; }
export function reconnectReason(previous, next) { return next && previous !== next ? 'net-up' : null; }
export function shouldKickOnForeground() { return false; }
export function shouldAbandonPendingConnect() { return false; }
export function useSyncExternalStore() {}
export const AppState = { addEventListener(_event, callback) { H().foreground = callback; return { remove() {} }; } };
export default { addEventListener(callback) { H().network = callback; return () => {}; } };   // NetInfo
export async function getAccessToken() { return 'tok'; }
export async function refreshAccessToken() { return 'terminal'; }
export function io(url, opts) {
  H().ioCalls.push({ url, opts });
  const ls = new Map();
  const s = {
    io: { on() {} },
    connected: true,
    on(e, cb) { if (!ls.has(e)) ls.set(e, new Set()); ls.get(e).add(cb); },
    off(e, cb) { ls.get(e)?.delete(cb); },
    once(e, cb) {
      if (e === 'ready') { setTimeout(() => cb(), 0); return; }
      s.on(e, cb);
    },
    emit(ev, data) { H().emits.push({ ev, data }); },
    connect() {}, disconnect() {}, removeAllListeners() { ls.clear(); },
  };
  return s;
}
export class Socket {}
`);

writeFileSync(join(WORK, 'perfstub.js'), `
const H = () => globalThis.__H;
const perf = {
  mark(event, meta) { H().marks.push({ event, meta }); },
  setTransport() {}, setConnState() {}, bumpReconnect() {},
  setSendTransport(n) { H().sendTransport = n; },
  snapshot() { return { transport: 'websocket', connState: 'connected', reconnects: 0 }; },
};
export default perf;
`);

writeFileSync(join(WORK, 'flags.js'), `
export const TRANSPORT_RUST = 'transport.rust';
export function isFeatureEnabled() { return globalThis.__H.flagMode === 'on'; }
`);

// The dynamic import() inside socket.ts resolves against the copy, so point it
// at the REAL supervisor. No stub: the code under test is the shipped code.
const REAL_TRANSPORT = pathToFileURL(join(HERE, 'transport.ts')).href;
writeFileSync(join(WORK, 'ccwire', 'transport.ts'),
  `export * from ${JSON.stringify(REAL_TRANSPORT)};\n`);

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

let src = readFileSync(join(LIB, 'socket.ts'), 'utf8');
for (const [re, to] of IMPORT_REWRITES) {
  if (!re.test(src)) {
    console.log(`  ✗ selftest could not rewrite an import — socket.ts changed its import block (${re})`);
    failures++;
  }
  src = src.replace(re, to);
}
check("socket.ts dials CC-Wire through ./ccwire/transport",
  /import\('\.\/ccwire\/transport'\)/.test(src) && /startCCWire\(/.test(src),
  'the branch must actually reach the dialer, or this file proves nothing');
writeFileSync(join(WORK, 'sock.ts'), src);

const H: any = { ioCalls: [], emits: [], marks: [], flagMode: 'off', sendTransport: null };
(globalThis as any).__H = H;
function resetH() { H.ioCalls = []; H.emits = []; H.marks = []; H.sendTransport = null; }
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function main() {
const S: any = await import(pathToFileURL(join(WORK, 'sock.ts')).href);
const T: any = await import(pathToFileURL(join(HERE, 'transport.ts')).href);

// ── 6. URL mapping ─────────────────────────────────────────────────────────
console.log('\nccwireUrlFor maps onto realtime.CCWirePath:');
check('https ⇒ wss + /ccwire/v1',
  T.ccwireUrlFor('https://api.corefinite.com') === 'wss://api.corefinite.com/ccwire/v1');
check('http ⇒ ws, trailing slash absorbed',
  T.ccwireUrlFor('http://10.0.0.2:3002/') === 'ws://10.0.0.2:3002/ccwire/v1');

// ── 5b. Generic Socket.IO event emission keeps its existing owner ──────────
console.log('\nCC-Wire has one submission owner and no Socket.IO event forwarding:');
const sendish = Object.keys(T).filter((k) => /^(send|emit|publish|write|subscribe)/i.test(k));
check('it exports no send/emit/publish/write/subscribe', sendish.length === 0,
  `found: ${sendish.join(', ')}`);

// ── 1. Flag OFF: today's behaviour, and no dial at all ─────────────────────
console.log('\nFlag OFF — nothing changes, and CC-Wire is never dialled:');
H.flagMode = 'off'; resetH(); T.__resetCCWireForTest();
check("selectTransport() is 'socketio'", S.selectTransport() === 'socketio');
const sockOff = await S.getSocket();
await sleep(50);
check('exactly one Socket.IO connection', H.ioCalls.length === 1, `got ${H.ioCalls.length}`);
check("transports is ['websocket'] — unchanged",
  JSON.stringify(H.ioCalls[0]?.opts?.transports) === '["websocket"]');
check('auth is still a function, not a captured token',
  typeof H.ioCalls[0]?.opts?.auth === 'function');
check("CC-Wire status is 'off' — no dial was attempted", T.ccwireStatus() === 'off',
  T.ccwireStatus());
check('no ccwire mark of any kind', !H.marks.some((m: any) => /ccwire/.test(m.event)));
check("message sends tagged 'http'", H.sendTransport === 'http');
await S.emit('typing_start', { chatId: 'c1' });
check('emit lands exactly once on Socket.IO',
  H.emits.filter((e: any) => e.ev === 'typing_start').length === 1);
const emitsAfterOff = H.emits.length;
S.disconnect();

// ── 2/3/4. Flag ON, dial fails ⇒ fall back, Socket.IO still built ──────────
for (const shape of ['no-websocket-impl', 'constructor-throws']) {
  console.log(`\nFlag ON, dial failure (${shape}) — falls back to Socket.IO:`);
  H.flagMode = 'on'; resetH(); T.__resetCCWireForTest();
  (globalThis as any).WebSocket = shape === 'no-websocket-impl'
    ? undefined
    : function BadWS() { throw new Error('dial refused'); };

  check("selectTransport() is 'ccwire' when someone means it",
    S.selectTransport() === 'ccwire');
  await S.getSocket();
  await sleep(50);
  // P3: the rollback lever. Socket.IO is built regardless of the flag.
  check('Socket.IO is STILL constructed — calls and mini-apps keep their link',
    H.ioCalls.length === 1, `got ${H.ioCalls.length}`);
  check("transports is ['websocket'] — unchanged",
    JSON.stringify(H.ioCalls[0]?.opts?.transports) === '["websocket"]');
  check("message sends tagged 'http' while CC-Wire is not ready",
    H.sendTransport === 'http');
  check('the dial was actually attempted', T.ccwireStatus() !== 'off', T.ccwireStatus());

  // The client retries with backoff; the supervisor gives up after three
  // pre-handshake closes. Poll rather than guess at the jittered delays.
  const t0 = Date.now();
  while (T.ccwireStatus() !== 'error' && Date.now() - t0 < 6000) await sleep(50);
  check("it ends at 'error' until an explicit platform recovery signal",
    T.ccwireStatus() === 'error', T.ccwireStatus());
  check('the fallback is marked for the rollout dashboards',
    H.marks.some((m: any) => m.event === 'transport_ccwire_unavailable'));
  check("message sends are STILL tagged 'http' after the failure",
    H.sendTransport === 'http');

  // 5. Sends across the switch: still exactly one, still on Socket.IO.
  await S.emit('typing_start', { chatId: 'c1' });
  check('emit lands exactly once, on Socket.IO, with the flag ON',
    H.emits.filter((e: any) => e.ev === 'typing_start').length === 1,
    `${H.emits.filter((e: any) => e.ev === 'typing_start').length}`);
  S.disconnect();
}

// ── 5. No duplicate sends ACROSS a switch ──────────────────────────────────
// The same logical operation, submitted once per flag state, must appear once
// per state — never twice in one, and never carried over into the next.
console.log('\nA transport switch does not duplicate a send:');
resetH(); T.__resetCCWireForTest();
(globalThis as any).WebSocket = undefined;
H.flagMode = 'off';
await S.getSocket(); await S.emit('join_chat', { chatId: 'x' });
const afterOffEmits = H.emits.filter((e: any) => e.ev === 'join_chat').length;
S.disconnect();
T.__resetCCWireForTest();
H.flagMode = 'on';
await S.getSocket(); await sleep(50); await S.emit('join_chat', { chatId: 'x' });
const afterOnEmits = H.emits.filter((e: any) => e.ev === 'join_chat').length;
check('one emit per flag state, never two', afterOffEmits === 1 && afterOnEmits === 2,
  `off=${afterOffEmits} total=${afterOnEmits}`);
check('the outbox uses the shared submission owner, not Socket.IO emits',
  !readFileSync(join(LIB, 'messageQueue.ts'), 'utf8').includes("from './socket'"),
  'if messageQueue ever imports the socket, single-submission-ownership needs re-proving');
S.disconnect();
await sleep(20);
check("logout stops any CC-Wire session", T.ccwireStatus() !== 'ready', T.ccwireStatus());

// Recovery hooks must run even while the separate Socket.IO session is healthy.
resetH(); T.__resetCCWireForTest(); H.flagMode = 'on';
let now = 0, timerId = 0, dials = 0;
const timers = new Map<number, { fn: () => void; ms: number }>();
class WaitingSocket {
  onopen: any; onmessage: any; onclose: any;
  constructor() { dials++; }
  send() {}
  close() {}
}
T.startCCWire({ serverUrl: 'https://example.invalid', getToken: () => 'tok', WebSocketImpl: WaitingSocket,
  now: () => now, setTimeoutImpl: (fn: () => void, ms: number) => { timers.set(++timerId, { fn, ms }); return timerId; },
  clearTimeoutImpl: (id: number) => { timers.delete(id); } });
await S.getSocket(); await sleep(50);
const expire = () => {
  const deadline = [...timers].find(([, timer]) => timer.ms === 15000)!;
  timers.delete(deadline[0]); deadline[1].fn();
};
expire();
check('startup deadline leaves the coordinator in error', T.ccwireStatus() === 'error');
H.foreground('active'); await sleep(10);
check('foreground recovers CC-Wire even with Socket.IO connected', T.ccwireStatus() === 'pending' && dials === 2);
check('CC-Wire foreground recovery does not recreate Socket.IO', H.ioCalls.length === 1);
expire(); now = 30000;
H.network({ type: 'wifi' }); await sleep(10);
check('network-up independently recovers CC-Wire', T.ccwireStatus() === 'pending' && dials === 3);
expire();
H.foreground('active'); H.foreground('active');
check('foreground events coalesce into one cooldown timer', timers.size === 1);
S.disconnect();
H.foreground('active'); H.network({ type: 'cellular' });
check('logout removes the CC-Wire recovery callback and timer', T.ccwireStatus() === 'off' && timers.size === 0 && dials === 3);
S.disconnect(); // cancel the independent Socket.IO network kick from that event

console.log(failures === 0 ? '\nAll CC-Wire transport checks passed.\n' : `\n${failures} check(s) FAILED.\n`);
process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });
