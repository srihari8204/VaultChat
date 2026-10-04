// constants/familyPalette.ts — the Family screens' FIXED colours: the few that
// deliberately do not follow the app theme. Everything else on those screens
// reads useTheme() / the space glass.
//
// Why each group is fixed, and what guards it
// (constants/familyPalette.selftest.ts runs the contrast checks):
//
//   FAMILY_MAP_MEMBER — one hue per member dot on the family map. The dots are
//     drawn inside the map's WebView page over a basemap that is LIGHT in both
//     app themes (lib/map/tileProvider), so a theme token, which flips with the
//     app, would be tuned for the wrong ground on half the devices. A member's
//     initials sit on their hue in the page's dark marker ink (MARKER_CSS in
//     components/family/FamilyMap.tsx); the selftest reads that ink from the
//     source and holds every hue to AA (4.5:1) against it.
//   FAMILY_MAP_TRACK — the location-history track's caps: green start, red end
//     (the convention every maps app uses), each with a white ring that lifts
//     it off the line and the tiles. No text sits on them.
//   CRASH_ALARM — the full-screen crash countdown. It is an alarm, the same in
//     both themes: deep green "I'm OK" and deep red "Send SOS now" with white
//     labels. The theme's own success/danger are the bright hues in dark mode,
//     where white labels fall to 2.3:1 and 3.8:1; "I'm OK" is the one button
//     that stops a false SOS and has to be the most readable thing on screen.
//     The selftest holds both labels to AA.

/** Member dot hues on the family map, assigned by roster order (self keeps the theme accent). */
export const FAMILY_MAP_MEMBER = [
  '#4A9FFF', '#EC4899', '#22C55E', '#F59E0B', '#A855F7', '#EF4444', '#14B8A6', '#F97316',
] as const;

/** History-track caps on the family map: start, end, and the ring around both. */
export const FAMILY_MAP_TRACK = { start: '#22C55E', end: '#EF4444', ring: '#FFFFFF' } as const;

/** The crash countdown's button fills, their label ink, and the alarm scrim behind the card. */
export const CRASH_ALARM = {
  ok: '#15803D',
  send: '#B42318',
  ink: '#FFFFFF',
  /** Deliberately darker than the sheets' scrim: this is an alarm. */
  scrim: 'rgba(0,0,0,0.82)',
} as const;
