// lib/location/live.ts — the read side of the all-space location platform.
//
// One subscription per space: an initial GET /locations/latest snapshot, then
// `space_location` socket events keep it fresh; `space_location_stop` drops a
// member's marker. Falls back to nothing gracefully — a server without the
// platform (404) or an offline device simply yields no platform events, and
// the caller's E2EE relay presences (if any) stand alone.
//
// Events are folded into the SAME MemberPresence shape the family screens
// already render, keyed by member id, so the platform and the sealed relay
// merge in one store: whichever source has the FRESHER fix for a member wins.
//
// Pure merge logic is self-checked:  npx tsx lib/location/live.ts

import { type MemberPresence } from '../family/types';

export interface PlatformPoint {
  userId: string;
  lat: number;
  lng: number;
  ts: number;       // epoch ms
  spd?: number;
  acc?: number;
  bat?: number;
}

/** Newest fix per member wins, regardless of which source delivered it. */
export function mergePresence(
  prev: Record<string, MemberPresence>,
  p: PlatformPoint,
): Record<string, MemberPresence> {
  if (!p?.userId || !isFinite(p.lat) || !isFinite(p.lng) || !isFinite(p.ts)) return prev;
  const cur = prev[p.userId];
  if (cur && cur.ts >= p.ts) return prev; // an older fix never overwrites a newer one
  return {
    ...prev,
    [p.userId]: {
      userId: p.userId, pos: { lat: p.lat, lng: p.lng },
      speed: p.spd, accuracy: p.acc, battery: p.bat, ts: p.ts,
      // Reference distances ("1.2 km from Home") ride the sealed relay only —
      // the server has no reference places to send. The two paths carry the
      // SAME fix, so whichever arrives second would otherwise blank the ref
      // line, making it flicker as the sources race.
      //
      // Carried forward ONLY at an identical coordinate, which is precisely
      // that race. Any real movement drops them: a distance-from-Home computed
      // for where they used to be is a wrong number, and blank beats wrong.
      refs: cur && cur.pos.lat === p.lat && cur.pos.lng === p.lng ? cur.refs : undefined,
    },
  };
}

// ── runtime half ──────────────────────────────────────────────────────

// eslint-disable-next-line @typescript-eslint/no-require-imports
const apiMod = () => require('../api').api as (path: string, opts?: any) => Promise<any>;
// eslint-disable-next-line @typescript-eslint/no-require-imports
const socketMod = () => require('../socket') as typeof import('../socket');
// eslint-disable-next-line @typescript-eslint/no-require-imports
const historyMod = () => require('../family/history') as typeof import('../family/history');

export interface PlatformEvent {
  userId: string;
  point: MemberPresence | null;
  /** The member EXPLICITLY stopped sharing — retain their last-known, never
   *  render LIVE. Distinct from point:null (a bare clear). */
  sharingOff?: boolean;
}

/**
 * Fetch the authoritative snapshot ONCE, without subscribing to anything.
 *
 * This is what FamilyMapRefreshController calls to reconcile. It deliberately
 * does NOT re-subscribe: re-running subscribeSpaceLocations to "refresh" would
 * add a second set of socket listeners every time, which is precisely the
 * duplicate-subscription failure §100 exists to prevent, and the symptom would
 * be members' positions arriving two, then three, then four times over.
 *
 * Returns events for the caller to fold through the same mergePresence path as
 * live ones, so a reconcile updates only the members who actually changed —
 * never the whole map.
 *
 * Never throws: the endpoint may not be deployed (404) or the device may be
 * offline, and a failed reconcile must leave the existing state alone rather
 * than blank the screen.
 */
export async function fetchSpaceSnapshot(chatId: string, meId: string): Promise<PlatformEvent[]> {
  const out: PlatformEvent[] = [];
  try {
    const res = await apiMod()(`/chats/${encodeURIComponent(chatId)}/locations/latest`);
    for (const m of res?.members ?? []) {
      const p: PlatformPoint = {
        userId: String(m?.userId ?? ''), lat: Number(m?.lat), lng: Number(m?.lng),
        ts: Number(m?.ts), spd: m?.spd ?? undefined, acc: m?.acc ?? undefined, bat: m?.bat ?? undefined,
      };
      if (!p.userId || p.userId === String(meId) || !isFinite(p.lat) || !isFinite(p.lng) || !isFinite(p.ts)) continue;
      const pres: MemberPresence = {
        userId: p.userId, pos: { lat: p.lat, lng: p.lng },
        speed: p.spd, accuracy: p.acc, battery: p.bat, ts: p.ts,
      };
      out.push({ userId: p.userId, point: pres });
      if (m?.sharingEnabled === false) out.push({ userId: p.userId, point: null, sharingOff: true });
    }
  } catch { /* not deployed, or offline — the caller keeps what it has */ }
  return out;
}

/**
 * Subscribe to a space's server-side locations: snapshot + live events.
 * Own userId is excluded (self comes from the device's own watcher).
 * Returns an unsubscribe. Never throws — a failed snapshot only means the
 * stream starts empty.
 */
