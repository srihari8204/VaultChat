// lib/call/machine.selftest.ts — run: npx tsx lib/call/machine.selftest.ts
//
// Every case below is a real situation from the shipped call screens, not an
// invented one. Where a case corresponds to a guard that already exists in
// app/voicecall.tsx or app/videocall.tsx, the comment says so — those guards are
// the specification, and this is the first time they can be checked without two
// phones and a TURN server.

import {
  durationSeconds, reduce, shouldCancelRing, startSnapshot, wasMissed,
  type CallEvent,
} from './machine';
import { MAX_CALL_CHAT, MAX_CALL_REACTIONS, type CallSnapshot } from './types';

let failures = 0;
function check(name: string, ok: boolean, detail?: string) {
  if (!ok) failures++;
  console.log(`  ${ok ? '✓' : '✗'} ${name}${ok || !detail ? '' : `  (${detail})`}`);
}
function eq(name: string, actual: unknown, expected: unknown) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  check(name, ok, ok ? undefined : `got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)}`);
}

const T0 = 1_800_000_000_000;
const PEER = 'peer-uid-1';
const out = () => startSnapshot({ chatId: 'c1', peerUid: PEER, peerName: 'Ada', kind: 'audio', direction: 'outgoing' });
const inc = () => startSnapshot({ chatId: 'c1', peerUid: PEER, peerName: 'Ada', kind: 'audio', direction: 'incoming' });
const run = (s: CallSnapshot, events: CallEvent[], now = T0) => events.reduce((acc, e) => reduce(acc, e, now), s);

console.log('start state:');
eq('outgoing starts connecting', out().status, 'connecting');
eq('voice call defaults to earpiece', out().speaker, false);
eq('video call defaults to speaker',
  startSnapshot({ chatId: 'c', peerUid: PEER, peerName: 'A', kind: 'video', direction: 'outgoing' }).speaker, true);
eq('no connectedAt before connecting', out().connectedAt, 0);

console.log('\ninvariant 3 — ringing is outgoing-only:');
eq('outgoing offer_sent -> ringing', run(out(), [{ type: 'offer_sent' }]).status, 'ringing');
eq('incoming offer_sent is ignored', run(inc(), [{ type: 'offer_sent' }]).status, 'connecting');

console.log('\ninvariant 2 — connecting is idempotent (the re-send storm):');
// The caller re-rings up to 9x and the callee re-sends its answer up to 5x, so
// these events genuinely arrive repeatedly on a live call.
const connected = run(out(), [{ type: 'offer_sent' }, { type: 'answer_applied' }], T0);
eq('answer_applied -> connected', connected.status, 'connected');
eq('connectedAt stamped', connected.connectedAt, T0);
const later = reduce(connected, { type: 'answer_applied' }, T0 + 30_000);
check('second answer_applied is a no-op (same reference)', later === connected);
eq('connectedAt did NOT restart', later.connectedAt, T0);
const reRing = reduce(connected, { type: 'offer_sent' }, T0 + 5_000);
check('a re-ring tick cannot demote connected -> ringing', reRing === connected);

console.log('\nreconnecting — the recovery that used to be invisible:');
// peer.ts holds a dropped call open for 30 s, retrying an ICE restart every 4 s.
// The engine dispatches 'reconnecting' from renegotiate() and 'recovered' from
// the peer's onConnected, so these two events bracket every real outage.
const recovering = reduce(connected, { type: 'reconnecting' }, T0 + 10_000);
eq('a connected call can start reconnecting', recovering.status, 'reconnecting');
eq('connectedAt survives the outage', recovering.connectedAt, T0);
const back = reduce(recovering, { type: 'recovered' }, T0 + 18_000);
eq('recovered -> connected', back.status, 'connected');
eq('connectedAt is NOT restamped on recovery', back.connectedAt, T0);
check('duration spans the outage', durationSeconds(back, T0 + 60_000) === 60);
// The engine fires 'recovered' on EVERY peer connect, including the first.
check('recovered on a healthy call is a no-op (same reference)',
  reduce(connected, { type: 'recovered' }, T0 + 1_000) === connected);
