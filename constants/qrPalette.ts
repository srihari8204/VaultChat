// constants/qrPalette.ts — fixed colours for QR codes and the QR scanner.
//
// WHY THESE COLOURS ARE FIXED. A QR code is read by a camera, not a person:
// scanners expect dark modules on a light ground, and many refuse an inverted
// (light-on-dark) code. So every QR this app draws (qr-contact, verify-contact's
// safety number, invite-link) is near-black on white in BOTH themes, never the
// theme's text-on-background pair. constants/qrPalette.selftest.ts checks it.
//
// The scanner's hint line sits over the live camera image, whose colours are
// unknown, so it is white with a black shadow in every theme (the same reason
// call chrome is always dark: constants/callTheme.ts).
import { ON_MEDIA_INK } from './theme';

export const QR_COLORS = {
  backgroundColor: '#FFFFFF',
  color: '#0A0A0F',
} as const;

export const QR_SCAN_OVERLAY = {
  ink: ON_MEDIA_INK,
  shadow: '#000000',
} as const;
