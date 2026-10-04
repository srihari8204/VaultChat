// lib/onboardDate.ts — a date of birth as a CALENDAR date, both ways. Pure.
//
// The DOB picker hands back a Date at local midnight and the onboarding store
// keeps 'YYYY-MM-DD'. Both directions used to go through UTC:
//   • out: toISOString() — east of UTC (all of India) stored the PREVIOUS day;
//   • back: new Date('YYYY-MM-DD') — parsed as UTC midnight, so west of UTC
//     returning to the profile step showed (and re-saved) the previous day.
// Both read and write local fields here. Node-tested in onboardDate.selftest.ts.

/** Date → 'YYYY-MM-DD' from its LOCAL fields. */
export function toLocalIsoDate(d: Date): string {
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${d.getFullYear()}-${mm}-${dd}`;
}

/** 'YYYY-MM-DD' → a Date at LOCAL midnight; null for anything else. */
export function fromLocalIsoDate(v: string | null | undefined): Date | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(v ?? '');
  return m ? new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])) : null;
}
