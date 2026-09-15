// constants/authTheme.ts — fixed, always-DARK palette for the sign-in flow.
//
// The same decision constants/callTheme.ts makes, for the same reason and with
// the same shape: these screens render on a dark surface whatever the app's
// light/dark preference is, so pulling app theme colours (which flip to
// dark-on-light) would make the chrome invisible in light mode.
//
// The reason is stronger here than for calls, though. The native splash is a
// fixed piece of artwork on a fixed #010628 ground, and onboarding is the very
// next thing drawn. If the first React screen honoured a light theme, launch
// would flash navy → white before the user had been asked anything. And the
// theme preference is stored per account — at the sign-in screen there is not
// yet an account to have a preference.
//
// Every value is either taken from the brand tokens or measured against
// BRAND_NIGHT, so this file has no opinions of its own about hue.

import { BRAND_ACCENT, BRAND_CYAN, BRAND_NIGHT, BRAND_VIOLET, type Palette } from './theme';

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

/** The slice of the app palette the shared auth inputs actually style with. */
export type FieldColors = Pick<
  Palette,
  'text' | 'textDim' | 'textFaint' | 'glassSoft' | 'glassStroke' | 'surfaceSolid' | 'bg' | 'primary' | 'danger'
>;

/**
 * AUTH wearing the palette's key names, so ONE StyleSheet can serve both
 * grounds — `onDark ? AUTH_FIELDS : colors` — instead of every shared input
 * carrying two parallel stylesheets that drift apart.
 *
 * Why a prop and not "always dark like SecurityQuestionRow": these inputs have
 * themed callers too. PhoneField is the number field on app/new-chat.tsx and
 * MpinInput is the unlock keypad on app/app-lock.tsx — both ordinary in-app
 * screens on AuroraBackground, where always-dark would just move the
 * invisible-field bug rather than fix it.
 *
 * glassSoft maps to the FAINTER hairline tint, not AUTH.card: every auth caller
 * puts these fields inside a card, and card-on-card at the same alpha reads as a
 * rendering bug (the same note SecurityQuestionRow carries).
 */
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
