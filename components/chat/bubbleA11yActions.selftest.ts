// components/chat/bubbleA11yActions.selftest.ts — run: npx tsx components/chat/bubbleA11yActions.selftest.ts
//
// The bubble's nested controls are only reachable by screen readers through
// these actions, so: every nested control has one, the message menu is always
// first, and nothing is offered that the bubble would refuse (reply/react on
// an unsent row, opening a view-once before its one view).

import assert from 'node:assert/strict';
import { bubbleA11yActions, type BubbleA11yFacts } from './bubbleA11yActions';

const base: BubbleA11yFacts = {
  confirmed: true, quote: false, revealOnce: null, media: null,
  location: false, card: null, link: false, longRead: false, poll: [],
};
const names = (f: Partial<BubbleA11yFacts>) => bubbleA11yActions({ ...base, ...f }).map(a => a.name);
const labels = (f: Partial<BubbleA11yFacts>) => bubbleA11yActions({ ...base, ...f }).map(a => a.label);

// 1. A plain confirmed text: menu first, then reply and react.
assert.deepEqual(names({}), ['longpress', 'reply', 'react']);
assert.equal(labels({})[0], 'Message actions');

// 2. Unsent rows: only the menu, worded for what it does there.
assert.deepEqual(names({ state: 'pending' }), ['longpress']);
assert.equal(labels({ state: 'pending' })[0], 'Cancel sending');
assert.equal(labels({ state: 'failed' })[0], 'Retry or delete');
assert.deepEqual(names({ confirmed: false }), ['longpress']);

// 3. View-once: the reveal replaces "open" — never both.
const once = names({ revealOnce: 'photo', media: 'photo' });
assert.ok(once.includes('reveal') && !once.includes('open'));
assert.ok(labels({ revealOnce: 'video' }).includes('View video once'));

// 4. Each nested control gets its action.
assert.ok(labels({ media: 'photo' }).includes('Open photo'));
assert.ok(labels({ media: 'video' }).includes('Play video'));
assert.ok(labels({ media: 'file' }).includes('Open file'));
assert.ok(names({ media: 'voice' }).includes('play'));
assert.ok(names({ quote: true }).includes('quote'));
assert.ok(names({ location: true }).includes('location'));
assert.ok(labels({ card: 'Open Book club' }).includes('Open Book club'));
assert.ok(names({ link: true }).includes('link'));
assert.ok(names({ longRead: true }).includes('reader'));

// 5. Poll: one action per option, saying whether it adds or removes the vote.
const poll = bubbleA11yActions({ ...base, poll: [{ label: 'Yes', mine: true }, { label: 'No', mine: false }] })
  .filter(a => a.name.startsWith('vote:'));
assert.deepEqual(poll, [
  { name: 'vote:0', label: 'Remove vote for Yes' },
  { name: 'vote:1', label: 'Vote for No' },
]);

// 6. Names are unique (the dispatcher switches on them).
const all = names({ quote: true, media: 'file', location: true, link: true, longRead: true, card: 'x',
  poll: [{ label: 'a', mine: false }, { label: 'b', mine: false }] });
assert.equal(new Set(all).size, all.length);

console.log('bubbleA11yActions: all passed');
