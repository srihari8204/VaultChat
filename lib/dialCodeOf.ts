// lib/dialCodeOf.ts — the dial code a phone-entry field should start on.
//
// New-contact entry used to start on a hard-coded '+91', so everyone outside
// India had to change it before typing a number. The user's own E.164 number is
// the best signal the app has for "which country are my contacts in" (there is
// no localization module installed). Pure, so the selftest runs under tsx.
import { COUNTRIES, DEFAULT_COUNTRY } from '../constants/countries';

/** The longest known dial code that prefixes `phone`, else `fallback`. */
export function dialCodeOf(phone: string | null | undefined, fallback: string = DEFAULT_COUNTRY.dial): string {
  const p = String(phone ?? '').replace(/[^\d+]/g, '');
  if (!p.startsWith('+')) return fallback;
  let best = '';
  for (const c of COUNTRIES) if (p.startsWith(c.dial) && c.dial.length > best.length) best = c.dial;
  return best || fallback;
}
