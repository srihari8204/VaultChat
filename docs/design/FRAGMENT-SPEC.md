# VaultChat UI Screens — Fragment Authoring Spec

Design package for VaultChat: a secure messaging app with an integrated Universal File
Viewer. Desktop only. Dark theme, glassmorphism, accent `#7C4DFF`, Fluent/Linear/Figma
quality bar. Every screen is a static, pixel-complete 1920×1080 mockup.

## Contract (MUST follow exactly)

Each screen lives in `docs/design/fragments/NN-slug.html` and contains **exactly**:

```html
<style>
/* EVERY selector prefixed with #s-slug  (the screen's own id) */
#s-slug .something { … }
</style>
<div class="screen" id="s-slug">
  … 1920×1080 content …
</div>
```

- No `<html>`, `<head>`, `<body>`, no `<script>`, no external URLs, no raster images.
- All selectors in the `<style>` block MUST start with `#s-slug` (prevents collisions
  when all screens are inlined into one infographic document).
- `tokens.css` (same folder) is globally available — use its components and variables.
  Do NOT restyle or override token classes globally; extend via `#s-slug` selectors.
- Icons: `<svg class="ic"><use href="#i-name"/></svg>` — sprite is injected at build
  time. Available ids: lock shield chat search mic clip send smile phone video more-v
  more-h check check2 chev-l chev-r chev-d chev-u close plus minus pin star folder file
  doc-lines grid image play pause volume download share print bookmark zoom-in zoom-out
  rotate expand pip pen marker sign comment toc type sun moon cloud-off cloud-check
  clock eye eye-off droplet swap split-v split-h copy book sync globe code zip music
  film filter sort freeze chart pivot fx bell settings speed subtitles chapters wave
  transcript layers hyperlink timer notes presenter ocr form slideshow compare exif
  frame log. Size via `.ic` / `.ic.sm` / `.ic.lg` / `.ic.xl` or `#s-slug` CSS.
- The mock is static: draw hover/pressed/focus states explicitly where the story needs
  them (e.g. a highlighted menu row, a mid-drag divider with tooltip).
- Draw a decorative `.scroll-rail` (with `.thumb`) on any region that would scroll.
- Everything must fit 1920×1080 with `overflow:hidden` — nothing important clipped.

## Quality bar

- Figma/Linear/Fluent-grade polish: 8pt spacing rhythm, aligned optical edges,
  restrained borders (`--stroke`), glass panels (`.glass`, `.glass-float`) over the
  ambient background, soft `--sh-2/--sh-3` elevation, `--grad-acc` only on primary
  actions/active states.
- Real content everywhere. NO lorem ipsum, no "Item 1/2/3". Use the shared cast and
  file set below so all 23 screens tell one coherent story.
- Text sizes: 10–13.5px UI copy, `--txt-2/--txt-3` for secondary text. Numbers in
  tables get `font-variant-numeric: tabular-nums` (`.dtable` has it).
- Purple is an accent, not a paint bucket: grounds stay dark neutral; accent marks
  the active, the selected, the primary.

## Shared cast & files (use these names verbatim)

People: **you = "Srihari"** (initials SB, `av-6`; outgoing `.bubble.out`), Maya Chen
(`av-1`, online), Ravi Patel (`av-4`), Elena Voss (`av-2`), Marcus Webb (`av-3`).
Groups: "Atlas Launch" (`av-5`), "Design Guild" (`av-3`), "Legal — NDA Review"
(`av-2`), "Release 1.3" (`av-4`).

Project narrative: the team is shipping "Atlas", a product launch. Files that appear
across screens (keep names/sizes consistent):

