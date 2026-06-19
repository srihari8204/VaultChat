/**
 * Below are the colors that are used in the app. The colors are defined in the light and dark mode.
 * There are many other ways to style your app. For example, [Nativewind](https://www.nativewind.dev/), [Tamagui](https://tamagui.dev/), [unistyles](https://reactnativeunistyles.vercel.app), etc.
 */

import { Platform } from 'react-native';

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

export const Fonts = Platform.select({
  ios: {
    /** iOS `UIFontDescriptorSystemDesignDefault` */
    sans: 'system-ui',
    /** iOS `UIFontDescriptorSystemDesignSerif` */
    serif: 'ui-serif',
    /** iOS `UIFontDescriptorSystemDesignRounded` */
    rounded: 'ui-rounded',
    /** iOS `UIFontDescriptorSystemDesignMonospaced` */
    mono: 'ui-monospace',
  },
  default: {
    sans: 'normal',
    serif: 'serif',
    rounded: 'normal',
    mono: 'monospace',
  },
  web: {
    sans: "system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif",
    serif: "Georgia, 'Times New Roman', serif",
    rounded: "'SF Pro Rounded', 'Hiragino Maru Gothic ProN', Meiryo, 'MS PGothic', sans-serif",
    mono: "SFMono-Regular, Menlo, Monaco, Consolas, 'Liberation Mono', 'Courier New', monospace",
  },
});

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
}

const BRAND = {
  primary: '#10B981', // emerald
  accent:  '#06B6D4', // cyan
  purple:  '#8B5CF6',
  danger:  '#EF4444',
  success: '#10B981',
  online:  '#10B981',
};

export const AuroraDark: Palette = {
  ...BRAND,
  bg:        '#0A0A0F', // near-black app background
  surface:   'rgba(255,255,255,0.05)',
  surfaceSolid: '#14141B',
  card:      '#15161D',
  border:    'rgba(255,255,255,0.08)',
  separator: 'rgba(255,255,255,0.06)',
  text:      '#FFFFFF',
  textDim:   'rgba(255,255,255,0.5)',
  textFaint: 'rgba(255,255,255,0.3)',
  // WhatsApp dark conversation palette
  chatBg:        '#0B141A',
  bubbleIn:      '#1F2C34',
  bubbleOut:     '#005C4B',
  bubbleInText:  '#E9EDEF',
  bubbleOutText: '#E9EDEF',
  bubbleMetaIn:  '#8696A0',
  bubbleMetaOut: 'rgba(233,237,239,0.6)',
  tickRead:      '#53BDEB',
  headerBar:     '#1F2C34',
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
  // WhatsApp light conversation palette
  chatBg:        '#ECE5DD',
  bubbleIn:      '#FFFFFF',
  bubbleOut:     '#D9FDD3',
  bubbleInText:  '#111B21',
  bubbleOutText: '#111B21',
  bubbleMetaIn:  '#667781',
  bubbleMetaOut: '#5B7765',
  tickRead:      '#34B7F1',
  headerBar:     '#008069',
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
  '#10B981', '#06B6D4', '#8B5CF6', '#F59E0B', '#EF4444',
  '#EC4899', '#3B82F6', '#14B8A6', '#F97316', '#6366F1',
] as const;

export function avatarColor(seed: string | null | undefined): string {
  const s = seed || '?';
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
  return AVATAR_PALETTE[h % AVATAR_PALETTE.length];
}