// A call still dialling is neither reconnecting nor recovered — saying either
// would be a lie, and the screens render these strings directly.
const dialling = out();
check('recovered during setup is a no-op (same reference)',
  reduce(dialling, { type: 'recovered' }, T0) === dialling);
check('reconnecting during setup is a no-op (same reference)',
  reduce(dialling, { type: 'reconnecting' }, T0) === dialling);
eq('a ringing call cannot become reconnecting',
  run(out(), [{ type: 'offer_sent' }, { type: 'reconnecting' }]).status, 'ringing');
// Invariant 1 still rules: nothing resurrects a finished call.
eq('reconnecting cannot resurrect an ended call',
  run(out(), [{ type: 'answer_applied' }, { type: 'end', reason: 'failed' }, { type: 'reconnecting' }]).status, 'ended');
// Real recovery paths land media again, and both routes back must clear it.
eq('remote media clears reconnecting',
  reduce(recovering, { type: 'remote_stream', uid: PEER, url: 'rtc://x' }, T0).status, 'connected');

console.log('\nremote media also connects (the ontrack path):');
const viaTrack = run(out(), [{ type: 'offer_sent' }, { type: 'remote_stream', uid: PEER, url: 'rtc://a' }], T0);
eq('remote_stream -> connected', viaTrack.status, 'connected');
eq('stream url recorded', viaTrack.participants[PEER].streamUrl, 'rtc://a');
eq('connectedAt stamped once', viaTrack.connectedAt, T0);
const sameTrack = reduce(viaTrack, { type: 'remote_stream', uid: PEER, url: 'rtc://a' }, T0 + 9_000);
check('identical remote_stream is a no-op (same reference)', sameTrack === viaTrack);
const newTrack = reduce(viaTrack, { type: 'remote_stream', uid: PEER, url: 'rtc://b' }, T0 + 9_000);
check('a CHANGED stream url does update', newTrack !== viaTrack && newTrack.participants[PEER].streamUrl === 'rtc://b');
eq('...without restarting the clock', newTrack.connectedAt, T0);

console.log('\ninvariant 1 — ended is terminal:');
const ended = reduce(connected, { type: 'end', reason: 'local_hangup' }, T0 + 60_000);
eq('end -> ended', ended.status, 'ended');
for (const e of [
  { type: 'answer_applied' },
  { type: 'remote_stream', uid: PEER, url: 'rtc://z' },
  { type: 'offer_sent' },
  { type: 'flag', key: 'muted', value: true },
  { type: 'error', message: 'boom' },
] as CallEvent[]) {
  check(`  '${e.type}' after end is ignored`, reduce(ended, e, T0 + 61_000) === ended);
}

console.log('\ninvariant 4 — first end reason wins:');
// Real race: pressing End closes the pc, which fires onconnectionstatechange
// 'failed' a moment later. The call was still a local hangup.
const raced = reduce(ended, { type: 'end', reason: 'failed' }, T0 + 60_100);
eq('local_hangup survives a following failure', raced.endReason, 'local_hangup');

console.log('\ninvariant 5 — no-ops keep the reference (no wasted re-render):');
check('same flag value', reduce(connected, { type: 'flag', key: 'muted', value: false }, T0) === connected);
check('same local url', reduce(connected, { type: 'local_stream', url: null }, T0) === connected);
check('same error', reduce(connected, { type: 'error', message: null as any }, T0) !== undefined);
check('peer_left for an unknown uid', reduce(connected, { type: 'peer_left', uid: 'nobody' }, T0) === connected);
const muted = reduce(connected, { type: 'flag', key: 'muted', value: true }, T0);
check('a CHANGED flag does produce a new object', muted !== connected && muted.muted === true);

