#!/usr/bin/env node
// scripts/bench/sockets-bench.js — the three socket measurements the repo did
// not already have. Run through scripts/bench/run.sh, not directly.
//
// WHAT EXISTS ALREADY, AND IS NOT DUPLICATED HERE
// -----------------------------------------------
// vaultchat-backend/loadtest/ already measures, against ANY backend via --base:
//   fanout.js  — send→delivered latency + fan-out in a 50-member group
//   http.js    — /health and /chats latency
//   seed.js    — bench users, a 50-member group, and minted JWTs
// run.sh drives those. This file adds only what they do not measure:
//
//   connect  — socket connect + handshake latency distribution (sockets.js
//              reports a success COUNT, never a per-connect duration)
//   storm    — N clients reconnecting simultaneously: what a deploy causes
//   ceiling  — ramp sockets in steps, sampling the server's own
//              /internal/metrics (heap, goroutines, sockets_local) at each
//              step, and stop at the first sign of degradation
//
// PRECONDITIONS (all checked; any failure exits non-zero with the reason):
//   * --jwt-list points at a file of valid access tokens (seed.js writes one)
//   * the tokens are accepted by the server under test — a JWT_SECRET mismatch
//     produces 100% connect failures, which would otherwise read as "the
//     server cannot hold sockets"
//   * for `ceiling`, --metrics must be go-api's /internal/metrics, reachable
//     DIRECTLY (Caddy 404s /internal/*, so this is host:14000, not :18080)
//
// NO NUMBER IS PRODUCED WITHOUT ITS SAMPLE COUNT. Warmup connections are made
// and discarded before any percentile is computed.
//
// Usage:
//   node scripts/bench/sockets-bench.js connect --base http://127.0.0.1:18080 \
//     --jwt-list vaultchat-backend/loadtest/jwt-list.txt --samples 200 --warmup 20
//   node scripts/bench/sockets-bench.js storm   --clients 500
//   node scripts/bench/sockets-bench.js ceiling --steps 250,500,1000,2500,5000 \
//     --metrics http://127.0.0.1:14000/internal/metrics
//   node scripts/bench/sockets-bench.js --selftest

'use strict';

const fs = require('fs');
const path = require('path');

// ── percentiles ───────────────────────────────────────────────────────
// Nearest-rank (NIST), on an ASCENDING-sorted array. This deliberately differs
// from loadtest/fanout.js's `sorted[floor(p/100*len)]`, which reads one slot
// low and returns the MAXIMUM for p100 only by accident. The difference is at
// most one sample and matters only for tiny n — but a tail statistic that is
// wrong at the tail is the one statistic you cannot afford to be casual about.
function pct(sortedAsc, p) {
  if (!sortedAsc.length) return null;
  const rank = Math.ceil((p / 100) * sortedAsc.length);
  return sortedAsc[Math.min(sortedAsc.length - 1, Math.max(0, rank - 1))];
}

function summarize(samples) {
  const s = samples.slice().sort((a, b) => a - b);
  return {
    n: s.length,
    p50: pct(s, 50), p95: pct(s, 95), p99: pct(s, 99),
    min: s[0] ?? null, max: s[s.length - 1] ?? null,
    mean: s.length ? +(s.reduce((a, b) => a + b, 0) / s.length).toFixed(2) : null,
  };
}

// ── selftest (the one runnable check; `run.sh` invokes it before measuring) ──
if (process.argv.includes('--selftest')) {
  const assert = require('assert');
  const h = Array.from({ length: 100 }, (_, i) => i + 1); // 1..100
  assert.strictEqual(pct(h, 50), 50);
  assert.strictEqual(pct(h, 95), 95);
  assert.strictEqual(pct(h, 99), 99);
  assert.strictEqual(pct(h, 100), 100);
  assert.strictEqual(pct(h, 1), 1);
  assert.strictEqual(pct([], 50), null);
  assert.strictEqual(pct([7], 99), 7);
  // p99 must never be below p95, on any length — the property that catches an
  // off-by-one in the rank formula.
  for (let n = 1; n <= 40; n++) {
    const a = Array.from({ length: n }, (_, i) => i);
    assert.ok(pct(a, 99) >= pct(a, 95) && pct(a, 95) >= pct(a, 50), `monotonic at n=${n}`);
  }
  // summarize must report the count it computed from, not the count requested.
  assert.strictEqual(summarize([3, 1, 2]).n, 3);
  assert.strictEqual(summarize([3, 1, 2]).max, 3);
  console.log('sockets-bench selftest OK');
  process.exit(0);
}

