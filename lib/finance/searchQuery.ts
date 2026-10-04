// lib/finance/searchQuery.ts — what a typed finance search matches a stored
// mobile number against. Pure; asserted by lib/finance/searchQuery.selftest.ts.
//
// Mobiles are stored as 10 bare digits (utils/financeRules normalizeMobile), so
// a query typed the way people write numbers — "+91 98765 43210", "98765-43210",
// "098765…" — matched nothing. A phone-shaped query is reduced to digits, with
// a country code or trunk 0 dropped, and that is what is looked for.

/** The digits to look for in a stored mobile, or null if the query is not phone-shaped. */
export function phoneDigits(query: string): string | null {
  const q = query.trim();
  // Only digits and the separators people type in a number.
  if (!/^\+?[\d\s\-().]+$/.test(q)) return null;
  let d = q.replace(/\D/g, '');
  // A country code or trunk 0 is not part of a stored mobile. After a "+",
  // "91" is always the country code; without one, a leading "91" or "0" is
  // dropped only from a query longer than a mobile (a mobile may start 91).
  if (q.startsWith('+') && d.startsWith('91')) d = d.slice(2);
  else if (d.length > 10 && d.startsWith('91')) d = d.slice(2);
  else if (d.length > 10 && d.startsWith('0')) d = d.slice(1);
  // At least 3 digits of the MOBILE itself, counted after the prefix is gone:
  // "+9198" left "98", which is in most mobiles.
  return d.length >= 3 ? d : null;
}

/** Does a stored mobile match the query (as typed, or as phone digits)? */
export function mobileMatches(stored: string | null | undefined, query: string): boolean {
  if (!stored) return false;
  const plain = query.trim().toLowerCase();
  if (plain && stored.toLowerCase().includes(plain)) return true;
  const digits = phoneDigits(query);
  return !!digits && stored.replace(/\D/g, '').includes(digits);
}
