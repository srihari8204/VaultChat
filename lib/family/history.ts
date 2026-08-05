// lib/family/history.ts — device-local Family Space location history.
//
// Trust boundary: history NEVER leaves the device and is never uploaded. It is
// built purely from positions this device already holds in the clear — my own
// fixes, plus circle members' pings that presence.ts has already decrypted. The
// server has no history endpoint and gains no new visibility from this file.
//
// At rest the payload goes through cacheCrypto.encField (same DEK as the message
// cache). If the DEK is not loaded, encField passes through and we store plain —
// exactly the behaviour of the rest of the local cache, so history is never LESS
// protected than the messages it was derived from.
//
// Volume control: a sample is only appended when the subject has actually moved
// (>= MIN_MOVE_M) or enough time has passed (>= MIN_GAP_MS). Without that a
// stationary phone at a 8s cadence would write ~10k rows a day per member.
//
// Pure helpers (pruneSamples / shouldRecord / summarize) are exported and
// self-checked: `npx tsx lib/family/history.ts`.

// NOTE: AsyncStorage and cacheCrypto are lazy-required inside read()/write()
// rather than imported at the top, so this module's pure half (shouldRecord /
// pruneSamples / summarize) stays free of the react-native graph and the
// self-check below remains runnable under tsx. Same pattern as lib/nav/routing.ts.
import { haversine } from '../nav/geo';

// eslint-disable-next-line @typescript-eslint/no-require-imports
const storage = () => require('@react-native-async-storage/async-storage').default;
// eslint-disable-next-line @typescript-eslint/no-require-imports
const crypt = () => require('../cacheCrypto') as typeof import('../cacheCrypto');

/** One recorded position for one member. Kept short — this is the bulk of the store. */
export interface TrackSample {
  u: string;      // userId
  lat: number;
  lng: number;
  ts: number;     // epoch ms of the fix
  bat?: number;   // battery 0..100 at the fix
  spd?: number;   // m/s
  acc?: number;   // GPS accuracy m (optional; older samples lack it)
}

export const RETENTION_MS = 31 * 24 * 3600 * 1000;  // Day/Week/Month views need 31d
export const MAX_SAMPLES = 4000;                    // per circle, hard cap
export const MIN_MOVE_M = 25;                       // below this we treat it as "parked"
export const MIN_GAP_MS = 120_000;                  // …but still record a heartbeat every 2 min

const kHist = (cid: string) => `vc_family_hist_${cid}`;

/** Should this fix be appended, given the last one we kept for that member? */
export function shouldRecord(prev: TrackSample | undefined, next: TrackSample): boolean {
  if (!prev) return true;
  if (next.ts - prev.ts >= MIN_GAP_MS) return true;
  return haversine({ lat: prev.lat, lng: prev.lng }, { lat: next.lat, lng: next.lng }) >= MIN_MOVE_M;
}

/** Drop anything older than the retention window, then cap to the newest MAX_SAMPLES. */
export function pruneSamples(samples: TrackSample[], now: number): TrackSample[] {
  const cutoff = now - RETENTION_MS;
  const live = samples.filter((s) => s.ts >= cutoff);
  return live.length > MAX_SAMPLES ? live.slice(live.length - MAX_SAMPLES) : live;
}

async function read(circleId: string): Promise<TrackSample[]> {
  try {
    const raw = await storage().getItem(kHist(circleId));
    if (!raw) return [];
    const json = crypt().decField(raw);
    const parsed = json ? JSON.parse(json) : null;
    return Array.isArray(parsed?.s) ? parsed.s as TrackSample[] : [];
  } catch { return []; }
}

async function write(circleId: string, samples: TrackSample[]): Promise<void> {
  try {
    const sealed = crypt().encField(JSON.stringify({ v: 1, s: samples }));
    if (sealed != null) await storage().setItem(kHist(circleId), sealed);
  } catch { /* history is best-effort — never break a location update over it */ }
}

// Last kept sample per (circle,user) so shouldRecord() doesn't need a read per fix.
const lastKept = new Map<string, TrackSample>();
const lk = (cid: string, uid: string) => `${cid}|${uid}`;

/**
 * Append a fix to a circle's history if it clears the movement/time threshold.
 * Returns true when it was actually stored. Safe to call on every GPS tick.
 */
export async function recordSample(circleId: string, s: TrackSample): Promise<boolean> {
  const key = lk(circleId, s.u);
  if (!shouldRecord(lastKept.get(key), s)) return false;
  lastKept.set(key, s);
  const all = await read(circleId);
  all.push(s);
  await write(circleId, pruneSamples(all, s.ts));
  return true;
}

/** All samples for a circle in [from, to], oldest first. Optionally one member. */
export async function getTrack(
  circleId: string,
  opts: { from: number; to?: number; userId?: string },
): Promise<TrackSample[]> {
  const to = opts.to ?? Date.now();
  const all = await read(circleId);
  return all
    .filter((s) => s.ts >= opts.from && s.ts <= to && (!opts.userId || s.u === opts.userId))
    .sort((a, b) => a.ts - b.ts);
}

export interface TrackSummary {
  distanceM: number;    // total path length
  maxSpeed: number;     // m/s
  first: number | null; // ts of first sample
  last: number | null;  // ts of last sample
  points: number;
}

/** Roll a (time-ordered) sample list into the numbers the history screen shows. */
export function summarize(samples: TrackSample[]): TrackSummary {
  if (!samples.length) return { distanceM: 0, maxSpeed: 0, first: null, last: null, points: 0 };
  let distanceM = 0, maxSpeed = 0;
  for (let i = 1; i < samples.length; i++) {
    const a = samples[i - 1], b = samples[i];
    distanceM += haversine({ lat: a.lat, lng: a.lng }, { lat: b.lat, lng: b.lng });
    if (b.spd != null && b.spd > maxSpeed) maxSpeed = b.spd;
  }
  if (samples[0].spd != null && samples[0].spd > maxSpeed) maxSpeed = samples[0].spd;
  return {
    distanceM: Math.round(distanceM),
    maxSpeed,
    first: samples[0].ts,
    last: samples[samples.length - 1].ts,
    points: samples.length,
  };
}

