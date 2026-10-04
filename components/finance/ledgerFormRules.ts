// components/finance/ledgerFormRules.ts — the checks a ledger form runs before
// saving. Pure, shared by LedgerForm (new and edit), asserted by
// ledgerFormRules.selftest.ts. Moved verbatim from the two screens that each
// had a copy.

import { num } from '../../utils/financeFormat';
import { normalizeMobile, ledgerDatesProblem } from '../../utils/financeRules';

export interface LedgerFormText {
  name: string; mobile: string; principal: string; rate: string; start: number; end: number | null;
}
/** Which input a problem belongs to, so the form can mark it inline. */
export type LedgerFormField = 'name' | 'principal' | 'rate' | 'mobile' | 'end';
export interface LedgerFormProblem { title: string; message: string; field: LedgerFormField }
/** Every problem (each marked at its field; `problem` is the first, for the
 *  Alert), or the checked values. */
export type LedgerFormCheck =
  | { problem: LedgerFormProblem; problems: LedgerFormProblem[] }
  | { ok: { name: string; mobile: string | null; principal: number; rate: number } };

export function checkLedgerForm(f: LedgerFormText): LedgerFormCheck {
  const no = (title: string, message: string, field: LedgerFormField): LedgerFormProblem => ({ title, message, field });
  const name = f.name.trim();
  const P = num(f.principal), R = num(f.rate);
  // Stored normalised (10 digits), like Lucky Draw members, so the customer
  // profile can match the same person typed as "+91 98765 43210" elsewhere.
  const mobile = f.mobile.trim() ? normalizeMobile(f.mobile) : null;
  const dateProblem = ledgerDatesProblem(f.start, f.end);
  // Every check runs, so the form can mark every failing field at once.
  const checks: (() => LedgerFormProblem | undefined)[] = [
    () => { if (!name) return no('Name', 'Enter a name.', 'name'); },
    () => { if (!(P > 0)) return no('Principal', 'Enter a principal greater than 0.', 'principal'); },
    // 0% IS A REAL LOAN (2026-09-17): money lent to a relative at no interest is
    // the commonest informal ledger there is, and utils/finance.ts prices a 0%
    // rate deliberately. A rate must be FINITE and NON-NEGATIVE, not positive —
    // NaN (a half-typed "1,2") and negatives are still refused.
    () => { if (!Number.isFinite(R) || R < 0) return no('Rate', 'Enter an interest rate of 0 or more.', 'rate'); },
    () => { if (f.mobile.trim() && !mobile) return no('Mobile number', 'Enter a valid 10-digit mobile number, or leave it empty.', 'mobile'); },
    () => { if (dateProblem) return no('End date', dateProblem, 'end'); },
  ];
  const problems = checks.map((c) => c()).filter((p): p is LedgerFormProblem => !!p);
  if (problems.length) return { problem: problems[0], problems };
  return { ok: { name, mobile, principal: P, rate: R } };
}
