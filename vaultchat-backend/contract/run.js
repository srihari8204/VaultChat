// vaultchat-backend/contract/run.js
//
// Behavioral contract suite — runs against EITHER backend via BASE_URL swap:
//   BASE_URL=http://127.0.0.1:13000 node contract/run.js       (Node bench)
//   BASE_URL=http://127.0.0.1:14000 node contract/run.js       (future Go)
//
// Depth model (Phase 2 Step 0):
//   • contract/inventory.js freezes the FULL surface (176 endpoints, 75 events)
//   • this file proves BEHAVIOR: deep fixtures for the messaging core + auth +
//     realtime (the risk), smoke checks (status + JSON shape) for every other
//     module. When a route is actually migrated, its smoke check gets promoted
//     to deep fixtures as part of that route's cutover PR.
//
// Needs the bench dataset: node loadtest/seed.js first (users A/B share the
// bench group and a direct chat).

const fs = require('fs');
const path = require('path');
const { io } = require('socket.io-client');

const BASE = process.env.BASE_URL || 'http://127.0.0.1:13000';
const STATE = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'loadtest', 'bench-state.json'), 'utf8'));
const A = STATE.users[0];
const B = STATE.users[1];
const directChat = STATE.directChatIds[0];

let failures = 0;
function check(cond, name, extra) {
  console.log(`  ${cond ? '✓' : '✗ FAIL'} ${name}${!cond && extra !== undefined ? ` — got: ${JSON.stringify(extra)?.slice(0, 200)}` : ''}`);
  if (!cond) failures += 1;
}

