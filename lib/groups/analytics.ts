// lib/groups/analytics.ts — group insights (Groups & Circles, G6).
//
// EVERYTHING HERE IS COMPUTED AND SHOWN ON THIS DEVICE. The inputs are the
// local track store and the local alert inbox — data this phone already holds
// because it decrypted it. Nothing is uploaded, not even an aggregate. A
// "weekly summary" that quietly posted totals to a server would break the
// server-blind invariant just as surely as uploading the positions would, and
// would be much easier to miss in review.
//
// HONEST ABOUT PRECISION: distance is an ESTIMATE. lib/family/history.ts
// deliberately throttles samples (no closer than 25 m apart, heartbeat every
// two minutes), so summing the gaps UNDERSTATES real travel — a winding road
// between two samples reads as a straight line. It is a useful comparative
// number, not an odometer, and the UI says so rather than implying precision it
// does not have.
//
// Pure — no react-native imports — so the self-check runs under tsx:
//   npx tsx lib/groups/analytics.ts

import { haversine } from '../nav/geo';

/** A recorded position, matching lib/family/history.ts TrackSample. */
export interface Sample {
  u: string;
  lat: number;
  lng: number;
  ts: number;
  spd?: number;
}

/** An alert, matching the shape lib/family/alerts.ts stores. */
export interface AlertLike {
  kind: string;
  actorId: string;
  at: number;
}

export interface Range { from: number; to: number }

export interface MemberInsight {
  userId: string;
  /** Estimated metres travelled in range. */
  distanceM: number;
  /** Fastest observed speed, m/s. */
  maxSpeed: number;
  /** Distinct local days with at least one recorded position. */
  activeDays: number;
  /** Arrivals at any safe zone in range — the attendance signal. */
  arrivals: number;
  /** Check-ins sent in range. */
  checkIns: number;
  /** Times they left the expected route on a group trip. */
  deviations: number;
  /** Last moment we have any record of them. */
  lastSeen: number | null;
}

/** Local midnight for an instant. */
export function startOfDay(ts: number): number {
  const d = new Date(ts); d.setHours(0, 0, 0, 0); return d.getTime();
}

/**
 * Bounds of the local week containing ts, MONDAY-first.
 *
 * Monday rather than Sunday because "this week" for a school run or an office
 * rota means the working week. getDay() is Sunday-based, hence the shift.
 */
export function weekBounds(ts: number): Range {
  const d = new Date(startOfDay(ts));
  const shift = (d.getDay() + 6) % 7;   // Mon=0 … Sun=6
  d.setDate(d.getDate() - shift);
  const end = new Date(d.getTime());
  end.setDate(end.getDate() + 7);
  return { from: d.getTime(), to: end.getTime() - 1 };
}

export function inRange(ts: number, r: Range): boolean {
  return ts >= r.from && ts <= r.to;
}

/**
 * Estimated distance for one member's samples.
 *
 * Sorts before summing: history can be appended out of order when a background
 * fix lands late, and summing unsorted points would zig-zag back and forth and
 * inflate the total dramatically.
 *
 * A gap longer than MAX_GAP_MS is NOT bridged — if a phone was off for six
 * hours, the straight line between where it stopped and where it resumed is not
 * distance anyone travelled in a way we can claim to have observed.
 */
export const MAX_GAP_MS = 30 * 60_000;

export function distanceOf(samples: Sample[]): number {
  if (samples.length < 2) return 0;
  const sorted = [...samples].sort((a, b) => a.ts - b.ts);
  let total = 0;
  for (let i = 1; i < sorted.length; i++) {
    const a = sorted[i - 1], b = sorted[i];
    if (b.ts - a.ts > MAX_GAP_MS) continue;   // unobserved gap: do not invent it
    total += haversine({ lat: a.lat, lng: a.lng }, { lat: b.lat, lng: b.lng });
  }
  return Math.round(total);
}

/** Distinct local days represented in a sample set. */
export function activeDaysOf(samples: Sample[]): number {
  const days = new Set<number>();
  for (const s of samples) days.add(startOfDay(s.ts));
  return days.size;
}

/**
 * Roll the local stores into one insight per member.
 *
 * Members with no data still get a row, with zeros. Dropping them would make a
 * quiet member look like they had left the group, which is exactly the wrong
 * impression for a safety product to give.
 */