// ── args ──────────────────────────────────────────────────────────────
const argv = process.argv.slice(2);
const MODE = argv[0];
function arg(name, def) {
  const i = argv.indexOf(`--${name}`);
  return i > -1 && argv[i + 1] !== undefined ? argv[i + 1] : def;
}
function num(name, def) { return parseInt(arg(name, String(def)), 10); }

function die(msg) {
  console.error(`\nFAILED PRECONDITION: ${msg}\n`);
  console.error('No number was produced. That is the correct outcome — a');
  console.error('measurement taken through a broken setup gets quoted later.\n');
  process.exit(2);
}

if (!['connect', 'storm', 'ceiling'].includes(MODE)) {
  die(`unknown mode ${JSON.stringify(MODE)}; expected connect | storm | ceiling (or --selftest)`);
}

const REPO = path.resolve(__dirname, '..', '..');
const BASE = arg('base', 'http://127.0.0.1:18080');
const JWT_LIST = path.resolve(REPO, arg('jwt-list', 'vaultchat-backend/loadtest/jwt-list.txt'));
const OUT = arg('out', '');
const CONNECT_TIMEOUT_MS = num('connect-timeout-ms', 20000);

let io;
try {
  ({ io } = require('socket.io-client'));
} catch {
  die('socket.io-client not resolvable from the repo root. It is ALREADY a '
    + 'dependency of this repo (package.json), so this means node_modules is '
    + 'missing: run `npm ci` at the repo root. Do not add a new dependency.');
}

if (!fs.existsSync(JWT_LIST)) {
  die(`token list not found: ${JWT_LIST}\n  Produce it first:\n`
    + '    cd vaultchat-backend && DB_HOST=127.0.0.1 DB_PORT=15432 JWT_SECRET=<server secret> \\\n'
    + '      node loadtest/seed.js --users 5000 --group-members 50');
}
const TOKENS = fs.readFileSync(JWT_LIST, 'utf8').split('\n').map((s) => s.trim()).filter(Boolean);
if (!TOKENS.length) die(`token list is empty: ${JWT_LIST}`);

// ── one connection, timed from the io() call to the 'connect' event ────
// That span is TCP + WS upgrade + the JWT auth middleware — which is what a
// user waits through before the app is live, and what N of them wait through
// together after a deploy.
function connectOne(token) {
  return new Promise((resolve) => {
    const t0 = Date.now();
    const s = io(BASE, { transports: ['websocket'], auth: { token }, reconnection: false });
    const timer = setTimeout(() => {
      try { s.close(); } catch { /* already gone */ }
      resolve({ ok: false, ms: Date.now() - t0, error: `timeout after ${CONNECT_TIMEOUT_MS}ms` });
    }, CONNECT_TIMEOUT_MS);
    s.on('connect', () => { clearTimeout(timer); resolve({ ok: true, ms: Date.now() - t0, socket: s }); });
    s.on('connect_error', (e) => {
      clearTimeout(timer);
      try { s.close(); } catch { /* already gone */ }
      resolve({ ok: false, ms: Date.now() - t0, error: e?.message || 'connect_error' });
    });
  });
}

// A JWT_SECRET mismatch, an unseeded database or a stopped server all look
// identical from here — total connect failure — and each would otherwise be
// reported as a capacity finding. One probe up front separates them.
async function probe() {
  const r = await connectOne(TOKENS[0]);
  if (!r.ok) {
    die(`the very first socket could not connect to ${BASE}: ${r.error}\n`
      + '  Likely causes, in order:\n'
      + '    1. JWT_SECRET used by loadtest/seed.js differs from the server\'s\n'
      + '       (the handshake middleware rejects and the client sees a generic error)\n'
      + '    2. the stack is not up, or --base points at the wrong port\n'
      + '       (18080 = through Caddy, 14000 = go-api direct)\n'
      + '    3. the bench users in the token list are not in this database');
  }
  r.socket.close();
}

