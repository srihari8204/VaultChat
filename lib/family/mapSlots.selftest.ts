// lib/family/mapSlots.selftest.ts — run: npx tsx lib/family/mapSlots.selftest.ts
//
// The family map's bars must stack without sharing a pixel, in a fixed reading
// order, and the bottom controls must clear whatever bars are on the floor.

import assert from 'node:assert/strict';
import { mapSlots, type MapSlotInput } from './mapSlots';

let n = 0;
const eq = <T>(a: T, b: T, label: string) => { assert.deepEqual(a, b, label); n++; };

const none: MapSlotInput = { search: false, places: false, trip: false, follow: false, leave: false, bottom0: 10, routeBar: false, turnBar: false };

// Nothing showing: no slots, the floor is the floor.
eq(mapSlots(none), { searchTop: 0, placesTop: 0, tripTop: 0, followTop: 0, leaveTop: 0, barsBottom: 0,
  routeBarBottom: 10, turnBarBottom: 10, chipsBottom: 10 }, 'empty map');

// Every top bar: one pitch apart, in reading order.
const all = mapSlots({ ...none, search: true, places: true, trip: true, follow: true, leave: true });
eq([all.searchTop, all.placesTop, all.tripTop, all.followTop, all.leaveTop], [8, 54, 100, 146, 192], 'all five stack at 46');
eq(all.barsBottom, 230, 'the nav capsule starts below the fifth bar');

// A hidden bar gives its slot up: follow moves straight under search.
const s = mapSlots({ ...none, search: true, follow: true });
eq([s.searchTop, s.followTop, s.placesTop, s.tripTop], [8, 54, 0, 0], 'follow takes the second slot');
eq(s.barsBottom, 92, 'two bars');

// Navigating: no search or places, the trip bar takes the top slot.
const nav = mapSlots({ ...none, trip: true, leave: true });
eq([nav.tripTop, nav.leaveTop], [8, 54], 'trip then leave');

// Bottom: route bar on the floor, turn strip above it, chips above both.
const b = mapSlots({ ...none, bottom0: 10 + 48, routeBar: true, turnBar: true });
eq([b.routeBarBottom, b.turnBarBottom, b.chipsBottom], [58, 102, 146], 'route, turn, chips with a 48 dp gesture inset');
const r = mapSlots({ ...none, routeBar: true });
eq([r.turnBarBottom, r.chipsBottom], [54, 54], 'route bar alone lifts the chips one pitch');

console.log(`family/mapSlots.selftest: ${n} checks passed`);
