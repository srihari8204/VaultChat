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

  // ── migrated routes: deep fixtures (promoted at Phase 2 cutover) ─────
  console.log('contacts (deep):');
  // GET /user/profile lazily assigns vaultIds (needed for trusted adds below).
  const profA = (await req('GET', '/user/profile', { token: A.jwt })).json;
  const profB = (await req('GET', '/user/profile', { token: B.jwt })).json;
  check(!!profA?.vaultId && !!profB?.vaultId, 'profiles carry vaultId', { a: profA?.vaultId, b: profB?.vaultId });

  // match — random bench users so the 5/min limiter never bleeds across runs.
  const pick = () => 3 + Math.floor(Math.random() * 900);
  const M = STATE.users[pick()];
  r = await req('POST', '/contacts/match', { token: M.jwt, body: {} });
  check(r.status === 400 && r.json?.error === 'phoneHashes array required', 'match w/o array → exact 400', r);
  r = await req('POST', '/contacts/match', { token: M.jwt, body: { phoneHashes: [] } });
  check(r.status === 200 && Array.isArray(r.json) && r.json.length === 0, 'match [] → 200 []', r);
  r = await req('POST', '/contacts/match', { token: M.jwt, body: { phoneHashes: ['nothex', 'ZZ', 123] } });
  check(r.status === 200 && Array.isArray(r.json) && r.json.length === 0, 'match junk hashes filtered → 200 []', r);
  const L = STATE.users[pick()];
  let last = null;
  for (let i = 0; i < 6; i++) last = await req('POST', '/contacts/match', { token: L.jwt, body: { phoneHashes: [] } });
  check(last.status === 429 && last.json?.error === 'Too many requests' && typeof last.json?.retryAfter === 'number',
    '6th match in a minute → 429 {retryAfter}', last);

  // mutual-consent sync flow, end to end
  r = await req('POST', '/contacts/sync/create', { token: A.jwt });
  check(r.status === 200 && r.json?.success === true && /^\d{6}$/.test(r.json?.code || ''), 'sync/create → {success, 6-digit code}', r);
  const code = r.json?.code;
  const wrong = code === '000000' ? '111111' : '000000';
  r = await req('GET', `/contacts/sync/${code}`, { token: A.jwt });
  check(r.status === 200 && r.json?.verified === false, 'sync status before verify → {verified:false}', r);
  r = await req('GET', `/contacts/sync/${wrong}`, { token: A.jwt });
  check(r.status === 404 && r.json?.error === 'not found', 'sync status unknown code → exact 404', r);
  r = await req('POST', '/contacts/sync/verify', { token: B.jwt, body: { code: '12345' } });
  check(r.status === 400 && r.json?.error === '6-digit code required', 'verify malformed code → exact 400', r);
  r = await req('POST', '/contacts/sync/verify', { token: B.jwt, body: { code: wrong } });
  check(r.status === 404 && r.json?.error === 'Invalid code', 'verify unknown code → exact 404', r);
  r = await req('POST', '/contacts/sync/verify', { token: A.jwt, body: { code } });
  check(r.status === 400 && r.json?.error === 'Cannot sync with yourself', 'self-verify → exact 400', r);
  r = await req('POST', '/contacts/sync/verify', { token: B.jwt, body: { code } });
  check(r.status === 200 && r.json?.success === true && r.json?.initiator?.userId === A.id
    && hasKeys(r.json?.initiator, ['userId', 'displayName', 'email', 'phoneNumber']), 'verify → {success, initiator stub}', r);
  r = await req('POST', '/contacts/sync/verify', { token: B.jwt, body: { code } });
  check(r.status === 409 && r.json?.error === 'Code already used', 'second verify → exact 409', r);
  r = await req('GET', `/contacts/sync/${code}`, { token: A.jwt });
  check(r.status === 200 && r.json?.verified === true, 'sync status after verify → {verified:true}', r);

  // trusted contacts — self-cleaning add/dup/list/remove
  await req('DELETE', `/contacts/trusted/${B.id}`, { token: A.jwt }); // cleanup from any dead run
  r = await req('POST', '/contacts/trusted', { token: A.jwt, body: {} });
  check(r.status === 400 && r.json?.error === 'vaultId required', 'trusted add w/o vaultId → exact 400', r);
  r = await req('POST', '/contacts/trusted', { token: A.jwt, body: { vaultId: 'no-such-vault-id-000' } });
  check(r.status === 404 && r.json?.error === 'No user with that VaultID', 'trusted add unknown → exact 404', r);
  r = await req('POST', '/contacts/trusted', { token: A.jwt, body: { vaultId: profA.vaultId } });
  check(r.status === 400 && r.json?.error === "You can't add yourself", 'trusted add self → exact 400', r);
  r = await req('POST', '/contacts/trusted', { token: A.jwt, body: { vaultId: `@${profB.vaultId}` } });
  check(r.status === 200 && r.json?.userId === B.id && hasKeys(r.json, ['userId', 'name', 'vaultId', 'online']),
    'trusted add (@-prefixed) → member stub', r);
  r = await req('POST', '/contacts/trusted', { token: A.jwt, body: { vaultId: profB.vaultId } });
  check(r.status === 409 && r.json?.error === 'Already a trusted contact', 'duplicate trusted add → exact 409', r);
  r = await req('GET', '/contacts/trusted', { token: A.jwt });
  check(r.status === 200 && Array.isArray(r.json) && r.json.some(c => c.userId === B.id), 'trusted list contains B', r);
  r = await req('DELETE', `/contacts/trusted/${B.id}`, { token: A.jwt });
  check(r.status === 200 && r.json?.ok === true, 'trusted remove → {ok:true}', r);

  console.log('link (deep):');
  r = await req('GET', '/link/preview?url=notaurl', { token: A.jwt });
  check(r.status === 400 && r.json?.error === 'invalid url', 'invalid url → exact 400', r);
  r = await req('GET', `/link/preview?url=${encodeURIComponent('ftp://example.com/x')}`, { token: A.jwt });
  check(r.status === 400 && r.json?.error === 'unsupported scheme', 'ftp scheme → exact 400', r);
  r = await req('GET', `/link/preview?url=${encodeURIComponent('https://example.com:8080/')}`, { token: A.jwt });
  check(r.status === 400 && r.json?.error === 'blocked port', 'non-std port → exact 400', r);
  r = await req('GET', `/link/preview?url=${encodeURIComponent('http://localhost/admin')}`, { token: A.jwt });
  check(r.status === 502 && r.json?.error === 'preview unavailable', 'localhost blocked → 502', r);
  r = await req('GET', `/link/preview?url=${encodeURIComponent('http://169.254.169.254/latest/meta-data/')}`, { token: A.jwt });
  check(r.status === 502 && r.json?.error === 'preview unavailable', 'metadata IP blocked → 502', r);
  r = await req('GET', `/link/preview?url=${encodeURIComponent('https://example.com')}`, { token: A.jwt });
  check(r.status === 200 && hasKeys(r.json, ['url', 'title', 'description', 'image'])
    && r.json?.url === 'https://example.com/', 'real fetch → OG shape, WHATWG-normalized url echo', r);

  console.log('gif (deep):');
  r = await req('GET', '/gif/search?q=hello', { token: A.jwt });
  if (r.json?.error === 'not_configured') {
    check(r.status === 200 && Array.isArray(r.json?.results) && r.json.results.length === 0 && r.json?.next === '',
      'no GIPHY_KEY → exact not_configured shape', r);
  } else {
    check(r.status === 200 && Array.isArray(r.json?.results) && r.json.results.length > 0
      && hasKeys(r.json.results[0], ['id', 'url', 'gif', 'preview', 'width', 'height'])
      && typeof r.json?.next === 'string', 'gif search → normalized results', r);
  }

  console.log('stories (deep):');
  r = await req('GET', '/stories/privacy', { token: A.jwt });
  check(r.status === 200 && typeof r.json?.mode === 'string' && Array.isArray(r.json?.userIds), 'privacy → {mode, userIds}', r);
  r = await req('PUT', '/stories/privacy', { token: A.jwt, body: { mode: 'only', userIds: [B.id] } });
  check(r.status === 200 && r.json?.ok === true, 'privacy PUT only:[B] → {ok}', r);
  r = await req('GET', '/stories/privacy', { token: A.jwt });
  check(r.json?.mode === 'only' && r.json?.userIds?.length === 1 && r.json?.userIds?.[0] === B.id, 'privacy round-trips', r);
  r = await req('GET', '/stories/audience', { token: A.jwt });
  check(r.status === 200 && Array.isArray(r.json?.viewerIds) && r.json.viewerIds.length === 1
    && r.json.viewerIds[0] === B.id, "audience honors 'only' filter", r);
  r = await req('PUT', '/stories/privacy', { token: A.jwt, body: { mode: 'contacts' } });
  check(r.status === 200 && r.json?.ok === true, 'privacy reset to contacts', r);

  r = await req('POST', '/stories', { token: A.jwt, body: {} });
  check(r.status === 400 && r.json?.error === 'attachmentId required', 'post w/o attachment → exact 400', r);
  r = await req('POST', '/stories', { token: A.jwt, body: { attachmentId: 'x', mediaType: 'gif' } });
  check(r.status === 400 && r.json?.error === 'mediaType must be image or video', 'bad mediaType → exact 400', r);
  r = await req('POST', '/stories', { token: A.jwt, body: { mediaType: 'text', text: '   ' } });
  check(r.status === 400 && r.json?.error === 'text required', 'text story w/o text → exact 400', r);

  // text story lifecycle, with the live story_posted push to B's socket
  // (through the internal emit bridge when Go serves /stories).
  let storyPush = null;
  try {
    const { s: sb } = await (async () => {
      const s = io(BASE, { transports: ['websocket'], auth: { token: B.jwt }, reconnection: false });
      await new Promise((resolve, reject) => {
        const t = setTimeout(() => reject(new Error('connect timeout')), 10000);
        s.on('ready', () => { clearTimeout(t); resolve(); });
        s.on('connect_error', (e) => { clearTimeout(t); reject(e); });
      });
      return { s };
    })();
    storyPush = new Promise((resolve) => {
      const t = setTimeout(() => resolve(null), 8000);
      sb.on('story_posted', (d) => { if (d?.userId === A.id) { clearTimeout(t); resolve(d); } });
    });
    r = await req('POST', '/stories', { token: A.jwt, body: { mediaType: 'text', text: 'contract story', bgColor: '#112233' } });
    check(r.status === 200 && /^\d+$/.test(r.json?.id || '') && r.json?.mediaType === 'text'
      && r.json?.text === 'contract story' && r.json?.bgColor === '#112233' && r.json?.caption === null,
      'text story post → exact shape (bigint id as string)', r);
    const storyId = r.json?.id;
    check(!!(await storyPush), "story post → 'story_posted' pushed to B's socket");
    sb.disconnect();

    r = await req('GET', '/stories/feed', { token: B.jwt });
    const aBucket = Array.isArray(r.json) ? r.json.find(x => x.userId === A.id) : null;
    const inFeed = aBucket?.stories?.find?.(s => s.id === storyId);
    check(!!inFeed && inFeed.text === 'contract story' && inFeed.seen === false
      && hasKeys(aBucket, ['userId', 'name', 'email', 'photoURL', 'isMine', 'stories', 'seenAll', 'latestAt']),
      'B feed shows A bucket with the story, unseen', { bucket: !!aBucket, inFeed: !!inFeed });

    r = await req('POST', `/stories/${storyId}/viewed`, { token: B.jwt });
    check(r.status === 200 && r.json?.ok === true && !('noop' in (r.json || {})), 'B marks viewed → {ok}', r);
    r = await req('POST', `/stories/${storyId}/viewed`, { token: B.jwt });
    check(r.status === 200 && r.json?.ok === true, 'viewed is idempotent', r);
    r = await req('POST', `/stories/${storyId}/viewed`, { token: A.jwt });
    check(r.status === 200 && r.json?.ok === true && r.json?.noop === true, 'author view → {ok, noop}', r);

    r = await req('GET', `/stories/${storyId}/views`, { token: B.jwt });
    check(r.status === 403 && r.json?.error === 'author only', 'views by non-author → exact 403', r);
    r = await req('GET', `/stories/${storyId}/views`, { token: A.jwt });
    const viewRow = Array.isArray(r.json) ? r.json.find(v => v.userId === B.id) : null;
    check(!!viewRow && hasKeys(viewRow, ['userId', 'name', 'email', 'photoURL', 'viewedAt']), 'author sees B in viewers', r);
    r = await req('GET', `/stories/${storyId}/key`, { token: B.jwt });
    check(r.status === 404 && r.json?.error === 'no key for viewer', 'key for unencrypted story → exact 404', r);

    r = await req('GET', '/stories/abc/views', { token: A.jwt });
    check(r.status === 400 && r.json?.error === 'invalid id', 'non-numeric id → exact 400', r);
    r = await req('GET', '/stories/999999999/views', { token: A.jwt });
    check(r.status === 404 && r.json?.error === 'story not found', 'unknown story id → exact 404', r);

    r = await req('DELETE', `/stories/${storyId}`, { token: B.jwt });
    check(r.status === 404 && r.json?.error === 'not found or not author', 'delete by non-author → exact 404', r);
    r = await req('DELETE', `/stories/${storyId}`, { token: A.jwt });
    check(r.status === 200 && r.json?.ok === true, 'author delete → {ok}', r);
    r = await req('DELETE', `/stories/${storyId}`, { token: A.jwt });
    check(r.status === 404 && r.json?.error === 'not found or not author', 'double delete → exact 404', r);
  } catch (e) {
    check(false, `stories harness: ${e.message}`);
  }

  console.log('communities (deep):');
  r = await req('POST', '/communities', { token: A.jwt, body: {} });
  check(r.status === 400 && r.json?.error === 'name required', 'create w/o name → exact 400', r);
  r = await req('POST', '/communities', { token: A.jwt, body: { name: 'Contract Community' } });
  check(r.status === 200 && hasKeys(r.json, ['id', 'name', 'description', 'photoURL', 'announcementChatId'])
    && r.json?.name === 'Contract Community' && r.json?.description === null, 'create → full stub', r);
  const commId = r.json?.id;
  r = await req('GET', '/communities', { token: A.jwt });
  check(r.status === 200 && Array.isArray(r.json?.communities)
    && r.json.communities.some(c => c.id === commId && typeof c.groupCount === 'number'),
    'list contains new community with numeric groupCount', r);
  r = await req('GET', `/communities/${commId}`, { token: A.jwt });
  check(r.status === 200 && r.json?.isOwner === true && Array.isArray(r.json?.groups)
    && r.json.groups.length === 1 && r.json.groups[0].isAnnouncement === true && r.json.groups[0].members === 1,
    'detail → owner + announcement group', r);
  r = await req('GET', `/communities/${commId}`, { token: B.jwt });
  check(r.status === 403 && r.json?.error === 'Not a community member', 'non-member detail → exact 403', r);
  r = await req('GET', '/communities/00000000-0000-0000-0000-000000000000', { token: A.jwt });
  check(r.status === 404 && r.json?.error === 'Community not found', 'unknown id → exact 404', r);
  r = await req('POST', `/communities/${commId}/groups`, { token: A.jwt, body: {} });
  check(r.status === 400 && r.json?.error === 'name required', 'sub-group w/o name → exact 400', r);
  r = await req('POST', `/communities/${commId}/groups`, { token: B.jwt, body: { name: 'Nope' } });
  check(r.status === 403 && r.json?.error === 'Not a community member', 'sub-group by non-member → exact 403', r);
  r = await req('POST', `/communities/${commId}/groups`, { token: A.jwt, body: { name: 'Contract Sub' } });
  check(r.status === 200 && !!r.json?.id && r.json?.name === 'Contract Sub', 'sub-group create → {id, name}', r);

  console.log('nav (deep):');
  r = await req('POST', '/nav/route', { token: A.jwt, body: {} });
  check(r.status === 400 && r.json?.error === 'from{lat,lng} + to{lat,lng} required', 'no coords → exact 400', r);
  r = await req('POST', '/nav/route', { token: A.jwt, body: { from: { lat: '17.4', lng: 78.4 }, to: { lat: 17.5, lng: 78.5 } } });
  check(r.status === 400 && r.json?.error === 'from{lat,lng} + to{lat,lng} required', 'string lat → exact 400', r);
  r = await req('POST', '/nav/route', { token: A.jwt, body: { from: { lat: 17.4, lng: 78.4 }, to: { lat: 17.5, lng: 78.5 } } });
  check((r.status === 503 && r.json?.error === 'routing engine unavailable') || (r.status === 200 && !!r.json?.trip),
    'valid coords → trip (engine up) or exact 503 (engine down)', r);

  console.log('ai (deep):');
  r = await req('POST', '/ai/chat', { token: A.jwt, body: {} });
  check(r.status === 400 && r.json?.error === 'message required', 'chat w/o message → exact 400', r);
  r = await req('POST', '/ai/assist', { token: A.jwt, body: { task: 'nope', text: 'x' } });
  check(r.status === 400 && r.json?.error === 'unknown task', 'assist unknown task → exact 400', r);
  r = await req('POST', '/ai/assist', { token: A.jwt, body: { task: 'summarize' } });
  check(r.status === 400 && r.json?.error === 'text required', 'assist w/o text → exact 400', r);
  r = await req('POST', '/ai/chat', { token: A.jwt, body: { message: 'hi' } });
  check((r.status === 503 && r.json?.error === 'AI is unavailable right now') || (r.status === 200 && typeof r.json?.reply === 'string'),
    'chat → reply (ollama up) or exact 503 (down)', r);

  console.log('calls (deep):');
  r = await req('POST', '/call/initiate', { token: A.jwt, body: {} });
  check(r.status === 400 && r.json?.error === 'calleeId and callId required', 'initiate w/o ids → exact 400', r);
  r = await req('POST', '/call/cancel', { token: A.jwt, body: {} });
  check(r.status === 400 && r.json?.error === 'calleeId and callId required', 'cancel w/o ids → exact 400', r);
  r = await req('POST', '/call/token', { token: A.jwt, body: {} });
  check(r.status === 400 && r.json?.error === 'fcmToken required', 'token w/o fcmToken → exact 400', r);
  const CT = STATE.users[pick()];
  r = await req('POST', '/call/token', { token: CT.jwt, body: { fcmToken: `contract-fake-${Date.now()}` } });
  check(r.status === 200 && r.json?.ok === true, 'token register → {ok}', r);
  r = await req('POST', '/call/initiate', { token: A.jwt, body: { calleeId: CT.id, callId: 'contract-call' } });
  check(r.status === 200 && r.json?.ok === true && r.json?.delivered === false,
    'initiate → {ok, delivered:false} (no usable push path in bench)', r);
  r = await req('POST', '/call/cancel', { token: A.jwt, body: { calleeId: CT.id, callId: 'contract-call' } });
  check(r.status === 200 && r.json?.ok === true, 'cancel → {ok}', r);

  console.log('uploads (deep):');
  r = await req('GET', '/uploads/00000000-0000-0000-0000-000000000000', { token: A.jwt });
  check(r.status === 404 && r.json?.error === 'Not found', 'unknown attachment → exact 404', r);
  // presign accepts an empty body today (no validation) — that IS the contract.
  r = await req('POST', '/uploads/presign', { token: A.jwt, body: {} });
  check(r.status === 200 && hasKeys(r.json, ['id', 'uploadUrl', 'key']) && r.json.key.startsWith('att/'),
    'presign empty body → {id, uploadUrl, key}', r);
  r = await req('POST', '/uploads/presign', { token: A.jwt, body: { filename: 'x.bin', size: 99999999999 } });
  check(r.status === 413 && /^File too large \(max \d+ bytes\)$/.test(r.json?.error || ''), 'presign oversize → exact 413', r);

  // resumable multipart lifecycle (against the shared MinIO)
  r = await req('POST', '/uploads/multipart/init', { token: A.jwt, body: { filename: 'v.mp4', mime: 'video/mp4' } });
  check(r.status === 400 && r.json?.error === 'size required', 'mp init w/o size → exact 400', r);
  r = await req('POST', '/uploads/multipart/init', { token: A.jwt, body: { filename: 'v.mp4', mime: 'video/mp4', size: 20000000 } });
  check(r.status === 200 && hasKeys(r.json, ['id', 'uploadId', 'key', 'partSize', 'partCount'])
    && r.json.partSize === 8388608 && r.json.partCount === 3, 'mp init → session {partSize 8MiB, 3 parts}', r);
  const mp = r.json;
  r = await req('POST', '/uploads/multipart/part-urls', { token: A.jwt, body: { id: mp?.id, uploadId: mp?.uploadId, partNumbers: [1, 2, 3] } });
  check(r.status === 200 && r.json?.urls && ['1', '2', '3'].every(k => typeof r.json.urls[k] === 'string'),
    'part-urls → 3 presigned urls', r);
  r = await req('POST', '/uploads/multipart/part-urls', { token: B.jwt, body: { id: mp?.id, uploadId: mp?.uploadId, partNumbers: [1] } });
  check(r.status === 403 && r.json?.error === 'Forbidden', 'part-urls by non-owner → exact 403', r);
  r = await req('GET', `/uploads/multipart/${mp?.id}/parts`, { token: A.jwt });
  check(r.status === 400 && r.json?.error === 'uploadId required', 'parts w/o uploadId → exact 400', r);
  r = await req('GET', `/uploads/multipart/${mp?.id}/parts?uploadId=${encodeURIComponent(mp?.uploadId || '')}`, { token: A.jwt });
  check(r.status === 200 && Array.isArray(r.json?.uploaded) && r.json.uploaded.length === 0, 'parts → {uploaded:[]}', r);
  r = await req('POST', '/uploads/multipart/complete', { token: A.jwt, body: { id: mp?.id, uploadId: mp?.uploadId } });
  check(r.status === 400 && r.json?.error === 'No parts uploaded', 'complete w/o parts → exact 400', r);
  r = await req('POST', '/uploads/multipart/abort', { token: A.jwt, body: { id: mp?.id, uploadId: mp?.uploadId } });
  check(r.status === 200 && r.json?.ok === true, 'abort → {ok} (row deleted)', r);
  r = await req('GET', `/uploads/${mp?.id}`, { token: A.jwt });
  check(r.status === 404, 'aborted attachment gone', r);

  // disk upload path: real bytes through the API, owner round-trip
  try {
    const bytes = Buffer.from(`contract-upload-${Date.now()}`);
    const fd = new FormData();
    fd.append('file', new Blob([bytes], { type: 'text/plain' }), 'contract.txt');
    const up = await fetch(`${BASE}/uploads?viewOnce=0`, {
      method: 'POST', headers: { Authorization: `Bearer ${A.jwt}` }, body: fd,
    });
    const upj = await up.json();
    check(up.status === 200 && hasKeys(upj, ['id', 'mime', 'size', 'filename', 'viewOnce'])
      && upj.size === bytes.length && upj.viewOnce === false, 'disk upload → row shape', upj);
    const dl = await fetch(`${BASE}/uploads/${upj.id}`, { headers: { Authorization: `Bearer ${A.jwt}` } });
    const body = Buffer.from(await dl.arrayBuffer());
    check(dl.status === 200 && body.equals(bytes), 'owner download → identical bytes', { status: dl.status, len: body.length });
    r = await req('GET', `/uploads/${upj.id}`, { token: STATE.users[10].jwt });
    check(r.status === 403 && r.json?.error === 'Forbidden', 'unrelated user download → exact 403', r);
    r = await req('POST', `/uploads/${upj.id}/viewed`, { token: A.jwt });
    check(r.status === 200 && r.json?.ok === true && r.json?.noop === true, 'viewed on non-view-once → {ok, noop}', r);
  } catch (e) {
    check(false, `uploads disk harness: ${e.message}`);
  }

  console.log('user (deep):');
  r = await req('GET', `/user/by-vault/@${profB.vaultId}`, { token: A.jwt });
  check(r.status === 200 && r.json?.userId === B.id && hasKeys(r.json, ['userId', 'name', 'photoURL', 'vaultId']),
    'by-vault (@-prefixed) → public stub', r);
  r = await req('GET', '/user/by-vault/no-such-vault-id-000', { token: A.jwt });
  check(r.status === 404 && r.json?.error === 'No user with that VaultID', 'by-vault unknown → exact 404', r);
  r = await req('GET', `/user/${B.id}/identity`, { token: A.jwt });
  check([200, 404].includes(r.status) && !!r.json, 'GET /user/:id/identity 200|404 JSON (bench users have no ik)', r);
  r = await req('GET', '/user/ghost-mode', { token: A.jwt });
  check(r.status === 200 && !!r.json, 'ghost-mode 200 JSON', r);
  r = await req('GET', '/user/sessions', { token: A.jwt });
  check(r.status === 200 && !!r.json, 'sessions 200 JSON', r);

  console.log('channels (deep):');
  r = await req('POST', '/channels', { token: A.jwt, body: {} });
  check(r.status === 400 && r.json?.error === 'name required', 'create w/o name → exact 400', r);
  r = await req('POST', '/channels', { token: A.jwt, body: { name: 'Contract Channel' } });
  check(r.status === 200 && hasKeys(r.json, ['id', 'name', 'adminId', 'isAdmin', 'inviteCode'])
    && r.json?.isAdmin === true && r.json?.subscriberCount === 1, 'create → publicChannel {subscriberCount:1}', r);
  const chan = r.json;
  r = await req('POST', '/channels/join', { token: B.jwt, body: {} });
  check(r.status === 400 && r.json?.error === 'code required', 'join w/o code → exact 400', r);
  r = await req('POST', '/channels/join', { token: B.jwt, body: { code: '0000-0000' } });
  check(r.status === 404 && r.json?.error === 'No channel with that code', 'join unknown code → exact 404', r);
  r = await req('POST', '/channels/join', { token: B.jwt, body: { code: (chan?.inviteCode || '').toLowerCase() } });
  check(r.status === 200 && r.json?.id === chan?.id && r.json?.isAdmin === false && r.json?.subscriberCount === 2,
    'join (lowercased code) → subscriberCount 2', r);
  r = await req('POST', `/channels/${chan?.id}/posts`, { token: B.jwt, body: { text: 'nope' } });
  check(r.status === 403 && r.json?.error === 'Only the admin can post', 'post by non-admin → exact 403', r);
  r = await req('POST', `/channels/${chan?.id}/posts`, { token: A.jwt, body: {} });
  check(r.status === 400 && r.json?.error === 'text required', 'post w/o text → exact 400', r);
  r = await req('POST', `/channels/${chan?.id}/posts`, { token: A.jwt, body: { text: 'contract post' } });
  check(r.status === 200 && !!r.json?.id && r.json?.text === 'contract post', 'admin post → post row', r);
  r = await req('GET', `/channels/${chan?.id}/posts`, { token: B.jwt });
  check(r.status === 200 && Array.isArray(r.json) && r.json.some(p => p.text === 'contract post' && p.authorId === A.id),
    'subscriber reads posts', r);
  r = await req('GET', `/channels/${chan?.id}/posts`, { token: STATE.users[10].jwt });
  check(r.status === 403 && r.json?.error === 'Not subscribed', 'non-subscriber posts → exact 403', r);
  r = await req('GET', '/channels/00000000-0000-0000-0000-000000000000/posts', { token: A.jwt });
  check(r.status === 404 && r.json?.error === 'Channel not found', 'unknown channel → exact 404', r);
  r = await req('GET', '/channels', { token: B.jwt });
  check(r.status === 200 && Array.isArray(r.json) && r.json.some(c => c.id === chan?.id), 'B list contains channel', r);

  console.log('vaultbeam (deep):');
  const vbId = `contract${Date.now()}${Math.floor(Math.random() * 1e6)}`;
  r = await req('POST', '/vaultbeam/relay/init', { token: A.jwt, body: {} });
  check(r.status === 400 && r.json?.error === 'invalid transferId', 'init w/o transferId → exact 400', r);
  r = await req('POST', '/vaultbeam/relay/init', { token: A.jwt, body: { transferId: vbId } });
  check(r.status === 400 && r.json?.error === 'recipientId required', 'init w/o recipient → exact 400', r);
  r = await req('POST', '/vaultbeam/relay/init', { token: A.jwt, body: { transferId: vbId, recipientId: A.id, totalBytes: 100 } });
  check(r.status === 400 && r.json?.error === 'cannot send to self', 'init to self → exact 400', r);
  r = await req('POST', '/vaultbeam/relay/init', { token: A.jwt, body: { transferId: vbId, recipientId: B.id, totalBytes: 0 } });
  check(r.status === 400 && r.json?.error === 'invalid totalBytes', 'init zero bytes → exact 400', r);
  r = await req('POST', '/vaultbeam/relay/init', { token: A.jwt, body: { transferId: vbId, recipientId: B.id, totalBytes: 13 * 1024 * 1024 * 1024 } });
  check(r.status === 413 && r.json?.error === 'exceeds 12GB cap', 'init >12GB → exact 413', r);
  r = await req('POST', '/vaultbeam/relay/init', { token: A.jwt, body: { transferId: vbId, recipientId: B.id, totalBytes: 1048576 } });
  check(r.status === 200 && r.json?.transferId === vbId
    && hasKeys(r.json, ['transferId', 'blockCount', 'chunkCount', 'chunkBytes', 'blockBytes', 'expiresAt']),
    'init → transfer geometry', r);
  r = await req('GET', `/vaultbeam/relay/${vbId}`, { token: A.jwt });
  check(r.status === 200 && r.json?.isSender === true, 'sender polls transfer state', r);
  r = await req('POST', '/vaultbeam/relay/abort', { token: A.jwt, body: { transferId: vbId } });
  check(r.status === 200, 'abort → 200 (cleanup)', r);
  r = await req('GET', `/vaultbeam/relay/${vbId}`, { token: A.jwt });
  check(r.status === 200 && r.json?.state === 'aborted', 'transfer state → aborted', r);

  console.log('admin (deep):');
  // Bench sets ADMIN_KEY=bench-admin-key (docker-compose.bench.yml) so the
  // whole admin surface is exercisable; without it only the 503 smoke runs.
  const AKEY = process.env.ADMIN_KEY || 'bench-admin-key';
  const admin = (method, p, body) => fetch(`${BASE}${p}`, {
    method,
    headers: { 'x-admin-key': AKEY, ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  }).then(async (x) => ({ status: x.status, json: await x.json().catch(() => null) }));
  r = await req('GET', '/api/admin/stats');
  if (r.status === 503) {
    check(!!r.json?.error, 'admin: 503 when ADMIN_KEY unset', r);
  } else {
    check(r.status === 401 && !!r.json?.error, 'stats w/o key → 401', r);
    r = await admin('GET', '/api/admin/stats');
    check(r.status === 200 && !!r.json, 'stats with key → 200 JSON', r);
    r = await admin('GET', '/api/admin/users?limit=5');
    check(r.status === 200 && !!r.json, 'users list → 200 JSON', r);
    r = await admin('GET', '/api/admin/messages');
    check(r.status === 200 && !!r.json, 'messages firehose → 200 JSON', r);
    r = await admin('GET', '/api/admin/sessions');
    check(r.status === 200 && !!r.json, 'sessions → 200 JSON', r);
    r = await admin('POST', '/api/admin/broadcast', {});
    check(r.status === 400 && r.json?.error === 'text required', 'broadcast w/o text → exact 400', r);
    r = await admin('POST', '/api/admin/broadcast', { text: 'contract announcement' });
    check(r.status === 200 && r.json?.ok === true && r.json?.payload?.text === 'contract announcement'
      && typeof r.json?.delivered === 'number', 'broadcast → {ok, delivered, payload}', r);
    r = await admin('GET', '/api/admin/health-detail');
    check(r.status === 200 && !!r.json, 'health-detail → 200 JSON', r);
  }

  // ── module smokes (promoted to deep fixtures at each route's cutover) ─
  console.log('module smokes:');
  const smokes = [
    ['vaultlens', 'GET', '/vaultlens/catalog', { token: A.jwt }, (x) => x.status === 200 && !!x.json],
    ['vaultlens', 'GET', '/vaultlens/quota', { token: A.jwt }, (x) => x.status === 200 && !!x.json],
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
