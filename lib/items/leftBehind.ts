// lib/items/leftBehind.ts — "you left your keys at Home".
//
// This is the half a bare BLE tracker cannot do and the reason to build item
// finding INSIDE a family app rather than beside one: the app already knows
// the member's saved Places and their live position, so it can tell the
// difference between "the tag is out of range because it is in the next room"
// and "the tag is out of range because you drove away from it".
//
// The rule, deliberately narrow to avoid false alarms:
//   1. the tag was HEARD recently while the phone was inside a Place, and
//   2. the phone has since LEFT that Place, and
//   3. the tag has not been heard since.
// Anything less certain stays silent. A tracker that cries wolf gets muted,
// and a muted tracker never saves anyone anything.
//
// Pure — no react-native imports — so the self-check runs under tsx:
//   npx tsx lib/items/leftBehind.ts

/** The tag must have been heard within this long before the departure to count. */
export const HEARD_WINDOW_MS = 10 * 60_000;
/** Silence for at least this long after leaving before we accuse. */
export const GONE_GRACE_MS = 90_000;
/** One alert per item per departure — this long must pass before another. */
export const REALERT_MS = 30 * 60_000;

export interface ItemWatchState {
  /** Where the tag was last heard, and when. */
  lastHeardAt: number | null;
  /** Name of the Place the phone was inside when it was last heard. */
  lastHeardPlace: string | null;
  /** When we last told the user about this item. */
  lastAlertAt: number | null;
}

export interface LeftBehindInput {
  /** Is the tag audible right now? */
  present: boolean;
  /** Place the phone is inside right now, or null when outside all of them. */
  insidePlace: string | null;
  now: number;
}

export function emptyWatch(): ItemWatchState {
  return { lastHeardAt: null, lastHeardPlace: null, lastAlertAt: null };
}

export interface LeftBehindResult {
  state: ItemWatchState;
  /** Non-null when the user should be told, carrying the place to name. */
  alertPlace: string | null;
}

/**
 * Fold one observation. Returns the new state plus an alert when — and only
 * when — all three conditions above hold.
 */
export function observeItem(state: ItemWatchState, input: LeftBehindInput): LeftBehindResult {
  const { present, insidePlace, now } = input;
  const next: ItemWatchState = { ...state };

  if (present) {
    // Hearing the tag always refreshes the memory, and always clears any
    // pending suspicion: an item in range is not an item left behind.
    next.lastHeardAt = now;
    // Only record a PLACE when we are actually inside one. Hearing the tag in
    // a car park teaches nothing about where it would be abandoned.
    if (insidePlace) next.lastHeardPlace = insidePlace;
    return { state: next, alertPlace: null };
  }

  // Not present. Do we have grounds to worry?
  if (!next.lastHeardAt || !next.lastHeardPlace) return { state: next, alertPlace: null };
  // Still inside the same Place → the tag is simply out of radio range in a
  // big house. That is not leaving it behind.
  if (insidePlace && insidePlace === next.lastHeardPlace) return { state: next, alertPlace: null };
  // Heard too long ago to attribute to this departure.
  if (now - next.lastHeardAt > HEARD_WINDOW_MS) return { state: next, alertPlace: null };
  // Give the radio a moment — a tag drops in and out at the edge of range.
  if (now - next.lastHeardAt < GONE_GRACE_MS) return { state: next, alertPlace: null };
  // One alert per departure.
  if (next.lastAlertAt != null && now - next.lastAlertAt < REALERT_MS) return { state: next, alertPlace: null };

  next.lastAlertAt = now;
  return { state: next, alertPlace: next.lastHeardPlace };
}

/** "Keys — left at Home" */
export function leftBehindText(itemName: string, place: string): string {
  return `${itemName} may be left at ${place}`;
}

// ── self-check: `npx tsx lib/items/leftBehind.ts` ──────────────────────────
declare const require: any; declare const module: any;
if (typeof require !== 'undefined' && require.main === module) {
  const A = (c: boolean, m: string) => { if (!c) throw new Error('leftBehind: ' + m); };
  const t0 = 1_700_000_000_000;
  const M = 60_000;

  // 1. THE HAPPY PATH: heard at Home, then the phone leaves and it goes quiet
  let s = emptyWatch();
  s = observeItem(s, { present: true, insidePlace: 'Home', now: t0 }).state;
  A(s.lastHeardPlace === 'Home', 'hearing it inside Home records Home');
  let r = observeItem(s, { present: false, insidePlace: null, now: t0 + 2 * M });
  A(r.alertPlace === 'Home', 'leaving Home without the tag must alert');

  // 2. STILL INSIDE THE PLACE is not leaving it behind — the commonest false
  //    alarm a naive tracker produces (tag in a drawer upstairs).
  s = emptyWatch();
  s = observeItem(s, { present: true, insidePlace: 'Home', now: t0 }).state;
  r = observeItem(s, { present: false, insidePlace: 'Home', now: t0 + 5 * M });
  A(r.alertPlace === null, 'out of radio range but still at Home must stay silent');

  // 3. the grace period stops edge-of-range flapping
  s = emptyWatch();
  s = observeItem(s, { present: true, insidePlace: 'Home', now: t0 }).state;
  r = observeItem(s, { present: false, insidePlace: null, now: t0 + 30_000 });
  A(r.alertPlace === null, '30 s of silence is radio flap, not a departure');

  // 4. stale memory cannot trigger an alert
  s = emptyWatch();
  s = observeItem(s, { present: true, insidePlace: 'Home', now: t0 }).state;
  r = observeItem(s, { present: false, insidePlace: null, now: t0 + 30 * M });
  A(r.alertPlace === null, 'a half-hour-old sighting says nothing about now');

  // 5. one alert per departure, not one per scan
  s = emptyWatch();
  s = observeItem(s, { present: true, insidePlace: 'Home', now: t0 }).state;
  r = observeItem(s, { present: false, insidePlace: null, now: t0 + 2 * M });
  A(r.alertPlace === 'Home', 'first alert fires');
  const r2 = observeItem(r.state, { present: false, insidePlace: null, now: t0 + 3 * M });
  A(r2.alertPlace === null, 'the very next scan must not alert again');

  // 6. hearing it again clears the worry, and a later departure alerts afresh
  s = observeItem(r.state, { present: true, insidePlace: 'Office', now: t0 + 40 * M }).state;
  A(s.lastHeardPlace === 'Office', 'a new place replaces the old memory');
  const r3 = observeItem(s, { present: false, insidePlace: null, now: t0 + 42 * M });
  A(r3.alertPlace === 'Office', 'a new departure alerts, naming the NEW place');

  // 7. never learns a place it was not inside
  s = emptyWatch();
  s = observeItem(s, { present: true, insidePlace: null, now: t0 }).state;
  A(s.lastHeardPlace === null, 'hearing it outside every Place records no place');
  r = observeItem(s, { present: false, insidePlace: null, now: t0 + 5 * M });
  A(r.alertPlace === null, 'with no place to name there is nothing to say');

  A(leftBehindText('Keys', 'Home') === 'Keys may be left at Home', 'copy names item and place');

  console.log('items/leftBehind self-check: OK');
}

export default {};
