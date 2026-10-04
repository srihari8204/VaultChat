// constants/storyPalette.ts — the text-status (story) background choices.
//
// WHY THESE COLOURS ARE FIXED. A text status's background is the story's own
// artwork: it is posted with the story (lib/chatService postTextStory) and the
// viewer (app/story-viewer.tsx) paints it with white text in every theme, on
// the poster's phone and everyone else's. A theme token would change the story
// with the viewer's theme, so these are fixed colours, not app chrome.
//
// Every swatch carries white text, so every swatch must give white AA contrast
// for normal text (4.5:1), even though the story text is large: the composer's
// ink is the always-dark palette's 96% white, not pure white.
// constants/storyPalette.selftest.ts proves it. Teal, Red, Blue and Orange were
// the lighter Material 400 shades until 2026-10 (white on Orange was 1.94:1);
// stories already posted keep the colour they were posted with.
export const TEXT_STORY_SWATCHES = [
  { color: '#0B0B10', name: 'Black' },
  { color: '#7E57C2', name: 'Purple' },
  { color: '#00796B', name: 'Teal' },
  { color: '#D32F2F', name: 'Red' },
  { color: '#1565C0', name: 'Blue' },
  { color: '#C2410C', name: 'Orange' },
  { color: '#5C6BC0', name: 'Indigo' },
] as const;
