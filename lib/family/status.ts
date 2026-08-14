// lib/family/status.ts — freshness tiers, derived member status, speed bands
// and trip segmentation for the Family space.
//
// EVERYTHING HERE IS DERIVED ON THE VIEWING DEVICE. Positions are E2EE — the
// server cannot compute "at school", so the client that decrypted the ping
// does, against the VIEWER's own saved places. Nothing in this module invents
// data: no presence → 'unavailable', never a fabricated status; no speed → no
// speed; a gap in samples → a gap in trips.
//
// Pure — no react-native imports — so the self-check runs under tsx:
//   npx tsx lib/family/status.ts

import { haversine, type LatLng } from '../nav/geo';
import { isZoneActive, type Geofence } from './geofence';
import { STALE_MS, type MemberPresence } from './types';

// ── freshness (spec §12) ──────────────────────────────────────────────
//
// LIVE      fresh fix, safe to call "now"          (≤ 90 s — the existing STALE_MS)
// RECENT    older but still usable                 (≤ 10 min)
// STALE     too old for live tracking; show "last known · Xm ago", never LIVE
// UNAVAILABLE no usable fix at all

export type Freshness = 'live' | 'recent' | 'stale' | 'unavailable';

export const LIVE_MS = STALE_MS;          // 90 s — one boundary, not two
export const RECENT_MS = 10 * 60_000;

export function freshnessOf(ts: number | null | undefined, now: number): Freshness {
  if (!ts || ts > now + 60_000) return 'unavailable'; // absent, zero, or a clock lying about the future
  const age = now - ts;
  if (age <= LIVE_MS) return 'live';
  if (age <= RECENT_MS) return 'recent';
  return 'stale';
}

// ── speed bands (spec §23) ────────────────────────────────────────────
//
// Central thresholds, km/h. Pings carry m/s (expo-location); convert once here
// so no screen re-invents the factor.

export const KMH_PER_MS = 3.6;
export const SPEED_BANDS = { stationaryMax: 10, normalMax: 40, highMax: 80 } as const;

export type SpeedBand = 'stationary' | 'normal' | 'high' | 'very_high';

/** Band for a speed in m/s. null in, null out — no speed is not 0 km/h. */
export function speedBand(spdMs: number | null | undefined): SpeedBand | null {
  if (spdMs == null || !isFinite(spdMs) || spdMs < 0) return null;
  const kmh = spdMs * KMH_PER_MS;
  if (kmh <= SPEED_BANDS.stationaryMax) return 'stationary';
  if (kmh <= SPEED_BANDS.normalMax) return 'normal';
  if (kmh <= SPEED_BANDS.highMax) return 'high';
  return 'very_high';
}

/**
 * High-speed alert decision (spec §24): over the threshold, respecting a
 * cooldown so one motorway drive is one alert, not one per ping.
 */
export function shouldSpeedAlert(
  spdMs: number | null | undefined,
  thresholdKmh: number,
  lastAlertAt: number | null,
  now: number,
  cooldownMs = 10 * 60_000,
): boolean {
  if (spdMs == null || !isFinite(spdMs)) return false;
  if (spdMs * KMH_PER_MS < thresholdKmh) return false;
  return lastAlertAt == null || now - lastAlertAt >= cooldownMs;
}

// ── derived member status (spec §14/§30/§31) ──────────────────────────
//
// Honesty rules, in order:
//  - no presence, or a stale/unavailable fix → 'unavailable'. Never a place.
//  - inside an ACTIVE saved place (schedule/expiry respected) → that place,
//    nearest wins on overlap. GPS accuracy widens nothing: the fence's own
//    radius is the contract, same as evaluateFences.
//  - clearly moving → 'traveling'.
//  - otherwise 'away' — sharing, somewhere we have no name for.

export type MemberStatus =
  | { kind: 'unavailable' }
  | { kind: 'at_place'; place: Geofence }
  | { kind: 'traveling' }
  | { kind: 'away' };

