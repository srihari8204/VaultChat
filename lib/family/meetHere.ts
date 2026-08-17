// lib/family/meetHere.ts — Meet Here and Family Center, the arithmetic half.
//
// Pure — no react-native imports — so the self-check runs under tsx:
//   npx tsx lib/family/meetHere.ts
//
// The one rule this module exists to enforce: STRAIGHT-LINE AND ROAD DISTANCE
// ARE NEVER INTERCHANGEABLE (spec §8). Every member here carries both, in
// separate fields, and the road figures are present ONLY when routing actually
// returned them. A member the router could not reach keeps their straight-line
// distance and reports no ETA — an estimate is never synthesised from crow-flies
// distance and an assumed speed, because a number that looks like an ETA will be
// read as one, and "18 min" that came from a guess is worse than a blank.

import { haversine, type LatLng } from '../nav/geo';
import { type MatrixResult } from '../nav/routing';
import { type MemberInput } from './distance';

/** One member measured against the meeting destination. */
export interface MeetRow {
  id: string;
  name: string;
  /** Crow-flies metres. Always present when the member has a usable position. */
  straightM: number | null;
  /** Road metres. Present only when routing returned a figure for them. */
  roadM: number | null;
  /** Seconds by road. Present only alongside roadM. */
  etaS: number | null;
  self?: boolean;
}

/**
 * Arrival state (spec §69). Deliberately text, never colour alone — every
 * caller renders the label, and the colour is decoration on top of it.
 *
 * `unknown` is a first-class answer, not a failure: a member with no fix has an
 * unknown arrival state, and calling that "on the way" would be an invention.
 */
export type ArrivalStatus = 'arrived' | 'nearby' | 'onTheWay' | 'unknown';

export const ARRIVAL_LABEL: Record<ArrivalStatus, string> = {
  arrived: 'Arrived',
  nearby: 'Nearby',
  onTheWay: 'On the way',
  unknown: 'Location unavailable',
};

/** Inside this many metres of the destination counts as arrived. */
export const ARRIVED_M = 150;
/** Inside this many metres counts as nearby (but not yet arrived). */
export const NEARBY_M = 500;

/**
 * Arrival state from the best distance available.
 *
 * Uses STRAIGHT-LINE distance on purpose, even when a road distance exists:
 * standing in the restaurant's car park is 20 m away as the crow flies but can
 * be 600 m by road around a one-way system, and "On the way" for someone who
 * has visibly arrived is the more annoying error.
 */
export function arrivalOf(straightM: number | null): ArrivalStatus {
  if (straightM == null || !Number.isFinite(straightM)) return 'unknown';
  if (straightM <= ARRIVED_M) return 'arrived';
  if (straightM <= NEARBY_M) return 'nearby';
  return 'onTheWay';
}

/**
 * Build the Meet Here table: every member, against one destination.
 *
 * EVERY member appears, including those with no position (spec §41 — all ten
 * must be listed). They carry nulls rather than being dropped, so the UI can
 * say "location unavailable" instead of quietly showing nine of ten.
 *
 * `matrix` is matched by INDEX into `members`, which is exactly how
 * fetchMatrix returns it — a missing index means the router had no answer for
 * that member and their road fields stay null.
 */
export function meetRows(
  members: MemberInput[],
  destination: LatLng,
  matrix?: MatrixResult[] | null,
): MeetRow[] {
  const byIndex = new Map((matrix ?? []).map((r) => [r.index, r]));
  return members.map((m, i) => {
    const usable = !!m.pos && !m.unavailable;
    const road = byIndex.get(i);
    return {
      id: m.id,
      name: m.name,
      straightM: usable ? Math.round(haversine(m.pos!, destination)) : null,
      // Road figures only survive with a usable position: a stale matrix row
      // for someone who has since gone dark would otherwise outlive the fix it
      // was computed from.
      roadM: usable && road ? road.distanceM : null,
      etaS: usable && road ? road.durationS : null,
      self: m.self,
    };
  });
}

export interface MeetSummary {
  nearest: MeetRow | null;
  farthest: MeetRow | null;
  /** Longest ETA among members routing could reach. Null if none were. */
  longestEta: MeetRow | null;
  /** Seconds until the LAST arrival — when the family is actually assembled. */
  familyArrivalS: number | null;
  /** Members with a usable position (may still lack an ETA). */
  located: number;
  /** Members routing produced an ETA for. */
  routed: number;
  total: number;
}

