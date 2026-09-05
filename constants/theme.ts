/**
 * Below are the colors that are used in the app. The colors are defined in the light and dark mode.
 * There are many other ways to style your app. For example, [Nativewind](https://www.nativewind.dev/), [Tamagui](https://tamagui.dev/), [unistyles](https://reactnativeunistyles.vercel.app), etc.
 */

const tintColorLight = '#0a7ea4';
const tintColorDark = '#fff';

export const Colors = {
  light: {
    text: '#11181C',
    background: '#fff',
    tint: tintColorLight,
    icon: '#687076',
    tabIconDefault: '#687076',
    tabIconSelected: tintColorLight,
  },
  dark: {
    text: '#ECEDEE',
    background: '#151718',
    tint: tintColorDark,
    icon: '#9BA1A6',
    tabIconDefault: '#9BA1A6',
    tabIconSelected: tintColorDark,
  },
};

// ─── Obsidian Aurora design system ───────────────────────────────────
// Two palettes (dark / light) sharing the brand accents (U3). `Aurora` is the
// DARK palette and stays the static default so every existing `import { Aurora }`
// keeps working unchanged; theme-aware code reads the active palette via
// useTheme() (lib/theme). Brand colors are identical across both so accents stay
// on-brand in either mode; only surfaces + text invert.

export interface Palette {
  primary: string; accent: string; purple: string;
  danger: string; success: string; online: string;
  bg: string; surface: string; surfaceSolid: string;
  card: string; border: string; separator: string;
  text: string; textDim: string; textFaint: string;
  // WhatsApp-faithful chat surface (see memory: WhatsApp = reference standard).
  chatBg: string;          // conversation background
  bubbleIn: string;        // received bubble
  bubbleOut: string;       // sent bubble
  bubbleInText: string; bubbleOutText: string;
  bubbleMetaIn: string; bubbleMetaOut: string;  // time/tick color inside the bubble
  tickRead: string;        // blue double-tick
  headerBar: string;       // chat top bar

  // ─── Aurora Glass (U6) ───────────────────────────────────────────
  // The design spends translucency ONLY on floating chrome (tab bar, chat
  // header, composer, sheets) — never behind list content, where a blur per
  // row costs a frame and buys nothing. List rows stay flat on `bg`, split by
  // `hairline`; the personality comes from the aurora ground + gradient rings.
  /** Translucent fill for floating chrome sat over scrolling content. */
  glass: string;
  /** Quieter translucent fill for inline surfaces (chips, field cards). */
  glassSoft: string;
  /** Hairline border drawn on a glass surface. */
  glassStroke: string;
  /** List separator — barely there. */
  hairline: string;
  /** Disc behind avatar initials, inside the gradient ring. */
  groundDisc: string;
  /** Accent gradient ends. Also the accent tint legible on glass. */
  accentLight: string;
  accentDeep: string;
}

// ─── Single source of truth for the brand ACCENT (lavender) ─────────
// Change BRAND_ACCENT and the whole app re-colors. Everything that needs the
// accent imports this (solid) or brandAlpha(a) (translucent tints) — no screen
// hardcodes the hex. Keep BRAND_ACCENT_RGB in sync with the hex.
export const BRAND_ACCENT = '#9D6FD0';           // lavender (button-safe shade)
export const BRAND_ACCENT_RGB = '157, 111, 208'; // keep in sync with BRAND_ACCENT
export const brandAlpha = (a: number) => `rgba(${BRAND_ACCENT_RGB}, ${a})`;

const BRAND = {
  primary: BRAND_ACCENT,
  accent:  BRAND_ACCENT, // secondary accent follows the brand color
  purple:  '#8B5CF6',
  danger:  '#EF4444',
  success: '#22C55E', // green stays for "success / good" semantics (reference uses it)
  online:  '#22C55E', // presence stays green
};