| File | Type chip | Size |
|---|---|---|
| Atlas-Proposal.docx | ft-doc "DOC" | 4.2 MB · 24 pages |
| Atlas-Financials-FY26.xlsx | ft-xls "XLS" | 1.8 MB · 6 sheets |
| Atlas-Launch-Deck.pptx | ft-ppt "PPT" | 12.6 MB · 18 slides |
| Atlas-MSA-Contract.pdf | ft-pdf "PDF" | 2.1 MB · 14 pages |
| hero-shoot-042.jpg / hero-v2.webp / logo-motion.gif / atlas-mark.svg | ft-img | 3.4 MB |
| Atlas-Demo-v3.mp4 (also .mov/.mkv variants) | ft-vid | 148 MB · 04:36 |
| Standup-2026-08-04.mp3 (also .wav) | ft-aud | 9.2 MB · 12:04 |
| Design-Assets.zip (also .rar/.7z) | ft-zip | 86 MB |
| release-notes.md · metrics.csv · config.json · schema.xml · index.html · deploy.log · PaymentService.ts | ft-txt / ft-code | small |

## Shared chrome snippets (copy verbatim, then adapt the `active` rail item)

Titlebar — first child of `.screen` on chat-type screens:

```html
<header class="vc-titlebar">
  <div class="vc-brand"><span class="vc-logo"><svg class="ic"><use href="#i-shield"/></svg></span>VaultChat</div>
  <div class="vc-search"><svg class="ic sm"><use href="#i-search"/></svg><span class="grow">Search chats, people, and every file…</span><span class="kbd">Ctrl K</span></div>
  <div class="row gap-4">
    <span class="icon-btn sm"><svg class="ic sm"><use href="#i-cloud-check"/></svg></span>
    <span class="icon-btn sm"><svg class="ic sm"><use href="#i-bell"/></svg></span>
    <span class="avatar sm av-6" style="width:26px;height:26px;font-size:10px;border-radius:9px">SB</span>
  </div>
  <div class="vc-win"><span>─</span><span>▢</span><span class="close">✕</span></div>
</header>
```

Below the titlebar: `<div class="row grow" style="align-items:stretch;min-height:0">`
containing the rail, then panels.

Nav rail (set `.active` on the item matching your screen):

```html
<nav class="vc-rail">
  <div class="rail-btn active"><svg class="ic lg"><use href="#i-chat"/></svg></div><div class="rail-label">Chats</div>
  <div class="rail-btn"><svg class="ic lg"><use href="#i-book"/></svg></div><div class="rail-label">Shelf</div>
  <div class="rail-btn"><svg class="ic lg"><use href="#i-search"/></svg></div><div class="rail-label">Search</div>
  <div class="rail-btn"><svg class="ic lg"><use href="#i-cloud-off"/></svg></div><div class="rail-label">Offline</div>
  <div class="rail-btn"><svg class="ic lg"><use href="#i-shield"/></svg></div><div class="rail-label">Vault</div>
  <div class="rail-spacer"></div>
  <div class="rail-btn"><svg class="ic lg"><use href="#i-settings"/></svg></div>
</nav>
```

Viewer screens (Word/Excel/PPT/PDF/image/video/audio/archive/code) replace the
titlebar with a **viewer bar** (`.vc-viewerbar`), first child of `.screen`:

```html
<header class="vc-viewerbar">
  <span class="icon-btn framed"><svg class="ic"><use href="#i-chev-l"/></svg></span>
  <span class="filecard-mini"><!-- 30px ft-* tile with type label --></span>
  <div class="col" style="gap:1px">
    <span style="font-size:13.5px;font-weight:600">Atlas-Proposal.docx</span>
    <span style="font-size:11px;color:var(--txt-3)">Shared by Maya Chen · 4.2 MB · in Atlas Launch</span>
  </div>
  <span class="secure-pill"><svg class="ic sm"><use href="#i-lock"/></svg>Rendered inside VaultChat — no external apps, nothing leaves the vault</span>
  <div class="grow"></div>
  <!-- viewer-specific actions -->
  <div class="vc-win"><span>─</span><span>▢</span><span class="close">✕</span></div>
</header>
```

The secure pill MUST appear on every viewer screen (it carries requirement §B:
"no external application ever opens; every file renders inside VaultChat").

---

## Screen briefs