export interface PlaceTime {
  timeMs: number;        // time spent inside the place across the sample window
  visits: number;        // outside→inside transitions
  firstArrival: number | null;  // ts of the first arrival in the window
}

/**
 * Time-at-place from a (time-ordered) track (v3 family statistics). A gap
 * between samples longer than `maxGapMs` contributes nothing — pings pausing
 * (app killed, sharing off) must not count as "5 hours at Home". Pure; uses
 * the same haversine the geofence and lock engines use.
 */
export function timeAtPlace(
  samples: TrackSample[],
  place: { center: { lat: number; lng: number }; radiusM: number },
  maxGapMs = 5 * 60_000,
): PlaceTime {
  let timeMs = 0, visits = 0, firstArrival: number | null = null;
  let prevIn = false, prevTs = 0;
  for (const s of samples) {
    const inside = haversine({ lat: s.lat, lng: s.lng }, place.center) <= place.radiusM;
    if (inside && !prevIn) { visits++; if (firstArrival == null) firstArrival = s.ts; }
    if (inside && prevIn && prevTs) {
      const dt = s.ts - prevTs;
      if (dt > 0 && dt <= maxGapMs) timeMs += dt;
    }
    prevIn = inside;
    prevTs = s.ts;
  }
  return { timeMs, visits, firstArrival };
}

/** Forget a circle's history (called when a circle is left/deleted). */
export async function clearHistory(circleId: string): Promise<void> {
  for (const k of [...lastKept.keys()]) if (k.startsWith(`${circleId}|`)) lastKept.delete(k);
  try { await storage().removeItem(kHist(circleId)); } catch {}
}

/** Reset the in-memory throttle (used by tests and when presence restarts). */
export function resetThrottle(): void { lastKept.clear(); }

// ── self-check ──
if (require.main === module) {
  const base = { u: 'a', lat: 12.9716, lng: 77.5946 };
  const t0 = 1_700_000_000_000;

  // 1. first sample always records
  if (!shouldRecord(undefined, { ...base, ts: t0 })) throw new Error('first sample must record');
  // 2. a 5 m nudge 10 s later is noise → skip
  if (shouldRecord({ ...base, ts: t0 }, { ...base, lat: 12.97164, ts: t0 + 10_000 })) {
    throw new Error('5m/10s should be throttled');
  }
  // 3. same spot but 3 min later → heartbeat records
  if (!shouldRecord({ ...base, ts: t0 }, { ...base, ts: t0 + 180_000 })) {
    throw new Error('2min heartbeat must record');
  }
  // 4. real movement records immediately
  if (!shouldRecord({ ...base, ts: t0 }, { ...base, lat: 12.9750, ts: t0 + 5_000 })) {
    throw new Error('380m move must record');
  }

  // 5. retention prunes old, cap keeps the NEWEST
  const old = { ...base, ts: t0 - RETENTION_MS - 1 };
  const fresh = { ...base, ts: t0 };
  if (pruneSamples([old, fresh], t0).length !== 1) throw new Error('retention should drop the old sample');
  const many = Array.from({ length: MAX_SAMPLES + 50 }, (_, i) => ({ ...base, ts: t0 - (MAX_SAMPLES + 50 - i) * 1000 }));
  const capped = pruneSamples(many, t0);
  if (capped.length !== MAX_SAMPLES) throw new Error('cap not applied: ' + capped.length);
  if (capped[capped.length - 1].ts !== many[many.length - 1].ts) throw new Error('cap must keep the newest');

  // 6. summarize: 2 points ~500 m apart (0.0045 deg lat ≈ 500 m)
  const sum = summarize([{ ...base, ts: t0 }, { ...base, lat: base.lat + 0.0045, ts: t0 + 60_000, spd: 12 }]);
  if (sum.points !== 2 || sum.maxSpeed !== 12) throw new Error('summarize fields wrong: ' + JSON.stringify(sum));
  if (Math.abs(sum.distanceM - 500) > 30) throw new Error('distance off: ' + sum.distanceM);
  if (summarize([]).distanceM !== 0) throw new Error('empty summarize must be zero');

  // 7. timeAtPlace: in→out→in counts 2 visits, sums only in-place spans, and a
  //    long ping gap contributes nothing
  const home = { center: { lat: base.lat, lng: base.lng }, radiusM: 100 };
  const far = base.lat + 0.01;                                   // ~1.1 km away
  const tp = timeAtPlace([
    { ...base, ts: t0 },                                          // inside (visit 1)
    { ...base, ts: t0 + 60_000 },                                 // inside +60s
    { ...base, lat: far, ts: t0 + 120_000 },                      // outside
    { ...base, ts: t0 + 180_000 },                                // inside (visit 2)
    { ...base, ts: t0 + 240_000 },                                // inside +60s
    { ...base, ts: t0 + 240_000 + 20 * 60_000 },                  // inside, but 20 min gap → ignored
  ], home);
  if (tp.visits !== 2) throw new Error('timeAtPlace visits: ' + tp.visits);
  if (tp.timeMs !== 120_000) throw new Error('timeAtPlace ms: ' + tp.timeMs);
  if (tp.firstArrival !== t0) throw new Error('timeAtPlace firstArrival');
  if (timeAtPlace([], home).visits !== 0) throw new Error('empty timeAtPlace');

  console.log('family/history self-check OK');
}
