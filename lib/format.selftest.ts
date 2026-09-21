// lib/format.selftest.ts — run: npx tsx lib/format.selftest.ts
//
// initialOf exists because two screens white-screened on an account with no
// email. Every case below is a render path: it must return a character, never
// throw. The empty-string and whitespace rows are the actual shipped bugs.

import { formatDuration, initialOf } from './format';

let failures = 0;
function check(name: string, ok: boolean) {
  if (!ok) failures++;
  console.log(`  ${ok ? '✓' : '✗'} ${name}`);
}

console.log('\nFormat self-test\n');

console.log('initialOf:');
check('first letter, uppercased',   initialOf('sri') === 'S');
check('leading space trimmed',      initialOf('  sri') === 'S');
check('empty string falls through', initialOf('', 'ana@example.com') === 'A');
check('whitespace falls through',   initialOf('   ', 'ana@example.com') === 'A');
check('null falls through',         initialOf(null, undefined, 'ana') === 'A');
check('nothing at all is safe',     initialOf(null, undefined, '', '   ') === '?');
check('no arguments is safe',       initialOf() === '?');
check('emoji name survives',        initialOf('🦊 fox') === '🦊');
// Not decorative: `[0]` of an astral name is half a surrogate pair and paints a
// tofu box. en/te/hi are shipped locales, so non-Latin names are the norm.
check('emoji is one whole char',    [...initialOf('🦊 fox')].length === 1);
check('devanagari passes through',  initialOf('अनिल') === 'अ');
check('telugu passes through',      initialOf('శ్రీ') === 'శ');
// The group-avatar call sites want '#', not '?', when there is no name. They
// spell it as a trailing literal part rather than a second helper: a literal
// is its own uppercase, so it always wins the loop and never falls to '?'.
check("trailing literal is the fallback", initialOf('', '#') === '#');
check("whitespace falls to literal",      initialOf('   ', '#') === '#');
check("a real name still beats it",       initialOf('ana', '#') === 'A');

console.log('\nformatDuration:');
check('zero pads',                  formatDuration(5) === '00:05');
check('past an hour stays MM:SS',   formatDuration(5405) === '90:05');
check('negative clamps to zero',    formatDuration(-3) === '00:00');

console.log(failures ? `\n  ${failures} FAILED\n` : '\n  all format checks passed\n');
process.exit(failures ? 1 : 0);
