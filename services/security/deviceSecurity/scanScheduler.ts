// services/security/deviceSecurity/scanScheduler.ts — when (and how deep) to scan.
//
// Pure policy that answers "given this trigger and when we last scanned, should
// we scan now, and lightweight or deep?". Keeps the battery contract explicit
// and testable: app launch and foreground returns do a THROTTLED lightweight
// scan (so a quick relaunch doesn't re-scan), the periodic background job does a
// DEEP scan on a long cadence, and user "Scan now" / OS-broadcast tripwires
// always scan immediately. No timers, no storage, no RN — `now` and the last
// scan time are passed in (scanScheduler.selftest.ts).
//
// `depth` is advisory for the collector: today's JS collector ignores it, but
// the native VaultShield collector will run only the cheap checks for `light`
// and the full maps/mount/port sweep for `deep`.

export type ScanTrigger = 'launch' | 'foreground' | 'periodic' | 'manual' | 'event';
export type ScanDepth = 'light' | 'deep';

export interface ScanDecision {
  shouldScan: boolean;
  depth: ScanDepth;
  reason: string;
}

export interface ScanPolicy {
  /** Don't re-scan on a quick relaunch within this window. */
  launchMinIntervalMs: number;
  /** Minimum gap between foreground-return re-scans. */
  foregroundMinIntervalMs: number;
  /** Deep background scan cadence. */
  periodicIntervalMs: number;
}

export const DEFAULT_SCAN_POLICY: ScanPolicy = {
  launchMinIntervalMs: 5 * 60 * 1000,        // 5 minutes
  foregroundMinIntervalMs: 15 * 60 * 1000,   // 15 minutes
  periodicIntervalMs: 12 * 60 * 60 * 1000,   // 12 hours
};

/**
 * Decide whether to scan. `manual` and `event` (OS-broadcast tripwire) always
 * scan deeply and immediately. Time-based triggers are throttled against
 * `lastScanAt` (null = never scanned → always scan). A last scan timestamped in
 * the future (clock moved backwards) is treated as due, so a clock change can't
 * wedge scanning off.
 */
export function decideScan(
  trigger: ScanTrigger,
  lastScanAt: number | null,
  now: number,
  policy: ScanPolicy = DEFAULT_SCAN_POLICY,
): ScanDecision {
  if (trigger === 'manual') return { shouldScan: true, depth: 'deep', reason: 'user requested' };
  if (trigger === 'event')  return { shouldScan: true, depth: 'deep', reason: 'device-state change' };

  if (lastScanAt == null) {
    // Never scanned: launch/foreground stay light (fast first paint), periodic deep.
    return { shouldScan: true, depth: trigger === 'periodic' ? 'deep' : 'light', reason: 'first scan' };
  }

  const age = now - lastScanAt;
  const clockWentBack = age < 0;

  if (trigger === 'periodic') {
    const due = clockWentBack || age >= policy.periodicIntervalMs;
    return due
      ? { shouldScan: true, depth: 'deep', reason: clockWentBack ? 'clock changed' : 'periodic cadence' }
      : { shouldScan: false, depth: 'deep', reason: 'periodic not due' };
  }

  const minGap = trigger === 'launch' ? policy.launchMinIntervalMs : policy.foregroundMinIntervalMs;
  const due = clockWentBack || age >= minGap;
  return due
    ? { shouldScan: true, depth: 'light', reason: clockWentBack ? 'clock changed' : trigger }
    : { shouldScan: false, depth: 'light', reason: `recent scan (${trigger})` };
}
