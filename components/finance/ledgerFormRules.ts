// components/finance/ledgerFormRules.ts — the checks a ledger form runs before
// saving. Pure, shared by LedgerForm (new and edit), asserted by
// ledgerFormRules.selftest.ts. Moved verbatim from the two screens that each
// had a copy.

import { num } from '../../utils/financeFormat';
import { normalizeMobile, ledgerDatesProblem } from '../../utils/financeRules';

export interface LedgerFormText {
  name: string; mobile: string; principal: string; rate: string; start: number; end: number | null;
}
/** A problem to show (title + message), or the checked values. */
export type LedgerFormCheck =
  | { problem: { title: string; message: string } }
  | { ok: { name: string; mobile: string | null; principal: number; rate: number } };

export function checkLedgerForm(f: LedgerFormText): LedgerFormCheck {
  const no = (title: string, message: string): LedgerFormCheck => ({ problem: { title, message } });
  const name = f.name.trim();
  if (!name) return no('Name', 'Enter a name.');
  const P = num(f.principal), R = num(f.rate);
  if (!(P > 0)) return no('Principal', 'Enter a principal greater than 0.');
  // 0% IS A REAL LOAN (2026-09-17): money lent to a relative at no interest is
  // the commonest informal ledger there is, and utils/finance.ts prices a 0%
  // rate deliberately. A rate must be FINITE and NON-NEGATIVE, not positive —
  // NaN (a half-typed "1,2") and negatives are still refused.
  if (!Number.isFinite(R) || R < 0) return no('Rate', 'Enter an interest rate of 0 or more.');
  // Stored normalised (10 digits), like Lucky Draw members, so the customer
  // profile can match the same person typed as "+91 98765 43210" elsewhere.
  let mobile: string | null = null;
  if (f.mobile.trim()) {
    mobile = normalizeMobile(f.mobile);
    if (!mobile) return no('Mobile number', 'Enter a valid 10-digit mobile number, or leave it empty.');
  }
  const dateProblem = ledgerDatesProblem(f.start, f.end);
  if (dateProblem) return no('End date', dateProblem);
  return { ok: { name, mobile, principal: P, rate: R } };
}
