// components/finance/ledgerFormRules.selftest.ts — run: npx tsx components/finance/ledgerFormRules.selftest.ts
//
// The one set of checks the new and edit ledger forms both save through.

import assert from 'node:assert/strict';
import { checkLedgerForm, type LedgerFormText } from './ledgerFormRules';

let n = 0;
const eq = (label: string, a: unknown, b: unknown) => { assert.deepEqual(a, b, label); n++; };
const day = (d: number) => new Date(2026, 4, d, 10).getTime();
const good: LedgerFormText = { name: ' Ramesh ', mobile: '', principal: '1,00,000', rate: '2', start: day(10), end: null };
const title = (f: Partial<LedgerFormText>) => { const r = checkLedgerForm({ ...good, ...f }); return 'problem' in r ? r.problem.title : 'ok'; };

eq('a good form passes, trimmed and parsed', checkLedgerForm(good), { ok: { name: 'Ramesh', mobile: null, principal: 100000, rate: 2 } });
eq('blank name', title({ name: '  ' }), 'Name');
eq('zero principal', title({ principal: '0' }), 'Principal');
eq('decimal-comma principal is refused, not multiplied', title({ principal: '12,5' }), 'Principal');
eq('0% is a real loan', title({ rate: '0' }), 'ok');
eq('negative rate', title({ rate: '-1' }), 'Rate');
eq('half-typed rate', title({ rate: '1,2' }), 'Rate');
eq('bad mobile', title({ mobile: '12345' }), 'Mobile number');
const m = checkLedgerForm({ ...good, mobile: '+91 98765 43210' });
eq('mobile is stored normalised', 'ok' in m && m.ok.mobile, '9876543210');
eq('end before start', title({ end: day(9) }), 'End date');
eq('end on the start day', title({ end: day(10) }), 'ok');

console.log(`ledgerFormRules: ${n} assertions passed`);
