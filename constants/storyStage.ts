// constants/storyStage.ts — the story viewer's always-black stage.
//
// WHY THESE COLOURS ARE FIXED. Stories play full-bleed on black in every theme
// (the WhatsApp model): the media sets the picture, the status bar is light,
// and every glyph over it is white. App theme tokens flip to dark-on-light in
// light mode and would vanish here. components/status/GateChallenge.tsx (the
// puzzle / question gate in front of a locked status) sits on this stage.
// app/story-viewer.tsx keeps a matching local STAGE for its own chrome.
//
// constants/storyStage.selftest.ts proves every text ink here is AA (4.5:1)
// on the stage.
import { ON_MEDIA_INK } from './theme';

export const STORY_STAGE = {
  bg: '#000000',
  ink: ON_MEDIA_INK,                 // titles, icons, button labels
  faint: 'rgba(255,255,255,0.62)',   // hints and placeholders (0.45 was 4.41:1)
  field: 'rgba(255,255,255,0.10)',   // a text field's fill
  error: '#FF8A7A',                  // "That's not it" — a light red that reads on black
} as const;
