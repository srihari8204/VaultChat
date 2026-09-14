// lib/featureFlags.ts — staged rollout gate for the Rust transport (§21).
//
// STATUS: NOT WIRED. Nothing imports this yet, and `initFeatureFlags()` is not
// called from the boot path. Until something calls it there is no install id,
// so every flag reads OFF and the app behaves exactly as it does today. That is
// the intended state; see docs/ROLLOUT_TRANSPORT.md for how it gets switched on.
//
// WHAT THIS IS FOR
// ----------------
// services/transport/rust is finished and tested and deliberately unwired. The
// live transport is Socket.IO v4 over WebSocket (lib/socket.ts). This file is
// the switch between them, and — more importantly — the switch back.
//
// THE TWO HALVES, AND WHY THEY ARE DIFFERENT SHAPES
// ------------------------------------------------
//   ENABLE  comes from the build: `EXPO_PUBLIC_FLAG_<NAME>_PCT`, inlined into
//           the JS bundle at build time. Raising a stage therefore ships as a
//           JS bundle — an EAS update (app.json declares updates.url and
//           runtimeVersion policy "appVersion"), not necessarily a store
//           release. It is still a deploy, with a deploy's latency.
//
//   KILL    comes from the server: GET /app/flags, already in this repo
//           (lib/remoteFlags.ts, vaultchat-backend-go/internal/routes/appflags.go).
//           It is env-driven and cached for 60s, so an operator can kill a flag
//           with one env var and a restart. No release of any kind.
//
// That asymmetry is not an accident, it is remoteFlagPolicy's rule: /app/flags
// is UNAUTHENTICATED, so it may only ever turn things off. We do not weaken it.
// A rollback is the fast path; a rollout is the slow one. That is the correct
// way round.
//
// HONEST LIMITS OF THE KILL SWITCH — read these before trusting it
// ---------------------------------------------------------------
//   1. It lands on the NEXT COLD START of the app, not mid-session. A flag is
//      sticky once evaluated (see below), and the remote answer is fetched once
//      per launch by loadRemoteFlags(). A user in a conversation right now keeps
//      the transport they started on until they relaunch. Budget for that when
//      reading recovery graphs: the fleet drains over hours, not seconds.
//   2. It needs the client to reach /app/flags at least once. A device that is
//      offline keeps its last cached answer (remoteFlags persists it), and a
//      device that has NEVER fetched has no cached kill — but it also has
//      whatever percentage its bundle shipped with, which is why stages are
//      small and why stage 1 is internal-only.
//   3. It cannot un-send anything. See "What cannot be rolled back" in the
//      runbook.
//
// STICKINESS. A flag is evaluated at most once per app session and the answer is
// remembered for the rest of it. Transports must not change under a live
// conversation, and a value that can flip between two reads is a bug generator
// in every caller.
//
// NO react-native / AsyncStorage IMPORT AT MODULE SCOPE. Everything that could
// touch a native module is behind a lazy `import()` inside try/catch, so this
// file loads under plain node (that is what lets featureFlags.selftest.ts import
// it) and so a missing or broken SecureStore means OFF instead of a crash.

/** The rollout flag for the Rust transport. The only one that exists today. */
export const TRANSPORT_RUST = 'transport.rust';

/**
 * Everything a flag decision needs, as ONE interface with optional fields.
 *
 * Deliberately not a discriminated union: tsconfig has strict:false and
 * strictNullChecks:false, so unions do not narrow here (frame.ts documents the
 * same hazard). Optional fields with explicit checks are the shape that behaves.
 */
export interface FlagInput {
  /** Flag name, e.g. TRANSPORT_RUST. Part of the bucket hash. */
  name?: string;
  /** Rollout percentage, 0–100. Anything absent or unparseable means 0. */
  percent?: number;
  /** Stable per-install id. Absent ⇒ we cannot bucket ⇒ OFF (below 100%). */
  installId?: string;
  /** True when the server has killed this flag. Beats everything else. */
  killed?: boolean;
}

/**
 * 32-bit FNV-1a over `name:installId`.
 *
 * NOT a random draw. Re-rolling per launch turns a 1% rollout into a 1%
 * chance per launch — over a week nearly everyone gets the new path at least
 * once, each of them briefly, which is the worst of both transports and
 * impossible to debug. A hash of a stable id puts the same install on the same
 * side every time, so "it is broken for me" stays reproducible.
 *
 * The name is in the hash so two flags at 10% do not select the same 10%.
 */
export function bucketOf(name: string, installId: string): number {
  let h = 0x811c9dc5;
  const s = `${name}:${installId}`;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    // FNV prime 16777619, via shifts to stay in 32-bit int range.
    h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0;
  }
  return h % 100; // 0–99
}

/**
 * 0–100. Anything that is not a finite number reads as 0 (= OFF) — including
 * Infinity, which is a corrupt value rather than "everyone", and a corrupt
 * value must never move a single user onto a new transport.
 */