export const AuroraDark: Palette = {
  ...BRAND,
  bg:        '#0A0810', // deep aurora ground — the blooms are drawn on top of this
  surface:   'rgba(255,255,255,0.06)',
  surfaceSolid: '#1B1626',
  card:      '#171320',
  border:    'rgba(255,255,255,0.09)',
  separator: 'rgba(255,255,255,0.06)',
  text:      'rgba(255,255,255,0.96)',
  textDim:   'rgba(255,255,255,0.48)',
  textFaint: 'rgba(255,255,255,0.34)',
  // Conversation: received sits on a raised ground tone, sent carries the accent.
  chatBg:        '#0A0810',
  bubbleIn:      '#1B1626',
  bubbleOut:     BRAND_ACCENT,
  bubbleInText:  'rgba(255,255,255,0.96)',
  bubbleOutText: '#FFFFFF',
  bubbleMetaIn:  'rgba(255,255,255,0.34)',
  bubbleMetaOut: 'rgba(255,255,255,0.70)',
  tickRead:      '#FFFFFF',
  headerBar:     '#12101A',

  glass:       'rgba(255,255,255,0.08)',
  glassSoft:   'rgba(255,255,255,0.06)',
  glassStroke: 'rgba(255,255,255,0.16)',
  hairline:    'rgba(255,255,255,0.06)',
  groundDisc:  '#171320',
  accentLight: '#C9A6F5',
  accentDeep:  '#7C3AED',
};

export const AuroraLight: Palette = {
  ...BRAND,
  bg:        '#F6F7F9',
  surface:   'rgba(0,0,0,0.04)',
  surfaceSolid: '#EDEFF3',
  card:      '#FFFFFF',
  border:    'rgba(0,0,0,0.10)',
  separator: 'rgba(0,0,0,0.07)',
  text:      '#0A0A0F',
  textDim:   'rgba(0,0,0,0.55)',
  textFaint: 'rgba(0,0,0,0.35)',
  // Lavender-theme light conversation palette (sent = accent, received = neutral)
  chatBg:        '#F4F4F7',
  bubbleIn:      '#FFFFFF',
  bubbleOut:     BRAND_ACCENT,
  bubbleInText:  '#11181C',
  bubbleOutText: '#FFFFFF',
  bubbleMetaIn:  '#667781',
  bubbleMetaOut: 'rgba(255,255,255,0.85)',
  tickRead:      '#FFFFFF',
  headerBar:     '#FFFFFF',

  glass:       'rgba(255,255,255,0.72)',
  glassSoft:   'rgba(255,255,255,0.55)',
  glassStroke: 'rgba(0,0,0,0.08)',
  hairline:    'rgba(0,0,0,0.07)',
  groundDisc:  '#FFFFFF',
  accentLight: '#7C3AED',
  accentDeep:  '#6D28D9',
};

/** The static default palette (dark). Existing screens import this directly. */
export const Aurora: Palette = AuroraDark;

export type AuroraTheme = Palette;
export const PALETTES = { dark: AuroraDark, light: AuroraLight };
export type ColorScheme = keyof typeof PALETTES;

// ─── U1: Design-token foundation ─────────────────────────────────────
// One source of truth for space / radius / elevation / motion / type, so every
// screen stops inventing its own 8/10/14/18/20/24 radii and ad-hoc paddings.
// All additive — existing Aurora.* usage is untouched.

/** 4-point spacing scale. Use SPACING.md not magic numbers. */
export const SPACING = {
  xs: 4,
  sm: 8,
  md: 12,
  lg: 16,
  xl: 24,
  xxl: 32,
  xxxl: 48,
} as const;

/** Corner-radius scale. `pill` = fully rounded; `bubble`/`tail` for chat. */
export const RADIUS = {
  xs: 6,
  sm: 8,
  md: 12,
  lg: 16,
  xl: 20,
  xxl: 28,
  bubble: 16,
  tail: 4,
  pill: 999,
} as const;

/** Elevation presets — ready-to-spread RN style objects (iOS shadow + Android elevation). */
export const ELEVATION = {
  none: {},
  sm: {
    shadowColor: '#000', shadowOffset: { width: 0, height: 1 }, shadowOpacity: 0.18,
    shadowRadius: 2, elevation: 2,
  },
  md: {
    shadowColor: '#000', shadowOffset: { width: 0, height: 4 }, shadowOpacity: 0.24,
    shadowRadius: 8, elevation: 5,
  },
  lg: {
    shadowColor: '#000', shadowOffset: { width: 0, height: 8 }, shadowOpacity: 0.32,
    shadowRadius: 16, elevation: 10,
  },
} as const;

