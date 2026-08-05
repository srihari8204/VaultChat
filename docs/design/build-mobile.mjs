#!/usr/bin/env node
/* Mobile build: mobile/*.html -> screens-mobile/*.html (standalone 430x932)
 *                             -> vaultchat-storyboard-mobile-4k.html
 *                             -> artifact-storyboard-mobile.html (body-only)
 * Reuses tokens.css and sprite.svg unchanged; adds tokens-mobile.css.
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = dirname(fileURLToPath(import.meta.url));
const tokens = readFileSync(join(ROOT, "tokens.css"), "utf8");
const mtokens = readFileSync(join(ROOT, "tokens-mobile.css"), "utf8");
const sprite = readFileSync(join(ROOT, "sprite.svg"), "utf8");

const W = 430, H = 932;

const SECTIONS = [
  {
    kicker: "Section A", title: "Chat, split in two",
    desc: "The same conversation model on a phone. Long-press a chat to open it with the one you're already in — stacked, because a phone can't hold two readable columns. Drag the divider, swap the panes, close back to one.",
    screens: [
      { slug: "home",     file: "m01-home.html",       step: "M1", title: "Open VaultChat",         caption: "Chat list under a large title, filter chips, bottom tab bar, and a compose button. Same rail destinations as desktop — now tabs." },
      { slug: "chat",     file: "m02-chat.html",       step: "M2", title: "Open a chat",            caption: "Full-width conversation: presence and E2E badge in the app bar, bubbles, an attached file card, and a composer with attach, emoji and voice." },
      { slug: "press",    file: "m03-longpress.html",  step: "M3", title: "Long-press a chat",      caption: "Press and hold any conversation. A bottom sheet offers Open in Split View, with a stacked or side-by-side choice." },
      { slug: "split",    file: "m04-split.html",      step: "M4", title: "Two chats, stacked",     caption: "Each pane keeps its own header and composer. A grip divider sits between them with swap and close controls." },
      { slug: "resize",   file: "m05-split-resize.html", step: "M5", title: "Drag the divider",     caption: "Free resize with snap points at 30/70, 50/50 and 70/30. The live ratio follows your thumb." },
      { slug: "swap",     file: "m06-split-swap.html", step: "M6", title: "Swap or close",          caption: "Swap the panes in place, or close the split and return to a single full-height chat." },
    ],
  },
  {
    kicker: "Section B", title: "The Universal File Viewer",
    desc: "Every format a chat can carry opens inside VaultChat on the phone too — Word, Excel, PowerPoint, PDF, text, Markdown, CSV, JSON, XML, HTML, images (JPG · PNG · GIF · SVG · WEBP), video (MP4 · MOV · MKV), audio (MP3 · WAV), archives (ZIP · RAR · 7Z), code and logs. No external app. No download.",
    screens: [
      { slug: "files",   file: "m07-files.html",     step: "M7",  title: "A file arrives",        caption: "Files land as cards in the thread and open in place. The sheet lists every supported format by category." },
      { slug: "word",    file: "m08-word.html",      step: "M8",  title: "Word — reading",        caption: "Single-page reading tuned for the phone, with contents, bookmarks, comments, search, zoom, themes and reading progress." },
      { slug: "excel",   file: "m09-excel.html",     step: "M9",  title: "Excel — native grid",   caption: "Pinch-zoom grid with frozen header and first column, formula bar, sheet tabs, filters, conditional formatting and cell comments." },
      { slug: "ppt",     file: "m10-ppt.html",       step: "M10", title: "PowerPoint",            caption: "Slide view with thumbnails, speaker notes, animations and embedded video; rotate for fullscreen presenting." },
      { slug: "pdf",     file: "m11-pdf.html",       step: "M11", title: "PDF — annotate & sign", caption: "Highlight, draw, comment, fill forms and sign with a finger; page thumbnails, bookmarks and OCR search." },
      { slug: "image",   file: "m12-image.html",     step: "M12", title: "Images — compare",      caption: "Pinch to zoom, rotate, slideshow, a drag-to-compare handle, and full EXIF in a sheet." },
      { slug: "video",   file: "m13-video.html",     step: "M13", title: "Video player",          caption: "Chapters, subtitles, speed, frame-preview scrubbing, picture-in-picture and rotate-to-landscape." },
      { slug: "audio",   file: "m14-audio.html",     step: "M14", title: "Audio — waveform",      caption: "Waveform with bookmarks pinned to moments, playback speed, and a live speaker-labelled transcript." },
      { slug: "archive", file: "m15-archive.html",   step: "M15", title: "Archives",              caption: "ZIP, RAR and 7Z browse as a tree with previews — inspect and pull one file without extracting the rest." },
      { slug: "code",    file: "m16-code.html",      step: "M16", title: "Code, data & logs",     caption: "Syntax-highlighted code, JSON trees, CSV and live-tail logs with severity — read-only vault copies." },
      { slug: "shelf",   file: "m17-shelf.html",     step: "M17", title: "The Bookshelf",         caption: "Everything ever shared: Recent, Pinned, Favorites, Shared with me, Downloads, Collections and Folders." },
    ],
  },
  {
    kicker: "Section C", title: "Reading Mode",
    desc: "A phone is where a wall of text hurts most. When a message is too large to read comfortably in a bubble, VaultChat offers it as a page — and you can flip back to chat at any time.",
    screens: [
      { slug: "detect",   file: "m18-reader-detect.html",   step: "M18", title: "A long message lands", caption: "Detected automatically and offered as a sheet: open in Reader, or keep it as chat. Your choice is remembered." },
      { slug: "reader",   file: "m19-reader.html",          step: "M19", title: "The message as a page", caption: "Cover title, reading time and pages, then real typography — headings, lists, tables, code, links and highlights." },
      { slug: "settings", file: "m20-reader-settings.html", step: "M20", title: "Make it yours",        caption: "Dark, Light, Sepia and AMOLED; Serif, Sans and Monospace; text size, line spacing, margins, scroll or pages." },
    ],
  },
  {
    kicker: "Section D", title: "Everywhere features",
    desc: "The three surfaces that hold the product together, sized for one hand: one search across every chat and format, the offline vault, and the security controls wrapped around each shared file.",
    screens: [
      { slug: "search",   file: "m21-search.html",   step: "M21", title: "Search everywhere", caption: "One query sweeps chats, documents, sheets, slides, PDFs (incl. OCR), images, video and audio transcripts, and raw files." },
      { slug: "offline",  file: "m22-offline.html",  step: "M22", title: "The offline vault", caption: "Downloaded, sync-pending and cloud-only per file, a live sync queue, and conflict-free merges on reconnect." },
      { slug: "security", file: "m23-security.html", step: "M23", title: "Vault controls",    caption: "End-to-end encryption, a sandboxed viewer, view-only sharing, expiring files, blocked downloads and watermarks." },
    ],
  },
];

function parseFragment(file) {
  const p = join(ROOT, "mobile", file);
  if (!existsSync(p)) return null;
  const src = readFileSync(p, "utf8");
  const styleM = src.match(/<style>([\s\S]*?)<\/style>/);
  const bodyM = src.match(/<div class="mscreen"[\s\S]*<\/div>\s*$/);
  if (!styleM || !bodyM) throw new Error(`Fragment ${file}: missing <style> or root .mscreen div`);
  return { css: styleM[1].trim(), html: bodyM[0].trim() };
}

const screenShell = (s, frag) => `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>VaultChat Mobile · ${s.step} — ${s.title}</title>
<style>${tokens}</style>
<style>${mtokens}</style>
<style>${frag.css}</style>
<style>
  html, body { margin: 0; background: #050409; }
  body { min-height: 100vh; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 14px; padding: 24px 0; }
  .vcxm-device { border-radius: 44px; overflow: hidden; box-shadow: 0 30px 90px rgba(0,0,0,.65), 0 0 0 10px #17161f, 0 0 0 11px rgba(235,232,255,.12); }
  .vcxm-meta { font: 500 12px/1 "Segoe UI", system-ui, sans-serif; color: #6B6684; letter-spacing: .3px; }
  .vcxm-meta b { color: #A29DC0; font-weight: 600; }
</style>
</head>
<body>
${sprite}
<div class="vcxm-device">${frag.html}</div>
<div class="vcxm-meta"><b>VaultChat Mobile</b> · ${s.step} — ${s.title} · ${W} × ${H} · dark / glass / #7C4DFF</div>
</body>
</html>`;

/* ---------------- Infographic ---------------- */
const SCALE = 0.74;
const FW = Math.round(W * SCALE), FH = Math.round(H * SCALE);
const PER_ROW = 6;

