// lib/sessionEnded.selftest.ts — run: npx tsx lib/sessionEnded.selftest.ts
//
// AUDIT F09. The last open finding of the 2026-09-08 audit, and the one with a
// genuine trap in it: the fix suppresses a dialog, so getting it slightly wrong
// means real errors stop reaching the user and nothing looks broken.
//
// Two halves are tested differently:
//   - the predicates are pure, so they run for real here;
//   - the wiring (api.ts rejects with it, _layout installs the boundary) is
//     checked by reading the source, because both files import react-native.

import fs from 'node:fs';
import path from 'node:path';

import { SESSION_ENDED_MESSAGE, SessionEndedError, isSessionEnded, isSessionEndedText } from './sessionEnded';

let failures = 0;
function check(name: string, ok: boolean, detail?: string) {
  if (!ok) failures++;
  console.log(`  ${ok ? '✓' : '✗'} ${name}${ok || !detail ? '' : `  (${detail})`}`);
}
const read = (p: string) => fs.readFileSync(path.join(process.cwd(), p), 'utf8');

console.log('\nSession-ended self-test\n');

console.log('The error identifies itself:');
check('a SessionEndedError is recognised', isSessionEnded(new SessionEndedError()));
check('so is a plain object carrying the marker — it survives serialisation',
  isSessionEnded({ code: 'VAULTCHAT_SESSION_ENDED' }));
check('an ordinary Error is not', !isSessionEnded(new Error('Payment failed')));
check('null/undefined are not', !isSessionEnded(null) && !isSessionEnded(undefined));
check('a string is not — only the text predicate accepts text',
  !isSessionEnded(SESSION_ENDED_MESSAGE));
check('an error with a DIFFERENT code is not', !isSessionEnded({ code: 'ERR_NETWORK' }));

console.log('\nThe alert boundary suppresses exactly one message:');
check('the session-ended message is suppressed', isSessionEndedText(SESSION_ENDED_MESSAGE));
check('surrounding whitespace still matches', isSessionEndedText(`  ${SESSION_ENDED_MESSAGE} `));
// These are the ones that matter. A looser predicate would swallow them, and a
// swallowed error is a screen that silently did nothing.
for (const real of [
  'Network unavailable — check your connection and try again.',
  'Your session ended because this device was signed out remotely.',
  'Session expired',
  'Please sign in again to continue',
  'Payment failed',
  '',
]) {
  check(`a real error is NOT suppressed: ${JSON.stringify(real)}`, !isSessionEndedText(real));
}
check('undefined is not suppressed — Alert.alert(title) with no message',
  !isSessionEndedText(undefined));

console.log('\nThe wiring is in place:');
const API = read('lib/api.ts');
check('api() rejects a dead session with the typed error',
  /throw new SessionEndedError\(\)/.test(API));
check('it no longer returns a promise that never settles',
  !/return new Promise<T>\(\(\) => \{\}\)/.test(API),
  'the never-settling promise is back; finally blocks will not run');
check('the redirect still happens before the throw',
  /await endSessionAndBounce\(opts.expectedUserId\);[\s\S]*?throw new SessionEndedError\(\)/.test(API));

const ALERT = read('lib/alertGuard.ts');
check('the boundary is idempotent', /if \(installed\) return;/.test(ALERT));
check('it checks both message and title', /isSessionEndedText\(message\)/.test(ALERT) && /isSessionEndedText\(title\)/.test(ALERT));
check('it forwards everything else untouched',
  /original\(title, message, buttons, options\)/.test(ALERT));

const LAYOUT = read('app/_layout.tsx');
check('the boundary is installed at module scope, not inside an effect',
  /^installAlertGuard\(\);$/m.test(LAYOUT),
  'a request can fail before the first render');
check('Sentry drops session-ended events instead of filing them as crashes',
  /beforeSend:.*isSessionEnded\(hint\?\.originalException\)/.test(LAYOUT));

console.log(failures === 0 ? '\nAll session-ended checks passed.\n' : `\n${failures} check(s) FAILED.\n`);
process.exit(failures === 0 ? 0 : 1);