### 01-home — `#s-home` · "VaultChat opened"
Titlebar + rail (Chats active) + sidebar (360px, glass): "Chats" heading + compose
`icon-btn` (`i-pen`) · `.field.focus` search "Search conversations" · filter chips All
(active) / Unread / Groups / Pinned · 8 `.convo` items using the cast (Maya Chen active
+ online dot, Atlas Launch with `.badge` 3, Design Guild, Elena Voss with `i-pin`,
Release 1.3 badge 12, Ravi Patel, Marcus Webb, Legal — NDA Review) with realistic
previews ("Maya: uploaded Atlas-Proposal.docx", "typing…" in accent, etc.) + times.
Main area = welcome state: centered glass card (~560px) with large `vc-logo`-style mark
(56px), "Your conversations are sealed." H1 (26px, `--grad-text`), sub-line "End-to-end
encrypted messaging with a built-in viewer for every file your team shares — nothing
ever leaves VaultChat.", three small feature tiles in a row (Split chats `i-split-v`,
Universal viewer `i-file`, Reader mode `i-book`), primary button "Start a secure chat"
+ ghost "Open Bookshelf". Footer chip row: `secure-pill` "AES-256 · End-to-end
encrypted", chip "Zero-knowledge sync".

### 02-chat — `#s-chat` (EXEMPLAR — already written; read it before authoring yours)
Single conversation with Maya Chen. Reference for: header pattern, bubbles, file card
in bubble, reactions, typing indicator, composer with voice+attach+send, E2E chip.

### 03-context-menu — `#s-context` · "Long-press → Open in Split View"
Exact layout of 02 (chat with Maya open, dimmed ~55% via an overlay tint) with the
sidebar's "Atlas Launch" convo row lifted (pressed state: slight scale, stroke-acc ring,
`--sh-3`) and a `.menu` floating beside it (z-index above overlay): title "Atlas Launch",
items: Open · **Open in Split View** (`.hl`, `i-split-v`, kbd "Ctrl ⇧ S") with a nested
flyout submenu to its right: "Split vertically ▍▍" (`i-split-v`, `.hl`) / "Split
horizontally ▬▬" (`i-split-h`) · Mark as read (`i-check2`) · Pin (`i-pin`) · Mute
(`i-bell`) · sep · Archive · Delete (`.danger`). Draw a soft cursor arrow (CSS triangle
or small SVG) pressing the row. Caption chip near menu: `.tip` "Long-press or
right-click any conversation".

### 04-split-vertical — `#s-split-v` · "Two chats side by side, 50/50"
Titlebar + rail; NO sidebar (collapsed to give both panes room — show a thin 52px
collapsed sidebar strip with avatars only). Two complete chat panes (Maya Chen | Atlas
Launch), EACH with: full header (avatar, name, presence/members, E2E lock chip, search
`i-search`, phone, video, more-v), 4–6 messages (reuse 02's voice; Atlas Launch is a
group — show sender names above `.in` bubbles, distinct avatar colors), its own
composer (attach, placeholder, smile, mic, send). Center divider (10px): vertical glass
rail with grip dots and a floating `.tip` on it: `i-swap` "Swap panes". Top-right of
each pane header: small "50%" chip. A slim glass bar above panes: chips "Split view"
(active, `i-split-v`), "Swap" (`i-swap`), "Close split ✕" — right-aligned.

### 05-split-resize — `#s-split-resize` · "Dragging the divider — 30 / 70"
Same as 04 but mid-drag: left pane (Maya) at 30% (its composer/text truncates
gracefully), right (Atlas Launch) at 70%. Divider glows (`--glow`), cursor glyph
(resize ↔) on it, floating `.tip` above cursor: "30% · 70%". Under the top bar center,
a small glass segmented control showing snap points: `30/70` · `50/50` (idle) ·
`70/30` — current one active. Right pane shows more message history to justify width.

### 06-split-horizontal — `#s-split-h` · "Horizontal split, stacked"
Like 04 but stacked: Maya Chen pane on top, Design Guild below; horizontal glass
divider with grip + tip `i-swap` "Swap panes"; top bar chips show "Split view"
(`i-split-h` active) / "Close split". Each pane keeps header + 2–3 messages + its own
full composer. "50%" chips on both.