/** Motion presets — durations (ms) + spring configs for Reanimated/Animated. */
export const MOTION = {
  fast: 150,
  base: 220,
  slow: 320,
  spring:      { damping: 18, stiffness: 180, mass: 1 },
  springSnappy:{ damping: 22, stiffness: 260, mass: 0.9 },
  springSoft:  { damping: 26, stiffness: 120, mass: 1 },
} as const;

// ─── Brand font families (loaded in the root layout — see U2) ─────────
// Until the fonts load, the Text wrapper falls back to the system font.
// Family names match @expo-google-fonts exports (loaded in the root layout, U2).
export const FONT = {
  heading:     'Sora_700Bold',          // headings / titles
  headingBold: 'Sora_800ExtraBold',
  body:        'NunitoSans_400Regular', // body / UI
  bodySemibold:'NunitoSans_600SemiBold',
  bodyBold:    'NunitoSans_700Bold',
} as const;

/**
 * Type scale. Each variant carries size / lineHeight / weight / family so a
 * single <Text variant="title"> renders consistently everywhere. Weight is kept
 * for the system-font fallback; family takes over once the brand fonts load.
 */
export const TYPOGRAPHY = {
  display: { fontSize: 34, lineHeight: 40, fontWeight: '800' as const, family: FONT.headingBold },
  title:   { fontSize: 24, lineHeight: 30, fontWeight: '800' as const, family: FONT.headingBold },
  h2:      { fontSize: 20, lineHeight: 26, fontWeight: '700' as const, family: FONT.heading },
  h3:      { fontSize: 17, lineHeight: 22, fontWeight: '700' as const, family: FONT.heading },
  body:    { fontSize: 15, lineHeight: 21, fontWeight: '400' as const, family: FONT.body },
  bodyStrong:{ fontSize: 15, lineHeight: 21, fontWeight: '600' as const, family: FONT.bodySemibold },
  callout: { fontSize: 14, lineHeight: 19, fontWeight: '500' as const, family: FONT.body },
  caption: { fontSize: 12.5, lineHeight: 16, fontWeight: '500' as const, family: FONT.body },
  tiny:    { fontSize: 11, lineHeight: 14, fontWeight: '600' as const, family: FONT.bodySemibold },
} as const;

export type TypeVariant = keyof typeof TYPOGRAPHY;

/**
 * Deterministic per-contact avatar colors (name-hash → palette), so initials
 * aren't all the same purple (U7). Pass a stable string (userId or name).
 */
export const AVATAR_PALETTE = [
  BRAND_ACCENT, '#06B6D4', '#8B5CF6', '#F59E0B', '#EF4444',
  '#EC4899', '#3B82F6', '#14B8A6', '#F97316', '#6366F1',
] as const;

/**
 * Aurora Glass carries per-contact colour in the avatar's gradient RING, with a
 * dark disc behind the initial — so identity is legible without giving every
 * row a coloured block. Index-matched to AVATAR_PALETTE: [lighter, deeper].
 */
export const AVATAR_RING_PALETTE: readonly (readonly [string, string])[] = [
  ['#C9A6F5', '#7C3AED'], ['#7DD3FC', '#0EA5E9'], ['#C4B5FD', '#6D28D9'],
  ['#FCD34D', '#B45309'], ['#FDA4AF', '#B91C1C'], ['#F9A8D4', '#9D174D'],
  ['#93C5FD', '#1E40AF'], ['#5EEAD4', '#0F766E'], ['#FDBA74', '#C2410C'],
  ['#A5B4FC', '#4338CA'],
] as const;

function seedIndex(seed: string | null | undefined, len: number): number {
  const s = seed || '?';
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
  return h % len;
}

/** Deterministic [light, deep] ring gradient for a contact. */
export function avatarRing(seed: string | null | undefined): readonly [string, string] {
  return AVATAR_RING_PALETTE[seedIndex(seed, AVATAR_RING_PALETTE.length)];
}

export function avatarColor(seed: string | null | undefined): string {
  const s = seed || '?';
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
  return AVATAR_PALETTE[h % AVATAR_PALETTE.length];
}