const TRAVELING_MIN_MPS = 3 / KMH_PER_MS * 3; // ~2.5 m/s ≈ 9 km/h; below city-driving, above walking-in-a-shop

export function statusOf(
  p: MemberPresence | null | undefined,
  places: Geofence[],
  now: number,
): MemberStatus {
  // Explicit sharing-off: the retained last-known fix must not claim a place
  // or a movement state, however fresh it still is.
  if (p?.sharingOff) return { kind: 'unavailable' };
  const fresh = p ? freshnessOf(p.ts, now) : 'unavailable';
  if (!p || fresh === 'stale' || fresh === 'unavailable') return { kind: 'unavailable' };

  let best: { place: Geofence; d: number } | null = null;
  const at = new Date(now);
  for (const f of places) {
    if (!isZoneActive(f, at)) continue;
    const d = haversine(p.pos, f.center);
    if (d <= f.radiusM && (!best || d < best.d)) best = { place: f, d };
  }
  if (best) return { kind: 'at_place', place: best.place };
  if ((p.speed ?? 0) >= TRAVELING_MIN_MPS) return { kind: 'traveling' };
  return { kind: 'away' };
}

/**
 * Fold one presence event into the per-member store. THE STORE IS KEYED BY
 * MEMBER ID, never by index, name or avatar — the classic multi-member bug is
 * markers swapping when someone joins or leaves, and stable keying is the
 * whole defence. A null presence removes exactly that member's entry and
 * touches nothing else. Pure, so the N-member visibility matrix
 * (visibility.selftest.ts) can prove independence deterministically.
 */
export function foldPresence(
  prev: Record<string, MemberPresence>,
  userId: string,
  presence: MemberPresence | null | undefined,
): Record<string, MemberPresence> {
  const next = { ...prev };
  if (presence) next[userId] = presence; else delete next[userId];
  return next;
}

/**
 * Mark a member as having EXPLICITLY stopped sharing, RETAINING their last
 * fix as "last known" (spec: never delete the last location; never show it
 * as LIVE). A member with no fix to retain simply stays absent — there is
 * nothing to keep and nothing to invent. Idempotent.
 */
export function markSharingOff(
  prev: Record<string, MemberPresence>,
  userId: string,
): Record<string, MemberPresence> {
  const cur = prev[userId];
  if (!cur || cur.sharingOff) return prev;
  return { ...prev, [userId]: { ...cur, sharingOff: true } };
}

/** Board totals for the dashboard (spec §14/§31). Pure fold over statusOf. */
export interface StatusBoard {
  total: number;
  sharing: number;       // presence with a live/recent fix
  unavailable: number;   // no usable fix: silence OR stale — "we cannot say where"
  traveling: number;
  away: number;
  /**
   * THE FIVE FRESHNESS BUCKETS PARTITION THE ROSTER: every member falls in
   * exactly one, and live + recent + stale + sharingOff + noLocation === total.
   * A board whose numbers add up to more than the family has people in it is
   * worse than no board — seen on device, where a 2-member circle showed four
   * chips summing to 4 because one person counted as both "Location off" and
   * "No location".
   *
   * `unavailable` is the UNION (stale + sharingOff + noLocation) and is kept
   * for callers asking "how many can I not place right now"; never render it
   * alongside its own parts.
   */
  live: number;
  recent: number;
  stale: number;
  /** Members who EXPLICITLY stopped sharing (last-known retained). */
  sharingOff: number;
  /** Silent for an unknown reason — no fix at all, and no stop was announced. */
  noLocation: number;
  /** place name → member count, insertion-ordered by `places`. */
  atPlace: Map<string, number>;
}

