// constants/gatePalette.ts — the fixed colours of the app's system gates:
// components/TermsGate, components/UpdateGate and the root
// components/ErrorBoundary fallback.
//
// WHY THESE ARE FIXED, NOT THEME TOKENS
// - UpdateGate may be the only screen a user ever sees from a broken or
//   out-of-date build, so it must not depend on theme code that could itself be
//   the out-of-date part.
// - TermsGate is a system surface shown over everything, before the themed
//   shell has necessarily loaded; it is always dark like the other gates.
// - ErrorBoundary renders after the tree threw, possibly inside ThemeProvider,
//   so it must read no context at all. This module (and constants/theme, which
//   it imports) is plain data with no imports of its own beyond that.
//
// Every text/ground pair here is held to WCAG AA (4.5:1 text, 3:1 icons) by
// constants/paletteContrast.selftest.ts. Round 7 raised the three that failed:
// the lavender #9D6FD0 under white button labels (3.74:1 → BRAND_VIOLET 4.69:1),
// TermsGate's foot note #75728A (4.08:1 → #85829A 5.09:1) and UpdateGate's build
// line at 0.38 alpha (3.35:1 → 0.55, 5.91:1).

import { BRAND_VIOLET, FALLBACK_GROUND } from './theme';

/** components/TermsGate — the recorded terms acceptance. */
export const TERMS_GATE = {
  ground: '#0F1115',
  title: '#F2F2F6',
  body: '#A5A2B5',
  /** Icon disc and the "I agree" button. */
  accent: BRAND_VIOLET,
  onAccent: '#FFFFFF',
  linkFill: '#171A21',
  linkStroke: '#242833',
  linkText: '#E7E9EE',
  linkIcon: '#B48CE8',
  linkOpenIcon: '#8A879B',
  error: '#F1737A',
  foot: '#85829A',
} as const;

/** components/UpdateGate — the blocking screen and the soft "update" bar. */
export const UPDATE_GATE = {
  ground: '#0A0A0F',
  title: '#F6F7F9',
  body: 'rgba(246,247,249,0.72)',
  meta: 'rgba(246,247,249,0.55)',
  /** Faint disc behind the icon: BRAND_VIOLET at 18%. */
  iconDisc: 'rgba(140,73,252,0.18)',
  onIconDisc: '#FFFFFF',
  accent: BRAND_VIOLET,
  onAccent: '#FFFFFF',
  bar: '#6D4AA8',
  onBar: '#FFFFFF',
  onBarDim: 'rgba(255,255,255,0.8)',
} as const;

/** components/ErrorBoundary — the crash fallback. Context-free by design. */
export const CRASH_SCREEN = {
  ground: FALLBACK_GROUND,
  title: '#FF3C6E',
  body: '#888888',
  button: '#00E5FF',
  onButton: '#000000',
} as const;
