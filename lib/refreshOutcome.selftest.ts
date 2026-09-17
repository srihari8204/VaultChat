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
//
// 2026-09-17, second pass. Mutation proved four ways this file lied:
//
//   • /purgeAccountData()/ — `()` is an EMPTY CAPTURE GROUP, so the regex was
//     really /purgeAccountData/ and was satisfied by an import, or by the
//     comment above the call explaining what it does. Same bug in
//     /catch {[^}]*clearTokens()/. Every call is now written \(\).
//   • Nothing was stripped, so a COMMENT could satisfy a structural check. The
//     comment block inside endSessionAndBounce names both purgeAccountData()
//     and clearTokens(); deleting the calls left the guard green. CODE below is
//     comment-free.
//   • BOUNCE was SRC.slice(indexOf(header)) — to the END OF FILE. A later
//     function's clearTokens() or resetTo('/onboard') satisfied the ordering
//     checks for a body that no longer contained either. Now bounded.
//   • a.indexOf(X) < a.indexOf(Y) is TRUE when X is ABSENT, because -1 is less
//     than everything. Deleting the thing being ordered PASSED the ordering
//     check. before() below requires both ends to exist.
//
// Two checks that measured comment volume rather than behaviour (a negative
// regex with a {0,300} window that only held because a comment padded it out)
// are now branch extractions instead.

import fs from 'node:fs';
import path from 'node:path';

const SRC = fs.readFileSync(path.join(process.cwd(), 'lib', 'api.ts'), 'utf8');
/** Comments carry no behaviour, and this file's job is behaviour. */
const CODE = SRC.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');

let failures = 0;
function check(name: string, ok: boolean, detail?: string) {
  if (!ok) failures++;
  console.log(`  ${ok ? '✓' : '✗'} ${name}${ok || !detail ? '' : `  (${detail})`}`);
}
/** A top-level declaration's own text, ending at its column-0 closing brace.
 *  Slicing to end-of-file is what let a neighbouring function answer for it. */
function topLevelFn(src: string, header: string): string {
  const i = src.indexOf(header);
  if (i === -1) throw new Error(`refreshOutcome.selftest: ${header} is gone from lib/api.ts`);
  const j = src.indexOf('\n}', i);
  if (j === -1) throw new Error(`refreshOutcome.selftest: no end found for ${header}`);
  return src.slice(i, j);
}
/** From the first `{` at/after `from`, through its matching `}`. */
function blockAt(src: string, from: number): string {
  if (from === -1) throw new Error('refreshOutcome.selftest: block anchor not found');
  const open = src.indexOf('{', from);
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}' && --depth === 0) return src.slice(open, i + 1);
  }
  throw new Error('refreshOutcome.selftest: unbalanced braces');
}
/** X comes before Y, AND BOTH ARE THERE. indexOf returns -1 for a missing
 *  needle and -1 < anything, so the bare comparison passed loudest exactly when
 *  the thing it was ordering had been deleted. */
function before(hay: string, a: string, b: string): [boolean, string] {
  const i = hay.indexOf(a), j = hay.indexOf(b);
  if (i === -1) return [false, `${a} is missing entirely`];
  if (j === -1) return [false, `${b} is missing entirely`];
  return [i < j, `${a} @${i} vs ${b} @${j}`];
}
const order = (name: string, hay: string, a: string, b: string) => {
  const [ok, detail] = before(hay, a, b);
  check(name, ok, detail);
};

const DOREFRESH = topLevelFn(CODE, 'async function doRefresh');
const BOUNCE = topLevelFn(CODE, 'async function endSessionAndBounce');
const API = topLevelFn(CODE, 'export async function api');

console.log('\nRefresh-outcome self-test\n');

console.log('The three answers exist:');
check("'ok' | 'terminal' | 'transient' is the return type",
  /RefreshOutcome\s*=\s*'ok'\s*\|\s*'terminal'\s*\|\s*'transient'/.test(CODE));
check('doRefresh returns that type, not a boolean',
  /async function doRefresh\(\): Promise<RefreshOutcome>/.test(CODE));

console.log('\nOnly a rejected token ends the session:');
check('401/403 from /auth/refresh is terminal',
  /res\.status === 401 \|\| res\.status === 403\) return 'terminal'/.test(DOREFRESH));
check('any other non-ok status is transient (5xx, 429, 502…)',
  /if \(!res\.ok\) return 'transient'/.test(DOREFRESH));
check('a thrown fetch — offline, DNS, TLS, abort — is transient',
  /catch \{\s*\n\s*return 'transient'/.test(DOREFRESH));
check('an unparseable 200 is transient, not terminal',
  /accessToken \|\| !data\?\.refreshToken\) return 'transient'/.test(DOREFRESH));
// #32: …with exactly one exception. A SEALED session's tokens exist, they are
// just still locked (a deep link or notification beat the unlock screen).
// Terminal there would run endSessionAndBounce → the full purge, i.e. a
// permanent logout. It must be transient + /app-lock.
const NO_REFRESH = blockAt(DOREFRESH, DOREFRESH.indexOf('if (!refresh)'));
check('no refresh token at all is terminal', /return 'terminal';/.test(NO_REFRESH));
check('a sealed-but-locked session is transient, not terminal',
  /sealedSessionLocked\(\)/.test(NO_REFRESH) && /return 'transient';/.test(NO_REFRESH));
