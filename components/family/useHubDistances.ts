// components/family/useHubDistances.ts — the Family hub's distance layer, moved
// out of app/family.tsx (spec §7–12, §34–39): every member's distance from me
// or from one of MY saved places, upgraded to ROAD metres by one coarse
// /nav/matrix call, plus the summary and the roster order.

import { useEffect, useMemo, useRef, useState } from 'react';
import { freshnessOf } from '../../lib/family/status';
import { memberLabel, type RelationMap } from '../../lib/family/relations';
import {
  memberDistances, mergeRoadDistances, summarize, sortMembers, type SortMode,
} from '../../lib/family/distance';
import { fetchMatrix } from '../../lib/nav/routing';
import { type Geofence } from '../../lib/family/geofence';
import { type CircleMember, type MemberPresence } from '../../lib/family/types';

/** ~110 m: below this nothing on screen moves, and the routing server need not see more. */
const coarse = (n: number) => Math.round(n * 1000) / 1000;

export function useHubDistances({ presences, members, myId, tick, originName, places, relations, sortMode }: {
  presences: Record<string, MemberPresence>;
  members: CircleMember[];
  myId: string | null;
  /** The hub's visibility tick — freshness decays without new data. */
  tick: number;
  originName: string | null;
  places: Geofence[];
  relations: RelationMap;
  sortMode: SortMode;
}) {
  /**
   * Every member's straight-line distance from me, plus the family summary.
   *
   * Computed HERE, on the viewing device, from presences this device already
   * decrypted — not on the server. That is a deliberate exception to the
   * thin-client rule: on the sealed relay the server never sees a coordinate,
   * so it could not compute these even if we asked it to.
   *
   * A member with no usable fix gets fromMe: null, never zero — counting the
   * unlocatable as "0 km away" would make the summary claim the family is
   * closer together than it is.
   */
  const distanceInputs = useMemo(() => {
    const now = Date.now();
    const mineNow = myId ? presences[myId] : undefined;
    // The origin every distance is measured from: my own position by default,
    // or one of MY saved places when one is picked ("how far is everyone from
    // Home"). A picked place that has since been deleted falls back to me
    // rather than silently measuring from nowhere.
    const origin = originName
      ? (places.find((p) => p.name === originName)?.center ?? mineNow?.pos ?? null)
      : (mineNow?.pos ?? null);
    const rows = members.map((m) => {
      const p = presences[m.id];
      const usable = !!p && freshnessOf(p.ts, now) !== 'unavailable';
      return {
        id: m.id,
        // The relation LEADS when set — "Mother · Arun" identifies a person on
        // a family map faster than a display name does. Server-supplied, so
        // this is a lookup, not a computation.
        name: m.id === myId ? 'You' : memberLabel(m.name, relations[m.id]),
        pos: usable ? p.pos : null,
        refs: p?.sharingOff ? null : p?.refs,
        ts: p?.ts,
        // Measuring from a PLACE makes me an ordinary traveller to it — my own
        // distance from Home is exactly the number being asked for. Measuring
        // from myself keeps me excluded, since "You are 0 km from You" is noise.
        self: m.id === myId && !originName,
        unavailable: !usable,
      };
    });
    return { rows, origin };
  // `tick` re-derives freshness when no new ping arrives; it is read through
  // Date.now(), not as a value.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [presences, members, myId, tick, originName, places, relations]);

  const straightRows = useMemo(
    () => memberDistances(distanceInputs.rows, distanceInputs.origin),
    [distanceInputs]);

  /**
   * ROAD distance for the list, layered over the straight line.
   *
   * "4 km away" meaning four kilometres of driving is a more useful claim than
   * four kilometres of open air — a member across a river reads as close and
   * is not. /nav/matrix answers all members in ONE call (it is what Meet Here
   * already runs on), so this costs one request per refresh, not one per
   * member.
   *
   * Keyed on the ROUNDED positions, not on `presences`: a fix arrives every
   * few seconds and jitters by metres, and re-routing the whole family for a
   * 3-metre wobble would spend a request per tick to change nothing on screen.
   *
   * Geofences and published reference distances are deliberately NOT routed —
   * see mergeRoadDistances for why converting either would be a bug.
   */
  const [roadM, setRoadM] = useState<Record<string, number>>({});
  const roadKey = useMemo(() => {
    const o = distanceInputs.origin;
    if (!o) return '';
    const q = (n: number) => n.toFixed(3);   // ~110m: below this nothing on screen moves
    const parts = distanceInputs.rows
      .filter((r) => r.pos && !r.self && !r.unavailable)
      .map((r) => `${r.id}:${q(r.pos!.lat)},${q(r.pos!.lng)}`)
      .sort();
    return parts.length ? `${q(o.lat)},${q(o.lng)}|${parts.join('|')}` : '';
  }, [distanceInputs]);
  // The effect runs on the KEY alone; the inputs it reads are the ones that
  // produced that key, held here so a new ping with the same rounded
  // positions does not re-route.
  const inputsRef = useRef(distanceInputs);
  inputsRef.current = distanceInputs;

  useEffect(() => {
    if (!roadKey) { setRoadM({}); return; }
    const { origin, rows } = inputsRef.current;
    if (!origin) return;
    const targets = rows.filter((r) => r.pos && !r.self && !r.unavailable);
    if (!targets.length) return;
    let cancel = false;
    (async () => {
      try {
        // Same coarseness as the live map (~110 m): a road distance needs no more,
        // and the routing server need not see anyone's exact position.
        const res = await fetchMatrix(
          targets.map((t) => ({ lat: coarse(t.pos!.lat), lng: coarse(t.pos!.lng) })),
          { lat: coarse(origin.lat), lng: coarse(origin.lng) }, 'auto');
        if (cancel) return;
        const next: Record<string, number> = {};
        for (const r of res) {
          const t = targets[r.index];
          if (t) next[t.id] = r.distanceM;
        }
        setRoadM(next);
      } catch {
        // Router unavailable: the straight-line numbers already on screen stand.
        if (!cancel) setRoadM({});
      }
    })();
    return () => { cancel = true; };
  }, [roadKey]);

  const distanceRows = useMemo(
    () => mergeRoadDistances(straightRows, roadM), [straightRows, roadM]);

  const summary = useMemo(() => summarize(distanceRows), [distanceRows]);
  /**
   * Is there anyone at all we could measure — INCLUDING me?
   *
   * The origin chips are gated on this rather than on the summary's `available`,
   * which deliberately excludes self. Gating on `available` was a chicken-and-egg
   * bug: in a circle where I am the only member with a fix, available is 0, so
   * the chips stayed hidden, so I could never switch the origin to Home — the
   * one case where my own distance IS the answer being asked for.
   */
  const anyoneLocatable = useMemo(
    () => distanceRows.some((r) => r.fromMe != null) || (!!myId && !!presences[myId]),
    [distanceRows, myId, presences],
  );
  /** Member ids in the chosen order, for the roster to follow. */
  const sortedIds = useMemo(
    () => sortMembers(distanceRows, sortMode).map((r) => r.id),
    [distanceRows, sortMode],
  );

  return { roadM, summary, anyoneLocatable, sortedIds };
}
