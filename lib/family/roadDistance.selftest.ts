/**
 * lib/family/roadDistance.selftest.ts
 *   run with: npx tsx lib/family/roadDistance.selftest.ts
 *
 * mergeRoadDistances upgrades the DISPLAYED family distance from straight-line
 * to road. The interesting assertions are the ones about what it refuses to
 * touch, because those are the cases where "improving" the number would break
 * a feature:
 *
 *   - an unlocatable member must not acquire a distance
 *   - published reference distances (their Home/Office numbers) must survive
 *     untouched — they come from a device whose places we have never seen
 *   - a garbage figure from the router must not overwrite a good straight line
 */
import assert from 'node:assert/strict';
import { mergeRoadDistances, summarize, summaryBasis, type MemberDistance } from './distance';

let n = 0;
const ok = (label: string, cond: boolean) => { assert.ok(cond, label); n++; };

const row = (over: Partial<MemberDistance>): MemberDistance => ({
  id: 'x', name: 'X', fromMe: 4000, ref: null, refs: [], ...over,
});

// ── the normal case ──────────────────────────────────────────────────
{
  const out = mergeRoadDistances([row({ id: 'a', fromMe: 4000 })], { a: 6200 });
  ok('straight line is replaced by the road figure', out[0].fromMe === 6200);
  ok('and the row says so', out[0].byRoad === true);
}

// ── an unlocatable member must NOT gain a distance ───────────────────
// fromMe null means we do not trust their position at all. Attaching a road
// distance to it would invent precision, and worse, would rank them in a list
// sorted by distance as though we knew where they were.
{
  const out = mergeRoadDistances([row({ id: 'a', fromMe: null, unavailable: true })], { a: 6200 });
  ok('null stays null', out[0].fromMe === null);
  ok('and is not marked byRoad', !out[0].byRoad);
}

// ── published reference distances are never rewritten ────────────────
// These are computed on the OTHER member's device from places this device has
// never seen; by owner directive the coordinates never leave that device. There
// is nothing here to route from.
{
  const refs = [{ n: 'Home', d: 1200 }];
  const out = mergeRoadDistances(
    [row({ id: 'a', fromMe: 4000, ref: refs[0], refs })], { a: 6200 });
  ok('ref survives untouched', out[0].ref === refs[0]);
  ok('refs array survives untouched', out[0].refs === refs);
  ok('only fromMe changed', out[0].fromMe === 6200);
}

// ── a bad router answer must not corrupt a good number ───────────────
for (const bad of [NaN, Infinity, -1, -0.5]) {
  const out = mergeRoadDistances([row({ id: 'a', fromMe: 4000 })], { a: bad as number });
  ok(`router value ${String(bad)} is ignored`, out[0].fromMe === 4000 && !out[0].byRoad);
}

// ── partial answers ──────────────────────────────────────────────────
// The router omits origins it cannot reach; those members keep their straight
// line rather than going blank.
{
  const out = mergeRoadDistances(
    [row({ id: 'a', fromMe: 4000 }), row({ id: 'b', fromMe: 9000 })], { a: 6200 });
  ok('answered member upgraded', out[0].fromMe === 6200 && out[0].byRoad === true);
  ok('unanswered member keeps its straight line', out[1].fromMe === 9000);
  ok('and is not falsely marked byRoad', !out[1].byRoad);
}

// ── identity is preserved when nothing changed ───────────────────────
// family.tsx feeds these rows into useMemo consumers; returning a fresh array
// on every position tick would re-render the whole list for no reason.
{
  const rows = [row({ id: 'a', fromMe: 4000 })];
  ok('no answers → same array reference', mergeRoadDistances(rows, {}) === rows);
  ok('irrelevant answers → same array reference', mergeRoadDistances(rows, { zzz: 500 }) === rows);
  ok('unlocatable-only → same array reference',
     mergeRoadDistances([row({ id: 'a', fromMe: null })], { a: 100 })[0].fromMe === null);
}

// ── rounding ─────────────────────────────────────────────────────────
{
  const out = mergeRoadDistances([row({ id: 'a' })], { a: 6200.6 });
  ok('metres are whole', Number.isInteger(out[0].fromMe as number) && out[0].fromMe === 6201);
}

// ── the summary card names the kind of distance it shows ─────────────
{
  const rows = [row({ id: 'me', fromMe: null, self: true }), row({ id: 'a', fromMe: 4000 }), row({ id: 'b', fromMe: 900 })];
  const none = summarize(rows);
  ok('no road answers → straight-line', none.byRoad === 0 && summaryBasis(none) === 'Straight-line');
  const some = summarize(mergeRoadDistances(rows, { a: 6200 }));
  ok('one of two by road → says so', some.byRoad === 1 && summaryBasis(some) === 'By road (1 straight-line)');
  const all = summarize(mergeRoadDistances(rows, { a: 6200, b: 1300 }));
  ok('all by road → by road', all.byRoad === 2 && summaryBasis(all) === 'By road');
  ok('self never counts', summarize(mergeRoadDistances(rows, { me: 5 })).byRoad === 0);
}

console.log(`roadDistance selftest: OK (${n} checks)`);
