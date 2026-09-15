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

// Email is optional now, so blank is the ordinary shape of it — and a blank
// phone must not swallow the branch and strand an account that has an email.
console.log('\nBlank is absent, not present:');
check('blank phone falls through to email',
  identityMatches({ phone: '', email: 'sri@example.com' }, 'sri@example.com'));
check('whitespace phone falls through',
  identityMatches({ phone: '   ', email: 'sri@example.com' }, 'sri@example.com'));
check('blank email is not matched by blank input',
  !identityMatches({ phone: null, email: '' }, ''));

// The mobile-only account whose profile carries neither: without this the
// delete button can never arm, and in-app deletion is a Play requirement.
console.log('\nVaultID, last resort:');
const vaultAcct = { phone: null, email: null, vaultId: 'v9f3a1c20b7e' };
check('exact handle arms',           identityMatches(vaultAcct, 'v9f3a1c20b7e'));
check('leading @ tolerated',         identityMatches(vaultAcct, '@v9f3a1c20b7e'));
check('case-insensitive',            identityMatches(vaultAcct, 'V9F3A1C20B7E'));
check('a prefix fails',              !identityMatches(vaultAcct, 'v9f3a1'));
check('empty fails',                 !identityMatches(vaultAcct, ''));
check('phone still wins when both',
  identityMatches({ phone: '+919876543210', vaultId: 'v9f3a1c20b7e' }, '9876543210'));
check('handle does NOT arm a phone account',
  !identityMatches({ phone: '+919876543210', vaultId: 'v9f3a1c20b7e' }, 'v9f3a1c20b7e'));

console.log('\nNothing to match against:');
check('null account never arms',     !identityMatches(null, 'anything'));
check('no phone and no email fails', !identityMatches({ phone: null, email: null }, ''));
check('all three absent never arms', !identityMatches({ phone: null, email: null, vaultId: null }, 'anything'));

console.log(failures ? `\n  ${failures} FAILED\n` : '\n  all confirm-identity checks passed\n');
process.exit(failures ? 1 : 0);
