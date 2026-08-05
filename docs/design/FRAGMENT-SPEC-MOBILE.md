# VaultChat MOBILE screens — authoring spec

Phone version of the existing VaultChat desktop design package. **Same product, same
palette, same icon set, same features — only the layout is mobile.** Dark,
glassmorphism, accent `#7C4DFF`, Fluent/Linear/Figma quality bar.

Device canvas: **430 × 932** (large phone). Nothing scrolls in the mock — every screen
is a static, pixel-complete frame.

## Contract (MUST follow exactly)

Each screen lives in `docs/design/mobile/mNN-slug.html` and contains **exactly**:

```html
<style>
/* EVERY selector prefixed with #m-slug (the screen's own id) */
#m-slug .something { … }
</style>
<div class="mscreen" id="m-slug">
  … 430 × 932 content …
</div>
```

- Root class is `.mscreen` (NOT `.screen`), root id is `#m-…`.
- No `<html>`/`<head>`/`<body>`, no `<script>`, no external URLs, no raster images.
- `tokens.css` **and** `tokens-mobile.css` are globally available. Build from their
  components; extend only under your `#m-…` prefix. Never restyle a token class globally.
- **Icons: reuse `sprite.svg` exactly as-is — do NOT invent, rename or restyle icons.**
  `<svg class="ic"><use href="#i-name"/></svg>`. Available ids: lock shield chat search
  mic clip send smile phone video more-v more-h check check2 chev-l chev-r chev-d chev-u
  close plus minus pin star folder file doc-lines grid image play pause volume download
  share print bookmark zoom-in zoom-out rotate expand pip pen marker sign comment toc
  type sun moon cloud-off cloud-check clock eye eye-off droplet swap split-v split-h copy
  book sync globe code zip music film filter sort freeze chart pivot fx bell settings
  speed subtitles chapters wave transcript layers hyperlink timer notes presenter ocr
  form slideshow compare exif frame log.
- Draw interaction states explicitly where the story needs them (pressed row, mid-drag
  divider, open sheet).
- Everything must fit 430 × 932 with nothing important clipped.

## Mobile system (from `tokens-mobile.css`) — use these, don't reinvent

`.m-status` (status bar: time + `.m-sig`/`.m-wifi`/`.m-batt` shapes) · `.m-home` (home
indicator) · `.m-appbar` · `.m-largehead` (big title) · `.m-tabbar` + `.m-tab` (bottom
nav) · `.m-ic-btn` · `.m-search` · `.m-chip`/`.m-chips` · `.m-seg`/`.sg` (segmented) ·
`.m-convo` · `.m-msgs`/`.m-bub.in|.out`/`.m-sender`/`.m-day` · `.m-composer`/`.m-send` ·
`.m-sheet`/`.m-grab`/`.m-sheet-t`/`.m-sheet-s`/`.m-act` · `.m-dim` · `.m-btn(.primary
.ghost .sm .block)` · `.m-fab` · `.m-card`/`.m-row` · `.m-tile(.sm)` + desktop `.ft-*`
gradients · `.m-viewerbar`/`.m-secure` · `.m-toolbar`/`.m-tool` · `.m-float` ·
`.m-divider(.hot)` · `.m-panehead` · `.m-tip` · `.m-scroll` · `.m-label`.
Desktop token classes still work: `.chip`, `.avatar`, `.progress`, `.slider`, `.toggle`,
`.dtable`, `.tree-item`, `.glass*`, `.secure-pill`, `.badge`, `.dot`, `.kbd`.

**Every screen starts with `.m-status` and ends with `.m-home`.**
List/hub screens (M1, M17, M21, M22, M23) carry `.m-tabbar` above `.m-home`, with the
right tab `.on`: Chats · Shelf · Search · Offline · Vault (icons i-chat, i-book,
i-search, i-cloud-off, i-shield).
Viewer screens (M8–M16) start with `.m-viewerbar` (back chevron, file tile, name +
meta, actions) followed by `.m-secure` reading
**"Opens inside VaultChat — no external app"**. That line is a hard requirement.

## Shared cast & files (verbatim — same story as the desktop set)

