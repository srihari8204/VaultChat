// lib/spaces/leave.ts — pure helpers for app/space-leave.tsx: local calendar
// days, and the leave-allowance editor's validation.
//
// Pure — no react-native imports — so lib/spaces/leave.selftest.ts runs under tsx.

/** The leave types the server stores an allowance for (spaces_workforce.go
 *  leaveAllowanceSet). 'other' can be requested but has no allowance. */
export const ALLOWANCE_KINDS = ['casual', 'sick', 'privilege', 'unpaid'] as const;
export type AllowanceKind = typeof ALLOWANCE_KINDS[number];

/** A Date's LOCAL calendar day as YYYY-MM-DD. Not toISOString(), which is the
 *  UTC day — a request made late in the evening east of UTC (or early in the
 *  morning west of it) would otherwise land on the wrong day. */
export function ymd(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/** YYYY-MM-DD for `n` local days from `now`. */
export function dayOffset(n: number, now = new Date()): string {
  const d = new Date(now);
  d.setDate(d.getDate() + n);
  return ymd(d);
}

/**
 * The PATCH body for the allowance editor. A blank field is left out — the
 * server then has no allowance for that type ("not set", never zero). Whole
 * days 0–365 only, matching the server.
 */
export function allowanceBody(
  form: Record<AllowanceKind, string>,
): { ok: true; body: Partial<Record<AllowanceKind, number>> } | { ok: false; error: string } {
  const body: Partial<Record<AllowanceKind, number>> = {};
  for (const k of ALLOWANCE_KINDS) {
    const t = (form[k] ?? '').trim();
    if (!t) continue;
    const n = Number(t);
    if (!/^\d+$/.test(t) || n > 365) return { ok: false, error: `${k}: use whole days from 0 to 365.` };
    body[k] = n;
  }
  if (Object.keys(body).length === 0) return { ok: false, error: 'Give at least one leave type a number of days.' };
  return { ok: true, body };
}
