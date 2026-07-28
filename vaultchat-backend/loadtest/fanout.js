// vaultchat-backend/loadtest/fanout.js
//
// Message fan-out throughput + end-to-end delivery latency (Phase 2 Step 0).
//
// Connects N member sockets of the bench group (seed.js), then drives the REAL
// production send path — REST POST /chats/:id/messages — at increasing rates
// while every member socket timestamps its 'new_message' deliveries. The clock
// is the same machine for senders and receivers, so latency = recvTs - sentTs.
//
// Reports per stage: send rate achieved, deliveries/s, delivery ratio,
// p50/p95/p99/max delivery latency, send errors, api container memory.
//
// Run:
//   node loadtest/fanout.js --base http://127.0.0.1:13000 \
//     --members 50 --senders 5 --rates 10,25,50,100 --stage-secs 30
//
// Requires loadtest/bench-state.json (node loadtest/seed.js first).

const { io } = require('socket.io-client');
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const { argv } = require('process');

function arg(name, def) {
  const i = argv.indexOf(`--${name}`);
  return i > -1 ? argv[i + 1] : def;
}

const BASE = arg('base', 'http://127.0.0.1:13000');
const MEMBERS = parseInt(arg('members', '50'), 10);
const SENDERS = parseInt(arg('senders', '5'), 10);
const RATES = arg('rates', '10,25,50').split(',').map(Number);
const STAGE_SECS = parseInt(arg('stage-secs', '30'), 10);
const STATE = JSON.parse(fs.readFileSync(path.join(__dirname, 'bench-state.json'), 'utf8'));

const chatId = STATE.groupChatId;
const members = STATE.users.slice(0, MEMBERS);

function pct(sorted, p) {
  if (!sorted.length) return 0;
  return sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))];
}

function apiMemory() {
  try {
    const out = execSync('docker stats --no-stream --format "{{.Name}}|{{.MemUsage}}|{{.CPUPerc}}"', {
      encoding: 'utf8', timeout: 15000,
    });
    const line = out.split('\n').find(l => l.includes('api'));
    return line ? line.trim() : 'n/a';
  } catch { return 'n/a'; }
}

async function connectAll() {
  console.log(`connecting ${members.length} member sockets…`);
  const sockets = await Promise.all(members.map((u, idx) => new Promise((resolve, reject) => {
    const s = io(BASE, { transports: ['websocket'], auth: { token: u.jwt }, reconnection: false });
    const t = setTimeout(() => reject(new Error(`socket ${idx} connect timeout`)), 15000);
    s.on('connect', () => { clearTimeout(t); s.emit('join_chat', { chatId }); resolve(s); });
    s.on('connect_error', (e) => { clearTimeout(t); reject(new Error(`socket ${idx}: ${e.message}`)); });
  })));
  console.log('all members connected + joined');
  return sockets;
}

async function runStage(sockets, rate) {
  const stage = {
    rate, sent: 0, sendErrors: 0, deliveries: 0, latencies: [],
    sendLatencies: [], start: Date.now(),
  };
  const seen = new Set(); // dedupe guard: `${socketIdx}|${seq}`

  const handlers = sockets.map((s, idx) => {
    const h = (msg) => {
      const recvTs = Date.now();
      const m = /^bench\|(\d+)\|(\d+)$/.exec(msg?.content || '');
      if (!m) return;
      const key = `${idx}|${m[1]}`;
      if (seen.has(key)) return;
      seen.add(key);
      stage.deliveries++;
      stage.latencies.push(recvTs - Number(m[2]));
    };
    s.on('new_message', h);
    return h;
  });

  const intervalMs = 1000 / rate;
  let seq = 0;
  let nextAt = Date.now();
  const endAt = Date.now() + STAGE_SECS * 1000;

  while (Date.now() < endAt) {
    const wait = nextAt - Date.now();
    if (wait > 0) await new Promise(r => setTimeout(r, wait));
    nextAt += intervalMs;
    const sender = members[seq % SENDERS];
    const mySeq = seq++;
    const sentAt = Date.now();
    fetch(`${BASE}/chats/${chatId}/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${sender.jwt}` },
      body: JSON.stringify({ type: 'text', content: `bench|${mySeq}|${sentAt}` }),
    }).then((r) => {
      stage.sendLatencies.push(Date.now() - sentAt);
      if (r.ok) stage.sent++; else stage.sendErrors++;
    }).catch(() => { stage.sendErrors++; });
  }

  // Drain: give in-flight deliveries 5s to arrive.
  await new Promise(r => setTimeout(r, 5000));
  for (let i = 0; i < sockets.length; i++) sockets[i].off('new_message', handlers[i]);

  const elapsed = (Date.now() - stage.start - 5000) / 1000;
  const lat = stage.latencies.sort((a, b) => a - b);
  const slat = stage.sendLatencies.sort((a, b) => a - b);
  // Every member socket receives, including the sender's own (multi-device model).
  const expected = stage.sent * members.length;
  console.log(`\n── stage rate=${rate} msg/s (${STAGE_SECS}s, ${MEMBERS} members) ──`);
  console.log(`  sent:            ${stage.sent} ok, ${stage.sendErrors} errors (${(stage.sent / elapsed).toFixed(1)}/s achieved)`);
  console.log(`  POST latency:    p50=${pct(slat, 50)}ms p95=${pct(slat, 95)}ms p99=${pct(slat, 99)}ms`);
  console.log(`  deliveries:      ${stage.deliveries}/${expected} (${expected ? ((stage.deliveries / expected) * 100).toFixed(2) : 0}%) → ${(stage.deliveries / elapsed).toFixed(0)}/s`);
  console.log(`  delivery p50:    ${pct(lat, 50)}ms  p95: ${pct(lat, 95)}ms  p99: ${pct(lat, 99)}ms  max: ${lat[lat.length - 1] ?? 0}ms`);
  console.log(`  api container:   ${apiMemory()}`);
  return {
    rate, sent: stage.sent, sendErrors: stage.sendErrors,
    achievedRate: +(stage.sent / elapsed).toFixed(1),
    postP50: pct(slat, 50), postP95: pct(slat, 95), postP99: pct(slat, 99),
    deliveries: stage.deliveries, expected,
    deliveryRatio: expected ? +((stage.deliveries / expected)).toFixed(4) : 0,
    deliveriesPerSec: +(stage.deliveries / elapsed).toFixed(0),
    p50: pct(lat, 50), p95: pct(lat, 95), p99: pct(lat, 99), max: lat[lat.length - 1] ?? 0,
    apiStats: apiMemory(),
  };
}

async function main() {
  console.log(`fan-out bench → ${BASE}, chat=${chatId}, members=${MEMBERS}, senders=${SENDERS}`);
  console.log(`api container before: ${apiMemory()}`);
  const sockets = await connectAll();
  await new Promise(r => setTimeout(r, 2000));

  const results = [];
  for (const rate of RATES) {
    results.push(await runStage(sockets, rate));
  }

  fs.writeFileSync(
    path.join(__dirname, 'fanout-results.json'),
    JSON.stringify({ base: BASE, members: MEMBERS, senders: SENDERS, stageSecs: STAGE_SECS, results, at: new Date().toISOString() }, null, 2),
  );
  console.log('\nwrote loadtest/fanout-results.json');
  for (const s of sockets) s.disconnect();
  process.exit(0);
}

main().catch((e) => { console.error(e); process.exit(1); });
