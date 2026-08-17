// lib/family/refresh.ts — FamilyMapRefreshController.
//
// THE JOB: the Family screen must never sit there looking alive while showing
// something that stopped being true ten minutes ago. Realtime is the primary
// path; this is the watchdog that notices when realtime has quietly stopped
// working and asks for an authoritative snapshot to reconcile against.
//
// WHAT IT DOES NOT DO, and this is the important half:
//   * it does not reload the MapView, remount the screen, or recreate markers.
//     It emits ONE callback — "go re-fetch the snapshot" — and the screen
//     folds that into its existing presence state, so only changed members
//     move. A remount is what makes a map blink and forget its camera.
//   * it does not poll while realtime is healthy. A connected socket that
//     delivered an event recently is left completely alone.
//   * it never invents state. It cannot make a member live; it can only ask
//     for the truth again.
//
// Before this, the family stack had no AppState listener, no network listener,
// and no staleness watchdog anywhere. If the socket dropped without a clean
// disconnect — the normal case on mobile — nothing re-subscribed and nothing
// re-snapshotted. The screen kept showing the last positions it happened to
// receive, with freshness captions ticking upward, until the user backed out
// and came in again.
//
// The decision half is pure and self-checked:  npx tsx lib/family/refresh.ts

/** Why a reconcile was requested. Surfaced for diagnostics, and so a caller
 *  can treat a cheap resume differently from a real recovery if it wants. */
export type RefreshTrigger =
  | 'appResume'      // app came back to the foreground (covers screen unlock)
  | 'reconnect'      // realtime transport came back up
  | 'stale'          // nothing has arrived for too long, though we look connected
  | 'networkBack'    // the OS says we have a network again
  | 'gap'            // an event sequence gap — we know we missed something
  | 'initial';       // first load

export type ConnHealth = 'connected' | 'connecting' | 'disconnected';

export interface RefreshState {
  /** When the last realtime event of ANY kind arrived. */
  lastEventAt: number | null;
  /** When we last performed a reconcile. */
  lastReconcileAt: number | null;
  conn: ConnHealth;
  /** App is foregrounded. A backgrounded screen has nothing to un-freeze. */
  foreground: boolean;
  online: boolean;
}

/**
 * Nothing has arrived for this long, while apparently connected → suspect the
 * transport. Comfortably longer than the slowest keepalive a foregrounded
 * peer uses (45 s in adaptive.ts), so a genuinely quiet family is not mistaken
 * for a broken socket.
 */
export const STALE_AFTER_MS = 100_000;

/**
 * Never reconcile more often than this. THE POINT OF THIS CONSTANT: on a flaky
 * connection every one of these triggers can fire at once — resume, reconnect
 * and network-back inside the same second — and without a floor that is three
 * snapshot requests. Multiply by every member of every family on a train going
 * into a tunnel and you have built a reconnect storm against your own API.
 */
export const MIN_RECONCILE_GAP_MS = 5_000;

/**
 * Should we reconcile right now, and why?
 *
 * Returns null for "leave it alone", which is the answer most of the time.
 */
export function shouldReconcile(s: RefreshState, now: number): RefreshTrigger | null {
  // A backgrounded screen is not frozen, it is not being looked at. Waking to
  // fetch snapshots for an invisible map is pure battery and API load.
  if (!s.foreground) return null;
  // No network: a snapshot request can only fail. The networkBack trigger will
  // pick this up the moment there is a point.
  if (!s.online) return null;

  if (s.lastReconcileAt != null && now - s.lastReconcileAt < MIN_RECONCILE_GAP_MS) return null;

  if (s.lastEventAt == null && s.lastReconcileAt == null) return 'initial';
  // Silence past the window, whatever the transport claims about itself. A
  // socket that believes it is connected while delivering nothing is the exact
  // failure this watchdog exists for, so `conn` deliberately does NOT gate
  // this — trusting it would blind us to the only case that matters.
  if (s.lastEventAt != null && now - s.lastEventAt > STALE_AFTER_MS) return 'stale';
  return null;
}

/**
 * Detect a hole in a member's event sequence.
 *
 * Returns the missing sequence numbers when `next` skips ahead of `last`.
 * A repeat or an out-of-order arrival is NOT a gap — those are normal on any
 * network and re-snapshotting for them would thrash.
 */