export function summarise(
  memberIds: string[],
  samples: Sample[],
  alerts: AlertLike[],
  range: Range,
): MemberInsight[] {
  const byMember = new Map<string, Sample[]>();
  for (const s of samples) {
    if (!inRange(s.ts, range)) continue;
    const arr = byMember.get(s.u);
    if (arr) arr.push(s); else byMember.set(s.u, [s]);
  }

  const counts = new Map<string, { arrivals: number; checkIns: number; deviations: number; last: number }>();
  for (const a of alerts) {
    if (!inRange(a.at, range)) continue;
    const c = counts.get(a.actorId) ?? { arrivals: 0, checkIns: 0, deviations: 0, last: 0 };
    if (a.kind === 'enter') c.arrivals++;
    else if (a.kind === 'checkin') c.checkIns++;
    else if (a.kind === 'deviation') c.deviations++;
    if (a.at > c.last) c.last = a.at;
    counts.set(a.actorId, c);
  }

  return memberIds.map((id) => {
    const mine = byMember.get(id) ?? [];
    const c = counts.get(id);
    let maxSpeed = 0, lastSample = 0;
    for (const s of mine) {
      if (s.spd != null && s.spd > maxSpeed) maxSpeed = s.spd;
      if (s.ts > lastSample) lastSample = s.ts;
    }
    const last = Math.max(lastSample, c?.last ?? 0);
    return {
      userId: id,
      distanceM: distanceOf(mine),
      maxSpeed,
      activeDays: activeDaysOf(mine),
      arrivals: c?.arrivals ?? 0,
      checkIns: c?.checkIns ?? 0,
      deviations: c?.deviations ?? 0,
      lastSeen: last > 0 ? last : null,
    };
  });
}

export interface GroupSummary {
  distanceM: number;
  arrivals: number;
  checkIns: number;
  deviations: number;
  /** Members with any activity at all in range. */
  activeMembers: number;
  busiest: MemberInsight | null;
}

/** Roll per-member insights into the one-line group picture. */
// ── shared trip history (G6.3) ──────────────────────────────────────
//
// Derived, not stored. Every trip already announces itself as an E2EE message
// in the group thread, and arrivals already land in the local alert inbox — so
// history is a FOLD over data this phone holds, exactly like tasks. A separate
// trips table would mean new storage, new sync and a new thing to keep private,
// to record something already recorded twice.

/** One trip the group took. */
export interface TripRecord {
  id: string;
  destinationName: string;
  startedBy: string;
  startedAt: number;
  leaderId: string | null;
  /** Who reached it, and when. */
  arrivals: { userId: string; at: number }[];
  /** How many times somebody left the route on this trip. */
  deviations: number;
}

/** The announce fields history needs. Matches the trip message payload. */
export interface TripAnnounce {
  id: string;
  destinationName: string;
  startedBy: string;
  startedAt: number;
  leaderId?: string | null;
}

/**
 * Fold trip announcements and alerts into a history, newest first.
 *
 * Attribution is by `tripId` on the alert, never by matching its text: that
 * string is rendered for humans and is reworded whenever the copy changes,
 * which would break history silently and at a distance.
 *
 * A duplicate announcement — the same trip re-read from history on every
 * subscribe — must not produce two entries, so trips are keyed by id.
 */
export function foldTripHistory(
  announces: TripAnnounce[],
  alerts: AlertLike[],
  range: Range,
): TripRecord[] {
  const byId = new Map<string, TripRecord>();
  for (const a of announces) {
    if (!a?.id || a.startedAt < range.from || a.startedAt > range.to) continue;
    if (byId.has(a.id)) continue;
    byId.set(a.id, {
      id: a.id,
      destinationName: a.destinationName || 'Somewhere',
      startedBy: a.startedBy,
      startedAt: a.startedAt,
      leaderId: a.leaderId ?? null,
      arrivals: [],
      deviations: 0,
    });
  }

  for (const al of alerts) {
    const tripId = (al as AlertLike & { tripId?: string }).tripId;
    if (!tripId) continue;             // not a trip alert, or predates tripId
    const t = byId.get(tripId);
    if (!t) continue;                  // an alert for a trip outside this range
    if (al.kind === 'enter') {
      // One arrival per person: a re-delivered alert must not inflate the count.
      if (!t.arrivals.some((x) => x.userId === al.actorId)) {
        t.arrivals.push({ userId: al.actorId, at: al.at });
      }
    } else if (al.kind === 'deviation') {
      t.deviations += 1;
    }
  }

  return [...byId.values()].sort((a, b) => b.startedAt - a.startedAt);
}

/** Distinct destinations visited, most frequent first. */
export function frequentDestinations(trips: TripRecord[], top = 5): { name: string; count: number }[] {
  const counts = new Map<string, number>();
  for (const t of trips) counts.set(t.destinationName, (counts.get(t.destinationName) ?? 0) + 1);
  return [...counts.entries()]
    .map(([name, count]) => ({ name, count }))
    // Ties broken by name so the list is stable rather than reshuffling on
    // every render.
    .sort((a, b) => b.count - a.count || (a.name < b.name ? -1 : 1))
    .slice(0, top);
}

