// utils/financeFormat.ts — small display helpers shared across finance screens.

import { formatINR, round2 } from './interest';

export { formatINR, round2 };

/** Parse a user-entered numeric string; NaN when blank/invalid. */
export const num = (s: string): number => {
  const n = Number((s ?? '').toString().replace(/,/g, ''));
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
