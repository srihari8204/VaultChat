// mm-probe.js — Phase 1 empirical check of the /live/ws matchmaker for rummy.
// Queues N players for a game, records the match events they receive, then (for
// rummy) has each matched pair try to join their assigned mm- room on /ws and
// reports which room they LAND in. Proves whether matchmade rummy tables are
// real and independent, or collapse. LOCAL ONLY (localhost:8090).

const http = require('http');
const WebSocket = require('ws');
const BASE = 'http://127.0.0.1:8090';
const LIVE = BASE.replace(/^http/, 'ws') + '/live/ws';
const WS = BASE.replace(/^http/, "ws") + (process.env.EP || "/ws");
const GAME = process.env.GAME || 'rummy';
const N = Number(process.env.N || 10);
const agent = new http.Agent({ keepAlive: true, maxSockets: 50 });

function post(p, b) {
  return new Promise((res, rej) => {
    const d = Buffer.from(JSON.stringify(b));
    const r = http.request(BASE + p, { method: 'POST', agent, headers: { 'content-type': 'application/json', 'content-length': d.length } },
      (x) => { const c = []; x.on('data', (y) => c.push(y)); x.on('end', () => res({ headers: x.headers, body: Buffer.concat(c).toString() })); });
    r.on('error', rej); r.end(d);
  });
}
async function session(id) {
  const t = JSON.parse((await post('/dev/launch-token', { vaultId: id, displayName: id })).body).token;
  const s = await post('/api/session', { token: t });
  return (s.headers['set-cookie'] || []).map((c) => c.split(';')[0]).find((c) => c.startsWith('gsid='));
}
const ws = (url, cookie) => new Promise((res, rej) => { const s = new WebSocket(url, { headers: { Cookie: cookie } }); s.once('open', () => res(s)); s.once('error', rej); setTimeout(() => rej(new Error('t/o')), 8000); });

(async () => {
  const matches = [];     // {vault, roomId, opponent}
  const queued = [];
  const players = [];
  for (let i = 0; i < N; i++) {
    const vid = `@mm${i}`;
    const cookie = await session(vid);
    const live = await ws(LIVE, cookie);
    const p = { vid, cookie, live, match: null };
    live.on('message', (buf) => {
      let m; try { m = JSON.parse(buf.toString()); } catch { return; }
      if (m.t === 'match') { p.match = m; matches.push({ vault: vid, roomId: m.roomId, opp: m.opponent && m.opponent.vaultId }); }
      else if (m.t === 'queued') queued.push(vid);
      else if (m.t === 'botoffer') matches.push({ vault: vid, roomId: m.roomId, opp: 'BOT' });
    });
    players.push(p);
  }
  // queue everyone for the game
  for (const p of players) { p.live.send(JSON.stringify({ t: 'queue', game: GAME })); await new Promise((r) => setTimeout(r, 20)); }
  await new Promise((r) => setTimeout(r, 2500));

  // distinct rooms actually assigned
  const rooms = [...new Set(matches.map((m) => m.roomId))];
  console.log(JSON.stringify({ phase: 'matchmaking', game: GAME, players: N, matched: matches.length, queuedStill: queued.length, distinctRooms: rooms.length, sampleRooms: rooms.slice(0, 6) }, null, 2));

  // For the first matched pair, try joining the assigned room on /ws and see where they land.
  if (matches.length >= 1) {
    const first = matches[0];
    const jp = players.find((p) => p.vid === first.vault);
    const gws = await ws(WS, jp.cookie);
    let landed = null;
    gws.on('message', (buf) => { let m; try { m = JSON.parse(buf.toString()); } catch { return; } if (m.t === 'joined') landed = m.roomId; if (m.t === 'state' && m.lobby) landed = m.lobby.table && m.lobby.table.id; });
    gws.send(JSON.stringify({ t: 'join', tableId: first.roomId }));
    await new Promise((r) => setTimeout(r, 1200));
    console.log(JSON.stringify({ phase: 'join-check', requestedRoom: first.roomId, landedInRoom: landed, collapsed: landed !== first.roomId }, null, 2));
    gws.close();
  }
  for (const p of players) p.live.close();
  setTimeout(() => process.exit(0), 300);
})().catch((e) => { console.error('ERR', e.message); process.exit(1); });