order('...and the sealed test is reached BEFORE the terminal answer',
  NO_REFRESH, 'sealedSessionLocked()', "return 'terminal';");

console.log('\nThe caller acts on the distinction:');
// Extracted as BRANCHES, not as a character-distance window. The window version
// only passed because a comment sat inside it: strip the comments and
// "endSessionAndBounce is more than 300 chars from 'transient'" became false on
// correct code. A distance is not a property; a branch body is.
const TRANSIENT = blockAt(API, API.indexOf("outcome === 'transient'"));
check('transient throws a retryable error instead of ending the session',
  /throw new Error/.test(TRANSIENT));
check('credentials are NOT cleared on the transient path',
  !/endSessionAndBounce/.test(TRANSIENT) && !/clearTokens/.test(TRANSIENT) && !/purgeAccountData/.test(TRANSIENT));
const TERMINAL = blockAt(API, API.indexOf('} else {', API.indexOf("outcome === 'transient'")));
// Called, and called WITH AN OWNER. Naming the argument `opts.expectedUserId`
// verbatim was the same byte-matching mistake as everywhere else in this file:
// it broke the moment the caller started falling back to the token's own `sub`
// (2026-09-17). What matters is that an id is passed at all — a bare
// endSessionAndBounce() purges whichever account happens to be signed in now.
check('only the remaining (terminal) branch clears credentials',
  /endSessionAndBounce\(\s*[^)\s]/.test(TERMINAL));

console.log('\nThe bounce never fires on a user who has no session yet:');
// Reported from the device: entering the email OTP threw the user back to the
// landing screen with the form blank. Onboarding has no refresh token, so
// doRefresh answers 'terminal' for any stray authenticated background request,
// and endSessionAndBounce then router.replace('/onboard')'d out from under the
// sign-up flow. Ending a session that never started is always wrong.
check('endSessionAndBounce returns early when there is no session',
  /if \(!\(await hasSession\(\)\)\) \{[\s\S]{0,120}?return;\s*\n\s*\}/.test(BOUNCE));
order('...and it checks BEFORE clearing tokens', BOUNCE, 'hasSession()', 'clearTokens()');
order('...and before the redirect', BOUNCE, 'hasSession()', "resetTo('/onboard')");
// A dead session now takes the FULL purge, not just a token clear (2026-09-17).
// This check used to match /await clearTokens(); ... resetTo/ verbatim, which
// pinned it to the weaker implementation: endSessionAndBounce landed the user
// on /onboard - a screen where SOMEBODY ELSE signs in - with the previous
// account's message database, media, PIN record and E2EE identity still on
// disk. Assert the stronger contract instead: purge, keep a token-clearing
// fallback if the purge cannot be reached, and only then bounce.
check('a real dead session takes the full account purge',
  /purgeAccountData\(\)/.test(BOUNCE));
check('...with a token-clearing fallback if the purge is unreachable',
  /catch\s*\{[^}]*clearTokens\(\)/.test(BOUNCE));
// NOT "purge before bounce" any more. lib/api.ts deliberately reversed that on
// 2026-09-17 and says why: the purge is a filesystem sweep plus ~25 SecureStore
// round trips, and while it ran inside sessionEndingPromise every concurrent
// 401 queued behind it and the user sat on a dead signed-in screen. Asserting
// the old order would now be this file failing a considered decision rather
// than catching a regression. The property that survives the reorder is that
// the purge only happens to a session that EXISTED — the same guard the
// redirect is behind, and the one whose absence logged onboarding users out.
order('...and the purge only runs once a session is proven', BOUNCE, 'hasSession()', 'purgeAccountData()');
// resetTo, not a bare replace: replace() swaps only the TOP history entry, so a
// forced sign-out left the signed-in stack underneath and BACK re-entered it.
// The negative half used to name one exact spelling — `'/onboard' as any` — so
// dropping the cast, or switching quotes, or using push(), all slipped past.
check('the forced sign-out resets the stack, not just the top entry',
  /resetTo\(\s*['"`]\/onboard/.test(BOUNCE));
check('...and nothing in lib/api.ts reaches /onboard by push/replace/navigate',
  !/router\s*\.\s*(?:replace|push|navigate)\s*\(\s*['"`]\/onboard/.test(CODE));

console.log('\nRefresh cannot hang forever (F09):');
check('the refresh fetch carries an abort signal',
  /\/auth\/refresh/.test(DOREFRESH) && /signal:\s*ctl\.signal/.test(DOREFRESH));
check('...driven by a bounded timeout',
  /REFRESH_TIMEOUT_MS/.test(DOREFRESH) && /setTimeout\(\(\) => ctl\.abort\(\), REFRESH_TIMEOUT_MS\)/.test(DOREFRESH));
check('the timer is always cleared',
  /finally\s*\{[^}]*clearTimeout\(\s*timer\s*\)/.test(DOREFRESH));

console.log(failures ? `\n  ${failures} FAILED\n` : '\n  all refresh-outcome checks passed\n');
process.exit(failures ? 1 : 0);
