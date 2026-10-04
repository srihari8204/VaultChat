// lib/finance/compounding.ts — the interest calculator's maths, with the
// compounding frequency as a real input. Pure; asserted by
// lib/finance/compounding.selftest.ts.
//
// The calculator used to call compoundInterest(..., 1) whatever the user
// chose: "2% a month, compound" grew once a year at 24%, not monthly at 2%.
// The rate's period now sets how often it compounds by default (the way an
// informal "2 rupees per 100 a month" loan is reckoned), and the user can pick
// another frequency. Money stays in rupees here; display rounds with round2,
// exactly as before.

import { simpleInterest, compoundInterest, type InterestType } from '../../utils/interest';
import { periodRateToAnnualPct, type LedgerPeriod } from '../../utils/finance';
import { ledgerCompounding, compoundingOfAll, type LedgerTerms } from '../../utils/financeRules';

/** Compounding periods per year the calculator offers. */
export const COMPOUNDING: { n: number; label: string; adverb: string }[] = [
  { n: 1, label: 'Yearly', adverb: 'yearly' },
  { n: 4, label: 'Quarterly', adverb: 'quarterly' },
  { n: 12, label: 'Monthly', adverb: 'monthly' },
  { n: 52, label: 'Weekly', adverb: 'weekly' },
  { n: 365, label: 'Daily', adverb: 'daily' },
];

/** The compounding that matches a rate quoted per `period`. */
export function compoundingFor(period: LedgerPeriod): number {
  return { daily: 365, weekly: 52, monthly: 12, yearly: 1 }[period];
}

/** "monthly" for 12, or "12 times a year" for a value not in the list. */
export function compoundingWord(n: number): string {
  return COMPOUNDING.find(c => c.n === n)?.adverb ?? `${n} times a year`;
}

export interface CalcInput {
  type: InterestType; principal: number; rate: number; rateMode: 'percent' | 'rupees';
  period: LedgerPeriod; years: number;
  /** Compounding periods per year; ignored for simple interest. */
  perYear: number;
}

export function calculateInterest(i: CalcInput): { interest: number; total: number; annual: number } {
  const annual = periodRateToAnnualPct(i.rate, i.rateMode, i.period);
  const r = i.type === 'simple'
    ? simpleInterest(i.principal, annual, i.years)
    : compoundInterest(i.principal, annual, i.years, i.perYear);
  return { ...r, annual };
}

/** How a ledger's interest grows, said in full: "Compound, compounded yearly". */
export function ledgerInterestTypeLabel(e: Pick<LedgerTerms, 'interest_type' | 'compounding'>): string {
  return e.interest_type === 'simple' ? 'Simple' : `Compound, compounded ${compoundingWord(ledgerCompounding(e))}`;
}

/** A footnote for a total over many ledgers, or null when none is compound. */
export function ledgerCompoundingNote(rows: Pick<LedgerTerms, 'interest_type' | 'compounding'>[]): string | null {
  const { any, n } = compoundingOfAll(rows);
  if (!any) return null;
  return n != null ? `Compound loans are compounded ${compoundingWord(n)}.` : 'Compound loans are compounded as set on each ledger.';
}
