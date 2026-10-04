// constants/gamesPalette.ts — the fixed colours the game screens paint with
// that are not in lib/games/theme.ts's room palette.
//
// WHY FIXED. A card table is a place: the boards look the same in the app's
// light and dark themes (see the palette note in lib/games/theme.ts), so these
// are deliberately not theme tokens. The only light-scheme values here are the
// launcher's (`LIGHT_HUB`), which is the one games screen that follows the app
// theme (components/games/appearance.ts).
//
// WHY HERE AND NOT IN lib/games/theme.ts. That module imports react-native, so
// it cannot be loaded under Node; this one imports nothing, so
// constants/gamesPalette.selftest.ts can measure every pair where text sits on
// one of these colours. lib/games/theme.ts re-exports RED_FILL from here.

/** Pure white light: specular highlights, the glint on a mark, the confetti white. */
export const HIGHLIGHT = '#FFFFFF';

/** The table vignette's shadow colour (TableBackground). */
export const VIGNETTE = '#000000';

/**
 * The painted button fills, top → bottom, under a white 15 dp label.
 *
 * A gradient is only as readable as its lightest stop (the same rule as
 * constants/theme.ts DANGER_GRADIENT_CTA), and the label spans most of the
 * button's height. The old light ends were under AA: #fb7185 at 2.69:1 and
 * #2FA36A at 3.20:1, so the label measured 4.39:1 at its own centre on red.
 * Both top stops are now AA (4.70:1 and 4.71:1); the hue and the depth of the
 * sweep are unchanged.
 */
export const RED_FILL = ['#e11d48', '#be123c', '#a30f2e'] as const;

/** Deep felt-green fill for Btn kind="good", matched to the table it sits on. */
export const GOOD_FILL = ['#1A8450', '#15794A', '#0B5233'] as const;
export const GOOD_STOPS = [0, 0.55, 1] as const;

/** The 1 px edge around the painted danger and good buttons. */
export const BTN_EDGE = { danger: '#7d0f2a', good: '#0a4a2e' } as const;

/** Label and icon ink on the painted danger and good buttons. */
export const ON_FILL = '#FFFFFF';

/** The danger action's ink on the chess action dock (Resign). */
export const DOCK_DANGER_INK = '#FFB3B8';

/** Confetti pieces besides the two golds: green, blue, rose and white. Decorative. */
export const CONFETTI = ['#5fe08c', '#6fa9ff', '#ff6b78', HIGHLIGHT] as const;

/**
 * The launcher in the app's LIGHT scheme. The four game accents are lifted for
 * the dark room (lib/games/theme.ts ACCENT), so on a white card they wash out;
 * these are their deep counterparts, and gold is the light hub's one accent.
 */
export const LIGHT_HUB = {
  gold: '#925B00',
  accent: { chess: '#05603A', rummy: '#00695C', ludo: '#925B00', tictactoe: '#1552E0' },
} as const;
