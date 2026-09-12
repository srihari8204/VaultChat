// lib/appVersionPolicy.ts — the version-floor DECISION, with no imports.
//
// Split out of appVersion.ts on purpose: that module needs expo-constants and
// the server URL, which drag in react-native and cannot be loaded under Node.
// The decision is the part worth testing — it is the one control that can lock
// every user out of the app at once — so it lives where a test can reach it.
//
// THE RULE: block only on a CLEAR instruction from the server. Silence,
// timeouts, garbage and unknown builds all mean "allowed".

export interface VersionGate {
  /** The server's hard floor. 0 (the default) blocks nobody. */
  minBuild: number;
  /** Soft floor — below this, nag but keep working. */
  adviseBuild: number;
  updateUrl: string;
  /** Server-supplied reason, shown on the blocking screen. */
  message: string;
}

export type VersionVerdict = 'ok' | 'advise' | 'blocked';

/**
 * Decide, given this build and whatever the server said.
 *
 * `gate === null` is "no usable answer" — offline, a timeout, a captive portal
 * returning HTML — and must never block: this app is local-first and works
 * offline by design, so a bad network must not look like a forced update.
 *
 * `build <= 0` is "cannot read the native build number" (Expo Go, web, a
 * malformed config). Also never blocked: locking a developer out because the
 * native config was unreadable would be a self-inflicted outage.
 *
 * The comparison is numeric because versionCode is a monotonic integer.
 * versionName is marketing text and sorts wrong — as strings "1.2.10" is below
 * "1.2.9", so a string floor would block the NEWER build.
 */
export function verdictFor(build: number, gate: VersionGate | null): VersionVerdict {
  if (!gate) return 'ok';
  if (build <= 0) return 'ok';
  if (gate.minBuild > 0 && build < gate.minBuild) return 'blocked';
  if (gate.adviseBuild > 0 && build < gate.adviseBuild) return 'advise';
  return 'ok';
}

export default { verdictFor };
