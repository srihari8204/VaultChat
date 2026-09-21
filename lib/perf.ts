// lib/perf.ts — lightweight perf tracer (Task 1, kept permanently).
//
// Ring buffer of the last 500 marks + a rolling window of the last 50 send
// timings. Each submission names its actual HTTP or CC-Wire carrier.
//   send_tap → encrypt_done → canonical server acknowledgement

export interface PerfMark {
  event: string;
  t: number;
  meta?: Record<string, unknown>;
}

// `__DEV__` is injected by Metro and does NOT exist under plain node, where the
// selftests run. A bare reference threw ReferenceError the moment any
// node-executed test reached a mark() — which localDb now does on every open.
const DEV = typeof __DEV__ !== 'undefined' && __DEV__;

const RING = 500;
const marks: PerfMark[] = [];
let markIdx = 0;

/** Marks that survive into release logs — the cold-start timeline only. */
const BOOT_MARK = /^(boot_|db_|chats_|socket_|transport_)/;

/** Record an event into the ring buffer (+ log in dev; boot marks always). */
export function mark(event: string, meta?: Record<string, unknown>): void {
  const m: PerfMark = { event, t: Date.now(), meta };
  marks[markIdx % RING] = m;
  markIdx++;
  // Boot marks log in RELEASE too. Without this the cold-start timeline exists
  // only in this ring buffer, readable solely by a human tapping into
  // app/perf-debug.tsx — so `adb logcat -s ReactNativeJS` could see the splash
  // appear but never when chats actually painted. Boot marks are a handful per
  // launch and carry no user data; every other mark stays dev-only.
  //
  // console.WARN, not console.log, and that is load-bearing: babel.config.js
  // runs transform-remove-console with `exclude: ['warn','error']` for the
  // production env, so a console.log here is DELETED from the release bundle
  // at build time. Verified the expensive way — a release APK was built and
  // installed with console.log and logged nothing at all on either handset.
  if (DEV) console.log(`[perf] ${event} @${m.t}`, meta ?? '');
  else if (BOOT_MARK.test(event)) console.warn(`[perf] ${event} @${m.t}`, meta ?? '');
}

/** The last `n` marks, oldest→newest. */
export function recentMarks(n = 50): PerfMark[] {
  const out: PerfMark[] = [];
  const start = Math.max(0, markIdx - Math.min(n, RING));
  for (let i = start; i < markIdx; i++) {
    const m = marks[i % RING];
    if (m) out.push(m);
  }
  return out;
}

// ── Per-send timing (correlated by client message id) ──────────────
export interface SendTiming {
  id: string;
  tapToEncrypt?: number;   // send tap → encryption finished (ms)
  encryptToAck?: number;   // encryption finished → canonical server result (ms)
  totalMs?: number;        // tap → ack
  transport?: string;
  failed?: boolean;
  at: number;
}

// Default submission path. Individual sends name the transport they used;
// a parallel socket's readiness must not rewrite that evidence.
let _sendTransport = 'http';
export function setSendTransport(name: string): void { _sendTransport = name; }

const sends: SendTiming[] = [];
export function recordSend(t: SendTiming): void {
  t.transport = t.transport ?? _sendTransport;
  sends.unshift(t);
  if (sends.length > 50) sends.length = 50;
  if (DEV) {
    console.log(
      `SEND id=${t.id} tap→encrypt=${t.tapToEncrypt ?? '?'}ms encrypt→ack=${t.encryptToAck ?? '?'}ms` +
      ` total=${t.totalMs ?? '?'}ms transport=${t.transport ?? '?'}${t.failed ? ' FAILED' : ''}`,
    );
  }
}
export function recentSends(n = 20): SendTiming[] {
  return sends.slice(0, n);
}

// ── Socket transport + reconnect tracking ──────────────────────────
let _transport = 'unknown';
let _connState: 'connected' | 'connecting' | 'disconnected' = 'disconnected';
let _reconnects = 0;

export function setTransport(name: string): void {
  _transport = name;
  if (name === 'polling') console.warn('[perf] ⚠️ socket is on POLLING transport, not websocket');
}
export function setConnState(s: 'connected' | 'connecting' | 'disconnected'): void { _connState = s; }
export function bumpReconnect(): void { _reconnects++; }

export function snapshot(): { transport: string; connState: string; reconnects: number } {
  return { transport: _transport, connState: _connState, reconnects: _reconnects };
}

export default {
  mark, recentMarks, recordSend, recentSends,
  setTransport, setSendTransport, setConnState, bumpReconnect, snapshot,
};
