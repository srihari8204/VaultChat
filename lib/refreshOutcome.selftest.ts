// lib/refreshOutcome.selftest.ts — run: npx tsx lib/refreshOutcome.selftest.ts
//
// AUDIT F08. Refresh used to answer with a boolean, so "the network is down",
// "the server is deploying" and "this token is revoked" were the same answer —
// and the caller responded to it by deleting the user's credentials and sending
// them to onboarding. One bad minute logged people out.
//
// The rule this locks down: ONLY the server rejecting the refresh token itself
// ends a session. Everything else keeps the credentials.
//
// lib/api.ts imports react-native and expo-router, so it cannot be loaded under
// Node. This tests the decision table by reading the source's own branches —
// enough to catch the regression that matters (a 5xx or a network error being
// classified terminal again), and honest about being a source-level check.

import fs from 'node:fs';
import path from 'node:path';

const SRC = fs.readFileSync(path.join(process.cwd(), 'lib', 'api.ts'), 'utf8');

let failures = 0;
function check(name: string, ok: boolean, detail?: string) {
  if (!ok) failures++;
  console.log(`  ${ok ? '✓' : '✗'} ${name}${ok || !detail ? '' : `  (${detail})`}`);
}

console.log('\nRefresh-outcome self-test\n');

console.log('The three answers exist:');
check("'ok' | 'terminal' | 'transient' is the return type",
  /RefreshOutcome\s*=\s*'ok'\s*\|\s*'terminal'\s*\|\s*'transient'/.test(SRC));
check('doRefresh returns that type, not a boolean',
  /async function doRefresh\(\): Promise<RefreshOutcome>/.test(SRC));

console.log('\nOnly a rejected token ends the session:');
check('401/403 from /auth/refresh is terminal',
  /res\.status === 401 \|\| res\.status === 403\) return 'terminal'/.test(SRC));
check('any other non-ok status is transient (5xx, 429, 502…)',
  /if \(!res\.ok\) return 'transient'/.test(SRC));
check('a thrown fetch — offline, DNS, TLS, abort — is transient',
  /catch \{\s*\n\s*return 'transient'/.test(SRC));
check('an unparseable 200 is transient, not terminal',
  /accessToken \|\| !data\?\.refreshToken\) return 'transient'/.test(SRC));
check('no refresh token at all is terminal',
  /if \(!refresh\) \{[\s\S]{0,600}?return 'terminal';\s*\n\s*\}/.test(SRC));
// #32: …with exactly one exception. A SEALED session's tokens exist, they are
// just still locked (a deep link or notification beat the unlock screen).
// Terminal there would run endSessionAndBounce → clearTokens → the sealed blob
// is deleted, i.e. a permanent logout. It must be transient + /app-lock.
check('a sealed-but-locked session is transient, not terminal',
  /if \(!refresh\) \{[\s\S]{0,400}?sealedSessionLocked\(\)[\s\S]{0,300}?return 'transient';/.test(SRC));

console.log('\nThe caller acts on the distinction:');
check('transient throws a retryable error instead of ending the session',
  /outcome === 'transient'[\s\S]{0,400}?throw new Error/.test(SRC));
check('only the remaining (terminal) branch clears credentials',
  /\} else \{[\s\S]{0,900}?endSessionAndBounce\(\)/.test(SRC));
check('credentials are NOT cleared on the transient path',
  !/outcome === 'transient'[\s\S]{0,300}?endSessionAndBounce/.test(SRC));

console.log('\nThe bounce never fires on a user who has no session yet:');
// Reported from the device: entering the email OTP threw the user back to the
// landing screen with the form blank. Onboarding has no refresh token, so
// doRefresh answers 'terminal' for any stray authenticated background request,
// and endSessionAndBounce then router.replace('/onboard')'d out from under the
// sign-up flow. Ending a session that never started is always wrong.
check('endSessionAndBounce returns early when there is no session',
  /sessionEndingPromise = \(async \(\) => \{[\s\S]{0,1800}?if \(!\(await hasSession\(\)\)\) \{[\s\S]{0,120}?return;\s*\n\s*\}/.test(SRC));
// Scope the ordering checks to endSessionAndBounce's own body — clearTokens
// appears elsewhere in the file, so a bare indexOf would compare the wrong one.
const BOUNCE = SRC.slice(SRC.indexOf('async function endSessionAndBounce'));
check('...and it checks BEFORE clearing tokens',
  BOUNCE.indexOf('hasSession()') < BOUNCE.indexOf('clearTokens()'));
check('...and before the redirect',
  BOUNCE.indexOf('hasSession()') < BOUNCE.indexOf("resetTo('/onboard')"));
check('a real dead session still clears and bounces',
  /await clearTokens\(\);[\s\S]{0,600}?resetTo\('\/onboard'\)/.test(SRC));
// resetTo, not a bare replace: replace() swaps only the TOP history entry, so a
// forced sign-out left the signed-in stack underneath and BACK re-entered it.
check('the forced sign-out resets the stack, not just the top entry',
  /resetTo\('\/onboard'\)/.test(SRC) && !/router\.replace\('\/onboard' as any\)/.test(SRC));

console.log('\nRefresh cannot hang forever (F09):');
check('the refresh fetch carries an abort signal',
  /body: JSON\.stringify\(\{ refreshToken: refresh \}\),\s*\n\s*signal: ctl\.signal,/.test(SRC));
check('...driven by a bounded timeout',
  /REFRESH_TIMEOUT_MS/.test(SRC) && /setTimeout\(\(\) => ctl\.abort\(\), REFRESH_TIMEOUT_MS\)/.test(SRC));
check('the timer is always cleared',
  /finally \{\s*\n\s*clearTimeout\(timer\);/.test(SRC));

console.log(failures ? `\n  ${failures} FAILED\n` : '\n  all refresh-outcome checks passed\n');
process.exit(failures ? 1 : 0);
