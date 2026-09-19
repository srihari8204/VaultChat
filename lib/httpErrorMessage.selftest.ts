// lib/httpErrorMessage.selftest.ts — the text ~248 Alert.alert call sites show.
//
// Measured on an Honor ELI-NX9 (Android 16) on 2026-09-19: every Spaces screen
// put up a modal whose entire body was "HTTP 404", and one of them blocked
// navigation until it was dismissed. The message came from lib/api.ts's
// `res.statusText || \`HTTP ${res.status}\`` fallback, which is what almost
// every screen renders via `e?.message ?? 'Try again.'`.
//
// This pins the two properties that matter and are easy to regress:
//   1. no status code, HTTP jargon, or raw reason phrase reaches a user;
//   2. statusText is ignored even when the platform supplies one.

// Imported from the standalone module, not from ./api — api.ts pulls in
// react-native, which tsx cannot transform, and this is a pure string function.
import { httpErrorMessage } from './httpErrorMessage';

let failures = 0;
function ok(label: string, cond: boolean, detail?: string) {
  if (!cond) failures++;
  console.log(`  ${cond ? '✓' : '✗'} ${label}${cond || !detail ? '' : `  (${detail})`}`);
}

console.log('httpErrorMessage — what the user actually reads\n');

// 1. Nothing leaks protocol trivia.
const STATUSES = [400, 401, 403, 404, 408, 409, 413, 429, 500, 502, 503, 507, 418, 451];
for (const s of STATUSES) {
  const m = httpErrorMessage(s);
  ok(`${s}: no bare status code`, !new RegExp(`\\b${s}\\b`).test(m), m);
  ok(`${s}: no "HTTP"`, !/HTTP/i.test(m), m);
  ok(`${s}: reads as a sentence`, m.length > 12 && /[.!]$/.test(m), m);
}

// 2. statusText is deliberately ignored — "Not Found" is protocol trivia too,
//    and on RN it is frequently '' anyway, which is what produced "HTTP 404".
ok('statusText does not change the answer',
  httpErrorMessage(404, 'Not Found') === httpErrorMessage(404, '') &&
  httpErrorMessage(404) === httpErrorMessage(404, 'Not Found'),
  `${httpErrorMessage(404, 'Not Found')} vs ${httpErrorMessage(404, '')}`);

// 3. The cases a caller is most likely to branch on stay distinguishable to a
//    PERSON, not just to code — 401 and 403 mean different things to do next.
ok('401 tells them to sign in', /sign in/i.test(httpErrorMessage(401)), httpErrorMessage(401));
ok('403 is about permission', /permission/i.test(httpErrorMessage(403)), httpErrorMessage(403));
ok('413 names the file size', /large/i.test(httpErrorMessage(413)), httpErrorMessage(413));
ok('429 asks them to wait', /wait|too many/i.test(httpErrorMessage(429)), httpErrorMessage(429));
ok('5xx blames the server, not the user', /server/i.test(httpErrorMessage(503)), httpErrorMessage(503));

// 4. The exact shape the Spaces screens hit.
const spaces = `Could not load people\n${httpErrorMessage(404)}`;
ok('the Spaces dialog no longer says "HTTP 404"', !/HTTP 404/.test(spaces), spaces.replace('\n', ' / '));

// 5. Unknown / non-error input still returns something showable rather than
//    undefined — these screens render the string unconditionally.
for (const s of [0, 200, 301, 999]) {
  const m = httpErrorMessage(s);
  ok(`${s}: still a usable string`, typeof m === 'string' && m.length > 0, m);
}

console.log(failures ? `\n${failures} FAILED` : '\nall passed');
process.exit(failures ? 1 : 0);
