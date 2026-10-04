// lib/searchSnippet.selftest.ts — run: npx tsx lib/searchSnippet.selftest.ts
import assert from 'node:assert/strict';
import { searchSnippet as s } from './searchSnippet';

assert.deepEqual(s('Hello World', 'world'), { before: 'Hello ', match: 'World', after: '' }, 'case-insensitive, keeps original case');
assert.deepEqual(s('abc', 'x'), { before: 'abc', match: '', after: '' }, 'no match');
assert.deepEqual(s('abc', '  '), { before: 'abc', match: '', after: '' }, 'blank query');
assert.deepEqual(s('pay rent pay', 'pay'), { before: '', match: 'pay', after: ' rent pay' }, 'first match only');
const long = 'the quick brown fox jumps over the lazy dog and then the meeting is at noon';
const r = s(long, 'meeting');
assert.equal(r.match, 'meeting');
assert.ok(r.before.startsWith('…') && r.before.length <= 25, `lead-in trimmed: ${JSON.stringify(r.before)}`);
assert.ok(long.endsWith(r.before.slice(1) + r.match + r.after), 'no text invented');
assert.deepEqual(s(undefined as any, 'a'), { before: '', match: '', after: '' });
console.log('searchSnippet selftest: ok');
