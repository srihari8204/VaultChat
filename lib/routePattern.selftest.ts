// lib/routePattern.selftest.ts — run: npx tsx lib/routePattern.selftest.ts
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { routePatternName } from './routePattern';

assert.equal(routePatternName(['join', '[code]']), 'join/[code]', 'invite codes never reach the counter');
assert.equal(routePatternName(['live', 'join', '[code]']), 'live/join/[code]');
assert.equal(routePatternName(['add', '[...segments]']), 'add/[...segments]');
assert.equal(routePatternName(['(tabs)', 'chats']), 'chats', 'route groups are structure, not screens');
assert.equal(routePatternName(['finance', '(group)', 'ledger', 'index']), 'finance/ledger/index');
assert.equal(routePatternName(['shop-book']), 'shop-book');
assert.equal(routePatternName([]), '', 'the cold-start index is not counted');

// The observer must count segments, not the resolved pathname.
const src = fs.readFileSync(path.join(__dirname, '..', 'components', 'UsageCounter.tsx'), 'utf8')
  .replace(/\/\/.*$/gm, '');
assert.match(src, /useSegments\(\)/, 'UsageCounter reads useSegments');
assert.doesNotMatch(src, /usePathname/, 'UsageCounter no longer reads the resolved pathname');
assert.match(src, /routePatternName\(/, 'UsageCounter names screens with routePatternName');

console.log('routePattern.selftest: all checks passed');
