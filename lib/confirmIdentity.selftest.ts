// lib/confirmIdentity.selftest.ts — run: npx tsx lib/confirmIdentity.selftest.ts
//
// This gate is the only thing between a stray tap and a permanently deleted
// account, so both directions matter: it must not refuse the owner typing their
// own number in a different shape, and it must not arm on empty, partial or
// someone else's input.

import { identityMatches } from './confirmIdentity';

let failures = 0;
function check(name: string, ok: boolean) {
  if (!ok) failures++;
  console.log(`  ${ok ? '✓' : '✗'} ${name}`);
}

console.log('\nConfirm-identity self-test\n');

const phoneAcct = { phone: '+91 98765 43210', email: 'a@b.com' };

console.log('Phone accounts:');
check('exact, as stored',            identityMatches(phoneAcct, '+91 98765 43210'));
check('digits only',                 identityMatches(phoneAcct, '919876543210'));
check('national form, no country',   identityMatches(phoneAcct, '9876543210'));
check('spaces and dashes ignored',   identityMatches(phoneAcct, '98765-43210'));
check('a different number fails',    !identityMatches(phoneAcct, '9876543211'));
check('a too-short suffix fails',    !identityMatches(phoneAcct, '43210'));
check('empty fails',                 !identityMatches(phoneAcct, ''));
check('a prefix is not a suffix',    !identityMatches(phoneAcct, '9198765'));

console.log('\nEmail accounts:');
const mailAcct = { phone: null, email: 'Sri@Example.com' };
check('exact match',                 identityMatches(mailAcct, 'Sri@Example.com'));
check('case-insensitive',            identityMatches(mailAcct, 'sri@example.com'));
check('surrounding space ignored',   identityMatches(mailAcct, '  sri@example.com '));
check('local part alone fails',      !identityMatches(mailAcct, 'sri'));
check('empty fails',                 !identityMatches(mailAcct, ''));

console.log('\nNothing to match against:');
check('null account never arms',     !identityMatches(null, 'anything'));
check('no phone and no email fails', !identityMatches({ phone: null, email: null }, ''));

console.log(failures ? `\n  ${failures} FAILED\n` : '\n  all confirm-identity checks passed\n');
process.exit(failures ? 1 : 0);