/**
 * Summarise the meeting (spec §42).
 *
 * `familyArrivalS` is the MAXIMUM eta, not the mean: the family is assembled
 * when the last person walks in. An average would answer a question nobody
 * asked and would consistently understate the wait.
 *
 * It is null unless EVERY located member has an ETA — a "family arrival" that
 * silently ignores the three people routing could not reach is a promise the
 * data does not support.
 */
export function meetSummary(rows: MeetRow[]): MeetSummary {
  const others = rows.filter((r) => !r.self);
  const located = others.filter((r) => r.straightM != null);
  const routed = others.filter((r) => r.etaS != null);
  const byStraight = [...located].sort((a, b) => a.straightM! - b.straightM!);
  const byEta = [...routed].sort((a, b) => a.etaS! - b.etaS!);
  return {
    nearest: byStraight[0] ?? null,
    farthest: byStraight[byStraight.length - 1] ?? null,
    longestEta: byEta[byEta.length - 1] ?? null,
    familyArrivalS: routed.length > 0 && routed.length === located.length
      ? byEta[byEta.length - 1].etaS
      : null,
    located: located.length,
    routed: routed.length,
    total: rows.length,
  };
}

/**
 * Family Center (spec §43): a balanced point to meet at.
 *
 * The centroid of the located members, minimising the WORST travel distance
 * rather than the average — the point of a family meeting place is that nobody
 * is stuck with an hour's drive, not that the total is small.
 *
 * Straight-line only, and honestly labelled as such: this returns an AREA to
 * search near, not a venue. Turning it into a real suggestion means running the
 * search around this point, which is the caller's job.
 *
 * Self is INCLUDED here — unlike the distance summary, you are one of the
 * people who has to travel to the meeting.
 */
export function familyCenter(members: MemberInput[]): { center: LatLng; worstM: number; count: number } | null {
  const pts = members.filter((m) => m.pos && !m.unavailable).map((m) => m.pos!);
  if (pts.length < 2) return null;

  // Start at the plain centroid, then take a few Weiszfeld-style steps toward
  // the point that minimises the worst distance. Twenty iterations on ≤10
  // points is microseconds and converges far past display precision.
  //
  // ponytail: fixed-iteration descent, not a proper 1-centre solver. Exact
  // minimax (Welzl) is worth it only if someone measures the difference — at
  // family scale it is metres.
  let best: LatLng = {
    lat: pts.reduce((a, p) => a + p.lat, 0) / pts.length,
    lng: pts.reduce((a, p) => a + p.lng, 0) / pts.length,
  };
  const worst = (c: LatLng) => pts.reduce((mx, p) => Math.max(mx, haversine(c, p)), 0);
  let bestWorst = worst(best);
  let step = 0.02;                       // degrees, ~2 km — shrinks each round
  for (let i = 0; i < 20; i++) {
    let improved = false;
    for (const [dLat, dLng] of [[step, 0], [-step, 0], [0, step], [0, -step]]) {
      const cand = { lat: best.lat + dLat, lng: best.lng + dLng };
      const w = worst(cand);
      if (w < bestWorst) { best = cand; bestWorst = w; improved = true; }
    }
    if (!improved) step /= 2;
  }
  return { center: best, worstM: Math.round(bestWorst), count: pts.length };
}

/** "7 min", "1 h 12 min" — durations, never distances. */
export function formatEta(seconds: number | null | undefined): string {
  if (seconds == null || !Number.isFinite(seconds) || seconds < 0) return '—';
  const min = Math.max(1, Math.round(seconds / 60));
  return min < 60 ? `${min} min` : `${Math.floor(min / 60)} h ${min % 60} min`;
}