export function normalizePercent(value: unknown): number {
  const n = typeof value === 'string' ? Number(value.trim()) : value;
  if (typeof n !== 'number' || !isFinite(n)) return 0;
  if (n <= 0) return 0;
  if (n >= 100) return 100;
  return Math.floor(n);
}

/**
 * The whole decision, pure and synchronous. Never throws.
 *
 * Order matters: the kill is checked first, so a killed flag is off even at
 * 100% and even for an install that would otherwise be in the bucket.
 */
export function evaluateFlag(input: FlagInput): boolean {
  try {
    if (!input || !input.name) return false;
    if (input.killed === true) return false;
    const pct = normalizePercent(input.percent);
    if (pct <= 0) return false;            // 0% is nobody, including internal
    if (pct >= 100) return true;           // 100% is everybody, id or no id
    if (!input.installId) return false;    // cannot bucket ⇒ stay on the old path
    return bucketOf(input.name, input.installId) < pct;
  } catch {
    return false;
  }
}

/**
 * The build's rollout percentage for a flag, from the environment.
 *
 * `transport.rust` → `EXPO_PUBLIC_FLAG_TRANSPORT_RUST_PCT`. Expo inlines
 * EXPO_PUBLIC_* into the bundle, so this is a build/OTA-time value, and with no
 * variable set it is 0 — which is the non-negotiable default.
 */
export function envKeyFor(name: string): string {
  return `EXPO_PUBLIC_FLAG_${String(name).toUpperCase().replace(/[^A-Z0-9]+/g, '_')}_PCT`;
}

export function configuredPercent(name: string): number {
  try {
    // eslint-disable-next-line no-undef
    const env: any = typeof process !== 'undefined' && process ? process.env : null;
    if (!env) return 0;
    return normalizePercent(env[envKeyFor(name)]);
  } catch {
    return 0;
  }
}

// ── Session state ───────────────────────────────────────────────────────────
// All three of these are module-level and never reset: one app session, one set
// of answers.

let installId: string | null = null;
/** Set during init to a live reader of the remote kill switches. */
let killReader: ((name: string) => boolean) | null = null;
const decided: Record<string, boolean> = {};

/**
 * Load what a flag decision needs. Call once at boot, do not await on a render
 * path, and never let it reject — it already cannot.
 *
 * Both halves are best-effort and both fail to OFF:
 *   • the install id comes from services/deviceService (SecureStore-backed, the
 *     same id the API layer already uses). Unavailable ⇒ no bucketing ⇒ OFF.
 *   • the kill reader comes from lib/remoteFlags, whose own snapshot is loaded
 *     at boot by app/_layout.tsx. We hold a function rather than a value so the
 *     first flag read sees the freshest snapshot, not whatever had arrived by
 *     the time init ran.
 */
export async function initFeatureFlags(): Promise<void> {
  try {
    const dev: any = await import('../services/deviceService');
    const id = await dev.getDeviceId();
    if (typeof id === 'string' && id.length > 0) installId = id;
  } catch {
    // No SecureStore, no native module, a rejected read: stay unbucketed.
  }
  try {
    const rf: any = await import('./remoteFlags');
    killReader = (name: string) => {
      try {
        // flagEnabled applies `buildDefault AND remote !== false`, so with a
        // build default of true this is exactly "has the server killed it?".
        return rf.flagEnabled(name, true) === false;
      } catch {
        return false;
      }
    };
  } catch {
    // No remote flags module ⇒ no kill signal ⇒ the percentage alone decides.
  }
}

/**
 * Is this feature on for this install, for the rest of this session?
 *
 * Synchronous, sticky and total: it returns a boolean on every path, including
 * before initFeatureFlags() has run (false) and if anything inside throws
 * (false).
 */
export function isFeatureEnabled(name: string): boolean {
  try {
    if (!name) return false;
    if (name in decided) return decided[name];
    const killed = killReader ? killReader(name) : false;
    const on = evaluateFlag({
      name,
      percent: configuredPercent(name),
      installId,
      killed,
    });
    decided[name] = on;
    return on;
  } catch {
    return false;
  }
}

/**
 * What this session decided and why, for a diagnostics screen and for the
 * runbook's "which side is this handset on?" step. Contains no user data — the
 * install id is reported only as its bucket.
 */
export function featureFlagDiagnostics(name: string): {
  name: string;
  percent: number;
  bucket: number;
  hasInstallId: boolean;
  killed: boolean;
  enabled: boolean;
} {
  const percent = configuredPercent(name);
  return {
    name,
    percent,
    bucket: installId ? bucketOf(name, installId) : -1,
    hasInstallId: !!installId,
    killed: killReader ? killReader(name) : false,
    enabled: isFeatureEnabled(name),
  };
}

/** Test seam only. Not exported from the default object; do not call in app code. */
export function __resetFeatureFlagsForTest(id?: string, kill?: (n: string) => boolean): void {
  for (const k of Object.keys(decided)) delete decided[k];
  installId = id || null;
  killReader = kill || null;
}

export default { TRANSPORT_RUST, initFeatureFlags, isFeatureEnabled, featureFlagDiagnostics };
