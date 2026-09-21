// constants/glass.ts — Aurora Glass surface recipes (U8).
//
// WHAT THE PALETTE DOES NOT CARRY
// -------------------------------
// `Palette` owns the COLOURS of glass: `glass`, `glassSoft`, `glassStroke`.
// It does not own the RECIPE — how much blur a surface class gets, whether it
// wears the lip highlight, how deep its shadow sits. Those numbers had been
// scattered as literals (`intensity={40}` in one file, `intensity={48}` in the
// next, `shadowRadius: 28` in the tab bar) and had already drifted apart.
// This is the one table they come from now, and it is the same table the
// Figma effect styles were built from, so a designer and an engineer read one
// list:
//
//   Figma "VaultChat — Aurora Glass UI" › 01 · Foundations › Glass surfaces
//   Glass/Chrome ↔ GLASS.chrome     Glass/Card  ↔ GLASS.card
//   Glass/Chip   ↔ GLASS.chip       Glass/Sheet ↔ GLASS.sheet
//   Glow/Accent  ↔ GLOW.accent      Elevation/FAB ↔ GLOW.fab
//
// THE RULE THAT KEEPS IT FAST
// ---------------------------
// Real blur is spent only on chrome that floats over MOVING content: the tab
// bar, the chat header, the composer, bottom sheets. `card` and `chip` are the
// recipe for the flat translucent look (fill + hairline + lip + shadow) and
// take NO blur pass by default — GlassCard opts one hero surface in per
// screen, never a list row. A blur per row is what makes glassmorphism feel
// cheap and drop frames, and it is the one thing this module refuses to
// make easy.

import type { ViewStyle } from 'react-native';
import { AuroraDark, RADIUS } from './theme';

export type GlassKind = 'chrome' | 'card' | 'chip' | 'sheet';

export interface GlassRecipe {
  /** expo-blur intensity (0–100) when the surface does take a blur pass. */
  intensity: number;
  /** Peak alpha of the 1px lip highlight along the top edge (dark theme). */
  lip: number;
  /** Corner radius the class defaults to. */
  radius: number;
  /** Whether this class takes a real blur pass by default. */
  blur: boolean;
  /** iOS shadow + Android elevation, ready to spread into a style. */
  shadow: ViewStyle;
}

const shadow = (height: number, radius: number, opacity: number, elevation: number): ViewStyle => ({
  // The ground's own near-black, so the shadow deepens the aurora instead of
  // greying it. Deliberately not a palette token: a shadow is dark in both
  // themes, and on the light ground a lavender-tinted shadow reads as a stain.
  shadowColor: '#05030D',
  shadowOffset: { width: 0, height },
  shadowOpacity: opacity,
  shadowRadius: radius,
  elevation,
});

export const GLASS: Record<GlassKind, GlassRecipe> = {
  /** Tab bar, chat header, composer: floats over scrolling content. */
  chrome: { intensity: 48, lip: 0.28, radius: 30,          blur: true,  shadow: shadow(12, 28, 0.55, 12) },
  /** Settings groups, score cards, tiles: flat translucent by default. */
  card:   { intensity: 36, lip: 0.22, radius: 24,          blur: false, shadow: shadow(8, 16, 0.32, 6) },
  /** Filter chips, date pills, reaction chips. */
  chip:   { intensity: 24, lip: 0.18, radius: RADIUS.pill, blur: false, shadow: shadow(2, 6, 0.18, 2) },
  /** Bottom sheets: the heaviest blur, shadow cast upward. */
  sheet:  { intensity: 56, lip: 0.30, radius: RADIUS.xxl,  blur: true,  shadow: shadow(-6, 40, 0.60, 16) },
};

const LIGHT_SHADOW: Record<GlassKind, ViewStyle> = {
  chrome: { shadowColor: '#244064', shadowOffset: { width: 0, height: 10 }, shadowOpacity: 0.18, shadowRadius: 26, elevation: 10 },
  card:   { shadowColor: '#244064', shadowOffset: { width: 0, height: 8 },  shadowOpacity: 0.14, shadowRadius: 20, elevation: 5 },
  chip:   { shadowColor: '#244064', shadowOffset: { width: 0, height: 2 },  shadowOpacity: 0.12, shadowRadius: 6,  elevation: 2 },
  sheet:  { shadowColor: '#244064', shadowOffset: { width: 0, height: -6 }, shadowOpacity: 0.18, shadowRadius: 34, elevation: 14 },
};

export const glassShadow = (kind: GlassKind, scheme: 'dark' | 'light'): ViewStyle =>
  scheme === 'light' ? LIGHT_SHADOW[kind] : GLASS[kind].shadow;

/**
 * Coloured glow under a gradient disc — the FAB, the Apps tab, an active chip.
 * Keyed by SEMANTIC so a screen never picks a hex: the accent glow follows the
 * brand's deep end and the state glows follow the state colours. Static (the
 * dark palette's values) on purpose: a glow is a saturated shadow, and the
 * saturated brand colours are identical in both themes.
 */
export const GLOW = {
  accent:  { shadowColor: AuroraDark.accentDeep, shadowOffset: { width: 0, height: 6 },  shadowOpacity: 0.60, shadowRadius: 18, elevation: 10 },
  fab:     { shadowColor: AuroraDark.accentDeep, shadowOffset: { width: 0, height: 10 }, shadowOpacity: 0.55, shadowRadius: 24, elevation: 8 },
  success: { shadowColor: AuroraDark.success,    shadowOffset: { width: 0, height: 4 },  shadowOpacity: 0.55, shadowRadius: 14, elevation: 6 },
  danger:  { shadowColor: AuroraDark.danger,     shadowOffset: { width: 0, height: 4 },  shadowOpacity: 0.55, shadowRadius: 14, elevation: 6 },
} as const satisfies Record<string, ViewStyle>;

export type GlowKind = keyof typeof GLOW;

/**
 * The lip: a 1px horizontal gradient, clear → white → clear, laid along the
 * top edge of a glass surface. It is the light catching the edge of the pane,
 * and it is the single detail that separates "glass" from "grey rectangle
 * with a border". On the light theme the pane is already near-white, so the
 * lip has to go almost opaque to register at all.
 */
export const lipGradient = (peak: number): [string, string, string] => {
  const a = Math.min(1, Math.max(0, peak));
  return ['rgba(255,255,255,0)', `rgba(255,255,255,${a})`, 'rgba(255,255,255,0)'];
};

/** Lip peak for the active scheme. */
export const lipPeak = (kind: GlassKind, scheme: 'dark' | 'light'): number =>
  scheme === 'light' ? 0.95 : GLASS[kind].lip;

/**
 * The same recipe as CSS, for the design artefacts under design/aurora-glass
 * and the web build. Kept here so the prototype and the app cannot disagree
 * about what "chrome glass" means. expo-blur's intensity is roughly twice a
 * CSS blur radius at the same visual weight.
 */
export function glassCss(kind: GlassKind): string {
  const r = GLASS[kind];
  const blurPx = Math.round(r.intensity / 2);
  return `backdrop-filter: blur(${blurPx}px) saturate(160%); -webkit-backdrop-filter: blur(${blurPx}px) saturate(160%); border-radius: ${r.radius}px;`;
}