export function statusBoard(
  memberIds: string[],
  presences: Record<string, MemberPresence | undefined>,
  places: Geofence[],
  now: number,
): StatusBoard {
  const b: StatusBoard = {
    total: memberIds.length, sharing: 0, unavailable: 0,
    traveling: 0, away: 0, live: 0, recent: 0, stale: 0, sharingOff: 0,
    noLocation: 0, atPlace: new Map(),
  };
  const at = new Date(now);
  for (const f of places) if (isZoneActive(f, at)) b.atPlace.set(f.name, 0);
  for (const id of memberIds) {
    const p = presences[id];
    // Exactly one freshness bucket per member, in precedence order.
    // An explicit sharing-off outranks freshness: however new the retained
    // fix is, the member must never count as live/recent/sharing.
    if (p?.sharingOff) { b.sharingOff++; b.unavailable++; continue; }
    const tier = freshnessOf(p?.ts, now);
    if (tier === 'live') b.live++;
    else if (tier === 'recent') b.recent++;
    else if (tier === 'stale') b.stale++;
    else b.noLocation++;                    // silent, no stop announced
    const s = statusOf(p, places, now);
    if (s.kind === 'unavailable') { b.unavailable++; continue; }
    b.sharing++;
    if (s.kind === 'traveling') b.traveling++;
    else if (s.kind === 'away') b.away++;
    else b.atPlace.set(s.place.name, (b.atPlace.get(s.place.name) ?? 0) + 1);
  }
  return b;
}

// ── trip segmentation (spec §22) ──────────────────────────────────────
//
// Trips are re-derived from the device-local history store, never stored —
// same philosophy as the server's "computed on read cannot be stale" rule.
// A trip is a run of samples that keeps moving; it ends when the track goes
// quiet (long time gap, or a dwell: consecutive samples inside DWELL_RADIUS_M
// for ≥ DWELL_MS). The history store already thins to ≥25 m / ≥2 min between
// samples, so thresholds here are sized for that grid.

export interface TripStop { at: LatLng; fromTs: number; toTs: number }

export interface Trip {
  from: LatLng;
  to: LatLng;
  startTs: number;
  endTs: number;
  distanceM: number;
  durationMs: number;
  avgKmh: number;          // over moving time
  maxKmh: number | null;   // null when no sample carried a speed
  stops: TripStop[];       // pauses ≥ STOP_MS inside the trip
}

export const TRIP_GAP_MS = 20 * 60_000;   // silence that ends a trip
export const DWELL_MS = 8 * 60_000;       // sitting still this long ends a trip
export const DWELL_RADIUS_M = 60;
export const STOP_MS = 3 * 60_000;        // an in-trip pause worth reporting
export const MIN_TRIP_M = 300;            // below this it's GPS noise, not a trip

interface Sample { lat: number; lng: number; ts: number; spd?: number }

export function segmentTrips(samples: Sample[]): Trip[] {
  const pts = [...samples].sort((a, b) => a.ts - b.ts);
  const trips: Trip[] = [];
  let run: Sample[] = [];

  const flush = () => {
    if (run.length >= 2) {
      const t = tripOf(run);
      if (t.distanceM >= MIN_TRIP_M) trips.push(t);
    }
    run = [];
  };

  for (const s of pts) {
    const prev = run[run.length - 1];
    if (prev) {
      if (s.ts - prev.ts > TRIP_GAP_MS) flush();
      else {
        // Dwell check: how long has the tail been inside DWELL_RADIUS_M of here?
        let i = run.length - 1;
        while (i >= 0 && haversine(run[i], s) <= DWELL_RADIUS_M) i--;
        const dwellStart = run[i + 1];
        if (dwellStart && s.ts - dwellStart.ts >= DWELL_MS) {
          run = run.slice(0, i + 2); // the trip ends where the dwell began
          flush();
        }
      }
    }
    run.push(s);
  }
  flush();
  return trips;
}

