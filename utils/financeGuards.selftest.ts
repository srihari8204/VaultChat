// utils/financeGuards.selftest.ts — run: npx tsx utils/financeGuards.selftest.ts
//
// NaN IS NOT LESS THAN OR EQUAL TO ZERO.
//
// Every comparison with NaN is false, so `if (months <= 0) return` does not
// reject NaN — it waves it through. utils/finance.ts guarded emi() and
// amortization() that way, and app/finance/emi.tsx recomputes the schedule from
// the LIVE amount/rate strings on every keystroke. Typing '1,2' into Loan
// Amount while the schedule was open produced a full table of NaN rows,
// rendered as the literal "NaN" and exported to the shared PDF as "₹NaN".
//
// tsconfig has strict:false and strictNullChecks:false, so nothing upstream
// catches this; the guard is the only thing standing there.
//
// utils/finance.ts is pure, so it is imported and run for real. The screens are
// not importable outside React Native, so their fixes are source-scanned.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import { emi, amortization, partPayment } from './finance';

let n = 0;
const ok = (label: string, cond: boolean) => { assert.ok(cond, label); n++; console.log('  ok  ' + label); };

// ── The NaN class, at the source ────────────────────────────────
ok('a NaN principal yields no EMI', emi(NaN, 8.5, 120).emi === 0);
ok('a NaN tenure yields no EMI', emi(1000000, 8.5, NaN).emi === 0);
ok('a NaN rate yields no EMI', emi(1000000, NaN, 120).emi === 0);
ok('an EMI result is never NaN', Number.isFinite(emi(NaN, NaN, NaN).totalPayment));

ok('a NaN principal yields no schedule', amortization(NaN, 8.5, 120).length === 0);
ok('a NaN tenure yields no schedule', amortization(1000000, 8.5, NaN).length === 0);
ok('a NaN rate yields no schedule', amortization(1000000, NaN, 120).length === 0);
ok('an all-NaN call yields no schedule', amortization(NaN, NaN, NaN).length === 0);

// Not one NaN may reach a row, whatever the inputs — this is what the PDF prints.
for (const [p, r, m] of [[NaN, 8.5, 12], [1e6, NaN, 12], [1e6, 8.5, NaN], [-1, 8.5, 12], [0, 0, 0]]) {
  for (const row of amortization(p, r, m)) {
    ok('no NaN in any amortization cell',
      [row.emi, row.principal, row.interest, row.balance].every(Number.isFinite));
  }
}

// The old guards' own cases must keep behaving.
ok('zero principal still yields no EMI', emi(0, 8.5, 120).emi === 0);
ok('a negative tenure still yields no schedule', amortization(1000000, 8.5, -12).length === 0);

// ── The maths must be unchanged ─────────────────────────────────
// ₹10,00,000 at 8.5% for 120 months → ₹12,398.57/month (standard EMI formula).
ok('the EMI formula is untouched', emi(1000000, 8.5, 120).emi === 12398.57);
ok('a 0% loan is still principal ÷ months, not a rejected rate', emi(120000, 0, 12).emi === 10000);
const sched = amortization(1000000, 8.5, 120);
ok('the schedule still runs the full tenure', sched.length === 120);
ok('the schedule still closes at zero', sched[sched.length - 1].balance === 0);
ok('the first row still splits EMI into principal and interest',
  sched[0].interest === 7083.33 && sched[0].principal === 5315.24);
ok('a 0% schedule still amortises evenly', amortization(120000, 0, 12)[0].principal === 10000);

// partPayment shares the shape: `denom <= 0` passed NaN into Math.log.
ok('a part payment never returns a NaN tenure',
  Number.isFinite(partPayment(NaN, NaN, 120, NaN, 'tenure').newMonths));
ok('a real part payment still shortens the tenure',
  partPayment(1000000, 8.5, 120, 200000, 'tenure').newMonths < 120);

// ...but the flip only reached the `denom` branch. Two doors stayed open.
// `r === 0` divides by old.emi, which is 0 for a zero/NaN outstanding or tenure.
ok('a 0% part payment on nothing yields no NaN tenure',
  Number.isFinite(partPayment(0, 0, 12, 0, 'tenure').newMonths));
ok('a 0% part payment on nothing yields no NaN saving',
  Number.isFinite(partPayment(0, 0, 12, 0, 'tenure').interestSaved));
ok('a NaN tenure yields no NaN part payment',
  Number.isFinite(partPayment(1000000, 8.5, NaN, 100000, 'tenure').newMonths));
// A NaN lump made newP NaN; emi() answers 0 for a NaN principal, so 'emi' mode
// reported "new EMI ₹0, interest saved ₹4,87,828" — a confident lie about a
// payment that never parsed. A payment we cannot read saves nothing.
ok('a NaN lump does not report the whole interest as saved',
  partPayment(1000000, 9, 120, NaN, 'emi').interestSaved === 0);