const igCss = `
  .ig-root { background: #050409; font-family: var(--font-ui); color: var(--txt-1); -webkit-font-smoothing: antialiased; }
  .ig-viewport { width: 100%; overflow-x: auto; }
  .ig-canvas {
    width: 3200px; margin: 0 auto; padding: 110px 140px 130px;
    transform-origin: top left; position: relative;
    background:
      radial-gradient(1400px 800px at 78% -4%, rgba(124,77,255,.14), transparent 60%),
      radial-gradient(1200px 800px at 6% 34%, rgba(124,77,255,.06), transparent 55%),
      radial-gradient(1200px 800px at 94% 80%, rgba(124,77,255,.07), transparent 55%),
      #050409;
  }
  .ig-head { display: flex; align-items: flex-start; gap: 54px; margin-bottom: 34px; }
  .ig-mark { width: 84px; height: 84px; border-radius: 24px; background: var(--grad-acc); box-shadow: 0 10px 46px rgba(124,77,255,.55), var(--inner-hi); display: flex; align-items: center; justify-content: center; color: #fff; flex: none; }
  .ig-mark .ic { width: 44px; height: 44px; }
  .ig-head h1 { font-size: 56px; font-weight: 750; letter-spacing: -1.3px; line-height: 1.05; background: var(--grad-text); -webkit-background-clip: text; background-clip: text; color: transparent; text-wrap: balance; }
  .ig-head .sub { margin-top: 14px; font-size: 18px; color: var(--txt-2); max-width: 880px; line-height: 1.55; }
  .ig-head .meta { margin-top: 20px; display: flex; gap: 10px; flex-wrap: wrap; }
  .ig-legend { margin-left: auto; flex: none; width: 780px; display: grid; gap: 13px; }
  .ig-lgcard { padding: 17px 19px; }
  .ig-lgcard h3 { font-size: 11px; font-weight: 700; letter-spacing: 1.3px; text-transform: uppercase; color: var(--txt-3); margin-bottom: 11px; }
  .ig-swatches { display: flex; gap: 8px; }
  .ig-sw { flex: 1; }
  .ig-sw i { display: block; height: 36px; border-radius: 9px; border: 1px solid var(--stroke-2); }
  .ig-sw b { display: block; font: 600 10px/1 var(--font-mono); color: var(--txt-2); margin-top: 6px; }
  .ig-sw span { display: block; font-size: 9.5px; color: var(--txt-3); margin-top: 3px; }
  .ig-georow { display: flex; gap: 9px; align-items: center; flex-wrap: wrap; }

  .ig-section { margin-top: 84px; }
  .ig-sechead { display: flex; align-items: flex-end; gap: 26px; margin-bottom: 34px; }
  .ig-seckicker { font-size: 12.5px; font-weight: 800; letter-spacing: 3px; text-transform: uppercase; color: var(--acc-2); }
  .ig-sechead h2 { font-size: 38px; font-weight: 720; letter-spacing: -.9px; margin-top: 6px; }
  .ig-sechead .desc { font-size: 15px; color: var(--txt-2); max-width: 1150px; line-height: 1.6; margin-left: auto; padding-bottom: 5px; }
  .ig-secrule { height: 1px; background: linear-gradient(90deg, var(--stroke-acc), transparent 70%); margin-top: 16px; }

  .ig-row { display: flex; align-items: flex-start; }
  .ig-rowgap { position: relative; height: 84px; }
  .ig-frame { width: ${FW}px; flex: none; }
  .ig-frametop { display: flex; align-items: center; gap: 11px; margin-bottom: 11px; }
  .ig-steppill { display: inline-flex; align-items: center; justify-content: center; min-width: 50px; height: 29px; padding: 0 12px; border-radius: 999px; background: var(--grad-acc); color: #fff; font-size: 12.5px; font-weight: 800; letter-spacing: .4px; box-shadow: 0 4px 18px rgba(124,77,255,.45); }
  .ig-frametitle { font-size: 15.5px; font-weight: 650; letter-spacing: -.2px; }
  .ig-shot {
    width: ${FW}px; height: ${FH}px; border-radius: 32px; overflow: hidden;
    box-shadow: 0 22px 60px rgba(0,0,0,.6), 0 0 0 7px #17161f, 0 0 0 8px rgba(235,232,255,.10);
    position: relative; background: #0B0A13;
  }
  .ig-shotin { width: ${W}px; height: ${H}px; transform: scale(${SCALE}); transform-origin: top left; }
  .ig-framecap { margin-top: 12px; font-size: 12.5px; line-height: 1.55; color: var(--txt-2); padding-right: 6px; }
  .ig-frame.missing .ig-shot { display: flex; align-items: center; justify-content: center; color: var(--txt-3); font-size: 13px; }
  .ig-arr { flex: none; width: 74px; height: ${FH}px; margin-top: 40px; display: flex; align-items: center; justify-content: center; }

  .ig-foot { margin-top: 100px; display: flex; align-items: center; gap: 22px; border-top: 1px solid var(--stroke); padding-top: 32px; color: var(--txt-3); font-size: 13px; }
  .ig-foot .chips { display: flex; gap: 9px; margin-left: auto; }
  .ig-fitbar { position: sticky; top: 0; z-index: 90; display: flex; justify-content: center; padding: 10px 0; }
`;