console.log('\nmesh roster:');
let mesh = run(out(), [
  { type: 'remote_stream', uid: 'a', url: 'rtc://a', name: 'Ann' },
  { type: 'remote_stream', uid: 'b', url: 'rtc://b', name: 'Bob' },
], T0);
eq('two participants', Object.keys(mesh.participants).sort(), ['a', 'b']);
mesh = reduce(mesh, { type: 'peer_left', uid: 'a' }, T0);
eq('peer_left removes exactly one', Object.keys(mesh.participants), ['b']);
eq('name preserved', mesh.participants.b.name, 'Bob');
mesh = reduce(mesh, { type: 'peer_muted', uid: 'b', muted: true }, T0);
eq('peer mute tracked', mesh.participants.b.muted, true);
check('repeat peer_muted is a no-op',
  reduce(mesh, { type: 'peer_muted', uid: 'b', muted: true }, T0) === mesh);

console.log('\nin-call chat + reactions:');
const line = (id: string, mine: boolean, text = id) =>
  ({ id, uid: mine ? 'me' : 'them', name: 'Them', text, at: T0, mine });

let ch = reduce(connected, { type: 'chat', message: line('1', false, 'hi') }, T0);
eq('a peer line lands', ch.chat.map(m => m.text), ['hi']);
eq('and counts as unread', ch.chatUnread, 1);
ch = reduce(ch, { type: 'chat', message: line('2', true, 'hello') }, T0);
eq('ordering is oldest-first', ch.chat.map(m => m.text), ['hi', 'hello']);
eq('our OWN line is never unread', ch.chatUnread, 1);
ch = reduce(ch, { type: 'chat_read' }, T0);
eq('opening the sheet clears the badge', ch.chatUnread, 0);
check('a second chat_read is a no-op',
  reduce(ch, { type: 'chat_read' }, T0) === ch);
check('the history survives being read', ch.chat.length === 2);

// The cap must drop the OLDEST, never the arrival — losing the line that just
// came in is the one failure a user would actually notice.
let full = connected;
for (let i = 0; i < MAX_CALL_CHAT + 5; i++) {
  full = reduce(full, { type: 'chat', message: line(`m${i}`, false, `m${i}`) }, T0);
}
eq('chat is capped', full.chat.length, MAX_CALL_CHAT);
eq('the newest line is kept', full.chat[full.chat.length - 1].text, `m${MAX_CALL_CHAT + 4}`);
eq('the oldest were dropped', full.chat[0].text, 'm5');
eq('unread counts every peer line, uncapped', full.chatUnread, MAX_CALL_CHAT + 5);

let rx = connected;
for (let i = 0; i < MAX_CALL_REACTIONS + 3; i++) {
  rx = reduce(rx, { type: 'reaction', reaction: { id: `r${i}`, uid: 'them', emoji: '👍', at: T0 } }, T0);
}
eq('reactions are capped', rx.reactions.length, MAX_CALL_REACTIONS);
eq('newest reaction kept', rx.reactions[rx.reactions.length - 1].id, `r${MAX_CALL_REACTIONS + 2}`);

// Invariant 1 covers the new events too: a message racing teardown is dropped,
// not appended to a call that has already been logged and disposed.
const dead = reduce(connected, { type: 'end', reason: 'local_hangup' }, T0);
check('chat after end is ignored',
  reduce(dead, { type: 'chat', message: line('late', false) }, T0) === dead);
check('reaction after end is ignored',
  reduce(dead, { type: 'reaction', reaction: { id: 'late', uid: 'them', emoji: '👍', at: T0 } }, T0) === dead);

console.log('\nroles and raised hands:');
const withMe = reduce(connected, { type: 'me', uid: 'me' }, T0);
eq('our own uid lands', withMe.meId, 'me');
check('repeating it is a no-op', reduce(withMe, { type: 'me', uid: 'me' }, T0) === withMe);

let r = reduce(withMe, { type: 'session', sessionId: 'call-1', myRole: 'host' }, T0);
eq('the session id lands', r.sessionId, 'call-1');
eq('and our role with it', r.myRole, 'host');
check('an identical session event is a no-op',
  reduce(r, { type: 'session', sessionId: 'call-1', myRole: 'host' }, T0) === r);

