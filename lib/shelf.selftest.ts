// lib/shelf.selftest.ts — run: npx tsx lib/shelf.selftest.ts
//
// The shelf is how someone finds a file again weeks later, so the two ways it
// can fail the user are (a) putting a file in a bucket they won't look in and
// (b) losing it from the list entirely. Both are asserted here.

import { classify, countsByKind, formatSize, queryShelf, type ShelfFile } from './shelf';

let failures = 0;
function check(name: string, ok: boolean, detail?: string) {
  if (!ok) failures++;
  console.log(`  ${ok ? '✓' : '✗'} ${name}${ok || !detail ? '' : `  (${detail})`}`);
}
function eq(name: string, actual: unknown, expected: unknown) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  check(name, ok, ok ? undefined : `got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)}`);
}

console.log('\nBookshelf self-test\n');

// ── classification ─────────────────────────────────────────────────────
eq('pdf by mime', classify('x', 'application/pdf'), 'document');
eq('docx by mime', classify('a.docx', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'), 'document');
eq('xlsx by extension when mime is generic', classify('books.xlsx', 'application/octet-stream'), 'document');
eq('image by mime', classify('no-extension', 'image/heic'), 'image');
eq('video by extension', classify('clip.mkv'), 'video');
eq('audio by extension', classify('voice.opus'), 'audio');
eq('zip is an archive', classify('bundle.zip'), 'archive');
eq('source file is code', classify('main.rs'), 'code');
eq('mime WINS over a misleading extension', classify('report.txt', 'application/pdf'), 'document');
eq('unknown stays other, never guessed', classify('mystery.qqq'), 'other');
eq('no filename and no mime is other', classify(null, null), 'other');
eq('uppercase extension still classifies', classify('SCAN.PDF'), 'document');

// ── query ──────────────────────────────────────────────────────────────
const f = (over: Partial<ShelfFile>): ShelfFile => ({
  attachmentId: 'a', chatId: 'c1', messageId: 1, senderId: 'u1',
  filename: 'file.pdf', mime: 'application/pdf', size: 100,
  createdAt: '2026-08-01T10:00:00.000Z', kind: 'document', ...over,
});

const files: ShelfFile[] = [
  f({ attachmentId: '1', filename: 'Atlas-Proposal.docx', createdAt: '2026-08-01T10:00:00.000Z', size: 4200, messageId: 1 }),
  f({ attachmentId: '2', filename: 'photo.png', kind: 'image', mime: 'image/png', createdAt: '2026-08-03T10:00:00.000Z', size: 900, messageId: 2 }),
  f({ attachmentId: '3', filename: 'Atlas-MSA.pdf', createdAt: '2026-08-02T10:00:00.000Z', size: 10_000, messageId: 3, pinned: true }),
  f({ attachmentId: '4', filename: 'notes.md', kind: 'code', mime: 'text/markdown', createdAt: '2026-08-04T10:00:00.000Z', size: 50, messageId: 4 }),
];

eq('no query returns everything', queryShelf(files).length, files.length);
eq('pinned floats to the top', queryShelf(files)[0].attachmentId, '3');
eq('without pinnedFirst, recency wins', queryShelf(files, { pinnedFirst: false })[0].attachmentId, '4');
eq('kind filter', queryShelf(files, { kind: 'image' }).map(x => x.attachmentId), ['2']);
eq('search is case-insensitive and partial', queryShelf(files, { search: 'atlas', pinnedFirst: false }).map(x => x.attachmentId), ['3', '1']);
eq('search that matches nothing returns empty', queryShelf(files, { search: 'zzzz' }), []);
eq('sort by size, largest first', queryShelf(files, { sort: 'size', pinnedFirst: false }).map(x => x.attachmentId), ['3', '1', '2', '4']);
eq('sort by name', queryShelf(files, { sort: 'name', pinnedFirst: false })[0].filename, 'Atlas-MSA.pdf');

// A filter must never invent or drop rows beyond what it excluded.
const imgs = queryShelf(files, { kind: 'image' });
check('filtering only ever removes', imgs.every(x => files.some(o => o.attachmentId === x.attachmentId)));
eq('every file lands in exactly one kind bucket',
  (['document', 'image', 'video', 'audio', 'archive', 'code', 'other'] as const)
    .reduce((n, k) => n + queryShelf(files, { kind: k }).length, 0),
  files.length);

// Same-timestamp batches must not reorder arbitrarily between calls.
const sameTime = [
  f({ attachmentId: 'x', messageId: 10, createdAt: '2026-08-05T00:00:00.000Z' }),
  f({ attachmentId: 'y', messageId: 11, createdAt: '2026-08-05T00:00:00.000Z' }),
];
eq('a batch send is ordered by message id, stably',
  queryShelf(sameTime).map(x => x.attachmentId), ['y', 'x']);
eq('sorting is deterministic across repeated calls',
  queryShelf(sameTime).map(x => x.attachmentId), queryShelf(sameTime).map(x => x.attachmentId));

// ── counts ─────────────────────────────────────────────────────────────
const counts = countsByKind(files);
eq('counts total matches', counts.all, files.length);
eq('counts per kind', [counts.document, counts.image, counts.code], [2, 1, 1]);
eq('an empty kind reports 0 rather than being absent', counts.video, 0);
eq('empty shelf counts cleanly', countsByKind([]).all, 0);

// ── sizes ──────────────────────────────────────────────────────────────
eq('bytes', formatSize(512), '512 B');
eq('kilobytes', formatSize(2048), '2.0 KB');
eq('megabytes', formatSize(4_404_019), '4.2 MB');
eq('zero renders as nothing, not "0 B"', formatSize(0), '');

console.log(failures ? `\n  ${failures} FAILED\n` : '\n  all shelf checks passed\n');
process.exit(failures ? 1 : 0);
