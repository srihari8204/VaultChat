// constants/mediaChrome.selftest.ts — run: npx tsx constants/mediaChrome.selftest.ts
//
// The media screens draw fixed light chrome on a fixed dark stage in either app
// theme, so each text/icon colour must clear WCAG AA (4.5:1) on its surface.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { contrastOn } from '../components/chat/bubbleFillInk';
import {
  MEDIA_DANGER, MEDIA_INK, MEDIA_STAGE, PDF_MAT, PDF_PAPER, PDF_PILL_ALPHA, VIDEO_ACCENT, VIDEO_CTA,
} from './mediaChrome';

const hex = (n: number) => Math.round(n).toString(16).padStart(2, '0');
/** Black at `alpha` over a solid colour, as a hex colour. */
function darken(bg: string, alpha: number): string {
  const ch = [1, 3, 5].map(i => parseInt(bg.slice(i, i + 2), 16) * (1 - alpha));
  return '#' + ch.map(hex).join('');
}

const pairs: [string, string, string][] = [
  ['ink on the stage', MEDIA_INK, MEDIA_STAGE],
  ['error red on the stage', MEDIA_DANGER, MEDIA_STAGE],
  ['video accent on the stage', VIDEO_ACCENT, MEDIA_STAGE],
  ['white on the video CTA', MEDIA_INK, VIDEO_CTA],
  // A PDF pill floats over the mat or over a white page; white must read on both.
  ['pill text over the PDF mat', MEDIA_INK, darken(PDF_MAT, PDF_PILL_ALPHA)],
  ['pill text over a PDF page', MEDIA_INK, darken(PDF_PAPER, PDF_PILL_ALPHA)],
];
for (const [what, fg, bg] of pairs) {
  const r = contrastOn(fg, bg);
  assert.ok(r >= 4.5, `${what}: ${fg} on ${bg} is ${r.toFixed(2)}:1, under 4.5:1`);
  console.log(`  ${what}: ${r.toFixed(2)}:1`);
}

// The media screens must take these from here, not inline literals.
for (const f of ['app/video-player.tsx', 'app/media-viewer.tsx', 'app/story-viewer.tsx', 'components/PdfView.tsx']) {
  const src = readFileSync(join(__dirname, '..', f), 'utf8');
  assert.ok(/constants\/mediaChrome/.test(src), `${f} no longer reads constants/mediaChrome`);
  assert.ok(!/['"`]#[0-9a-fA-F]{3,8}['"`]/.test(src), `${f} has an inline hex colour again`);
}

console.log('mediaChrome: every media chrome ink clears 4.5:1');
