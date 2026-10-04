// components/finance/interestFormRules.ts — the checks the interest calculator
// runs before calculating. Pure, asserted by interestFormRules.selftest.ts.
// Moved from app/finance/interest.tsx's onCalc (same rules, same copy), and
// shaped like ledgerFormRules so every failing field is marked inline.

import { num } from '../../utils/financeFormat';

const YEAR_MS = 31536000000;

export interface InterestFormText {
  principal: string; rate: string; timeMode: 'dates' | 'duration';
  from: number | null; to: number; durY: string; durM: string; durD: string;
}
export type InterestFormField = 'principal' | 'rate' | 'from' | 'to' | 'duration';
export interface InterestFormProblem { title: string; message: string; field: InterestFormField }
export type InterestFormCheck =
  | { problem: InterestFormProblem; problems: InterestFormProblem[] }
  | { ok: { principal: number; rate: number; years: number; start: number } };

export function checkInterestForm(f: InterestFormText, now: number = Date.now()): InterestFormCheck {
  const no = (title: string, message: string, field: InterestFormField): InterestFormProblem => ({ title, message, field });
  const problems: InterestFormProblem[] = [];
  const P = num(f.principal), R = num(f.rate);
  if (!(P > 0)) problems.push(no('Principal', 'Enter a principal greater than 0.', 'principal'));
  // 0% is a real (family) loan — same rule as the ledger forms and EMI.
  if (!Number.isFinite(R) || R < 0) problems.push(no('Rate', 'Enter an interest rate of 0 or more.', 'rate'));
  let years = 0;
  let start = now;
  if (f.timeMode === 'dates') {
    if (!f.from) problems.push(no('From date', 'Pick a start date.', 'from'));
    else if (f.to <= f.from) problems.push(no('Dates', 'End date must be after start date.', 'to'));
    else { years = (f.to - f.from) / YEAR_MS; start = f.from; }
  } else {
    // num() returns NaN for a half-typed "1,2"; `|| 0` once turned that into a
    // believable zero before the check (2026-09-17). Blank is 0 (num('') is 0).
    const dY = num(f.durY), dM = num(f.durM), dD = num(f.durD);
    if (!Number.isFinite(dY) || !Number.isFinite(dM) || !Number.isFinite(dD)) {
      problems.push(no('Duration', 'Years, months and days must be plain numbers. Use digits only — 1200 or 1,200 both work — or leave a box empty.', 'duration'));
    } else if (dY < 0 || dM < 0 || dD < 0) {
      // "2 years, −6 months" is a typo, not an instruction.
      problems.push(no('Duration', 'Years, months and days cannot be negative.', 'duration'));
    } else {
      years = dY + dM / 12 + dD / 365;
      if (!(years > 0)) problems.push(no('Duration', 'Enter a duration greater than 0.', 'duration'));
    }
  }
  if (problems.length) return { problem: problems[0], problems };
  return { ok: { principal: P, rate: R, years, start } };
}

export { YEAR_MS };
