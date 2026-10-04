// Run: npx tsx lib/nav/geocodeBias.selftest.ts
// The type-ahead's "near" bias leaves the device rounded to about 1 km.
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { coarseLatLng, haversine } from './geo';

const p = { lat: 12.971598, lng: 77.594566 };
const c = coarseLatLng(p);
assert.deepEqual(c, { lat: 12.97, lng: 77.59 });
assert.ok(haversine(p, c) < 1000, 'still within about 1 km, so the bias works');
assert.deepEqual(coarseLatLng({ lat: -33.8688, lng: 151.2093 }), { lat: -33.87, lng: 151.21 });
const src = fs.readFileSync(path.join(__dirname, 'geocode.ts'), 'utf8');
assert.ok(/coarseLatLng\(near\)/.test(src) && !/String\(near\.lat\)/.test(src), 'geocodeSearch sends only the rounded point');
console.log('geocodeBias selftest: 4 passed');
