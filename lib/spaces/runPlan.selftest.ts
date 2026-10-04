// Run: npx tsx lib/spaces/runPlan.selftest.ts
// Stop payloads, rider remapping after a stop-list save, and the driver's
// per-stop manifest (riders with no stop must stay markable).
import assert from 'node:assert/strict';
import {
  parseCoords, parseClock, plannedAtOn, clockOf, stopPayload, remapRiders,
} from './runPlan';
import { driverView, nextStop, type RunStop, type RunRider, type RiderState } from './runs';

const stop = (id: string, seq: number, extra: Partial<RunStop> = {}): RunStop =>
  ({ id, seq, label: `Stop ${seq}`, lat: null, lng: null, plannedAt: null, arrivedAt: null, ...extra });
const rider = (id: string, stopId: string | null, state: RiderState = 'pending'): RunRider =>
  ({ riderId: id, stopId, state, stateAt: null, note: null, displayName: id.toUpperCase() });

// ── coordinates ──
assert.deepEqual(parseCoords('12.97, 77.59'), { lat: 12.97, lng: 77.59 });
assert.deepEqual(parseCoords('-33.9 151.2'), { lat: -33.9, lng: 151.2 });
assert.equal(parseCoords('91, 0'), null, 'latitude out of range is refused (the DB check would 500)');
assert.equal(parseCoords('0, 181'), null);
assert.equal(parseCoords('Green Lane'), null);
assert.equal(parseCoords(''), null);

// ── planned times ──
assert.equal(parseClock('7:05'), 425);
assert.equal(parseClock('23:59'), 1439);
assert.equal(parseClock('24:00'), null);
assert.equal(parseClock('7.05'), null);
assert.equal(parseClock('07:45:00'), 465, 'a server TIME string parses too');
assert.equal(parseClock(''), null);
const base = new Date(2026, 9, 4, 22, 30).getTime(); // local 4 Oct, late evening
const iso = plannedAtOn(base, 7 * 60 + 5);
const back = new Date(iso);
assert.equal(back.getDate(), 4, 'the LOCAL day of the base is kept, not the UTC one');
assert.equal(back.getHours(), 7);
assert.equal(back.getMinutes(), 5);
assert.equal(clockOf(iso), '07:05', 'a saved time pre-fills as the same wall clock');
assert.equal(clockOf(null), '');
assert.equal(clockOf('nonsense'), '');

// ── stop payload keeps place and time (it used to send only the label) ──
const payload = stopPayload([
  stop('a', 0, { lat: 1, lng: 2, plannedAt: iso }),
  stop('b', 1),
  stop('c', 2, { lat: 1, lng: null }), // half a coordinate is no coordinate
]);
assert.deepEqual(payload[0], { label: 'Stop 0', lat: 1, lng: 2, plannedAt: iso });
assert.deepEqual(payload[1], { label: 'Stop 1' });
assert.deepEqual(payload[2], { label: 'Stop 2' });

// ── remap after the server re-issues stop ids ──
// Before: s1, s2, s3. Edit: remove s2, insert a new stop first. After save the
// server returns n0..n2 in that order.
const riders = [rider('x', 's1'), rider('y', 's2'), rider('z', 's3'), rider('w', null)];
const remapped = remapRiders(riders, [null, 's1', 's3'], [
  { id: 'n2', seq: 2 }, { id: 'n0', seq: 0 }, { id: 'n1', seq: 1 },
]);
assert.deepEqual(remapped, [
  { riderId: 'x', stopId: 'n1' },
  { riderId: 'y', stopId: null }, // their stop was removed
  { riderId: 'z', stopId: 'n2' },
  { riderId: 'w', stopId: null },
]);

// ── driver view ──
const stops = [stop('s2', 1), stop('s1', 0)];

// Unassigned riders are shown (and markable) at the first stop together with
// that stop's own riders — they used to be routed there by nextStop and then
// filtered out by stopId.
let v = driverView(stops, [rider('a', 's1'), rider('u', null), rider('b', 's2')]);
assert.equal(v?.stop?.id, 's1');
assert.deepEqual(v?.riders.map((r) => r.riderId), ['a', 'u']);

// Only unassigned left: still at the first stop, still listed.
v = driverView(stops, [rider('a', 's1', 'boarded'), rider('u', null), rider('b', 's2', 'absent')]);
assert.equal(v?.stop?.id, 's1');
assert.ok(v?.riders.some((r) => r.riderId === 'u' && r.state === 'pending'));

// A rider pointing at a stop the run no longer has is treated as unassigned.
v = driverView(stops, [rider('o', 'gone')]);
assert.equal(v?.stop?.id, 's1');
assert.deepEqual(v?.riders.map((r) => r.riderId), ['o']);
assert.equal(nextStop(stops, [rider('o', 'gone')])?.id, 's1');

// Later stop: unassigned riders do NOT repeat there.
v = driverView(stops, [rider('a', 's1', 'boarded'), rider('b', 's2')]);
assert.equal(v?.stop?.id, 's2');
assert.deepEqual(v?.riders.map((r) => r.riderId), ['b']);

// No stops at all: everybody is markable, pending first.
v = driverView([], [rider('b', null, 'boarded'), rider('a', null)]);
assert.equal(v?.stop, null);
assert.deepEqual(v?.riders.map((r) => r.riderId), ['a', 'b']);

// Nothing pending → done, with or without stops.
assert.equal(driverView([], [rider('a', null, 'dropped')]), null);
assert.equal(driverView(stops, [rider('a', 's1', 'absent')]), null);
assert.equal(driverView([], []), null);

console.log('spaces/runPlan self-check OK');
