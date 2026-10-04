// lib/family/useVisibleTick.ts — a repeating re-render that STOPS when nobody
// is looking at the screen.
//
// The family screens tick every 30 s so "LIVE" decays into "5 min ago" without
// a new ping arriving. That tick is worth paying for while someone is reading
// the screen and worth nothing at all once the app is in the background: it
// wakes the JS thread and re-renders a whole screen — roster, summary, markers
// — that no one can see. Two screens did exactly that, indefinitely, for as
// long as the app stayed resident.
//
// What this does NOT touch: the location publisher. presence.ts's keepalive and
// the background task must keep running when backgrounded — that is the entire
// point of background sharing. This is about REDRAWING, not about reporting.
//
// On returning to the foreground it ticks IMMEDIATELY rather than waiting out
// the interval, because the first thing a returning user looks at is exactly
// the freshness text that went stale while they were away.

import { useEffect, useState } from 'react';
import { AppState } from 'react-native';

/** The tick count and the wall-clock time it was taken at (one timer for
 *  screens that need both, e.g. the hub's markers and its child hooks). */
export function useVisibleClock(ms: number): { tick: number; now: number } {
  const [clock, setClock] = useState(() => ({ tick: 0, now: Date.now() }));

  useEffect(() => {
    let timer: ReturnType<typeof setInterval> | null = null;

    const stop = () => { if (timer) { clearInterval(timer); timer = null; } };
    const start = () => {
      stop();
      timer = setInterval(() => setClock((c) => ({ tick: c.tick + 1, now: Date.now() })), ms);
    };

    const apply = (active: boolean) => {
      if (active) {
        // Catch up first, then resume: the elapsed time is precisely what the
        // caller renders, and making the user wait up to `ms` to see a correct
        // "12 min ago" is the one moment the tick actually matters.
        setClock((c) => ({ tick: c.tick + 1, now: Date.now() }));
        start();
      } else {
        stop();
      }
    };

    apply(AppState.currentState === 'active');
    const sub = AppState.addEventListener('change', (s) => apply(s === 'active'));

    return () => { stop(); sub.remove(); };
  }, [ms]);

  return clock;
}

/**
 * Returns a counter that increments every `ms` — but only while the app is
 * foregrounded. Use it as a render dependency for time-derived text.
 */
export function useVisibleTick(ms: number): number {
  return useVisibleClock(ms).tick;
}

/**
 * The same tick as a timestamp: `Date.now()` as of the latest tick. For
 * screens that render "5 min ago" from one consistent `now` per tick.
 */
export function useVisibleNow(ms: number): number {
  return useVisibleClock(ms).now;
}

export default useVisibleTick;
