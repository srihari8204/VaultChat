// lib/docOpen.selftest.ts — run: npx tsx lib/docOpen.selftest.ts
//
// Routing decides which screen a tap lands on. Get it wrong and the failure is
// silent and total: a PDF sent to /media-viewer shows a "Download & Open" card
// instead of its pages, and an archive sent to /file-viewer shows the hand-off.
// Both look like "opening documents is broken" to the person holding the phone.

import { extOf, viewerRouteFor } from './docOpen';

let failures = 0;
function eq(name: string, actual: unknown, expected: unknown) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failures++;
  console.log(`  ${ok ? '✓' : '✗'} ${name}${ok ? '' : `  (got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)})`}`);
}

console.log('\ndocOpen self-test\n');

// ── extension parsing ──────────────────────────────────────────────────
eq('plain name', extOf('report.pdf'), 'pdf');
eq('uppercase is normalised', extOf('REPORT.PDF'), 'pdf');
eq('dotted name takes the LAST extension', extOf('invoice.2026.01.pdf'), 'pdf');
eq('no extension is empty, not the whole name', extOf('statement'), '');
eq('a dot with a space after it is not an extension', extOf('v1.2 report'), '');
eq('trailing dot is not an extension', extOf('draft.'), '');
eq('unicode filename still finds the extension', extOf('వివరాలు.docx'), 'docx');
eq('empty name', extOf(''), '');

// ── routing by extension ───────────────────────────────────────────────
eq('pdf reads in-app', viewerRouteFor('a.pdf'), '/file-viewer');
eq('docx reads in-app', viewerRouteFor('a.docx'), '/file-viewer');
eq('xlsx reads in-app', viewerRouteFor('books.xlsx'), '/file-viewer');
eq('pptx reads in-app', viewerRouteFor('deck.pptx'), '/file-viewer');
eq('csv reads in-app', viewerRouteFor('ledger.csv'), '/file-viewer');
eq('txt reads in-app', viewerRouteFor('notes.txt'), '/file-viewer');
eq('zip browses', viewerRouteFor('bundle.zip'), '/archive-viewer');
eq('image plays in the media viewer', viewerRouteFor('photo.jpg'), '/media-viewer');
eq('video plays in the media viewer', viewerRouteFor('clip.mp4'), '/media-viewer');
eq('an unknown extension hands off rather than faking a preview',
   viewerRouteFor('firmware.bin'), 'handoff');

// ── the EXTENSION wins over a disagreeing mime ─────────────────────────
// The viewers dispatch on the extension, so routing on a mime that contradicts
// it delivers the file to a screen that cannot open it.
eq('extension beats a wrong mime', viewerRouteFor('report.pdf', 'application/octet-stream'), '/file-viewer');
eq('extension beats a mime claiming image', viewerRouteFor('report.docx', 'image/png'), '/file-viewer');

// ── mime is the fallback only when there is no extension ───────────────
eq('pdf by mime alone', viewerRouteFor('statement', 'application/pdf'), '/file-viewer');
eq('word by mime alone',
   viewerRouteFor('statement', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'),
   '/file-viewer');
eq('excel by mime alone', viewerRouteFor('sheet', 'application/vnd.ms-excel'), '/file-viewer');
eq('text by mime alone', viewerRouteFor('log', 'text/plain'), '/file-viewer');
eq('image by mime alone', viewerRouteFor('snap', 'image/heic'), '/media-viewer');
eq('zip by mime alone', viewerRouteFor('pack', 'application/zip'), '/archive-viewer');
eq('no extension and no mime hands off', viewerRouteFor('mystery'), 'handoff');
eq('no extension and an unknown mime hands off',
   viewerRouteFor('mystery', 'application/octet-stream'), 'handoff');

console.log(failures ? `\n  ${failures} FAILED\n` : '\n  all docOpen checks passed\n');
process.exit(failures ? 1 : 0);
