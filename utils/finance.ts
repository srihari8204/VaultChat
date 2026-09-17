// utils/finance.ts — pure financial math for the calculator mini-app (unit-testable).
//
// Covers Indian informal-lending conventions: interest rate can be a PERCENT
// (per annum) OR "rupees" (₹ per ₹100 per month — the classic "byaj" rate),
// plus EMI, home-loan part-payment, EMI comparison and gold-loan eligibility.

import { round2 } from './interest';

// ── Rate helpers ────────────────────────────────────────────────
/** "rupees" rate = ₹ per ₹100 per MONTH → annual %.  e.g. ₹2 → 24% p.a. */
export function rupeeRateToAnnualPct(rupeePer100PerMonth: number): number {
  return rupeePer100PerMonth * 12;
}

// ── Time helpers ────────────────────────────────────────────────
export function yearsBetween(fromMs: number, toMs: number): number {
  return Math.max(0, (toMs - fromMs) / 86400000) / 365;
}
/** Break a fractional-year duration into y / m / d for display. */
export function splitDuration(years: number): { y: number; m: number; d: number } {
  const totalDays = Math.round(years * 365);
  return { y: Math.floor(totalDays / 365), m: Math.floor((totalDays % 365) / 30), d: (totalDays % 365) % 30 };
}

// ── EMI ─────────────────────────────────────────────────────────
export interface EmiResult { emi: number; totalPayment: number; totalInterest: number; }
/** EMI = P·r·(1+r)^n / ((1+r)^n − 1), r = monthly rate, n = months. */
export function emi(principal: number, annualRatePct: number, months: number): EmiResult {
  // `x <= 0` is FALSE for NaN, so the old guard waved NaN straight through and
  // every caller got a NaN EMI it then rendered and exported. Written as
  // `!(x > 0)` the guard rejects NaN as well as zero and negatives. The rate is
  // checked separately because 0% is a legitimate loan (handled below) while a
  // half-typed rate — num('1,2') is NaN — is not (2026-09-17).
  if (!(months > 0) || !(principal > 0) || !Number.isFinite(annualRatePct)) {
    return { emi: 0, totalPayment: 0, totalInterest: 0 };
  }
  const r = annualRatePct / 12 / 100;
  const e = r === 0 ? principal / months : (principal * r * Math.pow(1 + r, months)) / (Math.pow(1 + r, months) - 1);
  const total = e * months;
  return { emi: round2(e), totalPayment: round2(total), totalInterest: round2(total - principal) };
}

// ── Amortization schedule ───────────────────────────────────────
export interface AmortRow { month: number; emi: number; principal: number; interest: number; balance: number; }
/** Month-by-month EMI split into principal / interest with the running balance. */
export function amortization(principal: number, annualRatePct: number, months: number): AmortRow[] {
  // One guard, not two: emi() already rejects NaN, zero and negative inputs and
  // answers 0, so a non-positive EMI means there is no schedule to draw. Keeping
  // the check here in sync with emi()'s by hand is how NaN got in the first time
  // — the screen re-runs this on every keystroke of the live amount/rate
  // strings, so a half-typed field must yield no rows, not NaN rows (2026-09-17).
  const e = emi(principal, annualRatePct, months).emi;
  if (!(e > 0)) return [];
  const r = annualRatePct / 12 / 100;
  const rows: AmortRow[] = [];
  let bal = principal;
  for (let m = 1; m <= months; m++) {
    const interest = round2(bal * r);
    let princ = round2(e - interest);
    bal = round2(bal - princ);
    if (m === months || bal < 0) { princ = round2(princ + bal); bal = 0; }  // absorb rounding on the last row
    rows.push({ month: m, emi: round2(princ + interest), principal: princ, interest, balance: bal });
  }
  return rows;
}

/** Convert an interest "period" to an annualised percent for the ledger. */
export type LedgerPeriod = 'daily' | 'weekly' | 'monthly' | 'yearly';
export function periodRateToAnnualPct(rate: number, mode: 'rupees' | 'percent', period: LedgerPeriod): number {
  // "rupees" = ₹ per ₹100 for one period; "percent" = % for one period.
  const perPeriodPct = mode === 'rupees' ? rate : rate;
  const periodsPerYear = period === 'daily' ? 365 : period === 'weekly' ? 52 : period === 'monthly' ? 12 : 1;
  return perPeriodPct * periodsPerYear;
}

