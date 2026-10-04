// components/family/useHubFeeds.ts — the Family hub's side feeds, moved out of
// app/family.tsx unchanged: the live trip, today's highlights with the pinned
// announcement, the space's runs, and the server-made relation labels. Each
// is keyed on the active space's id, so a registry refresh that hands the hub
// a fresh `active` object re-fetches nothing.

import { useEffect, useState } from 'react';
import { getMessages, decryptFromChat, isAnnouncement } from '../../lib/chatService';
import { subscribeTrip, joinTrip, currentTrip } from '../../lib/groups/tripSession';
import { type Trip, type TripPing } from '../../lib/groups/trips';
import { getRuns } from '../../lib/spaces/api';
import { type Run as SpaceRun } from '../../lib/spaces/runs';
import { getRelations, type RelationMap } from '../../lib/family/relations';

export interface Highlight { icon: string; text: string; at: number }

// Family Space message prefixes — used to pick highlights out of the circle chat.
const HIGHLIGHT_RE = /^(🆘|✅|🚗|⏳)/;

/**
 * Watch for a live trip in the active group. Subscribing here rather than
 * only inside the trip screen is the whole point of 5.7: a convoy that is
 * already moving should be visible without going looking for it.
 */
export function useHubTrip(activeId: string | undefined, myId: string | undefined) {
  const [trip, setTrip] = useState<Trip | null>(null);
  const [tripPings, setTripPings] = useState<TripPing[]>([]);
  useEffect(() => {
    if (!activeId || !myId) { setTrip(null); setTripPings([]); return; }
    let live = true;
    let off: (() => void) | null = null;
    setTrip(currentTrip());
    setTripPings([]);
    (async () => {
      const unsub = await subscribeTrip(
        activeId, myId,
        (e) => {
          if (!live) return;
          setTripPings((prev) => (e.ping
            ? [...prev.filter((p) => p.userId !== e.userId), e.ping]
            : prev.filter((p) => p.userId !== e.userId)));
        },
        // null = ended or expired — the card must clear, not linger forever.
        (t) => {
          if (!live) return;
          if (t === null) { setTrip(null); setTripPings([]); return; }
          setTrip((cur) => cur ?? t);
          // AUTO-JOIN: a family trip is for the whole circle, so every
          // member's device adopts it and starts reporting its own DERIVED
          // ETA on the next fix — no joining ceremony. The position itself
          // never rides the trip channel.
          if (!currentTrip()) joinTrip(t, myId).catch(() => {});
        },
      ).catch(() => null);
      if (live && unsub) off = unsub; else unsub?.();
    })();
    return () => { live = false; off?.(); };
  }, [activeId, myId]);
  return { trip, tripPings };
}

/** Today's highlights — recent check-ins / SOS decrypted from the circle chat —
 *  and the most recent announcement, pinned to the dashboard. `bump` re-pulls
 *  after we send something. */
export function useHubHighlights(activeId: string | undefined, bump: number) {
  const [highlights, setHighlights] = useState<Highlight[]>([]);
  const [announcement, setAnnouncement] = useState<{ text: string; at: number } | null>(null);
  useEffect(() => {
    if (!activeId) return;
    let dead = false;
    (async () => {
      try {
        const msgs = await getMessages(activeId, { limit: 30 });
        const out: Highlight[] = [];
        // Announcements are identified from meta, so finding the latest costs
        // no extra request and no decryption of unrelated messages.
        let latest: { text: string; at: number } | null = null;
        for (const m of msgs) {
          if (!m.deletedAt && m.content && isAnnouncement(m)) {
            const at = new Date(m.createdAt).getTime();
            if (!latest || at > latest.at) {
              try { latest = { text: await decryptFromChat(activeId, m.senderId, m.content, m.id), at }; } catch {}
            }
          }
        }
        if (!dead) setAnnouncement(latest);
        for (const m of msgs) {
          if (m.deletedAt || !m.content || (m.type !== 'text' && m.type !== 'system')) continue;
          let t = '';
          try { t = await decryptFromChat(activeId, m.senderId, m.content, m.id); } catch { continue; }
          if (!HIGHLIGHT_RE.test(t)) continue;
          const icon = [...t][0] ?? '•';
          out.push({ icon, text: t.slice(icon.length).trim(), at: new Date(m.createdAt).getTime() });
        }
        out.sort((a, b) => b.at - a.at);
        if (!dead) setHighlights(out.slice(0, 5));
      } catch {}
    })();
    return () => { dead = true; };
  }, [activeId, bump]);
  return { highlights, announcement };
}

/**
 * Runs this caller may see in this space (Spaces & Operations, S3.1/S3.4).
 * The SERVER decides what is in this list: ops sees the timetable, a driver
 * sees their own runs, a guardian sees the runs their linked riders are on.
 * Nothing here filters it further. `wanted` is the caller's gate (an
 * operational space, or an ops/driver permission) — a Family group has no
 * runs, and a 200 with an empty array on every dashboard open is a request
 * nobody needed.
 */
export function useHubRuns(activeId: string | undefined, wanted: boolean) {
  const [runs, setRuns] = useState<SpaceRun[]>([]);
  useEffect(() => {
    if (!activeId || !wanted) { setRuns([]); return; }
    let live = true;
    getRuns(activeId, true)
      .then((r) => { if (live) setRuns(r || []); })
      // Silent: an operations card that failed to load must not interrupt a
      // dashboard whose other half is working.
      .catch(() => { if (live) setRuns([]); });
    return () => { live = false; };
  }, [activeId, wanted]);
  return runs;
}

/**
 * Relations ("Mother", "Father") arrive READY from the server, keyed by
 * member id and already scoped to me as the viewer — the app looks one up
 * while rendering a row and computes nothing. A failure leaves the map empty
 * and the roster renders plain names, exactly as it did before this existed.
 */
export function useHubRelations(activeId: string | undefined) {
  const [relations, setRelations] = useState<RelationMap>({});
  useEffect(() => {
    if (!activeId) { setRelations({}); return; }
    let live = true;
    getRelations(activeId).then((r) => { if (live) setRelations(r); });
    return () => { live = false; };
  }, [activeId]);
  return relations;
}
