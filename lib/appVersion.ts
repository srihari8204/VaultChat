// lib/appVersion.ts — "is this build still allowed to run?"
//
// The server publishes a minimum build number (GET /app/version). A client
// below it must stop, because so much of this system is versioned formats —
// message envelopes, sender keys, backup files, the frozen API contract — and
// an out-of-date client does not fail loudly, it misreads. It is also the only
// lever that works after a security fix ships: a fix in a release nobody
// installs protects nobody.
//
// THREE RULES, AND THEY ARE ALL ABOUT NOT LOCKING PEOPLE OUT BY ACCIDENT:
//
//   1. Unreachable server ⇒ ALLOWED. An offline user, a captive portal or an
//      API outage must never look like a forced update. This app is local-first
//      and works offline by design; a version check that blocks on a failed
//      request would break that on the one day the network is bad.
//   2. Unparseable answer ⇒ ALLOWED. Same reasoning: a proxy that returns HTML
//      is not a policy decision.
//   3. The floor is a NUMBER, compared numerically. versionName ("1.2.8") is
//      marketing text and sorts wrong ("1.2.10" < "1.2.9" as a string);
//      versionCode is a monotonically increasing integer, which is exactly what
//      a floor needs.
//
// Cached so the check runs once per launch rather than per screen, and so a
// slow network delays nothing after the first answer.

import Constants from 'expo-constants';
import { SERVER_URL } from '../constants/server';

// The decision itself lives in ./appVersionPolicy — no react-native there,
// so it can be unit-tested under Node. Re-exported so callers see one module.
export { verdictFor } from './appVersionPolicy';
export type { VersionGate, VersionVerdict } from './appVersionPolicy';
import { verdictFor, type VersionGate, type VersionVerdict } from './appVersionPolicy';

/** How long to wait before deciding the server has no opinion. */
const VERSION_TIMEOUT_MS = 6000;

/**
 * This build's versionCode / buildNumber.
 *
 * Returns 0 when it cannot be read (Expo Go, a web build, a malformed
 * config), and verdictFor treats 0 as unknown rather than ancient.
 */
export function currentBuild(): number {
  const android = Constants.expoConfig?.android?.versionCode;
  const ios = Constants.expoConfig?.ios?.buildNumber;
  const n = Number(android ?? ios ?? 0);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
}

let cached: VersionGate | null | undefined;

/** Ask the server. Never throws; null means "no usable answer". */
export async function fetchVersionGate(force = false): Promise<VersionGate | null> {
  if (!force && cached !== undefined) return cached;

  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), VERSION_TIMEOUT_MS);
  try {
    const res = await fetch(`${SERVER_URL}/app/version`, {
      headers: { Accept: 'application/json' },
      signal: ctl.signal,
    });
    if (!res.ok) { cached = null; return null; }
    const d: any = await res.json();
    const gate: VersionGate = {
      minBuild: Number(d?.minBuild) || 0,
      adviseBuild: Number(d?.adviseBuild) || 0,
      updateUrl: typeof d?.updateUrl === 'string' ? d.updateUrl : '',
      message: typeof d?.message === 'string' ? d.message : '',
    };
    cached = gate;
    return gate;
  } catch {
    cached = null;                     // offline, timeout, captive portal
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/** The whole check, as one call: ask, then decide. */
export async function checkAppVersion(): Promise<{ verdict: VersionVerdict; gate: VersionGate | null }> {
  const gate = await fetchVersionGate();
  return { verdict: verdictFor(currentBuild(), gate), gate };
}

export default { currentBuild, verdictFor, fetchVersionGate, checkAppVersion };