export async function subscribeSpaceLocations(
  chatId: string,
  meId: string,
  onEvent: (e: PlatformEvent) => void,
): Promise<() => void> {
  let disposed = false;

  /**
   * Record a platform point into the SAME device-local history the relay path
   * writes to (presence.ts recordSample).
   *
   * Without this the two paths disagree about the same person: the hub, which
   * reads live presences, showed "2m ago" while the member-detail screen,
   * which reads the history store, showed "Last known · 7h ago" — seen on a
   * real phone. History, Trips and the member timeline all read that store, so
   * a position the platform delivered would simply be missing from them.
   * recordSample throttles internally (≥25 m / ≥2 min), so this is cheap.
   */
  const remember = (p: MemberPresence) => {
    historyMod().recordSample(chatId, {
      u: p.userId, lat: p.pos.lat, lng: p.pos.lng, ts: p.ts,
      bat: p.battery, spd: p.speed, acc: p.accuracy,
    }).catch(() => {});
  };

  const toPresence = (m: any): MemberPresence | null => {
    const p: PlatformPoint = {
      userId: String(m?.userId ?? ''), lat: Number(m?.lat), lng: Number(m?.lng),
      ts: Number(m?.ts), spd: m?.spd ?? undefined, acc: m?.acc ?? undefined, bat: m?.bat ?? undefined,
    };
    if (!p.userId || !isFinite(p.lat) || !isFinite(p.lng) || !isFinite(p.ts)) return null;
    return { userId: p.userId, pos: { lat: p.lat, lng: p.lng }, speed: p.spd, accuracy: p.acc, battery: p.bat, ts: p.ts };
  };

  // Snapshot — the late-joiner catch-up the sealed relay never had. A member
  // whose sharingEnabled is EXPLICITLY false still yields their last-known
  // point, immediately flagged sharing-off: profile + "last seen", never LIVE.
  try {
    const res = await apiMod()(`/chats/${encodeURIComponent(chatId)}/locations/latest`);
    for (const m of res?.members ?? []) {
      if (disposed) break;
      const pres = toPresence(m);
      if (pres && pres.userId !== String(meId)) {
        onEvent({ userId: pres.userId, point: pres });
        remember(pres);
        if (m?.sharingEnabled === false) onEvent({ userId: pres.userId, point: null, sharingOff: true });
      }
    }
  } catch { /* endpoint absent (not deployed) or offline — live events may still arrive */ }

  let offUpd = () => {};
  let offStop = () => {};
  try {
    const s = await socketMod().getSocket();
    const onUpd = (e: any) => {
      if (disposed || String(e?.chatId) !== String(chatId)) return;
      const uid = String(e?.userId ?? '');
      if (!uid || uid === String(meId)) return;
      // Gated space families send coordinate-free "fresh data exists" events;
      // only coordinate-carrying events fold directly.
      const pres = toPresence(e);
      if (pres) { onEvent({ userId: uid, point: pres }); remember(pres); }
    };
    const onStop = (e: any) => {
      if (disposed || String(e?.chatId) !== String(chatId)) return;
      const uid = String(e?.userId ?? '');
      // A stop is an EXPLICIT choice — retain last-known, flag the reason.
      if (uid && uid !== String(meId)) onEvent({ userId: uid, point: null, sharingOff: true });
    };
    const onSharing = (e: any) => {
      if (disposed || String(e?.chatId) !== String(chatId)) return;
      const uid = String(e?.userId ?? '');
      if (!uid || uid === String(meId)) return;
      // sharing=false → last-known state now. sharing=true → nothing yet:
      // only a FRESH fix (the next space_location event) may become LIVE.
      if (e?.sharing === false) onEvent({ userId: uid, point: null, sharingOff: true });
    };
    s.on('space_location', onUpd);
    s.on('space_location_stop', onStop);
    s.on('space_location_sharing', onSharing);
    offUpd = () => s.off('space_location', onUpd);
    offStop = () => { s.off('space_location_stop', onStop); s.off('space_location_sharing', onSharing); };
  } catch { /* socket unavailable — snapshot-only */ }

  return () => { disposed = true; offUpd(); offStop(); };
}

// ── self-check ────────────────────────────────────────────────────────
if (require.main === module) {
  const fail = (m: string) => { throw new Error(m); };
  const P = (uid: string, ts: number, lat = 10): PlatformPoint => ({ userId: uid, lat, lng: 70, ts });

  let s: Record<string, MemberPresence> = {};
  s = mergePresence(s, P('a', 100));
  s = mergePresence(s, P('b', 200));
  if (Object.keys(s).length !== 2) fail('two members expected');

  // newer wins, older never overwrites — regardless of source order
  s = mergePresence(s, P('a', 300, 11));
  if (s.a.ts !== 300 || s.a.pos.lat !== 11) fail('newer fix must win');
  s = mergePresence(s, P('a', 250, 99));
  if (s.a.ts !== 300 || s.a.pos.lat === 99) fail('older fix must never overwrite');

  // identity: b untouched by a's updates (same guarantee as foldPresence)
  if (s.b.ts !== 200) fail('unrelated member disturbed');

  // garbage refused
  if (mergePresence(s, { userId: '', lat: 1, lng: 1, ts: 1 }) !== s) fail('empty uid accepted');
  if (mergePresence(s, P('c', NaN)) !== s) fail('NaN ts accepted');

  // refs: the platform carries none, so the same fix arriving twice must not
  // blank the ref line — but a MOVED member must not keep a stale distance.
  let r: Record<string, MemberPresence> = {
    d: { userId: 'd', pos: { lat: 10, lng: 70 }, ts: 100, refs: [{ n: 'Home', d: 1200 }] },
  };
  const same = mergePresence(r, P('d', 150, 10));           // identical coordinate, newer ts
  if (same.d.refs?.[0]?.d !== 1200) fail('same-position merge must keep refs');
  const moved = mergePresence(r, P('d', 150, 11));          // actually moved
  if (moved.d.refs !== undefined) fail('a moved member must not keep a stale ref distance');

  console.log('location/live self-check OK');
}
