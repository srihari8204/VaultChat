// constants/spaceTheme.ts — dusk-glass tokens for the Spaces hub (app/family.tsx).
//
// Same mechanics as financeTheme (translucent pane + lit edge over a gradient
// ground rendered ONCE, no BlurView — a live blur behind a scrolling list is
// the most expensive thing a mid-range Android GPU can be asked for), but its
// own identity: finance is arctic ice in daylight; a space is the sky at dusk.
// Violet-greys keyed to the Aurora brand, and the ground carries an aura in
// the ACTIVE SPACE'S identity colour — groupIdentity() supplies it at runtime,
// which is why no accent hex lives here.
//
// PURE — no imports — so spaceTheme.selftest.ts can import it under Node.
// Both schemes share a shape key-for-key (pinned by the selftest) so the
// screen swaps palettes without knowing which one it holds.

export const SPACE_GLASS = {
  light: {
    // Ground, top → bottom. Drawn once behind the whole screen.
    bgTop:      '#F7F5FC',
    bgMid:      '#EFECF7',
    bgBottom:   '#E5E1F0',

    // Three weights of glass. Hierarchy lives in the glass itself:
    // strong = the hero pane and floating controls, pane = every ordinary
    // card, faint = tertiary rows and resting chips.
    pane:       'rgba(255,255,255,0.62)',
    paneStrong: 'rgba(255,255,255,0.82)',
    paneFaint:  'rgba(255,255,255,0.38)',

    edge:       'rgba(255,255,255,0.92)',   // the lit rim — doubles as pane border
    line:       'rgba(22,17,44,0.08)',      // hairline separators inside a pane
    // Shadowless chips can't lean on elevation to separate from the ground,
    // and a white rim on a white ground is invisible — so chips take an ink
    // hairline in light while panes keep the lit edge. Dark keeps the rim.
    chipEdge:   'rgba(22,17,44,0.10)',
    // Press tint for rows: white-over-white shows nothing, ink does.
    press:      'rgba(22,17,44,0.05)',

    // Elevated surfaces (sheets, dialogs) are SOLID: glass over a scrim or a
    // busy map costs readability and buys nothing.
    sheet:      '#FBFAFE',

    // Semantic TEXT tints for small type on glass. The palette's raw accent
    // (#9D6FD0) and success (#22C55E) fail WCAG AA at the 11–13px sizes this
    // screen uses them at; these are the same hues, deep enough to clear 4.5:1
    // on the pane∘ground composite — pinned by the selftest, not by eye.
    accentText: '#6D3FA8',
    goodText:   '#05603A',
    dangerText: '#B42318',

    // Alpha suffixes for the three concentric aura circles (hex, appended to
    // the identity colour). Concentric fades stand in for a radial blur.
    auraAlphas: ['14', '10', '0C'],
  },
  dark: {
    bgTop:      '#16131F',
    bgMid:      '#110F19',
    bgBottom:   '#0B0A11',

    // A lift, not a wash: white at low alpha over near-black turns milky fast.
    pane:       'rgba(255,255,255,0.07)',
    paneStrong: 'rgba(255,255,255,0.12)',
    paneFaint:  'rgba(255,255,255,0.04)',

    edge:       'rgba(255,255,255,0.15)',
    line:       'rgba(255,255,255,0.07)',
    chipEdge:   'rgba(255,255,255,0.15)',
    press:      'rgba(255,255,255,0.06)',

    sheet:      '#191624',

    accentText: '#C9ADED',
    goodText:   '#6CE9A6',
    dangerText: '#FDA29B',

    // The dark ground swallows more, so the aura breathes a little brighter.
    auraAlphas: ['20', '18', '10'],
  },
} as const;

export type SpaceScheme = keyof typeof SPACE_GLASS;
export type SpaceGlass = (typeof SPACE_GLASS)[SpaceScheme];

/** Soft two-layer elevation for glass panes. `elevation` is what Android
 *  actually honours; the rest is iOS. Shadow colour is a deep dusk violet so
 *  light-mode shadows stay cool instead of going muddy grey. */
export const SPACE_SHADOW = {
  rest:   { shadowColor: '#14102A', shadowOpacity: 0.10, shadowRadius: 12, shadowOffset: { width: 0, height: 4 }, elevation: 2 },
  raised: { shadowColor: '#14102A', shadowOpacity: 0.16, shadowRadius: 20, shadowOffset: { width: 0, height: 8 }, elevation: 5 },
} as const;

export default SPACE_GLASS;
