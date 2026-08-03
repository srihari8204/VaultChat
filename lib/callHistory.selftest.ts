// lib/callHistory.selftest.ts — run: npx tsx lib/callHistory.selftest.ts
//
// The merge is where user-visible history can be silently destroyed, so it is
// tested as a pure function. Every case below is a way the two sources actually
// disagree in practice, not an invented one.

import { mergeCallHistory, type ChatNameLookup } from './callHistory';
import type { CallLogEntry } from './callLog';
import type { ServerCallEntry } from './callSession';

let failures = 0;
function check(name: string, ok: boolean, detail?: string) {
  if (!ok) failures++;
  console.log(`  ${ok ? '✓' : '✗'} ${name}${ok || !detail ? '' : `  (${detail})`}`);
}
function eq(name: string, actual: unknown, expected: unknown) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  check(name, ok, ok ? undefined : `got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)}`);
}

const ME = 'me-uid';
const T0 = 1_800_000_000_000;

const names: ChatNameLookup = {
  get: (id) => ({
    'chat-ann': { name: 'Ann', photo: 'p1', direct: true },
    'chat-team': { name: 'Team', photo: null, direct: false },
  }[id]),
};

const local = (over: Partial<CallLogEntry> = {}): CallLogEntry => ({
  id: 'L1', chatId: 'chat-ann', peerUid: 'ann', peerName: 'Ann',
  kind: 'audio', direction: 'outgoing', at: T0, durationSec: 60, ...over,
});

const srv = (over: Partial<ServerCallEntry> = {}): ServerCallEntry => ({
  callId: 'c1', chatId: 'chat-ann', kind: 'audio', mode: 'meeting', role: 'host',
  startedBy: ME, startedAt: new Date(T0).toISOString(), endedAt: null,
  joinedAt: new Date(T0).toISOString(), leftAt: null, durationSec: 60, ...over,
});

console.log('the device log is never lost:');
let out = mergeCallHistory([local()], [], ME, names);
eq('a purely local call survives an empty server', out.map(e => e.id), ['L1']);
out = mergeCallHistory([local({ id: 'old', callId: undefined })], [srv({ callId: 'c9' })], ME, names);
eq('history from before CALL_SESSIONS is kept', out.length, 2);
check('…and keeps its own identity', out.some(e => e.id === 'old'));

console.log('\ndeduplication is by callId, exactly:');
out = mergeCallHistory([local({ callId: 'c1' })], [srv({ callId: 'c1' })], ME, names);
eq('the same call appears once', out.length, 1);
eq('and the LOCAL row wins — it knows the peer', out[0].peerName, 'Ann');
check('so the peer uid survives', out[0].peerUid === 'ann');

// Two calls to the same person seconds apart are two calls. A timestamp-window
// merge would eat one of them; an id match cannot.
out = mergeCallHistory(
  [local({ id: 'L1', callId: 'c1', at: T0 }), local({ id: 'L2', callId: 'c2', at: T0 + 2000 })],
  [srv({ callId: 'c1' }), srv({ callId: 'c2', joinedAt: new Date(T0 + 2000).toISOString() })],
  ME, names);
eq('two near-simultaneous calls both survive', out.length, 2);

console.log('\nthe server fills in what this device never saw:');
out = mergeCallHistory([], [srv({ callId: 'c2', chatId: 'chat-team', mode: 'meeting' })], ME, names);
eq('a call from another device appears', out.length, 1);
check('marked as remote', out[0].remote === true);
eq('named from the chat lookup', out[0].peerName, 'Team');
check('a group chat produces a group row', out[0].group === true);
eq('the role is carried through', out[0].role, 'host');

out = mergeCallHistory([], [srv({ callId: 'c3', startedBy: 'someone-else' })], ME, names);
eq('a call I did not start is incoming', out[0].direction, 'incoming');
out = mergeCallHistory([], [srv({ callId: 'c4', startedBy: ME })], ME, names);
eq('a call I started is outgoing', out[0].direction, 'outgoing');

// The server has no row for a call that only rang, so "missed" is not something
// it can tell us. Claiming it would be inventing information.
check('a server row is never reported as missed',
  mergeCallHistory([], [srv({ callId: 'c5' })], ME, names)[0].direction !== 'missed');

console.log('\ndismissing a server-only call:');
// A row this device never made has nothing to delete locally, so "remove" has
// to filter it here or it comes straight back on the next sync.
out = mergeCallHistory([], [srv({ callId: 'c6' })], ME, names, new Set(['c6']));
eq('a dismissed server call is gone', out.length, 0);
out = mergeCallHistory([], [srv({ callId: 'c6' }), srv({ callId: 'c7' })], ME, names, new Set(['c6']));
eq('and only that one', out.map(e => e.callId), ['c7']);
// Dismissal must not reach into the device's own log — that history may exist
// nowhere else.
out = mergeCallHistory([local({ callId: 'c8' })], [srv({ callId: 'c8' })], ME, names, new Set(['c8']));
eq('a LOCAL call is never hidden by a dismissal', out.length, 1);
check('…and it is still the local row', out[0].id === 'L1');

console.log('\nordering and robustness:');
out = mergeCallHistory(
  [local({ id: 'old', at: T0 })],
  [srv({ callId: 'cNew', joinedAt: new Date(T0 + 60_000).toISOString() })],
  ME, names);
eq('newest first, across both sources', out.map(e => e.id), ['srv:cNew', 'old']);

out = mergeCallHistory([local()], [srv({ callId: '' } as any), null as any], ME, names);
eq('a malformed server row is skipped, not thrown on', out.length, 1);

out = mergeCallHistory([], [srv({ callId: 'cX', chatId: 'chat-unknown' })], ME, names);
check('an unknown chat still renders with a fallback name', !!out[0].peerName);
eq('duration comes from the server row', out[0].durationSec, 60);

console.log(failures === 0
  ? '\nALL CALL HISTORY CHECKS PASSED ✓'
  : `\n${failures} CHECK(S) FAILED ✗`);
process.exit(failures === 0 ? 0 : 1);
