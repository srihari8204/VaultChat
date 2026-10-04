// constants/chatPalette.ts — the chat screen's fixed (theme-independent) colours.
//
// WHY THESE ARE FIXED.
// * Media scrims. The staged-media preview (components/chat/MediaCaptionPreview)
//   draws its close button, the "2 / 5" counter and each thumbnail's remove
//   button ON the photo or video. The picture has no theme, so a dark scrim
//   under white ink (ON_MEDIA_INK) carries the contrast in both app themes.
// * The send button's glyph. S.sendFab (components/chat/chatStyles) is filled
//   with accentDeep, #1552E0 in BOTH palettes, where white is 6.33:1. Not
//   colors.onPrimary: that is the ink for the `primary` fill (#1777FE in dark),
//   and its dark value waits on an open design decision (see
//   AuroraDark.onPrimary in constants/theme.ts) that must not restyle this
//   button by accident.
//
// constants/chatPalette.selftest.ts checks each ink against the worst case (a
// pure-white photo under the scrim): text 4.5:1, glyphs 3:1.
import { ON_MEDIA_INK } from './theme';

export const CHAT_MEDIA_SCRIM = {
  /** Glyphs and text drawn on either scrim. */
  ink: ON_MEDIA_INK,
  /** Behind a large glyph (the 26pt close button) over the picture. */
  scrim: '#00000088',
  /** Behind text (the counter) or a small glyph (the 12pt remove) over the picture. */
  scrimStrong: '#000000aa',
} as const;

/** Send / mic glyph and spinner on S.sendFab (accentDeep in both themes). */
export const SEND_FAB_INK = '#FFFFFF';