export function sequenceGap(last: number | null | undefined, next: number): number[] {
  if (last == null || !Number.isFinite(last) || !Number.isFinite(next)) return [];
  if (next <= last + 1) return [];
  const missing: number[] = [];
  // Cap the report: a device asleep for an hour returns thousands, and the
  // only thing the caller does with this is decide "yes, reconcile".
  for (let i = last + 1; i < next && missing.length < 64; i++) missing.push(i);
  return missing;
}

// ── runtime half ──────────────────────────────────────────────────────────

export interface RefreshOptions {
  /**
   * Re-fetch the authoritative snapshot and fold it in. MUST NOT remount the
   * map — reconciling means updating changed members, not rebuilding the view.
   */
  onReconcile: (trigger: RefreshTrigger) => void | Promise<void>;
  /** Poll interval for the staleness check. Not a data poll — it reads local
   *  timestamps and almost always decides to do nothing. */
  checkEveryMs?: number;
}

/**
 * Start the controller. Returns a stop function.
 *
 * ONE CONTROLLER PER MOUNTED SCREEN, and stop() removes every listener and the
 * timer — §100's "exactly one subscription, one timer" is enforced by the
 * caller mounting this once in an effect and returning stop as the cleanup.
 * There is no module-level singleton here on purpose: a hidden global would
 * survive navigation and quietly accumulate.
 */
export function startRefreshController(o: RefreshOptions): () => void {
  const checkEveryMs = o.checkEveryMs ?? 20_000;
  let stopped = false;
  let busy = false;

  const state: RefreshState = {
    lastEventAt: null,
    lastReconcileAt: null,
    conn: 'connecting',
    foreground: true,
    online: true,
  };

  const run = async (trigger: RefreshTrigger) => {
    // A reconcile already in flight makes a second one pointless — and on a
    // slow network they would queue up behind each other and arrive as a
    // burst of identical snapshots.
    if (stopped || busy) return;
    busy = true;
    state.lastReconcileAt = Date.now();
    try { await o.onReconcile(trigger); }
    catch { /* a failed snapshot leaves the old state; the next tick retries */ }
    finally { busy = false; }
  };

  const maybe = (forced?: RefreshTrigger) => {
    if (stopped) return;
    const now = Date.now();
    if (forced) {
      if (state.lastReconcileAt != null && now - state.lastReconcileAt < MIN_RECONCILE_GAP_MS) return;
      if (!state.foreground || !state.online) return;
      run(forced);
      return;
    }
    const t = shouldReconcile(state, now);
    if (t) run(t);
  };

  // ── app foreground / screen unlock ──
  // AppState 'active' covers both returning from another app and unlocking the
  // screen, which is exactly the pair §59 asks for.
  let appSub: { remove: () => void } | null = null;
  try {
     
    const { AppState } = require('react-native');
    appSub = AppState.addEventListener('change', (next: string) => {
      const wasBackground = !state.foreground;
      state.foreground = next === 'active';
      syncTimer();
      if (state.foreground && wasBackground) maybe('appResume');
    });
  } catch { /* not on a device (tsx/self-check) — the timer half still works */ }

  // ── realtime transport health ──
  let offConn: (() => void) | null = null;
  try {
     
    const socket = require('../socket');
    const map = (s: string): ConnHealth =>
      s === 'CONNECTED' ? 'connected' : s === 'CONNECTING' ? 'connecting' : 'disconnected';
    state.conn = map(socket.getConnectionState?.() ?? 'CONNECTING');
    offConn = socket.onConnectionState?.((s: string) => {
      const prev = state.conn;
      state.conn = map(s);
      // Coming back UP is the trigger. Going down is not: there is nothing to
      // reconcile against while the transport is dead.
      if (prev !== 'connected' && state.conn === 'connected') maybe('reconnect');
    }) ?? null;
  } catch { /* socket module unavailable — staleness still covers us */ }

  // ── network ──
  let offNet: (() => void) | null = null;
  try {
     
    const NetInfo = require('@react-native-community/netinfo').default;
    offNet = NetInfo.addEventListener((s: any) => {
      const was = state.online;
      state.online = s?.isConnected !== false;
      if (!was && state.online) maybe('networkBack');
    });
  } catch { /* assume online; the socket signal is the practical backstop */ }

  // ── staleness watchdog ──
  // Reads local timestamps only. It is NOT a data poll: while realtime is
  // healthy every tick decides to do nothing and costs one comparison.
  //
  // The timer is STOPPED while backgrounded rather than left running to be
  // rejected by shouldReconcile. A backgrounded screen can never reconcile —
  // the first guard refuses it — so those wakeups did nothing but cost battery,
  // three times a minute, for as long as the app stayed resident. The appResume
  // trigger already covers the return, so nothing is missed by sleeping.
  let timer: ReturnType<typeof setInterval> | null = null;
  const stopTimer = () => { if (timer) { clearInterval(timer); timer = null; } };
  const startTimer = () => { stopTimer(); timer = setInterval(() => maybe(), checkEveryMs); };
  const syncTimer = () => { if (state.foreground && !stopped) startTimer(); else stopTimer(); };

  syncTimer();
  maybe();   // initial load

  return () => {
    stopped = true;
    stopTimer();
    try { appSub?.remove(); } catch {}
    try { offConn?.(); } catch {}
    try { offNet?.(); } catch {}
  };
}

