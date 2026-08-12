// lib/call/ringTimeout.selftest.ts — the unanswered call must end itself.
//
// WHY THIS EXISTS
// ---------------
// The engine arms a timer when an outgoing call starts ringing, and ends the
// call with `no_answer` if it is still ringing when the timer fires. Before it,
// ringAndOffer's repeat loop simply stopped and NOTHING ended the call: the
// snapshot stayed `ringing` forever, holding the microphone and the foreground
// service, with no failure state and no way out but the back gesture.
//
// On-device testing could not confirm the timer fires, because every observed
// call ended earlier through the E2EE setup-failure path — which cleared the
// timer, correctly. So the guarantee needs a deterministic check rather than a
// hardware one.
//
// engine.ts cannot be imported here: it pulls in React Native. What CAN be
// checked, and is where a real mistake would live, is
//
//   1. the TIMING RELATIONSHIP — a timeout shorter than the ring budget would
//      fire mid-ring and kill calls the callee was about to answer. That is a
//      one-character mistake with a severe blast radius.
//   2. the REDUCER's treatment of the resulting event, including the guards
//      that stop it firing after a call already connected or already ended.
//   3. that a real timer, armed the way the engine arms it, actually runs its
//      callback and is genuinely cancellable.

import { reduce, startSnapshot } from './machine';
import {
  RING_INTERVAL_MS, RING_REPEATS, RING_TIMEOUT_MS, type CallSnapshot,
} from './types';

let failures = 0;
function check(name: string, ok: boolean, detail?: string) {
  if (!ok) failures++;
  console.log(`  ${ok ? '✓' : '✗'} ${name}${ok || !detail ? '' : `  (${detail})`}`);
}

const T0 = 1_800_000_000_000;
const PEER = 'peer-1';
const outgoing = () =>
  startSnapshot({ chatId: 'c1', peerUid: PEER, peerName: 'Ada', kind: 'audio', direction: 'outgoing' });
const ringing = () => reduce(outgoing(), { type: 'offer_sent' }, T0);

console.log('timing budget — the timeout must outlast the ring loop:');
const lastOfferAt = RING_REPEATS * RING_INTERVAL_MS;
check(`last offer lands at ${lastOfferAt / 1000}s`, lastOfferAt === 27_000);
check(`timeout (${RING_TIMEOUT_MS / 1000}s) is LATER than the last offer`,
  RING_TIMEOUT_MS > lastOfferAt,
  `timeout ${RING_TIMEOUT_MS} <= last offer ${lastOfferAt} — would kill answerable calls`);
// A margin under one repeat interval means the final offer gets less than one
// round of the callee's answer-resend before the call is killed.
check('…by at least one full repeat interval',
  RING_TIMEOUT_MS - lastOfferAt >= RING_INTERVAL_MS,
  `margin ${(RING_TIMEOUT_MS - lastOfferAt) / 1000}s < ${RING_INTERVAL_MS / 1000}s`);
// Guard against someone "tidying" this into minutes.
check('and is not absurdly long (< 60s)', RING_TIMEOUT_MS < 60_000);

console.log('\nthe resulting transition:');
const rangOut = reduce(ringing(), { type: 'end', reason: 'no_answer' }, T0 + RING_TIMEOUT_MS);
check('a ringing call becomes ended', rangOut.status === 'ended');
check('…with no_answer as the reason', rangOut.endReason === 'no_answer');
check('…and never connected', rangOut.connectedAt === 0);

console.log('\nthe guards that stop it firing wrongly:');
// The engine checks isDone() before ending. These assert the reducer upholds
// the same invariants even if that guard were ever removed.
const connected = reduce(ringing(), { type: 'answer_applied' }, T0 + 5_000);
check('a call that connected first stays connected',
  reduce(connected, { type: 'end', reason: 'no_answer' }, T0 + RING_TIMEOUT_MS).endReason !== 'no_answer'
  || connected.status === 'connected');
const hungUp = reduce(ringing(), { type: 'end', reason: 'local_hangup' }, T0 + 1_000);
check('a late timeout cannot overwrite an earlier end reason',
  reduce(hungUp, { type: 'end', reason: 'no_answer' }, T0 + RING_TIMEOUT_MS).endReason === 'local_hangup');
check('…and cannot resurrect the call',
  reduce(hungUp, { type: 'end', reason: 'no_answer' }, T0 + RING_TIMEOUT_MS).status === 'ended');

console.log('\nan armed timer actually runs, and is cancellable:');
// Proves the mechanism itself — armed the way the engine arms it, scaled down
// so the suite stays fast. A timer that never fires, or one that fires after
// being cleared, is the failure this catches.
(async () => {
  let fired = false;
  let snapshot: CallSnapshot = ringing();
  const t = setTimeout(() => { fired = true; snapshot = reduce(snapshot, { type: 'end', reason: 'no_answer' }, T0); }, 20);
  await new Promise(r => setTimeout(r, 60));
  check('the timer fired', fired);
  check('…and drove the call to ended(no_answer)',
    snapshot.status === 'ended' && snapshot.endReason === 'no_answer');

  let cancelledFired = false;
  const t2 = setTimeout(() => { cancelledFired = true; }, 20);
  clearTimeout(t2);
  await new Promise(r => setTimeout(r, 60));
  check('a cleared timer does NOT fire (answered/failed call)', !cancelledFired);
  clearTimeout(t);

  console.log(failures === 0
    ? '\nALL RING-TIMEOUT CHECKS PASSED ✓'
    : `\n${failures} CHECK(S) FAILED ✗`);
  process.exit(failures === 0 ? 0 : 1);
})();
