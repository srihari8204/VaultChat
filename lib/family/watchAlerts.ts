// lib/family/watchAlerts.ts — Life360-style alerts about OTHER members,
// derived on the VIEWING device from presences it already decrypted.
//
// Why viewer-side: a member's low battery travels in every ping (`bat`), and
// their silence is literally the absence of pings — both are things only a
// watcher can observe. The emitting device already raises its OWN low-battery
// alert in fixPipeline; this is the other half, so a parent hears "Rohan's
// phone is at 10%" instead of finding out when the dot goes dark.
//
// Edge-detection with hysteresis, so one low-battery episode is ONE alert and
// one stretch of silence is ONE alert — never one per ping or per tick.
//
// Pure — no react-native imports — so the self-check runs under tsx:
//   npx tsx lib/family/watchAlerts.ts

/** At or below this (and not charging), a member's battery is alert-worthy. */
export const LOW_BATTERY_PCT = 15;
/** The battery must recover past this (or charge) before a new episode. */
export const BATTERY_RESET_PCT = 25;
/** No fix for this long = the member went quiet. */
export const QUIET_AFTER_MS = 4 * 60_000;
/** Silence older than this is history, not news — opening the app a day
 *  later must not announce that someone "just" stopped reporting. */
export const QUIET_NEWS_MS = 30 * 60_000;

export interface MemberSnapshot {
  id: string;
  name: string;
  battery?: number;
  charging?: boolean;
  /** Epoch ms of their newest fix. */
  ts: number;
  /** They explicitly stopped sharing — silence is expected, not alarming. */
  sharingOff?: boolean;
}

export interface WatchState {
  /** Member is inside a low-battery episode (already alerted). */
  lowBat: Record<string, boolean>;
  /** Member's current silence has already been alerted. */
  quiet: Record<string, boolean>;
}

export interface WatchAlert {
  kind: 'battery' | 'offline';
  actorId: string;
  actorName: string;
  text: string;
}

export function emptyWatchState(): WatchState {
  return { lowBat: {}, quiet: {} };
}

/**
 * Fold the current presences into the watch state, returning any NEW alerts.
 * Call it as often as you like — it only speaks on an edge.
 */
export function deriveWatchAlerts(
  state: WatchState,
  members: MemberSnapshot[],
  now: number,
): { state: WatchState; alerts: WatchAlert[] } {
  const next: WatchState = { lowBat: { ...state.lowBat }, quiet: { ...state.quiet } };
  const alerts: WatchAlert[] = [];

  for (const m of members) {
    // ── battery episode ──
    const bat = m.battery;
    if (bat != null && Number.isFinite(bat)) {
      if (bat <= LOW_BATTERY_PCT && !m.charging) {
        if (!next.lowBat[m.id]) {
          next.lowBat[m.id] = true;
          alerts.push({
            kind: 'battery', actorId: m.id, actorName: m.name,
            text: `${m.name}'s phone is at ${Math.round(bat)}%`,
          });
        }
      } else if (bat >= BATTERY_RESET_PCT || m.charging) {
        // Only a REAL recovery (or a charger) closes the episode — bouncing
        // between 14% and 18% is one dying battery, not four alerts.
        next.lowBat[m.id] = false;
      }
    }

    // ── silence episode ──
    const silentFor = now - m.ts;
    if (m.sharingOff || silentFor <= QUIET_AFTER_MS) {
      // Reporting again (or an explicit stop) ends the episode either way.
      next.quiet[m.id] = false;
    } else if (silentFor <= QUIET_NEWS_MS && !next.quiet[m.id]) {
      next.quiet[m.id] = true;
      alerts.push({
        kind: 'offline', actorId: m.id, actorName: m.name,
        text: `${m.name}'s phone stopped reporting — battery dead, no signal, or the phone is off`,
      });
    } else if (silentFor > QUIET_NEWS_MS) {
      // Too old to announce, but mark the episode so a later mount of this
      // state never treats stale history as fresh news.
      next.quiet[m.id] = true;
    }
  }
  return { state: next, alerts };
}

