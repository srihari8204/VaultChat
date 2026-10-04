// constants/businessTheme.ts — palette for the Business space mini-app.
//
// The VaultChat Business design system (see the Business Dashboard reference)
// uses blue identity accents, distinct from the app-wide lavender brand.
// BIZ remains the legacy static navy palette; businessPalette combines its
// identity with the active app theme for operational space screens.
//
// Shaped as a `Palette` so the existing space screens — all written as
// `styles(colors)` over that interface — re-skin through lib/spaces/theme.ts
// without any per-screen style changes. School/family/generic spaces keep the
// app palette; the routing lives in useSpaceColors(), not here.

import type { Palette } from './theme';

/** Keep Business blue while surfaces and text follow the app's day/night setting. */
export function businessPalette(base: Palette, scheme: 'light' | 'dark'): Palette {
  return {
    ...base,
    primary: scheme === 'light' ? BIZ.brandOnLight : BIZ.primary,
    accent: BIZ.accent,
    purple: BIZ.purple,
    accentLight: BIZ.accentLight,
    accentDeep: BIZ.accentDeep,
    accentOn: scheme === 'light' ? BIZ.brandOnLight : BIZ.accentOn,
    brandOnLight: BIZ.brandOnLight,
  };
}

export const BIZ: Palette = {
  primary: '#1677FF',   // VaultChat Business blue
  accent:  '#2563EB',   // secondary blue
  purple:  '#8B5CF6',   // management / analytics
  danger:  '#EF4444',   // error / overdue / declined
  success: '#16C784',   // online / checked in / approved
  online:  '#16C784',

  bg:           '#020B16', // deep navy, the darkest value
  surface:      'rgba(255,255,255,0.05)',
  surfaceSolid: '#102638',
  card:         '#0B1B2A',
  border:       'rgba(255,255,255,0.06)',
  separator:    'rgba(255,255,255,0.06)',
  text:      '#FFFFFF',
  textDim:   '#CBD5E1', // secondary text (spec §2)
  textFaint: '#94A3B8', // muted text (spec §2)

  // Palette requires the chat surface; business screens do not chat, but a
  // space type that ever renders one gets blue-on-navy rather than a crash.
  chatBg:        '#020B16',
  bubbleIn:      '#0D2030',
  bubbleOut:     '#1677FF',
  bubbleInText:  '#ECEDEE',
  bubbleOutText: '#FFFFFF',
  bubbleMetaIn:  'rgba(255,255,255,0.45)',
  bubbleMetaOut: 'rgba(255,255,255,0.75)',
  tickRead:      '#7CFFB2',   // same read-tick mint as constants/theme.ts
  headerBar:     '#0B1B2A',

  // Aurora Glass roles, in Business blue-on-navy. Business screens are dark-only
  // and specify their surfaces exactly, so these stay navy rather than lavender.
  glass:       'rgba(255,255,255,0.08)',
  glassSoft:   'rgba(255,255,255,0.05)',
  glassStroke: 'rgba(255,255,255,0.14)',
  hairline:    'rgba(255,255,255,0.06)',
  groundDisc:  '#0D2030',
  accentLight: '#7DD3FC',
  accentDeep:  '#1677FF',
  accentOn:    '#7DD3FC',
  brandOnLight:'#1552E0',
  onPrimary:   '#FFFFFF',   // as today; see constants/theme.ts AuroraDark note
  onDanger:    '#FFFFFF',
  warning:     '#F59E0B',   // = BIZ_WARN; 9.21:1 on bg, 7.21:1 on surfaceSolid
  scrim:       'rgba(0,0,0,0.6)',
  caution:     '#FBBF24',   // ≥9.2:1 on bg/card/surfaceSolid
};

// The design system's status colors that Palette has no slot for. Fixed by
// spec: orange = leave/pending/warning, teal = live location, gray = inactive.
export const BIZ_WARN = '#F59E0B';
export const BIZ_TEAL = '#14B8A6';
export const BIZ_GRAY = '#64748B';
// Secondary card surface (nested/inner cards on a BIZ.card background).
export const BIZ_CARD2 = '#0D2030';
