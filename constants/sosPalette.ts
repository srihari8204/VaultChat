// constants/sosPalette.ts — the Emergency SOS button's colours, named.
//
// Deliberately NOT theme tokens: the big SOS button (app/emergency-sos.tsx) is
// an emergency control and must look the same — a saturated red disc with white
// "SOS" — in light and dark mode, the way a physical panic button does. The
// theme's `danger` differs per scheme and `onDanger` is an open design decision
// (2026-10-04_fix_status.md §5), so neither may decide how this button reads.
// The ink is fixed with the ground for that reason.
//
// The label is 48 sp, weight 900 (components/sos/sosStyles.ts `sosText`), which
// is WCAG "large text": constants/sosPalette.selftest.ts asserts the ink is at
// least 3:1 on both gradient stops.

export const SOS_BUTTON = {
  /** Gradient stops, top → bottom (LinearGradient default direction). */
  gradient: ['#FF2D2D', '#CC0000'],
  /** The "SOS" label on the gradient. */
  ink: '#FFFFFF',
} as const;