// ── self-check: `npx tsx lib/family/watchAlerts.ts` ────────────────────────
declare const require: any; declare const module: any;
if (typeof require !== 'undefined' && require.main === module) {
  const A = (c: boolean, m: string) => { if (!c) throw new Error('watchAlerts: ' + m); };
  const now = 1_700_000_000_000;
  const fresh = now - 10_000;
  const m = (o: Partial<MemberSnapshot>): MemberSnapshot =>
    ({ id: 'u1', name: 'Rohan', ts: fresh, ...o });

  // 1. LOW BATTERY: one alert per episode, with hysteresis
  let s = emptyWatchState();
  let r = deriveWatchAlerts(s, [m({ battery: 12 })], now);
  A(r.alerts.length === 1 && r.alerts[0].kind === 'battery', 'low battery must alert');
  A(r.alerts[0].text.includes('12%'), 'the alert should carry the percentage');
  r = deriveWatchAlerts(r.state, [m({ battery: 11 })], now);
  A(r.alerts.length === 0, 'still low is the SAME episode — no repeat');
  r = deriveWatchAlerts(r.state, [m({ battery: 18 })], now);
  r = deriveWatchAlerts(r.state, [m({ battery: 12 })], now);
  A(r.alerts.length === 0, '18% is inside the hysteresis band — not a new episode');
  r = deriveWatchAlerts(r.state, [m({ battery: 40 })], now);
  r = deriveWatchAlerts(r.state, [m({ battery: 10 })], now);
  A(r.alerts.length === 1, 'a real recovery then a new drop is a NEW episode');

  // 2. charging cancels the worry; unknown battery says nothing
  r = deriveWatchAlerts(emptyWatchState(), [m({ battery: 8, charging: true })], now);
  A(r.alerts.length === 0, 'charging at 8% is fine — it is getting better');
  r = deriveWatchAlerts(emptyWatchState(), [m({})], now);
  A(r.alerts.length === 0, 'no battery reading must not invent an alert');
  r = deriveWatchAlerts(emptyWatchState(), [m({ battery: LOW_BATTERY_PCT })], now);
  A(r.alerts.length === 1, 'the threshold itself counts as low');

  // 3. WENT QUIET: one alert per stretch of silence, only while it is news
  s = emptyWatchState();
  r = deriveWatchAlerts(s, [m({ ts: fresh })], now);
  A(r.alerts.length === 0, 'a live member is not quiet');
  r = deriveWatchAlerts(r.state, [m({ ts: now - 5 * 60_000 })], now);
  A(r.alerts.length === 1 && r.alerts[0].kind === 'offline', '5 min of silence must alert');
  r = deriveWatchAlerts(r.state, [m({ ts: now - 6 * 60_000 })], now);
  A(r.alerts.length === 0, 'the same silence must not alert twice');
  // a fresh fix clears the episode; the next silence alerts again
  r = deriveWatchAlerts(r.state, [m({ ts: fresh })], now);
  r = deriveWatchAlerts(r.state, [m({ ts: now - 5 * 60_000 })], now);
  A(r.alerts.length === 1, 'a new stretch of silence is a new alert');

  // 4. old silence is history, not news; an explicit stop is never "quiet"
  r = deriveWatchAlerts(emptyWatchState(), [m({ ts: now - 2 * 3600_000 })], now);
  A(r.alerts.length === 0, 'hours-old silence on app open must not announce itself');
  r = deriveWatchAlerts(emptyWatchState(), [m({ ts: now - 5 * 60_000, sharingOff: true })], now);
  A(r.alerts.length === 0, 'sharing-off silence is expected, not alarming');

  // 5. members are independent
  r = deriveWatchAlerts(emptyWatchState(), [
    m({ id: 'a', name: 'A', battery: 9 }),
    m({ id: 'b', name: 'B', ts: now - 5 * 60_000 }),
    m({ id: 'c', name: 'C', battery: 80 }),
  ], now);
  A(r.alerts.length === 2, `two members, two alerts — got ${r.alerts.length}`);
  A(r.alerts.some((x) => x.actorId === 'a' && x.kind === 'battery'), 'A is the battery alert');
  A(r.alerts.some((x) => x.actorId === 'b' && x.kind === 'offline'), 'B is the quiet alert');

  console.log('family/watchAlerts self-check: OK');
}

export default {};
