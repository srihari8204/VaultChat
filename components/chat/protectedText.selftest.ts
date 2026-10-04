// components/chat/protectedText.selftest.ts — run: npx tsx components/chat/protectedText.selftest.ts
import assert from 'node:assert/strict';
import { isProtectedMessage, previewText } from './protectedText';
import { countVisibleMatches } from '../../lib/inChatSearchCount';

const plain = { content: 'meet at the station', meta: null };
const ink = { content: 'meet at the station', meta: { invisibleInk: true } };
const once = { content: 'meet at the station', meta: { viewOnce: true } };

assert.equal(isProtectedMessage(plain), false);
assert.equal(isProtectedMessage({}), false);
assert.equal(isProtectedMessage(null), false);
assert.equal(isProtectedMessage(ink), true);
assert.equal(isProtectedMessage(once), true);

// Reply bar / quoted reply / any preview outside the bubble: the text is
// replaced by a kind label, so it can reach neither the screen nor a11y.
assert.equal(previewText(plain, plain.content), 'meet at the station');
assert.equal(previewText(ink, ink.content), 'Invisible Ink message');
assert.equal(previewText(once, once.content), 'View once message');
assert.ok(!previewText(ink, ink.content).includes('station'));
assert.equal(previewText(undefined, 'x'), 'x');

// In-chat search (InChatSearchBar): protected rows are dropped before matching,
// so the count cannot confirm a guess about hidden text.
const rows = [plain, ink, once, { content: 'station closed', meta: { invisibleInk: true } }];
const searchable = rows.filter(m => !isProtectedMessage(m));
assert.equal(countVisibleMatches(rows, 'station'), 4, 'unfiltered, every row would match');
assert.equal(countVisibleMatches(searchable, 'station'), 1);
assert.equal(countVisibleMatches(searchable, 'closed'), 0, 'a word only in Ink text is not found');

console.log('protectedText selftest: ok');
