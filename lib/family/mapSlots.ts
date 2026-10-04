// lib/family/mapSlots.ts — where each floating bar sits on the family map,
// moved out of app/family-map.tsx unchanged.
//
// OVERLAY SLOTS. Every floating bar used to carry a hardcoded offset, and
// three pairs collided the moment their conditions were both true: the follow
// banner sat exactly on the search bar, the Routes chip sat under the
// full-width route bar, and the From-Home chip sat on the turn strip. Offsets
// are computed from what is actually on screen instead, so bars stack in a
// fixed reading order and never share a pixel.
//
// Pure (no React), so lib/family/mapSlots.selftest.ts runs it under tsx.

// Compact by intent: every pixel of chrome is a pixel of map the family cannot
// see. Bars are sized to their content and stacked at that pitch.
const TOP_0 = 8, TOP_PITCH = 46;
const BOT_PITCH = 44;

export interface MapSlotInput {
  /** Which top bars are showing, in their stacking order. */
  search: boolean;
  places: boolean;
  trip: boolean;
  follow: boolean;
  leave: boolean;
  /** The floor for bottom bars; the screen includes the gesture inset in it. */
  bottom0: number;
  /** A road route (member, From-Home or destination) is drawn, so its bar shows. */
  routeBar: boolean;
  /** The routed member's next-turn strip shows. */
  turnBar: boolean;
}

export interface MapSlots {
  /** Top offsets; 0 for a bar that is not showing (no slot allocated). */
  searchTop: number;
  placesTop: number;
  tripTop: number;
  followTop: number;
  leaveTop: number;
  /** Where the free map starts below the stacked bars — the nav capsule's top. */
  barsBottom: number;
  routeBarBottom: number;
  turnBarBottom: number;
  /** Above every bottom bar: the chips, FABs, sheets and the map's own controls. */
  chipsBottom: number;
}

export function mapSlots(v: MapSlotInput): MapSlots {
  let i = 0;
  const searchTop = v.search ? TOP_0 + TOP_PITCH * i++ : 0;
  // The place-chip row is a slot like any bar; at a fixed searchTop+52 it sat
  // under the follow/leave bars, which also started at searchTop+46.
  const placesTop = v.places ? TOP_0 + TOP_PITCH * i++ : 0;
  const tripTop = v.trip ? TOP_0 + TOP_PITCH * i++ : 0;
  const followTop = v.follow ? TOP_0 + TOP_PITCH * i++ : 0;
  const leaveTop = v.leave ? TOP_0 + TOP_PITCH * i++ : 0;
  const barsBottom = TOP_PITCH * i;
  // Bottom bars claim the floor first; the chips and the map's own controls
  // then start above whatever is there.
  const routeBarBottom = v.bottom0;
  const turnBarBottom = v.bottom0 + (v.routeBar ? BOT_PITCH : 0);
  const chipsBottom = v.bottom0 + (v.routeBar ? BOT_PITCH : 0) + (v.turnBar ? BOT_PITCH : 0);
  return { searchTop, placesTop, tripTop, followTop, leaveTop, barsBottom, routeBarBottom, turnBarBottom, chipsBottom };
}