/** Tell the controller a realtime event arrived, so it stops suspecting the
 *  transport. Call this from the presence/platform event handlers. */
export function noteEvent(state: RefreshState, now = Date.now()): void {
  state.lastEventAt = now;
}

// ── self-check: `npx tsx lib/family/refresh.ts` ────────────────────────────
declare const require: any; declare const module: any;
if (typeof require !== 'undefined' && require.main === module) {
  const A = (c: boolean, m: string) => { if (!c) throw new Error('refresh: ' + m); };
  const T = 1_700_000_000_000;
  const S = (o: Partial<RefreshState>): RefreshState =>
    ({ lastEventAt: T, lastReconcileAt: T, conn: 'connected', foreground: true, online: true, ...o });

  // 1. a healthy, chatty screen is left completely alone
  A(shouldReconcile(S({}), T + 1_000) === null, 'a fresh event means no reconcile');
  A(shouldReconcile(S({}), T + STALE_AFTER_MS - 1) === null, 'just inside the window is still fine');

  // 2. silence past the window IS the frozen-screen symptom
  A(shouldReconcile(S({}), T + STALE_AFTER_MS + 1) === 'stale', 'silence must trigger a reconcile');

  // 3. first load
  A(shouldReconcile(S({ lastEventAt: null, lastReconcileAt: null }), T) === 'initial', 'first load reconciles');

  // 4. NOT while backgrounded or offline — an invisible map is not frozen, and
  //    a snapshot with no network can only fail
  A(shouldReconcile(S({ foreground: false }), T + 999_999) === null, 'a background screen must not reconcile');
  A(shouldReconcile(S({ online: false }), T + 999_999) === null, 'offline must not fire doomed requests');

  // 5. THE STORM GUARD — resume + reconnect + networkBack in the same second
  //    must not become three snapshot requests
  A(shouldReconcile(S({ lastReconcileAt: T + 999_000, lastEventAt: T }), T + 1_000) === null,
    'a reconcile moments ago must suppress the next');
  const justNow = S({ lastReconcileAt: T, lastEventAt: null });
  A(shouldReconcile(justNow, T + MIN_RECONCILE_GAP_MS - 1) === null, 'inside the floor: suppressed');
  A(shouldReconcile(S({ lastReconcileAt: T, lastEventAt: T - 999_999 }), T + MIN_RECONCILE_GAP_MS + 1) === 'stale',
    'past the floor with stale data: allowed');

  // 6. sequence gaps: a hole is a gap, a repeat or a reorder is not
  A(sequenceGap(101, 104).join() === '102,103', 'must report the missing sequence numbers');
  A(sequenceGap(101, 102).length === 0, 'the very next event is not a gap');
  A(sequenceGap(101, 101).length === 0, 'a duplicate is not a gap');
  A(sequenceGap(101, 99).length === 0, 'an out-of-order arrival is not a gap');
  A(sequenceGap(null, 500).length === 0, 'no previous sequence means nothing is missing');
  A(sequenceGap(0, 100_000).length === 64, 'a huge hole must be capped, not enumerated');

  // 7. noteEvent clears suspicion. lastReconcileAt is pushed back too, or the
  //    storm guard (correctly) suppresses the check before staleness is read.
  const st = S({ lastEventAt: T - 999_999, lastReconcileAt: T - 999_999 });
  A(shouldReconcile(st, T) === 'stale', 'stale before the event');
  noteEvent(st, T);
  A(shouldReconcile(st, T) === null, 'an arriving event must clear staleness');

  // 8. a socket that CLAIMS to be connected while delivering nothing is still
  //    stale — the failure mode the whole watchdog exists for
  A(shouldReconcile(S({ conn: 'connected', lastEventAt: T - 999_999, lastReconcileAt: T - 999_999 }), T) === 'stale',
    'a "connected" socket delivering nothing must still reconcile');

  console.log('family/refresh self-check: OK');
}

export default {};
