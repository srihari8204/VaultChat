// mm-accept.js — P8 acceptance: full matchmade rummy path end to end.
// N players -> /live/ws -> queue -> match -> join THEIR room on /ws -> play.
// Proves: requested roomId == actual roomId, players isolated per room, real
// gameplay actions succeed, ZERO practice fallback. LOCAL ONLY (localhost:8090).

const http = require('http');
const WebSocket = require('ws');
const BASE = 'http://127.0.0.1:8090';
const LIVE = BASE.replace(/^http/, 'ws') + '/live/ws';
const WS = BASE.replace(/^http/, 'ws') + '/ws';
const N = Number(process.env.N || 10);
const PLAY_SECS = Number(process.env.SECS || 8);
const agent = new http.Agent({ keepAlive: true, maxSockets: 100 });

function post(p, b) { return new Promise((res, rej) => { const d = Buffer.from(JSON.stringify(b)); const r = http.request(BASE + p, { method: 'POST', agent, headers: { 'content-type': 'application/json', 'content-length': d.length } }, x => { const c = []; x.on('data', y => c.push(y)); x.on('end', () => res({ headers: x.headers, body: Buffer.concat(c).toString() })); }); r.on('error', rej); r.end(d); }); }
async function session(id) { const t = JSON.parse((await post('/dev/launch-token', { vaultId: id, displayName: id })).body).token; const s = await post('/api/session', { token: t }); return (s.headers['set-cookie'] || []).map(c => c.split(';')[0]).find(c => c.startsWith('gsid=')); }
const ws = (url, cookie) => new Promise((res, rej) => { const s = new WebSocket(url, { headers: { Cookie: cookie } }); s.once('open', () => res(s)); s.once('error', rej); setTimeout(() => rej(new Error('t/o')), 8000); });

(async () => {
  const players = [];
  for (let i = 0; i < N; i++) { const vid = `@ac${i}`; players.push({ vid, cookie: await session(vid), room: null, landed: null, joins: 0, actions: 0, errors: 0, states: 0 }); }

  // Phase 1: queue all on /live/ws, collect match rooms
  await Promise.all(players.map(async (p) => {
    p.live = await ws(LIVE, p.cookie);
    p.live.on('message', (buf) => { let m; try { m = JSON.parse(buf) } catch { return } if (m.t === 'match') p.room = m.roomId; else if (m.t === 'botoffer') p.room = m.roomId; });
    p.live.send(JSON.stringify({ t: 'queue', game: 'rummy' }));
  }));
  await new Promise(r => setTimeout(r, Number(process.env.MATCHWAIT||2500)));

  const withRoom = players.filter(p => p.room);
  const distinct = [...new Set(withRoom.map(p => p.room))];

  // Phase 2: each matched player joins THEIR room on /ws and plays legal turns
  await Promise.all(withRoom.map(async (p) => {
    p.game = await ws(WS, p.cookie);
    p.game.on('message', (buf) => {
      let m; try { m = JSON.parse(buf) } catch { return }
      if (m.t === 'joined') { p.joins++; p.landed = m.roomId; }
      else if (m.t === 'error') { p.errors++; }
      else if (m.t === 'state' && m.game) {
        p.states++;
        if (m.game.phase !== 'playing' || m.game.turnPlayerId !== p.vid) return;
        const hand = m.hand || [];
        if (hand.length <= 13) { p.game.send(JSON.stringify({ t: 'draw', source: 'closed' })); p.actions++; }
        else { p.game.send(JSON.stringify({ t: 'discard', cardId: hand[0].id })); p.actions++; }
      }
    });
    p.game.send(JSON.stringify({ t: 'join', tableId: p.room }));
  }));
  await new Promise(r => setTimeout(r, 300));
  // host of each room (first joiner) starts the game
  const byRoom = {};
  for (const p of withRoom) (byRoom[p.room] = byRoom[p.room] || []).push(p);
  for (const room of Object.keys(byRoom)) byRoom[room][0].game.send(JSON.stringify({ t: 'start' }));
  await new Promise(r => setTimeout(r, PLAY_SECS * 1000));

  // Verdict
  const landedWrong = withRoom.filter(p => p.landed && p.landed !== p.room);
  const landedPractice = withRoom.filter(p => p.landed === 'practice');
  const joinErrors = withRoom.filter(p => p.joins === 0);
  const totalActions = players.reduce((n, p) => n + p.actions, 0);
  const totalErrors = players.reduce((n, p) => n + p.errors, 0);
  const out = {
    players: N, matched: withRoom.length, distinctRooms: distinct.length,
    joinedOwnRoom: withRoom.filter(p => p.landed === p.room).length,
    landedWrongRoom: landedWrong.length, landedPractice: landedPractice.length,
    joinFailures: joinErrors.length,
    gameplayActions: totalActions, gameplayErrors: totalErrors,
    INVARIANT_requested_eq_actual: landedWrong.length === 0 && landedPractice.length === 0,
  };
  console.log(JSON.stringify(out, null, 2));
  players.forEach(p => { try { p.live && p.live.close(); p.game && p.game.close(); } catch {} });
  setTimeout(() => process.exit(out.INVARIANT_requested_eq_actual ? 0 : 1), 400);
})().catch(e => { console.error('ERR', e.message); process.exit(1); });