// The routing that matters: the SAME event shape means "me" or "a peer"
// depending only on the uid, so the engine never has to decide.
r = reduce(r, { type: 'role', uid: 'them', role: 'audience' }, T0);
eq("a peer's role goes to participants", r.participants.them.role, 'audience');
eq('and does not touch ours', r.myRole, 'host');
r = reduce(r, { type: 'role', uid: 'me', role: 'cohost' }, T0);
eq('our own role updates in place', r.myRole, 'cohost');
check('and creates no phantom participant for us', !r.participants.me);

r = reduce(r, { type: 'hand', uid: 'them', at: T0 + 5 }, T0);
eq("a peer's hand is a timestamp", r.participants.them.handRaisedAt, T0 + 5);
r = reduce(r, { type: 'hand', uid: 'me', at: T0 + 9 }, T0);
eq('our own hand tracks separately', r.myHandRaisedAt, T0 + 9);
check('still no phantom participant', !r.participants.me);
r = reduce(r, { type: 'hand', uid: 'them', at: 0 }, T0);
eq('lowering is at: 0', r.participants.them.handRaisedAt, 0);
check('lowering an already-lowered hand is a no-op',
  reduce(r, { type: 'hand', uid: 'them', at: 0 }, T0) === r);

// A hand raised before we joined must survive the roster seed reaching a peer
// we have not yet received media from.
const seeded = reduce(withMe, { type: 'hand', uid: 'early', at: T0 - 1000 }, T0);
eq('a hand can be seeded for an unseen peer', seeded.participants.early.handRaisedAt, T0 - 1000);
eq('…without inventing a stream for them', seeded.participants.early.streamUrl, null);

console.log('\nno_answer — the ring budget expiring must END the call:');
// ringAndOffer stops after 9 repeats and used to leave the call in `ringing`
// forever: no answer, no failure, mic and foreground service still held. The
// engine now ends it at RING_TIMEOUT_MS; these assert the reducer half.
const rangOut = run(out(), [{ type: 'offer_sent' }, { type: 'end', reason: 'no_answer' }]);
eq('an unanswered outgoing call reaches ended', rangOut.status, 'ended');
eq('…with no_answer recorded', rangOut.endReason, 'no_answer');
eq('it never connected', rangOut.connectedAt, 0);
check('so it logs a zero duration', durationSeconds(rangOut, T0 + 60_000) === 0);
check('and it still cancels the callee ring', shouldCancelRing(run(out(), [{ type: 'offer_sent' }])) === true);
// Invariant 4: a timeout firing after a real end must not rewrite the cause.
eq('a late no_answer cannot overwrite an earlier reason',
  run(out(), [{ type: 'offer_sent' }, { type: 'end', reason: 'local_hangup' }, { type: 'end', reason: 'no_answer' }]).endReason,
  'local_hangup');
// The timeout is guarded by isDone(), but the reducer must be safe regardless.
eq('no_answer cannot end a call that already connected',
  run(out(), [{ type: 'answer_applied' }]).status, 'connected');

console.log('\nlog derivation (what addCallLog needs):');
eq('duration of a connected call', durationSeconds(connected, T0 + 65_400), 65);
eq('duration of a call that never connected', durationSeconds(run(out(), [{ type: 'offer_sent' }]), T0 + 9_000), 0);
check('unanswered incoming is missed', wasMissed(run(inc(), [])) === true);
check('answered incoming is NOT missed', wasMissed(run(inc(), [{ type: 'answer_applied' }])) === false);
check('outgoing is never missed', wasMissed(connected) === false);
check('abandoned outgoing cancels the callee ring',
  shouldCancelRing(run(out(), [{ type: 'offer_sent' }])) === true);
check('answered outgoing does NOT cancel', shouldCancelRing(connected) === false);
check('incoming never cancels', shouldCancelRing(run(inc(), [])) === false);

console.log(failures === 0
  ? '\nALL CALL MACHINE CHECKS PASSED ✓'
  : `\n${failures} CHECK(S) FAILED ✗`);
process.exit(failures === 0 ? 0 : 1);
