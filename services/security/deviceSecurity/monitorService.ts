// services/security/deviceSecurity/monitorService.ts — the monitoring entry point.
//
// ⚠️ DEVICE-ONLY (transitively imports react-native via postureStore/notifee):
// not run under the Node self-tests. The single place that turns a TRIGGER
// (app launch, foreground return, periodic job, user "Scan now", OS tripwire)
// into a scan-if-due plus its two side effects — recording to the audit chain
// and presenting notifications — so the screen and the background paths share
// one code path and can't drift.
//
// The scan-if-due decision (scanScheduler) and everything it feeds are pure and
// Node-tested; this file only wires them to the real store, clock, audit chain
// and notifee. It owns NO destructive behaviour (no wipe) — that lives in the
// separate boot-time securityService.

import { appendSecurityEvent, type AuditSeverity } from '../auditChain';
import { getCurrentSnapshot, scanDevice } from './postureStore';
import { decideScan, type ScanTrigger } from './scanScheduler';
import { presentSecurityNotifications } from './securityNotifications';
import type { ScanOutcome } from './orchestrator';
import type { SecurityNotification } from './notificationPolicy';

export interface MonitorResult {
  scanned: boolean;
  reason: string;
  outcome?: ScanOutcome;
}

function auditSeverity(n: SecurityNotification): AuditSeverity {
  return n.severity === 'critical' ? 'critical' : 'medium';
}

/** Record the scan's notifications + a scan-completed trace into the audit chain. */
async function recordOutcome(outcome: ScanOutcome): Promise<void> {
  for (const n of outcome.notifications) {
    appendSecurityEvent({
      type: n.event,
      severity: auditSeverity(n),
      title: n.title,
      detail: n.body,
      meta: { factorKey: n.factorKey ?? null, band: outcome.snapshot.band, score: outcome.snapshot.score },
    }).catch(() => {});
  }
  appendSecurityEvent({
    type: 'DEVICE_SCAN',
    severity: outcome.snapshot.band === 'low' ? 'info' : outcome.snapshot.band === 'critical' ? 'critical' : 'medium',
    title: `Device scan: ${outcome.snapshot.band} risk (${outcome.snapshot.score}/100)`,
    detail: 'Device-security scan completed. Clean ≠ guaranteed safe — a sandboxed app cannot see kernel-level implants.',
    meta: { band: outcome.snapshot.band, score: outcome.snapshot.score, platform: outcome.snapshot.platform },
  }).catch(() => {});
}

/**
 * Run a monitoring scan for the given trigger, if the scheduler says it's due.
 * Returns whether it scanned (and the outcome, so the Security Hub screen can
 * render immediately). Fire-and-forget safe from background/launch callers.
 */
export async function runMonitoringScan(trigger: ScanTrigger): Promise<MonitorResult> {
  const prev = await getCurrentSnapshot().catch(() => null);
  const decision = decideScan(trigger, prev?.scannedAt ?? null, Date.now());
  if (!decision.shouldScan) return { scanned: false, reason: decision.reason };

  const outcome = await scanDevice();
  await recordOutcome(outcome);
  await presentSecurityNotifications(outcome.notifications);
  return { scanned: true, reason: decision.reason, outcome };
}
