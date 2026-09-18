// shopbook_currency.go — THE one place the server knows how many minor units a
// currency has. The Go half of utils/currencyMinor.ts; the two tables are
// pinned against each other by utils/currencyMinor.selftest.ts, which reads
// THIS FILE, so they cannot drift apart silently.
//
// shopbook_money.go already holds money as int64 minor units — that part was
// right. What was wrong is that every conversion across a boundary was a
// hard-coded ×100: sbCents(), sbAmt(), money.Float(), money.String(),
// sbRoundOff(), and NUMERIC(12,2) in the schema. A hard-coded 2 has no valid
// encoding for exponent-0 money (JPY ¥1299 is 1299 minor units, not 129900) and
// silently discards the third decimal of exponent-3 money (KWD, BHD, JOD …).
//
// Rounding everywhere here is HALF AWAY FROM ZERO, matching divRound() and
// sbRoundOff() in shopbook_money.go. Not half-even: the repo is already
// consistent, and switching would move displayed values for existing shops.
package routes

import (
	"context"
	"fmt"
	"strings"
)

// sbExponentTable — ISO 4217 minor-unit exponents. No default: a code that is
// not in here is an error, not a 2. See sbExponent.
//
// KEEP IN SYNC WITH utils/currencyMinor.ts (the selftest there enforces it).
var sbExponentTable = map[string]int{
	// exponent 0 — no minor unit at all
	"BIF": 0, "CLP": 0, "DJF": 0, "GNF": 0, "ISK": 0, "JPY": 0, "KMF": 0,
	"KRW": 0, "PYG": 0, "RWF": 0, "UGX": 0, "UYI": 0, "VND": 0, "VUV": 0,
	"XAF": 0, "XOF": 0, "XPF": 0,
	// exponent 3 — three decimal places
	"BHD": 3, "IQD": 3, "JOD": 3, "KWD": 3, "LYD": 3, "OMR": 3, "TND": 3,
	// exponent 2 — an allowlist, NOT a fallback. The six shopbook_country
	// seeds (migration 069) are INR USD GBP AUD CAD SGD; the rest let an admin
	// add a country without a server change.
	"AED": 2, "ARS": 2, "AUD": 2, "BDT": 2, "BND": 2, "BRL": 2, "CAD": 2,
	"CHF": 2, "CNY": 2, "COP": 2, "CZK": 2, "DKK": 2, "EGP": 2, "EUR": 2,
	"GBP": 2, "HKD": 2, "IDR": 2, "ILS": 2, "INR": 2, "KES": 2, "LKR": 2,
	"MAD": 2, "MMK": 2, "MXN": 2, "MYR": 2, "NGN": 2, "NOK": 2, "NPR": 2,
	"NZD": 2, "PHP": 2, "PKR": 2, "PLN": 2, "QAR": 2, "RON": 2, "RUB": 2,
	"SAR": 2, "SEK": 2, "SGD": 2, "THB": 2, "TRY": 2, "TWD": 2, "TZS": 2,
	"UAH": 2, "USD": 2, "ZAR": 2,
}

// sbExponent returns the ISO 4217 minor-unit exponent for a currency code.
//
// It ERRORS on an unknown code rather than assuming 2. A silent 2 is how ¥1,299
// becomes ¥129,900 and how 0.001 KD disappears; a request that fails is
// recoverable, a ledger that is quietly wrong is not.
func sbExponent(code string) (int, error) {
	c := strings.ToUpper(strings.TrimSpace(code))
	if e, ok := sbExponentTable[c]; ok {
		return e, nil
	}
	return 0, fmt.Errorf("unknown currency %q: refusing to assume 2 decimal places", code)
}

// sbMinorPer returns 10^exp — 100 for INR, 1 for JPY, 1000 for KWD.
func sbMinorPer(exp int) int64 {
	p := int64(1)
	for i := 0; i < exp; i++ {
		p *= 10
	}
	return p
}

// ── exponent-aware boundary crossings ─────────────────────────────
//
// The exp-2 wrappers in shopbook_money.go (sbCents/sbAmt/Float/String) stay
// exactly as they are and keep every existing call site reading identically.
// These are the same crossings with the scale supplied rather than assumed.

