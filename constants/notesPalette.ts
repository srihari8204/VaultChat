// constants/notesPalette.ts — Encrypted Notes' FIXED colours: the category
// hues and the tag colours. Everything else on the notes screens reads
// useTheme().
//
// Why they are fixed, not theme tokens:
//   • A note STORES its tag colour as one of these hex strings (`tagColor` in
//     components/notes/notesModel), inside its sealed blob and in backups. A
//     token that changed with the theme or a redesign would leave old notes
//     pointing at colours that no longer exist in the picker.
//   • Each category keeps one identity hue in both themes, so "red = Passwords"
//     reads the same in light and dark.
// What sits on them: a hue only fills a swatch dot, tints a chip (at
// NOTE_CHIP_TINT, ~12.5%) and edges it. Label TEXT on a chip is never the raw
// hue (amber on the light ground is under 2:1): it is noteHueInk()
// (components/notes/noteHueInk.ts), the hue darkened (light) or lightened
// (dark) only as far as WCAG AA needs. constants/notesPalette.selftest.ts holds
// every hue's ink to 4.5:1 on its chip in both themes.

import { BRAND_ACCENT } from './theme';

/** One identity hue per note category (keys are the stored `category` values). */
export const NOTE_CATEGORY_HUE = {
  passwords: '#EF4444',
  ideas:     '#F59E0B',
  personal:  '#3B82F6',
  bank:      BRAND_ACCENT,
  medical:   '#EC4899',
  documents: '#8B5CF6',
  recovery:  BRAND_ACCENT,
  bookmarks: '#06B6D4',
  custom:    '#6B7280',
} as const;

/** The tag colours the editor offers (stored on the note as picked). */
export const NOTE_TAG_COLORS = ['#EF4444', '#F59E0B', BRAND_ACCENT, '#3B82F6', '#8B5CF6', '#EC4899', '#06B6D4', '#6B7280'] as const;

/** The tag colour of a note that never picked one (stored data, see above). */
export const DEFAULT_NOTE_TAG_COLOR = '#3B82F6';

/** The `hue + '20'` chip tint the screens append (0x20 / 255). */
export const NOTE_CHIP_TINT = '20';
