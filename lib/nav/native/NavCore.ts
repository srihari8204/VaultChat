/**
 * lib/nav/native/NavCore.ts — the route-maths backend selector.
 *
 * ONE surface, two implementations:
 *   native — services/nav/rust, reached through the Nitro HybridObject
 *            "NavCore" (one sync JSI method: call(op, argsJson) → responseJson),
 *            linked into libvaultcrypto.so beside the crypto core.
 *   TS     — lib/nav/routeProgress.ts, the reference implementation.
 *
 * THE TS PATH IS NOT A DEGRADED MODE. services/nav/rust/tests/parity.rs proves
 * the two agree to sub-millimetre on the same vectors, so which one runs is
 * invisible in behaviour. That matters because the native library is absent on
 * more builds than you would guess: iOS entirely (crypto-core is Android-only
 * today), any build made without cargo-ndk installed, and every Node/tsx test
 * run. Navigation must be identical on all of them.
 *
 * HONEST PERFORMANCE NOTE. Measured on this workload the native core saves
 * roughly 0.3 microseconds per GPS fix over the optimised TypeScript — less
 * than a single JSI crossing costs. The large win (167x at 6000 vertices) was
 * ALGORITHMIC and lives in routeProgress.ts, which both paths share the shape
 * of. This module exists because the owner asked for the native path to be
 * real and wired rather than dead code; it is not load-bearing for performance,
 * and `preferNative(false)` turns it off with no behavioural change.
 */

import {
  buildGeometry, navStep as tsNavStep, NAV_STEP_IDLE,
  type RouteGeometry, type NavStepInput, type NavStepOutput, type NavStepState,
} from '../routeProgress';
import type { LatLng } from '../geo';

interface NativeNavCore {
  call(op: string, argsJson: string): string;
}

let native: NativeNavCore | null = null;
let initTried = false;
let initError: string | null = null;
let allowNative = true;

/**
 * Bind + self-check the native HybridObject. Never throws; safe to re-call.
 *
 * The self-check is a real geometry assertion inside Rust (ffi.rs op_self_check),
 * not a constant — a miscompiled or ABI-mismatched .so fails here, on a bench,
 * instead of producing subtly wrong distances on a road.
 */
export function initNativeNav(): boolean {
  if (native) return true;
  if (initTried) return false;
  initTried = true;
  try {
    // Lazy require: Node/tsx test runs and TS-backend sessions never touch the
    // native module at all. Same pattern as services/crypto/native/CryptoCore.ts.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { NitroModules } = require('react-native-nitro-modules');
    const obj = NitroModules.createHybridObject('NavCore') as unknown as NativeNavCore;
    const probe = JSON.parse(obj.call('selfCheck', '{}'));
    if (!probe.ok) throw new Error(probe.error || 'nav-core: self-check failed');
    native = obj;
    // ONE line, on the first bind only, so a device log can answer "did the
    // native core actually run this journey?" — the question packaging proof
    // cannot. console.warn on purpose: babel strips console.log from release
    // builds and keeps warn (same reason FamilyMap reports its basemap host
    // this way), and a diagnostic that vanishes from exactly the builds that
    // go on a phone is not a diagnostic.
    console.warn('[NavCore] native backend bound', probe.result?.version ?? '');
    return true;
  } catch (e) {
    initError = String((e as Error)?.message || e);
    console.warn('[NavCore] native unavailable — TypeScript fallback:', initError);
    return false;
  }
}

/** Why the native core is not in use, or null when it is. */
export function nativeNavInitError(): string | null {
  return native ? null : initError;
}

/** Which backend the ACTIVE session is running on — for the report line and
 *  for tests that need to assert both paths were exercised. */
export function activeBackend(): 'native' | 'ts' | 'none' {
  if (!session) return 'none';
  return session.kind;
}

/** Kill switch. `false` forces the TypeScript path; used by the parity
 *  harness to run the same journey twice and compare. */
export function preferNative(v: boolean): void {
  allowNative = v;
}

// ── session ───────────────────────────────────────────────────────────