const arrow = `
<svg width="74" height="56" viewBox="0 0 74 56" fill="none">
  <path d="M4 28h54" stroke="#8f68ff" stroke-opacity=".85" stroke-width="2.5" stroke-linecap="round"/>
  <path d="M50 17l14 11-14 11" fill="none" stroke="#9E7BFF" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"/>
  <circle cx="6" cy="28" r="3.4" fill="#7C4DFF"/>
</svg>`;

function rowLink(fromX, toX, h) {
  return `<svg class="ig-rowlink" style="position:absolute;inset:0;overflow:visible" width="2800" height="${h}" viewBox="0 0 2800 ${h}" fill="none">
    <path d="M${fromX} 6 C ${fromX} ${h * 0.6}, ${toX} ${h * 0.3}, ${toX} ${h - 12}"
      stroke="#8f68ff" stroke-opacity=".7" stroke-width="2.5" stroke-linecap="round" stroke-dasharray="1 9"/>
    <path d="M${toX - 9} ${h - 24}l9 14 9-14" fill="none" stroke="#9E7BFF" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"/>
    <circle cx="${fromX}" cy="7" r="3.4" fill="#7C4DFF"/>
  </svg>`;
}

const chunk = (a, n) => { const o = []; for (let i = 0; i < a.length; i += n) o.push(a.slice(i, i + n)); return o; };

