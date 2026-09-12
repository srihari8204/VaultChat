// lib/appVersion.selftest.ts — run: npx tsx lib/appVersion.selftest.ts
//
// The version floor is the one control that can lock every user out of the app
// at once, so its failure modes matter more than its happy path. The rule is:
// it may only ever block on a CLEAR instruction from the server. Silence,
// timeouts, garbage and unknown builds all mean "allowed".
//
// verdictFor is pure, so this exercises the real decision rather than reading
// source — the fetch wrapper around it is what cannot be loaded under Node.

import { verdictFor, type VersionGate } from './appVersionPolicy';

let failures = 0;
function eq(name: string, actual: unknown, expected: unknown) {
  const ok = Object.is(actual, expected);
  if (!ok) failures++;
  console.log(`  ${ok ? '✓' : '✗'} ${name}${ok ? '' : `  (got ${actual}, want ${expected})`}`);
}

const gate = (minBuild: number, adviseBuild = 0): VersionGate =>
  ({ minBuild, adviseBuild, updateUrl: 'https://example.test', message: '' });

console.log('\nApp-version gate self-test\n');

console.log('It blocks when — and only when — the server says so:');
eq('below the floor is blocked', verdictFor(23, gate(24)), 'blocked');
eq('exactly at the floor is allowed', verdictFor(24, gate(24)), 'ok');
eq('above the floor is allowed', verdictFor(99, gate(24)), 'ok');

console.log('\nIt never blocks on an absent or unusable answer:');
eq('no answer at all (offline, timeout, captive portal)', verdictFor(23, null), 'ok');
eq('a server with no floor configured blocks nobody', verdictFor(1, gate(0)), 'ok');
eq('an unknown build is never blocked', verdictFor(0, gate(9999)), 'ok');
eq('...not even by a huge floor', verdictFor(-5, gate(9999)), 'ok');

console.log('\nThe soft floor nags, it does not block:');
eq('between advise and min is advise', verdictFor(25, gate(24, 30)), 'advise');
eq('below BOTH is blocked, not advised', verdictFor(10, gate(24, 30)), 'blocked');
eq('at the advisory floor is ok', verdictFor(30, gate(24, 30)), 'ok');
eq('an advisory floor alone never blocks', verdictFor(5, gate(0, 30)), 'advise');

console.log('\nThe comparison is numeric, not lexical:');
// The reason the floor is a build NUMBER and not a versionName: as strings,
// "1.2.10" sorts below "1.2.9", so a string floor would block the newer build.
eq('build 100 clears a floor of 99', verdictFor(100, gate(99)), 'ok');
eq('build 9 does not clear a floor of 10', verdictFor(9, gate(10)), 'blocked');

console.log(failures ? `\n  ${failures} FAILED\n` : '\n  all app-version checks passed\n');
process.exit(failures ? 1 : 0);
