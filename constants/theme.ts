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
  /** The two ends of the accent gradient (rings, FABs, the Apps disc). */
  accentLight: string;
  accentDeep: string;
  /**
   * The accent as TEXT/ICON colour on this theme's ground. Not a gradient end:
   * on dark it is the pale lavender, on light it must be the deep violet, or
   * active tabs and links wash out. Keeping this separate is what lets the
   * gradient stay a gradient in both themes.
   */
  accentOn: string;
  /**
   * Brand text/icon colour when the surface underneath is light, regardless of
   * the active app theme. Used by mixed-material previews and handoff sheets.
   */
  brandOnLight: string;
  /**
   * Text/icon colour ON a solid `primary` / `danger` fill (buttons, badges).
   * Not always white: white on the dark scheme's #1777FE is 4.11:1 and on
   * #EF4444 3.76:1 — under AA 4.5:1 — so dark uses the splash night ink.
   */
  onPrimary: string;
  onDanger: string;
  /** Amber warning text/icon on this scheme's normal surfaces (AA 4.5:1). */
  warning: string;
}

// ─── Single source of truth for the brand ACCENT ────────────────────
// Change BRAND_ACCENT and the whole app re-colors. Everything that needs the
// accent imports this (solid) or brandAlpha(a) (translucent tints) — no screen
// hardcodes the hex. Keep BRAND_ACCENT_RGB in sync with the hex.
//
// crazzychat, and every value below was SAMPLED OUT OF THE ARTWORK rather than
// eyeballed — logo/logo.png and logo/splashscreen.png, which ship as
// assets/images/icon.png and splash.png. The mark is one continuous sweep from
// cyan through electric blue into violet, so picking a single "brand colour"
// means picking a point on that sweep; this is the one the wordmark itself uses
// for "chat", which makes it the colour a person actually reads as the brand.
//
// It replaces the lavender #9D6FD0. A rebrand that keeps the old accent is half
// a rebrand — a lavender send-bubble under a blue-and-violet logo reads as two
// products.
export const BRAND_ACCENT = '#1777FE';           // the wordmark blue
export const BRAND_ACCENT_RGB = '23, 119, 254';  // keep in sync with BRAND_ACCENT
export const brandAlpha = (a: number) => `rgba(${BRAND_ACCENT_RGB}, ${a})`;

/** Navigation artwork keeps its identity in both appearances. */
export const TAB_ICON_INK = {
  chats: { light: '#1552E0', dark: '#8BC6FF' },
  status: { light: '#00695C', dark: '#75E3CB' },
  mini: { light: '#6D28D9', dark: '#CEB5FF' },
  calls: { light: '#9A5700', dark: '#FFD285' },
  profile: { light: '#B42361', dark: '#FFADCA' },
} as const;

export const CHAT_ACTION_INK = {
  search: TAB_ICON_INK.chats,
  alerts: TAB_ICON_INK.mini,
  temporary: TAB_ICON_INK.calls,
  contacts: TAB_ICON_INK.status,
  broadcast: TAB_ICON_INK.profile,
} as const;

/**
 * The three stops of the mark, cyan → blue → violet, in sweep order.
 *
 * Use this for anything that should read as THE LOGO — the wordmark, the sign-in
 * button, a progress rail. Two stops of it look like a tasteful gradient; all
 * three look like the brand, because the violet is what stops it being generic
 * tech-blue.
 */
export const BRAND_CYAN   = '#33DDFE';
export const BRAND_BLUE   = '#0040FD';
export const BRAND_VIOLET = '#8C49FC';
export const BRAND_GRADIENT = [BRAND_CYAN, BRAND_ACCENT, BRAND_VIOLET] as const;

/**
 * The gradient that is SAFE UNDER WHITE TEXT. Not the same list, on purpose.
 *
 * A gradient's contrast is only as good as its lightest stop, and BRAND_CYAN is
 * 1.63:1 against white — so the logo sweep makes a beautiful button that nobody
 * can read the label of. Measured, against white:
 *
 *     #33DDFE cyan    1.63:1   <- decorative only, never behind text
 *     #1777FE accent  4.11:1   <- the brand blue; under AA for body text
 *     #0040FD blue    6.66:1
 *     #8C49FC violet  4.69:1
 *
 * So anything carrying a white label runs blue → violet, which passes at both
 * ends, and the cyan is spent where it belongs: the mark, the glow, the rings.
 * (For reference the lavender this replaces was 3.74:1, so the brand accent is
 * a step up rather than a regression — but it is still not a text background.)
 */
export const BRAND_GRADIENT_CTA = [BRAND_BLUE, BRAND_VIOLET] as const;

/**
 * The night the splash is lit against, and the ink the wordmark is set in.
 *
 * BRAND_NIGHT is the actual background of splashscreen.png. The auth screens use
 * it so that the hand-off from the native splash to the first React screen is
 * invisible — same ground, same glow, the logo simply stops being a picture and
 * becomes a screen.
 */