function tripOf(run: Sample[]): Trip {
  let distanceM = 0;
  let maxMs: number | null = null;
  const stops: TripStop[] = [];
  for (let i = 1; i < run.length; i++) {
    distanceM += haversine(run[i - 1], run[i]);
    const spd = run[i].spd;
    if (spd != null && isFinite(spd)) maxMs = maxMs == null ? spd : Math.max(maxMs, spd);
    const dt = run[i].ts - run[i - 1].ts;
    if (dt >= STOP_MS && haversine(run[i - 1], run[i]) <= DWELL_RADIUS_M) {
      stops.push({ at: { lat: run[i - 1].lat, lng: run[i - 1].lng }, fromTs: run[i - 1].ts, toTs: run[i].ts });
    }
  }
  const durationMs = run[run.length - 1].ts - run[0].ts;
  const stopped = stops.reduce((a, s) => a + (s.toTs - s.fromTs), 0);
  const movingMs = Math.max(durationMs - stopped, 1);
  return {
    from: { lat: run[0].lat, lng: run[0].lng },
    to: { lat: run[run.length - 1].lat, lng: run[run.length - 1].lng },
    startTs: run[0].ts,
    endTs: run[run.length - 1].ts,
    distanceM,
    durationMs,
    avgKmh: (distanceM / 1000) / (movingMs / 3_600_000),
    maxKmh: maxMs == null ? null : maxMs * KMH_PER_MS,
    stops,
  };
}