### 07-files-in-chat — `#s-files` · "Every format opens inside VaultChat"
Chat layout (titlebar/rail/sidebar compact 300px, Atlas Launch active). Conversation
shows a burst of shared files as bubbles from different senders: filecards for
Atlas-Proposal.docx, Atlas-Financials-FY26.xlsx, Atlas-Launch-Deck.pptx,
Atlas-MSA-Contract.pdf, Design-Assets.zip; an image grid bubble (2×2 gradient
thumbnails: hero-shoot-042.jpg, hero-v2.webp, logo-motion.gif chip "GIF",
atlas-mark.svg chip "SVG"); a video card (Atlas-Demo-v3.mp4, 16:9 gradient thumb,
play button, "04:36"); an audio card (Standup-2026-08-04.mp3 with mini waveform).
Each filecard gets a hover-state "Open" `.btn.sm.btn-primary` on the PDF one +
`.tip` "Opens instantly — no download, no external app". Right side: slide-over
glass panel (380px) "Shared in this chat" listing ALL supported formats as small
rows grouped by section — Documents: DOC DOCX PDF TXT MD | Data: XLS XLSX CSV JSON
XML HTML | Media: JPG PNG GIF SVG WEBP MP4 MOV MKV MP3 WAV | Code & logs: TS JSON
LOG | Archives: ZIP RAR 7Z — each row: `.filecard .f-ic` mini tile + extension +
count. Panel footer: `secure-pill` full-width "Every format renders natively inside
VaultChat".

