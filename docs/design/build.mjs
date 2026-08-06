#!/usr/bin/env node
/* Build: fragments/*.html  ->  screens/*.html (standalone 1920x1080)
 *                          ->  vaultchat-storyboard-4k.html (one 4K infographic)
 *                          ->  artifact-storyboard.html (body-only variant)
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = dirname(fileURLToPath(import.meta.url));
const tokens = readFileSync(join(ROOT, "tokens.css"), "utf8");
const sprite = readFileSync(join(ROOT, "sprite.svg"), "utf8");

/* ---------------- Manifest ---------------- */
const SECTIONS = [
  {
    id: "A", kicker: "Section A", title: "Chat, split in two",
    desc: "The core conversation surface — and how one window holds two of them. Long-press any conversation to open it beside (or below) the one you're in, resize with a glass divider, swap panes, and close back to a single chat.",
    screens: [
      { slug: "home",          file: "01-home.html",          step: "A1", title: "Open VaultChat",              caption: "The encrypted workspace opens to your conversations. Messages and files are sealed on-device — the welcome card says exactly that." },
      { slug: "chat",          file: "02-chat.html",          step: "A2", title: "Open the first chat",         caption: "A full conversation: header with presence and E2E badge, message history, attachments, and a composer with voice, emoji and attach." },
      { slug: "context",       file: "03-context-menu.html",  step: "A3", title: "Long-press another chat",     caption: "Press-and-hold (or right-click) any conversation. The context menu offers Split View — vertically or horizontally." },
      { slug: "split-v",       file: "04-split-vertical.html",step: "A4", title: "Two chats, side by side",     caption: "Each pane keeps its own header, history, search and composer. A grip divider with a swap control sits between them." },
      { slug: "split-resize",  file: "05-split-resize.html",  step: "A5", title: "Drag the divider",            caption: "Free resize with snap points at 30/70, 50/50 and 70/30. The live ratio follows the cursor." },
      { slug: "split-h",       file: "06-split-horizontal.html", step: "A6", title: "Stack, swap, or close",    caption: "The same split, stacked horizontally. Swap panes in place; closing the split returns to a single full-width chat." },
    ],
  },
  {
    id: "B", kicker: "Section B", title: "The Universal File Viewer",
    desc: "Word, Excel, PowerPoint, PDF, text, Markdown, CSV, JSON, XML, HTML, images (JPG · PNG · GIF · SVG · WEBP), video (MP4 · MOV · MKV), audio (MP3 · WAV), archives (ZIP · RAR · 7Z), code and logs — every file a chat can carry renders natively inside VaultChat. No external application ever opens. Nothing requires a download.",
    screens: [
      { slug: "files",   file: "07-files-in-chat.html", step: "B1", title: "A file arrives",            caption: "Every format shared into a chat opens in place. The side panel indexes all supported types — documents, data, media, code, archives." },
      { slug: "word",    file: "08-word.html",          step: "B2", title: "Word — book mode",          caption: "Two-page book reading with single-page and continuous-scroll modes, contents, bookmarks, comments, tables, hyperlinks, headers, footers, search, zoom, themes, and reading progress." },
      { slug: "excel",   file: "09-excel.html",         step: "B3", title: "Excel — native grid",       caption: "Sheets, formula inspection, freeze panes, filters, sorting, conditional formatting, cell comments, pivot tables, charts, and hidden-sheet awareness." },
      { slug: "ppt",     file: "10-powerpoint.html",    step: "B4", title: "PowerPoint — presenter",    caption: "Presenter mode with next-slide preview, speaker notes and timer; slide sorter, thumbnails, animations, embedded video, fullscreen and zoom." },
      { slug: "pdf",     file: "11-pdf.html",           step: "B5", title: "PDF — annotate & sign",     caption: "Highlight, draw, comment, fill forms, sign digitally, bookmark, and search — including OCR text found inside scanned pages." },
      { slug: "image",   file: "12-image.html",         step: "B6", title: "Images — compare & inspect",caption: "Zoom, rotate, slideshow and fullscreen, plus a draggable before/after compare and full EXIF metadata. JPG, PNG, GIF, SVG and WEBP." },
      { slug: "video",   file: "13-video.html",         step: "B7", title: "Video player",              caption: "Chapters, subtitles, playback speed, frame-preview scrubbing, picture-in-picture and landscape fullscreen. MP4, MOV, MKV." },
      { slug: "audio",   file: "14-audio.html",         step: "B8", title: "Audio — waveform",          caption: "A real waveform with bookmarks pinned to moments, playback speed, and a live speaker-labelled transcript. MP3, WAV." },
      { slug: "archive", file: "15-archive.html",       step: "B9", title: "Archives — browse inside",  caption: "ZIP, RAR and 7Z open as a browsable tree with previews — inspect and pull single files without extracting anything." },
      { slug: "code",    file: "16-code-data.html",     step: "B10", title: "Code, data & logs",        caption: "Syntax-highlighted code, JSON trees, XML, Markdown, CSV and live-tail logs with severity — read-only copies straight from the vault." },
      { slug: "shelf",   file: "17-bookshelf.html",     step: "B11", title: "The Bookshelf",            caption: "Everything ever shared, in one place: Recent, Pinned, Favorites, Shared with me, Downloads, Collections and Folders." },
    ],
  },
  {
    id: "C", kicker: "Section C", title: "Reading Mode",
    desc: "When a message is too large to read comfortably as a bubble, VaultChat offers it as a page instead. Readers get typography, structure and focus — and can flip back to chat view at any time.",
    screens: [
      { slug: "reader-detect",   file: "18-reader-detect.html",   step: "C1", title: "A long message lands",   caption: "VaultChat detects content too large for comfortable chat viewing and offers Reader — or keep it as chat. Your choice is remembered." },
      { slug: "reader",          file: "19-reader.html",          step: "C2", title: "The message as a page",  caption: "Cover title, reading time and page count, then real typography: headings, lists, tables, images, code, links, highlights — with contents, search, progress, copy, share, print and Export PDF. Switch Chat ⇄ Reader any time." },
      { slug: "reader-settings", file: "20-reader-settings.html", step: "C3", title: "Make it yours",          caption: "Dark, Light, Sepia and AMOLED themes; Serif, Sans and Monospace faces; text size, line spacing, margins; continuous scroll or book pages." },
    ],
  },
  {
    id: "D", kicker: "Section D", title: "Everywhere features",
    desc: "Three surfaces that hold the whole product together: one search across every chat and every file format, a first-class offline vault, and the security controls wrapped around each shared file.",
    screens: [
      { slug: "search",   file: "21-search.html",   step: "D1", title: "Search everywhere",  caption: "One query sweeps chats, Word, Excel, slides, PDFs (incl. OCR), images, video and audio transcripts, and raw files — on an encrypted, on-device index." },
      { slug: "offline",  file: "22-offline.html",  step: "D2", title: "The offline vault",  caption: "Downloaded, sync-pending and cloud-only states per file; a visible sync queue; edits merge conflict-free on reconnect." },
      { slug: "security", file: "23-security.html", step: "D3", title: "Vault controls",     caption: "End-to-end encryption, a sandboxed viewer, view-only sharing, expiring files, disabled downloads, and per-viewer watermarks." },
    ],
  },
];

