// utils/financeRules.selftest.ts — run: npx tsx utils/financeRules.selftest.ts
//
// The finance status transitions, interest, reminder recurrence and search
// matching, run for real (the module is pure).

import assert from 'node:assert/strict';
import {
  addMonths, startOfDay, isPastDue, ledgerDatesProblem, normalizeMobile, ledgerInterest,
  ledgerStatusFor, groupStatusFor, nextAuction, chittiTermEnd, nextOccurrence, occurrencesBetween,
  advanceReminders, amountMatches, sameCustomer, ledgerCompounding, compoundingOfAll, ledgerInterestSoFar,
} from './financeRules';
import { toPaise, fromPaise } from './money';

let n = 0;
const ok = (label: string, cond: boolean) => { assert.ok(cond, label); n++; };
const eq = (label: string, a: unknown, b: unknown) => { assert.deepEqual(a, b, label); n++; };
const at = (y: number, m: number, d: number, h = 9, mi = 0) => new Date(y, m - 1, d, h, mi).getTime();
const ymd = (ms: number) => { const d = new Date(ms); return [d.getFullYear(), d.getMonth() + 1, d.getDate()]; };

// ── calendar months ──
eq('31 Jan + 1 month is the last day of Feb', ymd(addMonths(at(2026, 1, 31), 1)), [2026, 2, 28]);
eq('leap year February', ymd(addMonths(at(2028, 1, 31), 1)), [2028, 2, 29]);
eq('+2 months from 31 Jan keeps day 31', ymd(addMonths(at(2026, 1, 31), 2)), [2026, 3, 31]);
eq('crosses a year', ymd(addMonths(at(2026, 11, 15), 3)), [2027, 2, 15]);
eq('time of day is kept', new Date(addMonths(at(2026, 1, 10, 14, 30), 1)).getHours(), 14);

// ── due dates ──
ok('not past due on the end day itself', !isPastDue(at(2026, 5, 10), at(2026, 5, 10, 23, 59)));
ok('past due the day after', isPastDue(at(2026, 5, 10), at(2026, 5, 11, 0, 1)));
ok('no end date is never past due', !isPastDue(null, at(2030, 1, 1)));
ok('end on the start day is fine', ledgerDatesProblem(at(2026, 5, 10, 18), at(2026, 5, 10, 8)) === null);
ok('end before start is refused', ledgerDatesProblem(at(2026, 5, 10), at(2026, 5, 9)) !== null);
ok('no end date is fine', ledgerDatesProblem(at(2026, 5, 10), null) === null);

// ── mobile ──
eq('every formatting agrees', new Set(['9876543210', '+919876543210', '098765 43210', '(98765) 43210'].map(normalizeMobile)).size, 1);
eq('9123456789 survives', normalizeMobile('9123456789'), '9123456789');
ok('junk is rejected', normalizeMobile('12345') === null && normalizeMobile('2212345678') === null);

// ── interest: one calculator, compound respected ──
const base = { principal: 100000, rate: 12, rate_mode: 'percent' as const, period: 'yearly' as const,
  start_date: at(2026, 1, 1), end_date: at(2028, 1, 1) };
const simple = ledgerInterest({ ...base, interest_type: 'simple' });
const compound = ledgerInterest({ ...base, interest_type: 'compound' });
ok('simple: 12% for ~2 years', Math.abs(simple.interest - 24000) < 50);
ok('compound is more than simple over 2 years', compound.interest > simple.interest + 1000);
ok('compound ≈ P(1.12^2) − P', Math.abs(compound.interest - 25440) < 60);
ok('no end date is a 1-year projection', ledgerInterest({ ...base, end_date: null, interest_type: 'simple' }).projected === true);
eq('0% is zero interest', ledgerInterest({ ...base, rate: 0, interest_type: 'compound' }).interest, 0);