ok('a NaN lump does not report the EMI as reduced to zero',
  partPayment(1000000, 9, 120, NaN, 'emi').emiReduced === 0);
ok('a 0% part payment that IS real still shortens the tenure',
  partPayment(120000, 0, 12, 60000, 'tenure').newMonths === 6);

// ── Screens: source-scanned, since they cannot be imported here ──
const interest = fs.readFileSync('app/finance/interest.tsx', 'utf8');
ok('the interest screen refuses a non-finite result before it is shown or stored',
  /Number\.isFinite\(r\.total\)/.test(interest));
ok('the refusal happens before setRes and insertInterest',
  interest.indexOf('Number.isFinite(r.total)') < interest.indexOf('setRes(out)'));
ok('the out-of-range result is bounded, not merely finite',
  interest.includes('Number.MAX_SAFE_INTEGER'));
ok('the user is told the inputs are out of range', interest.includes("'Out of range'"));

// `num(x) || 0` SWALLOWS THE HARDENED PARSER. financeFormat's num() returns
// NaN so that `!(x > 0)` can see a half-typed "1,2" — `|| 0` converts that back
// to a believable zero BEFORE the guard, and the guard then passes on the
// strength of the other fields. Every remaining `|| 0` around num() in these
// screens is that bug (2026-09-17).
ok('the interest duration no longer launders NaN through `|| 0`',
  !/num\(dur[YMD]\) \|\| 0/.test(interest));
ok('the interest duration rejects a box that did not parse',
  /Number\.isFinite\(dY\)/.test(interest) && interest.indexOf('Number.isFinite(dY)') < interest.indexOf('years = dY'));

const chitti = fs.readFileSync('app/finance/chitti/[id].tsx', 'utf8');
ok('the auction commission no longer launders NaN through `|| 0`',
  !/num\(commission\) \|\| 0/.test(chitti));
ok('an unreadable commission is refused rather than recorded as none',
  chitti.includes("if (!(c >= 0)) return Alert.alert('Commission'"));
ok('the preview still mirrors the recorded auction',
  chitti.includes('if (!(b > 0) || !(c >= 0)) return { each: 0'));

const io = fs.readFileSync('app/finance/io.tsx', 'utf8');
ok('a settled ledger is no longer resurrected by `|| principal`',
  !/remaining: num\(c\[8\]\) \|\| principal/.test(io));
ok('an empty Remaining cell is distinguished from a zero one',
  /remCell === ''/.test(io));
// Blank and unparseable shared the principal fallback, so "₹1,00,000.00" —
// which the parser refuses, correctly — restored the full principal on a
// settled ledger. Blank falls back; unreadable is skipped, like the principal.
ok('an UNPARSEABLE Remaining cell no longer falls back to the principal',
  !/remaining: remCell === '' \|\| !Number\.isFinite\(rem\)/.test(io));
ok('an unreadable Remaining cell skips the row instead of inventing a number',
  /if \(remCell !== '' && !Number\.isFinite\(rem\)\) \{ skipped\+\+; continue; \}/.test(io));
ok('skipped rows are reported rather than silently dropped', /skipped \?/.test(io));

// 0% is a real loan — money lent to a relative at no interest — and finance.ts
// prices it deliberately. `!(R > 0)` refused to record one at all.
for (const f of ['app/finance/ledger/new.tsx', 'app/finance/ledger/edit.tsx']) {
  const src = fs.readFileSync(f, 'utf8');
  ok(`${f} no longer refuses a 0% rate`, !/if \(!\(R > 0\)\) return Alert\.alert\('Rate'/.test(src));
  ok(`${f} still refuses a NaN or negative rate`,
    /if \(!Number\.isFinite\(R\) \|\| R < 0\) return Alert\.alert\('Rate'/.test(src));
  ok(`${f} still requires a principal above 0`, /if \(!\(P > 0\)\) return Alert\.alert\('Principal'/.test(src));
}

const emiScreen = fs.readFileSync('app/finance/emi.tsx', 'utf8');
ok('the schedule is built from the calculated result, not the live fields',
  emiScreen.includes('amortization(res.P, res.R, res.months)'));
ok('the result card and PDF no longer re-parse the live amount field',
  !/formatINR\(num\(amount\)\)/.test(emiScreen));

const search = fs.readFileSync('app/finance/search.tsx', 'utf8');
ok('search has no bare comma strip of its own', !/Number\(q\.replace\(\/\[₹,/.test(search));
ok('search uses the shared hardened parser', /num\(q\.replace\(/.test(search));

console.log(`\nfinanceGuards.selftest: ${n} assertions passed`);
