// constants/financeTheme.ts — palette + tokens for the Vault Finance hub.
//
// Vault Finance uses a light, lavender-branded surface (matching the concept
// mockups) built on the app's real BRAND_ACCENT so it stays on-brand. Kept as a
// static palette (like the original calculator) so every finance screen renders
// identically and never depends on the theme hook.

import { BRAND_ACCENT } from './theme';

export const FIN = {
  brand:      BRAND_ACCENT,   // #9D6FD0 lavender
  brandDeep:  '#6D3FA8',
  brandSoft:  '#EFE7FA',
  accent:     '#7C3AED',

  good:       '#16A34A',      // lent / positive
  goodSoft:   '#DCFCE7',
  bad:        '#DC2626',      // borrowed / overdue
  badSoft:    '#FEE2E2',
  warn:       '#D97706',      // pending / due
  warnSoft:   '#FEF3C7',
  info:       '#2563EB',
  infoSoft:   '#DBEAFE',

  bg:         '#F5F3FA',      // app surface (light plum)
  card:       '#FFFFFF',
  card2:      '#F4F0FA',
  border:     '#E7E2EE',
  line:       '#EFEAF5',

  text:       '#171320',
  sub:        '#6B6478',
  faint:      '#9A93A8',
  onBrand:    '#FFFFFF',
} as const;

export type LedgerStatus = 'running' | 'overdue' | 'completed';

export const STATUS_COLORS: Record<LedgerStatus, { fg: string; bg: string; label: string }> = {
  running:   { fg: FIN.good, bg: FIN.goodSoft, label: 'Running' },
  overdue:   { fg: FIN.bad,  bg: FIN.badSoft,  label: 'Overdue' },
  completed: { fg: FIN.sub,  bg: FIN.card2,    label: 'Completed' },
};

export default FIN;
