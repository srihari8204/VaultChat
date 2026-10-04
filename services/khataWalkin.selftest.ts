// khataWalkin.selftest.ts — a walk-in khata must hit the right party column.
//
// # WHAT THIS PROTECTS
//
// `shopbook_ledger` stores the party in one of two columns: `customer_user_id`
// for a crazzychat account, `khata_customer_id` for a walk-in. A CHECK
// constraint (`shopbook_ledger_party_ck`) rejects a row that sets both or
// neither, so the client cannot be vague about which it means.
//
// Getting it wrong is not a cosmetic bug. Posting a walk-in's debt into
// `customer_user_id` would either be rejected outright or, worse, attach the
// debt to whatever account id happened to be passed — money against the wrong
// person. And reading with the wrong column returns an EMPTY ledger rather than
// an error, so a customer who owes money would render as owing nothing.
//
// # THE FAMILY RULE
//
// Dedup is on (shop, mobile), so a wife or son buying on the household number
// lands on the SAME khata rather than opening a second one. The unique index is
// PARTIAL (`WHERE mobile <> ''`), so two name-only customers stay separate —
// two different people called "Ramesh" with no phone number are two khatas, not
// one merged mess.
//
// STRUCTURAL: reads source, sends nothing, writes nothing.
//
//   npx tsx services/khataWalkin.selftest.ts

import { readFileSync, readdirSync } from 'fs';
import { join } from 'path';

const ROOT = join(__dirname, '..');
const read = (...p: string[]) => readFileSync(join(ROOT, ...p), 'utf8');
const SVC = read('services', 'shopBookService.ts');
// Shop Book's screens moved out of app/shop-book.tsx into components/shopbook/
// (2026-10-04 split). Read the route shell plus every moved file, in a fixed
// order, so these source checks follow the code rather than its old address.
const shopBookSource = (root: string): string => [
  join(root, 'app', 'shop-book.tsx'),
  ...readdirSync(join(root, 'components', 'shopbook')).filter((f) => /\.tsx?$/.test(f)).sort()
    .map((f) => join(root, 'components', 'shopbook', f)),
].map((p) => readFileSync(p, 'utf8')).join('\n');
const UI = shopBookSource(ROOT);
const GO = read('vaultchat-backend-go', 'internal', 'routes', 'shopbook.go');
const GOK = read('vaultchat-backend-go', 'internal', 'routes', 'shopbook_khata.go');

let failures = 0;
const A = (ok: boolean, what: string): void => {
  if (!ok) { failures++; console.error('  FAIL', what); } else console.log('  ok  ', what);
};

console.log('\nShopBook walk-in khata\n');

// ── 1. EXACTLY ONE PARTY COLUMN ────────────────────────────────────
A(/const party = isKhata \? \{ khataCustomerId: customerId \} : \{ customerId \};/.test(SVC),
  '1. the client sends exactly one party field, chosen by the discriminator');
A(!/khataCustomerId,\s*customerId/.test(SVC),
  '2. never both — the CHECK constraint would reject it');
// Go needs no outer parens on an if, so the guard reads `if (a) == (b) {`.
A(/if \(b\.CustomerID == ""\) == \(b\.KhataCustomerID == ""\) \{/.test(GO),
  '3. and the server enforces exactly-one independently of the client');

// ── 2. READS USE THE MATCHING COLUMN ───────────────────────────────
A(/const q = isKhata \? 'khataCustomerId' : 'customerId';/.test(SVC),
  '4. the detail fetch asks by the right parameter');
A(/partyCol = "l\.khata_customer_id"/.test(GO),
  '5. and the handler switches the WHERE column rather than ignoring it');
A(/khataCustomerId"\); kID != ""/.test(GO),
  '6. a khata id has its own query param, so it cannot be read as an account id');

// ── 3. WALK-INS ARE VISIBLE AT ALL ─────────────────────────────────
// The bug that made the whole feature unreachable: the summary grouped only by
// customer_user_id, so a walk-in never appeared no matter what they owed.
A(/UNION ALL/.test(GO) && /FROM shopbook_khata_customer k/.test(GO),
  '7. the owner summary unions account customers AND walk-ins');
A(/LEFT JOIN shopbook_ledger l\s*\n\s*ON l\.khata_customer_id = k\.id/.test(GO),
  '8. LEFT JOIN, so a customer added a moment ago with no entries still appears');
A(/"isKhata": isKhata/.test(GO) && /isKhata\?: boolean/.test(SVC),
  '9. the discriminator is returned and typed, not inferred from the id shape');
A(/l\.customer_user_id IS NOT NULL/.test(GO),
  '10. the account arm excludes walk-in rows, so nobody is counted twice');

// ── 4. ONE HOUSEHOLD, ONE KHATA ────────────────────────────────────
A(/SELECT id FROM shopbook_khata_customer WHERE shop_id=\$1 AND mobile=\$2/.test(GOK),
  '11. dedup is on (shop, mobile) — the family key');
A(/"duplicate": true/.test(GOK),
  '12. and the caller is told it reused an existing khata');
A(/if \(r\.duplicate\)/.test(UI),
  '13. the UI says so rather than pretending a new customer was created');
A(/mobile != ""/.test(GOK),
  '14. a blank mobile is NOT deduplicated — two name-only customers stay apart');

// ── 5. PARTIAL PAYMENT LEAVES A BALANCE ────────────────────────────
A(/type === 'payment' && customer\.isKhata/.test(UI),
  '15. a walk-in payment is routed to the ledger endpoint');
A(/'payment', amt,/.test(UI),
  '16. as a payment entry, so it subtracts from the balance');
A(/SUM\(CASE WHEN l\.type='purchase' THEN l\.amount ELSE -l\.amount END\)/.test(GO),
  '17. pending = purchases minus payments, so ' +
  'a 500 payment against 1000 leaves 500 outstanding');

// ── 6. THE UI IS REACHABLE ─────────────────────────────────────────
A(/Add customer/.test(UI), '18. there is an Add customer affordance');
A(/createKhataCustomer/.test(UI) && /createKhataCustomer/.test(SVC),
  '19. wired to the deployed endpoint');
A(/keyboardType="phone-pad"/.test(UI), '20. the mobile field uses a phone keypad');
// ASSERT THE BEHAVIOUR, NOT THE MARKUP. This pinned the exact inline JSX
// `{!!c.mobile && <Text style={s.hint}>{c.mobile}</Text>}`, so the glassmorphism
// pass (7c55bb7) broke it by moving the row onto the shared TxnRow — the number
// is still rendered, via `sub`, and the check failed anyway. A test that fails
// when a feature is REFACTORED rather than when it BREAKS trains people to
// delete it.
//
// Two halves, because either alone can pass while the number is invisible: the
// row must be handed the mobile, and TxnRow must actually draw what it is handed.
A(/sub=\{c\.mobile/.test(UI),
  '21. the customer row is given the mobile number');
A(/\{sub \? <Text[^>]*>\{sub\}<\/Text> : null\}/.test(UI)
  && /accessibilityLabel=\{\[title, sub,/.test(UI),
  '21a. ...and the row renders it, and reads it out, so a household khata is identifiable');

// ── 7. NOTHING ELSE MOVED ──────────────────────────────────────────
A(!/DROP |ALTER TABLE|CREATE TABLE/.test(GO),
  '22. no schema change — 111/112 already provide every column used');

console.log(failures === 0
  ? '\nALL WALK-IN KHATA CHECKS PASSED ✓  (device test separate)\n'
  : `\n${failures} FAILED ✗\n`);
process.exit(failures === 0 ? 0 : 1);
