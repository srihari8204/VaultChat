// lib/pushRegistration.selftest.ts — the call doorbell must never fail silently.
//
// WHY THIS EXISTS
// ---------------
// registerForCalls() swallowed every failure behind `if (__DEV__)`, so in a
// release build a device that could not register for push produced no log, no
// retry and no user-visible sign — and then never rang for a call while killed
// or dozing. The failure and its consequence were both invisible.
//
// The retry logic that replaces it has one way to be catastrophically wrong:
// retrying a PERMANENT condition. A device with no Google Play Services can
// never issue a token, so a `no_provider` retry loop would wake the CPU to fail
// identically forever — turning a missing doorbell into a battery drain, on
// exactly the devices whose users already complain about battery.
//
// The mirror mistake is just as bad: NOT retrying a transient failure puts back
// the one-shot behaviour this replaced, where booting without network cost you
// push for the entire session.
//
// Those two, plus the backoff bound, are what this pins down. CallService.ts
// cannot be imported here (react-native), which is why the classification and
// the schedule live in a dependency-free module.

import {
  PUSH_RETRY_LIMIT, canWakeForCalls, pushRetryDelayMs, pushWarningText,
  shouldReregister, shouldRetryPush, pushTokenFailureOutcome, type PushOutcome,
} from './pushRegistration';

let failures = 0;
function check(name: string, ok: boolean, detail?: string) {
  if (!ok) failures++;
  console.log(`  ${ok ? '✓' : '✗'} ${name}${ok || !detail ? '' : `  (${detail})`}`);
}

const ALL: PushOutcome[] = ['ok', 'no_platform', 'no_provider', 'not_signed_in', 'transient'];

check('Firebase network outage is retryable', pushTokenFailureOutcome(new Error('SERVICE_NOT_AVAILABLE')) === 'transient');
check('Firebase unknown bridge failure is retryable', pushTokenFailureOutcome({ code: 'fcm_token' }) === 'transient');
check('explicit missing provider does not retry', pushTokenFailureOutcome(new Error('java.io.IOException: MISSING_INSTANCEID_SERVICE')) === 'no_provider');

console.log('what gets retried — and what must never be:');
check('a transient failure IS retried', shouldRetryPush('transient', 0));
// The whole point. A device with no Play Services cannot ever produce a token.
check('no_provider is NOT retried',
  !shouldRetryPush('no_provider', 0),
  'a device with no push provider would spin forever, draining the battery');
check('not_signed_in is NOT retried',
  !shouldRetryPush('not_signed_in', 0),
  'sign-in re-runs registration; a timer racing it is waste');
check('success is NOT retried', !shouldRetryPush('ok', 0));
check('no_platform is NOT retried', !shouldRetryPush('no_platform', 0));
// Guard the whole enum, so a future outcome cannot silently join the retry set.
check('ONLY transient is ever retried',
  ALL.filter(o => shouldRetryPush(o, 0)).join(',') === 'transient');

console.log('\nthe retry loop terminates:');
check(`transient stops after ${PUSH_RETRY_LIMIT} attempts`,
  shouldRetryPush('transient', PUSH_RETRY_LIMIT - 1) && !shouldRetryPush('transient', PUSH_RETRY_LIMIT));
{
  // Walk the real loop shape from CallService.registerForCalls, with every
  // attempt failing, and prove it exits.
  let attempts = 0;
  for (let attempt = 0; ; attempt++) {
    attempts++;
    if (!shouldRetryPush('transient', attempt)) break;
    if (attempts > 50) break;                     // would hang in production
  }
  check('an always-failing transient loop exits',
    attempts === PUSH_RETRY_LIMIT + 1, `ran ${attempts} attempts`);
}
{
  // And that a permanent failure costs exactly one attempt.
  let attempts = 0;
  for (let attempt = 0; ; attempt++) {
    attempts++;
    if (!shouldRetryPush('no_provider', attempt)) break;
    if (attempts > 50) break;
  }
  check('a no-provider device attempts exactly once', attempts === 1, `ran ${attempts}`);
}

