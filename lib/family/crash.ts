// lib/family/crash.ts — crash detection, the deciding half.
//
// Life360's headline safety feature, done with the sensors this phone already
// has: a hard impact (accelerometer spike) that follows real driving speed is
// a suspected crash. The SCREEN then owns what happens next — a loud 30 s
// countdown that fires SOS unless the person says "I'm OK" — because firing an
// SOS is a human-facing act, and this module only ever answers "was that an
// impact worth asking about?".
//
// Deliberately simple: one threshold, one recency window. A phone dropped on
// a desk shows the spike but no driving; a hard brake at speed shows driving
// but rarely 4 g on the cabin-mounted phone. The cooldown means one crash is
// one question, not a question per bounce of the same impact.
//
// ponytail: threshold heuristic, not sensor fusion. If false positives show
// up on a real drive, add a speed-drop confirmation before raising.
//
// Pure — no react-native imports — so the self-check runs under tsx:
//   npx tsx lib/family/crash.ts

/** Total acceleration (in g) at or above this reads as an impact. */
export const CRASH_G = 4;
/** Speed at or above this counts as driving (m/s ≈ 29 km/h). */
export const DRIVING_MS = 8;
/** The impact must follow driving within this window. */
export const DRIVE_WINDOW_MS = 15_000;
/** After one suspected crash, stay quiet this long. */
export const COOLDOWN_MS = 2 * 60_000;
/** How long the screen counts down before SOS fires on its own. */
export const COUNTDOWN_S = 30;

export interface CrashState {
  /** Last instant the device was moving at driving speed. */
  lastDriveTs: number | null;
  /** Last suspected crash (for the cooldown). */
  lastSuspectTs: number | null;
}

export function emptyCrashState(): CrashState {
  return { lastDriveTs: null, lastSuspectTs: null };
}

/** Record a speed reading (from the fixes presence already takes). */
export function feedSpeed(state: CrashState, speedMs: number | null | undefined, ts: number): CrashState {
  if (speedMs == null || !Number.isFinite(speedMs) || speedMs < DRIVING_MS) return state;
  return { ...state, lastDriveTs: ts };
}

/** Feed one accelerometer magnitude (g). True = suspected crash. */
export function feedImpact(state: CrashState, accG: number, ts: number): { state: CrashState; suspect: boolean } {
  if (!Number.isFinite(accG) || accG < CRASH_G) return { state, suspect: false };
  if (state.lastDriveTs == null || ts - state.lastDriveTs > DRIVE_WINDOW_MS) return { state, suspect: false };
  if (state.lastSuspectTs != null && ts - state.lastSuspectTs < COOLDOWN_MS) return { state, suspect: false };
  return { state: { ...state, lastSuspectTs: ts }, suspect: true };
}

// ── self-check: `npx tsx lib/family/crash.ts` ──────────────────────────────
declare const require: any; declare const module: any;
if (typeof require !== 'undefined' && require.main === module) {
  const A = (c: boolean, m: string) => { if (!c) throw new Error('crash: ' + m); };
  const t0 = 1_700_000_000_000;

  // 1. impact while driving = suspect
  let s = feedSpeed(emptyCrashState(), 12, t0);
  let r = feedImpact(s, 5, t0 + 3_000);
  A(r.suspect, 'a 5g impact seconds after driving must raise a suspect');

  // 2. the same impact must not ask twice (cooldown)
  r = feedImpact(r.state, 6, t0 + 4_000);
  A(!r.suspect, 'a second spike inside the cooldown is the same crash');
  r = feedImpact({ ...r.state, lastDriveTs: t0 + COOLDOWN_MS + 9_000 }, 5, t0 + 4_000 + COOLDOWN_MS + 6_000);
  A(r.suspect, 'after the cooldown, a new impact with fresh driving asks again');

  // 3. no driving context = no crash (a dropped phone is not an accident)
  r = feedImpact(emptyCrashState(), 7, t0);
  A(!r.suspect, 'a spike with no driving history must not fire');
  s = feedSpeed(emptyCrashState(), 12, t0);
  r = feedImpact(s, 5, t0 + DRIVE_WINDOW_MS + 1_000);
  A(!r.suspect, 'driving too long ago must not arm the detector');

  // 4. below the threshold is a pothole, not a crash
  s = feedSpeed(emptyCrashState(), 15, t0);
  r = feedImpact(s, 2.5, t0 + 1_000);
  A(!r.suspect, 'a 2.5g bump while driving is a road, not an accident');

  // 5. speed bookkeeping: only driving speed arms; walking never does
  s = feedSpeed(emptyCrashState(), 1.2, t0);
  A(s.lastDriveTs === null, 'walking speed must not arm the detector');
  s = feedSpeed(s, DRIVING_MS, t0 + 1_000);
  A(s.lastDriveTs === t0 + 1_000, 'the driving threshold itself arms');
  s = feedSpeed(s, null, t0 + 2_000);
  A(s.lastDriveTs === t0 + 1_000, 'a missing speed reading must not erase the driving history');

  console.log('family/crash self-check: OK');
}

export default {};