export const BRAND_NIGHT = '#010628';
export const BRAND_INK   = '#001646';

const BRAND = {
  primary: BRAND_ACCENT,
  accent:  BRAND_ACCENT, // secondary accent follows the brand color
  purple:  BRAND_VIOLET,
  danger:  '#EF4444',
  success: '#22C55E', // green stays for "success / good" semantics (reference uses it)
  online:  '#22C55E', // presence stays green
};

export const AuroraDark: Palette = {
  ...BRAND,
  bg:        '#0A0810', // deep aurora ground — the blooms are drawn on top of this
  surface:   'rgba(255,255,255,0.07)',
  surfaceSolid: '#1F1A2B',
  card:      '#171320',
  border:    'rgba(255,255,255,0.09)',
  separator: 'rgba(255,255,255,0.06)',
  text:      'rgba(255,255,255,0.96)',
  textDim:   'rgba(255,255,255,0.72)',
  textFaint: 'rgba(255,255,255,0.62)',
  // Conversation: received sits on a raised ground tone, sent carries the accent.
  chatBg:        '#0A0810',
  bubbleIn:      '#1B1626',
  bubbleOut:     '#1552E0',   // deep end of the accent ramp: white body text needs 4.5:1 (6.33:1)

  bubbleInText:  'rgba(255,255,255,0.96)',
  bubbleOutText: '#FFFFFF',
  bubbleMetaIn:  'rgba(255,255,255,0.62)',
  bubbleMetaOut: 'rgba(255,255,255,0.70)',
  tickRead:      '#FFFFFF',
  headerBar:     '#12101A',

  glass:       'rgba(255,255,255,0.10)',
  glassSoft:   'rgba(255,255,255,0.075)',
  glassStroke: 'rgba(255,255,255,0.20)',
  hairline:    'rgba(255,255,255,0.075)',
  groundDisc:  '#171320',
  accentLight: '#7FB6FF',   // 9.49:1 on the dark ground — the on-dark accent TEXT colour
  accentDeep:  '#1552E0',
  accentOn:    '#7FB6FF',
  brandOnLight:'#1552E0',
  // White, as every solid button already uses. Below AA for small text in dark
  // (4.11:1 on #1777FE, 3.76:1 on #EF4444); BRAND_NIGHT '#010628' would pass
  // (4.83 / 5.27:1) but restyles every dark-mode button — a design decision
  // left open in 2026-10-04_fix_status.md §5.
  onPrimary:   '#FFFFFF',
  onDanger:    '#FFFFFF',
  warning:     '#F59E0B',   // ≥7.44:1 on bg/card/surfaceSolid/surface/glass
};

export const AuroraLight: Palette = {
  ...BRAND,
  // These roles also label actions/statuses on light glass: use readable ink.
  primary: '#1552E0',
  accent: '#1552E0',
  success: '#05603A',
  danger: '#B42318',
  bg:        '#D4E1F2', // a distinct blue ground separates white glass from the page
  surface:   'rgba(49,76,118,0.11)',
  surfaceSolid: '#EAF1FA',
  card:      '#FFFFFF',
  border:    'rgba(49,76,118,0.32)',
  separator: 'rgba(49,76,118,0.20)',
  text:      '#1B1526',
  textDim:   'rgba(27,21,38,0.74)',
  textFaint: 'rgba(27,21,38,0.66)',
  // Conversation: received on white, sent on the brand accent.
  chatBg:        '#F4F1FA',
  bubbleIn:      '#FFFFFF',
  bubbleOut:     '#1552E0',   // deep end of the accent ramp: white body text needs 4.5:1 (6.33:1)

  bubbleInText:  '#1B1526',
  bubbleOutText: '#FFFFFF',
  bubbleMetaIn:  'rgba(27,21,38,0.66)',
  bubbleMetaOut: 'rgba(255,255,255,0.85)',
  tickRead:      '#FFFFFF',
  headerBar:     '#FFFFFF',

  glass:       'rgba(255,255,255,0.88)',
  glassSoft:   'rgba(232,240,252,0.86)',
  glassStroke: 'rgba(38,67,110,0.40)',
  hairline:    'rgba(38,67,110,0.24)',
  groundDisc:  '#FFFFFF',
  accentLight: '#6BA5FF',
  accentDeep:  '#1552E0',
  accentOn:    '#1552E0',
  brandOnLight:'#1552E0',
  onPrimary:   '#FFFFFF',   // 6.33:1 on #1552E0
  onDanger:    '#FFFFFF',   // 6.57:1 on #B42318
  warning:     '#93370D',   // ≥4.83:1 on bg/card/surfaceSolid/surface (spaces' warnText)
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