You = **Srihari** (SB, `av-6`, outgoing). Maya Chen (`av-1`, online), Ravi Patel
(`av-4`), Elena Voss (`av-2`), Marcus Webb (`av-3`). Groups: Atlas Launch (`av-5`),
Design Guild (`av-3`), Legal — NDA Review (`av-2`), Release 1.3 (`av-4`).

Files: Atlas-Proposal.docx (4.2 MB · 24 pages) · Atlas-Financials-FY26.xlsx (1.8 MB ·
6 sheets) · Atlas-Launch-Deck.pptx (12.6 MB · 18 slides) · Atlas-MSA-Contract.pdf
(2.1 MB · 14 pages) · hero-shoot-042.jpg / hero-v2.webp / logo-motion.gif /
atlas-mark.svg · Atlas-Demo-v3.mp4 (148 MB · 04:36) · Standup-2026-08-04.mp3
(9.2 MB · 12:04) · Design-Assets.zip (86 MB · 247 files) · release-notes.md ·
metrics.csv · config.json · deploy.log · PaymentService.ts.

Reference exemplar: **`mobile/m02-chat.html`** — read it before authoring.

---

## Screen briefs

### m01-home `#m-home` — Chat list
Status bar · `.m-largehead` "Chats" + sub "8 conversations · all sealed" with a compose
`.m-ic-btn.framed` (i-pen) right-aligned · `.m-search` "Search chats, people, and every
file" · `.m-chips` All(on)/Unread/Groups/Pinned · 7 `.m-convo` rows from the cast (Maya
Chen online + accent "typing…", Atlas Launch + `.badge` 3, Design Guild, Elena Voss with
i-pin, Release 1.3 badge 12, Ravi Patel, Legal — NDA Review) with previews and times ·
`.m-fab` (i-pen) bottom-right above the tab bar · `.m-tabbar` (Chats on) · `.m-home`.

### m02-chat `#m-chat` — EXEMPLAR, already built.

### m03-longpress `#m-press` — Long-press → split
The m01 list, dimmed by `.m-dim`; the "Atlas Launch" row lifted above the scrim in a
pressed state (scale ~1.02, `--stroke-acc` ring, `--sh-3`); a `.m-sheet` with grabber and
title "Atlas Launch", then `.m-act` rows: Open · **Open in Split View** (`.hl`, i-split-h)
· Mark as read (i-check2) · Pin (i-pin) · Mute (i-bell) · Archive (i-folder) · Delete
(`.danger`, i-close). Inside the highlighted row show a small inline choice: two mini
buttons "Stacked ▤" (on, i-split-h) and "Side by side ▥" (i-split-v). A `.m-tip`
"Hold any chat" near the pressed row.

### m04-split `#m-split` — Two chats stacked, 50/50
Status bar · a slim split bar: chip "Split view" (on, i-split-h) + spacer + `.m-ic-btn`
swap (i-swap) + close (i-close) · TOP pane: `.m-panehead` (avatar, "Maya Chen", "Online",
"50%" chip, i-more-v) + 3 messages + its own `.m-composer` (compact: attach, field, send)
· `.m-divider` with grip dots and a small centered `.m-tip` "Drag to resize" · BOTTOM
pane: `.m-panehead` ("Atlas Launch", "6 members", "50%") + 3 messages with `.m-sender`
names + its own composer · `.m-home`. Keep both panes complete and readable.

### m05-split-resize `#m-resize` — Dragging, 30/70
Same as m04 mid-drag: top pane 30% (2 messages), bottom 70% (4 messages).
`.m-divider.hot` glowing, a thumb/finger circle on it, floating `.m-tip` "30% · 70%"
above the divider, and a `.m-seg` snap control at the top showing 30/70 (on) · 50/50 ·
70/30.

### m06-split-swap `#m-swap` — Swap or close
Same layout with the panes swapped (Atlas Launch on top, Maya below) plus a small
toast/`.m-tip` centered near the divider: "Panes swapped". The top split bar shows the
swap button `.active` and a labelled "Close split" `.m-btn.sm`.

