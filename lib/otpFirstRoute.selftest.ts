// lib/otpFirstRoute.selftest.ts — run: npx tsx lib/otpFirstRoute.selftest.ts
//
// Sign-in runs the SMS code first for every number (R4BE C15), then routes on
// what the server said — and keeps working against a server that says nothing.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { afterLookup, afterOtp, needsFreshOtp } from './otpFirstRoute';

// 1. A C15 server answers on the verify call.
assert.deepEqual(afterOtp({ ok: true, exists: true, userId: 'u1' } as any), { to: 'mpin', userId: 'u1' });
assert.deepEqual(afterOtp({ exists: false }), { to: 'signup' });
// 2. Today's server (no `exists`), a DB hiccup (omitted), or a half answer → ask lookup.
assert.deepEqual(afterOtp({}), { to: 'lookup' });
assert.deepEqual(afterOtp(null), { to: 'lookup' });
assert.deepEqual(afterOtp({ exists: true }), { to: 'lookup' });
assert.deepEqual(afterOtp({ exists: true, userId: '' }), { to: 'lookup' });

// 3. Lookup, as before, but sent with the ticket.
assert.deepEqual(afterLookup({ exists: true, userId: 'u2' }), { to: 'mpin', userId: 'u2' });
assert.deepEqual(afterLookup({ exists: false }), { to: 'signup' });
assert.deepEqual(afterLookup({ exists: false, conflict: 'phone' }), { to: 'conflict' });
// exists without a userId is the otpRequired answer: the ticket did not count. Never sign up over it.
assert.deepEqual(afterLookup({ exists: true, otpRequired: true } as any), { to: 'error' });

// 4. Wiring: the landing sends the code for every number (no lookup before the
// OTP), and the MPIN / recovery calls carry the proof.
const LANDING = readFileSync('app/onboard.tsx', 'utf8');
assert.ok(/sendPhoneOtp\(e164\)/.test(LANDING) && !/lookupUser\(/.test(LANDING), 'landing must not look up before the OTP');
const ONB = readFileSync('lib/onboarding.ts', 'utf8');
for (const fn of ['verifyMpinRemote', 'getRecoveryQuestions', 'verifyRecoveryAnswers']) {
  const body = ONB.slice(ONB.indexOf(`export async function ${fn}`));
  assert.ok(/possession(Headers|Ticket)\(/.test(body.slice(0, body.indexOf('\n}\n'))), `${fn} must carry the possession proof`);
}

// 5. An expired or missing ticket (403 otp_required, lib/api's error shape) is
// told apart from a wrong MPIN, a lockout and an offline failure.
assert.equal(needsFreshOtp({ status: 403, body: { error: { code: 'otp_required' } } }), true);
assert.equal(needsFreshOtp({ status: 401, body: { error: { code: 'invalid_mpin' } } }), false);
assert.equal(needsFreshOtp({ status: 403, body: { error: { code: 'forbidden' } } }), false);
assert.equal(needsFreshOtp({ status: 403, body: { error: 'otp_required' } }), false);
assert.equal(needsFreshOtp(new TypeError('Network request failed')), false);
assert.equal(needsFreshOtp(null), false);
// …and the three screens that can meet it route it back to the number step.
for (const f of ['app/mpin-entry.tsx', 'app/mpin-recover.tsx', 'app/onboard-success.tsx']) {
  assert.ok(/needsFreshOtp\(e\)/.test(readFileSync(f, 'utf8')), `${f} must map otp_required`);
}

console.log('otpFirstRoute selftest: ok');
