// services/security/securityScore.ts — honest, signal-derived security score.
//
// Replaces the old hardcoded "97/100" in aiguardian.tsx. Every factor here is a
// real, checkable property of the device/account. We never invent a number:
// the score is the share of *applicable* factor weight that actually passes,
// and a factor we can't yet evaluate (e.g. integrity before any scan) is marked
// `pending` and excluded from the denominator rather than assumed good.

import * as SecureStore from 'expo-secure-store';
import * as pinStore from './pinStore';
import { E2EE_ENABLED } from '../../constants/flags';
import { listSecurityEvents } from './auditChain';

export interface SecurityFactor {
  key: string;
  label: string;
  weight: number;
  ok: boolean;
  pending: boolean;   // can't evaluate yet (e.g. no scan run) → excluded from score
  detail: string;
}

export interface SecurityScore {
  score: number | null;   // 0–100, or null when nothing is evaluable yet
  grade: 'strong' | 'good' | 'fair' | 'weak' | 'unknown';
  factors: SecurityFactor[];
  lastScanAt: number | null;
}

async function hasAppPin(): Promise<boolean> {
  // One PIN system now (services/security/pinStore), which still reports true
  // for an install that hasn't been migrated off either legacy key yet.
  return pinStore.hasPin();
}

export async function computeSecurityScore(): Promise<SecurityScore> {
  const [pinSet, events] = await Promise.all([
    hasAppPin(),
    listSecurityEvents(50),
  ]);

  const lastScan = events.find((e) => e.type === 'DEVICE_SCAN');
  const scanClean: boolean | null = lastScan ? (lastScan.meta?.level === 'clean') : null;
  const threatCount: number = lastScan?.meta?.threats?.length ?? 0;

  const factors: SecurityFactor[] = [
    {
      key: 'e2ee',
      label: 'End-to-end encryption',
      weight: 35,
      ok: E2EE_ENABLED,
      pending: false,
      detail: E2EE_ENABLED
        ? 'Direct chats are end-to-end encrypted (X3DH + Double Ratchet).'
        : 'End-to-end encryption is currently off.',
    },
    {
      key: 'lock',
      label: 'App lock / PIN',
      weight: 30,
      ok: pinSet,
      pending: false,
      detail: pinSet
        ? 'A PIN protects access to this app.'
        : 'No app PIN is set — add one in Settings → Security.',
    },
    {
      key: 'integrity',
      label: 'Device integrity',
      weight: 35,
      ok: scanClean === true,
      pending: scanClean === null,
      detail: scanClean === null
        ? 'Not scanned yet — run a device scan to evaluate this.'
        : scanClean
          ? 'Last scan found no root, instrumentation, or tampering indicators.'
          : `Last scan flagged ${threatCount} issue${threatCount === 1 ? '' : 's'}. See Alerts.`,
    },
  ];

  const applicable = factors.filter((f) => !f.pending);
  const totalWeight = applicable.reduce((s, f) => s + f.weight, 0);
  const earned = applicable.filter((f) => f.ok).reduce((s, f) => s + f.weight, 0);
  const score = totalWeight > 0 ? Math.round((earned / totalWeight) * 100) : null;

  let grade: SecurityScore['grade'];
  if (score === null) grade = 'unknown';
  else if (score >= 90) grade = 'strong';
  else if (score >= 70) grade = 'good';
  else if (score >= 45) grade = 'fair';
  else grade = 'weak';

  return { score, grade, factors, lastScanAt: lastScan?.ts ?? null };
}