function buildFrames(sec, frags) {
  const rows = chunk(sec.screens, PER_ROW);
  let html = "";
  rows.forEach((row, ri) => {
    html += `<div class="ig-row">`;
    row.forEach((s, i) => {
      const f = frags.get(s.slug);
      html += `<div class="ig-frame${f ? "" : " missing"}">
        <div class="ig-frametop"><span class="ig-steppill">${s.step}</span><span class="ig-frametitle">${s.title}</span></div>
        <div class="ig-shot">${f ? `<div class="ig-shotin">${f.html}</div>` : `pending — ${s.file}`}</div>
        <div class="ig-framecap">${s.caption}</div>
      </div>`;
      if (i < row.length - 1) html += `<div class="ig-arr">${arrow}</div>`;
    });
    html += `</div>`;
    if (ri < rows.length - 1) {
      const fromX = (row.length - 1) * (FW + 74) + FW / 2;
      html += `<div class="ig-rowgap">${rowLink(fromX, FW / 2, 84)}</div>`;
    }
  });
  return html;
}

const legend = `
<div class="ig-legend">
  <div class="m-card ig-lgcard">
    <h3>Same system as the desktop set</h3>
    <div class="ig-swatches">
      <div class="ig-sw"><i style="background:#08070D"></i><b>#08070D</b><span>ground</span></div>
      <div class="ig-sw"><i style="background:#12111C"></i><b>#12111C</b><span>surface</span></div>
      <div class="ig-sw"><i style="background:rgba(24,22,40,.55);backdrop-filter:blur(24px)"></i><b>glass 55%</b><span>blur 24</span></div>
      <div class="ig-sw"><i style="background:#7C4DFF"></i><b>#7C4DFF</b><span>accent</span></div>
      <div class="ig-sw"><i style="background:linear-gradient(135deg,#9257FF,#6C3DF4)"></i><b>gradient</b><span>primary</span></div>
      <div class="ig-sw"><i style="background:#EDEBFA"></i><b>#EDEBFA</b><span>text</span></div>
    </div>
  </div>
  <div class="m-card ig-lgcard">
    <h3>What changed for the phone — and what didn't</h3>
    <div class="ig-georow">
      <span class="chip ok">Identical icon set</span><span class="chip ok">Identical palette</span><span class="chip ok">Identical features</span>
      <span class="chip active">Rail → bottom tabs</span><span class="chip active">Menus → bottom sheets</span>
      <span class="chip active">Side-by-side → stacked split</span><span class="chip active">44 px touch targets</span>
      <span class="chip">430 × 932 · safe areas</span>
    </div>
  </div>
  <div class="m-card ig-lgcard">
    <h3>Formats the viewer renders natively — never an external app</h3>
    <div class="ig-georow">
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
      <div style="height:34px"></div>
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
        <h1>VaultChat on the phone —<br>the same product, one hand</h1>
        <div class="sub">The desktop concept rebuilt for mobile: end-to-end encrypted chat with a stacked split view, the Universal File Viewer rendering every shared format natively — no external apps, no downloads — and Reading Mode for long messages. Same palette, same icons, same features; only the layout is mobile.</div>
        <div class="meta">
          <span class="chip active">23 screens · 4 sections</span><span class="chip">Mobile · 430×932 each</span>
          <span class="chip">Dark · Glassmorphism · #7C4DFF</span><span class="chip">For developers &amp; designers</span>
        </div>
      </div>
      ${legend}
    </div>
    ${sections}
    <div class="ig-foot">
      <span><b style="color:var(--txt-2)">VaultChat mobile design package</b> · storyboard + 23 implementation screens · docs/design/screens-mobile/</span>
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
        const k = fit ? Math.min(1, vw / 3200) : 1;
        c.style.transform = "scale(" + k + ")";
        c.parentElement.style.height = c.scrollHeight * k + "px";
        t.textContent = fit ? "Fit width · click for 100%" : "100% · click to fit width";
      }
      t.addEventListener("click", () => { fit = !fit; apply(); });
      addEventListener("resize", apply); apply();
    })();
  </script>`;

  if (bodyOnly) return `<style>${tokens}</style>\n<style>${mtokens}</style>\n<style>${igCss}</style>\n<style>html,body{background:#050409}</style>\n${canvas}`;
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>VaultChat Mobile — Premium UI Storyboard</title>
<style>${tokens}</style>
<style>${mtokens}</style>
<style>${igCss}</style>
<style>html,body{margin:0;background:#050409}</style>
</head>
<body>${canvas}</body>
</html>`;
}

/* ---------------- Run ---------------- */
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
  mkdirSync(join(ROOT, "screens-mobile"), { recursive: true });
  writeFileSync(join(ROOT, "screens-mobile", s.file), screenShell(s, frag));
  if (only.length) console.log(`  ✓ screens-mobile/${s.file}`);
}
if (!only.length) {
  writeFileSync(join(ROOT, "vaultchat-storyboard-mobile-4k.html"), buildInfographic(frags, false));
  writeFileSync(join(ROOT, "artifact-storyboard-mobile.html"), buildInfographic(frags, true));
  console.log(`Built ${frags.size} mobile screens (${missing} pending) + infographic.`);
}
