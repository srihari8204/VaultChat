// lib/family/presenceFold.ts — fold one presence event into the screen's
// member → presence map. Shared by the hub (components/family/useHubPresence)
// and the live map (app/family-map.tsx), which used to write the same fold out
// five times between them.
//
// Two sources feed the one store: the location service (PlatformEvent) and the
// sealed relay (PresenceEvent). Newest fix per member wins (mergePresence); a
// stop keeps the last-known fix, flagged (markSharingOff).
//
// The sealed relay alone carries the member's published reference distances
// ("1.2 km from Home"). Folding it through mergePresence's platform shape
// dropped them, so no roster ever showed one. They are attached here, but only
// to the very fix they were computed for — a ref line for a position the store
// has since moved past would be a wrong number, and blank beats wrong.

import { mergePresence, type PlatformEvent } from '../location/live';
import { markSharingOff } from './status';
import { type MemberPresence } from './types';
import type { PresenceEvent } from './presence';

export type Presences = Record<string, MemberPresence>;

/** One location-service event (a point, or an explicit stop). */
export function foldPoint(prev: Presences, e: PlatformEvent): Presences {
  return e.point
    ? mergePresence(prev, {
      userId: e.userId, lat: e.point.pos.lat, lng: e.point.pos.lng,
      ts: e.point.ts, spd: e.point.speed, acc: e.point.accuracy, bat: e.point.battery,
    })
    : markSharingOff(prev, e.userId);
}

/** One sealed-relay event: the same fold, plus the refs it alone carries. */
export function foldSealed(prev: Presences, e: Pick<PresenceEvent, 'userId' | 'presence'>): Presences {
  const p = e.presence;
  if (!p) return markSharingOff(prev, e.userId);
  const next = mergePresence(prev, {
    userId: e.userId, lat: p.pos.lat, lng: p.pos.lng,
    ts: p.ts, spd: p.speed, acc: p.accuracy, bat: p.battery,
  });
  const cur = next[e.userId];
  if (!p.refs?.length || !cur || cur.refs === p.refs) return next;
  if (cur.ts !== p.ts || cur.pos.lat !== p.pos.lat || cur.pos.lng !== p.pos.lng) return next;
  return { ...next, [e.userId]: { ...cur, refs: p.refs } };
}