/* ---------------- Fragment parsing ---------------- */
function parseFragment(file) {
  const p = join(ROOT, "fragments", file);
  if (!existsSync(p)) return null;
  const src = readFileSync(p, "utf8");
  const styleM = src.match(/<style>([\s\S]*?)<\/style>/);
  const bodyM = src.match(/<div class="screen"[\s\S]*<\/div>\s*$/);
  if (!styleM || !bodyM) throw new Error(`Fragment ${file}: missing <style> or root .screen div`);
  return { css: styleM[1].trim(), html: bodyM[0].trim() };
}

/* ---------------- Standalone screens ---------------- */
const screenShell = (s, frag) => `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>VaultChat · ${s.step} — ${s.title}</title>
<style>${tokens}</style>
<style>${frag.css}</style>
<style>
  html, body { margin: 0; background: #050409; }
  body { min-height: 100vh; display: flex; flex-direction: column; align-items: center; gap: 14px; padding: 20px 0 28px; }
  .vcx-fit { flex: none; overflow: hidden; border-radius: 18px; box-shadow: 0 30px 90px rgba(0,0,0,.6), 0 0 0 1px rgba(235,232,255,.08); }
  .vcx-stage { width: 1920px; height: 1080px; transform-origin: top left; }
  .vcx-meta { font: 500 12px/1 "Segoe UI", system-ui, sans-serif; color: #6B6684; letter-spacing: .3px; }
  .vcx-meta b { color: #A29DC0; font-weight: 600; }
</style>
</head>
<body>
${sprite}
<div class="vcx-fit"><div class="vcx-stage">${frag.html}</div></div>
<div class="vcx-meta"><b>VaultChat</b> · ${s.step} — ${s.title} · 1920 × 1080 · dark / glass / #7C4DFF</div>
<script>
  const fit = () => {
    const k = Math.min(1, (innerWidth - 48) / 1920);
    document.querySelector(".vcx-stage").style.transform = "scale(" + k + ")";
    const w = document.querySelector(".vcx-fit");
    w.style.width = 1920 * k + "px"; w.style.height = 1080 * k + "px";
  };
  addEventListener("resize", fit); fit();
</script>
</body>
</html>`;

