// lib/perf.ts — lightweight perf tracer (Task 1, kept permanently).
//
// Ring buffer of the last 500 marks + a rolling window of the last 50 send
// timings. Adapted to VaultChat's REAL send path: messages go out over HTTP
// POST (not a socket emit), so the meaningful segments are
//   send_tap → encrypt_done → http_ack
// (i.e. how long E2EE encryption takes, then the POST round-trip).

export interface PerfMark {
  event: string;
  t: number;
  meta?: Record<string, unknown>;
}

const RING = 500;
const marks: PerfMark[] = [];
let markIdx = 0;

/** Record an event into the ring buffer (+ log in dev). */
export function mark(event: string, meta?: Record<string, unknown>): void {
  const m: PerfMark = { event, t: Date.now(), meta };
  marks[markIdx % RING] = m;
  markIdx++;
  if (__DEV__) console.log(`[perf] ${event}`, meta ?? '');
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
  encryptToAck?: number;   // encryption finished → HTTP ack (ms)
  totalMs?: number;        // tap → ack
  transport?: string;
  failed?: boolean;
  at: number;
}

// §21 rollout cohort tag — "socketio" | "ccwire", the transport that actually
// carried the send (docs/ROLLOUT_TRANSPORT.md §4). Set by lib/socket.ts at
// connect time; defaults to the live path, so with no flag configured every
// send is tagged "socketio", which is the truth today.
let _sendTransport = 'socketio';
export function setSendTransport(name: string): void { _sendTransport = name; }

const sends: SendTiming[] = [];
export function recordSend(t: SendTiming): void {
  // Overwrites whatever the caller passed. Call sites pass snapshot().transport
  // — the engine name ("websocket"/"polling") — which cannot answer "which
  // cohort was this?", and that is the question a staged rollout is aborted on.
  // The engine name is still recorded by setTransport/snapshot and the
  // socket_connect mark, so nothing is lost.
  t.transport = _sendTransport;
  sends.unshift(t);
  if (sends.length > 50) sends.length = 50;
  if (__DEV__) {
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
