// components/finance/ledgerPrefill.selftest.ts — run: npx tsx components/finance/ledgerPrefill.selftest.ts
//
// The calculator's "Save as ledger": the terms survive the trip through route
// params, a ledger made from them gives the calculator's interest to the
// paise, and malformed params are dropped rather than trusted.

import assert from 'node:assert/strict';
import { ledgerPrefillParams, parseLedgerPrefill } from './ledgerPrefill';
import { ledgerInterest } from '../../utils/financeRules';
import { calculateInterest } from '../../lib/finance/compounding';
import { round2 } from '../../utils/interest';

let n = 0;
const eq = (label: string, a: unknown, b: unknown) => { assert.deepEqual(a, b, label); n++; };
const DAY = 86400000;
const start = new Date(2026, 0, 1).getTime();
const end = start + 365 * DAY;

// 2% a month, compounded monthly, for one year: the round-5 example.
const calc = { type: 'compound' as const, principal: 100000, rate: 2, rateMode: 'percent' as const, period: 'monthly' as const, perYear: 12, start, end };
const params = ledgerPrefillParams(calc);
eq('params are strings', Object.values(params).every((v) => typeof v === 'string'), true);
const pre = parseLedgerPrefill(params);
eq('every term comes back', pre, {
  interest_type: 'compound', principal: 100000, rate: 2, rate_mode: 'percent', period: 'monthly',
  compounding: 12, start_date: start, end_date: end,
});
const years = (end - start) / 31536000000;
const fromCalc = round2(calculateInterest({ type: 'compound', principal: 100000, rate: 2, rateMode: 'percent', period: 'monthly', years, perYear: 12 }).interest);
const fromLedger = ledgerInterest({
  principal: pre.principal!, rate: pre.rate!, rate_mode: pre.rate_mode!, period: pre.period!,
  interest_type: pre.interest_type!, start_date: pre.start_date!, end_date: pre.end_date!, compounding: pre.compounding,
}).interest;
eq('the saved ledger gives the calculator\'s interest', fromLedger, fromCalc);
eq('… which is the monthly-compounded figure, not yearly', fromLedger, 26824.18);

// Simple interest carries no compounding.
eq('simple: no compounding', parseLedgerPrefill(ledgerPrefillParams({ ...calc, type: 'simple' })).compounding, undefined);

// Malformed or hostile params are dropped, field by field.
const bad = parseLedgerPrefill({
  type: 'fixed', principal: '-5', rate: 'abc', rateMode: 'bitcoin', period: 'hourly', perYear: '1000',
  start: 'x', end: '1',
});
eq('nothing malformed is kept', bad, {});
eq('a zero rate is a real loan', parseLedgerPrefill({ rate: '0' }), { rate: 0 });
eq('compounding outside 1–365 is dropped', parseLedgerPrefill({ type: 'compound', perYear: '0' }), { interest_type: 'compound' });
eq('fractional compounding is dropped', parseLedgerPrefill({ type: 'compound', perYear: '2.5' }), { interest_type: 'compound' });
eq('an end before the start is dropped', parseLedgerPrefill({ start: String(start), end: String(start - DAY) }), { start_date: start });
eq('array params use the first value', parseLedgerPrefill({ principal: ['500', '900'] }), { principal: 500 });
eq('no params, no prefill', parseLedgerPrefill({}), {});

console.log(`ledgerPrefill.selftest: ${n} checks passed`);
