// constants/brandCtaInk.ts — the ink on the brand CTA gradient.

/**
 * Label and spinner colour ON `BRAND_GRADIENT_CTA` (blue → violet), the fill of
 * the sign-in and recovery CTAs (onboard, onboard-profile, onboard-security,
 * onboard-success, mpin-recover).
 *
 * FIXED, not a theme token, because the fill under it is fixed: those CTAs
 * paint the same blue → violet in both appearances. It is deliberately NOT
 * `onPrimary`, which is the ink for the theme's solid `primary` fill and whose
 * dark value is an open design decision (fix_status §5) — a near-black ink
 * chosen there would fail on #0040FD. Against white the stops measure 6.66:1
 * (#0040FD) and 4.69:1 (#8C49FC), both AA for the 16 pt labels;
 * constants/brandCtaInk.selftest.ts keeps it that way if either side changes.
 */
// One value with constants/theme GRADIENT_INK (the same white on the same
// gradient for Button and GlassChip), so the two cannot drift apart.
export { GRADIENT_INK as BRAND_CTA_INK } from './theme';
