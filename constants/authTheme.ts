// Auth uses the selected appearance; the original night palette is preserved.
import { AuroraLight, BRAND_ACCENT, BRAND_CYAN, BRAND_NIGHT, BRAND_VIOLET, type Palette } from './theme';

export const AUTH = {
  /** The ground, identical to the splash artwork's background. */
  bg: BRAND_NIGHT,

  /**
   * The glass a form sits on.
   *
   * A LIFTED WHITE, not a tinted navy. Over a ground that is already lit by
   * coloured blooms, a coloured panel composites to mud — the same lesson
   * lib/games/rummyGlass.ts records about surfaces on a lit table. A neutral
   * white at low alpha lets the bloom behind it show through as the tint.
   */
  card:     'rgba(255,255,255,0.055)',
  stroke:   'rgba(255,255,255,0.12)',
  hairline: 'rgba(255,255,255,0.08)',

  /** Ink. Measured against BRAND_NIGHT: 19.8:1, 8.9:1 and 5.1:1. */
  text:  '#FFFFFF',
  dim:   'rgba(255,255,255,0.66)',
  faint: 'rgba(255,255,255,0.44)',

  /** The accent, and the two ends of the decorative sweep. */
  accent: BRAND_ACCENT,
  cyan:   BRAND_CYAN,
  violet: BRAND_VIOLET,

  /** Something went wrong. Legible on the night ground rather than pure red. */
  danger: '#FF7A85',
} as const;

export type AuthPalette = { [K in keyof typeof AUTH]: string };

export const AUTH_LIGHT: AuthPalette = {
  bg: AuroraLight.bg, card: AuroraLight.glass, stroke: AuroraLight.glassStroke,
  hairline: AuroraLight.glassSoft, text: AuroraLight.text, dim: AuroraLight.textDim,
  faint: AuroraLight.textFaint, accent: AuroraLight.primary, cyan: '#0369A1',
  violet: AuroraLight.purple, danger: AuroraLight.danger,
};

/** The slice of the app palette the shared auth inputs actually style with. */
export type FieldColors = Pick<
  Palette,
  'text' | 'textDim' | 'textFaint' | 'glassSoft' | 'glassStroke' | 'surfaceSolid' | 'bg' | 'primary' | 'danger'
>;

/** Original night input roles, used only for auth fields in dark appearance. */
export const AUTH_FIELDS: FieldColors = {
  text:         AUTH.text,
  textDim:      AUTH.dim,
  textFaint:    AUTH.faint,
  glassSoft:    AUTH.hairline,
  glassStroke:  AUTH.stroke,
  surfaceSolid: AUTH.card,
  bg:           AUTH.bg,
  primary:      AUTH.accent,
  danger:       AUTH.danger,
};
