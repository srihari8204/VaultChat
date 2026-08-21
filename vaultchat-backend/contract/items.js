// vaultchat-backend/contract/items.js
//
// Behavioral contract for the shared item finder (migration 114,
// space_items.go). Runs against the local Docker bench:
//
//   BASE_URL=http://127.0.0.1:14000 node contract/items.js
//
// What it proves that the pure Go test cannot: the SQL actually pools
// sightings across members, refuses to move the answer backwards when reports
// arrive out of order, keeps ownership on re-pair, and gates every path on
// membership.

const fs = require('fs');
const path = require('path');

const BASE = process.env.BASE_URL || 'http://127.0.0.1:14000';
const STATE = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'loadtest', 'bench-state.json'), 'utf8'));
const A = STATE.users[0];
const B = STATE.users[1];
const GROUP = STATE.groupChatId ?? STATE.groupChatIds?.[0];
const TAG = 'AA:BB:CC:DD:EE:' + String(Date.now() % 100).padStart(2, '0');

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

const find = (list, bleId) => (list ?? []).find((i) => i.bleId === bleId);

async function main() {
  console.log(`space items contract → ${BASE}\n`);
  await req('POST', `/chats/${GROUP}/items/forget`, { token: A.jwt, body: { bleId: TAG } });

  // ── register ──
  let r = await req('POST', `/chats/${GROUP}/items`, { token: A.jwt, body: { bleId: TAG, name: 'Keys', icon: 'key' } });
  check(r.status === 200 && r.json?.ok === true, 'A registers a tag', r);

  r = await req('GET', `/chats/${GROUP}/items`, { token: B.jwt });
  const seenByB = find(r.json?.items, TAG);
  check(r.status === 200 && !!seenByB, 'B sees the tag A registered (pooled per space)', r.json?.items?.length);
  check(seenByB?.ownerId === A.id, 'ownership is recorded as A', seenByB);
  check(seenByB?.lastSeenAt === null, 'a fresh registration has no sighting yet', seenByB);

  // ── validation ──
  r = await req('POST', `/chats/${GROUP}/items`, { token: A.jwt, body: { bleId: '', name: 'X' } });
  check(r.status === 400, 'empty bleId rejected', r);
  r = await req('POST', `/chats/${GROUP}/items`, { token: A.jwt, body: { bleId: TAG, name: '' } });
  check(r.status === 400, 'empty name rejected', r);

  // ── THE POINT: B's phone hears A's tag ──
  const t1 = Date.now();
  r = await req('POST', `/chats/${GROUP}/items/sighting`, {
    token: B.jwt, body: { bleId: TAG, ts: t1, lat: 12.9716, lng: 77.5946, placeName: 'Home' },
  });
  check(r.status === 200 && r.json?.applied === true, "B reports hearing A's tag", r);

  r = await req('GET', `/chats/${GROUP}/items`, { token: A.jwt });
  const afterB = find(r.json?.items, TAG);
  check(afterB?.lastSeenBy === B.id, 'A now sees that B was the finder', afterB);
  check(afterB?.placeName === 'Home', "the finder's place name travels", afterB);
  check(Math.abs((afterB?.lat ?? 0) - 12.9716) < 1e-6, 'the sighting coordinate is stored', afterB);

  // ── ORDERING: an older report must never move the answer backwards ──
  r = await req('POST', `/chats/${GROUP}/items/sighting`, {
    token: A.jwt, body: { bleId: TAG, ts: t1 - 60_000, lat: 1, lng: 1, placeName: 'Office' },
  });
  check(r.status === 200 && r.json?.applied === false, 'an older sighting is not applied', r);
  r = await req('GET', `/chats/${GROUP}/items`, { token: A.jwt });
  check(find(r.json?.items, TAG)?.placeName === 'Home', 'the newer sighting still stands', find(r.json?.items, TAG));

  // …and a newer one does win
  r = await req('POST', `/chats/${GROUP}/items/sighting`, {
    token: A.jwt, body: { bleId: TAG, ts: t1 + 60_000, lat: 2, lng: 2, placeName: 'Office' },
  });
  check(r.json?.applied === true, 'a newer sighting is applied', r);
  r = await req('GET', `/chats/${GROUP}/items`, { token: A.jwt });
  check(find(r.json?.items, TAG)?.placeName === 'Office', 'the newest sighting wins', find(r.json?.items, TAG));

  // ── stale reports are refused, but not as errors (clients must not retry) ──
  r = await req('POST', `/chats/${GROUP}/items/sighting`, {
    token: A.jwt, body: { bleId: TAG, ts: Date.now() - 3 * 3600_000, lat: 3, lng: 3 },
  });
  check(r.status === 200 && r.json?.applied === false, 'a three-hour-old sighting is ignored, not an error', r);

  // ── an unregistered tag is a no-op, never a 500 ──
  r = await req('POST', `/chats/${GROUP}/items/sighting`, { token: A.jwt, body: { bleId: 'ZZ:NOT:REGISTERED', ts: Date.now() } });
  check(r.status === 200 && r.json?.applied === false, 'sighting for an unknown tag is a clean no-op', r);

  // ── re-pair renames but does not seize ownership ──
  r = await req('POST', `/chats/${GROUP}/items`, { token: B.jwt, body: { bleId: TAG, name: 'House keys', icon: 'home' } });
  check(r.status === 200, 'B may rename the shared entry', r);
  r = await req('GET', `/chats/${GROUP}/items`, { token: A.jwt });
  const renamed = find(r.json?.items, TAG);
  check(renamed?.name === 'House keys', 'the rename applied', renamed);
  check(renamed?.ownerId === A.id, 'ownership stays with A — re-pairing must not seize it', renamed);

  // ── forget is owner-only ──
  r = await req('POST', `/chats/${GROUP}/items/forget`, { token: B.jwt, body: { bleId: TAG } });
  r = await req('GET', `/chats/${GROUP}/items`, { token: A.jwt });
  check(!!find(r.json?.items, TAG), "a non-owner cannot delete A's item", r.json?.items?.length);

  r = await req('POST', `/chats/${GROUP}/items/forget`, { token: A.jwt, body: { bleId: TAG } });
  check(r.status === 200, 'the owner removes it', r);
  r = await req('GET', `/chats/${GROUP}/items`, { token: A.jwt });
  check(!find(r.json?.items, TAG), 'it is gone', r.json?.items?.length);

  // ── IDOR ──
  const foreign = '00000000-0000-0000-0000-00000000dead';
  r = await req('GET', `/chats/${foreign}/items`, { token: A.jwt });
  check(r.status === 403 || r.status === 404, 'IDOR: unknown chat denied', r);
  r = await req('POST', `/chats/${foreign}/items`, { token: A.jwt, body: { bleId: TAG, name: 'X' } });
  check(r.status === 403 || r.status === 404, 'IDOR: cannot register into a foreign chat', r);

  console.log(failures ? `\n${failures} FAILURE(S)` : '\nALL ITEM CONTRACTS PASS');
  process.exit(failures ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
