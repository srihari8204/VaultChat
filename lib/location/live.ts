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
    },
  };
}

// ── runtime half ──────────────────────────────────────────────────────

// eslint-disable-next-line @typescript-eslint/no-require-imports
const apiMod = () => require('../api').api as (path: string, opts?: any) => Promise<any>;
// eslint-disable-next-line @typescript-eslint/no-require-imports
const socketMod = () => require('../socket') as typeof import('../socket');

export interface PlatformEvent {
  userId: string;
  point: MemberPresence | null;
  /** The member EXPLICITLY stopped sharing — retain their last-known, never
   *  render LIVE. Distinct from point:null (a bare clear). */
  sharingOff?: boolean;
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
      if (pres) onEvent({ userId: uid, point: pres });
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

  console.log('location/live self-check OK');
}
