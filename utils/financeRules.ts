// utils/financeRules.ts — pure Vault Finance rules shared by the screens and db.
//
// Everything here is a decision the app used to make in several places, each
// slightly differently: how much interest a ledger carries, when a loan is
// overdue, when a Lucky Draw group has run its course, when a recurring
// reminder next falls due, whether a typed amount matches a stored one. One
// copy, no I/O, asserted by utils/financeRules.selftest.ts.

import { simpleInterest, compoundInterest, round2 } from './interest';
import { periodRateToAnnualPct, type LedgerPeriod } from './finance';
import { toPaise } from './money';

// ── Dates ─────────────────────────────────────────────────────────────
/** Local midnight of the day `ms` falls on. */
export function startOfDay(ms: number): number {
  const d = new Date(ms);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

/**
 * `n` calendar months after `ms`, same time of day. The day is clamped to the
 * target month's length, so 31 Jan + 1 month is 28/29 Feb, not 2/3 March —
 * and the clamp is per call, so +2 months from 31 Jan is 31 Mar again.
 */
export function addMonths(ms: number, n: number): number {
  const d = new Date(ms);
  const t = new Date(d.getFullYear(), d.getMonth() + n, 1, d.getHours(), d.getMinutes(), d.getSeconds(), d.getMilliseconds());
  const last = new Date(t.getFullYear(), t.getMonth() + 1, 0).getDate();
  t.setDate(Math.min(d.getDate(), last));
  return t.getTime();
}

function addDays(ms: number, n: number): number {
  const d = new Date(ms);
  d.setDate(d.getDate() + n);   // calendar days: a DST change does not shift the time
  return d.getTime();
}

/** End date is a calendar day: a loan is past due once that whole day is over. */
export function isPastDue(endDate: number | null | undefined, now: number): boolean {
  return endDate != null && startOfDay(now) > startOfDay(endDate);
}

/** An end date may equal the start date, never fall before it. */
export function ledgerDatesProblem(start: number, end: number | null): string | null {
  return end != null && startOfDay(end) < startOfDay(start)
    ? 'The end date cannot be before the start date.'
    : null;
}

// ── Mobile numbers ────────────────────────────────────────────────────
/**
 * Loose validator for an Indian mobile number: 10 digits, optional +91/91/0
 * prefix, tolerant of spaces/hyphens/parens the user typed. Returns the
 * normalized 10-digit form, or null if the input doesn't look like a mobile
 * number. Lives here (pure) so the CSV importer and the forms can share it;
 * db/chitti.ts re-exports it.
 */
export function normalizeMobile(raw: string): string | null {
  let s = (raw ?? '').replace(/[\s\-()]/g, '');
  if (s.startsWith('+')) s = s.slice(1);
  // Strip a country code / trunk prefix ONLY when what remains is still a
  // 10-digit number. A valid mobile can itself begin with "91" (9123456789),
  // so an unconditional strip would eat its first two digits and reject it.
  if (s.length === 12 && s.startsWith('91')) s = s.slice(2);
  else if (s.length === 11 && s.startsWith('0')) s = s.slice(1);
  return /^[6-9]\d{9}$/.test(s) ? s : null;
}

// ── Ledger interest and status ────────────────────────────────────────
export interface LedgerTerms {
  principal: number; rate: number; rate_mode: 'rupees' | 'percent'; period: LedgerPeriod;
  interest_type: 'simple' | 'compound'; start_date: number; end_date: number | null;
}

/**
 * Interest over the ledger's term — the ONE calculator the ledger detail,
 * dashboard and reports all use. Compound ledgers compound yearly. Without an
 * end date the term is one year and `projected` is true, so the caller can say
 * so instead of presenting a guess as a due amount.
 */
export function ledgerInterest(e: LedgerTerms) {
  const annual = periodRateToAnnualPct(e.rate, e.rate_mode, e.period);
  const years = e.end_date ? Math.max(0, (e.end_date - e.start_date) / 31536000000) : 1;
  const res = e.interest_type === 'simple'
    ? simpleInterest(e.principal, annual, years)
    : compoundInterest(e.principal, annual, years, 1);
  return { interest: round2(res.interest), total: round2(res.total), years, annual, projected: !e.end_date };
}

export type LedgerStatus = 'running' | 'overdue' | 'completed';

/**
 * The status a ledger should have now. Completed is final. A balance at zero
 * is completed. A balance left after the end day is overdue; an overdue loan
 * whose end date was moved later is running again. A stored 'overdue' with no
 * end date (CSV import) is left alone — nothing here can contradict it.
 */
export function ledgerStatusFor(
  e: { status: LedgerStatus; remaining: number; end_date: number | null }, now: number,
): LedgerStatus {
  if (e.status === 'completed') return 'completed';
  if (!(e.remaining > 0)) return 'completed';
  if (isPastDue(e.end_date, now)) return 'overdue';
  if (e.status === 'overdue' && e.end_date != null) return 'running';
  return e.status;
}

// ── Lucky Draw groups ─────────────────────────────────────────────────
export type ChittiStatus = 'active' | 'closed' | 'draft';

/** Month m's auction (1-based) falls m calendar months after the start. */
export function auctionDate(start: number, month: number): number {
  return addMonths(start, month);
}

/** The day of the group's last auction. */
export function chittiTermEnd(g: { start_date: number; duration: number }): number {
  return auctionDate(g.start_date, Math.max(0, Math.round(g.duration)));
}

/**
 * An ACTIVE group closes the day after its last auction. Draft and closed are
 * the organiser's own choices and are never changed here.
 */
export function groupStatusFor(
  g: { status: ChittiStatus; start_date: number; duration: number }, now: number,
): ChittiStatus {
  return g.status === 'active' && g.duration > 0 && isPastDue(chittiTermEnd(g), now) ? 'closed' : g.status;
}

/** The first auction today or later, or null once every month has passed. */
export function nextAuction(
  g: { start_date: number; duration: number }, now: number,
): { month: number; at: number } | null {
  const today = startOfDay(now);
  const n = Math.min(Math.max(0, Math.round(g.duration)), 1200);
  for (let m = 1; m <= n; m++) {
    const at = auctionDate(g.start_date, m);
    if (startOfDay(at) >= today) return { month: m, at };
  }
  return null;
}

// ── Reminders ─────────────────────────────────────────────────────────
export type ReminderFreq = 'once' | 'daily' | 'weekly' | 'monthly' | 'yearly';

/** The k-th occurrence after `anchor` (k = 0 is the anchor). Months are
 *  counted from the anchor each time, so a day-31 reminder keeps day 31. */
export function occurrence(freq: ReminderFreq, anchor: number, k: number): number {
  switch (freq) {
    case 'daily': return addDays(anchor, k);
    case 'weekly': return addDays(anchor, 7 * k);
    case 'monthly': return addMonths(anchor, k);
    case 'yearly': return addMonths(anchor, 12 * k);
    default: return anchor;
  }
}

/** Far more steps than any real gap needs (daily for 50 years). */
const MAX_STEPS = 20000;

/**
 * The first occurrence at or after `from`. A one-off never moves; a recurring
 * reminder already at or after `from` is unchanged.
 */
export function nextOccurrence(freq: ReminderFreq, anchor: number, from: number): number {
  if (freq === 'once' || anchor >= from) return anchor;
  for (let k = 1; k <= MAX_STEPS; k++) {
    const at = occurrence(freq, anchor, k);
    if (at >= from) return at;
  }
  return anchor;
}

/** Every occurrence in [from, to), starting at the anchor (none before it). */
export function occurrencesBetween(freq: ReminderFreq, anchor: number, from: number, to: number): number[] {
  if (freq === 'once') return anchor >= from && anchor < to ? [anchor] : [];
  const out: number[] = [];
  for (let k = 0; k <= MAX_STEPS; k++) {
    const at = occurrence(freq, anchor, k);
    if (at >= to) break;
    if (at >= from) out.push(at);
  }
  return out;
}

/**
 * Recurring reminders whose `next_at` is on an earlier day than `now`, moved
 * to their next occurrence from the start of today — so a daily 9am reminder
 * still counts as due today at 10am. One-offs and done reminders stay put.
 */
export function advanceReminders<T extends { id: string; freq: ReminderFreq; next_at: number; status: string }>(
  rows: T[], now: number,
): { id: string; next_at: number }[] {
  const today = startOfDay(now);
  const out: { id: string; next_at: number }[] = [];
  for (const r of rows) {
    if (r.status !== 'active' || r.freq === 'once' || r.next_at >= today) continue;
    const next = nextOccurrence(r.freq, r.next_at, today);
    if (next !== r.next_at) out.push({ id: r.id, next_at: next });
  }
  return out;
}

// ── Search ────────────────────────────────────────────────────────────
/**
 * Does a typed amount match a stored one? A whole-rupee query matches amounts
 * whose rupee digits START with it (typing "50" finds ₹5,000 and ₹50,000,
 * not every amount above ₹50). A query with paise must match exactly.
 */
export function amountMatches(query: number, value: number): boolean {
  if (!(query > 0) || !Number.isFinite(value) || value < 0) return false;
  if (!Number.isInteger(query)) return toPaise(query) === toPaise(value);
  return String(Math.trunc(value)).startsWith(String(query));
}

/**
 * Is this ledger row the customer being viewed? When both sides have a valid
 * mobile number, the number decides (two people called "Ramesh" are two
 * customers; one person typed as "Ramesh" and "Ramesh K" is one). Otherwise
 * the trimmed, case-insensitive name decides.
 */
export function sameCustomer(
  row: { name: string; mobile: string | null }, name: string, mobile?: string | null,
): boolean {
  const want = normalizeMobile(mobile ?? '');
  const have = normalizeMobile(row.mobile ?? '');
  if (want && have) return want === have;
  return row.name.trim().toLowerCase() === String(name ?? '').trim().toLowerCase();
}
