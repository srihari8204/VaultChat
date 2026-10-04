// components/chat/forwardFeedback.selftest.ts — run: npx tsx components/chat/forwardFeedback.selftest.ts
//
// The source chat's feedback for a forward (components/chat/forwardFeedback):
//   * a permanent rejection of a TRACKED forward is reported once, by name;
//   * other chats' failures, a 'sent', and a second 'failed' report nothing;
//   * dispose detaches both listeners;
//   * a repeated "Forwarding to X" is a new notice (new key), so it is announced
//     again and gets a fresh timer;
//   * app/chat.tsx uses these, keyed by the notice count.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { forwardFeedback, nextForwardNote, type ForwardQueueBus } from './forwardFeedback';

const subs = { failed: new Set<(e: any) => void>(), sent: new Set<(e: any) => void>() };
const on = ((event: 'failed' | 'sent', fn: (e: any) => void) => {
  subs[event].add(fn);
  return () => { subs[event].delete(fn); };
}) as ForwardQueueBus;
const fire = (event: 'failed' | 'sent', e: object) => subs[event].forEach(fn => fn(e));

const reported: [string, string][] = [];
const f = forwardFeedback(on, (name, error) => reported.push([name, error]));
f.track('t1', 'Sam');
f.track('t2', 'Book club');
assert.equal(f.pending(), 2);

fire('failed', { tempId: 'other', chatId: 'x', error: 'nope' });
assert.deepEqual(reported, [], 'a failure that is not one of our forwards is ignored');

fire('failed', { tempId: 't1', chatId: 'a', error: 'You are blocked' });
assert.deepEqual(reported, [['Sam', 'You are blocked']], 'a tracked rejection is reported by name');
fire('failed', { tempId: 't1', chatId: 'a', error: 'again' });
assert.equal(reported.length, 1, 'reported once');

fire('sent', { tempId: 't2', chatId: 'b', real: null });
fire('failed', { tempId: 't2', chatId: 'b', error: 'late' });
assert.equal(reported.length, 1, 'a sent forward is forgotten');
assert.equal(f.pending(), 0);

f.track('t3', 'Ana');
f.dispose();
assert.equal(subs.failed.size + subs.sent.size, 0, 'dispose detaches both listeners');
fire('failed', { tempId: 't3', chatId: 'c', error: 'x' });
assert.equal(reported.length, 1, 'nothing after dispose');

const a = nextForwardNote(null, 'Sam');
const b = nextForwardNote(a, 'Sam');
assert.equal(a.text, 'Forwarding to Sam');
assert.equal(b.text, a.text);
assert.notEqual(b.n, a.n, 'the same text twice is a new notice');

const chat = readFileSync('app/chat.tsx', 'utf8');
assert.match(chat, /forwardFeedback\(onQueue,/, 'chat.tsx listens through forwardFeedback');
assert.match(chat, /forwards\.current\?\.track\(q\.tempId, name\)/, 'chat.tsx tracks each queued forward');
assert.match(chat, /<NoticeBar key=\{forwardNote\.n\}/, 'the notice is keyed by its count');

console.log('forwardFeedback: rejection report, sent/foreign/dispose and repeated-notice checks passed');
