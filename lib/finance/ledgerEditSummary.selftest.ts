// lib/finance/ledgerEditSummary.selftest.ts — run: npx tsx lib/finance/ledgerEditSummary.selftest.ts
//
// The ledger edit timeline entry says what changed ("was → now").

import assert from 'node:assert/strict';
import { ledgerEditSummary, type LedgerEditable } from './ledgerEditSummary';

let n = 0;
const eq = (label: string, a: unknown, b: unknown) => { assert.deepEqual(a, b, label); n++; };
const day = (d: number) => new Date(2026, 4, d, 10).getTime();
const base: LedgerEditable = {
  name: 'Ramesh', mobile: null, notes: null, principal: 100000, rate: 2, rate_mode: 'percent', period: 'monthly',
  interest_type: 'simple', start_date: day(1), end_date: null, compounding: null,
};

eq('nothing changed says so', ledgerEditSummary(base, { ...base }), 'Saved with no changes');
eq('a rate change shows was → now', ledgerEditSummary(base, { ...base, rate: 3 }), 'Terms edited · Rate 2% → 3%');
eq('rate mode is part of the rate', ledgerEditSummary(base, { ...base, rate_mode: 'rupees' }), 'Terms edited · Rate 2% → 2₹ per ₹100');
eq('principal in rupees', ledgerEditSummary(base, { ...base, principal: 150000 }), 'Terms edited · Principal ₹1,00,000 → ₹1,50,000');
eq('compounding alone is a change', ledgerEditSummary({ ...base, interest_type: 'compound', compounding: 1 }, { ...base, interest_type: 'compound', compounding: 12 }),
  'Terms edited · Interest Compound, compounded yearly → Compound, compounded monthly');
eq('an added end date', ledgerEditSummary(base, { ...base, end_date: day(20) }), 'Terms edited · End date none → 20/05/2026');
eq('notes say only that they changed', ledgerEditSummary(base, { ...base, notes: 'secret' }), 'Terms edited · Notes edited');
eq('several changes, in form order', ledgerEditSummary(base, { ...base, name: 'Ramesh K', period: 'yearly', mobile: '9876543210' }),
  'Terms edited · Name Ramesh → Ramesh K · Mobile none → 9876543210 · Period monthly → yearly');

console.log(`ledgerEditSummary: ${n} checks passed`);
