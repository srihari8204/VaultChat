// vaultchat-backend/contract/locations.js
//
// Behavioral contract for the all-space location platform (migration 103,
// spaces_locations.go). Runs against the local Docker bench:
//
//   BASE_URL=http://127.0.0.1:14000 node contract/locations.js
//
// Needs: bench seeded (node loadtest/seed.js — users A/B share the bench
// group), migration 103 applied, and the Go binary built from this tree.
//
// What it proves that the pure policy test cannot: the SQL predicates in
// locVisibleWhere actually enforce the decision table — membership gates,
// same-space mutual visibility, target filtering in /latest, history denial,
// IDOR against a chat the caller is not in, ingest validation and dedupe.

const fs = require('fs');
const path = require('path');

const BASE = process.env.BASE_URL || 'http://127.0.0.1:14000';
const STATE = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'loadtest', 'bench-state.json'), 'utf8'));
const A = STATE.users[0];
const B = STATE.users[1];
const GROUP = STATE.groupChatId ?? STATE.groupChatIds?.[0];

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

async function main() {
  console.log(`location platform contract → ${BASE}\n`);
  const now = Date.now();
  const pt = (ts, lat = 12.9716, lng = 77.5946) => ({ lat, lng, ts, spd: 4.2, acc: 12, bat: 77 });

  // ── ingest ──
  let r = await req('POST', `/chats/${GROUP}/locations`, { token: A.jwt, body: { points: [pt(now - 5000), pt(now - 3000)] } });
  check(r.status === 200 && r.json?.accepted === 2, 'A uploads 2 valid points', r);

  r = await req('POST', `/chats/${GROUP}/locations`, { token: A.jwt, body: { points: [pt(now - 5000)] } });
  check(r.status === 200 && r.json?.accepted === 0 && r.json?.received === 1, 'duplicate ts deduplicated', r);

  r = await req('POST', `/chats/${GROUP}/locations`, { token: A.jwt, body: { points: [pt(now, 91, 0)] } });
  check(r.status === 200 && r.json?.accepted === 0, 'out-of-range lat rejected', r);

  r = await req('POST', `/chats/${GROUP}/locations`, { token: A.jwt, body: { points: [pt(now + 10 * 60_000)] } });
  check(r.status === 200 && r.json?.accepted === 0, 'future timestamp rejected', r);

  r = await req('POST', `/chats/${GROUP}/locations`, { token: A.jwt, body: { points: [] } });
  check(r.status === 400, 'empty batch is a 400', r);

  // ── latest: same-space mutual visibility (bench group is generic/family) ──
  r = await req('GET', `/chats/${GROUP}/locations/latest`, { token: B.jwt });
  const rows = r.json?.members ?? [];
  check(r.status === 200 && rows.some((m) => m.userId === A.id), 'B sees A in latest (same space)', r);
  const aRow = rows.find((m) => m.userId === A.id);
  check(!!aRow && Math.abs(aRow.lat - 12.9716) < 1e-6, "A's newest coordinates are A's own", aRow);

  // ── history: policy + shape ──
  r = await req('GET', `/chats/${GROUP}/locations/history?userId=${A.id}&limit=10`, { token: B.jwt });
  check(r.status === 200 && Array.isArray(r.json?.points) && r.json.points.length >= 2, 'B reads A history in shared space', r);

  // ── denials ──
  // Non-member: a chat id that exists for A/B's DIRECT chat is still a chat —
  // but a random UUID must 403/404, never 200 with rows.
  const bogus = '00000000-0000-4000-8000-000000000000';
  r = await req('GET', `/chats/${bogus}/locations/latest`, { token: A.jwt });
  check(r.status === 403 || r.status === 404, 'IDOR: unknown chat denied', r);

  r = await req('POST', `/chats/${bogus}/locations`, { token: A.jwt, body: { points: [pt(now)] } });
  check(r.status === 403 || r.status === 404, 'IDOR: cannot upload into a foreign chat', r);

  r = await req('GET', `/chats/${GROUP}/locations/latest`, {});
  check(r.status === 401, 'unauthenticated latest denied', r);

  // A history target outside the space must be denied, not empty-200.
  r = await req('GET', `/chats/${GROUP}/locations/history?userId=${bogus}`, { token: A.jwt });
  check(r.status === 403, 'history for a non-member target denied', r);

  // ── explicit sharing state (migration 104) ──
  r = await req('POST', `/chats/${GROUP}/locations/stop`, { token: A.jwt, body: {} });
  check(r.status === 200 && r.json?.sharing === false, 'A stops sharing (flag recorded)', r);

  r = await req('POST', `/chats/${GROUP}/locations`, { token: A.jwt, body: { points: [pt(now - 1000)] } });
  check(r.status === 409, 'upload after explicit stop is refused by the SERVER', r);

  r = await req('GET', `/chats/${GROUP}/locations/latest`, { token: B.jwt });
  const offRow = (r.json?.members ?? []).find((m) => m.userId === A.id);
  check(!!offRow && offRow.sharingEnabled === false, 'last-known survives the stop, flagged sharingEnabled=false', offRow);
  check(!!offRow && Math.abs(offRow.lat - 12.9716) < 1e-6, 'last-known coordinates are intact (nothing deleted)', offRow);

  r = await req('POST', `/chats/${GROUP}/locations/start`, { token: A.jwt, body: {} });
  check(r.status === 200 && r.json?.sharing === true, 'A re-enables sharing', r);

  r = await req('POST', `/chats/${GROUP}/locations`, { token: A.jwt, body: { points: [pt(now + 1000 - 2)] } });
  check(r.status === 200 && r.json?.accepted === 1, 'fresh upload accepted after re-enable', r);

  r = await req('GET', `/chats/${GROUP}/locations/latest`, { token: B.jwt });
  const onRow = (r.json?.members ?? []).find((m) => m.userId === A.id);
  check(!!onRow && onRow.sharingEnabled === true, 'latest reflects sharingEnabled=true after re-enable', onRow);

  console.log(failures ? `\n${failures} FAILURE(S)` : '\nALL LOCATION CONTRACTS PASS');
  process.exit(failures ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
