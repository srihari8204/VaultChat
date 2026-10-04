// components/family/useMapRoutes.ts — the road routes and road figures on the
// family map, moved out of app/family-map.tsx with the same triggers.
//
// Each effect is keyed on COORDINATES (plain numbers), not on the objects that
// carry them: presences and the cached own fix are rebuilt on every ping, and
// a request per ping that repeats the same position would cost a routing call
// for nothing. The numbers are read out before the effect, so the dependency
// lists are complete as written.
//
// WHAT REACHES THE ROUTING SERVER (see the screen's header): one /nav/matrix
// call for the connector figures, every position rounded to ~110 m; a full
// route only for what the user asks for or a destination that exists.

import { useEffect, useMemo, useRef, useState } from 'react';
import { fetchRoute, fetchMatrix, nextTurnAlong, type Maneuver } from '../../lib/nav/routing';
import { getNavSettings } from '../../lib/nav/navSettings';
import { playHaptic } from '../../lib/nav/hapticPlayer';
import { formatRoute } from '../../lib/family/distance';
import { freshnessOf } from '../../lib/family/status';
import { type MemberPresence } from '../../lib/family/types';
import { type Geofence } from '../../lib/family/geofence';
import { currentTrip, setTripRoute } from '../../lib/groups/tripSession';
import { type MeetDestination } from './MeetHereSheet';

type Pt = { lat: number; lng: number };
type Shape = Pt[];
const pt = (lat: number | undefined, lng: number | undefined): Pt | null =>
  (lat != null && lng != null ? { lat, lng } : null);

/**
 * Road route to ONE member, fetched on demand (spec §8/§42).
 *
 * Deliberately not fetched for everyone: ten members would be ten Valhalla
 * routings for lines nobody asked to see. The dashed connectors already
 * answer "who is where and how far"; this answers "how do I actually get to
 * THIS one", and only when asked.
 *
 * WITH A DESTINATION SET the same tap answers the trip's question instead:
 * THAT member's own road to the destination ("individual route path"), not
 * my road to them.
 */
export function useMemberRoute({ routeTo, presences, mine, destination }: {
  routeTo: string | null;
  presences: Record<string, MemberPresence>;
  mine: MemberPresence | null;
  destination: MeetDestination | null;
}) {
  const [routeShape, setRouteShape] = useState<Shape | null>(null);
  /** The tapped route's maneuvers — they feed the member turn indicator. */
  const [routeMans, setRouteMans] = useState<Maneuver[] | null>(null);
  const [routeInfo, setRouteInfo] = useState<string | null>(null);
  const [routeBusy, setRouteBusy] = useState(false);

  const target = routeTo ? presences[routeTo] : undefined;
  const tLat = target?.pos.lat, tLng = target?.pos.lng;
  const mLat = mine?.pos.lat, mLng = mine?.pos.lng;
  const dLat = destination?.lat, dLng = destination?.lng;
  // Re-route when the target (or my fix, or the destination) actually moves,
  // not on every ping that repeats the same position.
  useEffect(() => {
    const tPos = pt(tLat, tLng), dPos = pt(dLat, dLng);
    const from = dPos ? tPos : pt(mLat, mLng);
    const to = dPos ?? tPos;
    if (!routeTo || !tPos || !from || !to) { setRouteShape(null); setRouteMans(null); setRouteInfo(null); return; }
    let live = true;
    setRouteBusy(true);
    // ~11 m (4 dp), as the history trace: the router snaps to the road anyway,
    // and it need not see either exact position.
    const r4 = (p: Pt) => ({ lat: Math.round(p.lat * 1e4) / 1e4, lng: Math.round(p.lng * 1e4) / 1e4 });
    fetchRoute(r4(from), r4(to), 'auto')
      .then((r) => {
        if (!live) return;
        setRouteShape(r.shape);
        setRouteMans(r.maneuvers);
        // Road figures, explicitly labelled as such — never mixed with the
        // straight-line numbers on the connectors (§8).
        setRouteInfo(formatRoute(r.lengthM, r.timeS));
      })
      .catch(() => {
        if (!live) return;
        setRouteShape(null);
        setRouteMans(null);
        setRouteInfo('Route unavailable');
      })
      .finally(() => { if (live) setRouteBusy(false); });
    return () => { live = false; };
  }, [routeTo, mLat, mLng, tLat, tLng, dLat, dLng]);

  /** CLEAR: drop the drawn shape now, in the same render that clears routeTo. */
  const clearShape = () => { setRouteShape(null); setRouteMans(null); };
  return { routeShape, routeMans, routeInfo, routeBusy, clearShape };
}

