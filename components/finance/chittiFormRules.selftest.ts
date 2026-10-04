// components/finance/chittiFormRules.selftest.ts — run: npx tsx components/finance/chittiFormRules.selftest.ts
//
// The checks app/finance/chitti/new.tsx runs before Create, and the fields it
// marks inline after a refused Create.

import assert from 'node:assert/strict';
import { checkChittiForm, type ChittiFormText } from './chittiFormRules';

let n = 0;
const eq = (label: string, a: unknown, b: unknown) => { assert.deepEqual(a, b, label); n++; };
const good: ChittiFormText = { name: ' Sundar ', chitValue: '1,00,000', installment: '5000', members: '20', duration: '20' };
const field = (f: Partial<ChittiFormText>) => { const r = checkChittiForm({ ...good, ...f }); return 'problem' in r ? r.problem.field : 'ok'; };

eq('a good form passes, trimmed and parsed', checkChittiForm(good),
  { ok: { name: 'Sundar', chitValue: 100000, installment: 5000, members: 20, duration: 20 } });
eq('blank name', field({ name: '  ' }), 'name');
eq('zero chit value', field({ chitValue: '0' }), 'chitValue');
eq('decimal-comma chit value is refused', field({ chitValue: '12,5' }), 'chitValue');
eq('blank installment', field({ installment: '' }), 'installment');
eq('fractional members', field({ members: '0.4' }), 'members');
eq('zero members', field({ members: '0' }), 'members');
eq('fractional duration', field({ duration: '2.5' }), 'duration');
eq('one member and one month are allowed', field({ members: '1', duration: '1' }), 'ok');
// The installment × members mismatch is a question on Create, not a refusal.
eq('a mismatch is not a form problem', field({ installment: '4000' }), 'ok');

const all = checkChittiForm({ name: '', chitValue: '', installment: '', members: 'x', duration: '0' });
eq('every failing field is listed, in form order',
  'problems' in all && all.problems.map((p) => p.field), ['name', 'chitValue', 'installment', 'members', 'duration']);
eq('the first one leads the Alert', 'problem' in all && all.problem.title, 'Name');

console.log(`chittiFormRules.selftest: ${n} checks passed`);
