// rummy-ws.js — REAL rummy-engine WebSocket load test against the LOCAL games
// server (vaultchat-games-integration, localhost:8090, GAMES_DEV_MODE).
//
// Flow per client, exactly what the app does:
//   POST /dev/launch-token {vaultId,displayName} -> {token}
//   POST /api/session {token}                    -> Set-Cookie: gsid
//   WS   /ws  with that cookie                   -> server sends {t:"hello"}
//   send {t:"join", tableId}                     -> seated; 4 per table
//
// HARD CLIENT LIMIT: Windows has 16,384 ephemeral ports to one host:port, so
// one box holds ~16k connections MAX. Past that is EADDRNOTAVAIL on the client,
// NOT a server failure. We measure up to a safe tier and extrapolate memory/CPU
// per connection to 30k/50k/100k.

const http = require('http');
const WebSocket = require('ws');

const BASE = process.env.BASE || 'http://127.0.0.1:8090';
const WS = BASE.replace(/^http/, 'ws') + '/ws';
const TARGET = Number(process.env.N || 2000);
const OPEN_RATE = Number(process.env.RATE || 400);   // new connections per second
const DWELL = Number(process.env.DWELL || 8);        // seconds to hold at full count
const SEATS = 4;

const POOL = Number(process.env.POOL || 500);       // distinct sessions pre-minted
const agent = new http.Agent({ keepAlive: true, maxSockets: 200 });

function post(path, body) {
  return new Promise((resolve, reject) => {
    const data = Buffer.from(JSON.stringify(body));
    const req = http.request(BASE + path, {
      method: 'POST', agent,
      headers: { 'content-type': 'application/json', 'content-length': data.length },
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString() }));
    });
    req.on('error', reject);
    req.setTimeout(10000, () => { req.destroy(new Error('timeout')); });
    req.end(data);
  });
}

async function session(i) {
  const t = await post('/dev/launch-token', { vaultId: `@lt${i}`, displayName: `LT${i}` });
  const tok = JSON.parse(t.body).token;
  const s = await post('/api/session', { token: tok });
  const setc = s.headers['set-cookie'] || [];
  const gsid = setc.map((c) => c.split(';')[0]).find((c) => c.startsWith('gsid='));
  if (!gsid) throw new Error('no gsid cookie');
  return gsid;
}

const conns = [];
let opened = 0, failed = 0, helloOK = 0;
const helloRtt = [];

// Pre-minted cookie pool, reused round-robin so the WS ramp is not competing
// with HTTP mints for sockets. Distinct sessions still let tables seat distinct
// players; connection ceiling + memory (the point of this test) are unaffected
// by reuse.
const cookiePool = [];
async function mintPool() {
  for (let i = 0; i < POOL; i++) {
    try { cookiePool.push(await session(i)); } catch {}
  }
  if (!cookiePool.length) throw new Error('could not mint any session');
  process.stderr.write(`  pool: ${cookiePool.length}/${POOL} sessions minted\n`);
}

function openOne(i) {
  return new Promise((resolve) => {
    const gsid = cookiePool[i % cookiePool.length];
    const t0 = process.hrtime.bigint();
    let settled = false;
    const done = () => { if (!settled) { settled = true; resolve(); } };
    const ws = new WebSocket(WS, { headers: { Cookie: gsid } });
    ws.on('open', () => {});
    ws.on('message', (buf) => {
      let m; try { m = JSON.parse(buf.toString()); } catch { return; }
      if (m.t === 'hello') {
        helloOK++;
        helloRtt.push(Number(process.hrtime.bigint() - t0) / 1e6);
        ws.send(JSON.stringify({ t: 'join', tableId: `lt${Math.floor(i / SEATS)}` }));
        opened++;
        conns.push(ws);
        done();
      }
    });
    ws.on('error', () => { failed++; done(); });
    ws.on('close', () => { done(); });
    setTimeout(done, 12000);
  });
}

async function run() {
  await mintPool();
  const batch = Math.max(1, Math.round(OPEN_RATE / 10)); // open in 100ms waves
  for (let i = 0; i < TARGET; i += batch) {
    const wave = [];
    for (let j = i; j < Math.min(i + batch, TARGET); j++) wave.push(openOne(j));
    await Promise.all(wave);
    await new Promise((r) => setTimeout(r, 100));
    if (i % 1000 < batch) process.stderr.write(`  opened=${opened} failed=${failed} live=${conns.filter((c) => c.readyState === 1).length}\n`);
  }
  // hold
  await new Promise((r) => setTimeout(r, DWELL * 1000));
  const live = conns.filter((c) => c.readyState === 1).length;
  helloRtt.sort((a, b) => a - b);
  const pct = (p) => helloRtt.length ? +helloRtt[Math.floor((p / 100) * helloRtt.length)].toFixed(1) : 0;
  const out = {
    target: TARGET, opened, live, failed,
    helloOK, helloP50: pct(50), helloP95: pct(95), helloP99: pct(99),
    at: new Date().toISOString(),
  };
  console.log(JSON.stringify(out));
  require('fs').appendFileSync(process.env.OUT || 'rummy-ws-results.jsonl', JSON.stringify(out) + '\n');
  for (const c of conns) { try { c.close(); } catch {} }
  setTimeout(() => process.exit(0), 500);
}
run();
