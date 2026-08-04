// services/security/deviceSecurity/viewModel.ts — dashboard presentation logic.
//
// Pure mapping from a PostureSnapshot to everything the Security Hub screen
// renders: the score ring, the band header, the factor rows (with per-status
// colour + label), the ranked "Recommended actions" list, and the last-scan
// text. Keeping this out of the .tsx keeps the screen a thin renderer and — like
// the rest of this module — makes the UI's logic Node-testable (viewModel.selftest.ts)
// even though the pixels can't be. `now` is passed in so time formatting stays
// deterministic.

import { BAND_META, REMEDIATION, type RiskBand } from './riskEngine';
import type { FactorStatus, Platform, PostureSnapshot } from './posture';

export interface StatusMeta { label: string; color: string; }

// Per-status presentation. Colours match the palette used across the security
// screens (auditChain/alerts). Severity order is encoded in RANK for sorting.
export const STATUS_META: Record<FactorStatus, StatusMeta> = {
  critical:       { label: 'Critical',       color: '#EF4444' },
  warning:        { label: 'Warning',        color: '#F59E0B' },
  clear:          { label: 'Clear',          color: '#34D399' },
  pending:        { label: 'Not evaluated',  color: '#9CA3AF' },
  not_applicable: { label: 'N/A',            color: '#6B7280' },
};

const RANK: Record<FactorStatus, number> = {
  critical: 4, warning: 3, pending: 2, clear: 1, not_applicable: 0,
};

export interface FactorRow {
  key: string;
  label: string;
  status: FactorStatus;
  statusLabel: string;
  statusColor: string;
  detail: string;
}

export interface ActionItem {
  key: string;
  text: string;
  severity: 'warning' | 'critical';
}

export interface DashboardVM {
  hasScanned: boolean;
  score: number | null;
  band: RiskBand | null;
  bandLabel: string;
  bandColor: string;
  bandBlurb: string;
  ringPct: number;          // 0..1 fill fraction (risk score / 100)
  factors: FactorRow[];
  actions: ActionItem[];
  lastScanText: string;
  platform: Platform | null;
}

const UNKNOWN_BAND = { color: '#9CA3AF', label: 'Not scanned', blurb: 'Run a device scan to evaluate this device.' };

/**
 * Build the full dashboard view model. When `snapshot` is null (never scanned),
 * returns an honest empty state — never a fabricated score.
 */
export function buildDashboardViewModel(snapshot: PostureSnapshot | null, now: number): DashboardVM {
  if (!snapshot) {
    return {
      hasScanned: false,
      score: null, band: null,
      bandLabel: UNKNOWN_BAND.label, bandColor: UNKNOWN_BAND.color, bandBlurb: UNKNOWN_BAND.blurb,
      ringPct: 0, factors: [], actions: [],
      lastScanText: 'Not scanned yet', platform: null,
    };
  }

  const meta = BAND_META[snapshot.band];
  const factors: FactorRow[] = snapshot.factors.map((f) => ({
    key: f.key,
    label: f.label,
    status: f.status,
    statusLabel: STATUS_META[f.status].label,
    statusColor: STATUS_META[f.status].color,
    detail: f.detail,
  }));

  // Recommended actions: one per warning/critical factor that maps to remediation
  // copy, ranked most-severe first, de-duplicated by text so a rollup row and its
  // specific row don't repeat the same advice.
  const seenText = new Set<string>();
  const actions: ActionItem[] = snapshot.factors
    .filter((f) => (f.status === 'warning' || f.status === 'critical') && f.signalType && REMEDIATION[f.signalType])
    .sort((a, b) => RANK[b.status] - RANK[a.status])
    .map((f) => ({ key: f.key, severity: f.status as 'warning' | 'critical', text: REMEDIATION[f.signalType as string] }))
    .filter((a) => (seenText.has(a.text) ? false : (seenText.add(a.text), true)));

  return {
    hasScanned: true,
    score: snapshot.score,
    band: snapshot.band,
    bandLabel: meta.label,
    bandColor: meta.color,
    bandBlurb: meta.blurb,
    ringPct: Math.max(0, Math.min(1, snapshot.score / 100)),
    factors,
    actions,
    lastScanText: relativeTime(snapshot.scannedAt, now),
    platform: snapshot.platform,
  };
}

/** Human "N ago" for the last-scan line. Pure — `now` is supplied. */
export function relativeTime(ts: number, now: number): string {
  const s = (now - ts) / 1000;
  if (s < 60) return 'just now';
  const m = s / 60; if (m < 60) return `${Math.floor(m)}m ago`;
  const h = m / 60; if (h < 24) return `${Math.floor(h)}h ago`;
  const d = h / 24; if (d < 7) return `${Math.floor(d)}d ago`;
  return new Date(ts).toLocaleDateString();
}
