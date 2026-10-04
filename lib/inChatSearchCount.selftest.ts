// lib/inChatSearchCount.selftest.ts — run: npx tsx lib/inChatSearchCount.selftest.ts
import assert from 'node:assert/strict';
import { countVisibleMatches } from './inChatSearchCount';

const rows = [
  { content: 'Hello there' },
  { content: 'hello again' },
  { content: 'deleted hello', deletedAt: '2026-01-01T00:00:00Z' },
  { content: null },
  { content: 'bye' },
];

assert.equal(countVisibleMatches(rows, 'hello'), 2, 'case-insensitive, deleted rows excluded');
assert.equal(countVisibleMatches(rows, '  HELLO  '), 2, 'query is trimmed like the highlight');
assert.equal(countVisibleMatches(rows, ''), 0, 'empty query counts nothing');
assert.equal(countVisibleMatches(rows, '   '), 0, 'blank query counts nothing');
assert.equal(countVisibleMatches(rows, 'zzz'), 0);

// The screen must count over the rendered list, not raw state that still holds
// reaction / trip / live-location plumbing rows.
import { readFileSync } from 'node:fs';
const SCREEN = readFileSync('app/chat.tsx', 'utf8');
assert.ok(SCREEN.includes('countVisibleMatches(renderMessages, searchQ)'),
  'chat.tsx search count must run over renderMessages');

console.log('inChatSearchCount selftest: ok');
