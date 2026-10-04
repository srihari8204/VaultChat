// components/finance/ledgerCsv.ts — the ledger CSV format: write, parse, plan an
// import. Pure (no DB, no files), so the whole round trip is asserted in
// ledgerCsv.selftest.ts.
//
// What this fixes over the old inline code in app/finance/io.tsx:
//  - FORMULA INJECTION. A name or note starting with = + - @ (or a tab / CR)
//    is run as a formula by Excel and Sheets when the CSV is opened. Such
//    text cells are written with a leading apostrophe, and the apostrophe is
//    removed again on import.
//  - MULTI-LINE NOTES. The importer split the file on newlines BEFORE parsing
//    quotes, so a quoted note with a line break corrupted its row and the next.
//    The parser now reads the file as a whole.
//  - LOAN DATES. StartDate / EndDate were not exported, and import reset the
//    start to "now" and dropped the end. They are now written as ISO dates.
//  - RE-IMPORT. Every import minted new rows, so importing the same file twice
//    doubled the ledger book. Rows matching an existing ledger are skipped.
//  - SILENT DROPS. Rows with an unreadable principal were dropped uncounted.

import type { LedgerEntry } from '../../db/ledger';
import type { LedgerPeriod } from '../../utils/finance';
import { fmtDate, num as parseAmount } from '../../utils/financeFormat';

export const LEDGER_HEADERS = [
  'Name', 'Mobile', 'Direction', 'InterestType', 'Principal', 'Rate', 'RateMode', 'Period',
  'Remaining', 'Status', 'Notes', 'Created', 'StartDate', 'EndDate',
];

// ── writing ─────────────────────────────────────────────────────────

const FORMULA_START = /^[=+\-@\t\r]/;

/** One CSV cell: formula-neutralised text, quoted when it needs to be. Numbers
 *  are written as numbers (a negative number is data, not a formula). */
export function csvCell(v: string | number | null | undefined): string {
  if (typeof v === 'number') return Number.isFinite(v) ? String(v) : '';
  let s = String(v ?? '');
  if (FORMULA_START.test(s)) s = `'${s}`;
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function toCsv(headers: string[], rows: (string | number | null)[][]): string {
  return [headers, ...rows].map(r => r.map(csvCell).join(',')).join('\r\n');
}

/** ISO date for a date column; '' for none. */
const isoOrBlank = (ms: number | null | undefined) =>
  ms != null && Number.isFinite(ms) ? new Date(ms).toISOString() : '';

export function ledgerCsvRow(l: LedgerEntry): (string | number)[] {
  return [
    l.name, l.mobile ?? '', l.direction, l.interest_type, l.principal, l.rate, l.rate_mode, l.period,
    l.remaining, l.status, l.notes ?? '', fmtDate(l.created_at), isoOrBlank(l.start_date), isoOrBlank(l.end_date),
  ];
}

// ── reading ─────────────────────────────────────────────────────────

/** RFC 4180 parser over the WHOLE text: quoted cells may hold commas, quotes
 *  and line breaks. Blank lines are dropped. */
export function parseCsv(text: string): string[][] {
  const src = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  const rows: string[][] = [];
  let row: string[] = [];
  let cur = '';
  let q = false;
  const endRow = () => {
    row.push(cur); cur = '';
    if (row.length > 1 || row[0].trim() !== '') rows.push(row);
    row = [];
  };
  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (q) {
      if (ch === '"' && src[i + 1] === '"') { cur += '"'; i++; }
      else if (ch === '"') q = false;
      else cur += ch;
    } else if (ch === '"') q = true;
    else if (ch === ',') { row.push(cur); cur = ''; }
    else if (ch === '\r' && src[i + 1] === '\n') { endRow(); i++; }
    else if (ch === '\n' || ch === '\r') endRow();
    else cur += ch;
  }
  if (cur !== '' || row.length > 0) endRow();
  return rows;
}

/** Undo csvCell's formula guard. Only an apostrophe WE could have added (one
 *  followed by a formula character) is removed. */
export function uncell(s: string | undefined): string {
  const v = s ?? '';
  return v.startsWith("'") && FORMULA_START.test(v.slice(1)) ? v.slice(1) : v;
}