/* ---------------- Infographic ---------------- */
const FRAME_W = 806, FRAME_H = 454, SCALE = 0.42; // 1920*0.42=806.4 -> round box

const infographicCss = `
  .ig-root { background: #050409; font-family: var(--font-ui); color: var(--txt-1); -webkit-font-smoothing: antialiased; }
  .ig-viewport { width: 100%; overflow-x: auto; }
  .ig-canvas {
    width: 3840px; margin: 0 auto; padding: 120px 160px 140px;
    transform-origin: top left; position: relative;
    background:
      radial-gradient(1600px 900px at 75% -5%, rgba(124,77,255,.13), transparent 60%),
      radial-gradient(1400px 900px at 8% 30%, rgba(124,77,255,.06), transparent 55%),
      radial-gradient(1400px 900px at 92% 78%, rgba(124,77,255,.07), transparent 55%),
      #050409;
  }
  .ig-head { display: flex; align-items: flex-start; gap: 60px; margin-bottom: 40px; }
  .ig-mark { width: 92px; height: 92px; border-radius: 26px; background: var(--grad-acc); box-shadow: 0 10px 50px rgba(124,77,255,.55), var(--inner-hi); display: flex; align-items: center; justify-content: center; color: #fff; }
  .ig-mark .ic { width: 48px; height: 48px; }
  .ig-head h1 { font-size: 64px; font-weight: 750; letter-spacing: -1.5px; line-height: 1.05; background: var(--grad-text); -webkit-background-clip: text; background-clip: text; color: transparent; text-wrap: balance; }
  .ig-head .sub { margin-top: 16px; font-size: 19px; color: var(--txt-2); max-width: 980px; line-height: 1.55; }
  .ig-head .meta { margin-top: 22px; display: flex; gap: 10px; flex-wrap: wrap; }
  .ig-legend { margin-left: auto; flex: none; width: 900px; display: grid; grid-template-columns: 1fr 1fr; gap: 14px; }
  .ig-lgcard { padding: 18px 20px; }
  .ig-lgcard h3 { font-size: 11px; font-weight: 700; letter-spacing: 1.4px; text-transform: uppercase; color: var(--txt-3); margin-bottom: 12px; }
  .ig-swatches { display: flex; gap: 8px; }
  .ig-sw { flex: 1; }
  .ig-sw i { display: block; height: 40px; border-radius: 9px; border: 1px solid var(--stroke-2); }
  .ig-sw b { display: block; font: 600 10px/1 var(--font-mono); color: var(--txt-2); margin-top: 7px; }
  .ig-sw span { display: block; font-size: 9.5px; color: var(--txt-3); margin-top: 3px; }
  .ig-typerow { display: flex; align-items: baseline; gap: 18px; }
  .ig-georow { display: flex; gap: 10px; align-items: center; }

  .ig-section { margin-top: 96px; }
  .ig-sechead { display: flex; align-items: flex-end; gap: 28px; margin-bottom: 44px; }
  .ig-seckicker { font-size: 13px; font-weight: 800; letter-spacing: 3px; text-transform: uppercase; color: var(--acc-2); }
  .ig-sechead h2 { font-size: 42px; font-weight: 720; letter-spacing: -1px; margin-top: 6px; }
  .ig-sechead .desc { font-size: 15.5px; color: var(--txt-2); max-width: 1240px; line-height: 1.6; margin-left: auto; padding-bottom: 6px; }
  .ig-secrule { height: 1px; background: linear-gradient(90deg, var(--stroke-acc), transparent 70%); margin: 18px 0 0; }

  .ig-row { display: flex; align-items: flex-start; }
  .ig-row + .ig-rowgap { position: relative; height: 96px; }
  .ig-frame { width: ${FRAME_W}px; flex: none; }
  .ig-frametop { display: flex; align-items: center; gap: 12px; margin-bottom: 12px; }
  .ig-steppill { display: inline-flex; align-items: center; justify-content: center; min-width: 52px; height: 30px; padding: 0 13px; border-radius: 999px; background: var(--grad-acc); color: #fff; font-size: 13px; font-weight: 800; letter-spacing: .5px; box-shadow: 0 4px 18px rgba(124,77,255,.45); }
  .ig-frametitle { font-size: 17px; font-weight: 650; letter-spacing: -.2px; }
  .ig-shot { width: ${FRAME_W}px; height: ${FRAME_H}px; border-radius: 16px; overflow: hidden; border: 1px solid var(--stroke-2); box-shadow: 0 24px 70px rgba(0,0,0,.55), 0 0 0 1px rgba(124,77,255,.07); position: relative; background: #0B0A13; }
  .ig-shotin { width: 1920px; height: 1080px; transform: scale(${SCALE}); transform-origin: top left; }
  .ig-framecap { margin-top: 12px; font-size: 12.5px; line-height: 1.55; color: var(--txt-2); padding-right: 8px; }
  .ig-frame.missing .ig-shot { display: flex; align-items: center; justify-content: center; color: var(--txt-3); font-size: 14px; }

  .ig-arr { flex: none; width: 86px; height: ${FRAME_H}px; margin-top: 42px; display: flex; align-items: center; justify-content: center; }
  .ig-rowlink { position: absolute; inset: 0; overflow: visible; }

  .ig-flow { margin-top: 110px; }
  .ig-flowcanvas { position: relative; height: 700px; margin-top: 40px; }
  .fl-node { position: absolute; display: flex; align-items: center; gap: 12px; padding: 16px 22px; border-radius: 16px; background: var(--glass-2); border: 1px solid var(--stroke-2); backdrop-filter: var(--blur); box-shadow: var(--sh-2), var(--inner-hi); font-size: 15px; font-weight: 600; white-space: nowrap; }
  .fl-node .ic { color: var(--acc-2); }
  .fl-node small { display: block; font-size: 11px; font-weight: 500; color: var(--txt-3); margin-top: 2px; }
  .fl-node.hub { background: var(--acc-soft-2); border-color: var(--stroke-acc); box-shadow: var(--glow); }
  .fl-node.dim { opacity: .92; font-size: 13.5px; padding: 12px 18px; }
  .fl-svg { position: absolute; inset: 0; overflow: visible; }
  .fl-label { position: absolute; font-size: 11px; font-weight: 700; letter-spacing: 1.6px; text-transform: uppercase; color: var(--txt-3); }

  .ig-foot { margin-top: 120px; display: flex; align-items: center; gap: 24px; border-top: 1px solid var(--stroke); padding-top: 36px; color: var(--txt-3); font-size: 13px; }
  .ig-foot .chips { display: flex; gap: 10px; margin-left: auto; }
  .ig-fitbar { position: sticky; top: 0; z-index: 90; display: flex; justify-content: center; padding: 10px 0; }
`;