// ── ledger compounding: chosen per ledger, yearly when not stored ──
// Exact reference, P × ((den + num) / den)^k in BigInt, rounded half-up to
// paise, compared through utils/money (toPaise / fromPaise).
function exactPaise(rupees: bigint, num: bigint, den: bigint, k: number): number {
  let N = rupees * 100n, D = 1n;
  for (let i = 0; i < k; i++) { N *= den + num; D *= den; }
  return Number((2n * N + D) / (2n * D));
}
const YEAR_MS = 31536000000;   // ledgerInterest's year: exactly 365 days
const lt = (over: Partial<Parameters<typeof ledgerInterest>[0]>) => ledgerInterest({
  principal: 100000, rate: 2, rate_mode: 'percent', period: 'monthly', interest_type: 'compound',
  start_date: at(2026, 1, 1), end_date: at(2026, 1, 1) + YEAR_MS, ...over,
});
const exactCases: [string, Parameters<typeof lt>[0], number][] = [
  // the re-rater's case: the calculator's monthly answer, now on a ledger
  ['2%/month, monthly, 1 year', { compounding: 12 }, exactPaise(100000n, 2n, 100n, 12)],
  ['2%/month, yearly (stored)', { compounding: 1 }, exactPaise(100000n, 24n, 100n, 1)],
  ['10%/year, quarterly, 2 years', { rate: 10, period: 'yearly', compounding: 4, end_date: at(2026, 1, 1) + 2 * YEAR_MS }, exactPaise(100000n, 25n, 1000n, 8)],
  ['₹2/₹100/month, monthly, 3 years on ₹50,000', { principal: 50000, rate_mode: 'rupees', compounding: 12, end_date: at(2026, 1, 1) + 3 * YEAR_MS }, exactPaise(50000n, 2n, 100n, 36)],
  ['1%/week, weekly, 1 year on ₹10,000', { principal: 10000, rate: 1, period: 'weekly', compounding: 52 }, exactPaise(10000n, 1n, 100n, 52)],
  ['0.1%/day, daily, 1 year', { rate: 0.1, period: 'daily', compounding: 365 }, exactPaise(100000n, 1n, 1000n, 365)],
];
for (const [label, over, want] of exactCases) {
  const r = lt(over);
  eq(`${label}: total to the paise`, toPaise(r.total), want);
  eq(`${label}: P + interest reconciles`, toPaise(over.principal ?? 100000) + toPaise(r.interest), toPaise(r.total));
}
eq('the ledger now agrees with the calculator: ₹26,824.18', lt({ compounding: 12 }).interest, fromPaise(exactPaise(100000n, 2n, 100n, 12) - 10000000));
// Existing loans do not change: a NULL (or absent) compounding is yearly,
// exactly the amount every compound ledger showed before.
eq('a stored NULL is yearly: still ₹24,000', lt({ compounding: null }).interest, 24000);
eq('absent is yearly too', lt({}).interest, 24000);
eq('junk compounding falls back to yearly', [0, -4, 2.5, 400, NaN].map(c => ledgerCompounding({ compounding: c })), [1, 1, 1, 1, 1]);
eq('valid frequencies are kept', [1, 4, 12, 52, 365].map(c => ledgerCompounding({ compounding: c })), [1, 4, 12, 52, 365]);
eq('simple interest ignores compounding', lt({ interest_type: 'simple', compounding: 365 }).interest, 24000);
eq('no compound ledgers: nothing to say', compoundingOfAll([{ interest_type: 'simple', compounding: 12 }]), { any: false, n: null });
eq('all yearly (stored NULL and 1)', compoundingOfAll([{ interest_type: 'compound', compounding: null }, { interest_type: 'compound', compounding: 1 }]), { any: true, n: 1 });
eq('mixed frequencies', compoundingOfAll([{ interest_type: 'compound', compounding: 12 }, { interest_type: 'compound', compounding: 1 }]), { any: true, n: null });

// ── interest so far: only while the loan is open and running ──
{
  const open = { ...base, interest_type: 'simple' as const, status: 'running' as const, end_date: at(2027, 1, 1) };
  ok('half a year in: about half a year of interest', Math.abs(ledgerInterestSoFar(open, at(2026, 7, 2))! - 6000) < 50);
  eq('nothing before the start', ledgerInterestSoFar(open, at(2025, 12, 1)), 0);
  eq('a settled loan stops accruing (was: kept growing after payoff)', ledgerInterestSoFar({ ...open, status: 'completed' }, at(2026, 7, 2)), null);
  eq('past the end date the full-term figure stands', ledgerInterestSoFar({ ...open, status: 'overdue' }, at(2027, 2, 1)), null);
  ok('no end date keeps accruing', (ledgerInterestSoFar({ ...open, end_date: null }, at(2026, 7, 2)) ?? 0) > 0);
}

// ── ledger status ──
const now = at(2026, 10, 4, 12);
eq('running past its end with a balance → overdue',
  ledgerStatusFor({ status: 'running', remaining: 500, end_date: at(2026, 10, 1) }, now), 'overdue');
eq('running before its end stays running',
  ledgerStatusFor({ status: 'running', remaining: 500, end_date: at(2026, 10, 4) }, now), 'running');
eq('no end date stays running', ledgerStatusFor({ status: 'running', remaining: 500, end_date: null }, now), 'running');
eq('overdue whose end moved later → running',
  ledgerStatusFor({ status: 'overdue', remaining: 500, end_date: at(2026, 12, 1) }, now), 'running');
