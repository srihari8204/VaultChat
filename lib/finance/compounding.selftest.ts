// lib/finance/compounding.selftest.ts — run: npx tsx lib/finance/compounding.selftest.ts
//
// The interest calculator compounds as often as the user says, not always
// once a year.

import assert from 'node:assert/strict';
import { calculateInterest, compoundingFor, compoundingWord, COMPOUNDING } from './compounding';
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

function ok(label: string, cond: boolean) { assert.ok(cond, label); n++; }

console.log(`compounding: ${n} assertions passed`);
