// lib/family/placeOptions.selftest.ts — run: npx tsx lib/family/placeOptions.selftest.ts
import assert from 'node:assert/strict';
import { hhmm, describeZone, iconFor, COORD_RE, PRESETS, LIFETIMES, DAYS, DAY_NAMES } from './placeOptions';
import type { Geofence } from './geofence';

assert.equal(hhmm(0), '00:00');
assert.equal(hhmm(9 * 60 + 5), '09:05');
assert.equal(hhmm(22 * 60), '22:00');

const base: Geofence = { id: 'p', name: 'Home', center: { lat: 0, lng: 0 }, radiusM: 150 } as Geofence;
const noon = new Date(2026, 9, 5, 12, 0); // a Monday
assert.equal(describeZone({ ...base, enabled: false }, noon), 'Alerts off');
assert.equal(describeZone({ ...base, expiresAt: noon.getTime() - 1 }, noon), 'Expired');
assert.equal(describeZone(base, noon), '150 m');
assert.equal(describeZone({ ...base, expiresAt: noon.getTime() + 60_000 }, noon), '150 m · temporary');
// School hours on a weekday at noon: live, so not asleep.
assert.equal(describeZone({ ...base, schedule: PRESETS[1].sched! }, noon), '150 m · 09:00–15:00 MTWTF');
// Overnight (every day) at noon: asleep.
assert.equal(describeZone({ ...base, schedule: PRESETS[3].sched! }, noon), '150 m · 22:00–06:00 daily · asleep');

assert.equal(iconFor('My House'), 'home');
assert.equal(iconFor('City College'), 'school');
assert.equal(iconFor('Office'), 'briefcase');
assert.equal(iconFor('Somewhere'), 'location');

assert.ok(COORD_RE.test('17.385, 78.4867'));
assert.ok(COORD_RE.test(' -33.9,151.2 '));
assert.ok(!COORD_RE.test('Banjara Hills'));

assert.equal(PRESETS[0].sched, null);
assert.equal(LIFETIMES[0].ms, null);
assert.equal(DAYS.length, 7);
assert.equal(DAY_NAMES.length, 7);

console.log('placeOptions selftest: ok');