eq('imported overdue without an end date is left alone',
  ledgerStatusFor({ status: 'overdue', remaining: 500, end_date: null }, now), 'overdue');
eq('a zero balance is completed', ledgerStatusFor({ status: 'running', remaining: 0, end_date: at(2026, 1, 1) }, now), 'completed');
eq('completed is final', ledgerStatusFor({ status: 'completed', remaining: 500, end_date: at(2026, 1, 1) }, now), 'completed');

// ── Lucky Draw groups ──
const g = { status: 'active' as const, start_date: at(2026, 1, 31), duration: 3 };
eq('term ends 3 calendar months on', ymd(chittiTermEnd(g)), [2026, 4, 30]);
eq('active on the last auction day', groupStatusFor(g, at(2026, 4, 30, 20)), 'active');
eq('closed the day after', groupStatusFor(g, at(2026, 5, 1, 1)), 'closed');
eq('draft is never auto-changed', groupStatusFor({ ...g, status: 'draft' }, at(2027, 1, 1)), 'draft');
eq('closed stays closed', groupStatusFor({ ...g, status: 'closed' }, at(2026, 2, 1)), 'closed');
eq('next auction uses calendar months (Feb is month 1)', nextAuction(g, at(2026, 2, 1)), { month: 1, at: addMonths(g.start_date, 1) });
eq('next auction skips past months', nextAuction(g, at(2026, 3, 1))?.month, 2);
eq('none left after the term', nextAuction(g, at(2026, 5, 1)), null);

// ── reminders ──
eq('a one-off never moves', nextOccurrence('once', at(2026, 1, 1), now), at(2026, 1, 1));
eq('daily lands on today at its time', ymd(nextOccurrence('daily', at(2026, 9, 1), startOfDay(now))), [2026, 10, 4]);
eq('weekly keeps its weekday', new Date(nextOccurrence('weekly', at(2026, 9, 2), now)).getDay(), new Date(at(2026, 9, 2)).getDay());
eq('monthly on day 31 lands on 31 Oct', ymd(nextOccurrence('monthly', at(2026, 1, 31), now)), [2026, 10, 31]);
eq('yearly', ymd(nextOccurrence('yearly', at(2024, 3, 15), now)), [2027, 3, 15]);
eq('a future anchor is unchanged', nextOccurrence('daily', at(2027, 1, 1), now), at(2027, 1, 1));
eq('daily occurrences in October from 29 Sep', occurrencesBetween('daily', at(2026, 9, 29), at(2026, 10, 1, 0), at(2026, 11, 1, 0)).length, 31);
eq('monthly on 31st across Nov', occurrencesBetween('monthly', at(2026, 1, 31), at(2026, 11, 1, 0), at(2026, 12, 1, 0)).map(ymd), [[2026, 11, 30]]);
eq('none before the anchor', occurrencesBetween('weekly', at(2026, 10, 20), at(2026, 10, 1, 0), at(2026, 10, 15, 0)), []);
const adv = advanceReminders([
  { id: 'a', freq: 'daily', next_at: at(2026, 10, 1), status: 'active' },
  { id: 'b', freq: 'daily', next_at: at(2026, 10, 4, 8), status: 'active' },   // earlier today: still today's due
  { id: 'c', freq: 'once', next_at: at(2026, 9, 1), status: 'active' },
  { id: 'd', freq: 'monthly', next_at: at(2026, 8, 1), status: 'done' },
] as const as any[], now);
eq('only stale recurring active rows move', adv.map(a => a.id), ['a']);
eq('to today at their time', ymd(adv[0].next_at), [2026, 10, 4]);

// ── search ──
ok('exact amount matches', amountMatches(5000, 5000));
ok('prefix matches', amountMatches(50, 5000) && amountMatches(50, 50000.5));
ok('a larger, different amount does NOT match', !amountMatches(5000, 9000));
ok('a 5-digit mobile prefix does not match every big principal', !amountMatches(98765, 100000));
ok('paise must match exactly', amountMatches(1250.5, 1250.5) && !amountMatches(1250.5, 1250.75));
ok('zero or NaN never matches', !amountMatches(0, 0) && !amountMatches(NaN, 1));

// ── customer ──
ok('same mobile, different spelling → same customer',
  sameCustomer({ name: 'Ramesh K', mobile: '+91 98765 43210' }, 'Ramesh', '9876543210'));
ok('same name, different mobile → different customer',
  !sameCustomer({ name: 'Ramesh', mobile: '9123456789' }, 'Ramesh', '9876543210'));
ok('no mobile on either side → name decides', sameCustomer({ name: ' ramesh ', mobile: null }, 'Ramesh'));

console.log(`financeRules selftest: ${n} assertions passed`);
