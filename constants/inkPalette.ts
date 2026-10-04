// constants/inkPalette.ts — pen and text colours for the drawing tools
// (app/whiteboard.tsx, app/image-editor.tsx).
//
// WHY THESE COLOURS ARE FIXED. An ink is IMAGE CONTENT, not UI chrome: what you
// draw is saved into the picture and sent as-is, so a red stroke must be the
// same red in light and dark theme and on the receiver's phone. No theme token
// stands in for "red pen". Each ink carries its spoken name, which the swatch
// uses as its accessibility label (a hex code is not a label).
//
// No text sits on these colours: the swatches are graphics, and the strokes
// are the user's own picture. constants/inkPalette.selftest.ts checks the lists
// stay well-formed and that the screens read them from here.
import { BRAND_ACCENT } from './theme';

export type Ink = { hex: string; name: string };

/**
 * Whiteboard pens, after its default black ink (lib/whiteboardStroke
 * DEFAULT_INK, which lives with the white canvas it is drawn on).
 */
export const WHITEBOARD_INKS: readonly Ink[] = [
  { hex: '#FF3C6E', name: 'red' },
  { hex: '#4A9FFF', name: 'blue' },
  { hex: BRAND_ACCENT, name: 'brand blue' },
  { hex: '#F59E0B', name: 'amber' },
  { hex: '#A78BFA', name: 'lavender' },
  { hex: '#FFFFFF', name: 'white' },
  { hex: '#EC4899', name: 'pink' },
  { hex: '#8B5CF6', name: 'purple' },
];

/** Image-editor brush and text colours, drawn over a photo. The first is the default. */
export const EDITOR_INKS: readonly Ink[] = [
  { hex: '#FFFFFF', name: 'white' },
  { hex: '#FF3C3C', name: 'red' },
  { hex: '#4A9FFF', name: 'blue' },
  { hex: BRAND_ACCENT, name: 'brand blue' },
  { hex: '#FBBF24', name: 'yellow' },
];

/** `hex → spoken name`, for the swatches' accessibility labels. */
export const inkNames = (inks: readonly Ink[]): Record<string, string> =>
  Object.fromEntries(inks.map(i => [i.hex, i.name]));
