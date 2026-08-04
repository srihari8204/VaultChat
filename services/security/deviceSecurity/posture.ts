// services/security/deviceSecurity/posture.ts — dashboard posture model + diff.
//
// Turns a raw riskEngine assessment into the fixed, ordered list of factor rows
// the Security Hub dashboard renders (Device Integrity, Root, Frida, USB
// debugging, …), and diffs one posture snapshot against the previous one so the
// monitoring layer can tell what CHANGED — which is what drives notifications.
//
// PURE — no React-Native imports (persistence lives in a thin store layer that
// wraps this). Timestamps and platform are passed IN so the module stays
// deterministic and Node-testable (posture.selftest.ts). Same contract as
// riskEngine.ts.
//
// Honesty rule carried through: a factor the collectors could not evaluate this
// run is `pending` (shown as "Not evaluated"), and a factor that doesn't apply
// to the OS is `not_applicable` (e.g. USB debugging on iOS) — neither is ever
// rendered as "clear/safe".

import {
  BAND_CUTOFFS, type RiskAssessment, type RiskBand, type SecuritySignalType,
} from './riskEngine';

export type FactorStatus = 'clear' | 'warning' | 'critical' | 'pending' | 'not_applicable';
export type Platform = 'android' | 'ios' | 'web';

export interface PostureFactor {
  key: string;
  label: string;
  status: FactorStatus;
  detail: string;
  /** The detected signal type that set a warning/critical status, if any. */
  signalType?: SecuritySignalType;
}

export interface PostureSnapshot {
  score: number;            // 0–100 risk
  band: RiskBand;
  factors: PostureFactor[];
  detectedTypes: SecuritySignalType[];
  scannedAt: number;        // epoch ms — supplied by the caller
  platform: Platform;
}

interface FactorDef {
  key: string;
  label: string;
  signalTypes: SecuritySignalType[];
  androidOnly?: boolean;    // hidden as not_applicable on iOS/web
}

// The dashboard's canonical rows, in render order. Rollup rows (deviceIntegrity,
// runtimeProtection, appIntegrity) summarise several signals as the WORST of
// their members; the specific rows below them let the user see exactly which.
const FACTOR_CATALOG: FactorDef[] = [
  { key: 'deviceIntegrity',   label: 'Device integrity',      signalTypes: ['ROOT_DETECTED', 'JAILBREAK_DETECTED', 'SU_BINARY_FOUND', 'MAGISK_DETECTED', 'EMULATOR_DETECTED'] },
  { key: 'runtimeProtection', label: 'Runtime protection',    signalTypes: ['FRIDA_DETECTED', 'DEBUGGER_ATTACHED', 'HOOK_FRAMEWORK'] },
  { key: 'appIntegrity',      label: 'Application integrity', signalTypes: ['APK_RESIGNED', 'APK_UNOFFICIAL', 'INTEGRITY_VERDICT_FAILED'] },
  { key: 'root',              label: 'Root / jailbreak',      signalTypes: ['ROOT_DETECTED', 'JAILBREAK_DETECTED', 'SU_BINARY_FOUND', 'MAGISK_DETECTED'] },
  { key: 'frida',             label: 'Frida / instrumentation', signalTypes: ['FRIDA_DETECTED'] },
  { key: 'debugger',          label: 'Debugger',              signalTypes: ['DEBUGGER_ATTACHED'] },
  { key: 'hooks',             label: 'Xposed / LSPosed',      signalTypes: ['HOOK_FRAMEWORK'] },
  { key: 'emulator',          label: 'Emulator',              signalTypes: ['EMULATOR_DETECTED'] },
  { key: 'devOptions',        label: 'Developer options',     signalTypes: ['DEV_OPTIONS_ON'], androidOnly: true },
  { key: 'usbDebugging',      label: 'USB debugging',         signalTypes: ['USB_DEBUGGING_ON'], androidOnly: true },
  { key: 'accessibility',     label: 'Accessibility risk',    signalTypes: ['ACCESSIBILITY_RISK'], androidOnly: true },
  { key: 'permissionRisk',    label: 'Permission / overlay risk', signalTypes: ['OVERLAY_RISK', 'HIGH_POWER_APP'], androidOnly: true },
  { key: 'network',           label: 'Network protection',    signalTypes: ['NETWORK_MITM', 'PROXY_CONFIGURED', 'OPEN_WIFI'] },
  { key: 'connectionIntegrity', label: 'Connection integrity', signalTypes: ['NETWORK_MITM'] },
  { key: 'proxy',             label: 'System proxy',          signalTypes: ['PROXY_CONFIGURED'] },
  { key: 'wifiSecurity',      label: 'Wi-Fi security',        signalTypes: ['OPEN_WIFI'], androidOnly: true },
];

const STATUS_RANK: Record<FactorStatus, number> = {
  critical: 4, warning: 3, pending: 2, clear: 1, not_applicable: 0,
};

export interface BuildOptions {
  /** Signal types the collectors actually evaluated this run. */
  evaluatedTypes: SecuritySignalType[];
  /** Signal types the collectors could NOT evaluate this run. */
  pendingTypes?: SecuritySignalType[];
  platform: Platform;
  scannedAt: number;
}

