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
check('the Powered by KLIPY assets are present',
  existsSync('assets/klipy/powered-by-klipy-black.png')
  && existsSync('assets/klipy/powered-by-klipy-white.png'));

check('the logo is rendered in the picker',
  /powered-by-klipy-(black|white)\.png/.test(PICKER));

// Placement: it must sit in the search row, which is what keeps it on screen
// while the selector is open. At the foot of the sheet a long grid pushes it
// out of view, which is the arrangement the guideline rules out.
const searchRow = PICKER.slice(PICKER.indexOf('<View style={s.searchRow}>'), PICKER.indexOf('<View style={s.tabs}>'));
check('the logo sits in the search row, not at the foot of the sheet',
  /powered-by-klipy-/.test(searchRow),
  'it must stay visible for as long as the selector is open');

check('theme-aware — black on light, white on dark',
  /scheme === 'light'[\s\S]{0,120}powered-by-klipy-black[\s\S]{0,120}powered-by-klipy-white/.test(PICKER));

// ── 3. watermark on the sent card ─────────────────────────────────────
check('the watermark asset is present',
  existsSync('assets/klipy/watermark-klipy-light.png'));

check('the sent card renders the watermark',
  /watermark-klipy-light\.png/.test(BUBBLE));

check('...bottom-left, per the guideline',
  /klipyWatermark:[^}]*left:\s*\d+[^}]*bottom:\s*\d+/.test(STYLES),
  'the guideline specifies the bottom-left corner');

check('...and semi-transparent',
  /klipyWatermark:[^}]*opacity:\s*0?\.\d+/.test(STYLES));

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

console.log(failures ? `\n  ${failures} FAILED\n` : '\n  all KLIPY attribution checks passed\n');
process.exit(failures ? 1 : 0);