/**
 * MY OWN road to the destination, drawn automatically the moment one exists
 * (a trip landing, or a Meet Here pick). This is the "your route" half of a
 * family trip — no tap required. Also feeds the trip's deviation check, so
 * "left the route" is measured against the road actually drawn.
 */
export function useDestRoute({ destination, mine }: {
  destination: MeetDestination | null;
  mine: MemberPresence | null;
}) {
  const [destRoute, setDestRoute] = useState<Shape | null>(null);
  const [destInfo, setDestInfo] = useState<string | null>(null);
  /** Road seconds to the destination — what "leave now" is computed from.
   *  Kept separate from destInfo, which is a formatted human string. */
  const [destSecs, setDestSecs] = useState<number | null>(null);
  const dLat = destination?.lat, dLng = destination?.lng;
  const mLat = mine?.pos.lat, mLng = mine?.pos.lng;
  useEffect(() => {
    const dPos = pt(dLat, dLng), mPos = pt(mLat, mLng);
    if (!dPos || !mPos) { setDestRoute(null); setDestInfo(null); setDestSecs(null); return; }
    let live = true;
    fetchRoute(mPos, dPos, 'auto')
      .then((r) => {
        if (!live) return;
        setDestRoute(r.shape);
        setDestInfo(formatRoute(r.lengthM, r.timeS));
        setDestSecs(r.timeS);
        const t = currentTrip();
        // Never override a leader's shared route — that is the road the group
        // agreed on; mine only stands in when nobody is leading.
        if (t && !t.leaderId) setTripRoute(r.shape);
      })
      .catch(() => { if (live) { setDestRoute(null); setDestInfo(null); setDestSecs(null); } });
    return () => { live = false; };
  }, [dLat, dLng, mLat, mLng]);
  return { destRoute, destInfo, destSecs };
}

/** From-Home: the road from MY reference place to where I am now. */
export function useHomeRoute({ show, homePlace, mine }: {
  show: boolean;
  homePlace: Geofence | null;
  mine: MemberPresence | null;
}) {
  const [homeRoute, setHomeRoute] = useState<Shape | null>(null);
  const [homeInfo, setHomeInfo] = useState<string | null>(null);
  const hLat = homePlace?.center.lat, hLng = homePlace?.center.lng;
  const mLat = mine?.pos.lat, mLng = mine?.pos.lng;
  useEffect(() => {
    const hPos = pt(hLat, hLng), mPos = pt(mLat, mLng);
    if (!show || !hPos || !mPos) { setHomeRoute(null); setHomeInfo(null); return; }
    let live = true;
    fetchRoute(hPos, mPos, 'auto')
      .then((r) => { if (live) { setHomeRoute(r.shape); setHomeInfo(formatRoute(r.lengthM, r.timeS)); } })
      .catch(() => { if (live) { setHomeRoute(null); setHomeInfo('Route unavailable'); } });
    return () => { live = false; };
  }, [show, hLat, hLng, mLat, mLng]);
  return { homeRoute, homeInfo };
}

