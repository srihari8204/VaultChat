// services/security/deviceSecurity/riskEngine.ts — device-security risk score (0–100).
//
// The pure, deterministic core of the Device Security & Monitoring module that
// replaces the "Pegasus" tile. It converts a set of detected device-integrity /
// device-state signals into a single 0–100 RISK score (higher = worse) and one
// of four bands (low/medium/high/critical).
//
// DESIGN CONTRACT (mirrors services/security/threatEngine.ts):
//   • PURE — no React-Native imports, so the EXACT same code runs in Node
//     (proven in riskEngine.selftest.ts) and in Hermes. The native signal
//     collection lives elsewhere; this module only decides.
//   • NEVER invents a verdict. A factor that cannot be evaluated yet (e.g. the
//     Play Integrity token hasn't returned) is `pending`: it carries ZERO weight
//     and is excluded from the score — never assumed safe, never assumed risky.
//     This is the same honesty rule that killed the old hardcoded "97/100".
//   • NEVER retaliates. Unlike threatEngine (which drives the boot self-destruct),
//     this engine only scores. There is no `wipe` level here by design — the
//     monitoring module observes and alerts; it does not destroy data.
//
// SCORING MODEL:
//   risk = min(100, Σ contribution), where each detected signal contributes
//   rawWeight × confidence. Signals that describe ONE underlying condition are
//   grouped into a cluster whose combined contribution is capped, so a single
//   fact (a rooted phone showing su + Magisk + root all at once) cannot be
//   triple-counted. Confidence < 1.0 marks heuristic detections (e.g. hook
//   frameworks, which a determined attacker can hide) so they weigh less than
//   deterministic ones (a mismatched signing certificate).

export type RiskBand = 'low' | 'medium' | 'high' | 'critical';

// Every signal the collectors can raise. Open-ended (a new collector may add a
// type) but the known ones are named so call-sites and the dashboard stay
// consistent. An unknown type is scored with a conservative default.
export type SecuritySignalType =
  // ── device integrity ────────────────────────────────────────────────
  | 'ROOT_DETECTED'
  | 'JAILBREAK_DETECTED'
  | 'SU_BINARY_FOUND'
  | 'MAGISK_DETECTED'
  | 'FRIDA_DETECTED'
  | 'DEBUGGER_ATTACHED'
  | 'HOOK_FRAMEWORK'          // Xposed / LSPosed / Zygisk / Riru (detail says which)
  | 'EMULATOR_DETECTED'
  | 'APK_RESIGNED'            // signing certificate != the one we shipped
  | 'APK_UNOFFICIAL'          // package name / installer source not recognised
  | 'INTEGRITY_VERDICT_FAILED'// server-verified Play Integrity / App Attest failed
  // ── device security state ───────────────────────────────────────────
  | 'ACCESSIBILITY_RISK'      // an enabled accessibility service we don't recognise
  | 'OVERLAY_RISK'            // an unknown app holding draw-over-other-apps
  | 'USB_DEBUGGING_ON'
  | 'DEV_OPTIONS_ON'
  | 'HIGH_POWER_APP'          // an app holding device-admin / notif-listener / usage-access
  | (string & {});

export interface SecuritySignal {
  type: SecuritySignalType;
  detail?: string;
  // Per-detection confidence override (0–1). When omitted, the catalog default
  // for the type is used. A collector that is unusually sure (or unsure) about a
  // single detection can tune it here without changing the catalog.
  confidence?: number;
}

interface CatalogEntry {
  weight: number;       // raw risk points this signal is worth at full confidence
  confidence: number;   // 0–1 default trust in the detection (1 = deterministic)
  label: string;        // human-readable factor name for the dashboard
  cluster?: ClusterKey; // signals in the same cluster share a capped budget
}

type ClusterKey = 'root' | 'runtime' | 'integrity';

// Combined contribution ceilings per cluster. root/runtime/integrity each
// describe ONE compromise story; without a cap, three overlapping indicators of
// the same root would sum to an absurd score. The cap is set so a single strong
// indicator already reaches `critical`, and piling on more can't inflate further.
const CLUSTER_CAP: Record<ClusterKey, number> = {
  root: 80,
  runtime: 85,
  integrity: 80,
};

