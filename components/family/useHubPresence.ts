// components/family/useHubPresence.ts — the Family hub's presence wiring, moved
// out of app/family.tsx unchanged: subscribe to the circle (sealed relay + the
// location service), publish my own position across every space, re-arm on
// focus, the never-frozen refresh controller, and the foreground flag.

import React, { useEffect, useState } from 'react';
import { AppState } from 'react-native';
import { useFocusEffect } from 'expo-router';
import { setPresenceForeground, startPresence, stopPresence, subscribeCircle, type PresenceEvent } from '../../lib/family/presence';
import { subscribeSpaceLocations, fetchSpaceSnapshot } from '../../lib/location/live';
import { foldPoint, foldSealed, type Presences } from '../../lib/family/presenceFold';
import { startRefreshController } from '../../lib/family/refresh';
import { startEscalationTicker, stopEscalationTicker } from '../../lib/family/escalationService';
import { type GroupRef } from '../../lib/groups/store';

export function useHubPresence({ active, me, circles, share, onLocDenied }: {
  active: GroupRef | null;
  me: { id: string; name: string } | null;
  circles: GroupRef[];
  share: boolean;
  onLocDenied: (denied: boolean) => void;
}) {
  const [presences, setPresences] = useState<Presences>({});
  /** Bumped every time the screen regains focus — see the focus effect below
   *  for why presence needs that in its dependency list. */
  const [focusTick, setFocusTick] = useState(0);
  const circleIds = circles.map((c) => c.id).join(',');

  // presence (broadcast self + receive others) for the active circle
  useEffect(() => {
    if (!active || !me) return;
    let unsub: (() => void) | null = null, cancelled = false;
    setPresences({});
    (async () => {
      // SUBSCRIBE FIRST. Receiving other people's sealed positions needs no
      // permission of ours, so it must not sit behind anything that does — a
      // parent who declined location still has to see the bus.
      try {
        const u = await subscribeCircle(active.id, me.id, (e: PresenceEvent) => {
          if (cancelled) return;
          // Keyed by member id via the shared fold — independence of every
          // member's entry is proven by lib/family/visibility.selftest.ts.
          // A relay ping may be older than a platform fix already folded in,
          // so it merges rather than overwrites (newest fix per member wins).
          // A stop is an explicit choice: retain the last-known fix, flagged,
          // instead of deleting the member's dot (spec: last known location).
          setPresences((prev) => foldSealed(prev, e));
        });
        if (cancelled) u(); else unsub = u;
      } catch { /* the map degrades to "nobody live yet"; the space still works */ }

      // The dedicated location service (all-space platform): snapshot of the
      // newest server-stored point per authorized member + live events. This
      // is the path with NO chat-E2EE dependency — it works even when a
      // member pair's sender-key session is wedged — and it gives a late
      // joiner the catch-up the sealed relay never could. Same store, same
      // fold: whichever source is fresher per member wins.
      try {
        const u2 = await subscribeSpaceLocations(active.id, me.id, (e) => {
          if (cancelled) return;
          setPresences((prev) => foldPoint(prev, e));
        });
        if (cancelled) u2(); else { const prevUnsub = unsub; unsub = () => { prevUnsub?.(); u2(); }; }
      } catch { /* platform absent — the sealed relay path stands alone */ }

      // Then our own position, which is optional. requestPermission is only
      // true when sharing is already on — otherwise entering a space prompts
      // for a permission the screen does not use.
      try {
        // EVERY group, not just the one on screen. The engine underneath
        // (presence.ts + background.ts) was always multi-group — per-group
        // privacy gates each publish — but this call site handed it a
        // singleton, so a School or Employee space only ever received
        // positions while its map was the active tab HERE. Locked phone,
        // different tab, or a space-* screen: nothing published, which is
        // "space location does not share when locked" from the outside.
        // Active first so the visible group gets the first fix.
        const allIds = [active.id, ...circleIds.split(',').filter((id) => id && id !== active.id)];
        const res = await startPresence({
          circleIds: allIds, myId: me.id, myName: me.name, share,
          requestPermission: share,
          onSelf: (p) => setPresences((prev) => ({ ...prev, [p.userId]: p })),
        });
        if (!cancelled) onLocDenied(res.denied);
      } catch { if (!cancelled) onLocDenied(true); }

      // The escalation ladder runs on the requesting guardian's device only,
      // so it ticks wherever Family Space is open — a cold start settles any
      // ladder that came due while away (advance() collapses those).
      if (!cancelled) startEscalationTicker([active.id], me.id);
    })();
    return () => { cancelled = true; unsub?.(); stopPresence(); stopEscalationTicker(); };
  // `share` IS a dependency, and its absence was a real field bug: settings
  // load async, so a cold start ran this with share=false and never re-ran —
  // the switch showed ON, the self-dot worked (the watcher runs regardless),
  // but startPresence never began BROADCASTING and never delivered keys.
  // Verified server-side: a whole session with the switch on produced zero
  // key messages. The joined id list (circleIds) re-arms presence when a
  // space is adopted or leaves. Keyed on the ids, not on `active`/`me`
  // objects (fresh on every registry refresh) or the onLocDenied callback.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active?.id, me?.id, share, focusTick, circleIds]);

  /**
   * RE-ARM ON RETURN. The blur cleanup below stops the watcher, but the
   * presence effect above is keyed on [active.id, me.id, share] — none of
   * which change when the user simply comes BACK. So one visit to the map (or
   * any other screen) left the device permanently not sharing until the app
   * was restarted or the switch was toggled, with the switch still reading ON.
   *
   * Measured on the Honor: silent for 18 minutes with the switch on, then
   * publishing again 24 s after a cold start. It is also why family trips
   * never collected ETAs — only one phone was ever publishing.
   *
   * Bumping a counter on focus puts "we are back" into the effect's own
   * dependency list. startPresence already guards against overlapping calls
   * with its generation check, so the extra run on first focus is harmless.
   */
  useFocusEffect(React.useCallback(() => {
    setFocusTick((t) => t + 1);
    return () => { stopPresence(); };
  }, []));

  /**
   * FamilyMapRefreshController — the "never frozen" watchdog (spec §59/§60).
   *
   * Realtime stays the primary path; this only notices when it has quietly
   * stopped working (app resumed, screen unlocked, socket reconnected, network
   * came back, or nothing has arrived for too long) and re-fetches the
   * authoritative snapshot.
   *
   * It folds through the SAME mergePresence the live events use, so only
   * members whose fix actually changed move. The MapView is never remounted
   * and the camera is never reset — a reconcile the user can see is a bug.
   *
   * One controller, mounted once, torn down on unmount: stop() removes the
   * AppState, socket and NetInfo listeners plus the timer, so §100's
   * "exactly one subscription and one timer" holds across navigation.
   */
  const activeId = active?.id, myId = me?.id;
  useEffect(() => {
    if (!activeId || !myId) return;
    return startRefreshController({
      onReconcile: async () => {
        for (const e of await fetchSpaceSnapshot(activeId, myId)) {
          setPresences((prev) => foldPoint(prev, e));
        }
      },
    });
  }, [activeId, myId]);

  // Tell the adaptive engine whether anyone is looking. Foreground + moving is
  // the only situation that justifies a 5 s GPS cadence; everything else steps
  // down. AppState 'active' covers both app-switching and screen unlock.
  useEffect(() => {
    const sub = AppState.addEventListener('change', (s) => setPresenceForeground(s === 'active'));
    setPresenceForeground(AppState.currentState === 'active');
    return () => sub.remove();
  }, []);

  return { presences, setPresences };
}
