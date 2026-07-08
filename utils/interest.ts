// utils/interest.ts — pure interest math + INR formatting (no side effects; unit-testable).

export type InterestType = 'simple' | 'compound';

export interface InterestResult {
  interest: number;
  total: number;
}

/** SI = (P × R × T) / 100 ; total = P + SI */
export function simpleInterest(principal: number, ratePct: number, years: number): InterestResult {
  const interest = (principal * ratePct * years) / 100;
  return { interest, total: principal + interest };
}

/** A = P × (1 + (R/100)/n)^(n×T) ; CI = A − P
 *  Sanity: P=10000, R=5, T=2, n=4 → A = 10000·(1.0125)^8 = 11044.86 (CI = 1044.86).
 *  (The spec's "11048.96" is a transposed-digit typo; this follows the stated formula.) */
export function compoundInterest(principal: number, ratePct: number, years: number, freq: number): InterestResult {
  const n = freq > 0 ? freq : 1;
  const total = principal * Math.pow(1 + (ratePct / 100) / n, n * years);
  return { interest: total - principal, total };
}

/** Round to 2 decimals for consistent display + storage. */
export function round2(n: number): number {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

/** Indian-locale currency (₹, lakh/crore grouping). Falls back if Intl is missing. */
export function formatINR(amount: number): string {
  try {
    return new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR', maximumFractionDigits: 2 }).format(amount);
  } catch {
    return '₹' + round2(amount).toLocaleString('en-IN');
  }
}

export const FREQUENCIES: { label: string; value: number }[] = [
  { label: 'Annually',      value: 1 },
  { label: 'Semi-annually', value: 2 },
  { label: 'Quarterly',     value: 4 },
  { label: 'Monthly',       value: 12 },
  { label: 'Daily',         value: 365 },
];

export function freqLabel(value: number | null | undefined): string {
  return FREQUENCIES.find(f => f.value === value)?.label ?? '—';
}