export function groupSummary(insights: MemberInsight[]): GroupSummary {
  let distanceM = 0, arrivals = 0, checkIns = 0, deviations = 0, activeMembers = 0;
  let busiest: MemberInsight | null = null;
  for (const i of insights) {
    distanceM += i.distanceM;
    arrivals += i.arrivals;
    checkIns += i.checkIns;
    deviations += i.deviations;
    if (i.activeDays > 0 || i.arrivals > 0 || i.checkIns > 0) activeMembers++;
    // Ties resolve by userId so the "busiest" does not flicker between equals
    // on every refresh.
    if (!busiest || i.distanceM > busiest.distanceM ||
        (i.distanceM === busiest.distanceM && i.userId < busiest.userId)) {
      busiest = i;
    }
  }
  // Nobody moved: naming a "busiest" member from a field of zeros is noise.
  if (busiest && busiest.distanceM === 0) busiest = null;
  return { distanceM, arrivals, checkIns, deviations, activeMembers, busiest };
}

/** Human distance. Estimates, so no false precision below a kilometre. */
export function formatDistance(m: number): string {
  if (m < 1000) return `${Math.round(m / 50) * 50} m`;
  return `${(m / 1000).toFixed(m < 10_000 ? 1 : 0)} km`;
}

// ── self-check ──
if (require.main === module) {
  const day = (d: number, h = 12) => new Date(2026, 2, d, h, 0, 0, 0).getTime();
  // 2026-03-04 is a Wednesday.
  const wed = day(4);

  // 1. weeks run Monday to Sunday
  const wb = weekBounds(wed);
  if (new Date(wb.from).getDay() !== 1) throw new Error('week should start on Monday');
  if (new Date(wb.from).getDate() !== 2) throw new Error('Wed 4 Mar 2026 belongs to the week starting Mon 2nd');
  if (wb.to - wb.from !== 7 * 86_400_000 - 1) throw new Error('a week should span 7 days');
  // Sunday belongs to the week that STARTED the previous Monday
  const sun = day(8);
  if (weekBounds(sun).from !== wb.from) throw new Error('Sunday belongs to the preceding Monday-week');
  if (weekBounds(day(9)).from === wb.from) throw new Error('the next Monday starts a new week');

  // 2. distance sums consecutive points — 0.0045 deg lat is ~500 m
  const line: Sample[] = [
    { u: 'a', lat: 12.9716, lng: 77.5946, ts: wed },
    { u: 'a', lat: 12.9761, lng: 77.5946, ts: wed + 60_000 },
    { u: 'a', lat: 12.9806, lng: 77.5946, ts: wed + 120_000 },
  ];
  const d = distanceOf(line);
  if (Math.abs(d - 1000) > 60) throw new Error('two 500m hops should total ~1000m, got ' + d);

  // 3. OUT-OF-ORDER samples must not inflate the total — history appends late
  //    when a background fix lands after a foreground one.
  const shuffled = [line[2], line[0], line[1]];
  if (distanceOf(shuffled) !== d) throw new Error('unsorted input must give the same distance');

  // 4. a long gap is NOT bridged: a phone that was off for hours did not
  //    observably travel the straight line between the two points.
  const gapped: Sample[] = [
    { u: 'a', lat: 12.9716, lng: 77.5946, ts: wed },
    { u: 'a', lat: 13.5000, lng: 77.5946, ts: wed + 6 * 3600_000 },
  ];
  if (distanceOf(gapped) !== 0) throw new Error('an unobserved gap must not count as distance');
  if (distanceOf([line[0]]) !== 0) throw new Error('one point is no distance');
  if (distanceOf([]) !== 0) throw new Error('no points is no distance');

  // 5. active days counts distinct local days
  if (activeDaysOf([
    { u: 'a', lat: 1, lng: 1, ts: day(2, 9) },
    { u: 'a', lat: 1, lng: 1, ts: day(2, 18) },
    { u: 'a', lat: 1, lng: 1, ts: day(3, 9) },
  ]) !== 2) throw new Error('two calendar days');

  // 6. summarise: quiet members still get a row
  const range = weekBounds(wed);
  const out = summarise(['a', 'quiet'], line, [
    { kind: 'enter', actorId: 'a', at: wed },
    { kind: 'enter', actorId: 'a', at: wed + 1000 },
    { kind: 'checkin', actorId: 'a', at: wed + 2000 },
    { kind: 'deviation', actorId: 'a', at: wed + 3000 },
    { kind: 'battery', actorId: 'a', at: wed + 4000 },   // not counted anywhere
    { kind: 'enter', actorId: 'a', at: range.to + 999_999 }, // out of range
  ], range);
  const A = out.find((x) => x.userId === 'a')!;
  const Q = out.find((x) => x.userId === 'quiet')!;
  if (out.length !== 2) throw new Error('every member gets a row');
  if (Q.distanceM !== 0 || Q.lastSeen !== null) throw new Error('a quiet member should read as zero, not vanish');
  if (A.arrivals !== 2) throw new Error('arrivals should count enter events in range: ' + A.arrivals);
  if (A.checkIns !== 1 || A.deviations !== 1) throw new Error('check-ins and deviations should count');
  if (A.activeDays !== 1) throw new Error('one day of samples');
  if (A.lastSeen == null) throw new Error('lastSeen should be set');

  // 7. samples outside the range are excluded
  const narrow = summarise(['a'], line, [], { from: wed + 90_000, to: wed + 200_000 });
  if (narrow[0].activeDays !== 1 || narrow[0].distanceM !== 0) {
    throw new Error('only one sample falls in that window, so no distance');
  }

  // 8. group rollup
  const g = groupSummary(out);
  if (g.arrivals !== 2 || g.checkIns !== 1 || g.deviations !== 1) throw new Error('rollup counts wrong');
  if (g.activeMembers !== 1) throw new Error('only one member was active');
  if (g.busiest?.userId !== 'a') throw new Error('busiest should be the one who moved');
  // …and a field of zeros names nobody
  if (groupSummary([{ ...Q }, { ...Q, userId: 'z' }]).busiest !== null) {
    throw new Error('nobody moved, so there is no busiest member');
  }
  if (groupSummary([]).distanceM !== 0) throw new Error('empty rollup');

  // 9. formatting avoids false precision
  if (formatDistance(120) !== '100 m') throw new Error('sub-km rounds to 50m: ' + formatDistance(120));
  if (formatDistance(1500) !== '1.5 km') throw new Error('km with one decimal');
  if (formatDistance(42_000) !== '42 km') throw new Error('large distances drop the decimal');

  // ── trip history ──
  const tr = (id: string, at: number, extra: Partial<TripAnnounce> = {}): TripAnnounce =>
    ({ id, destinationName: 'Beach', startedBy: 'u1', startedAt: at, ...extra });
  const week: Range = { from: wed, to: wed + 7 * 86_400_000 };
  const trAlert = (kind: string, actorId: string, at: number, tripId?: string): AlertLike =>
    ({ kind, actorId, at, ...(tripId ? { tripId } : {}) } as AlertLike);

  const hist = foldTripHistory(
    [tr('t1', wed + 1000), tr('t2', wed + 5000, { destinationName: 'School' })],
    [
      trAlert('enter', 'u1', wed + 2000, 't1'),
      trAlert('enter', 'u2', wed + 2500, 't1'),
      trAlert('deviation', 'u2', wed + 1500, 't1'),
      trAlert('enter', 'u9', wed + 3000),            // no tripId: a geofence arrival
      trAlert('enter', 'u1', wed + 4000, 'unknown'), // a trip outside this range
    ],
    week,
  );
  if (hist.length !== 2) throw new Error(`expected 2 trips, got ${hist.length}`);
  if (hist[0].id !== 't2') throw new Error('history must be newest first');
  const t1 = hist.find((h) => h.id === 't1')!;
  if (t1.arrivals.length !== 2) throw new Error('both arrivals should attach to their trip');
  if (t1.deviations !== 1) throw new Error('deviation should attach to its trip');

  // a geofence arrival with no tripId must never be counted as a trip arrival
  if (hist.some((h) => h.arrivals.some((a) => a.userId === 'u9'))) {
    throw new Error('a non-trip alert must not be attributed to a trip');
  }

  // duplicate announcements (re-read from history on every subscribe) collapse
  if (foldTripHistory([tr('t1', wed + 1000), tr('t1', wed + 1000)], [], week).length !== 1) {
    throw new Error('a duplicate announcement must not create a second trip');
  }
  // …and a re-delivered arrival does not inflate the count
  const dupArr = foldTripHistory([tr('t1', wed + 1000)],
    [trAlert('enter', 'u1', wed + 2000, 't1'), trAlert('enter', 'u1', wed + 2100, 't1')], week);
  if (dupArr[0].arrivals.length !== 1) throw new Error('one arrival per person');

  // range is honoured on the trip's start
  if (foldTripHistory([tr('old', wed - 1)], [], week).length !== 0) throw new Error('out-of-range trip must be dropped');

  // frequent destinations, stable under ties
  const freq = frequentDestinations(foldTripHistory(
    [tr('a', wed + 1), tr('b', wed + 2), tr('c', wed + 3, { destinationName: 'School' })], [], week));
  if (freq[0].name !== 'Beach' || freq[0].count !== 2) throw new Error('most frequent destination wrong');
  const tie = frequentDestinations(foldTripHistory(
    [tr('a', wed + 1, { destinationName: 'Zoo' }), tr('b', wed + 2, { destinationName: 'Aquarium' })], [], week));
  if (tie[0].name !== 'Aquarium') throw new Error('ties must break by name so the list is stable');

  console.log('groups/analytics self-check OK');
}
