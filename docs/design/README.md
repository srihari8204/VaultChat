# VaultChat — Premium UI Design Package

Desktop UI/UX concept for VaultChat: end-to-end encrypted messaging with split-screen
conversations, a Universal File Viewer that renders every shared format natively, and a
Reading Mode that turns long messages into pages.

**Style:** dark, glassmorphism, Fluent/Linear/Figma-grade, accent `#7C4DFF`.
Desktop only — no phones, no whiteboard, no canvas, no AI meeting screens, no analytics.

## What's here

| Path | What it is |
|---|---|
| `vaultchat-storyboard-4k.html` | **The infographic.** One 3840 px-wide board: all 23 screens, labelled `A1…D3`, connected by navigation arrows, plus a design-token legend and a flow map. Open in a browser — it fits to your window by default; click the pill at the top for 100%. |
| `screens/*.html` | **23 implementation-ready screens**, each a standalone 1920×1080 desktop mockup. Open any one directly. |
| `fragments/*.html` | Source for each screen (style block + markup, no boilerplate). Edit these. |
| `tokens.css` | The design system: color, elevation, geometry, type, and every shared component (glass surfaces, rail, chat bubbles, composer, chips, toolbars, tables, tree, slider, toggle…). |
| `sprite.svg` | Shared line-icon set, referenced as `<svg class="ic"><use href="#i-name"/></svg>`. |
| `FRAGMENT-SPEC.md` | Authoring contract + the written brief behind every screen. |
| `build.mjs` | `node build.mjs` rebuilds all screens and the infographic. `node build.mjs 09-excel.html` rebuilds one. |

## The 23 screens

**Section A — Chat, split in two**
`A1` Open VaultChat · `A2` First chat · `A3` Long-press → context menu (split vertically /
horizontally) · `A4` Two chats side by side · `A5` Drag divider (30/70 · 50/50 · 70/30) ·
`A6` Horizontal split, swap, close

**Section B — The Universal File Viewer**
`B1` Files arriving in chat · `B2` Word (two-page book / single page / continuous scroll,
contents, bookmarks, comments, tables, hyperlinks, headers, footers, reading progress) ·
`B3` Excel (sheets, hidden sheets, formula inspection, freeze panes, filter, sort,
conditional formatting, cell comments, pivot, charts) · `B4` PowerPoint (presenter mode,
slide sorter, thumbnails, notes, animations, embedded video, fullscreen, zoom) ·
`B5` PDF (highlight, draw, comment, fill forms, digital signature, OCR search, thumbnails,
bookmarks) · `B6` Images (compare, zoom, rotate, slideshow, fullscreen, EXIF) ·
`B7` Video (chapters, subtitles, speed, frame preview, picture-in-picture, landscape) ·
`B8` Audio (waveform, bookmarks, speed, transcript) · `B9` Archives (ZIP · RAR · 7Z,
browse and preview without extracting) · `B10` Code, data & logs · `B11` Bookshelf
(Recent, Pinned, Favorites, Shared with me, Downloads, Collections, Folders)

**Section C — Reading Mode**
`C1` Long-content detection with Reader / Chat choice · `C2` The reader page (contents,
bookmarks, search, highlight, progress, copy, share, download, print, Export PDF; switch
Chat ⇄ Reader at any time) · `C3` Themes (Dark · Light · Sepia · AMOLED), fonts (Serif ·
Sans · Monospace), text size, line spacing, margins, continuous scroll vs book pages

**Section D — Everywhere**
`D1` Search everywhere · `D2` Offline vault · `D3` Security & vault controls

## Formats the viewer renders natively

DOC · DOCX · XLS · XLSX · PPT · PPTX · PDF · TXT · MD · CSV · JSON · XML · HTML ·
JPG · PNG · GIF · SVG · WEBP · MP4 · MOV · MKV · MP3 · WAV · ZIP · RAR · 7Z · code · logs

No external application ever opens; nothing requires a download. Every viewer screen
carries that guarantee in its header.

## Notes for implementers

- Screens are static mockups: interaction states (hover, pressed, mid-drag, selection)
  are drawn explicitly where the story needs them.
- Everything is vector/CSS — zoom to inspect real spacing, radii, and color values.
- `tokens.css` is the contract. Build components from it rather than restyling per screen;
  fragment CSS is namespaced under each screen's `#s-…` id for exactly that reason.
- Semantic color (green ok / amber pending / red error) is separate from the purple accent,
  which marks the active, the selected, and the primary action.
