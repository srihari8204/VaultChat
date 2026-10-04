// components/finance/interestFormRules.selftest.ts — run: npx tsx components/finance/interestFormRules.selftest.ts
//
// The interest calculator's checks, moved out of onCalc so every failing field
// is marked inline (round 7: "Validation is still Alert-only").

import assert from 'node:assert/strict';
import { checkInterestForm, YEAR_MS, type InterestFormText } from './interestFormRules';

let n = 0;
const eq = (label: string, a: unknown, b: unknown) => { assert.deepEqual(a, b, label); n++; };
const NOW = 1_800_000_000_000;
const good: InterestFormText = { principal: '1,00,000', rate: '2', timeMode: 'dates', from: NOW - YEAR_MS, to: NOW, durY: '', durM: '', durD: '' };
const fields = (f: Partial<InterestFormText>) => {
  const r = checkInterestForm({ ...good, ...f }, NOW);
  return 'problems' in r ? r.problems.map((p) => p.field) : 'ok';
};

eq('a good dates form passes', checkInterestForm(good, NOW), { ok: { principal: 100000, rate: 2, years: 1, start: NOW - YEAR_MS } });
eq('0% is a real loan', fields({ rate: '0' }), 'ok');
eq('zero principal', fields({ principal: '0' }), ['principal']);
eq('half-typed rate', fields({ rate: '1,2' }), ['rate']);
eq('negative rate', fields({ rate: '-1' }), ['rate']);
eq('no start date', fields({ from: null }), ['from']);
eq('end not after start', fields({ to: NOW - YEAR_MS }), ['to']);
eq('every failing field is listed at once', fields({ principal: '', rate: 'x', from: null }), ['principal', 'rate', 'from']);
const first = checkInterestForm({ ...good, principal: '', rate: 'x' }, NOW);
eq('the first problem leads (for the Alert)', 'problem' in first && first.problem.title, 'Principal');

const dur = (y: string, m: string, d: string) => ({ timeMode: 'duration' as const, durY: y, durM: m, durD: d });
const ok = checkInterestForm({ ...good, ...dur('1', '6', '') }, NOW);
eq('a duration starts now and counts months as twelfths', 'ok' in ok && [ok.ok.years, ok.ok.start], [1.5, NOW]);
eq('a half-typed duration box is refused, not read as 0', fields(dur('1,2', '6', '')), ['duration']);
eq('a negative part is refused', fields(dur('2', '-6', '')), ['duration']);
eq('an empty duration is refused', fields(dur('', '', '')), ['duration']);
eq('the dates are ignored in duration mode', fields({ ...dur('1', '', ''), from: null }), 'ok');

console.log(`interestFormRules: ${n} checks passed`);