function close(list) { for (const s of list) { try { s.close(); } catch { /* already gone */ } } }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── mode: connect ─────────────────────────────────────────────────────
// Sequential, one at a time. Measures the cost of a handshake when the server
// is NOT under connect pressure — the floor that `storm` is compared against.
async function runConnect() {
  const samples = num('samples', 200);
  const warmup = num('warmup', 20);
  const ms = [];
  const failures = [];
  for (let i = 0; i < warmup + samples; i++) {
    const r = await connectOne(TOKENS[i % TOKENS.length]);
    if (r.ok) { if (i >= warmup) ms.push(r.ms); r.socket.close(); }
    else if (i >= warmup) failures.push(r.error);
    await sleep(20);
  }
  if (failures.length) {
    die(`${failures.length}/${samples} sequential connects FAILED (${[...new Set(failures)].join(', ')}). `
      + 'A handshake percentile computed over a partial sample is not a baseline.');
  }
  return {
    mode: 'connect', base: BASE, samplesRequested: samples, warmupDiscarded: warmup,
    handshakeMs: summarize(ms),
  };
}

// ── mode: storm ───────────────────────────────────────────────────────
// N clients handshake at the same instant. This is the deploy case: every
// phone that was connected comes back at once.
//
// FIDELITY LIMIT, stated because it changes how the number should be read:
// the clients here reconnect against a server that is already warm. A real
// deploy also restarts the process, so its first seconds include Go's cold
// start and an empty membership cache (delivery.go caches chat membership in
// Redis for 30s; after a restart that cache is warm but the per-socket
// permission caches are not). Treat this as a LOWER bound on deploy recovery.
async function runStorm() {
  const clients = num('clients', 500);
  const rounds = num('rounds', 3);
  const warmupRounds = num('warmup-rounds', 1);
  const settleMs = num('settle-ms', 3000);

  const perRound = [];
  for (let round = 0; round < warmupRounds + rounds; round++) {
    const t0 = Date.now();
    const results = await Promise.all(
      Array.from({ length: clients }, (_, i) => connectOne(TOKENS[i % TOKENS.length])),
    );
    const wallMs = Date.now() - t0;
    const ok = results.filter((r) => r.ok);
    close(ok.map((r) => r.socket));
    await sleep(settleMs);
    if (round < warmupRounds) continue;
    perRound.push({
      clients,
      connected: ok.length,
      failed: results.length - ok.length,
      errors: [...new Set(results.filter((r) => !r.ok).map((r) => r.error))],
      // Wall time to get EVERY client back. This is the number that decides
      // whether a deploy is invisible or is a visible outage.
      wallMsToAllConnected: wallMs,
      handshakeMs: summarize(ok.map((r) => r.ms)),
    });
  }
  return {
    mode: 'storm', base: BASE, clients, rounds, warmupRoundsDiscarded: warmupRounds,
    rounds_: perRound,
  };
}

