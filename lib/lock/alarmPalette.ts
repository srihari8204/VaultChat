// lib/lock/alarmPalette.ts — the Location Lock alarm colours, named.
//
// Deliberately NOT theme tokens: an alarm must read as an alarm in both light
// and dark mode, so the full-screen alert and the alarm/grace/boundary bars are
// the same red/orange everywhere and carry white text. The values are the ones
// the screens hard-coded before; naming them keeps the two lock screens from
// drifting apart. Surfaces that are not alarms (cards, chips, the safe face)
// use useTheme() colours instead.

export const ALARM = {
  /** Full-screen alert ground: the flash runs between these two. With reduced
   *  motion the screen holds `flashLow` (the higher-contrast end). */
  flashLow: '#7F1D1D',
  flashHigh: '#DC2626',
  /** Alarm sounding: bars, Stop alarm button and its label on white. */
  sounding: '#DC2626',
  /** Grace period: outside, alarm about to start. Also the caution icon colour. */
  grace: '#F97316',
  /** Boundary prediction bars while still inside. */
  nearEdge: '#A16207',
  atLimit: '#C2410C',
  /** Text and icons on the alarm grounds above. Every line uses it: white is
   *  4.83:1 on the bright flash end (#DC2626), and the softer pinks it replaced
   *  (#FEE2E2 3.95:1, #FECACA 3.34:1) failed 4.5:1 for the secondary lines. */
  ink: '#FFFFFF',
  /** Secondary controls sitting on the alarm ground. */
  controlFill: 'rgba(255,255,255,.14)',
  controlStroke: 'rgba(255,255,255,.35)',
  /** "You are safe" face: a green wash over the theme ground, and a button
   *  dark enough for white text (4.5:1+) in both themes. */
  safeWash: 'rgba(34,197,94,0.18)',
  safeButton: '#15803D',
} as const;