### m07-files `#m-files` — Every format arrives
Atlas Launch chat thread full of shared-file bubbles from different senders (sender name
+ small avatar on incoming): docx, xlsx, pptx cards; a 2×2 image grid bubble with GIF and
SVG badges; a video card (16:9 CSS-gradient thumb, play button, "04:36"); an audio card
with a mini waveform; a zip card ("247 files · browse without extracting"). One card
shows a pressed "Open" with a `.m-tip` "Opens instantly — no download". Then a
`.m-sheet` (half-height) titled "Shared in this chat · 64 files" listing supported
formats grouped by `.m-label` sections — Documents / Data / Media / Code & logs /
Archives — each a `.m-row` with a `.m-tile.sm` + extension + count. Sheet footer:
`.secure-pill` "Every format renders natively inside VaultChat".

### m08-word `#m-word` — Word reading
`.m-viewerbar` (Atlas-Proposal.docx · "Maya Chen · 4.2 MB") + `.m-secure`. A LIGHT paper
page (#F7F5FF, dark ink ~#2A2735) filling the width with: running header "ATLAS PROPOSAL
— CONFIDENTIAL", H1 "2. Market Opportunity", 2 short paragraphs of real business copy, a
3-row data table, an inline accent hyperlink, an amber comment highlight, a small margin
comment card from Elena Voss, and a page footer "8 of 24". Above the page a `.m-seg`:
Page (on) · Book · Scroll. Bottom: reading `.progress` (35%) with "35% read · 18 min
left", then `.m-toolbar` with `.m-tool`s: Contents (i-toc) · Bookmarks (i-bookmark) ·
Search (i-search) · Theme (i-moon, on) · Share (i-share).

### m09-excel `#m-excel` — Native grid
Viewer bar (Atlas-Financials-FY26.xlsx) + secure line. Formula row: cell ref "D14",
i-fx, mono `=SUM(D2:D13)*1.18`. Grid sized for the phone: row numbers + columns A–D
visible (Region / Month / Revenue / Margin) with a frozen accent header row and frozen
first column, ~11 data rows of plausible FY26 figures, D14 selected with an accent ring,
green/amber/red conditional-format pills in Margin, one commented cell with a red corner
tick. A horizontal `.m-chips` strip of sheet tabs: Summary · Revenue(on) · Forecast ·
Pivot · Charts · "2 hidden" (i-eye-off). `.m-toolbar`: Filter(on) · Sort · Freeze(on) ·
Pivot · Chart. Add a `.m-tip` "Pinch to zoom · swipe for more columns".

### m10-ppt `#m-ppt` — PowerPoint
Viewer bar (Atlas-Launch-Deck.pptx) + secure line. Large 16:9 slide (dark premium slide:
"Atlas changes how teams ship." + purple gradient bar chart) with "5 / 18" and an
"Animations: 3" chip (i-layers). Under it a horizontal thumbnail strip (slides 3–8, 5
active with accent ring, 6 with a play badge = embedded video). Then a "Speaker notes"
`.m-card` with 2 bullets. `.m-toolbar`: Notes(i-notes, on) · Sorter(i-grid) ·
Present(i-presenter) · Rotate(i-rotate) · Share. A `.m-tip` "Rotate for fullscreen".

### m11-pdf `#m-pdf` — Annotate & sign
Viewer bar (Atlas-MSA-Contract.pdf) + secure line. Light contract page: "3. FEES AND
PAYMENT", clauses 3.1–3.3, an amber highlight across a clause, a red freehand ink oval
around "4.5%", a filled form field (Company: Corefinite Ltd) and one empty REQUIRED
field, and a signature box with a drawn stroke + chip "Digitally signed · SHA-256".
A search row showing "indemnif" with "4 of 11 · includes OCR" (i-ocr). Page nav
"3 / 14" with chevrons. `.m-toolbar`: Highlight(i-marker, on) · Draw(i-pen) ·
Comment(i-comment) · Form(i-form) · Sign(i-sign) · Pages(i-grid).

### m12-image `#m-image` — Compare & inspect
Viewer bar (hero-shoot-042.jpg) + secure line. Full-bleed compare stage: two CSS-gradient
"photos" split by a vertical drag handle with a ⇄ grip and `.m-tip` "Drag to compare";
labels "Original" (top-left) and "hero-v2.webp · Edited" (top-right). Filmstrip of 6
thumbs below (GIF and SVG badges on two, active one ringed). A half-height `.m-sheet`
"Info · EXIF" with rows: Camera Sony A7 IV · FE 35mm f/1.8 · 1/250 s · ISO 200 ·
6000×4000 · 8.4 MB · Taken 02 Aug 2026 · Location chip "Presidio, San Francisco".
`.m-float` toolbar above the sheet: zoom-out · "100%" · zoom-in · rotate · compare(on) ·
slideshow · expand.

### m13-video `#m-video` — Player
Viewer bar (Atlas-Demo-v3.mp4 · chips MP4/MOV/MKV) + secure line. 16:9 dark stage with a
product-glow scene, centre pause control, a glass subtitle caption, and a top-left chip
"Playing · chapter 3". Control deck: seek bar with buffered segment, 4 chapter ticks, a
frame-preview popover ("02:41") above the thumb; row of pause · "02:41 / 04:36" mono ·
CC(on) · 1.5× · PiP · rotate · expand. Below: a "Chapters" `.m-card` listing 4 chapters
with mini thumbs (02:10 "The file viewer" active). Pin a small PiP mini-player to the
bottom-right corner of the screen.

### m14-audio `#m-audio` — Waveform & transcript
Viewer bar (Standup-2026-08-04.mp3 · MP3/WAV) + secure line. Waveform card: ~46 bars
(played portion in `--grad-acc`), playhead with a "04:12" bubble, 3 bookmark pins with
short labels ("Ship Friday", "QA env", "Maya designs"), a ruler 00:00 … 12:04. Controls:
back-15 · big play · fwd-30 · "04:12 / 12:04" · 1.5× · i-bookmark. Then "Live transcript"
`.m-card`: 4 speaker rows with tiny avatars and timestamps, the current line highlighted
with the spoken words bold. Footer row: search transcript + "Export".

### m15-archive `#m-archive` — Browse without extracting
Viewer bar (Design-Assets.zip · ZIP/RAR/7Z) + secure line. Breadcrumb row
"Design-Assets.zip / 02-Screens" + stats "247 files · 86 MB · 62% compressed". A 2-column
grid of file cards (gradient PNG previews with names and sizes). Above it a folder strip
as `.m-chips`: 01-Brand · 02-Screens(on) · 03-Motion · fonts · README.md. Bottom
`.m-card` preview of the selected "chat-dark.png": mini preview, "1.2 MB → 3.8 MB",
chip "CRC ok" (i-check), and two buttons "Preview" / "Extract file". `.m-tip`
"Nothing is written to your phone".

### m16-code `#m-code` — Code, data & logs
Viewer bar (PaymentService.ts) + secure line. File tabs as `.m-chips`:
PaymentService.ts(on) · config.json · metrics.csv · deploy.log. Editor block: line
numbers + ~14 lines of syntax-highlighted TypeScript (keywords accent, strings green,
comments muted) with one highlighted current line. Below, a "deploy.log" `.m-card` with
4 log rows carrying INFO/WARN/ERROR level pills (error row gets a red left stripe) and a
"Tail — live" footer. Status strip: TypeScript · UTF-8 · 342 lines · chip "Read-only
vault copy".

### m17-shelf `#m-shelf` — Bookshelf
`.m-largehead` "Bookshelf" + sub "126 files · every format your team has shared" ·
`.m-search` "Filter this shelf" · `.m-chips` Recent(on) · Pinned · Favorites · Shared ·
Downloads · a "Collections" `.m-label` row with 3 mini collection chips (Atlas Launch 12,
Legal 5, Brand 23) · a 2-column grid of 6 file cards (cover = `.ft-*` tile or gradient
book cover with big extension label, name, meta; PDF card carries a 62% reading-progress
bar; one card shows a star, one a pin) · footer strip "38.2 GB · encrypted at rest" ·
`.m-tabbar` (Shelf on) · `.m-home`.

### m18-reader-detect `#m-detect` — Long message lands
Design Guild chat; the last incoming message from Marcus Webb is a very long bubble
(7–8 lines then a soft fade-out mask) carrying a chip "Long read · ~1,400 words". The
chat is dimmed by `.m-dim` and a `.m-sheet` is open: icon tile (i-book) + title "This
message is easier as a page" + body "VaultChat converts long messages into a clean
reading view when they're too large for comfortable chat. You can switch back any time."
+ a meta row "~1,400 words · 6 min read · 3 pages" + `.m-btn.primary.block` "Open in
Reader" + `.m-btn.ghost.block` "View as chat" + a checkbox row "Always open long
messages in Reader".

### m19-reader `#m-reader` — The message as a page
Reader chrome: back chevron, source line "Design Guild · Marcus Webb", and a `.m-seg`
[Chat · Reader(on)] — the switch-any-time requirement — plus i-type and i-more-v. A
SEPIA page (#F6F1E7, dark ink ~#3A3226) filling the width: kicker "DESIGN GUILD · LONG
MESSAGE", serif title "The Atlas Rollout Plan" (26px), byline row (Marcus avatar ·
6 min read · 3 pages · 1,412 words), a drop-cap intro paragraph, an H2, a bulleted list,
a small 3-row table (Phase / Date / Owner), and one amber-highlighted sentence. Right
edge: a thin vertical reading-progress rail (42%) and a floating "Page 1 of 3" chip.
Bottom `.m-toolbar`: Highlight(i-marker) · Copy · Share · Print · Export PDF.

### m20-reader-settings `#m-rsettings` — Themes & typography
The m19 reader rendered in DARK theme (dark paper, light serif ink), dimmed, with a
`.m-sheet` open (sharp): `.m-label` THEME + 4 swatch cards in a row — Dark(active ring) ·
Light · Sepia · AMOLED (true black, "OLED" tag) — each showing a mini "Aa" in its own
scheme; FONT `.m-seg` Serif(on, set in serif) · Sans · Monospace (each label in its own
face); TEXT SIZE slider with A⁻/A⁺ and a "18px" chip; LINE SPACING slider "1.6";
MARGINS `.m-seg` Narrow · Comfortable(on) · Wide; LAYOUT `.m-seg` Scroll(on) · Pages;
footer row "Reset" ghost + "Done" primary.

### m21-search `#m-search` — Search everywhere
`.m-largehead` "Search" · a focused `.m-search` containing the query "atlas pricing" with
a caret · scrollable `.m-chips` scopes All(on) · Chats · Docs · Sheets · Slides · PDF ·
Images · Video · Audio · Files · then result group `.m-card`s, each with a header
(icon + type + count) and rows where the matched word "pricing" is highlighted in accent:
Chats (Maya + Atlas Launch), Word (Atlas-Proposal.docx · "Page 12 · Section 4.2 —
Pricing strategy"), Excel (cell "Revenue!D14"), PDF (chip "OCR match"), Video
(transcript hit at 02:41 with a mini thumb), Audio (transcript hit at 04:12). Footer
line "9 sources · 0.14 s · encrypted index, on-device". `.m-tabbar` (Search on).

### m22-offline `#m-offline` — Offline vault
`.m-largehead` "Offline" + amber status chip "You're offline — changes sync when you're
back" · a row of 3 compact KPI `.m-card`s (Downloaded 1.2 GB / Sync pending 3 / Synced
everything else) · `.m-chips` All(on) · Pending · Cloud-only · a list of 6 `.m-row`s
(file tile with a green corner tick where offline, name, where, size, and a state chip:
ok "Available offline" / warn "Sync pending" / ghost "Cloud only") · a "Sync queue"
`.m-card` with one 64% progress row and two done rows · a note "Conflict-free: edits
merge when you reconnect" · `.m-tabbar` (Offline on).

### m23-security `#m-security` — Vault controls
`.m-largehead` "Security" + sub "What protects this workspace, and what you control per
file" + chip ok "All 6 protections active" · six `.m-card` rows, each an icon tile +
title + one-line body + control: End-to-end encryption (chip "Always on · AES-256 +
X25519") · Secure file viewer (chip "Sandboxed · no external apps") · View-only sharing
(`.toggle.on`) · Expiring files (warn chip "Expires in 23:12:04") · Download disabled
(`.toggle.on`, i-download crossed) · Watermark (`.toggle.on`, mini page preview with
diagonal ghost text "SRIHARI · 05 AUG 2026") · footer audit strip "Last key rotation
12 days ago · Device verified · SOC 2 Type II" · `.m-tabbar` (Vault on).
