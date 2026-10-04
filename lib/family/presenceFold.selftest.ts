// lib/family/presenceFold.selftest.ts — run: npx tsx lib/family/presenceFold.selftest.ts
import assert from 'node:assert/strict';
import { foldPoint, foldSealed, type Presences } from './presenceFold';
import { type MemberPresence } from './types';

const at = (lat: number, ts: number, extra: Partial<MemberPresence> = {}): MemberPresence =>
  ({ userId: 'a', pos: { lat, lng: 70 }, ts, ...extra });
const refs = [{ n: 'Home', d: 1200 }];
let n = 0;
const ok = (label: string, c: boolean) => { assert.ok(c, label); n++; };

// sealed relay: refs survive the fold
let s: Presences = foldSealed({}, { userId: 'a', presence: at(10, 100, { refs }) });
ok('sealed fix lands', s.a?.ts === 100);
ok('sealed refs are kept', s.a.refs?.[0]?.d === 1200);

// the platform delivers the SAME fix afterwards: refs stay (identical coordinate)
s = foldPoint(s, { userId: 'a', point: at(10, 100) });
ok('same fix from the platform keeps refs', s.a.refs?.[0]?.d === 1200);

// platform first, then the sealed copy of the same fix: refs are attached
let t: Presences = foldPoint({}, { userId: 'a', point: at(10, 100) });
ok('platform fix has no refs', t.a.refs === undefined);
t = foldSealed(t, { userId: 'a', presence: at(10, 100, { refs }) });
ok('late sealed copy attaches refs to that fix', t.a.refs?.[0]?.d === 1200);

// an OLDER sealed fix never brings its refs onto a newer position
let u: Presences = foldPoint({}, { userId: 'a', point: at(11, 200) });
u = foldSealed(u, { userId: 'a', presence: at(10, 100, { refs }) });
ok('older sealed fix is ignored', u.a.ts === 200 && u.a.refs === undefined);

// movement on the platform drops a stale ref
s = foldPoint(s, { userId: 'a', point: at(10.5, 300) });
ok('moved member loses the stale ref', s.a.refs === undefined);

// stops keep the last-known fix, flagged — from either source
ok('platform stop flags sharing off', foldPoint(s, { userId: 'a', point: null }).a.sharingOff === true);
ok('sealed stop flags sharing off', foldSealed(s, { userId: 'a', presence: null }).a.sharingOff === true);
ok('stop for an unknown member is a no-op', foldSealed(s, { userId: 'zz', presence: null }) === s);

console.log(`presenceFold selftest: OK (${n} checks)`);