// The weight/confidence table. Weights are chosen so that, at the band cutoffs
// below, the "your device is compromised" signals (root, jailbreak, active Frida,
// re-signed APK, failed attestation) reach `critical` on their own, while
// config/heuristic signals stay proportionate and only escalate in combination.
const CATALOG: Record<string, CatalogEntry> = {
  ROOT_DETECTED:            { weight: 70, confidence: 1.0, label: 'Root access',            cluster: 'root' },
  JAILBREAK_DETECTED:       { weight: 70, confidence: 1.0, label: 'Jailbreak',              cluster: 'root' },
  SU_BINARY_FOUND:          { weight: 55, confidence: 1.0, label: 'su binary present',      cluster: 'root' },
  MAGISK_DETECTED:          { weight: 45, confidence: 0.7, label: 'Magisk',                 cluster: 'root' },
  FRIDA_DETECTED:           { weight: 65, confidence: 1.0, label: 'Frida instrumentation',  cluster: 'runtime' },
  DEBUGGER_ATTACHED:        { weight: 45, confidence: 0.9, label: 'Debugger attached',      cluster: 'runtime' },
  HOOK_FRAMEWORK:           { weight: 50, confidence: 0.6, label: 'Hooking framework',      cluster: 'runtime' },
  EMULATOR_DETECTED:        { weight: 22, confidence: 0.8, label: 'Emulator' },
  APK_RESIGNED:             { weight: 70, confidence: 1.0, label: 'App re-signed',          cluster: 'integrity' },
  APK_UNOFFICIAL:           { weight: 70, confidence: 1.0, label: 'Unofficial build',       cluster: 'integrity' },
  INTEGRITY_VERDICT_FAILED: { weight: 65, confidence: 1.0, label: 'Integrity check failed', cluster: 'integrity' },
  ACCESSIBILITY_RISK:       { weight: 40, confidence: 0.9, label: 'Unknown accessibility service' },
  OVERLAY_RISK:             { weight: 30, confidence: 0.8, label: 'Screen-overlay app' },
  USB_DEBUGGING_ON:         { weight: 12, confidence: 1.0, label: 'USB debugging' },
  DEV_OPTIONS_ON:           { weight: 8,  confidence: 1.0, label: 'Developer options' },
  HIGH_POWER_APP:           { weight: 8,  confidence: 0.7, label: 'High-power app access' },
};

// Conservative default for an unrecognised signal type: treated as a real but
// heuristic finding (mid weight, reduced confidence) rather than ignored.
const DEFAULT_ENTRY: CatalogEntry = { weight: 40, confidence: 0.6, label: 'Unknown indicator' };

function entryFor(type: string): CatalogEntry {
  return CATALOG[type] ?? DEFAULT_ENTRY;
}

// Band cutoffs on the 0–100 RISK scale. A lone root (70) or Frida (65) lands in
// `critical`; a lone accessibility risk (36) or debugger (40) in `high`; a lone
// emulator (~18) or overlay (24) in `medium`; dev-options/USB alone in `low`.
export const BAND_CUTOFFS = { medium: 15, high: 35, critical: 65 } as const;

export function bandFor(score: number): RiskBand {
  if (score >= BAND_CUTOFFS.critical) return 'critical';
  if (score >= BAND_CUTOFFS.high) return 'high';
  if (score >= BAND_CUTOFFS.medium) return 'medium';
  return 'low';
}

// Presentation metadata for the four bands. Colours match the palette used
// across the security screens (auditChain/alerts/aiguardian). Kept here so the
// dashboard, the notification service and the score ring all render one band
// identically — but it is inert data; the engine never reads it.
export const BAND_META: Record<RiskBand, { label: string; color: string; blurb: string }> = {
  low:      { color: '#34D399', label: 'Low risk',      blurb: 'No security indicators were found on this device.' },
  medium:   { color: '#F59E0B', label: 'Medium risk',   blurb: 'Configuration or minor indicators are present. Review recommended.' },
  high:     { color: '#F97316', label: 'High risk',     blurb: 'A significant security indicator was detected. Act soon.' },
  critical: { color: '#EF4444', label: 'Critical risk', blurb: 'The device shows strong signs of compromise. Act now.' },
};

// Per-signal recommended action for the dashboard's "Recommended actions" list.
export const REMEDIATION: Record<string, string> = {
  ROOT_DETECTED:            'This device is rooted. Use VaultChat on an unrooted device for sensitive chats.',
  JAILBREAK_DETECTED:       'This device is jailbroken. Use VaultChat on a non-jailbroken device for sensitive chats.',
  SU_BINARY_FOUND:          'A superuser binary was found. Remove root access or switch devices.',
  MAGISK_DETECTED:          'Magisk was detected. Root hiding cannot be fully verified — treat this device as untrusted.',
  FRIDA_DETECTED:           'Instrumentation tooling is active. Close it and restart your device.',
  DEBUGGER_ATTACHED:        'A debugger is attached to VaultChat. Disconnect it.',
  HOOK_FRAMEWORK:           'A code-hooking framework may be active. Disable Xposed/LSPosed-type modules.',
  EMULATOR_DETECTED:        'VaultChat is running on an emulator. Use a physical device for real accounts.',
  APK_RESIGNED:             'This build was re-signed and is not the official VaultChat. Reinstall from the official source.',
  APK_UNOFFICIAL:           'This build is unofficial. Reinstall VaultChat from the official source.',
  INTEGRITY_VERDICT_FAILED: 'The device failed an app-integrity check. Update your OS and reinstall from the official source.',
  ACCESSIBILITY_RISK:       'An accessibility service you may not recognise is enabled. Review it in Settings → Accessibility.',
  OVERLAY_RISK:             'An app can draw over the screen. Review "Display over other apps" in Settings.',
  USB_DEBUGGING_ON:         'Turn off USB debugging in Developer options when not developing.',
  DEV_OPTIONS_ON:           'Turn off Developer options if you are not actively developing.',
  HIGH_POWER_APP:           'An app holds powerful device access. Review app permissions in Settings.',
};

