// constants/businessTheme.ts — palette for the Business space mini-app.
//
// The VaultChat Business design system (see the Business Dashboard reference)
// is blue-on-navy and dark-only, distinct from the app-wide lavender brand.
// Like financeTheme.ts it is a STATIC palette: every business screen renders
// identically regardless of the device theme, because the design specifies the
// surfaces exactly and forbids white backgrounds.
//
// Shaped as a `Palette` so the existing space screens — all written as
// `styles(colors)` over that interface — re-skin through lib/spaces/theme.ts
// without any per-screen style changes. School/family/generic spaces keep the
// app palette; the routing lives in useSpaceColors(), not here.

import type { Palette } from './theme';

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
  tickRead:      '#FFFFFF',
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
};

// The design system's status colors that Palette has no slot for. Fixed by
// spec: orange = leave/pending/warning, teal = live location, gray = inactive.
export const BIZ_WARN = '#F59E0B';
export const BIZ_TEAL = '#14B8A6';
export const BIZ_GRAY = '#64748B';
// Secondary card surface (nested/inner cards on a BIZ.card background).
export const BIZ_CARD2 = '#0D2030';
