// lib/call/store.selftest.ts — run: npx tsx lib/call/store.selftest.ts
//
// The reducer is covered by machine.selftest.ts. What this covers is the thing
// the STORE adds on top: that subscribers are woken only when the snapshot
// actually changed. That is not a micro-optimisation — during call setup the
// caller re-rings up to 9x and the callee re-sends its answer up to 5x, so
// no-op events arrive constantly, and a store that notified on every dispatch
// would re-render the call screen through the whole handshake.

import { begin, dispatch, getSnapshot, isActive, reset, subscribe } from './store';
import { IDLE_SNAPSHOT } from './types';

let failures = 0;
function check(name: string, ok: boolean, detail?: string) {
  if (!ok) failures++;
  console.log(`  ${ok ? '✓' : '✗'} ${name}${ok || !detail ? '' : `  (${detail})`}`);
}
function eq(name: string, actual: unknown, expected: unknown) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  check(name, ok, ok ? undefined : `got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)}`);
}

/** Counts notifications; returns [read, unsubscribe]. */
function counter(): [() => number, () => void] {
  let n = 0;
  const off = subscribe(() => { n += 1; });
  return [() => n, off];
}

const START = { chatId: 'c1', peerUid: 'p1', peerName: 'Ada', kind: 'audio' as const, direction: 'outgoing' as const };

console.log('initial state:');
reset();
eq('starts idle', getSnapshot(), IDLE_SNAPSHOT);
check('idle is not active', isActive() === false);

console.log('\nbegin/reset:');
let [count, off] = counter();
begin(START);
eq('begin notifies once', count(), 1);
eq('snapshot reflects the new call', getSnapshot().peerUid, 'p1');
check('a started call is active', isActive() === true);
off();

console.log('\nnotification is change-gated (the re-send storm):');
[count, off] = counter();
dispatch({ type: 'offer_sent' }, 1000);
eq('a real transition notifies', count(), 1);
// Exactly what happens on the wire: the ring re-fires every 3s for up to 9 ticks.
for (let i = 0; i < 9; i++) dispatch({ type: 'offer_sent' }, 1000 + i * 3000);
eq('9 repeat rings notify ZERO times', count(), 1);

dispatch({ type: 'answer_applied' }, 5000);
eq('connecting notifies', count(), 2);
// And the callee re-sends its answer up to 5 times.
for (let i = 0; i < 5; i++) dispatch({ type: 'answer_applied' }, 6000 + i * 1500);
eq('5 repeat answers notify ZERO times', count(), 2);
eq('connectedAt stamped once, not restarted', getSnapshot().connectedAt, 5000);
off();

console.log('\nflags and identical remote streams:');
[count, off] = counter();
dispatch({ type: 'flag', key: 'muted', value: true });
eq('a changed flag notifies', count(), 1);
dispatch({ type: 'flag', key: 'muted', value: true });
eq('setting the same flag again does not', count(), 1);
dispatch({ type: 'remote_stream', uid: 'p1', url: 'rtc://a' }, 7000);
eq('a new stream notifies', count(), 2);
dispatch({ type: 'remote_stream', uid: 'p1', url: 'rtc://a' }, 8000);
eq('an identical stream does not', count(), 2);
off();

console.log('\nterminal + release:');
[count, off] = counter();
dispatch({ type: 'end', reason: 'local_hangup' }, 9000);
eq('end notifies', count(), 1);
eq('status is ended', getSnapshot().status, 'ended');
check('an ended call is not active', isActive() === false);
dispatch({ type: 'flag', key: 'muted', value: false });
eq('events after end notify ZERO times', count(), 1);
reset();
eq('reset notifies', count(), 2);
eq('back to idle', getSnapshot(), IDLE_SNAPSHOT);
dispatch({ type: 'flag', key: 'muted', value: true });
reset();
eq('reset while already idle does not notify', count(), 2);
off();

console.log('\nsubscriber hygiene:');
reset();
let aCount = 0, bCount = 0;
const offA = subscribe(() => { aCount += 1; });
const offB = subscribe(() => { bCount += 1; });
begin(START);
eq('both subscribers notified', [aCount, bCount], [1, 1]);
offA();
dispatch({ type: 'offer_sent' }, 100);
eq('unsubscribed listener is silent', aCount, 1);
eq('remaining listener still fires', bCount, 2);
offB();

// A listener that unsubscribes (or throws) mid-notification must not stop the
// rest — the engine's own teardown does exactly this.
reset();
let thrownAfter = 0;
const offBad = subscribe(() => { throw new Error('subscriber blew up'); });
const offGood = subscribe(() => { thrownAfter += 1; });
begin(START);
eq('a throwing subscriber does not block the others', thrownAfter, 1);
offBad(); offGood();

reset();
let selfOff: () => void = () => {};
let after = 0;
selfOff = subscribe(() => { selfOff(); });
const offLast = subscribe(() => { after += 1; });
begin(START);
eq('a subscriber unsubscribing mid-notify does not skip the next', after, 1);
offLast();
reset();

console.log(failures === 0
  ? '\nALL CALL STORE CHECKS PASSED ✓'
  : `\n${failures} CHECK(S) FAILED ✗`);
process.exit(failures === 0 ? 0 : 1);
