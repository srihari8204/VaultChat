// lib/finance/compounding.selftest.ts — run: npx tsx lib/finance/compounding.selftest.ts
//
// The interest calculator compounds as often as the user says, not always
// once a year.

import assert from 'node:assert/strict';
import { calculateInterest, compoundingFor, compoundingWord, COMPOUNDING, ledgerInterestTypeLabel, ledgerCompoundingNote } from './compounding';
import { ledgerInterest } from '../../utils/financeRules';
import { round2 } from '../../utils/interest';

let n = 0;
const eq = (label: string, a: unknown, b: unknown) => { assert.deepEqual(a, b, label); n++; };
const near = (label: string, a: number, b: number) => { assert.ok(Math.abs(a - b) < 0.005, `${label}: ${a} vs ${b}`); n++; };

const base = { principal: 100000, rate: 2, rateMode: 'percent' as const, period: 'monthly' as const, years: 1 };

// 2% a month, compounded monthly, for a year: 100000 × 1.02^12.
near('2% a month compounds monthly', calculateInterest({ ...base, type: 'compound', perYear: 12 }).total, 100000 * Math.pow(1.02, 12));
eq('… which is 126,824.18', round2(calculateInterest({ ...base, type: 'compound', perYear: 12 }).total), 126824.18);
// The old behaviour: one compounding a year at the annualised 24%.
eq('yearly compounding is the old 124,000', round2(calculateInterest({ ...base, type: 'compound', perYear: 1 }).total), 124000);
ok('monthly compounding earns more than yearly',
  calculateInterest({ ...base, type: 'compound', perYear: 12 }).interest > calculateInterest({ ...base, type: 'compound', perYear: 1 }).interest);

// Two years at 10% a year, quarterly: 100000 × 1.025^8.
near('quarterly', calculateInterest({ ...base, rate: 10, period: 'yearly', years: 2, type: 'compound', perYear: 4 }).total, 100000 * Math.pow(1.025, 8));

// Simple interest ignores the compounding choice.
eq('simple interest ignores compounding',
  calculateInterest({ ...base, type: 'simple', perYear: 365 }).total, calculateInterest({ ...base, type: 'simple', perYear: 1 }).total);
eq('simple: 2% a month for a year is 24%', calculateInterest({ ...base, type: 'simple', perYear: 12 }).interest, 24000);

// ₹ per ₹100 per month is the same as % per month.
eq('rupees per 100 equals percent', calculateInterest({ ...base, rateMode: 'rupees', type: 'compound', perYear: 12 }).total,
  calculateInterest({ ...base, type: 'compound', perYear: 12 }).total);

// 0% stays principal.
eq('0% is the principal back', calculateInterest({ ...base, rate: 0, type: 'compound', perYear: 12 }).total, 100000);

// The period sets the default compounding.
eq('period → compounding', (['daily', 'weekly', 'monthly', 'yearly'] as const).map(compoundingFor), [365, 52, 12, 1]);
eq('every default is offered', (['daily', 'weekly', 'monthly', 'yearly'] as const).every(p => COMPOUNDING.some(c => c.n === compoundingFor(p))), true);
eq('words', [compoundingWord(12), compoundingWord(2)], ['monthly', '2 times a year']);

// A ledger with the same terms and the same compounding gives the calculator's answer.
{
  const start = new Date(2026, 0, 1).getTime();
  for (const perYear of [1, 4, 12, 52, 365]) {
    const ledger = ledgerInterest({ principal: 100000, rate: 2, rate_mode: 'percent', period: 'monthly', interest_type: 'compound',
      start_date: start, end_date: start + 31536000000, compounding: perYear });
    eq(`ledger = calculator, ${compoundingWord(perYear)}`, ledger.total, round2(calculateInterest({ ...base, type: 'compound', perYear }).total));
  }
}
// The ledger screens say how a compound ledger compounds.
eq('label: stored NULL says yearly', ledgerInterestTypeLabel({ interest_type: 'compound', compounding: null }), 'Compound, compounded yearly');
eq('label: monthly', ledgerInterestTypeLabel({ interest_type: 'compound', compounding: 12 }), 'Compound, compounded monthly');
eq('label: simple', ledgerInterestTypeLabel({ interest_type: 'simple', compounding: 12 }), 'Simple');
eq('note: none compound', ledgerCompoundingNote([{ interest_type: 'simple', compounding: null }]), null);
eq('note: all yearly', ledgerCompoundingNote([{ interest_type: 'compound', compounding: null }]), 'Compound loans are compounded yearly.');
eq('note: mixed', ledgerCompoundingNote([{ interest_type: 'compound', compounding: null }, { interest_type: 'compound', compounding: 12 }]),
  'Compound loans are compounded as set on each ledger.');

function ok(label: string, cond: boolean) { assert.ok(cond, label); n++; }

console.log(`compounding: ${n} assertions passed`);
