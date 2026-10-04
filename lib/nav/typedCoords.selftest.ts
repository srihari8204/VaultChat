// lib/nav/typedCoords.selftest.ts — run: npx tsx lib/nav/typedCoords.selftest.ts
//
// A typed destination is either a real coordinate pair or text to geocode.
// Pins the two bugs fixed in typedCoords: unanchored matches inside addresses,
// and pairs outside ±90 / ±180 accepted as destinations.

import assert from 'node:assert/strict';
import { typedCoords, inLatLngRange } from './urlCoords';

assert.deepEqual(typedCoords('12.9716, 77.5946'), { lat: 12.9716, lng: 77.5946 });
assert.deepEqual(typedCoords('  -33.8688,151.2093 '), { lat: -33.8688, lng: 151.2093 });
assert.deepEqual(typedCoords('90, -180'), { lat: 90, lng: -180 }, 'the edges are valid');

assert.equal(typedCoords('91, 10'), 'out-of-range', 'latitude past the pole');
assert.equal(typedCoords('10, 180.5'), 'out-of-range', 'longitude past the antimeridian');
assert.equal(typedCoords('-120, 400'), 'out-of-range');

// Addresses that merely contain "number, number" are text, not coordinates.
assert.equal(typedCoords('Plot 45, 12th Cross'), null);
assert.equal(typedCoords('Flat 3, 21 Baker Street'), null);
assert.equal(typedCoords('12.97, 77.59 Bangalore'), null);
assert.equal(typedCoords('MG Road'), null);
assert.equal(typedCoords(''), null);

assert.equal(inLatLngRange(12.9, 77.5), true);
assert.equal(inLatLngRange(95, 0), false);
assert.equal(inLatLngRange(0, -181), false);
assert.equal(inLatLngRange(NaN, 0), false);

console.log('typedCoords: OK');
