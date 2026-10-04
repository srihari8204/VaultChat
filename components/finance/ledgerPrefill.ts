// components/finance/ledgerPrefill.ts — the calculator's "Save as ledger".
//
// app/finance/interest.tsx hands its result's terms to app/finance/ledger/new
// as route params, so a ledger made from a calculation compounds exactly as
// the calculation did (the two defaults differ: fix_status §5). Route params
// are strings from outside the form (a link can carry anything), so the parse
// keeps only well-formed values; the form still runs its own checks on Save.
// Pure, asserted by ledgerPrefill.selftest.ts.

import type { LedgerPeriod } from '../../utils/finance';
import type { LedgerFormValues } from './LedgerForm';

export type LedgerPrefill = Partial<Pick<LedgerFormValues,
  'interest_type' | 'principal' | 'rate' | 'rate_mode' | 'period' | 'start_date' | 'end_date' | 'compounding'>>;

export interface LedgerPrefillParams {
  [k: string]: string;
  type: string; principal: string; rate: string; rateMode: string; period: string;
  perYear: string; start: string; end: string;
}

/** The params interest.tsx pushes for a calculated result. */
export function ledgerPrefillParams(r: {
  type: 'simple' | 'compound'; principal: number; rate: number; rateMode: 'percent' | 'rupees';
  period: LedgerPeriod; perYear: number; start: number; end: number;
}): LedgerPrefillParams {
  return {
    type: r.type, principal: String(r.principal), rate: String(r.rate), rateMode: r.rateMode,
    period: r.period, perYear: String(r.perYear), start: String(Math.round(r.start)), end: String(Math.round(r.end)),
  };
}

const PERIODS: readonly LedgerPeriod[] = ['daily', 'weekly', 'monthly', 'yearly'];
const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);
const number = (v: string | string[] | undefined) => {
  const s = one(v);
  if (s == null || s.trim() === '') return undefined;
  const n = Number(s);
  return Number.isFinite(n) ? n : undefined;
};

/** Well-formed prefill values from route params; anything else is left out. */
export function parseLedgerPrefill(p: Record<string, string | string[] | undefined>): LedgerPrefill {
  const out: LedgerPrefill = {};
  const type = one(p.type);
  if (type === 'simple' || type === 'compound') out.interest_type = type;
  const principal = number(p.principal);
  if (principal != null && principal > 0) out.principal = principal;
  const rate = number(p.rate);
  if (rate != null && rate >= 0) out.rate = rate;
  const mode = one(p.rateMode);
  if (mode === 'percent' || mode === 'rupees') out.rate_mode = mode;
  const period = one(p.period);
  if (PERIODS.includes(period as LedgerPeriod)) out.period = period as LedgerPeriod;
  const perYear = number(p.perYear);
  if (out.interest_type === 'compound' && perYear != null && Number.isInteger(perYear) && perYear >= 1 && perYear <= 365) {
    out.compounding = perYear;
  }
  const start = number(p.start), end = number(p.end);
  if (start != null && start > 0) {
    out.start_date = start;
    if (end != null && end > start) out.end_date = end;
  }
  return out;
}
