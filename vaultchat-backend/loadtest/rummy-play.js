// rummy-play.js — GAMEPLAY fan-out load against the local rummy engine.
//
// Connection capacity was measured separately (rummy-ws.js). This measures the
// thing that actually matters at a live table: when one player acts, how fast
// does every seatmate see the new state, and how many actions/sec can the
// engine push across many concurrent tables.
//
// Each table: 2 REAL players (P0 host + P1) + 2 bots (addbot). P0 joins, P1
// joins the same table, P0 adds two bots and starts. Both humans run a legal
// auto-player: on your turn, draw from the closed pile (hand 13->14) then
// discard the first card (14->13). Server-side bots auto-play their turns, so
// the game cycles continuously.
//
// FAN-OUT LATENCY = time from a human's action-send to the OTHER human at that
// table receiving the resulting `state` frame. Measured cross-connection.

const http = require('http');
const WebSocket = require('ws');

const BASE = process.env.BASE || 'http://127.0.0.1:8090';
const WS = BASE.replace(/^http/, 'ws') + '/ws';
const PRESETS = ['practice','casual','pro'];
const TABLES = Math.min(Number(process.env.TABLES || 3), 3);
const SEATS = Number(process.env.SEATS || 6);
const SECONDS = Number(process.env.SECS || 30);
const agent = new http.Agent({ keepAlive: true, maxSockets: 200 });

function post(path, body) {
  return new Promise((resolve, reject) => {
    const data = Buffer.from(JSON.stringify(body));
    const req = http.request(BASE + path, { method: 'POST', agent,
      headers: { 'content-type': 'application/json', 'content-length': data.length } },
      (res) => { const c = []; res.on('data', (d) => c.push(d)); res.on('end', () => resolve({ headers: res.headers, body: Buffer.concat(c).toString() })); });
    req.on('error', reject); req.setTimeout(10000, () => req.destroy(new Error('t/o'))); req.end(data);
  });
}
async function session(id) {
  const t = JSON.parse((await post('/dev/launch-token', { vaultId: id, displayName: id })).body).token;
  const s = await post('/api/session', { token: t });
  return (s.headers['set-cookie'] || []).map((c) => c.split(';')[0]).find((c) => c.startsWith('gsid='));
}
function connect(cookie) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(WS, { headers: { Cookie: cookie } });
    ws.once('open', () => resolve(ws));
    ws.once('error', reject);
    setTimeout(() => reject(new Error('ws t/o')), 10000);
  });
}

// shared measurement state
const lat = [];           // fan-out latency samples (ms)
let actions = 0, errors = 0;
const lastActSend = new Map();  // tableId -> {who, t}

function seatBot(table, ws, me, tableId) {
  ws.on('message', (buf) => {
    let m; try { m = JSON.parse(buf.toString()); } catch { return; }
    if (m.t === 'error') { errors++; return; }
    if (m.t !== 'state' || !m.game) return;
    // fan-out: if a co-seat acted just now and this frame is for the OTHER human
    const pend = lastActSend.get(tableId);
    if (pend && pend.who !== me) {
      lat.push(Date.now() - pend.t);
      lastActSend.delete(tableId);
    }
    if (m.game.phase !== 'playing') return;
    if (m.game.turnPlayerId !== me) return;         // not my turn
    const hand = m.hand || [];
    // 13 => must draw; 14 => must discard
    if (hand.length <= 13) {
      ws.send(JSON.stringify({ t: 'draw', source: 'closed' }));
      actions++;
      lastActSend.set(tableId, { who: me, t: Date.now() });
    } else {
      ws.send(JSON.stringify({ t: 'discard', cardId: hand[0].id }));
      actions++;
      lastActSend.set(tableId, { who: me, t: Date.now() });
    }
  });
}

async function makeTable(idx) {
  const tableId = PRESETS[idx % PRESETS.length];
  const conns = [];
  for (let s = 0; s < SEATS; s++) {
    const vid = `@t${idx}s${s}`;
    const cookie = await session(vid);
    const ws = await connect(cookie);
    seatBot(tableId, ws, vid, tableId);
    conns.push({ ws, vid });
    ws.send(JSON.stringify({ t: 'join', tableId }));
    await new Promise((r) => setTimeout(r, 30));
  }
  // host (first seat) starts once all are seated
  conns[0].ws.send(JSON.stringify({ t: 'start' }));
  return conns.map((c) => c.ws);
}

(async () => {
  const all = [];
  let made = 0;
  for (let i = 0; i < TABLES; i++) {
    try { const ws = await makeTable(i); all.push(...ws); made++; }
    catch { errors++; }
    if (i % 25 === 0) process.stderr.write(`  tables=${made} actions=${actions} lat=${lat.length}\n`);
    await new Promise((r) => setTimeout(r, 8)); // gentle table-creation ramp
  }
  process.stderr.write(`  all ${made} tables started; running ${SECONDS}s of gameplay\n`);
  const t0 = Date.now();
  await new Promise((r) => setTimeout(r, SECONDS * 1000));
  const elapsed = (Date.now() - t0) / 1000;
  lat.sort((a, b) => a - b);
  const pct = (p) => lat.length ? +lat[Math.floor((p / 100) * lat.length)].toFixed(1) : 0;
  const out = {
    tables: made, seconds: +elapsed.toFixed(1),
    actions, actionsPerSec: +(actions / elapsed).toFixed(0), errors,
    fanoutSamples: lat.length,
    fanoutP50: pct(50), fanoutP95: pct(95), fanoutP99: pct(99), fanoutMax: +(lat[lat.length - 1] || 0).toFixed(1),
    at: new Date().toISOString(),
  };
  console.log(JSON.stringify(out));
  require('fs').appendFileSync(process.env.OUT || 'rummy-play-results.jsonl', JSON.stringify(out) + '\n');
  for (const w of all) { try { w.close(); } catch {} }
  setTimeout(() => process.exit(0), 500);
})();
