// utils/currencyMinor.ts — THE one place that knows how many minor units a
// currency has, and the only conversion between a displayed decimal amount and
// the int64 minor-unit integer that money is actually stored and sent as.
//
// WHY THIS EXISTS
// ---------------
// Shop Book money crossed its boundaries as a decimal `number` and every
// conversion in the codebase was a hard-coded ×100 / ÷100:
//
//   Go   internal/routes/shopbook_money.go  sbCents()/sbAmt()/money.Float()
//   TS   utils/shopbook.ts                  formatMoney()'s Math.round(n*100)
//   SQL  vaultchat-backend/migrations       NUMERIC(12,2) on every money column
//
// A hard-coded 2 has NO VALID ENCODING for a third of the world's money:
//
//   exponent 0  JPY KRW VND CLP ISK …  ¥1299 is 1299 minor units, not 129900.
//               Charging 129900 minor units is charging ¥129,900.
//   exponent 3  KWD BHD JOD TND OMR …  0.001 KD is a real amount a NUMERIC(_,2)
//               column silently rounds away, and a ×100 seam cannot express.
//
// WHAT IS DELIBERATELY *NOT* HERE
// -------------------------------
// Display. `formatMoney` in utils/shopbook.ts still owns how an amount is
// printed, unchanged, so no user-visible string moves because of this file.
//
// ROUNDING: HALF AWAY FROM ZERO, MATCHING WHAT THE REPO ALREADY DOES.
// ------------------------------------------------------------------
// Not half-even. The repo is already consistent on this and changing it would
// move real displayed values:
//
//   Go  divRound()            "half-away-from-zero — the rounding a shopkeeper
//                              does" (shopbook_money.go)
//   Go  sbRoundOff()           rem >= 50 rounds up
//   TS  utils/money.ts         toPaise() is Math.round, and moneySeam.selftest
//                              pins `toPaise rounds half-up` → toPaise(0.125)===13
//   TS  formatMoney()          Math.round(n*100), pinned by shopbook.selftest
//                              as formatMoney(10.005,'£') === '£10.01'
//
// Half-even would make that last one £10.00 — a displayed value changing for an
// existing user, which is exactly what this change must never do.

/** Currencies with no minor unit at all. ISO 4217 exponent 0. */
const EXP0 = [
  'BIF', 'CLP', 'DJF', 'GNF', 'ISK', 'JPY', 'KMF', 'KRW', 'PYG', 'RWF',
  'UGX', 'UYI', 'VND', 'VUV', 'XAF', 'XOF', 'XPF',
] as const;

/** Currencies with three decimal places. ISO 4217 exponent 3. */
const EXP3 = ['BHD', 'IQD', 'JOD', 'KWD', 'LYD', 'OMR', 'TND'] as const;

/**
 * Currencies this app knows have two decimal places.
 *
 * An ALLOWLIST, not a default. "Everything else is 2" is precisely the
 * assumption that had no valid encoding for JPY, and a typo ('IRN' for 'INR')
 * would be silently accepted as a 2dp currency and misprice a whole shop. The
 * six that shopbook_country actually seeds (migration 069) are INR USD GBP AUD
 * CAD SGD; the rest are here so an admin adding a country through
 * /shopbook/admin/countries gets a working shop rather than an error.
 */
const EXP2 = [
  'AED', 'ARS', 'AUD', 'BDT', 'BND', 'BRL', 'CAD', 'CHF', 'CNY', 'COP', 'CZK',
  'DKK', 'EGP', 'EUR', 'GBP', 'HKD', 'IDR', 'ILS', 'INR', 'KES', 'LKR', 'MAD',
  'MMK', 'MXN', 'MYR', 'NGN', 'NOK', 'NPR', 'NZD', 'PHP', 'PKR', 'PLN', 'QAR',
  'RON', 'RUB', 'SAR', 'SEK', 'SGD', 'THB', 'TRY', 'TWD', 'TZS', 'UAH', 'USD',
  'ZAR',
] as const;

/** The whole table. Exported so the selftest can pin it against the Go copy. */
export const CURRENCY_EXPONENTS: Readonly<Record<string, number>> = Object.freeze({
  ...Object.fromEntries(EXP0.map((c) => [c, 0])),
  ...Object.fromEntries(EXP2.map((c) => [c, 2])),
  ...Object.fromEntries(EXP3.map((c) => [c, 3])),
});

export class UnknownCurrencyError extends Error {
  constructor(code: unknown) {
    super(
      `unknown currency ${JSON.stringify(code)}: refusing to assume 2 decimal places. ` +
      `Add it to utils/currencyMinor.ts (and shopbook_currency.go) with its ISO 4217 exponent.`,
    );
    this.name = 'UnknownCurrencyError';
  }
}

/**
 * ISO 4217 minor-unit exponent for a currency code.
 *
 * THROWS on anything not in the table. Failing loudly is the whole point: a
 * silent fallback to 2 is how ¥1,299 becomes ¥129,900, and a ledger that is
 * wrong is worse than a screen that refuses to render.
 */
export function exponentOf(code: string): number {
  const c = String(code ?? '').trim().toUpperCase();
  const e = CURRENCY_EXPONENTS[c];
  if (e === undefined) throw new UnknownCurrencyError(code);
  return e;
}

/** Minor units in one major unit: 100 for INR, 1 for JPY, 1000 for KWD. */
export function minorPerUnit(code: string): number {
  return 10 ** exponentOf(code);
}

/** Half away from zero — see the rounding note at the top of this file. */
function roundHalf(n: number): number {
  return n < 0 ? -Math.round(-n) : Math.round(n);
}

/**
 * Decimal amount → integer minor units.
 *
 * This is the ONLY place a decimal becomes money. ₹125.50 → 12550,
 * ¥1299 → 1299, 1.234 KD → 1234.
 */
export function toMinor(amount: number, code: string): number {
  if (!Number.isFinite(amount)) throw new TypeError(`toMinor: ${amount} is not an amount`);
  return roundHalf(amount * minorPerUnit(code));
}

/**
 * Integer minor units → the decimal amount the display layer already expects.
 * Exact for every value inside 2^53 minor units.
 */
export function fromMinor(minor: number, code: string): number {
  const per = minorPerUnit(code);
  return per === 1 ? Math.round(minor) : Math.round(minor) / per;
}

/**
 * Sum minor units. Integer addition, so a thousand-line ledger is exact —
 * unlike summing the decimals, where 0.1 + 0.2 is already 0.30000000000000004
 * and a day's takings drift by a paisa per few hundred entries.
 */
export function sumMinor(values: number[]): number {
  let total = 0;
  for (const v of values) total += Math.round(v);
  return total;
}

/**
 * Read a row written by the OLD representation.
 *
 * Every pre-migration row is a decimal in the major unit (NUMERIC(12,2) in
 * Postgres, REAL in the on-device finance DB). This is the read-compatible
 * path: `minor` when the backfilled column is present, else the legacy decimal
 * converted on the fly. Both must produce the same displayed value.
 */
export function readMoney(minor: number | null | undefined, legacyDecimal: number, code: string): number {
  return minor == null ? toMinor(legacyDecimal, code) : Math.round(minor);
}

export default { exponentOf, minorPerUnit, toMinor, fromMinor, sumMinor, readMoney };