// ── self-check ────────────────────────────────────────────────────────
if (require.main === module) {
  const now = 1_700_000_000_000;
  const fail = (m: string) => { throw new Error(m); };

  // freshness tiers, including the boundary and the absent cases
  if (freshnessOf(now - 5_000, now) !== 'live') fail('5s-old fix is live');
  if (freshnessOf(now - LIVE_MS, now) !== 'live') fail('exactly LIVE_MS is still live');
  if (freshnessOf(now - LIVE_MS - 1, now) !== 'recent') fail('past LIVE_MS is recent');
  if (freshnessOf(now - RECENT_MS - 1, now) !== 'stale') fail('past RECENT_MS is stale');
  if (freshnessOf(undefined, now) !== 'unavailable') fail('no ts is unavailable');
  if (freshnessOf(0, now) !== 'unavailable') fail('ts 0 is unavailable');
  if (freshnessOf(now + 120_000, now) !== 'unavailable') fail('a future fix is a lying clock, not LIVE');

  // speed bands: null in, null out; boundaries inclusive on the low side
  if (speedBand(null) !== null || speedBand(undefined) !== null) fail('no speed has no band');
  if (speedBand(-1) !== null) fail('negative speed has no band');
  if (speedBand(0) !== 'stationary') fail('0 is stationary');
  if (speedBand(10 / KMH_PER_MS) !== 'stationary') fail('10 km/h is stationary');
  if (speedBand(39 / KMH_PER_MS) !== 'normal') fail('39 km/h is normal');
  if (speedBand(79 / KMH_PER_MS) !== 'high') fail('79 km/h is high');
  if (speedBand(81 / KMH_PER_MS) !== 'very_high') fail('81 km/h is very high');

  // speed alert: threshold + cooldown, and "no speed" never alerts
  if (shouldSpeedAlert(null, 80, null, now)) fail('no speed must not alert');
  if (shouldSpeedAlert(70 / KMH_PER_MS, 80, null, now)) fail('under threshold must not alert');
  if (!shouldSpeedAlert(85 / KMH_PER_MS, 80, null, now)) fail('over threshold must alert');
  if (shouldSpeedAlert(85 / KMH_PER_MS, 80, now - 60_000, now)) fail('cooldown must hold');
  if (!shouldSpeedAlert(85 / KMH_PER_MS, 80, now - 11 * 60_000, now)) fail('cooldown must expire');

  // status: honesty first
  const home: Geofence = { id: 'h', name: 'Home', center: { lat: 12.97, lng: 77.59 }, radiusM: 100 };
  const school: Geofence = { id: 's', name: 'School', center: { lat: 12.98, lng: 77.60 }, radiusM: 150 };
  const pres = (over: Partial<MemberPresence>): MemberPresence => ({
    userId: 'u', pos: { lat: 0, lng: 0 }, ts: now, ...over,
  });
  if (statusOf(undefined, [home], now).kind !== 'unavailable') fail('no presence is unavailable');
  if (statusOf(pres({ ts: now - RECENT_MS - 1 }), [home], now).kind !== 'unavailable') {
    fail('a stale fix must not claim a place');
  }
  const atHome = statusOf(pres({ pos: home.center }), [home, school], now);
  if (atHome.kind !== 'at_place' || atHome.place.name !== 'Home') fail('inside Home is at Home');
  // a disabled fence must not claim anyone
  const off = statusOf(pres({ pos: home.center }), [{ ...home, enabled: false }], now);
  if (off.kind === 'at_place') fail('a disabled fence claims nobody');
  // overlap: nearest centre wins
  const both = statusOf(pres({ pos: home.center }), [{ ...school, radiusM: 5_000_000 }, home], now);
  if (both.kind !== 'at_place' || both.place.name !== 'Home') fail('nearest fence wins overlap');
  if (statusOf(pres({ pos: { lat: 13.1, lng: 77.7 }, speed: 15 }), [home], now).kind !== 'traveling') {
    fail('moving outside every fence is traveling');
  }
  if (statusOf(pres({ pos: { lat: 13.1, lng: 77.7 } }), [home], now).kind !== 'away') {
    fail('still, outside every fence, is away');
  }

  // board: loading-vs-zero honesty is the CALLER's job (it holds membersLoaded);
  // here every id must land in exactly one bucket.
  const board = statusBoard(
    ['a', 'b', 'c', 'd'],
    {
      a: pres({ pos: home.center }),
      b: pres({ pos: { lat: 13.1, lng: 77.7 }, speed: 15 }),
      c: pres({ ts: now - RECENT_MS - 1 }),
    },
    [home, school],
    now,
  );
  if (board.total !== 4) fail('board total');
  if (board.sharing !== 2) fail(`sharing should be 2, got ${board.sharing}`);
  if (board.unavailable !== 2) fail('c (stale) and d (absent) are unavailable');
  if (board.traveling !== 1) fail('b is traveling');
  if (board.atPlace.get('Home') !== 1) fail('a is at Home');
  if (board.atPlace.get('School') !== 0) fail('School is listed with zero, not missing');

  // sharing-off retention (Life360-style last known)
  let ps: Record<string, MemberPresence> = { a: pres({ pos: home.center }) };
  ps = markSharingOff(ps, 'a');
  if (!ps.a || !ps.a.sharingOff) fail('sharing-off must retain the entry, flagged');
  if (ps.a.pos.lat !== home.center.lat) fail('last-known coordinates must survive the stop');
  if (markSharingOff(ps, 'a') !== ps) fail('markSharingOff must be idempotent');
  if (markSharingOff(ps, 'ghost') !== ps) fail('no entry → nothing to retain, nothing invented');
  // a sharing-off member is never live/at-place, however fresh the fix
  if (statusOf(ps.a, [home], now).kind !== 'unavailable') fail('sharing-off must not claim a place');
  const b2 = statusBoard(['a', 'b'], ps, [home], now);
  if (b2.sharingOff !== 1) fail('board must count sharing-off');
  if (b2.live !== 0) fail('a fresh-but-stopped fix must not count live');
  if (b2.unavailable !== 2) fail('sharing-off + absent = 2 unavailable');
  // THE PARTITION INVARIANT. A 2-member circle once rendered four chips
  // summing to 4, because one member counted as BOTH "Location off" and
  // "No location". The five buckets must add up to exactly the roster.
  const parts = (x: typeof b2) => x.live + x.recent + x.stale + x.sharingOff + x.noLocation;
  if (parts(b2) !== b2.total) fail(`buckets must partition: ${parts(b2)} != ${b2.total}`);
  if (b2.noLocation !== 1) fail('the absent member is the only "no location"');
  if (b2.sharingOff + b2.noLocation !== b2.unavailable) fail('unavailable must be the union of its parts');
  // ...and across the mixed states, for a bigger roster
  const mixed = statusBoard(['a', 'b', 'c', 'd', 'e'], {
    a: pres({ pos: home.center }),                        // live
    b: pres({ ts: now - 5 * 60_000 }),                    // recent
    c: pres({ ts: now - 20 * 60_000 }),                   // stale
    d: { ...pres({}), sharingOff: true },                 // sharing off
  }, [home], now);                                        // e absent
  if (parts(mixed) !== 5) fail(`mixed buckets must partition 5: got ${parts(mixed)}`);
  if (mixed.live !== 1 || mixed.recent !== 1 || mixed.stale !== 1 || mixed.sharingOff !== 1 || mixed.noLocation !== 1) {
    fail('each mixed state must land in exactly one bucket');
  }
  // a FRESH fix clears the flag (re-enable → only new GPS becomes live)
  ps = foldPresence(ps, 'a', pres({ pos: home.center, ts: now + 1000 }));
  if (ps.a.sharingOff) fail('a fresh fix must clear sharing-off');
  if (statusBoard(['a'], ps, [], now).live !== 1) fail('fresh fix after re-enable is live');

  // trips: two drives separated by 30 min of silence; a 4-min stop inside the
  // first (a time gap between two samples ~11 m apart — the signature a thinned
  // history store actually records for "pulled over at a junction").
  const t0 = now;
  const leg = (lat: number, ts: number, spd = 8): Sample => ({ lat, lng: 77.5, ts, spd });
  const trip1: Sample[] = [
    leg(12.900, t0),
    leg(12.902, t0 + 1 * 60_000),
    leg(12.904, t0 + 2 * 60_000),
    leg(12.9041, t0 + 6 * 60_000, 0),  // 4 min later, ~11 m away → an in-trip stop
    leg(12.906, t0 + 7 * 60_000),
    leg(12.908, t0 + 8 * 60_000),
    leg(12.910, t0 + 9 * 60_000),
  ];
  const t1 = t0 + 9 * 60_000 + 30 * 60_000;
  const trip2: Sample[] = Array.from({ length: 5 }, (_, i) =>
    ({ lat: 12.95 + i * 0.002, lng: 77.52, ts: t1 + i * 60_000, spd: 10 }));
  const trips = segmentTrips([...trip1, ...trip2]);
  if (trips.length !== 2) fail(`expected 2 trips, got ${trips.length}`);
  if (trips[0].distanceM < 1000 || trips[0].distanceM > 1400) fail(`trip 1 distance off: ${trips[0].distanceM}`);
  if (trips[0].stops.length !== 1) fail(`trip 1 should have 1 stop, got ${trips[0].stops.length}`);
  if (trips[0].maxKmh == null || Math.round(trips[0].maxKmh) !== Math.round(8 * KMH_PER_MS)) fail('trip 1 max speed');
  if (trips[1].stops.length !== 0) fail('trip 2 has no stops');
  // avg speed uses MOVING time: 9 min total − 4 min stopped = 5 min moving
  if (trips[0].avgKmh < 10 || trips[0].avgKmh > 16) fail(`trip 1 avg over moving time off: ${trips[0].avgKmh}`);
  // no speeds → maxKmh null, never 0
  const silent = segmentTrips([
    { lat: 12.9, lng: 77.5, ts: t0 }, { lat: 12.92, lng: 77.5, ts: t0 + 5 * 60_000 },
  ]);
  if (silent.length !== 1 || silent[0].maxKmh !== null) fail('no speed data → maxKmh null');
  // a jitter-sized track is not a trip
  if (segmentTrips([
    { lat: 12.9, lng: 77.5, ts: t0 }, { lat: 12.9001, lng: 77.5, ts: t0 + 60_000 },
  ]).length !== 0) fail('GPS noise is not a trip');

  console.log('family/status self-check OK');
}
