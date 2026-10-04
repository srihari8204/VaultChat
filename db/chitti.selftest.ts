// db/chitti.selftest.ts — run: npx tsx db/chitti.selftest.ts
//
// normalizeMobile decides whether a Lucky Draw member's number is accepted and
// what gets stored. Getting it wrong either rejects valid numbers the organizer
// typed with spaces/+91, or stores junk that later renders as a broken contact.
// The invariant asserted here: any formatting of the SAME number normalizes to
// one identical 10-digit string, and anything that is not an Indian mobile is
// rejected outright rather than silently stored.
//
// The function itself now lives in utils/financeRules.ts (pure, so the CSV
// importer and the ledger forms can share it) and is imported and run for
// real. db/chitti.ts re-exports it; the source checks below keep both honest.

import { readFileSync } from 'fs';
import { join } from 'path';
import { normalizeMobile } from '../utils/financeRules';

let failures = 0;
function check(name: string, ok: boolean, detail?: string) {
  if (!ok) failures++;
  console.log(`  ${ok ? '✓' : '✗'} ${name}${ok || !detail ? '' : `  (${detail})`}`);
}
function eq(name: string, actual: unknown, expected: unknown) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  check(name, ok, ok ? undefined : `got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)}`);
}

console.log('\nLucky Draw — mobile normalization self-test\n');

// ── every formatting of one number collapses to the same stored value ──
const SAME = ['9876543210', '+919876543210', '91 9876543210', '098765 43210',
              '98765-43210', '(98765) 43210', '  9876543210  '];
const normalized = SAME.map(normalizeMobile);
eq('all formattings of one number agree', new Set(normalized).size, 1);
eq('and normalize to the bare 10 digits', normalized[0], '9876543210');

// ── rejected: not an Indian mobile ──
check('empty string rejected', normalizeMobile('') === null);
check('too short rejected', normalizeMobile('98765') === null);
check('too long rejected', normalizeMobile('98765432101') === null);
check('letters rejected', normalizeMobile('98765abcde') === null);
check('landline (leading 2) rejected', normalizeMobile('2212345678') === null);
check('leading 5 rejected', normalizeMobile('5876543210') === null);
// A stripped +91 must not resurrect a too-short number as valid.
check('+91 with short body rejected', normalizeMobile('+9198765') === null);

// ── accepted: every valid Indian mobile prefix ──
// 9123456789 is the regression case: it BEGINS with "91" but is a real
// 10-digit mobile, not a country-coded one. An unconditional +91 strip ate
// its first two digits and rejected it.
for (const p of [6, 7, 8, 9]) {
  const n = `${p}123456789`;
  eq(`prefix ${p} accepted`, normalizeMobile(n), n);
}
eq('9123456789 survives (country-code false positive)', normalizeMobile('9123456789'), '9123456789');
eq('+919123456789 still strips correctly', normalizeMobile('+919123456789'), '9123456789');

// ── the real implementation keeps its guards; db/chitti.ts still exports it ──
check('db/chitti.ts still exports normalizeMobile',
  /export \{ normalizeMobile \}/.test(readFileSync(join(__dirname, 'chitti.ts'), 'utf8')));
const src = readFileSync(join(__dirname, '..', 'utils', 'financeRules.ts'), 'utf8');
check('source keeps the 10-digit [6-9] rule', src.includes('/^[6-9]\\d{9}$/'));
// The length guards are the fix for "9123456789 is itself a valid mobile" —
// if someone reverts to an unconditional strip, this fails.
check('source strips 91 only at length 12', src.includes(`s.length === 12 && s.startsWith('91')`));
check('source strips 0 only at length 11', src.includes(`s.length === 11 && s.startsWith('0')`));

console.log(failures === 0 ? '\nAll checks passed.\n' : `\n${failures} check(s) FAILED.\n`);
process.exit(failures === 0 ? 0 : 1);
