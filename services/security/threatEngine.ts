/**
 * Threat-assessment engine — graded, multi-indicator self-destruct decision.
 *
 * The old securityService wiped all keys on ANY single detected threat. This
 * engine widens that: each indicator carries a severity, several weaker
 * indicators COMBINE toward a wipe, and a single `critical` indicator (root,
 * Frida, registered duress PIN…) still wipes instantly. Response is graded —
 * clean / monitor / restrict / wipe — so weak signals (emulator, ADB) can
 * block access without nuking data, while combinations escalate.
 *
 * Pure (no RN imports) → Node-tested in threatEngine.selftest.ts. The native
 * signal collection lives in securityService.ts; this module only decides.
 */

export type Severity = 'low' | 'medium' | 'high' | 'critical';
export type ResponseLevel = 'clean' | 'monitor' | 'restrict' | 'wipe';

export interface ThreatSignal {
  type: string;        // e.g. 'ROOT_DETECTED'
  severity: Severity;
  detail?: string;
}

export interface Assessment {
  level: ResponseLevel;
  score: number;
  hasCritical: boolean;
  signals: ThreatSignal[];
  reasons: string[];
}

export interface ThreatPolicy {
  weights: Record<Severity, number>;
  restrictAt: number; // score ≥ this → restrict
  wipeAt: number;     // score ≥ this (or any critical) → wipe
}

export const DEFAULT_POLICY: ThreatPolicy = {
  // A single 'high' restricts; two 'high' (or high+medium+low…) wipes.
  weights: { low: 1, medium: 3, high: 7, critical: 1000 },
  restrictAt: 5,
  wipeAt: 12,
};

/** Decide the response for a set of detected signals. Pure + deterministic. */
export function assessThreats(signals: ThreatSignal[], policy: ThreatPolicy = DEFAULT_POLICY): Assessment {
  const valid = signals.filter((s) => s && policy.weights[s.severity] != null);
  const score = valid.reduce((sum, s) => sum + policy.weights[s.severity], 0);
  const hasCritical = valid.some((s) => s.severity === 'critical');

  let level: ResponseLevel;
  if (hasCritical || score >= policy.wipeAt) level = 'wipe';
  else if (score >= policy.restrictAt) level = 'restrict';
  else if (valid.length > 0) level = 'monitor';
  else level = 'clean';

  return {
    level,
    score,
    hasCritical,
    signals: valid,
    reasons: valid.map((s) => `${s.type}(${s.severity})${s.detail ? ': ' + s.detail : ''}`),
  };
}

/**
 * Default severity for the known device-integrity threat types. Root/Frida and
 * the duress PIN stay `critical` (instant wipe — at least as protective as the
 * old behaviour); emulator/ADB are graded so they restrict alone but escalate
 * in combination. Unknown types default to 'high'.
 */
const SEVERITY_BY_TYPE: Record<string, Severity> = {
  ROOT_DETECTED:        'critical',
  MAGISK_DETECTED:      'critical',
  SU_BINARY_FOUND:      'critical',
  FRIDA_PORT_27042:     'critical',
  FRIDA_SERVER_RESPONSE:'critical',
  HOOK_FRAMEWORK:       'critical',
  DURESS_PIN:           'critical',
  DURESS_PIN_REPEATED:  'critical',
  DEBUGGER_ATTACHED:    'high',
  TEST_KEYS_BUILD:      'high',
  EMULATOR_DETECTED:    'high',
  ADB_ENABLED:          'medium',
  OVERLAY_DETECTED:     'high',
  SUSPICIOUS_IME:       'high',
  PIN_BRUTEFORCE:       'high',
};

export function severityFor(type: string): Severity {
  return SEVERITY_BY_TYPE[type] ?? 'high';
}

/** Convenience: build a signal from a known type (auto-severity) + detail. */
export function signal(type: string, detail?: string, severity?: Severity): ThreatSignal {
  return { type, severity: severity ?? severityFor(type), detail };
}