/**
 * Assemble the dashboard snapshot from a risk assessment. Leaf-factor status is
 * derived from the assessment's own per-signal contribution points (≥ the `high`
 * cutoff → critical, any detection below → warning), so the dashboard and the
 * score never disagree about severity. Rollup rows take the worst member status.
 */
export function buildSnapshot(assessment: RiskAssessment, opts: BuildOptions): PostureSnapshot {
  const evaluated = new Set(opts.evaluatedTypes ?? []);
  const pending = new Set(opts.pendingTypes ?? []);
  const isIOSlike = opts.platform !== 'android';

  // type → counted points detected this run (for severity of leaf factors)
  const counted = new Map<string, number>();
  for (const c of assessment.contributions) {
    counted.set(c.type, Math.max(counted.get(c.type) ?? 0, c.counted));
  }

  const factorFor = (def: FactorDef): PostureFactor => {
    if (def.androidOnly && isIOSlike) {
      return { key: def.key, label: def.label, status: 'not_applicable', detail: 'Not available on this platform.' };
    }
    // Best (worst-severity) detected member wins.
    let hitType: SecuritySignalType | undefined;
    let hitPoints = -1;
    for (const t of def.signalTypes) {
      if (counted.has(t) && (counted.get(t) as number) > hitPoints) {
        hitPoints = counted.get(t) as number;
        hitType = t;
      }
    }
    if (hitType) {
      const status: FactorStatus = hitPoints >= BAND_CUTOFFS.high ? 'critical' : 'warning';
      return { key: def.key, label: def.label, status, detail: detailFor(status, def.label), signalType: hitType };
    }
    // Not detected: clear only if every member type was actually evaluated.
    const allEvaluated = def.signalTypes.every((t) => evaluated.has(t));
    const anyPending = def.signalTypes.some((t) => pending.has(t)) || !allEvaluated;
    if (anyPending) {
      return { key: def.key, label: def.label, status: 'pending', detail: 'Not evaluated this scan.' };
    }
    return { key: def.key, label: def.label, status: 'clear', detail: 'No indicators found.' };
  };

  const factors = FACTOR_CATALOG.map(factorFor);

  return {
    score: assessment.score,
    band: assessment.band,
    factors,
    detectedTypes: assessment.contributions.map((c) => c.type),
    scannedAt: opts.scannedAt,
    platform: opts.platform,
  };
}

function detailFor(status: FactorStatus, label: string): string {
  if (status === 'critical') return `${label}: indicator detected.`;
  if (status === 'warning') return `${label}: minor indicator present.`;
  return '';
}

// ─── Diff: what changed since the previous snapshot ──────────────────────────

export interface FactorDelta {
  key: string;
  label: string;
  from: FactorStatus;
  to: FactorStatus;
  direction: 'worsened' | 'improved';
  signalType?: SecuritySignalType;
}

export interface PostureDiff {
  factorDeltas: FactorDelta[];
  worsened: boolean;         // any factor moved to a more severe status
  bandChanged: boolean;
  bandWorsened: boolean;
  scoreDelta: number;        // next.score − prev.score (positive = riskier)
}

const BAND_RANK: Record<RiskBand, number> = { low: 0, medium: 1, high: 2, critical: 3 };

/**
 * Compare two snapshots. Only status TRANSITIONS produce deltas (edge-triggered),
 * so a standing condition doesn't re-fire every scan. `prev` null (first ever
 * scan) yields no deltas but reports the band/score as a baseline.
 */
export function diffSnapshots(prev: PostureSnapshot | null, next: PostureSnapshot): PostureDiff {
  if (!prev) {
    return { factorDeltas: [], worsened: false, bandChanged: false, bandWorsened: false, scoreDelta: next.score };
  }
  const prevByKey = new Map(prev.factors.map((f) => [f.key, f]));
  const factorDeltas: FactorDelta[] = [];
  for (const f of next.factors) {
    const p = prevByKey.get(f.key);
    if (!p || p.status === f.status) continue;
    const worse = STATUS_RANK[f.status] > STATUS_RANK[p.status];
    // Ignore pending↔clear churn as a "change" the user cares about: moving
    // between "not evaluated" and "clear" is noise, not a security transition.
    const noisy = (isBenign(p.status) && isBenign(f.status));
    if (noisy) continue;
    factorDeltas.push({
      key: f.key, label: f.label, from: p.status, to: f.status,
      direction: worse ? 'worsened' : 'improved', signalType: f.signalType,
    });
  }
  const worsened = factorDeltas.some((d) => d.direction === 'worsened');
  const bandChanged = prev.band !== next.band;
  const bandWorsened = BAND_RANK[next.band] > BAND_RANK[prev.band];
  return { factorDeltas, worsened, bandChanged, bandWorsened, scoreDelta: next.score - prev.score };
}

function isBenign(s: FactorStatus): boolean {
  return s === 'clear' || s === 'pending' || s === 'not_applicable';
}

/** The dashboard's fixed factor keys, in render order (for UI + tests). */
export function factorKeys(): string[] {
  return FACTOR_CATALOG.map((d) => d.key);
}
