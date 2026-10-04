// constants/callTheme.ts — fixed, always-DARK palette for the call screens.
//
// Calls render on a dark surface regardless of the app's light/dark theme (the
// WhatsApp model): the controls/labels/icons are always white, so pulling app
// theme colors (which flip to dark-on-light in light mode) was making the call
// chrome invisible. These constants are the single source of truth for the
// voice + video call UI.

import { BRAND_ACCENT } from './theme';

export const CALL = {
  bg:         '#0B0B12',              // voice-call background (near-black)
  video:      '#000000',              // behind the video texture (true black)
  text:       '#FFFFFF',
  textDim:    'rgba(255,255,255,0.72)',
  barBg:      'rgba(24,24,32,0.72)',  // frosted control bar
  ctrl:       'rgba(255,255,255,0.12)',
  ctrlBorder: 'rgba(255,255,255,0.14)',
  active:     BRAND_ACCENT,           // lavender — armed/active control
  danger:     '#E5484D',              // end-call red
  tile:       '#1A1A22',              // empty participant tile
  errorText:  '#FCA5A5',              // error copy on the dark call surface
  handQueue:  '#FFD479',              // raised-hand queue line
  pagerDim:   '#BBBBBB',              // pager label
  pagerOff:   '#555555',              // pager arrow at either end
  textMuted:  'rgba(255,255,255,0.6)',  // secondary line under the title
  nameScrim:  'rgba(0,0,0,0.4)',      // behind a name on a tile
  badgeScrim: 'rgba(0,0,0,0.55)',     // behind a small badge on a tile
  shareTint:  'rgba(157,110,255,0.30)', // "X is sharing" banner (lavender)
  pill:       'rgba(255,255,255,0.16)', // small chip on the dark surface
  swatchIdle:     'rgba(255,255,255,0.05)', // filter swatch with no colour of its own ("None")
  swatchIdleEdge: 'rgba(255,255,255,0.4)',  // its outline, so the empty swatch still shows
  shareBanner: 'rgba(148,102,203,0.92)', // "You're sharing your screen" banner on video: white 12 pt bold at 4.82:1 over black (was 157,111,208 — 4.33:1)
  stripScrim: 'rgba(10,10,15,0.7)',   // behind the video Tint strip, so its labels read over any frame
  // The in-app "call in progress" strip (components/CallBar.tsx). It carries
  // white 14 pt names and 12 pt hints, so it is a deep green that holds them to
  // AA (6.58:1 white, 4.84:1 for the 80% hint). The old #1F9D55 was 3.49:1.
  bar:        '#0F6B3E',
  barHint:    'rgba(255,255,255,0.8)',
  // In-call chat sheet (components/call/CallChatSheet.tsx).
  sheet:      '#15151C',              // sheet surface on the dark call screen
  chatMine:   '#2B66FA',              // my message bubble: white 15 pt text at 4.79:1 (was #2F6BFF, 4.499:1)
};

// Text over live video needs a shadow to stay legible on bright frames.
export const CALL_TEXT_SHADOW = {
  textShadowColor: 'rgba(0,0,0,0.6)',
  textShadowOffset: { width: 0, height: 1 },
  textShadowRadius: 3,
} as const;
