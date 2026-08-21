// vaultchat-backend/contract/trips.js
//
// Behavioral contract for server-backed family trips (migration 113,
// space_trips.go). Runs against the local Docker bench:
//
//   BASE_URL=http://127.0.0.1:14000 node contract/trips.js
//
// Needs: bench seeded (node loadtest/seed.js — users A/B share the bench
// group), migration 113 applied, the Go binary built from this tree.
//
// What it proves that the pure Go test cannot: the partial unique index
// actually funnels a racing second start into a 409 that carries the winning
// trip; ending is starter-only; the active read is membership-gated.

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
  console.log(`space trips contract → ${BASE}\n`);
  const dest = { destinationName: 'Contract Cafe', lat: 17.385, lng: 78.4867 };

  // Clean slate: end any leftover trip from a previous run (idempotent for
  // the starter; harmless 200 {ended:false} when there is none).
  await req('POST', `/chats/${GROUP}/trip/end`, { token: A.jwt, body: {} });
  await req('POST', `/chats/${GROUP}/trip/end`, { token: B.jwt, body: {} });

  // ── read with no trip ──
  let r = await req('GET', `/chats/${GROUP}/trip`, { token: A.jwt });
  check(r.status === 200 && r.json?.trip === null, 'no trip → {trip: null}', r);

  // ── start ──
  r = await req('POST', `/chats/${GROUP}/trip`, { token: A.jwt, body: dest });
  check(r.status === 200 && r.json?.trip?.destinationName === 'Contract Cafe', 'A starts a trip', r);
  check(r.json?.trip?.startedBy === A.id, 'the trip records its starter', r.json?.trip);
  const tripId = r.json?.trip?.id;

  // ── one active trip per space: the DB resolves the race ──
  r = await req('POST', `/chats/${GROUP}/trip`, { token: B.jwt, body: { ...dest, destinationName: 'Rival Cafe' } });
  check(r.status === 409 && r.json?.trip?.id === tripId, 'second start → 409 carrying the WINNING trip', r);

  // ── everyone in the space reads it ──
  r = await req('GET', `/chats/${GROUP}/trip`, { token: B.jwt });
  check(r.status === 200 && r.json?.trip?.id === tripId, 'B reads the active trip', r);

  // ── validation ──
  r = await req('POST', `/chats/${GROUP}/trip`, { token: A.jwt, body: { destinationName: '', lat: 1, lng: 1 } });
  check(r.status === 400 || r.status === 409, 'empty destination rejected (or blocked by the live trip)', r);

  // ── end: starter-only ──
  r = await req('POST', `/chats/${GROUP}/trip/end`, { token: B.jwt, body: {} });
  check(r.status === 403, "B cannot end A's trip", r);

  r = await req('POST', `/chats/${GROUP}/trip/end`, { token: A.jwt, body: {} });
  check(r.status === 200 && r.json?.ended === true, 'A ends the trip', r);

  r = await req('GET', `/chats/${GROUP}/trip`, { token: B.jwt });
  check(r.status === 200 && r.json?.trip === null, 'ended trip no longer reads as active', r);

  // Ending again is idempotent, never an error — a double-tap on END.
  r = await req('POST', `/chats/${GROUP}/trip/end`, { token: A.jwt, body: {} });
  check(r.status === 200 && r.json?.ended === false, 'double end is a no-op, not an error', r);

  // ── a new trip can start after the old one ends ──
  r = await req('POST', `/chats/${GROUP}/trip`, { token: B.jwt, body: { ...dest, destinationName: 'Second Cafe' } });
  check(r.status === 200 && r.json?.trip?.startedBy === B.id, 'B starts the next trip after A ended', r);
  await req('POST', `/chats/${GROUP}/trip/end`, { token: B.jwt, body: {} });

  // ── IDOR ──
  const foreign = '00000000-0000-0000-0000-00000000dead';
  r = await req('GET', `/chats/${foreign}/trip`, { token: A.jwt });
  check(r.status === 403 || r.status === 404, 'IDOR: unknown chat denied', r);
  r = await req('POST', `/chats/${foreign}/trip`, { token: A.jwt, body: dest });
  check(r.status === 403 || r.status === 404, 'IDOR: cannot start a trip in a foreign chat', r);

  console.log(failures ? `\n${failures} FAILURE(S)` : '\nALL TRIP CONTRACTS PASS');
  process.exit(failures ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