type Session =
  | { kind: 'native'; routeId: string; lengthM: number }
  | { kind: 'ts'; geom: RouteGeometry; state: NavStepState };

let session: Session | null = null;
let routeSeq = 0;

function invoke(op: string, args: unknown): any {
  if (!native) throw new Error('nav-core: not initialised');
  const resp = JSON.parse(native.call(op, JSON.stringify(args)));
  if (!resp.ok) throw new Error(resp.error || 'nav-core: unknown native error');
  return resp.result;
}

/**
 * Adopt a route. Chooses the backend ONCE, here — a session never switches
 * backends mid-journey, because the two hold their filter and hysteresis state
 * separately and swapping would reset an in-flight off-route excursion.
 *
 * Returns the route length in metres. Never throws: a native failure falls
 * through to the TypeScript path rather than leaving the caller with no route.
 */
export function setRoute(shape: LatLng[]): number {
  routeSeq += 1;
  const routeId = `r${routeSeq}`;

  if (allowNative && (native || initNativeNav())) {
    try {
      const res = invoke('setRoute', {
        routeId,
        shape: shape.map((p) => [p.lat, p.lng]),
      });
      session = { kind: 'native', routeId, lengthM: Number(res.lengthM) || 0 };
      return session.lengthM;
    } catch (e) {
      // One failure disables the native path for the rest of the process: if
      // setRoute failed once it will fail every second from now on, and
      // retrying per route would spend a JSI call to learn the same thing.
      initError = String((e as Error)?.message || e);
      native = null;
    }
  }

  const geom = buildGeometry(shape);
  session = { kind: 'ts', geom, state: NAV_STEP_IDLE };
  return geom.lengthM;
}

/** Drop the session. Called on stopNavigation so a finished journey's geometry
 *  is not retained on either side (do not hold location data longer than
 *  necessary). */
export function clearRoute(): void {
  if (session?.kind === 'native' && native) {
    try { invoke('clearRoute', {}); } catch { /* the session is going anyway */ }
  }
  session = null;
}

/**
 * One pass per GPS fix. Returns null only when no route is set.
 *
 * A native error mid-journey does NOT strand the caller: the geometry is
 * rebuilt on the TypeScript side and this fix is answered from there, so the
 * worst a native fault can cost is one slightly slower frame.
 */
export function step(input: NavStepInput, shape: LatLng[]): NavStepOutput | null {
  if (!session) return null;

  if (session.kind === 'native') {
    try {
      const r = invoke('step', {
        routeId: session.routeId,
        lat: input.lat, lng: input.lng,
        accuracyM: input.accuracyM, speedMps: input.speedMps,
        headingDeg: input.headingDeg, tsMs: input.tsMs,
        prevIndex: input.prevIndex, maneuverBeginIndex: input.maneuverBeginIndex,
      });
      return {
        index: r.index, snappedLat: r.snappedLat, snappedLng: r.snappedLng,
        crossTrackM: r.crossTrackM, alongM: r.alongM,
        distToManeuverM: r.distToManeuverM, remainingM: r.remainingM,
        progress: r.progress, verdict: r.verdict,
        arrived: !!r.arrived, rescanned: !!r.rescanned,
      };
    } catch (e) {
      initError = String((e as Error)?.message || e);
      native = null;
      // Fall through to TS, rebuilding the geometry from the caller's shape.
      const geom = buildGeometry(shape);
      session = { kind: 'ts', geom, state: NAV_STEP_IDLE };
    }
  }

  const s = session as Extract<Session, { kind: 'ts' }>;
  const { output, state } = tsNavStep(s.geom, input, s.state);
  s.state = state;
  return output;
}

/** The active route's length in metres, or 0. */
export function routeLength(): number {
  if (!session) return 0;
  return session.kind === 'native' ? session.lengthM : session.geom.lengthM;
}

/** Cumulative distance to a shape index — the maneuver odometer. TS-side only;
 *  the native path returns distToManeuverM directly from `step`. */
export function cumulativeAt(index: number): number | null {
  if (session?.kind !== 'ts') return null;
  const c = session.geom.cum;
  return c[Math.max(0, Math.min(index, c.length - 1))];
}

export default {};
