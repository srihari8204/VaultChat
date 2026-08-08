// lib/reader.selftest.ts — run: npx tsx lib/reader.selftest.ts
//
// The Reader re-renders a user's message. Dropping or duplicating a line here
// would silently rewrite what someone said, so the invariant that every word
// survives the transform is tested directly, not assumed.

import {
  countWords, readStats, formatStats, toBlocks, paginate,
  MIN_READER_WORDS, WORDS_PER_PAGE,
} from './reader';

let failures = 0;
function check(name: string, ok: boolean, detail?: string) {
  if (!ok) failures++;
  console.log(`  ${ok ? '✓' : '✗'} ${name}${ok || !detail ? '' : `  (${detail})`}`);
}
function eq(name: string, actual: unknown, expected: unknown) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  check(name, ok, ok ? undefined : `got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)}`);
}

console.log('\nChat Reader self-test\n');

// ── counting ───────────────────────────────────────────────────────────
eq('empty text counts zero', countWords(''), 0);
eq('null is safe', countWords(null), 0);
eq('words are whitespace-separated', countWords('one two  three\nfour'), 4);
check('a short message is NOT a long read', !readStats('hello there').longRead);
check('a message at the threshold IS a long read',
  readStats(Array.from({ length: MIN_READER_WORDS }, () => 'w').join(' ')).longRead);
check('one word below the threshold is not',
  !readStats(Array.from({ length: MIN_READER_WORDS - 1 }, () => 'w').join(' ')).longRead);

const long = readStats(Array.from({ length: 1412 }, () => 'word').join(' '));
eq('1,412 words -> 7 min read', long.minutes, 7);
eq('1,412 words -> 6 pages', long.pages, Math.ceil(1412 / WORDS_PER_PAGE));
check('subtitle matches the design shape', /^\d+ min read · \d+ pages? · [\d,]+ words$/.test(formatStats(long)),
  formatStats(long));
eq('empty text has no minutes and no pages', [readStats('').minutes, readStats('').pages], [0, 0]);

// ── structure ──────────────────────────────────────────────────────────
const doc = [
  'Why we are changing it',
  '',
  'Checkout is a week behind, and pretending otherwise',
  'only moves the slip somewhere more expensive.',
  '',
  '- Phases replace the launch day',
  '* Pricing ships dark in Phase 1',
  '• No phase starts on a Friday',
  '',
  '> This is now written down.',
  '',
  'The plan we signed off in June assumed a single launch day.',
].join('\n');

const blocks = toBlocks(doc);
eq('heading detected', blocks[0], { kind: 'heading', text: 'Why we are changing it' });
eq('wrapped lines join into ONE paragraph', blocks[1],
  { kind: 'paragraph', text: 'Checkout is a week behind, and pretending otherwise only moves the slip somewhere more expensive.' });
eq('all three bullet markers work',
  blocks.slice(2, 5).map(b => b.kind), ['bullet', 'bullet', 'bullet']);
eq('bullet marker is stripped', blocks[2].text, 'Phases replace the launch day');
eq('quote detected and stripped', blocks[5], { kind: 'quote', text: 'This is now written down.' });

// A sentence must NOT be promoted to a heading just because it is short.
eq('a short SENTENCE stays a paragraph',
  toBlocks('It shipped.\n\nNext.')[0], { kind: 'paragraph', text: 'It shipped.' });
// A line followed by more text is mid-paragraph, not a heading.
eq('a heading-looking line mid-paragraph stays prose',
  toBlocks('Rollout plan\nis attached below.')[0].kind, 'paragraph');

// ── THE invariant: nothing the user wrote is lost ──────────────────────
const wordsIn = countWords(doc.replace(/^[-*•>]\s?/gm, ''));
const wordsOut = blocks.reduce((n, b) => n + countWords(b.text), 0);
eq('every word survives the transform', wordsOut, wordsIn);
check('no empty blocks are emitted', blocks.every(b => b.text.trim().length > 0));

// ── pagination ─────────────────────────────────────────────────────────
const many = Array.from({ length: 40 }, (_, i) => ({ kind: 'paragraph' as const, text: Array.from({ length: 40 }, () => `w${i}`).join(' ') }));
const pages = paginate(many);
check('pagination produces more than one page', pages.length > 1, `${pages.length} pages`);
eq('pagination loses no blocks', pages.flat().length, many.length);
eq('pagination preserves order', pages.flat()[0], many[0]);

// A heading must not be left alone at the foot of a page.
const headingAtBoundary = [
  { kind: 'paragraph' as const, text: Array.from({ length: WORDS_PER_PAGE }, () => 'w').join(' ') },
  { kind: 'heading' as const, text: 'Next section' },
  { kind: 'paragraph' as const, text: 'Body follows.' },
];
const p2 = paginate(headingAtBoundary);
const lastOfPage = p2.map(pg => pg[pg.length - 1].kind);
check('a heading never ends a page', !lastOfPage.includes('heading'), lastOfPage.join(','));

eq('empty input paginates to nothing', paginate([]), []);

console.log(failures ? `\n  ${failures} FAILED\n` : '\n  all reader checks passed\n');
process.exit(failures ? 1 : 0);