// ── mode: ceiling ─────────────────────────────────────────────────────
// Hold a growing number of idle sockets, reading the SERVER's own numbers at
// each step rather than guessing from the client side.
async function scrape(url) {
  const res = await fetch(url, { signal: AbortSignal.timeout(10000) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const text = await res.text();
  const pick = (name) => {
    const m = new RegExp(`^${name}\\s+([0-9.eE+-]+)$`, 'm').exec(text);
    return m ? Number(m[1]) : null;
  };
  return {
    heapAllocBytes: pick('vaultchat_heap_alloc_bytes'),
    goroutines: pick('vaultchat_goroutines'),
    socketsLocal: pick('vaultchat_sockets_local'),
    socketsOnline: pick('vaultchat_sockets_online'),
    usersLocal: pick('vaultchat_users_local'),
  };
}

async function runCeiling() {
  const steps = arg('steps', '250,500,1000,2500,5000').split(',').map(Number).filter(Boolean);
  const metrics = arg('metrics', 'http://127.0.0.1:14000/internal/metrics');
  const holdMs = num('hold-ms', 20000);
  const batch = num('batch', 100);
  // Stopping heuristic, NOT a target. Deliberately relative: the first step
  // defines "normal" for this host, and we stop when a later step is this many
  // times worse. An absolute millisecond number here would be invented.
  const degradeFactor = Number(arg('degrade-factor', '5'));

  let m0;
  try { m0 = await scrape(metrics); } catch (e) {
    die(`cannot read ${metrics}: ${e.message}\n`
      + '  /internal/* is 404ed by Caddy on purpose, so this MUST be go-api\'s\n'
      + '  own port (compose maps 14000:4000), not the 18080 proxy entry.\n'
      + '  Without it there is no server-side memory or socket count, and a\n'
      + '  ceiling measured only from the client is not a ceiling.');
  }
  if (m0.socketsLocal === null || m0.heapAllocBytes === null) {
    die(`${metrics} answered but carried no vaultchat_sockets_local / `
      + 'vaultchat_heap_alloc_bytes. Wrong process, or a build without metrics.Handler.');
  }
  if (m0.socketsLocal > 0) {
    die(`the server already holds ${m0.socketsLocal} sockets before this run started. `
      + 'A ceiling measured on top of unknown existing load is not comparable to '
      + 'anything. Drain them (or set --allow-existing-sockets is deliberately NOT '
      + 'offered) and re-run.');
  }

  const held = [];
  const table = [];
  let baselineP95 = null;
  let stopped = 'completed all steps';

  for (const target of steps) {
    const stepFailures = [];
    const stepMs = [];
    while (held.length < target) {
      const n = Math.min(batch, target - held.length);
      const rs = await Promise.all(
        Array.from({ length: n }, (_, i) => connectOne(TOKENS[(held.length + i) % TOKENS.length])),
      );
      for (const r of rs) {
        if (r.ok) { held.push(r.socket); stepMs.push(r.ms); }
        else stepFailures.push(r.error);
      }
      if (stepFailures.length) break;
    }
    await sleep(holdMs);           // let heartbeats settle before reading memory
    const m = await scrape(metrics);
    const hs = summarize(stepMs);
    const row = {
      targetSockets: target,
      heldSockets: held.length,
      connectFailures: stepFailures.length,
      errors: [...new Set(stepFailures)],
      handshakeMsDuringRamp: hs,
      server: m,
      // Comparable to the Node backend's measured ~20 KB per idle socket
      // (vaultchat-backend/loadtest/REPORT.md, 2026-07-26).
      heapBytesPerSocket: held.length
        ? Math.round((m.heapAllocBytes - m0.heapAllocBytes) / held.length) : null,
      // The server's own count must agree with ours. If it does not, sockets
      // are being dropped silently and every later row is fiction.
      serverClientSocketMismatch: m.socketsLocal !== null && m.socketsLocal !== held.length,
    };
    table.push(row);

    if (baselineP95 === null) baselineP95 = hs.p95;
    if (stepFailures.length) { stopped = `connect failures at ${target}: ${row.errors.join(', ')}`; break; }
    if (row.serverClientSocketMismatch) {
      stopped = `server reported ${m.socketsLocal} sockets, client holds ${held.length} at step ${target}`;
      break;
    }
    if (baselineP95 && hs.p95 > baselineP95 * degradeFactor) {
      stopped = `handshake p95 ${hs.p95}ms exceeded ${degradeFactor}x the first step's ${baselineP95}ms`;
      break;
    }
  }

  close(held);
  return {
    mode: 'ceiling', base: BASE, metrics, steps, holdMs, degradeFactor,
    serverBefore: m0, stoppedBecause: stopped, table,
  };
}

// ── main ──────────────────────────────────────────────────────────────
(async () => {
  await probe();
  const started = new Date().toISOString();
  const result = MODE === 'connect' ? await runConnect()
    : MODE === 'storm' ? await runStorm()
      : await runCeiling();
  result.startedAt = started;
  result.finishedAt = new Date().toISOString();
  result.tokenListSize = TOKENS.length;

  const json = JSON.stringify(result, null, 2);
  if (OUT) { fs.mkdirSync(path.dirname(OUT), { recursive: true }); fs.writeFileSync(OUT, json); }
  console.log(json);
  // socket.io-client keeps the event loop alive briefly after close().
  setTimeout(() => process.exit(0), 250).unref();
})().catch((e) => { console.error(e); process.exit(1); });