console.log('\nthe backoff is bounded:');
check('the first retry waits 2s', pushRetryDelayMs(1) === 2_000, String(pushRetryDelayMs(1)));
check('it grows', pushRetryDelayMs(2) > pushRetryDelayMs(1) && pushRetryDelayMs(3) > pushRetryDelayMs(2));
check('and is capped at 30s', pushRetryDelayMs(50) === 30_000, String(pushRetryDelayMs(50)));
check('a zero/negative attempt does not wait', pushRetryDelayMs(0) === 0 && pushRetryDelayMs(-3) === 0);
{
  // This runs at app start against a network that is still coming up. The whole
  // schedule has to finish inside the window a user keeps the app open.
  let total = 0;
  for (let i = 1; i <= PUSH_RETRY_LIMIT; i++) total += pushRetryDelayMs(i);
  check(`the whole schedule finishes within 60s (${total / 1000}s)`, total <= 60_000, `${total}ms`);
}

console.log('\nwhat the user is told:');
check('a registered device can be woken', canWakeForCalls('ok'));
check('…and every other outcome cannot',
  ALL.filter(o => o !== 'ok').every(o => !canWakeForCalls(o)));
check('an unknown/never-run state is not claimed as wakeable', !canWakeForCalls(null));
check('no_provider explains itself in plain language',
  (pushWarningText('no_provider') ?? '').includes('Google Play Services'));
check('…and says what the user can DO about it',
  (pushWarningText('no_provider') ?? '').toLowerCase().includes('keep the app open'));
check('a healthy device is not nagged', pushWarningText('ok') === null);
check('Expo Go / web is not nagged', pushWarningText('no_platform') === null);
check('signed-out is not nagged — signing in fixes it', pushWarningText('not_signed_in') === null);
// A warning that named a vendor as the culprit would be both wrong and
// inflammatory: on most of these devices it is a configuration fact, not a fault.
check('no warning blames a phone manufacturer',
  ALL.every(o => !/huawei|honor|xiaomi|samsung|oppo|vivo/i.test(pushWarningText(o) ?? '')));

console.log('\nre-registration — the token-rotation hole:');
// FCM rotates tokens on reinstall, data clear, restore and expiry. The native
// onNewToken handler stored the new one and NOTHING ever POSTed it, because JS
// registered exactly once at boot. The server kept addressing a dead token and
// the phone stopped ringing while killed, silently, until the next cold start.
check('a rotated token forces re-registration',
  shouldReregister({ token: 'old-token', outcome: 'ok' }, 'new-token'),
  'this is the missed-calls-after-reinstall case');
check('an unchanged token on a healthy device does NOT re-POST',
  !shouldReregister({ token: 'same-token', outcome: 'ok' }, 'same-token'),
  'would fire a request on every single foreground');
check('a previous transient failure retries on next foreground',
  shouldReregister({ token: 'tok', outcome: 'transient' }, 'tok'),
  'covers "booted with no network"');
check('a previous not_signed_in retries once signed in',
  shouldReregister({ token: 'tok', outcome: 'not_signed_in' }, 'tok'));
check('a never-registered device registers',
  shouldReregister({ token: null, outcome: null }, 'first-token'));
// A no-provider device has no token to compare, so it must not spin here either.
check('no token at all means nothing to do',
  !shouldReregister({ token: null, outcome: null }, null)
  && !shouldReregister({ token: 'tok', outcome: 'ok' }, null));
check('…even when the last outcome was a failure',
  !shouldReregister({ token: null, outcome: 'no_provider' }, null),
  'a device with no push provider must never loop');

console.log(failures === 0
  ? '\nALL PUSH-REGISTRATION CHECKS PASSED ✓'
  : `\n${failures} CHECK(S) FAILED ✗`);
process.exit(failures === 0 ? 0 : 1);