/** Identity of a ledger for de-duplication: who, which way, how much, from when. */
export function ledgerKey(name: string, direction: string, principal: number, startMs: number): string {
  return `${name.trim().toLowerCase()}|${direction}|${Math.round(principal * 100)}|${new Date(startMs).toISOString().slice(0, 10)}`;
}

export interface ImportPlan {
  rows: Omit<LedgerEntry, 'id' | 'user_id' | 'created_at' | 'last_updated'>[];
  duplicates: number;       // already in the ledger book (or twice in the file)
  badPrincipal: number;     // principal missing, zero or unreadable
  badRemaining: number;     // Remaining present but unreadable
  badDate: number;          // StartDate / EndDate present but unreadable
}

/**
 * Decide what an import would do, without writing anything. `now` is the
 * start date for files exported before StartDate existed.
 */
export function planLedgerImport(text: string, existing: LedgerEntry[], now: number): ImportPlan {
  const plan: ImportPlan = { rows: [], duplicates: 0, badPrincipal: 0, badRemaining: 0, badDate: 0 };
  const [header, ...body] = parseCsv(text);
  if (!header) return plan;
  const col = (name: string) => header.findIndex(h => h.trim().toLowerCase() === name.toLowerCase());
  const at = (c: string[], name: string, fallback: number) => {
    const i = col(name);
    return uncell(c[i >= 0 ? i : fallback]);
  };
  const seen = new Set(existing.map(l => ledgerKey(l.name, l.direction, l.principal, l.start_date)));
  // Files without a StartDate column can only be matched on the Created day.
  const seenCreated = new Set(existing.map(l => `${l.name.trim().toLowerCase()}|${l.direction}|${Math.round(l.principal * 100)}|${fmtDate(l.created_at)}`));
  const amount = (v: string) => { const n = parseAmount(v); return Number.isFinite(n) ? n : 0; };
  const date = (v: string): number | null | undefined => {
    const t = v.trim();
    if (t === '') return null;
    const ms = Date.parse(t);
    return Number.isFinite(ms) ? ms : undefined;   // undefined = unreadable
  };

  for (const c of body) {
    const name = at(c, 'Name', 0).trim();
    if (!name) continue;
    const principal = parseAmount(at(c, 'Principal', 4));
    if (!(Number.isFinite(principal) && principal > 0)) { plan.badPrincipal++; continue; }
    // Blank Remaining = the principal (no column); unreadable = skip, never guess:
    // guessing restored the full principal on a settled ledger.
    const remCell = at(c, 'Remaining', 8).trim();
    const rem = parseAmount(remCell);
    if (remCell !== '' && !Number.isFinite(rem)) { plan.badRemaining++; continue; }
    const start = date(at(c, 'StartDate', 12));
    const end = date(at(c, 'EndDate', 13));
    if (start === undefined || end === undefined) { plan.badDate++; continue; }
    const direction = at(c, 'Direction', 2) === 'borrow' ? 'borrow' : 'lend';
    const startDate = start ?? now;
    const key = ledgerKey(name, direction, principal, startDate);
    const createdKey = `${name.toLowerCase()}|${direction}|${Math.round(principal * 100)}|${at(c, 'Created', 11).trim()}`;
    if (seen.has(key) || (start === null && seenCreated.has(createdKey))) { plan.duplicates++; continue; }
    seen.add(key);
    const period = at(c, 'Period', 7);
    const status = at(c, 'Status', 9);
    plan.rows.push({
      direction, name, mobile: at(c, 'Mobile', 1).trim() || null,
      interest_type: at(c, 'InterestType', 3) === 'compound' ? 'compound' : 'simple',
      principal, rate: amount(at(c, 'Rate', 5)),
      rate_mode: at(c, 'RateMode', 6) === 'rupees' ? 'rupees' : 'percent',
      period: (['daily', 'weekly', 'monthly', 'yearly'].includes(period) ? period : 'monthly') as LedgerPeriod,
      start_date: startDate, end_date: end, notes: at(c, 'Notes', 10).trim() || null,
      remaining: remCell === '' ? principal : rem,
      status: (['running', 'overdue', 'completed'].includes(status) ? status : 'running') as LedgerEntry['status'],
    });
  }
  return plan;
}