// sbCentsExp wraps a NUMERIC column so it reads as exact minor units at `exp`.
// Postgres does the scaling in decimal, so nothing is lost.
func sbCentsExp(col string, exp int) string {
	return "(round((" + col + ")*" + fmt.Sprint(sbMinorPer(exp)) + "))::bigint"
}

// sbAmtExp wraps a bigint parameter so it writes back into a NUMERIC column.
func sbAmtExp(param string, exp int) string {
	return "(" + param + "::numeric/" + fmt.Sprint(sbMinorPer(exp)) + ")"
}

// FloatExp is the decimal an existing client parses. For exp 2 it is Float().
// For JPY it is the yen count itself: money(1299).FloatExp(0) == 1299.
func (m money) FloatExp(exp int) float64 {
	if exp == 0 {
		return float64(m)
	}
	return float64(m) / float64(sbMinorPer(exp))
}

// StringExp renders minor units at the currency's own scale: 12550 at exp 2 is
// "125.50", 1299 at exp 0 is "1299", 1234 at exp 3 is "1.234".
func (m money) StringExp(exp int) string {
	sign, v := "", int64(m)
	if v < 0 {
		sign, v = "-", -v
	}
	per := sbMinorPer(exp)
	if exp == 0 {
		return fmt.Sprintf("%s%d", sign, v)
	}
	return fmt.Sprintf("%s%d.%0*d", sign, v/per, exp, v%per)
}

// sbRoundOffExp is sbRoundOff at the currency's own scale: the adjustment to
// the nearest WHOLE currency unit. At exp 2 it is byte-for-byte the existing
// behaviour. At exp 0 there is nothing to round — a yen total is already whole
// — and at exp 3 it rounds to the whole dinar, not to a hundredth of one, which
// is what the hard-coded 100 did.
func sbRoundOffExp(total money, exp int) money {
	per := sbMinorPer(exp)
	rem := int64(total) % per
	if rem == 0 {
		return 0
	}
	if rem >= per/2 {
		return money(per - rem)
	}
	return money(-rem)
}

// sbToMinor converts a decimal major-unit amount (what every pre-migration row
// and every shipped client holds) into minor units, half away from zero.
// This is the read-compatible path for a row written the old way.
func sbToMinor(amount float64, exp int) money {
	v := amount * float64(sbMinorPer(exp))
	if v < 0 {
		return money(-int64(-v + 0.5))
	}
	return money(int64(v + 0.5))
}

// sbMinorFromCents re-scales a legacy hundredths value — what sbCents() reads
// out of a NUMERIC(_,2) column — into the currency's real minor units.
// At exp 2 it is the identity, which is why nothing an existing shop has moves.
func sbMinorFromCents(cents money, exp int) int64 {
	return divRound(int64(cents)*sbMinorPer(exp), 100)
}

// sbCurrencyBlock is the ADDITIVE minor-unit half of a Shop Book response.
//
// It sits ALONGSIDE the existing decimal fields, never instead of them: every
// shipped client parses `total` as a decimal number and must keep working. A
// client that understands minor units reads `money.minor.total` and
// `money.exponent` instead, and gets an amount that is correct for JPY and KWD
// as well as INR.
//
// An unresolvable currency does NOT fall back to 2 and does NOT fail the
// request. It emits `money.error` — loud in the payload and in any log that
// samples it — while the decimal fields still render, because refusing to show
// a shopkeeper their own order is a worse outcome than an absent new field.
func sbCurrencyBlock(ctx context.Context, country string, cents map[string]money) map[string]any {
	cc, ok := sbLoadCountry(ctx, country)
	if !ok {
		return map[string]any{"error": "no country config for " + country}
	}
	exp, err := sbExponent(cc.CurrencyCode)
	if err != nil {
		return map[string]any{"code": cc.CurrencyCode, "error": err.Error()}
	}
	minor := make(map[string]any, len(cents))
	for k, v := range cents {
		minor[k] = sbMinorFromCents(v, exp)
	}
	return map[string]any{"code": cc.CurrencyCode, "exponent": exp, "minor": minor}
}