// ── Home-loan part payment ──────────────────────────────────────
// ponytail: partPayment, compareLoans and goldLoan below have NO callers in
// the app (verified 2026-09-17) — they are guarded rather than deleted only
// because this working copy has no VCS, so a deletion here is not recoverable.
// Delete all three the first time this repo is under git and nothing imports
// them; financeGuards.selftest.ts is then the only edit that follows.
export interface PartPaymentResult {
  oldEmi: number; newEmi: number; oldMonths: number; newMonths: number;
  interestSaved: number; emiReduced: number; monthsReduced: number;
}
/**
 * Apply a lump-sum `lump` to `outstanding`, then either keep the tenure and
 * lower the EMI ('emi') or keep the EMI and shorten the tenure ('tenure').
 */
export function partPayment(
  outstanding: number, annualRatePct: number, months: number, lump: number, mode: 'emi' | 'tenure',
): PartPaymentResult {
  const r = annualRatePct / 12 / 100;
  const old = emi(outstanding, annualRatePct, months);
  // ONE ENTRY GUARD, because the 2026-09-17 flip only reached the `denom`
  // branch below and left two NaN doors open:
  //  - `r === 0` divides by `old.emi`, which emi() answers 0 for on a
  //    zero/NaN outstanding or tenure. newP / 0 is Infinity or NaN, and a NaN
  //    tenure survives the Math.max/Math.min clamp untouched.
  //  - a NaN `lump` makes newP NaN, and emi() answers a flat 0 for a NaN
  //    principal — so 'emi' mode reported "new EMI ₹0, interest saved
  //    ₹4,87,828" with total confidence about a payment that never parsed.
  // Both have the same answer: with no valid starting loan, or no valid lump,
  // there is no part payment to report. Zeros, exactly as emi() does it.
  if (!(old.emi > 0) || !(lump >= 0)) {
    return {
      oldEmi: old.emi, newEmi: old.emi, oldMonths: 0, newMonths: 0,
      interestSaved: 0, emiReduced: 0, monthsReduced: 0,
    };
  }
  const newP = Math.max(0, outstanding - lump);
  const oldInterest = old.totalInterest;

  if (mode === 'emi') {
    const ne = emi(newP, annualRatePct, months);
    return {
      oldEmi: old.emi, newEmi: ne.emi, oldMonths: months, newMonths: months,
      interestSaved: round2(oldInterest - ne.totalInterest), emiReduced: round2(old.emi - ne.emi), monthsReduced: 0,
    };
  }
  // keep EMI, solve new tenure: n = ln(E/(E − P·r)) / ln(1+r)
  let newMonths: number;
  if (r === 0) newMonths = Math.ceil(newP / old.emi);
  else {
    const denom = old.emi - newP * r;
    // Same shape as the EMI guard: `denom <= 0` passes NaN, and a NaN tenure
    // survives Math.max/Math.min below untouched. `!(denom > 0)` falls back to
    // the original tenure for a rate the EMI can never outrun AND for a rate
    // that never parsed (2026-09-17).
    newMonths = !(denom > 0) ? months : Math.ceil(Math.log(old.emi / denom) / Math.log(1 + r));
  }
  newMonths = Math.max(0, Math.min(newMonths, months));
  const newInterest = round2(old.emi * newMonths - newP);
  return {
    oldEmi: old.emi, newEmi: old.emi, oldMonths: months, newMonths,
    interestSaved: round2(oldInterest - newInterest), emiReduced: 0, monthsReduced: months - newMonths,
  };
}

// ── EMI comparison ──────────────────────────────────────────────
export interface LoanInput { amount: number; ratePct: number; months: number; }
export function compareLoans(a: LoanInput, b: LoanInput) {
  const ra = emi(a.amount, a.ratePct, a.months);
  const rb = emi(b.amount, b.ratePct, b.months);
  return {
    a: ra, b: rb,
    emiDiff: round2(Math.abs(ra.emi - rb.emi)),
    interestDiff: round2(Math.abs(ra.totalInterest - rb.totalInterest)),
    cheaper: ra.totalPayment <= rb.totalPayment ? 'A' : 'B',
  };
}

// ── Gold loan ───────────────────────────────────────────────────
export const GOLD_PURITY: { label: string; factor: number }[] = [
  { label: '24K', factor: 1.0 },
  { label: '22K', factor: 0.916 },
  { label: '20K', factor: 0.833 },
  { label: '18K', factor: 0.75 },
];
export interface GoldResult { goldValue: number; eligibleLoan: number; }
/** Eligible loan = weight(g) × ₹/g × purity × LTV%. RBI caps gold-loan LTV at 75%. */
export function goldLoan(weightG: number, ratePerGram: number, purityFactor: number, ltvPct: number): GoldResult {
  const value = weightG * ratePerGram * purityFactor;
  return { goldValue: round2(value), eligibleLoan: round2(value * ltvPct / 100) };
}
