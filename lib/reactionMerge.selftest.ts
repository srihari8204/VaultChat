// lib/reactionMerge.selftest.ts — run: npx tsx lib/reactionMerge.selftest.ts
//
// Two things matter here and they pull in opposite directions:
//   * the counts must be RIGHT (a wrong reaction count is user-visible)
//   * unchanged summaries must keep their ARRAY IDENTITY (a new array on every
//     unrelated message re-renders every reacted bubble in the conversation)
//
// A cache that returns stale arrays would pass the identity checks and break
// the app, so every identity check here is paired with a correctness check.

import { mergeReactions, type ReactionSummary, type ReactionSourceMsg } from './reactionMerge';

let failures = 0;
function check(name: string, ok: boolean, detail?: string) {
  if (!ok) failures++;
  console.log(`  ${ok ? '✓' : '✗'} ${name}${ok || !detail ? '' : `  (${detail})`}`);
}

let seq = 0;
const react = (target: number, emoji: string, sender: string, op: 'add' | 'remove' = 'add'): ReactionSourceMsg => ({
  id: ++seq, type: 'reaction', senderId: sender,
  createdAt: `2026-01-01T00:00:${String(seq).padStart(2, '0')}.000Z`,
  content: JSON.stringify({ reactsTo: target, emoji, op }),
});
const text = (id: number): ReactionSourceMsg =>
  ({ id, type: 'text', content: 'hi', senderId: 'u1', createdAt: '2026-01-01T00:00:00.000Z' });

const ME = 'me';

console.log('correctness first');
let msgs: ReactionSourceMsg[] = [text(1), text(2), react(1, '👍', ME), react(1, '👍', 'u2'), react(2, '❤️', 'u2')];
let r = mergeReactions(msgs, ME);
check('counts aggregate across senders', r[1]?.[0]?.count === 2, JSON.stringify(r[1]));
check('mine is true when I reacted', r[1]?.[0]?.mine === true);
check('a reaction from someone else is not mine', r[2]?.[0]?.mine === false);
check('unreacted messages have no entry', r[3] === undefined);

// remove wins when it is newer
const removed = mergeReactions([...msgs, react(1, '👍', ME, 'remove')], ME);
check('a later remove drops my reaction', removed[1]?.[0]?.count === 1, JSON.stringify(removed[1]));
check('and clears mine', removed[1]?.[0]?.mine === false);

console.log('identity across unrelated changes');
const base = mergeReactions(msgs, ME);
// Exactly what the chat does when an unrelated message arrives: a NEW array,
// same reaction rows by reference.
const afterUnrelated = mergeReactions([text(99), ...msgs], ME, base);
check('an unrelated new message keeps every reaction array identical',
  afterUnrelated[1] === base[1] && afterUnrelated[2] === base[2],
  'new arrays here re-render every reacted bubble on unrelated traffic');

// A receipt patch replaces a message OBJECT without touching reactions.
const patched = msgs.map(m => (m.id === 1 ? { ...m, deliveredAt: 'now' } : m));
const afterPatch = mergeReactions(patched, ME, afterUnrelated);
check('a receipt patch on an unrelated message keeps identity',
  afterPatch[1] === base[1] && afterPatch[2] === base[2]);

console.log('identity must NOT survive a real change');
const changed = mergeReactions([...msgs, react(1, '🎉', 'u3')], ME, afterPatch);
check('adding a reaction produces a NEW array for that message',
  changed[1] !== base[1], 'stale identity would freeze the UI');
check('…with the new emoji present',
  changed[1]?.some((x: ReactionSummary) => x.emoji === '🎉') === true, JSON.stringify(changed[1]));
check('…while an untouched message keeps its identity',
  changed[2] === base[2], 'only the changed message should invalidate');

// Count changes alone must invalidate, even with the same emoji set.
const more = mergeReactions([...msgs, react(2, '❤️', 'u4')], ME, changed);
check('a count change produces a new array', more[2] !== base[2]);
check('…and the count is right', more[2]?.[0]?.count === 2, JSON.stringify(more[2]));

console.log('degenerate input');
check('no messages is fine', Object.keys(mergeReactions([], ME)).length === 0);
check('malformed JSON is ignored',
  Object.keys(mergeReactions([{ id: 1, type: 'reaction', content: '{oops', senderId: 'u' }], ME)).length === 0);
check('a deleted reaction is ignored',
  Object.keys(mergeReactions([{ ...react(1, '👍', ME), deletedAt: 'x' }], ME)).length === 0);
check('a non-numeric target is ignored',
  Object.keys(mergeReactions([{ id: 1, type: 'reaction', senderId: 'u',
    content: JSON.stringify({ reactsTo: 'nope', emoji: '👍' }) }], ME)).length === 0);
check('calling without prev still works', !!mergeReactions(msgs, ME)[1]);

console.log(failures === 0 ? '\nPASS' : `\nFAIL (${failures})`);
process.exit(failures === 0 ? 0 : 1);
