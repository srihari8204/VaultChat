// lib/termsPolicy.selftest.ts — run: npx tsx lib/termsPolicy.selftest.ts
//
// AUDIT F10 (second half). A blocking acceptance screen has one catastrophic
// failure mode and one merely annoying one, and they pull in opposite
// directions:
//
//   catastrophic — it appears when it should not, and the user cannot get past
//                  it (offline, an outage, an unconfigured server). The app is
//                  local-first and works offline by design; a screen that
//                  blocks on a failed request breaks that on the one day the
//                  network is bad.
//   annoying     — it fails to appear and an acceptance is recorded a day late.
//
// So every uncertain path answers "not outstanding", and this pins each of
// them by name rather than trusting the happy path to imply them.

import fs from 'node:fs';
import path from 'node:path';

import { termsAreAnUpdate, termsOutstanding } from './termsPolicy';

let failures = 0;
function check(name: string, ok: boolean, detail?: string) {
  if (!ok) failures++;
  console.log(`  ${ok ? '✓' : '✗'} ${name}${ok || !detail ? '' : `  (${detail})`}`);
}
const read = (p: string) => fs.readFileSync(path.join(process.cwd(), p), 'utf8');

console.log('\nTerms-acceptance self-test\n');

console.log('It fails OPEN on every uncertain path:');
check('no answer at all ⇒ not outstanding', !termsOutstanding(null) && !termsOutstanding(undefined),
  'this is the offline and outage case — the user must not be stranded');
check('no version configured ⇒ nobody is asked', !termsOutstanding({ requiredVersion: '' }),
  'an operator who forgot the env var must not blank every user');
check('a null required version ⇒ nobody is asked', !termsOutstanding({ requiredVersion: null }));
check('whitespace is not a version', !termsOutstanding({ requiredVersion: '   ' }));

console.log('\nIt asks when, and only when, there is something to accept:');
check('never accepted ⇒ outstanding', termsOutstanding({ requiredVersion: '1' }));
check('accepted the current version ⇒ not outstanding',
  !termsOutstanding({ requiredVersion: '1', acceptedVersion: '1' }));
check('accepted an older version ⇒ outstanding',
  termsOutstanding({ requiredVersion: '2', acceptedVersion: '1' }));
check('surrounding whitespace does not cause a re-prompt',
  !termsOutstanding({ requiredVersion: ' 1 ', acceptedVersion: '1' }),
  'a stray space in an env var would re-prompt every user on every launch');

console.log('\nVersions are opaque labels compared for EQUALITY, never ordering:');
// "2026-09" and "1.1" are both reasonable labels. Anything that tried to decide
// which is "newer" would be wrong for most labels a person would pick.
check('a date-shaped label works', !termsOutstanding({ requiredVersion: '2026-09', acceptedVersion: '2026-09' }));
check('a different date-shaped label is outstanding',
  termsOutstanding({ requiredVersion: '2026-10', acceptedVersion: '2026-09' }));
check('an EARLIER label still counts as a change, not a downgrade to ignore',
  termsOutstanding({ requiredVersion: '2026-08', acceptedVersion: '2026-09' }),
  'the server decides what is in force; the client does not second-guess it');

console.log('\nFirst acceptance and a change are told apart:');
check('never accepted is not an update', !termsAreAnUpdate({ requiredVersion: '2' }));
check('previously accepted is an update', termsAreAnUpdate({ requiredVersion: '2', acceptedVersion: '1' }));
check('an empty accepted version is not an update', !termsAreAnUpdate({ acceptedVersion: '' }));

console.log('\nThe wiring is in place:');
const TERMS = read('lib/terms.ts');
check('the client does not ask while signed out', /hasSession\(\)/.test(TERMS),
  'calling an authed endpoint signed out would trip the session-ended redirect');
check('a failed request caches "no answer" rather than throwing', /catch \{[\s\S]{0,400}cached = null;/.test(TERMS));
check('acceptance posts the version the SERVER said is current',
  /const version = \(state\.requiredVersion \?\? ''\)\.trim\(\)/.test(TERMS),
  'a hard-coded version would keep recording the old label after the terms changed');

const GATE = read('components/TermsGate.tsx');
check('the gate renders children untouched when nothing is outstanding',
  /if \(!termsOutstanding\(state\)\) return <>\{children\}<\/>;/.test(GATE));
check('a failed acceptance keeps the screen up and says so', /setError\(/.test(GATE),
  'silently continuing would leave the app believing an acceptance it never recorded');
check('both documents are reachable from the screen',
  /\/terms/.test(GATE) && /\/privacy/.test(GATE),
  'accepting terms you cannot read is worth nothing');

const LAYOUT = read('app/_layout.tsx');
check('the terms gate sits INSIDE the version gate',
  LAYOUT.indexOf('<UpdateGate>') < LAYOUT.indexOf('<TermsGate>'),
  'an out-of-date build must be told to update before it is asked to accept anything');

const GO = read('vaultchat-backend-go/internal/routes/terms.go');
check('the server refuses to record a version that is not in force',
  /Those are not the terms currently in force/.test(GO),
  'storing whatever the client claimed would make the record evidence of nothing');
check('an unset version means nobody is asked', /required != "" &&/.test(GO));

console.log(failures === 0 ? '\nAll terms-acceptance checks passed.\n' : `\n${failures} check(s) FAILED.\n`);
process.exit(failures === 0 ? 0 : 1);
