// lib/klipyAttribution.selftest.ts — run: npx tsx lib/klipyAttribution.selftest.ts
//
// KLIPY's brand attribution requirements, asserted.
//
// These are not styling preferences. Their guideline states plainly that
// "meeting these brand attribution requirements is a mandatory criterion for
// the final approval of your application's production request" — so a
// regression here does not break a screen, it blocks the production API key,
// and the failure would surface as a rejection weeks later with no stack trace
// pointing at the commit that caused it.
//
// From "klipy attribution guideline.pdf" (7 pages, artwork only — no text
// layer, which is how the first attempt at this shipped guesswork):
//
//   1. SEARCH BAR PLACEHOLDER (REQUIRED) — exactly "Search KLIPY", brand fully
//      capitalised.
//   2. LOGO IN PICKER/SELECTOR — "Powered by KLIPY", placed near the search bar
//      or preview area, visible the whole time the selector is open.
//   3. WATERMARK ON SENT CARD — semi-transparent white logo, bottom-left of the
//      message card.

import { readFileSync, existsSync } from 'node:fs';

const PICKER = readFileSync('components/GifPicker.tsx', 'utf8');
const BUBBLE = readFileSync('components/chat/MessageBubble.tsx', 'utf8');
const STYLES = readFileSync('components/chat/chatStyles.ts', 'utf8');
const CHAT   = readFileSync('app/chat.tsx', 'utf8');

let failures = 0;
const check = (name: string, ok: boolean, detail = '') => {
  if (!ok) failures++;
  console.log(`  ${ok ? '✓' : '✗'} ${name}${!ok && detail ? `  (${detail})` : ''}`);
};

console.log('\nKLIPY attribution compliance\n');

// ── 1. search placeholder (REQUIRED) ──────────────────────────────────
check('the search placeholder is exactly "Search KLIPY"',
  /const SEARCH_PLACEHOLDER = 'Search KLIPY'/.test(PICKER),
  'REQUIRED by the guideline, and brand must be fully capitalised');

check('...and it is what the input actually renders',
  /placeholder=\{SEARCH_PLACEHOLDER\}/.test(PICKER),
  'the constant is only compliance if the TextInput uses it');

check('no per-tab placeholder has crept back in',
  !/placeholder: 'Search (GIFs|stickers|emojis)/.test(PICKER),
  'a per-tab placeholder fails the requirement');

// ── 2. logo in the picker ─────────────────────────────────────────────
check('the logo is rendered in the picker',
  /<KlipyMark/.test(PICKER));

// Placement: it must sit in the search row, which is what keeps it on screen
// while the selector is open. At the foot of the sheet a long grid pushes it
// out of view, which is the arrangement the guideline rules out.
const searchRow = PICKER.slice(PICKER.indexOf('<View style={s.searchRow}>'), PICKER.indexOf('<View style={s.tabs}>'));
check('the logo sits in the search row, not at the foot of the sheet',
  /<KlipyMark/.test(searchRow),
  'it must stay visible for as long as the selector is open');

check('theme-aware — black on light, white on dark',
  /scheme === 'light' \? KlipyBlack : KlipyWhite/.test(PICKER));

// ── 3. watermark on the sent card ─────────────────────────────────────
check('the sent card renders the watermark',
  /<KlipyWatermark/.test(BUBBLE));

check('...bottom-left, per the guideline',
  /klipyWatermark:[^}]*left:\s*\d+[^}]*bottom:\s*\d+/.test(STYLES),
  'the guideline specifies the bottom-left corner');

// "Visible with minimal distraction" — the scrim must be see-through, not a
// solid black box sitting on someone's GIF.
check('...on a semi-transparent scrim, not an opaque box',
  /klipyWatermark:[\s\S]{0,500}?rgba\(0,0,0,0\.[0-5]\d?\)/.test(STYLES));

check('the overlay cannot swallow taps on the card',
  /pointerEvents="none"/.test(BUBBLE),
  'the card opens the viewer; an overlay that eats touches makes a dead corner');