export interface RiskContribution {
  type: SecuritySignalType;
  label: string;
  detail?: string;
  rawWeight: number;
  confidence: number;
  effective: number;   // rawWeight × confidence, before cluster capping
  counted: number;     // points that actually reached the score after capping
  cluster?: ClusterKey;
}

export interface ClusterSummary {
  cluster: ClusterKey;
  sum: number;     // uncapped sum of effective contributions in the cluster
  cap: number;     // the cluster ceiling
  capped: boolean; // true when sum exceeded the cap
  counted: number; // points contributed after capping
}

export interface RiskAssessment {
  score: number;                       // 0–100 risk (higher = worse)
  band: RiskBand;
  contributions: RiskContribution[];
  clusters: ClusterSummary[];
  detectedCount: number;
  pending: SecuritySignalType[];       // echoed for the dashboard; ZERO weight
  reasons: string[];
}

export interface RiskInput {
  // Types the collectors could NOT evaluate this run (e.g. iOS can't read USB
  // debugging; the Integrity token hasn't returned). Echoed as `pending` so the
  // dashboard shows "Not evaluated" — never counted as safe or risky.
  pending?: SecuritySignalType[];
}

/**
 * Score a set of detected signals. Pure + deterministic: identical input always
 * yields identical output (no clock, no randomness), so the exact score for any
 * signal set is provable in CI — a scoring regression here is a trust regression.
 */
export function assessRisk(signals: SecuritySignal[], input: RiskInput = {}): RiskAssessment {
  const valid = (signals ?? []).filter((s) => s && typeof s.type === 'string');

  // 1. Effective (pre-cap) contribution per signal.
  const contributions: RiskContribution[] = valid.map((s) => {
    const e = entryFor(s.type);
    const confidence = clamp01(s.confidence ?? e.confidence);
    const effective = e.weight * confidence;
    return {
      type: s.type,
      label: e.label,
      detail: s.detail,
      rawWeight: e.weight,
      confidence,
      effective,
      counted: effective, // adjusted below if the signal is in a capped cluster
      cluster: e.cluster,
    };
  });

  // 2. Apply per-cluster caps. Within a capped cluster we scale each member's
  //    counted points proportionally so the cluster total == cap, keeping each
  //    member's relative share (purely for transparent per-signal reporting).
  const clusters: ClusterSummary[] = [];
  for (const key of Object.keys(CLUSTER_CAP) as ClusterKey[]) {
    const members = contributions.filter((c) => c.cluster === key);
    if (members.length === 0) continue;
    const sum = members.reduce((a, c) => a + c.effective, 0);
    const cap = CLUSTER_CAP[key];
    const capped = sum > cap;
    if (capped && sum > 0) {
      const scale = cap / sum;
      for (const m of members) m.counted = m.effective * scale;
    }
    clusters.push({ cluster: key, sum, cap, capped, counted: Math.min(sum, cap) });
  }

  // 3. Total = summed counted points, clamped to [0,100] and rounded.
  const raw = contributions.reduce((a, c) => a + c.counted, 0);
  const score = Math.max(0, Math.min(100, Math.round(raw)));
  const band = bandFor(score);

  const pending = dedupe(input.pending ?? []);
  const reasons = contributions
    .slice()
    .sort((a, b) => b.counted - a.counted)
    .map((c) => `${c.type}(${Math.round(c.counted)}pt${c.confidence < 1 ? `, conf ${c.confidence}` : ''})${c.detail ? ': ' + c.detail : ''}`);

  return { score, band, contributions, clusters, detectedCount: valid.length, pending, reasons };
}

/** Convenience: build a signal from a type (+ optional detail / confidence). */
export function riskSignal(type: SecuritySignalType, detail?: string, confidence?: number): SecuritySignal {
  return { type, detail, confidence };
}

function clamp01(n: number): number {
  if (!Number.isFinite(n)) return 0;
  return n < 0 ? 0 : n > 1 ? 1 : n;
}
function dedupe<T>(xs: T[]): T[] {
  return Array.from(new Set(xs));
}
