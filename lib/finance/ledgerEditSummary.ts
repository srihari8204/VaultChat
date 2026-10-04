// lib/finance/ledgerEditSummary.ts — what a ledger edit changed, "was → now",
// for the timeline entry db/ledger.ts updateLedgerDetails writes. It used to
// record only the new terms, so the history could not say what had changed.
// Pure, asserted by ledgerEditSummary.selftest.ts.

import type { LedgerTerms } from '../../utils/financeRules';
import { ledgerInterestTypeLabel } from './compounding';
import { fmtDate } from '../../utils/financeFormat';

export type LedgerEditable = Pick<LedgerTerms, 'principal' | 'rate' | 'rate_mode' | 'period' | 'interest_type' | 'start_date' | 'end_date' | 'compounding'> & {
  name: string; mobile: string | null; notes: string | null;
};

const rupees = (n: number) => `₹${n.toLocaleString('en-IN')}`;
const rateText = (e: Pick<LedgerEditable, 'rate' | 'rate_mode'>) => `${e.rate}${e.rate_mode === 'rupees' ? '₹ per ₹100' : '%'}`;
const endText = (ms: number | null) => (ms ? fmtDate(ms) : 'none');

/** "Rate 2% → 3% · End date none → 01/06/2027", or a plain note when nothing changed. */
export function ledgerEditSummary(was: LedgerEditable, now: LedgerEditable): string {
  const parts: string[] = [];
  const diff = (label: string, a: string, b: string) => { if (a !== b) parts.push(`${label} ${a} → ${b}`); };
  diff('Name', was.name, now.name);
  diff('Mobile', was.mobile ?? 'none', now.mobile ?? 'none');
  diff('Principal', rupees(was.principal), rupees(now.principal));
  diff('Rate', rateText(was), rateText(now));
  diff('Period', was.period, now.period);
  diff('Interest', ledgerInterestTypeLabel(was), ledgerInterestTypeLabel(now));
  diff('Start date', fmtDate(was.start_date), fmtDate(now.start_date));
  diff('End date', endText(was.end_date), endText(now.end_date));
  // Notes can be long and private-ish; the history says they changed, not what to.
  if ((was.notes ?? '') !== (now.notes ?? '')) parts.push('Notes edited');
  return parts.length ? `Terms edited · ${parts.join(' · ')}` : 'Saved with no changes';
}