// ── provenance: watermark KLIPY content, and ONLY KLIPY content ───────
check('sent picks are stamped with their source',
  /source: 'klipy'/.test(CHAT),
  'without provenance the bubble cannot tell KLIPY content from anything else');

check('the watermark is gated on that stamp',
  /msg\.meta\?\.source === 'klipy'/.test(BUBBLE),
  'gating on gifUrl alone would stamp pre-switch GIPHY messages with KLIPY\'s mark');

// ── 4. preview dialog before send (guideline "Version 2") ─────────────
check('tapping a tile opens a preview instead of sending outright',
  /onPress=\{\(\) => setPreview\(item\)\}/.test(PICKER),
  'a 100px tile is not enough to know what you are about to send');

check('the preview carries the Powered by KLIPY mark',
  /previewCard[\s\S]{0,900}<KlipyMark/.test(PICKER),
  'the preview area is the guideline\'s other sanctioned placement');

check('the preview can send, and can be dismissed without sending',
  /onSelect\(p\.url, p\.preview\)/.test(PICKER) && /setPreview\(null\)/.test(PICKER));

check('a stale preview cannot survive a tab change or a close',
  (PICKER.match(/setPreview\(null\)/g) ?? []).length >= 3,
  'otherwise reopening shows an item from the previous tab');

// ── the marks are VECTORS, sized from their own viewBox ───────────────
// A raster under resizeMode="contain" fits the tighter axis, so a style box
// whose ratio disagreed with the artwork silently shrank it — the sent-card
// watermark drew at ~40px on a 220px card, which is present, correct, and
// indistinguishable from "it never rendered". SVG removes that whole class of
// bug, but only if the declared height still follows the viewBox.
function svgRatio(path: string): number {
  const m = /viewBox="[\d.]+\s+[\d.]+\s+([\d.]+)\s+([\d.]+)"/.exec(readFileSync(path, 'utf8'));
  if (!m) throw new Error(`no viewBox in ${path}`);
  return Number(m[1]) / Number(m[2]);
}

for (const f of ['powered-by-klipy-black', 'powered-by-klipy-white', 'watermark-klipy-light']) {
  check(`${f}.svg is present`, existsSync(`assets/klipy/${f}.svg`));
}

check('the marks are imported as SVG components, not rasters',
  /from '\.\.\/assets\/klipy\/powered-by-klipy-black\.svg'/.test(PICKER)
  && /from '\.\.\/\.\.\/assets\/klipy\/watermark-klipy-light\.svg'/.test(BUBBLE));

check('no raster KLIPY asset is still referenced',
  !/klipy\/[a-z-]+\.png/.test(PICKER) && !/klipy\/[a-z-]+\.png/.test(BUBBLE),
  'a leftover require() would reintroduce the resizeMode scaling trap');

// The picker mark derives height from the viewBox ratio rather than a second
// hardcoded number, so the two can never drift apart.
const ratio = svgRatio('assets/klipy/powered-by-klipy-black.svg');
const declared = /width \/ ([\d.]+)/.exec(PICKER);
check(`the picker mark divides width by the viewBox ratio (${ratio.toFixed(2)})`,
  !!declared && Math.abs(Number(declared[1]) - ratio) < 0.1,
  `code says ${declared?.[1]}, asset says ${ratio.toFixed(2)}`);

// ── the reason it was invisible ───────────────────────────────────────
// shadowColor is a NO-OP on Android — it honours `elevation` only — so a white
// outlined wordmark on a pale GIF was drawn and unreadable. A scrim is the
// thing that actually works, and it leaves KLIPY's artwork untouched, which
// matters because the mark must not be recoloured.
check('the watermark sits on a scrim, not an Android-ignored shadow',
  /klipyWatermark:[\s\S]{0,500}?backgroundColor:\s*'rgba\(0,0,0/.test(STYLES),
  'shadowColor does nothing on Android; white-on-pale reads as no watermark');

check('...and no longer relies on shadowColor',
  !/klipyWatermark:[\s\S]{0,500}?shadowColor/.test(STYLES));

console.log(failures ? `\n  ${failures} FAILED\n` : '\n  all KLIPY attribution checks passed\n');
process.exit(failures ? 1 : 0);