/* No randomness here: the build must be reproducible, so the same source always
   produces a byte-identical storyboard. (This gradient was unused anyway.) */
const arrowSvg = `
<svg width="86" height="60" viewBox="0 0 86 60" fill="none">
  <path d="M4 30h64" stroke="#8f68ff" stroke-opacity=".85" stroke-width="2.5" stroke-linecap="round"/>
  <path d="M60 18l16 12-16 12" fill="none" stroke="#9E7BFF" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"/>
  <circle cx="6" cy="30" r="3.4" fill="#7C4DFF"/>
</svg>`;

function rowLink(fromX, toX, h) {
  // S-curve from bottom-center of last frame in row to top-center of first frame in next row
  return `<svg class="ig-rowlink" width="3520" height="${h}" viewBox="0 0 3520 ${h}" fill="none">
    <path d="M${fromX} 6 C ${fromX} ${h * 0.62}, ${toX} ${h * 0.3}, ${toX} ${h - 12}"
      stroke="#8f68ff" stroke-opacity=".7" stroke-width="2.5" stroke-linecap="round" stroke-dasharray="1 9"/>
    <path d="M${toX - 9} ${h - 24}l9 14 9-14" fill="none" stroke="#9E7BFF" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"/>
    <circle cx="${fromX}" cy="7" r="3.4" fill="#7C4DFF"/>
  </svg>`;
}