/**
 * ROAD FIGURES ON THE ALWAYS-ON CONNECTORS — one call, coarse positions.
 *
 * This used to fetch a full Valhalla ROUTE from me to every member, each at
 * full GPS precision, again whenever anyone moved 250 m: every member's
 * decrypted position went to the routing server, one request per member,
 * for lines nobody asked to see in detail. The connectors only need a
 * distance and a time, so now ONE /nav/matrix call answers the whole family
 * (as the hub already does), with every position rounded to ~110 m first —
 * the precision those figures can show. A road SHAPE is fetched only when a
 * member's Route is tapped (useMemberRoute).
 *
 * Keyed on the rounded positions, so jitter and small moves cost nothing. A
 * failed call leaves the straight-line figures, which never claim a road.
 */
export function useRoadLabels({ enabled, mine, presences, me, now }: {
  enabled: boolean;
  mine: MemberPresence | null;
  presences: Record<string, MemberPresence>;
  me: string | null;
  now: number;
}): Record<string, string> {
  const [roadLabel, setRoadLabel] = useState<Record<string, string>>({});
  // The request, serialised: the rounded origin and member rows. The effect
  // re-reads it from this key, so it runs exactly when the key changes.
  const key = useMemo(() => {
    if (!enabled || !mine) return null;
    const q = (n: number) => Math.round(n * 1000) / 1000;
    const rows = Object.entries(presences)
      .filter(([uid, p]) => uid !== me && freshnessOf(p.ts, now) !== 'unavailable')
      .map(([uid, p]) => ({ id: uid, pos: { lat: q(p.pos.lat), lng: q(p.pos.lng) } }))
      .sort((a, b) => (a.id < b.id ? -1 : 1));
    if (!rows.length) return null;
    const origin = { lat: q(mine.pos.lat), lng: q(mine.pos.lng) };
    return JSON.stringify([origin, rows]);
  }, [enabled, mine, presences, me, now]);
  useEffect(() => {
    if (!key) { setRoadLabel({}); return; }
    const [origin, rows] = JSON.parse(key) as [Pt, { id: string; pos: Pt }[]];
    let live = true;
    fetchMatrix(rows.map((r) => r.pos), origin, 'auto')
      .then((res) => {
        if (!live) return;
        const next: Record<string, string> = {};
        for (const r of res) {
          const t = rows[r.index];
          if (t) next[t.id] = `${formatRoute(r.distanceM, r.durationS)} by road`;
        }
        setRoadLabel(next);
      })
      .catch(() => { if (live) setRoadLabel({}); });
    return () => { live = false; };
  }, [key]);
  return roadLabel;
}

/**
 * NEXT TURN of the member whose route is on screen — the watcher's
 * indicator: their route, their live pings, their next left/right. The cue
 * also FIRES (sound per nav settings' mode, vibration per profile) once per
 * maneuver as they close within the trigger distance.
 */
const TURN_FIRE_M = 250;
export function useMemberTurn({ routeTo, routeShape, routeMans, presences }: {
  routeTo: string | null;
  routeShape: Shape | null;
  routeMans: Maneuver[] | null;
  presences: Record<string, MemberPresence>;
}) {
  const routed = routeTo ? presences[routeTo]?.pos : undefined;
  const rLat = routed?.lat, rLng = routed?.lng;
  const memberTurn = useMemo(() => {
    const pos = pt(rLat, rLng);
    if (!routeTo || !routeShape || !routeMans || !pos) return null;
    return nextTurnAlong(routeShape, routeMans, pos);
  }, [routeTo, routeShape, routeMans, rLat, rLng]);
  const firedTurn = useRef<string | null>(null);
  useEffect(() => {
    if (!memberTurn || !routeTo) return;
    const key = `${routeTo}:${memberTurn.index}`;
    if (memberTurn.distM <= TURN_FIRE_M && firedTurn.current !== key) {
      firedTurn.current = key;
      const s = getNavSettings();
      playHaptic(memberTurn.event, s.profile, { mode: s.mode });
    }
  }, [memberTurn, routeTo]);
  return memberTurn;
}
