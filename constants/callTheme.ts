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
};

// Text over live video needs a shadow to stay legible on bright frames.
export const CALL_TEXT_SHADOW = {
  textShadowColor: 'rgba(0,0,0,0.6)',
  textShadowOffset: { width: 0, height: 1 },
  textShadowRadius: 3,
} as const;
