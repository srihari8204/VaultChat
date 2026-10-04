// constants/mediaChrome.ts — fixed colours of the always-dark media surfaces:
// photo/video/story stages (media-viewer, video-player, story-viewer, the file
// viewer's photo pane), the image editor's crop chrome, and the PDF reader's
// mat and paper.
//
// WHY THESE COLOURS ARE FIXED. Media is shown full-bleed on a black stage in
// BOTH app themes (every photo and video app does; a light-theme stage washes
// out the picture and fights the light status bar). Chrome drawn ON that stage
// must therefore stay light-on-dark whatever the app theme is; where a theme
// token already means the right thing on dark (AuroraDark.*) the screens use
// it, and only the colours with no token live here. A PDF page is white paper
// on a neutral mat in every reader, and the rendered bitmap assumes white.
//
// constants/mediaChrome.selftest.ts checks every text/icon colour here clears
// WCAG AA (4.5:1) on the surface it is drawn on. Change a colour and run it.

/** The black stage behind photos, video and stories. */
export const MEDIA_STAGE = '#000000';
/** Icons and text drawn over the stage or its dark scrims. */
export const MEDIA_INK = '#FFFFFF';
/** Shadow behind white overlay text and crop lines over a photo. */
export const MEDIA_SHADOW = '#000000';
/** Error red tuned for the black stage (the theme's danger is tuned for cards). */
export const MEDIA_DANGER = '#FF7B72';

/** Video player: accent (progress, active speed) as text/icon on black, and the filled button under white text. */
export const VIDEO_ACCENT = '#4A9FFF';
export const VIDEO_CTA = '#1D4ED8';

/** PDF reader: the neutral mat behind the pages, and the page itself. */
export const PDF_MAT = '#3A3A3E';
export const PDF_PAPER = '#FFFFFF';
/** The PDF reader's page/zoom pills: black at this alpha, under MEDIA_INK. */
export const PDF_PILL_ALPHA = 0.6;
