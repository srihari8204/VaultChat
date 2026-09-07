// mm-scale.js — Phase 3: matchmaking-LAYER distribution + latency at scale.
// LOCAL ONLY (localhost:8090). Queues N players on the real /live/ws matchmaker
// (Redis-backed), measures per-player match latency and how many DISTINCT rooms
// they are distributed into. Does NOT attempt gameplay — matchmade rummy rooms
// collapse to "practice" (proven by mm-probe.js), so gameplay in them is not a
// valid test. This measures the matchmaker itself, which is real and works.

const http = require('http');
const WebSocket = require('ws');
const BASE = 'http://127.0.0.1:8090';
const LIVE = BASE.replace(/^http/, 'ws') + '/live/ws';
const GAME = process.env.GAME || 'rummy';
const N = Number(process.env.N || 1000);
const RATE = Number(process.env.RATE || 500); // queued/sec
const agent = new http.Agent({ keepAlive: true, maxSockets: 200 });

function post(p, b) {
  return new Promise((res, rej) => {
    const d = Buffer.from(JSON.stringify(b));
    const r = http.request(BASE + p, { method: 'POST', agent, headers: { 'content-type': 'application/json', 'content-length': d.length } },
      (x) => { const c = []; x.on('data', (y) => c.push(y)); x.on('end', () => res({ headers: x.headers, body: Buffer.concat(c).toString() })); });
    r.on('error', rej); r.setTimeout(15000, () => r.destroy(new Error('t/o'))); r.end(d);
  });
}
async function session(id) {
  const t = JSON.parse((await post('/dev/launch-token', { vaultId: id, displayName: id })).body).token;
  const s = await post('/api/session', { token: t });
  return (s.headers['set-cookie'] || []).map((c) => c.split(';')[0]).find((c) => c.startsWith('gsid='));
}
const wsOpen = (cookie) => new Promise((res, rej) => { const s = new WebSocket(LIVE, { headers: { Cookie: cookie } }); s.once('open', () => res(s)); s.once('error', rej); setTimeout(() => rej(new Error('t/o')), 12000); });

(async () => {
  // ONE DISTINCT session per player — the matchmaker keys on vaultId, so
  // sharing a cookie across sockets makes byVault deliver one match to many
  // sockets and corrupts pairing. Mint with bounded concurrency for speed.
  const cookies = new Array(N);
  let minted = 0;
  const CONC = 40;
  await Promise.all(Array.from({ length: CONC }, async (_, k) => {
    for (let i = k; i < N; i += CONC) {
      try { cookies[i] = await session(`@ms${i}`); minted++; } catch {}
    }
  }));
  process.stderr.write(`  minted ${minted}/${N} distinct sessions\n`);

  const rooms = new Set();
  const matchLat = [];
  let matched = 0, botoffer = 0, failed = 0, connected = 0;
  const queuedAt = new Map();
  const socks = [];

  async function one(i) {
    let s;
    if (!cookies[i]) { failed++; return; } try { s = await wsOpen(cookies[i]); } catch { failed++; return; }
    connected++; socks.push(s);
    s.on('message', (buf) => {
      let m; try { m = JSON.parse(buf.toString()); } catch { return; }
      if (m.t === 'match') { matched++; rooms.add(m.roomId); const q = queuedAt.get(s); if (q) matchLat.push(Date.now() - q); }
      else if (m.t === 'botoffer') { botoffer++; rooms.add(m.roomId); const q = queuedAt.get(s); if (q) matchLat.push(Date.now() - q); }
    });
    queuedAt.set(s, Date.now());
    s.send(JSON.stringify({ t: 'queue', game: GAME }));
  }

  const batch = Math.max(1, Math.round(RATE / 10));
  for (let i = 0; i < N; i += batch) {
    const w = [];
    for (let j = i; j < Math.min(i + batch, N); j++) w.push(one(j));
    await Promise.all(w);
    await new Promise((r) => setTimeout(r, 100));
  }
  // let the queue drain / bot-fallback (9s) fire for any unpaired tail
  await new Promise((r) => setTimeout(r, 11000));

  matchLat.sort((a, b) => a - b);
  const pct = (p) => matchLat.length ? +matchLat[Math.floor((p / 100) * matchLat.length)].toFixed(0) : 0;
  const out = {
    game: GAME, target: N, connected, failed,
    matched, botoffer, resolved: matched + botoffer,
    distinctRooms: rooms.size,
    matchP50: pct(50), matchP95: pct(95), matchP99: pct(99), matchMax: matchLat[matchLat.length - 1] || 0,
    at: new Date().toISOString(),
  };
  console.log(JSON.stringify(out));
  require('fs').appendFileSync(process.env.OUT || 'mm-scale-results.jsonl', JSON.stringify(out) + '\n');
  for (const s of socks) { try { s.close(); } catch {} }
  setTimeout(() => process.exit(0), 500);
})().catch((e) => { console.error('ERR', e.message); process.exit(1); });
