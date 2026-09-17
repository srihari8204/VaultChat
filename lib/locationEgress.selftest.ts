// lib/locationEgress.selftest.ts — a denied viewer must not FETCH, and must not
// UPLOAD, another member's location track.
//
// Run: npx tsx lib/locationEgress.selftest.ts
//
// Why this is a source scan and not a unit test: the defect was never in a
// function, it was in the ORDER of two statements. app/family-member.tsx issued
// getTrack() inside the same Promise.all as the getGroup() that yields the
// permission, so the track had already arrived before anyone could say whether
// it was allowed; the gate then only hid a button. The travelled-distance effect
// downstream feeds that track to fetchTraceDistance, which POSTs the polyline to
// /nav/trace — so the leak left the device. app/group-insights.tsx had the same
// shape with no userId at all, i.e. every member.
//
// The invariant, therefore, is positional: the permission is decided BEFORE the
// fetch, and the fetch is guarded by it. Nothing about a rendered component can
// observe that, so we assert it on the source.

import fs from 'node:fs';
import path from 'node:path';
import { historyAccess, migrateCircles, type GroupRef } from './groups/store';

const root = path.resolve(__dirname, '..');
const read = (p: string) => fs.readFileSync(path.join(root, p), 'utf8');

let failed = 0;
function ok(msg: string, pass: boolean) {
  console.log(`${pass ? 'ok  ' : 'FAIL'} ${msg}`);
  if (!pass) failed++;
}

/**
 * "`a` appears before `b`, AND BOTH APPEAR."
 *
 * A bare `src.indexOf(a) < src.indexOf(b)` is worse than no assertion: delete
 * the guard `a` and indexOf returns -1, which is less than every real index, so
 * the check goes green in exactly the case it exists to catch (2026-09-17).
 * Every positional assertion in this file goes through here.
 */
const before = (src: string, a: string, b: string): boolean => {
  const i = src.indexOf(a);
  const j = src.indexOf(b);
  return i !== -1 && j !== -1 && i < j;
};

// ── app/family-member.tsx ────────────────────────────────────────────────
{
  const src = read('app/family-member.tsx');
  const calls = src.split('getTrack(').length - 1;
  const iDenied = src.indexOf('const denied');
  const iTrack = src.indexOf('getTrack(', src.indexOf('from \'../lib/family/history\'') + 1);

  ok('family-member: exactly one getTrack call', calls === 1);
  ok('family-member: permission decided before the fetch',
    iDenied !== -1 && iTrack !== -1 && iDenied < iTrack);
  // The call itself must sit on the allowed branch of the gate — ordering alone
  // is not enough, the original bug computed the permission and ignored it.
  const gate = /const\s+(\w+)\s*=\s*denied\s*\?\s*\[\]\s*:\s*await\s+getTrack\(/.exec(src);
  ok('family-member: the fetch is on the allowed branch of the gate', gate !== null);
  // Every path into `today` — which is what reaches fetchTraceDistance — must
  // run through that gate, so a denied viewer's track is empty. The gate's
  // result is named, so accept the name it binds or the expression itself, and
  // nothing else.
  const setters: string[] = src.match(/setToday\(([^)]*)\)/g) ?? [];
  ok('family-member: every setToday is fed by that gate',
    setters.length > 0 && gate !== null
    && setters.every((s) => s.includes(gate[1]) || s.includes('denied')));
  // …and an empty track cannot reach the network: trackKey is '' below 2
  // samples and the effect returns before requiring the routing module.
  ok('family-member: an empty track never reaches fetchTraceDistance',
    /today\.length\s*<\s*2\s*\?\s*''/.test(src)
    && before(src, 'if (!trackKey)', 'fetchTraceDistance'));
}

