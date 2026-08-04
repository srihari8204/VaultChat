// services/security/deviceSecurity/notificationPolicy.ts — when to notify.
//
// Decides which posture changes become a user-facing security notification, and
// which stay silent (dashboard + audit log only). The whole point is restraint:
// notify on MEANINGFUL transitions, never on standing state, and never twice for
// the same thing inside a cooldown window — a noisy channel trains users to
// ignore the one alert that matters.
//
// PURE + deterministic: the clock (`now`) and the per-event last-sent map are
// passed IN, so the policy is fully Node-testable (notificationPolicy.selftest.ts)
// with no timers and no storage. The caller persists `lastSent` between runs.
//
// Three gates, in order:
//   1. EDGE-TRIGGER — only a factor that WORSENED into warning/critical is a
//      candidate (improvements and clear→pending churn never push).
//   2. SEVERITY FLOOR — warning and critical qualify; a warning uses a long
//      cooldown, a critical a short one (see COOLDOWN_MS).
//   3. COOLDOWN — suppress if the same event key fired within its window.
// Plus a separate "significant score change" event when the band worsens by a
// real margin, and an always-silent "scan completed" record for the log.

import type { PostureDiff, PostureSnapshot, FactorStatus } from './posture';

export type NotifySeverity = 'warning' | 'critical';

export interface SecurityNotification {
  key: string;                 // dedupe/cooldown key (usually the factor key)
  event: string;               // stable event name for the audit log
  severity: NotifySeverity;
  title: string;
  body: string;
  factorKey?: string;
}

export interface PolicyContext {
  now: number;                 // epoch ms — passed in for determinism
  lastSent: Record<string, number>;  // event key → last fired epoch ms
  /** Minimum band-worsening score jump that fires a "score changed" event. */
  scoreJump?: number;          // default 15
}

export interface PolicyResult {
  notifications: SecurityNotification[];
  lastSent: Record<string, number>;  // updated map to persist
}

// Per-severity cooldown. Critical repeats sooner (it's urgent and rare); warning
// config toggles (dev options, USB) get a long window so they can't nag.
export const COOLDOWN_MS: Record<NotifySeverity, number> = {
  critical: 30 * 60 * 1000,       // 30 minutes
  warning: 12 * 60 * 60 * 1000,   // 12 hours
};

const SCORE_JUMP_DEFAULT = 15;

// Per-factor notification copy. Body is intentionally generic enough to be safe
// on a lock screen (the specifics live inside the app), per the privacy model.
const COPY: Record<string, { event: string; title: string; body: string }> = {
  root:            { event: 'ROOT_DETECTED',            title: 'Root access detected',           body: 'This device appears to be rooted. Open VaultChat to review.' },
  frida:           { event: 'FRIDA_DETECTED',           title: 'Instrumentation detected',        body: 'Debugging/instrumentation tooling is active on this device.' },
  debugger:        { event: 'DEBUGGER_ATTACHED',        title: 'Debugger attached',               body: 'A debugger is attached to VaultChat.' },
  appIntegrity:    { event: 'APK_INTEGRITY_FAILED',     title: 'App integrity check failed',      body: 'This build may not be the official VaultChat. Open to review.' },
  hooks:           { event: 'HOOK_FRAMEWORK_DETECTED',  title: 'Hooking framework detected',      body: 'An Xposed/LSPosed-type module may be active.' },
  accessibility:   { event: 'ACCESSIBILITY_RISK',       title: 'Unknown accessibility service',   body: 'A screen-reader service you may not recognise is enabled.' },
  emulator:        { event: 'EMULATOR_DETECTED',        title: 'Emulator detected',               body: 'VaultChat is running on an emulator.' },
  usbDebugging:    { event: 'USB_DEBUGGING_ON',         title: 'USB debugging enabled',           body: 'USB debugging was turned on. Turn it off when not developing.' },
  devOptions:      { event: 'DEV_OPTIONS_ON',           title: 'Developer options enabled',       body: 'Developer options were turned on.' },
  permissionRisk:  { event: 'OVERLAY_RISK',             title: 'Screen-overlay permission',       body: 'An app can draw over the screen. Open VaultChat to review.' },
  connectionIntegrity: { event: 'NETWORK_MITM',         title: 'Connection may be intercepted',   body: "VaultChat's secure connection failed a check. Switch networks and open VaultChat." },
  proxy:           { event: 'PROXY_CONFIGURED',         title: 'System proxy detected',           body: 'A network proxy is configured. Open VaultChat to review.' },
};

// Rollup rows fully covered by their own leaf rows push NOTHING (the leaf row
// already alerts — pushing both would double-notify), and Wi-Fi changes too
// often (every café) to interrupt. These still update the dashboard + score and
// are still recorded; they just never fire a notification.
const SILENT_FACTORS = new Set<string>(['deviceIntegrity', 'runtimeProtection', 'network', 'wifiSecurity']);

function copyFor(factorKey: string): { event: string; title: string; body: string } {
  return COPY[factorKey] ?? { event: 'SECURITY_STATE_CHANGED', title: 'Device security changed', body: 'A device-security indicator changed. Open VaultChat to review.' };
}

function severityOf(status: FactorStatus): NotifySeverity | null {
  if (status === 'critical') return 'critical';
  if (status === 'warning') return 'warning';
  return null;
}

/**
 * Decide notifications for a scan's diff. Returns the notifications to send plus
 * the updated last-sent map to persist. `scanEvent` (the always-logged "scan
 * completed" record) is deliberately NOT returned here — it's a silent audit
 * entry, not a push — keeping this function strictly about what interrupts the user.
 */
export function decideNotifications(
  diff: PostureDiff,
  next: PostureSnapshot,
  ctx: PolicyContext,
): PolicyResult {
  const lastSent: Record<string, number> = { ...ctx.lastSent };
  const out: SecurityNotification[] = [];

  const fire = (key: string, severity: NotifySeverity, event: string, title: string, body: string, factorKey?: string) => {
    // An event never sent (no entry) always fires; only a real prior send starts
    // a cooldown. Using `?? 0` here would wrongly cool down against epoch 0 at
    // small clock values — an absent entry means "never", not "sent in 1970".
    const last = lastSent[key];
    if (last !== undefined && ctx.now - last < COOLDOWN_MS[severity]) return;
    lastSent[key] = ctx.now;
    out.push({ key, severity, event, title, body, factorKey });
  };

  // 1. Edge-triggered factor worsenings (warning/critical floor).
  for (const d of diff.factorDeltas) {
    if (d.direction !== 'worsened') continue;
    if (SILENT_FACTORS.has(d.key)) continue;      // dashboard-only rows never push
    const severity = severityOf(d.to);
    if (!severity) continue;
    const c = copyFor(d.key);
    fire(d.key, severity, c.event, c.title, c.body, d.key);
  }

  // 2. Significant score change: band worsened AND the jump clears the margin.
  //    A single event, separate cooldown, so a climbing score is announced once.
  const jump = ctx.scoreJump ?? SCORE_JUMP_DEFAULT;
  if (diff.bandWorsened && diff.scoreDelta >= jump) {
    fire('score', 'warning', 'SECURITY_SCORE_CHANGED', 'Security risk increased',
      `Your device risk rose to ${next.band}. Open VaultChat to review.`);
  }

  return { notifications: out, lastSent };
}
