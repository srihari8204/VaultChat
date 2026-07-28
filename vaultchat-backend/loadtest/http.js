// vaultchat-backend/loadtest/http.js
//
// Plain-Node HTTP latency driver (k6-compatible targets, no k6 install needed).
// Mirrors loadtest/http.k6.js: each VU = one signed-in user pacing ~1 req/s.
//
//   node loadtest/http.js --base http://127.0.0.1:13000 --vus 200 --duration 60 --mode health
//   node loadtest/http.js --base http://127.0.0.1:13000 --vus 100 --duration 60 --mode chats
//
// Acceptance (from http.k6.js): /health p95 < 100ms @200 VUs;
// /chats p95 < 400ms @100 VUs; error rate < 1%.

const fs = require('fs');
const path = require('path');
const { argv } = require('process');

function arg(name, def) {
  const i = argv.indexOf(`--${name}`);
  return i > -1 ? argv[i + 1] : def;
}

const BASE = arg('base', 'http://127.0.0.1:13000');
const VUS = parseInt(arg('vus', '200'), 10);
const DURATION = parseInt(arg('duration', '60'), 10);
const MODE = arg('mode', 'health'); // health | chats
const STATE = JSON.parse(fs.readFileSync(path.join(__dirname, 'bench-state.json'), 'utf8'));

const lat = [];
let ok = 0, errors = 0;

function pct(sorted, p) {
  if (!sorted.length) return 0;
  return sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))];
}

async function vu(i) {
  const user = STATE.users[i % STATE.users.length];
  const url = MODE === 'chats' ? `${BASE}/chats` : `${BASE}/health`;
  const headers = MODE === 'chats' ? { Authorization: `Bearer ${user.jwt}` } : {};
  const endAt = Date.now() + DURATION * 1000;
  while (Date.now() < endAt) {
    const t0 = Date.now();
    try {
      const r = await fetch(url, { headers });
      await r.arrayBuffer(); // consume body
      const ms = Date.now() - t0;
      lat.push(ms);
      if (r.status === 200) ok++; else errors++;
    } catch { errors++; }
    // pace ~1 req/s per VU like the k6 script
    const spent = Date.now() - t0;
    if (spent < 1000) await new Promise(r => setTimeout(r, 1000 - spent));
  }
}

async function main() {
  console.log(`http bench → ${BASE} mode=${MODE} vus=${VUS} duration=${DURATION}s`);
  const t0 = Date.now();
  // stagger VU starts over 2s to avoid a thundering herd at t=0
  await Promise.all(Array.from({ length: VUS }, (_, i) =>
    new Promise(r => setTimeout(r, (i * 2000) / VUS)).then(() => vu(i))));
  const elapsed = (Date.now() - t0) / 1000;
  lat.sort((a, b) => a - b);
  const total = ok + errors;
  console.log(`\n── ${MODE} @ ${VUS} VUs for ${DURATION}s ──`);
  console.log(`  requests: ${total} (${(total / elapsed).toFixed(1)}/s), errors: ${errors} (${total ? ((errors / total) * 100).toFixed(2) : 0}%)`);
  console.log(`  latency:  p50=${pct(lat, 50)}ms p95=${pct(lat, 95)}ms p99=${pct(lat, 99)}ms max=${lat[lat.length - 1] ?? 0}ms`);
  const target = MODE === 'health' ? 100 : 400;
  console.log(`  target:   p95 < ${target}ms → ${pct(lat, 95) < target ? 'PASS ✓' : 'FAIL ✗'}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