function chunk(arr, n) { const out = []; for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n)); return out; }

function buildFrames(section, frags) {
  const rows = chunk(section.screens, 4);
  let html = "";
  rows.forEach((row, ri) => {
    html += `<div class="ig-row">`;
    row.forEach((s, i) => {
      const frag = frags.get(s.slug);
      const shot = frag
        ? `<div class="ig-shot"><div class="ig-shotin">${frag.html}</div></div>`
        : `<div class="ig-shot">screen pending — ${s.file}</div>`;
      html += `<div class="ig-frame${frag ? "" : " missing"}">
        <div class="ig-frametop"><span class="ig-steppill">${s.step}</span><span class="ig-frametitle">${s.title}</span></div>
        ${shot}
        <div class="ig-framecap">${s.caption}</div>
      </div>`;
      if (i < row.length - 1) html += `<div class="ig-arr">${arrowSvg}</div>`;
    });
    html += `</div>`;
    if (ri < rows.length - 1) {
      const lastIdx = row.length - 1;
      const fromX = lastIdx * (FRAME_W + 86) + FRAME_W / 2;
      const toX = FRAME_W / 2;
      html += `<div class="ig-rowgap">${rowLink(fromX, toX, 96)}</div>`;
    }
  });
  return html;
}

/* ---- Flow map ---- */
function flowMap() {
  const nodes = [
    { id: "home",   x: 60,   y: 300, t: "Open VaultChat", s: "A1", ic: "shield", cls: "" },
    { id: "chat",   x: 420,  y: 300, t: "Chat", s: "A2 · the center of everything", ic: "chat", cls: "hub" },
    { id: "split",  x: 860,  y: 60,  t: "Split View", s: "A3–A6 · vertical · horizontal · resize · swap", ic: "split-v", cls: "" },
    { id: "viewer", x: 860,  y: 300, t: "Universal File Viewer", s: "B1–B10 · every format, in place", ic: "file", cls: "hub" },
    { id: "reader", x: 860,  y: 540, t: "Reading Mode", s: "C1–C3 · long messages become pages", ic: "book", cls: "" },
    { id: "word",   x: 1560, y: 40,  t: "Word", s: "B2", ic: "doc-lines", cls: "dim" },
    { id: "excel",  x: 1560, y: 130, t: "Excel", s: "B3", ic: "grid", cls: "dim" },
    { id: "ppt",    x: 1560, y: 220, t: "PowerPoint", s: "B4", ic: "presenter", cls: "dim" },
    { id: "pdf",    x: 1560, y: 310, t: "PDF", s: "B5", ic: "sign", cls: "dim" },
    { id: "image",  x: 1560, y: 400, t: "Images", s: "B6", ic: "image", cls: "dim" },
    { id: "video",  x: 1800, y: 85,  t: "Video", s: "B7", ic: "film", cls: "dim" },
    { id: "audio",  x: 1800, y: 175, t: "Audio", s: "B8", ic: "wave", cls: "dim" },
    { id: "zip",    x: 1800, y: 265, t: "Archives", s: "B9", ic: "zip", cls: "dim" },
    { id: "code",   x: 1800, y: 355, t: "Code & logs", s: "B10", ic: "code", cls: "dim" },
    { id: "shelf",  x: 2420, y: 220, t: "Bookshelf", s: "B11 · everything, organized", ic: "book", cls: "" },
    { id: "search", x: 2420, y: 480, t: "Search everywhere", s: "D1", ic: "search", cls: "" },
    { id: "off",    x: 2830, y: 480, t: "Offline vault", s: "D2", ic: "cloud-off", cls: "" },
    { id: "sec",    x: 3200, y: 480, t: "Security", s: "D3", ic: "lock", cls: "" },
  ];
  const edges = [
    ["home", "chat"], ["chat", "split"], ["chat", "viewer"], ["chat", "reader"],
    ["viewer", "word"], ["viewer", "excel"], ["viewer", "ppt"], ["viewer", "pdf"], ["viewer", "image"],
    ["viewer", "video"], ["viewer", "audio"], ["viewer", "zip"], ["viewer", "code"],
    ["word", "shelf"], ["video", "shelf"],
  ];
  const pos = Object.fromEntries(nodes.map(n => [n.id, n]));
  const NW = 200, NH = 30; // rough anchor offsets
  let svg = "";
  for (const [a, b] of edges) {
    const A = pos[a], B = pos[b];
    const x1 = A.x + (a === "viewer" || a === "chat" || a === "home" || a === "word" || a === "video" ? 260 : NW), y1 = A.y + NH;
    const x2 = B.x - 8, y2 = B.y + NH;
    const mx = (x1 + x2) / 2;
    svg += `<path d="M${x1} ${y1} C ${mx} ${y1}, ${mx} ${y2}, ${x2} ${y2}" stroke="#8f68ff" stroke-opacity=".45" stroke-width="2" fill="none"/>
            <path d="M${x2 - 12} ${y2 - 7}l12 7-12 7" stroke="#9E7BFF" stroke-opacity=".8" stroke-width="2" fill="none" stroke-linecap="round" stroke-linejoin="round"/>`;
  }
  // The three "wrap around everything" surfaces: a chain hanging off the Bookshelf.
  const chain = [
    { d: "M2520 282 L2520 462", head: "M2511 452l9 14 9-14" },      // shelf ↓ search
    { d: "M2660 510 L2812 510", head: "M2802 501l12 9-12 9" },      // search → offline
    { d: "M3030 510 L3182 510", head: "M3172 501l12 9-12 9" },      // offline → security
  ];
  for (const c of chain) {
    svg += `<path d="${c.d}" stroke="#8f68ff" stroke-opacity=".45" stroke-width="2" fill="none" stroke-dasharray="1 8" stroke-linecap="round"/>
            <path d="${c.head}" stroke="#9E7BFF" stroke-opacity=".8" stroke-width="2" fill="none" stroke-linecap="round" stroke-linejoin="round"/>`;
  }

  const nodesHtml = nodes.map(n => `
    <div class="fl-node ${n.cls}" style="left:${n.x}px; top:${n.y}px">
      <svg class="ic"><use href="#i-${n.ic}"/></svg>
      <div>${n.t}<small>${n.s}</small></div>
    </div>`).join("");
  return `
  <div class="ig-section ig-flow">
    <div class="ig-sechead"><div><div class="ig-seckicker">How it all connects</div><h2>One window, four surfaces</h2></div>
      <div class="desc">The navigation model in one picture: chat is the hub; splitting, viewing and reading are one gesture away; the bookshelf, search, offline vault and security wrap around everything.</div></div>
    <div class="ig-secrule"></div>
    <div class="ig-flowcanvas">
      <svg class="fl-svg">${svg}</svg>
      ${nodesHtml}
    </div>
  </div>`;
}