async function req(method, p, { token, body } = {}) {
  const r = await fetch(`${BASE}${p}`, {
    method,
    headers: {
      ...(body ? { 'Content-Type': 'application/json' } : {}),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  let json = null;
  try { json = await r.json(); } catch { /* non-JSON */ }
  return { status: r.status, json };
}

const hasKeys = (o, keys) => o && typeof o === 'object' && keys.every(k => k in o);

async function main() {
  console.log(`contract suite → ${BASE}\n`);

  // ── health ───────────────────────────────────────────────────────────
  console.log('health:');
  let r = await req('GET', '/health');
  check(r.status === 200 && hasKeys(r.json, ['status', 'db', 'redis']), 'GET /health shape', r);
  check(r.json?.db === true, 'health reports db up', r.json);

  // ── auth ─────────────────────────────────────────────────────────────
  console.log('auth:');
  r = await req('GET', '/auth/profile', { token: A.jwt });
  check(r.status === 200 && hasKeys(r.json, ['userId', 'onboardingComplete']), 'GET /auth/profile (authed) shape', r);
  check(r.json?.userId === A.id, 'profile userId matches token subject', r.json);
  r = await req('GET', '/auth/profile');
  check(r.status === 401 && r.json?.error, 'GET /auth/profile w/o token → 401 {error}', r);
  r = await req('POST', '/auth/refresh', { body: {} });
  check([400, 401].includes(r.status) && r.json?.error, 'POST /auth/refresh empty → 4xx {error}', r);
  r = await req('GET', '/auth/profile', { token: 'garbage.jwt.token' });
  check(r.status === 401, 'garbage JWT → 401', r);

  // ── user ─────────────────────────────────────────────────────────────
  console.log('user:');
  r = await req('GET', '/user/profile', { token: A.jwt });
  check(r.status === 200 && hasKeys(r.json, ['id', 'email']), 'GET /user/profile shape', r);
  r = await req('GET', '/user/settings', { token: A.jwt });
  check(r.status === 200 && r.json && typeof r.json === 'object', 'GET /user/settings 200 JSON', r);
  r = await req('GET', `/user/${B.id}/keybundle`, { token: A.jwt });
  check([200, 404].includes(r.status) && r.json, 'GET /user/:id/keybundle 200|404 JSON', r);

  // ── chats (deep — the messaging core) ────────────────────────────────
  console.log('chats:');
  r = await req('GET', '/chats', { token: A.jwt });
  check(r.status === 200 && Array.isArray(r.json), 'GET /chats → array', r);
  check(r.json?.some?.(c => c.id === directChat), 'chat list contains bench direct chat', r.json?.length);

  const content = `contract-${Date.now()}`;
  r = await req('POST', `/chats/${directChat}/messages`, { token: A.jwt, body: { type: 'text', content } });
  check(r.status === 200 || r.status === 201, 'POST message → 2xx', r);
  const MSG_KEYS = ['id', 'chatId', 'senderId', 'type', 'content', 'createdAt'];
  check(hasKeys(r.json, MSG_KEYS), 'message response has publicMessage keys', r.json);
  check(r.json?.senderId === A.id && r.json?.content === content, 'message senderId+content round-trip', r.json);
  const msgId = r.json?.id;

  r = await req('GET', `/chats/${directChat}/messages?limit=20`, { token: B.jwt });
  const listed = Array.isArray(r.json) ? r.json : r.json?.messages;
  check(Array.isArray(listed), 'GET messages → list', r);
  const found = listed?.find?.(m => m.id === msgId);
  check(!!found && found.content === content, 'B sees A message with same content', found);

  r = await req('GET', `/chats/${directChat}`, { token: A.jwt });
  check(r.status === 200 && r.json?.id === directChat, 'GET /chats/:id shape', r);
  r = await req('POST', `/chats/${directChat}/read`, { token: B.jwt, body: { lastReadMessageId: msgId } });
  check([200, 204].includes(r.status), 'POST /chats/:id/read 2xx', r);
  r = await req('POST', `/chats/${directChat}/read`, { token: B.jwt, body: {} });
  check(r.status === 400 && r.json?.error === 'lastReadMessageId required', 'read w/o id → exact 400 error', r);
  r = await req('GET', `/chats/${directChat}/messages`, { token: STATE.users[10].jwt });
  check(r.status === 403, 'non-member reads messages → 403', r);

  // ── realtime (socket contract: auth, rooms, delivery) ────────────────
  console.log('realtime:');
  const sock = (u) => new Promise((resolve, reject) => {
    const s = io(BASE, { transports: ['websocket'], auth: { token: u.jwt }, reconnection: false });
    const t = setTimeout(() => reject(new Error('connect timeout')), 10000);
    s.on('ready', (d) => { clearTimeout(t); resolve({ s, ready: d }); });
    s.on('connect_error', (e) => { clearTimeout(t); reject(e); });
  });
  try {
    const noAuth = await new Promise((resolve) => {
      const s = io(BASE, { transports: ['websocket'], reconnection: false });
      const t = setTimeout(() => { s.close(); resolve('timeout'); }, 8000);
      s.on('connect_error', (e) => { clearTimeout(t); s.close(); resolve(e.message); });
      s.on('connect', () => { clearTimeout(t); s.close(); resolve('CONNECTED'); });
    });
    check(noAuth !== 'CONNECTED', 'socket w/o JWT rejected at handshake', noAuth);

    const [ca, cb] = await Promise.all([sock(A), sock(B)]);
    check(ca.ready?.uid === A.id, "handshake 'ready' carries uid", ca.ready);
    cb.s.emit('join_chat', { chatId: directChat });
    await new Promise(rr => setTimeout(rr, 300));

    const socketContent = `socket-${Date.now()}`;
    const delivery = new Promise((resolve) => {
      const t = setTimeout(() => resolve(null), 8000);
      cb.s.on('new_message', (m) => {
        if (m?.content === socketContent) { clearTimeout(t); resolve(m); }
      });
    });
    await req('POST', `/chats/${directChat}/messages`, { token: A.jwt, body: { type: 'text', content: socketContent } });
    const delivered = await delivery;
    check(!!delivered, "REST send → 'new_message' delivered to member socket");
    check(hasKeys(delivered || {}, MSG_KEYS), 'delivered payload has publicMessage keys', delivered);

    const typing = new Promise((resolve) => {
      const t = setTimeout(() => resolve(null), 5000);
      cb.s.on('typing_start', (d) => { clearTimeout(t); resolve(d); });
    });
    ca.s.emit('typing_start', { chatId: directChat });
    check(!!(await typing), "typing_start relays to chat room");

    ca.s.disconnect(); cb.s.disconnect();
  } catch (e) {
    check(false, `realtime harness: ${e.message}`);
  }

  // ── module smokes (promoted to deep fixtures at each route's cutover) ─
  console.log('module smokes:');
  const smokes = [
    ['contacts', 'GET', '/contacts/trusted', { token: A.jwt }, (x) => x.status === 200],
    ['stories', 'GET', '/stories/feed', { token: A.jwt }, (x) => x.status === 200],
    ['stories', 'GET', '/stories/privacy', { token: A.jwt }, (x) => x.status === 200 && !!x.json],
    ['communities', 'GET', '/communities', { token: A.jwt }, (x) => x.status === 200],
    ['calls', 'POST', '/call/initiate', { token: A.jwt, body: {} }, (x) => x.status >= 400 && x.status < 500 && !!x.json?.error],
    ['link', 'GET', '/link/preview?url=https%3A%2F%2Fexample.com', { token: A.jwt }, (x) => !!x.json],
    ['gif', 'GET', '/gif/search?q=hello', { token: A.jwt }, (x) => !!x.json],
    ['channels', 'GET', '/channels', { token: A.jwt }, (x) => x.status === 200],
    ['games', 'GET', '/games/profile', { token: A.jwt }, (x) => x.status === 200 && !!x.json],
    ['games', 'GET', '/games/leaderboard', { token: A.jwt }, (x) => x.status === 200],
    ['vaultbeam', 'GET', '/vaultbeam/relay/00000000-0000-0000-0000-000000000000', { token: A.jwt }, (x) => x.status === 404 && !!x.json],
    ['nav', 'POST', '/nav/route', { token: A.jwt, body: {} }, (x) => x.status >= 400 && !!x.json],
    ['vaultlens', 'GET', '/vaultlens/catalog', { token: A.jwt }, (x) => x.status === 200 && !!x.json],
    ['vaultlens', 'GET', '/vaultlens/quota', { token: A.jwt }, (x) => x.status === 200 && !!x.json],
    ['uploads', 'GET', '/uploads/00000000-0000-0000-0000-000000000000', { token: A.jwt }, (x) => [400, 404].includes(x.status)],
    // presign accepts an empty body today (no validation) — that IS the contract.
    ['uploads', 'POST', '/uploads/presign', { token: A.jwt, body: {} }, (x) => x.status === 200 && hasKeys(x.json, ['id', 'uploadUrl'])],
    ['ai', 'POST', '/ai/chat', { token: A.jwt, body: {} }, (x) => x.status >= 400 && !!x.json],
    // 503 when ADMIN_KEY unset (bench), 401/403 when set and wrong.
    ['admin', 'GET', '/api/admin/stats', {}, (x) => [401, 403, 503].includes(x.status) && !!x.json?.error],
  ];
  for (const [mod, method, p, opts, ok] of smokes) {
    try {
      const res = await req(method, p, opts);
      check(ok(res), `${mod}: ${method} ${p.split('?')[0]}`, res);
    } catch (e) {
      check(false, `${mod}: ${method} ${p} — ${e.message}`);
    }
  }

  console.log(`\n${failures === 0 ? 'ALL CONTRACT CHECKS PASSED ✓' : `✗ ${failures} CONTRACT CHECK(S) FAILED`}`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => { console.error('harness error:', e); process.exit(1); });