// ── app/group-insights.tsx ───────────────────────────────────────────────
{
  const src = read('app/group-insights.tsx');
  const iAllowed = src.indexOf('const allowed');
  const iTrack = src.indexOf('getTrack(', src.indexOf('from \'../lib/family/history\'') + 1);

  ok('group-insights: permission decided before the fetch',
    iAllowed !== -1 && iTrack !== -1 && iAllowed < iTrack);
  // A circle-wide read (no userId) is only legal on the allowed branch; the
  // denied branch must scope the read to the viewer's own id.
  ok('group-insights: circle-wide read is gated on the permission',
    /allowed\s*\?\s*getTrack\(/.test(src));
  ok('group-insights: the denied branch reads only the viewer\'s own track',
    /myId\s*\?\s*getTrack\([^)]*userId:\s*myId/.test(src));
  // No unguarded circle-wide call may survive anywhere in the file. A `?? []`
  // with no length check is not an assertion: rename getTrack and the loop runs
  // zero times and the file still reports success (2026-09-17).
  const trackCalls: string[] = src.match(/getTrack\([^)]*\)/g) ?? [];
  ok('group-insights: there are getTrack calls to check at all', trackCalls.length > 0);
  for (const m of trackCalls) {
    const lead = src.slice(Math.max(0, src.indexOf(m) - 40), src.indexOf(m));
    ok(`group-insights: guarded — ${m.slice(0, 48)}…`,
      m.includes('userId') || /allowed\s*\?\s*$/.test(lead));
  }
}

// ── the gate itself: UNKNOWN IS NOT DENIED ───────────────────────────────
//
// The scans above cannot see the failure that mattered most (2026-09-17): the
// order was right, the branch was right, and a PERMITTED viewer still got an
// empty track. `GroupRef.permissions` is a cache of server truth and it is
// absent until a getChat has landed — a migrated circle has never had one — so
// reading absence as an empty permission set denied every member of every such
// circle, its owner included, and the screen then narrated the withheld track
// as facts about the person. Both directions are pinned here: unknown must not
// deny, and a real refusal must still refuse.
{
  const ref = (p: Partial<GroupRef>): GroupRef =>
    ({ id: 'g', name: 'G', groupType: 'family', ...p });

  const migrated = migrateCircles([], [{ id: 'c1', name: 'Balla' }])[0];
  ok('gate: a migrated circle never evaluates as denied',
    historyAccess(migrated) !== 'denied');
  ok('gate: a typed group with no cached permissions is not denied',
    historyAccess(ref({})) !== 'denied');
  ok('gate: an untyped legacy group stays open',
    historyAccess(ref({ groupType: null })) === 'allowed');
  ok('gate: a cached grant allows',
    historyAccess(ref({ permissions: ['view_history'] })) === 'allowed');
  ok('gate: a cached set WITHOUT view_history still denies',
    historyAccess(ref({ permissions: [] })) === 'denied');

  // The screens must consult that gate rather than rebuilding the decision from
  // a raw `permissions ?? []`, which is the shape that lost the third case.
  for (const f of ['app/family-member.tsx', 'app/group-insights.tsx']) {
    const s = read(f);
    ok(`${f}: withholds on 'denied' only, through the shared gate`,
      /historyAccess\([^)]*\)\s*!==\s*'denied'/.test(s));
    ok(`${f}: does not re-derive the permission from a raw set`,
      !/permissions\s*\?\?\s*\[\]/.test(s));
  }
}

// ── the denied state must SAY it is denied ───────────────────────────────
// Withholding the data was only half the fix: family-member.tsx rendered the
// withheld track as "No recent location / 0 m travelled / 0 km/h", which are
// claims about the member, not about the permission.
{
  const src = read('app/family-member.tsx');
  ok('family-member: the denied state carries a lock notice, as group-insights does',
    /withheld\s*&&/.test(src) && src.includes('lock-closed-outline'));
  ok('family-member: the stats and timeline are not rendered from a withheld track',
    before(src, '{!withheld && (<>', "Today&apos;s Activity"));
}

console.log(failed === 0
  ? '\nlocationEgress: no unpermitted track reaches the device or the network'
  : `\nlocationEgress: ${failed} check(s) failed`);
process.exit(failed === 0 ? 0 : 1);
