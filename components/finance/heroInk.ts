// components/finance/heroInk.ts — ink for the finance surfaces that stay dark
// in BOTH schemes.
//
// The FIN_HERO gradients (constants/financeTheme) are saturated and dark in
// light and dark mode alike, so their text is white in both. No scheme token
// fits: FIN.onBrand turns dark in dark mode (it sits on the light dark-mode
// brand), and the app palette's onPrimary is documented as "not always white".
// One named set here replaces the white literals each hero used to repeat.

export const HERO_INK = {
  /** Headline figure. */
  strong: '#FFFFFF',
  /** Secondary lines under the figure. */
  soft: 'rgba(255,255,255,0.9)',
  /** Small caps labels above the figure. */
  label: 'rgba(255,255,255,0.85)',
  /** Hairline rules and dividers inside a hero. */
  rule: 'rgba(255,255,255,0.22)',
} as const;
