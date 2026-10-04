// lib/sosReachCopy.selftest.ts — run: npx tsx lib/sosReachCopy.selftest.ts
import assert from 'node:assert/strict';
import { sosCountdownAnnouncement, sosReachedOf, sosReachText, sosSentAnnouncement, sosSentLine } from './sosReachCopy';

let n = 0;
const ok = (label: string, fn: () => void) => { fn(); n++; console.log('  ok  ' + label); };

ok('today\'s server (no contactsReached) reads as unknown', () => {
  assert.equal(sosReachedOf({ contactsNotified: 3 }), null);
  assert.equal(sosReachedOf(null), null);
  assert.equal(sosReachedOf(undefined), null);
  assert.equal(sosReachedOf({ contactsReached: null }), null, 'pre-migration history rows send null');
  assert.equal(sosReachedOf({ contactsReached: '2' }), null);
  assert.equal(sosReachedOf({ contactsReached: -1 }), null);
});

ok('a numeric contactsReached is used', () => {
  assert.equal(sosReachedOf({ contactsReached: 0 }), 0);
  assert.equal(sosReachedOf({ contactsReached: 2 }), 2);
});

ok('unknown reach only says the alert was sent, never that it was received', () => {
  const t = sosReachText(3, null, true);
  assert.equal(t.line, 'Sent to 3 trusted contacts with your location.');
  assert.equal(t.warn, null);
  assert.ok(!/notified|saw|received/i.test(t.line));
  assert.equal(sosReachText(1, null, false).line, 'Sent to 1 trusted contact.');
});

ok('known reach says how many, and warns about the rest', () => {
  const t = sosReachText(4, 2, false);
  assert.equal(t.line, 'Reached 2 of 4 trusted contacts.');
  assert.match(t.warn ?? '', /^2 could not be reached/);
  assert.equal(sosReachText(2, 2, true).warn, null);
});

ok('reached is never shown above notified', () => {
  assert.equal(sosReachText(2, 5, false).line, 'Reached 2 of 2 trusted contacts.');
});

ok('nobody addressed is said plainly', () => {
  assert.equal(sosReachText(0, null, false).line, 'No trusted contacts were alerted.');
  assert.equal(sosReachText(0, 0, false).warn, null);
});

ok('the Sent face line covers a missing count and nobody addressed', () => {
  assert.equal(sosSentLine(null, null).line, 'Your trusted contacts are being alerted');
  assert.match(sosSentLine(0, null).line, /^No trusted contacts to alert/);
  assert.equal(sosSentLine(3, null).line, 'Sent to 3 trusted contacts.');
  assert.equal(sosSentLine(4, 2).warn, '2 could not be reached (no app, or notifications turned off). Call or text them too.');
});

ok('the announcement says everything the Sent face shows', () => {
  assert.equal(sosSentAnnouncement(false, 3, null, false), 'SOS sent. Sent to 3 trusted contacts.');
  assert.equal(sosSentAnnouncement(true, null, null, true),
    'Test SOS sent. Your trusted contacts are being alerted. Sent without your location.');
  assert.match(sosSentAnnouncement(false, 4, 2, false), /^SOS sent\. Reached 2 of 4 trusted contacts\. 2 could not be reached .* Call or text them too\.$/);
});

ok('the countdown is announced at the start and on each second', () => {
  assert.equal(sosCountdownAnnouncement(false, 5, true), 'SOS sends in 5 seconds. Tap Cancel SOS to stop it.');
  assert.equal(sosCountdownAnnouncement(true, 5, true), 'Test SOS sends in 5 seconds. Tap Cancel SOS to stop it.');
  assert.equal(sosCountdownAnnouncement(false, 3, false), 'SOS in 3 seconds.');
  assert.equal(sosCountdownAnnouncement(false, 1, false), 'SOS in 1 second.');
});

console.log(`sosReachCopy.selftest: ${n} groups passed`);
