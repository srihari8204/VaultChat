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
  if (months <= 0 || principal <= 0) return { emi: 0, totalPayment: 0, totalInterest: 0 };
  const r = annualRatePct / 12 / 100;
  const e = r === 0 ? principal / months : (principal * r * Math.pow(1 + r, months)) / (Math.pow(1 + r, months) - 1);
  const total = e * months;
  return { emi: round2(e), totalPayment: round2(total), totalInterest: round2(total - principal) };
}

// ── Home-loan part payment ──────────────────────────────────────
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
    newMonths = denom <= 0 ? months : Math.ceil(Math.log(old.emi / denom) / Math.log(1 + r));
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