/* ---- Header legend ---- */
const legend = `
<div class="ig-legend">
  <div class="glass ig-lgcard">
    <h3>Palette</h3>
    <div class="ig-swatches">
      <div class="ig-sw"><i style="background:#08070D"></i><b>#08070D</b><span>ground</span></div>
      <div class="ig-sw"><i style="background:#12111C"></i><b>#12111C</b><span>surface</span></div>
      <div class="ig-sw"><i style="background:rgba(24,22,40,.55);backdrop-filter:blur(24px)"></i><b>glass 55%</b><span>blur 24</span></div>
      <div class="ig-sw"><i style="background:#7C4DFF"></i><b>#7C4DFF</b><span>accent</span></div>
      <div class="ig-sw"><i style="background:linear-gradient(135deg,#9257FF,#6C3DF4)"></i><b>gradient</b><span>primary</span></div>
      <div class="ig-sw"><i style="background:#EDEBFA"></i><b>#EDEBFA</b><span>text</span></div>
    </div>
  </div>
  <div class="glass ig-lgcard">
    <h3>Type &amp; geometry</h3>
    <div class="ig-typerow" style="margin-bottom:12px">
      <span style="font-size:26px;font-weight:700;letter-spacing:-.5px">Display 26</span>
      <span style="font-size:15px;font-weight:600">Title 15</span>
      <span style="font-size:13px;color:var(--txt-2)">Body 13</span>
      <span style="font-size:11px;color:var(--txt-3)">Caption 11</span>
      <span style="font-family:var(--font-mono);font-size:12px;color:var(--acc-2)">mono 12</span>
    </div>
    <div class="ig-georow">
      <span class="chip">radius 8–20</span><span class="chip">8pt spacing grid</span>
      <span class="chip">blur 24 · saturate 1.5</span><span class="chip">1px inner light</span>
      <span class="chip active">accent = state</span>
    </div>
  </div>
  <div class="glass ig-lgcard" style="grid-column:1/-1">
    <h3>Formats the viewer renders natively — never an external app</h3>
    <div class="ig-georow" style="flex-wrap:wrap;gap:7px">
      ${"DOC DOCX XLS XLSX PPT PPTX PDF TXT MD CSV JSON XML HTML JPG PNG GIF SVG WEBP MP4 MOV MKV MP3 WAV ZIP RAR 7Z CODE LOG".split(" ").map(f => `<span class="chip" style="height:23px;font-size:10.5px">${f}</span>`).join("")}
    </div>
  </div>
</div>`;

