// utils/financeFormat.ts — small display helpers shared across finance screens.

import { formatINR, round2 } from './interest';

export { formatINR, round2 };

/**
 * Parse a user-entered amount. NaN when it is not one; blank is 0.
 *
 * THE COMMA IS THE WHOLE PROBLEM. Indian users type thousands separators, so
 * stripping them is deliberate and must stay - 1,200 is 1200 and 1,00,000 is
 * one lakh. But a bare strip also turns 12,5 - the decimal comma much of the
 * world types - into 125. On a lending ledger that is a TEN TIMES error in the
 * principal, silently, with a plausible-looking number at the end of it.
 *
 * A thousands separator is always followed by exactly three digits: in Western
 * (1,200) and Indian (1,00,000) grouping alike the LAST group is three. One or
 * two digits after the final comma is a decimal comma, and is refused rather
 * than multiplied.
 *
 * Number() also accepts forms a money field never means: 0x10 is 16, 1e3 is
 * 1000, Infinity parses. Those are refused too. A trailing point survives,
 * because this runs on half-typed input while a total is on screen.
 */
export const num = (s: string): number => {
  const t = (s ?? '').toString().trim();
  if (t === '') return 0;
  if (t.includes(',')) {
    const lastGroup = t.slice(t.lastIndexOf(',') + 1);
    if (!/^[0-9]{3}([.][0-9]+)?$/.test(lastGroup)) return NaN;
  }
  const bare = t.replace(/,/g, '');
  if (bare === '' || bare === '-' || bare === '.' || bare === '-.') return NaN;
  if (!/^-?[0-9]*[.]?[0-9]*$/.test(bare)) return NaN;
  const n = Number(bare);
  return Number.isFinite(n) ? n : NaN;
};

/** dd/mm/yyyy */
export function fmtDate(ms: number): string {
  const d = new Date(ms);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${p(d.getDate())}/${p(d.getMonth() + 1)}/${d.getFullYear()}`;
}

/** e.g. "05 Aug 2026, 10:30 AM" */
export function fmtDateTime(ms: number): string {
  try {
    return new Date(ms).toLocaleString('en-IN', {
      day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit',
    });
  } catch { return fmtDate(ms); }
}

/** Compact INR for tiles: ₹12.5L / ₹3.4Cr / ₹82.5k. */
export function inrShort(amount: number): string {
  const a = Math.abs(amount);
  const sign = amount < 0 ? '-' : '';
  if (a >= 1e7) return `${sign}₹${round2(a / 1e7)}Cr`;
  if (a >= 1e5) return `${sign}₹${round2(a / 1e5)}L`;
  if (a >= 1e3) return `${sign}₹${round2(a / 1e3)}k`;
  return `${sign}₹${Math.round(a)}`;
}

export const PERIOD_LABEL: Record<string, string> = {
  daily: 'Daily', weekly: 'Weekly', monthly: 'Monthly', yearly: 'Yearly',
};
