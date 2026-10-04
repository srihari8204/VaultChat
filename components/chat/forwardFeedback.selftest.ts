// components/chat/forwardFeedback.selftest.ts — run: npx tsx components/chat/forwardFeedback.selftest.ts
//
// The source chat's feedback for a forward (components/chat/forwardFeedback):
//   * a permanent rejection of a TRACKED forward is reported once, by name;
//   * other chats' failures, a 'sent', and a second 'failed' report nothing;
//   * dispose detaches both listeners;
//   * a repeated "Forwarding to X" is a new notice (new key), so it is announced
//     again and gets a fresh timer;
//   * appForwardFeedback is ONE app-wide instance: a second call (a remounted
//     screen) does not subscribe again, and nothing disposes it, so a rejection
//     after the source chat closed is still reported;
//   * after an app restart (nothing tracked in memory) a rejection is still
//     reported by the name the outbox row carries (forwardTo), and a plain
//     send's failure (no forwardTo) is not;
//   * app/chat.tsx uses the app-wide one with a module-scope reporter
//     (forwardRejectionReport), stores the name on the row, and the notice is
//     keyed by its count; the boot sequence arms it only after the launch gate
//     let the launch in.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { appForwardFeedback, forwardFeedback, nextForwardNote, type ForwardQueueBus } from './forwardFeedback';

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

// App-wide: subscribed once, never disposed by a screen.
const appReported: string[] = [];
const app1 = appForwardFeedback(on, (name) => appReported.push(name));
const app2 = appForwardFeedback(on, () => appReported.push('second reporter'));
assert.equal(app1, app2, 'one app-wide instance');
assert.equal(subs.failed.size, 1, 'a second call does not subscribe again');
app1.track('t4', 'Dev');
// (the source chat screen unmounts here: nothing it does touches app1)
fire('failed', { tempId: 't4', chatId: 'd', error: 'blocked' });
assert.deepEqual(appReported, ['Dev'], 'reported after the source chat closed, by the first reporter only');

// After a restart: the in-memory map is empty; the row's forwardTo names it.
fire('failed', { tempId: 'before-restart', chatId: 'e', error: 'blocked', forwardTo: 'Kim' });
assert.deepEqual(appReported, ['Dev', 'Kim'], 'an untracked rejection is reported by the row\'s forwardTo');
fire('failed', { tempId: 'plain-send', chatId: 'e', error: 'too large' });
assert.equal(appReported.length, 2, 'a failed ordinary send (no forwardTo) is not a forward');

const chat = readFileSync('app/chat.tsx', 'utf8');
assert.match(chat, /armForwardRejectionReport\(onQueue\)/, 'chat.tsx uses the app-wide tracker');
const report = readFileSync('components/chat/forwardRejectionReport.ts', 'utf8');
assert.match(report, /^export function reportForwardRejection\(/m, 'the reporter is module scope, not one screen instance');
assert.match(report, /appForwardFeedback\(on, reportForwardRejection\)/, 'one app-wide tracker with that reporter');
assert.match(chat, /enqueueMessage\(target\.id, \{[^}]*forwardTo: name \}\)/, 'the target name rides on the outbox row');
const queue = readFileSync('lib/messageQueue.ts', 'utf8');
assert.match(queue, /const payload = \{ content, type: item\.type, replyToId: item\.replyToId, meta: serverMeta, clientId: item\.clientId \};/,
  'the POST payload is built field by field, so forwardTo never leaves the device');
assert.match(queue, /emit\('failed', \{ tempId: item\.tempId, chatId: item\.chatId, error: item\.lastError, forwardTo: item\.forwardTo \}\)/,
  'a rejection hands the row\'s forwardTo back');
const boot = readFileSync('components/root/useBootSequence.ts', 'utf8');
assert.match(boot, /launchDecision\.then\(ok => ok\s*\? import\('\.\.\/chat\/forwardRejectionReport'\)\.then\(r => \{ r\.armForwardRejectionReport\(m\.on\); \}\)/,
  'the boot sequence arms the report only once this mount\'s gate allowed the launch');
assert.match(boot, /m\.initQueue\(\);\s*\}\)\.catch/, 'and still drains the outbox whatever the gate says');
assert.match(chat, /forwards\.track\(q\.tempId, name\)/, 'chat.tsx tracks each queued forward');
assert.doesNotMatch(chat, /\.dispose\(\)/, 'no screen disposes the app-wide tracker');
assert.match(chat, /<NoticeBar key=\{forwardNote\.n\}/, 'the notice is keyed by its count');

console.log('forwardFeedback: rejection report, sent/foreign/dispose, app-wide instance and repeated-notice checks passed');