// ── self-check: `npx tsx lib/family/meetHere.ts` ───────────────────────────
declare const require: any; declare const module: any;
if (typeof require !== 'undefined' && require.main === module) {
  const A = (c: boolean, m: string) => { if (!c) throw new Error('meetHere: ' + m); };
  const DEST: LatLng = { lat: 17.385, lng: 78.4867 };
  const at = (dLat: number): LatLng => ({ lat: DEST.lat + dLat, lng: DEST.lng });

  const members: MemberInput[] = [
    { id: 'me', name: 'You', pos: at(0.02), self: true },
    { id: 'mom', name: 'Mother', pos: at(0.001) },        // ~110 m — arrived
    { id: 'sis', name: 'Sister', pos: at(0.003) },        // ~333 m — nearby
    { id: 'dad', name: 'Father', pos: at(0.05) },         // ~5.5 km — on the way
    { id: 'gone', name: 'Uncle', pos: null, unavailable: true },
  ];

  // 1. every member appears, including the one with no position
  const noRoute = meetRows(members, DEST);
  A(noRoute.length === 5, 'all five members must be listed, spec §41');
  A(noRoute[4].straightM === null && noRoute[4].etaS === null, 'an unlocatable member carries nulls');
  A(noRoute.every((r) => r.roadM === null), 'no matrix → no road distance may be invented');

  // 2. arrival bands
  A(arrivalOf(noRoute[1].straightM) === 'arrived', 'inside 150 m is arrived');
  A(arrivalOf(noRoute[2].straightM) === 'nearby', 'inside 500 m is nearby');
  A(arrivalOf(noRoute[3].straightM) === 'onTheWay', 'kilometres away is on the way');
  A(arrivalOf(null) === 'unknown', 'no position is unknown, never on-the-way');
  A(ARRIVAL_LABEL.unknown.length > 0, 'every status needs a text label, §70');

  // 3. matrix folds in BY INDEX, and a missing row leaves nulls — not zeros
  const matrix: MatrixResult[] = [
    { index: 0, distanceM: 6000, durationS: 900 },
    { index: 1, distanceM: 200, durationS: 120 },
    { index: 3, distanceM: 7000, durationS: 1200 },
    // index 2 (Sister) unreachable; index 4 has no position at all
  ];
  const rows = meetRows(members, DEST, matrix);
  A(rows[1].roadM === 200 && rows[1].etaS === 120, 'matrix must map by index');
  A(rows[2].roadM === null && rows[2].etaS === null, 'an unrouted member gets nulls, not zero');
  A(rows[2].straightM !== null, 'losing an ETA must not lose the straight-line distance');
  A(rows[4].roadM === null, 'a member with no position cannot have a road distance');

  // 4. summary — self excluded from the extremes, they are one of the travellers
  //    only for Family Center
  const s = meetSummary(rows);
  A(s.nearest!.id === 'mom' && s.farthest!.id === 'dad', 'meet extremes wrong');
  A(s.located === 3 && s.total === 5, `located/total: ${s.located}/${s.total}`);
  A(s.routed === 2, `routed should count only members with an ETA: ${s.routed}`);
  // Sister is located but unrouted, so a family arrival cannot be claimed.
  A(s.familyArrivalS === null, 'family arrival must not ignore members routing missed');

  const full = meetRows(members, DEST, [...matrix, { index: 2, distanceM: 400, durationS: 300 }]);
  const sf = meetSummary(full);
  A(sf.familyArrivalS === 1200, `family arrival is the LAST arrival: ${sf.familyArrivalS}`);
  A(sf.longestEta!.id === 'dad', 'longest ETA member wrong');

  // 5. family centre sits between people and reports the worst distance
  const fc = familyCenter(members)!;
  A(fc.count === 4, `centre should use the four located members, got ${fc.count}`);
  A(fc.worstM > 0, 'a real spread has a non-zero worst distance');
  const centroidWorst = (() => {
    const pts = members.filter((m) => m.pos).map((m) => m.pos!);
    const c = { lat: pts.reduce((a, p) => a + p.lat, 0) / pts.length, lng: pts.reduce((a, p) => a + p.lng, 0) / pts.length };
    return pts.reduce((mx, p) => Math.max(mx, haversine(c, p)), 0);
  })();
  A(fc.worstM <= Math.round(centroidWorst) + 1, 'the search must not be WORSE than the plain centroid');
  A(familyCenter([members[0]]) === null, 'one person has no meeting point');
  A(familyCenter([]) === null, 'nobody has no meeting point');

  // 6. ETA formatting is a duration and never looks like a distance
  A(formatEta(420) === '7 min' && formatEta(4320) === '1 h 12 min', `eta format: ${formatEta(4320)}`);
  A(formatEta(null) === '—' && formatEta(-5) === '—', 'unknown eta must not render as 0 min');
  A(formatEta(20) === '1 min', 'sub-minute rounds up, never to "0 min"');

  console.log('family/meetHere self-check: OK');
}

export default {};