### 08-word — `#s-word` · "Word viewer — book mode"
Viewer bar (Atlas-Proposal.docx) with actions: view-mode segmented control [Two-page
book (active `i-book`) | Single page (`i-file`) | Continuous scroll (`i-toc`)], sep,
theme toggle `i-moon`(active)/`i-sun`, Print `i-print`, Share `i-share`, Download
`i-download`. Left panel (300px glass): tabs "Contents" (active) / "Bookmarks" /
"Comments"; TOC tree (Executive Summary active · Market Opportunity · Product
Strategy > Architecture / Rollout Phases · Financial Model · Risk Register ·
Appendix) with page numbers. Center: TWO white-ish paper pages side by side
(#F7F5FF-on-dark reading surface — pages are LIGHT to read like paper, subtle
book-gutter shadow between, rounded 8px, `--sh-3`): left page = "2. Market
Opportunity" with heading, running header "Atlas Proposal — Confidential", real
paragraph copy (2–3 short paras), a small data table (3×4: Segment/TAM/Growth), an
inline hyperlink (accent, underlined), a comment highlight (soft amber span) with a
margin comment bubble "Elena Voss: verify this TAM figure — 2d ago"; right page =
continued copy + an image placeholder block (gradient, caption "Fig 3 — Atlas
positioning map") + footer with page number "8" / "9 of 24" on respective pages.
Bottom center floating `.toolbar`: `chev-l` Previous · "Pages 8–9 of 24" · `chev-r`
Next · sep · zoom-out "110%" zoom-in · sep · `i-search` Search in document ·
`i-bookmark` Bookmark page. Very bottom: reading `.progress` (35%) full-width with
"35% read · 18 min left" label.

### 09-excel — `#s-excel` · "Excel viewer — native grid"
Viewer bar (Atlas-Financials-FY26.xlsx). Under it a spreadsheet chrome column:
formula bar row: cell ref box "D14", `i-fx`, formula "=SUM(D2:D13)*1.18" in mono,
right: `i-search` "Find in cells", buttons Filter `i-filter` (active) · Sort `i-sort`
· Freeze `i-freeze` (active) · Pivot `i-pivot` · Chart `i-chart`. Main split: grid
(≈70%) + right insights panel (≈30%). Grid: column headers A–H + row numbers 1–18;
header row (bold, frozen — accent bottom border + tiny lock glyph) "Region · Month ·
Product · Revenue · COGS · Margin · Growth % · Owner"; realistic FY26 numbers;
frozen first column (subtle right accent border); D14 selected (accent ring cell +
row/col header highlight); a conditional-formatting Margin column with green/amber/
red value pills; two filtered column headers show funnel glyphs; one cell (F7) has a
red corner tick + comment popover "Ravi: COGS restated after vendor credit". Sheet
tab strip at bottom: "Summary" · "Revenue" (active) · "Forecast" · "Pivot" ·
"Charts" + a ghost "2 hidden" chip (`i-eye-off`) + "+". Right panel (glass): mini
column chart "Revenue by region" (CSS bars), below it a small pivot table (Region ×
Quarter with totals, `.dtable`), footer note chip "Formulas preserved — live
inspection".

### 10-powerpoint — `#s-ppt` · "PowerPoint — presenter mode"
Viewer bar (Atlas-Launch-Deck.pptx) + actions: segmented [Presenter (active
`i-presenter`) | Slide sorter (`i-grid`) | Fullscreen (`i-expand`)], zoom pair.
Left: vertical thumbnail rail (110px wide, slides 1–8, slide 5 active with accent
ring; slide 6 shows tiny play-badge = embedded video). Center-left LARGE current
slide (16:9, dark premium slide design: "Atlas changes how teams ship" headline,
purple gradient bar chart, VaultChat-dark aesthetic), slide footer "5 / 18"; an
"Animations: 3" chip with `i-layers` top-right of slide + a subtle "entrance" arrow
overlay on the chart. Center-right column: "Next slide" small preview (slide 6 with
embedded video thumb + play), below it Speaker notes glass panel (mono-ish 12.5px,
3 bullet notes), below a timer row: `i-timer` 00:12:47 elapsed · slide 5 of 18 ·
`chev-l` `chev-r`. Bottom: thin progress of deck.

### 11-pdf — `#s-pdf` · "PDF — annotate, fill & sign"
Viewer bar (Atlas-MSA-Contract.pdf). Left rail (170px): page thumbnails 1–6 (page 3
active, page 2 shows yellow highlight marks, page 6 shows signature scribble),
below tabs Bookmarks / Annotations. Center: single light paper page (contract:
"Master Service Agreement — Atlas Deployment", numbered clauses; §3.2 has amber
highlight; a red ink freehand oval around a fee figure with margin note "check
uplift %" (Maya, accent card); an interactive FORM section: two filled form fields
(Company: "Corefinite Ltd", Effective date picker) drawn as accent-bordered inputs
+ one empty required field; bottom of page a signature box with a drawn signature
stroke + chip "Digitally signed · SHA-256 · 05 Aug 2026" `i-sign`). Floating left-
center vertical `.toolbar`: select, Highlight `i-marker` (active), Draw `i-pen`,
Comment `i-comment`, Form fill `i-form`, Sign `i-sign`, sep, OCR search `i-ocr`.
Top-right of page area: `.field.focus` "indemnif|" search with "4 of 11 matches ·
includes OCR text" dropdown hint. Bottom toolbar: page nav "3 / 14", zoom "125%",
fit-width, `i-bookmark`.

### 12-image — `#s-image` · "Image viewer — compare & inspect"
Viewer bar (hero-shoot-042.jpg · chips JPG GIF SVG WEBP supported). Main stage:
COMPARE mode — two large gradient "photos" (before: cooler/darker "hero-shoot-042.jpg
· Original", after: vibrant purple "hero-v2.webp · Edited") separated by a draggable
compare handle (vertical line + circular ⇄ grip). Under stage: filmstrip of 7 thumbs
(2 marked GIF/SVG badges; active pair ringed). Right panel (320px): "Info" with EXIF
`.dtable`-ish rows: Camera Sony A7 IV · 35mm f/1.8 · 1/250s · ISO 200 · 6000×4000 ·
8.4 MB · Taken 02 Aug 2026 · Location chip. Floating bottom `.toolbar`: zoom-out
"100%" zoom-in · Rotate `i-rotate` · Compare `i-compare` (active) · Slideshow
`i-slideshow` · Fullscreen `i-expand` · Info `i-exif` (active). A `.tip` on handle:
"Drag to compare".

### 13-video — `#s-video` · "Video player"
Viewer bar (Atlas-Demo-v3.mp4 · chips MP4 MOV MKV). Full-bleed 16:9 stage (dark
gradient scene with soft purple product glow + big center play/pause). Subtitle line
near bottom center: glass caption ""Every file opens right where the conversation
is."". Control deck (glass, bottom): seek bar with buffered segment + chapter ticks
(4) + a FRAME-PREVIEW popover above the scrubber cursor (small 16:9 thumb + "02:41");
row: play `i-pause`, vol `i-volume` + mini slider, time "02:41 / 04:36" mono, chips:
CC (active) · 1.5× speed · Chapters `i-chapters` · PiP `i-pip` · Landscape/rotate
`i-rotate` · Fullscreen `i-expand`. Right slide-over (300px): "Chapters" list — 00:00
Intro · 00:48 Split view · 02:10 File viewer (active accent) · 03:22 Reader mode,
each with mini thumb. Also a small PiP preview window pinned bottom-right corner of
the SCREEN (draggable mini player with the same scene + tiny controls) to show PiP.

### 14-audio — `#s-audio` · "Audio player — waveform & transcript"
Viewer bar (Standup-2026-08-04.mp3 · chips MP3 WAV). Top half: big waveform (≈90
vertical bars, played portion in `--grad-acc`, rest muted; playhead line + time
bubble "04:12"); three bookmark pins on the waveform (`i-bookmark`, labels "Decision:
ship Friday", "Blocker: QA env", "Action: Maya designs"). Controls row: back-15,
play, fwd-30, time "04:12 / 12:04", speed chip "1.5×", volume, `i-bookmark` "Add
bookmark", Download/Share. Bottom half: "Live transcript" glass panel — 5 speaker-
labelled lines (Maya/Ravi/Srihari with tiny avatars + timestamps), current line
highlighted accent with the spoken word bolded; top-right of panel: `i-search`
transcript search field + "Export transcript" ghost btn.

### 15-archive — `#s-archive` · "Archive — browse without extracting"
Viewer bar (Design-Assets.zip · chips ZIP RAR 7Z). Left: tree (Design-Assets.zip
root expanded: 01-Brand/ (logo-dark.svg, logo-light.svg…), 02-Screens/ (12 files),
03-Motion/ (logo-motion.gif, intro.mp4), fonts/ , README.md — folder icons, file
type mini-tiles, sizes; 02-Screens active). Center: grid of the selected folder's
contents (image thumb cards with gradient fills + names + sizes). Right: preview
panel — selected file "chat-dark.png" large gradient preview + meta rows
(compressed 1.2 MB → 3.8 MB, CRC ok `i-check` chip, path). Header strip above
grid: breadcrumb "Design-Assets.zip / 02-Screens", stats "247 files · 86 MB ·
compressed 62%", `.btn` "Extract all" + note chip "Preview without extracting".

### 16-code-data — `#s-code` · "Code, data & log viewer"
Viewer bar (PaymentService.ts · chips TS · JSON · XML · HTML · MD · CSV · LOG).
Top tabs (file tabs): PaymentService.ts (active) · config.json · schema.xml ·
release-notes.md · metrics.csv · deploy.log. Main split: LEFT code editor pane
(mono 12.5px, line numbers, syntax-highlight via colored spans: keywords accent,
strings green, comments txt-3; ~18 lines of a plausible TS payment class with a
folded region marker); minimap strip at right of pane. RIGHT column stacked: (a)
"config.json" tree view (collapsible keys, string/number value colors, 10 lines),
(b) "deploy.log" panel — 6 log rows with level pills (INFO ok, WARN amber, ERROR
red + accent left stripe on the error row), mono, timestamps, footer "Tail — live".
Bottom status bar: language "TypeScript", "UTF-8", "LF", "342 lines", branch chip
"main", `secure-pill` short: "Read-only vault copy".

### 17-bookshelf — `#s-shelf` · "Bookshelf — every file, one place"
Titlebar + rail (Shelf active). Left panel (260px): "Bookshelf" heading;
nav list: Recent (active `i-clock`), Pinned `i-pin`, Favorites `i-star`, Shared
with me `i-share`, Downloads `i-download`; section label "Collections": Atlas
Launch (12) `i-folder`, Legal (5), Brand (23), + "New collection" ghost; section
label "Folders": Contracts, Receipts, Screens. Main: header row "Recent" + sort
chip "Last opened ▾" + view toggle grid/list + `.field` filter. Grid of 8 file
cards (160px-tall glass cards: large ft-* tile as cover with big extension label,
name, meta "Opened 2h ago · Maya Chen", star/pin marks on some, PDF card shows
reading progress bar 62%, hover state on one card with quick actions Open ·
Share). One card is the DOCX with a book-cover treatment (gradient cover, title
overlaid) to echo the reader. Footer strip: storage chip "38.2 GB in vault ·
end-to-end encrypted" + chips "Synced `i-cloud-check`" "3 available offline".

### 18-reader-detect — `#s-reader-detect` · "Long message → Reader"
Chat with Design Guild (titlebar/rail/sidebar 300px). Last incoming bubble from
Marcus is a LONG wall of text (6–7 lines shown then a soft fade-out mask) with
chip on it: `i-book` "Long read · ~1,400 words". Centered above composer floats a
glass-float dialog (460px): icon row (`i-book` in accent tile), title "This
message is easier as a page", body "VaultChat converts long messages into a clean
reading view when they're too large for comfortable chat. You can switch back
any time.", meta row: "~1,400 words · 6 min read · 3 pages", buttons: primary
"Open in Reader" + ghost "View as chat", tiny checkbox row "Always open long
messages in Reader". Dim the chat behind the dialog slightly. A `.tip` near the
bubble chip: "Auto-detected: too long for a bubble".

### 19-reader — `#s-reader` · "Reader — the message as a page"
Full-screen reader chrome (its own bar): back chev-l, source chip "From Design
Guild · Marcus Webb · today 09:12", center segmented [Chat view `i-chat` | Reader
view `i-book` (active)], right: `i-search` `i-bookmark` `i-type` (opens settings)
`i-share` more-v. Left slim TOC panel (240px): "The Atlas Rollout Plan" contents
(Why we're changing the rollout (active) · Phase timeline · Risks we accept ·
What we need from every team · FAQ). Center column (720px, LIGHT sepia-tinted
paper #F6F1E7 for contrast with dark chrome): cover block — kicker "DESIGN GUILD
· LONG MESSAGE", serif title "The Atlas Rollout Plan" (34px), byline row (Marcus
avatar + name + "6 min read · 3 pages · 1,412 words"); body in serif: intro para,
H2 "Why we're changing the rollout", para with an accent-underlined link, bullet
list (3), a small table (Phase/Date/Owner), a code block (dark inset, mono, 3
lines), a pull-quote with accent left bar, one sentence carrying a reader
HIGHLIGHT (amber wash + margin `i-marker` mark). Right margin: reading progress
rail (vertical, 42%) + floating page chip "Page 1 of 3". Bottom floating toolbar:
`i-marker` Highlight · `i-copy` Copy · `i-share` Share · `i-download` Download ·
`i-print` Print · "Export PDF" btn.

### 20-reader-settings — `#s-reader-settings` · "Reader themes & typography"
Same reader as 19 (dimmed, content behind) with the `i-type` settings popover
open (glass-float, 400px, anchored top-right): sections — "Theme": 4 swatch cards
in a row: Dark (active ring) · Light · Sepia · AMOLED (true-black swatch with
"OLED" tag), each swatch shows mini "Aa" in its scheme; "Font": segmented Serif
(active, in serif) · Sans · Monospace (each label set in its own face); "Text
size": slider with A⁻ / A⁺ ends (value "18px"); "Line spacing": slider ("1.6");
"Margins": segmented Narrow · Comfortable (active) · Wide; "Layout": segmented
Continuous scroll (active) · Book pages; footer row: "Reset" ghost + "Done"
primary. The reader page behind should visibly render in DARK theme this time
(dark paper, light serif text) to show theme switching. Keep the settings popover
sharp (not dimmed).

### 21-search — `#s-search` · "Search everywhere"
Titlebar + rail (Search active). Center-top: huge search field (720px,
`.field.focus`, 46px) query "atlas pricing" with kbd Esc; under it scope chips:
All (active) · Chats · Documents · Spreadsheets · Slides · PDFs · Images · Videos
· Audio · Files. Results in two columns of glass group cards, each group header =
icon + type + count, rows with accent-highlighted match text: Chats (2: Maya
"…**pricing** tiers land tomorrow", Atlas Launch group msg), Word (Atlas-
Proposal.docx · "Section 4.2 — **Pricing** strategy" + page 12 chip), Excel
(Atlas-Financials-FY26.xlsx · cell match "Revenue!D14 · Enterprise **pricing**"),
Slides (Atlas-Launch-Deck.pptx · slide 9 thumb "**Pricing** — 3 tiers"), PDF
(Atlas-MSA-Contract.pdf · "§7 Fees — OCR match" chip `i-ocr`), Images (hero
shots row of 3 thumbs, one tagged "text-in-image match"), Video (Atlas-Demo-v3
.mp4 · transcript hit at 02:41 with mini thumb), Audio (Standup mp3 · transcript
"…align on **pricing**…" at 04:12), Files (metrics.csv, config.json rows).
Footer status: "9 sources searched · 0.14 s · encrypted index, on-device".

### 22-offline — `#s-offline` · "Offline vault"
Titlebar + rail (Offline active). Page header: `i-cloud-off` in amber-tinted tile
+ "Offline" H1 + status chip amber "You're offline — changes sync when you're
back" + toggle row "Available offline". KPI strip (4 glass tiles): Downloaded
"1.2 GB · 34 files", Sync pending "3 items", Synced "Everything else
`i-cloud-check`", Auto-download chip "Wi-Fi only". Main table (`.dtable`-based,
full-width glass card): columns Name / Where / Size / State — 7 rows mixing
states as chips: Atlas-Proposal.docx — ok "Available offline"; Atlas-Financials
— ok; Standup mp3 — ok; hero-v2.webp — warn "Sync pending ↑"; Atlas-MSA-Contract
.pdf — warn "Sync pending · edited offline"; Atlas-Demo-v3.mp4 — ghost "Cloud
only ☁ 148 MB"; Design-Assets.zip — ghost. Right side panel: "Sync queue" — 3
progress rows (two at 100% `i-check`, one 64% with animated-looking fill),
footer note "Conflict-free: edits merge when you reconnect". Every offline-
available row gets a small green `i-check` corner tick on its file tile.

### 23-security — `#s-security` · "The vault around every file"
Titlebar + rail (Vault active). Header: shield mark (glass tile with `i-shield`
accent) + H1 "Security & vault controls" + sub "What protects this workspace,
and what you control per file." Grid 3×2 of glass feature cards (each: icon
tile, title, one-line body, status control): End-to-end encryption — "Messages
and files are sealed on your device. Keys never leave it." chip ok "Always on ·
AES-256 + X25519"; Secure file viewer — "Files render inside VaultChat's
sandbox. No external apps, ever." chip ok "Sandboxed"; View-only sharing —
"Recipients can read but not save or copy." toggle ON + mini preview of a
file card marked "View-only"; Expiring files — "Access ends automatically."
countdown chip warn "Expires in 23:12:04" + date row; Download disabled —
toggle ON + a download icon crossed with a subtle slash + note "Blocked for 3
shared files"; Watermark — toggle ON + mini page preview with diagonal
repeating "SRIHARI · 05 AUG 2026" ghost text (`i-droplet`). Footer band: audit
strip "Last key rotation 12 days ago · Device verified · SOC 2 Type II" +
ghost btn "View audit log".

---

## Section/step map (for captions — build script owns final copy)

A: 01→02→03→04→05→06 · B: 07→08→09→10→11→12→13→14→15→16→17 ·
C: 18→19→20 · D: 21→22→23