function buildInfographic(frags, bodyOnly) {
  const sections = SECTIONS.map(sec => `
    <div class="ig-section">
      <div class="ig-sechead">
        <div><div class="ig-seckicker">${sec.kicker}</div><h2>${sec.title}</h2></div>
        <div class="desc">${sec.desc}</div>
      </div>
      <div class="ig-secrule"></div>
      <div style="height:40px"></div>
      ${buildFrames(sec, frags)}
    </div>`).join("");

  const canvas = `
  <div class="ig-root">
  ${sprite}
  <div class="ig-fitbar"><span class="chip" id="fit-toggle" style="cursor:pointer;height:30px;font-size:12px">Fit width · click for 100%</span></div>
  <div class="ig-viewport"><div class="ig-canvas" id="ig-canvas">
    <div class="ig-head">
      <div class="ig-mark"><svg class="ic"><use href="#i-shield"/></svg></div>
      <div>
        <h1>VaultChat — a secure chat<br>that opens everything</h1>
        <div class="sub">Premium desktop concept: end-to-end encrypted messaging with split-screen conversations, a Universal File Viewer that renders every shared format natively — no external apps, no downloads — and a Reading Mode that turns long messages into pages. Dark, glass, and precise.</div>
        <div class="meta">
          <span class="chip active">23 screens · 4 sections</span><span class="chip">Desktop · 1920×1080 each</span>
          <span class="chip">Dark · Glassmorphism · #7C4DFF</span><span class="chip">For developers &amp; designers</span>
        </div>
      </div>
      ${legend}
    </div>
    ${sections}
    ${flowMap()}
    <div class="ig-foot">
      <span><b style="color:var(--txt-2)">VaultChat design package</b> · storyboard + 23 implementation screens · docs/design/screens/</span>
      <div class="chips"><span class="chip">No whiteboard</span><span class="chip">No canvas</span><span class="chip">No AI meeting</span><span class="chip">No analytics</span><span class="chip ok">Chat · Files · Reader only</span></div>
    </div>
  </div></div>
  </div>
  <script>
    (function () {
      const c = document.getElementById("ig-canvas"), t = document.getElementById("fit-toggle");
      let fit = true;
      function apply() {
        const vw = document.querySelector(".ig-viewport").clientWidth;
        const k = fit ? Math.min(1, vw / 3840) : 1;
        c.style.transform = "scale(" + k + ")";
        c.parentElement.style.height = c.scrollHeight * k + "px";
        t.textContent = fit ? "Fit width · click for 100%" : "100% · click to fit width";
      }
      t.addEventListener("click", () => { fit = !fit; apply(); });
      addEventListener("resize", apply); apply();
    })();
  </script>`;

  if (bodyOnly) {
    return `<style>${tokens}</style>\n<style>${infographicCss}</style>\n<style>html,body{background:#050409}</style>\n${canvas}`;
  }
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>VaultChat — Premium UI Storyboard</title>
<style>${tokens}</style>
<style>${infographicCss}</style>
<style>html,body{margin:0;background:#050409}</style>
</head>
<body>${canvas}</body>
</html>`;
}

/* ---------------- Run ---------------- */
/* Usage: node build.mjs            -> build all screens + infographic
 *        node build.mjs 08-word.html [..] -> build only those screens (no infographic) */
const only = process.argv.slice(2);
const frags = new Map();
let missing = 0;
for (const sec of SECTIONS) for (const s of sec.screens) {
  let frag;
  try { frag = parseFragment(s.file); }
  catch (e) { console.log(`  ! ${s.file}: ${e.message}`); continue; }
  if (!frag) { missing++; if (!only.length) console.log(`  · pending: ${s.file}`); continue; }
  frags.set(s.slug, frag);
  if (only.length && !only.includes(s.file)) continue;
  mkdirSync(join(ROOT, "screens"), { recursive: true });
  writeFileSync(join(ROOT, "screens", s.file), screenShell(s, frag));
  if (only.length) console.log(`  ✓ screens/${s.file}`);
}
if (!only.length) {
  writeFileSync(join(ROOT, "vaultchat-storyboard-4k.html"), buildInfographic(frags, false));
  writeFileSync(join(ROOT, "artifact-storyboard.html"), buildInfographic(frags, true));
  console.log(`Built ${frags.size} screens (${missing} pending) + infographic.`);
}
