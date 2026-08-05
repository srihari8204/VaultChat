# VaultChat — Premium UI Design Package

UI/UX concept for VaultChat: end-to-end encrypted messaging with split-screen
conversations, a Universal File Viewer that renders every shared format natively, and a
Reading Mode that turns long messages into pages.

**Two platforms, one product:** a **desktop** set (1920×1080) and a **mobile** set
(430×932). Same palette, same icon set, same features — only the layout differs.

**Style:** dark, glassmorphism, Fluent/Linear/Figma-grade, accent `#7C4DFF`.
No whiteboard, no canvas, no AI meeting screens, no analytics.

## What's here

### Desktop

| Path | What it is |
|---|---|
| `vaultchat-storyboard-4k.html` | **The desktop infographic.** One 3840 px-wide board: all 23 screens, labelled `A1…D3`, connected by navigation arrows, plus a design-token legend and a flow map. Open in a browser — it fits to your window by default; click the pill at the top for 100%. |
| `screens/*.html` | **23 implementation-ready screens**, each a standalone 1920×1080 desktop mockup. |
| `fragments/*.html` | Source for each desktop screen (style block + markup, no boilerplate). |
| `FRAGMENT-SPEC.md` | Desktop authoring contract + the brief behind every screen. |
| `build.mjs` | `node build.mjs` rebuilds all desktop screens and the infographic. `node build.mjs 09-excel.html` rebuilds one. |

### Mobile

| Path | What it is |
|---|---|
| `vaultchat-storyboard-mobile-4k.html` | **The mobile infographic.** All 23 phone screens, labelled `M1…M23`, connected by arrows, in device frames. |
| `screens-mobile/*.html` | **23 implementation-ready screens**, each a standalone 430×932 phone mockup in a device frame. |
| `mobile/*.html` | Source for each mobile screen. |
| `tokens-mobile.css` | Mobile component system layered on `tokens.css`: status bar, app bar, bottom tabs, sheets, mobile composer, viewer chrome, stacked-split divider, touch targets. |
| `FRAGMENT-SPEC-MOBILE.md` | Mobile authoring contract + the brief behind every phone screen. |
| `build-mobile.mjs` | `node build-mobile.mjs` rebuilds all mobile screens and the mobile infographic. |

### Shared by both

| Path | What it is |
|---|---|
| `tokens.css` | The design system: color, elevation, geometry, type, and every shared component (glass surfaces, chat bubbles, chips, toolbars, tables, tree, slider, toggle…). |
| `sprite.svg` | The line-icon set — **identical across desktop and mobile**, referenced as `<svg class="ic"><use href="#i-name"/></svg>`. |

## Desktop → mobile translation

The mobile set is the same product, not a reduced one. What changes is only the shell:

| Desktop | Mobile |
|---|---|
| Left icon rail | Bottom tab bar — same five destinations, same icons |
| Right-click context menu | Long-press → bottom sheet |
| Side-by-side split view | Stacked split (top/bottom), same drag-resize, swap and close |
| Two-page book spread (Word) | Single page, with Page / Book / Scroll modes |
| Hover states | Pressed states, 44 px minimum touch targets |
| Side panels | Bottom sheets and stacked cards |

Every feature carries over: the Universal File Viewer across all formats, Reading Mode
with four themes and three type families, Search Everywhere, Offline, and Security.

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
