// shopbook_money.go — SHOP BOOK financial foundation (P0-A).
//
// Two rules this file exists to enforce:
//
//  1. NO FLOAT TOUCHES MONEY. `money` is an int64 count of minor units
//     (paise/cents). Postgres keeps NUMERIC — exact — and the boundary is
//     crossed with sbCents() on the way in and sbAmt() on the way out, so the
//     value is an integer on both sides and never a binary fraction in
//     between. math.Round on a float64 total is not rounding, it is damage
//     control after the fact.
//
//  2. THE SERVER PRICES THE ORDER. sbPriceLines resolves every line against
//     shopbook_product for the shop being ordered from, ignores whatever price
//     the client sent, and reports back which lines moved so the customer can
//     be shown the change instead of being silently re-charged.
//
// The output of sbPriceLines is the single financial snapshot that the order,
// the invoice, the ledger and the reports all read. They do not each
// recompute — that is how the ledger and the invoice came to disagree.
package routes

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"

	"vaultchat/backend-go/internal/db"
)

// ── money ─────────────────────────────────────────────────────────

// money is an exact amount in minor units: ₹125.50 is money(12550).
type money int64

// sbCents wraps a NUMERIC column so it reads as exact minor units.
// Postgres does the ×100 in decimal, so nothing is lost.
func sbCents(col string) string { return "((" + col + ")*100)::bigint" }

// sbAmt wraps a bigint parameter so it writes back into a NUMERIC column.
// usage: `SET total = ` + sbAmt("$1")
func sbAmt(param string) string { return "(" + param + "::numeric/100)" }

// Float is for JSON output only. Every existing Shop Book response field is a
// decimal number and the shipped client parses it as one; changing that
// contract wholesale would break every build in the field. Values here are
// ≤ 2 decimal places well inside 2^53, so the round-trip is exact.
func (m money) Float() float64 { return float64(m) / 100 }

func (m money) String() string {
	sign, v := "", int64(m)
	if v < 0 {
		sign, v = "-", -v
	}
	return fmt.Sprintf("%s%d.%02d", sign, v/100, v%100)
}

// divRound divides half-away-from-zero — the rounding a shopkeeper does, and
// the only one that keeps Σ(lines) reconcilable with the total.
func divRound(n, d int64) int64 {
	if d == 0 {
		return 0
	}
	if (n < 0) != (d < 0) {
		return (n - d/2) / d
	}
	return (n + d/2) / d
}

// mulQty multiplies a unit price by a quantity held in hundredths
// (qty 1.18 → 118), e.g. 1.18 kg at ₹240.00 → ₹283.20.
func (m money) mulQty(qty100 int64) money { return money(divRound(int64(m)*qty100, 100)) }

// pctOf applies a percentage held in hundredths of a percent
// (5% → 500, 2.5% → 250), so NUMERIC(5,2) tax rates survive intact.
func (m money) pctOf(pct100 int64) money { return money(divRound(int64(m)*pct100, 10000)) }

// sbAllocate splits `total` across `weights` proportionally, giving the
// remainder to the largest weights first (largest-remainder apportionment).
// Σ(result) == total exactly — a discount that doesn't add back up is how a
// bill ends up a paisa off from its own lines.
func sbAllocate(total money, weights []money) []money {
	out := make([]money, len(weights))
	var sum money
	for _, w := range weights {
		sum += w
	}
	if sum <= 0 || total == 0 {
		return out
	}
	var placed money
	// remainders[i] = the fractional part we truncated, scaled by sum.
	rem := make([]int64, len(weights))
	for i, w := range weights {
		n := int64(total) * int64(w)
		out[i] = money(n / int64(sum))
		rem[i] = n % int64(sum)
		placed += out[i]
	}
	for placed < total {
		best, bestRem := -1, int64(-1)
		for i := range weights {
			if rem[i] > bestRem {
				best, bestRem = i, rem[i]
			}
		}
		if best < 0 {
			break
		}
		out[best]++
		rem[best] = -1
		placed++
	}
	return out
}

// ── pricing ───────────────────────────────────────────────────────

// sbQ is the subset of pgx both *pgxpool.Pool and pgx.Tx satisfy, so pricing
// can run inside the order transaction or standalone.
type sbQ interface {
	Query(ctx context.Context, sql string, args ...any) (pgx.Rows, error)
	QueryRow(ctx context.Context, sql string, args ...any) pgx.Row
	Exec(ctx context.Context, sql string, args ...any) (pgconn.CommandTag, error)
}

// sbLineIn is one requested line as it arrives from the client. Price is
// deliberately absent from the authoritative path — ClientPrice is only ever
// compared, never used.
type sbLineIn struct {
	ProductID   string
	Name        string
	Brand       string
	Unit        string
	Note        string
	Qty100      int64  // quantity ×100
	ClientPrice *money // what the customer was shown, for revalidation
}

// sbLine is a priced line. Price/TaxPct are server-resolved, always.
type sbLine struct {
	sbLineIn
	Price     money
	TaxPct100 int64 // tax percent ×100
	Custom    bool  // not in the catalog: a quote the owner must price
	Subtotal  money // Price × Qty
	Discount  money // this line's share of the order discount
	Tax       money // on (Subtotal − Discount)
	Total     money // Subtotal − Discount + Tax
	Changed   bool  // server price differs from what the client displayed
	WasPrice  money // the price the client displayed, when Changed
}

// sbPriced is THE financial snapshot. Everything downstream copies it.
type sbPriced struct {
	Lines       []sbLine
	Subtotal    money
	Discount    money
	TaxTotal    money
	DeliveryFee money
	RoundOff    money
	Total       money
	Coupon      string
	TaxSnapshot map[string]any
	Changes     []sbLine // lines whose price moved since the client rendered them
}

// sbPriceLines is the single authoritative pricing path.
//
// Every line is resolved against this shop's catalog: by product id when the
// client sends one, else by an exact name/brand/unit match (pre-P0-A clients
// send no id, and a silent downgrade to a ₹0 quote would be worse than a
// lookup). Anything that resolves to nothing is a CUSTOM line — a request, not
// a sale — priced at zero until the owner quotes it during review.
func sbPriceLines(
	ctx context.Context, q sbQ, shopID string, in []sbLineIn,
	couponCode string, deliveryFee money,
) (sbPriced, error) {
	p := sbPriced{Lines: make([]sbLine, 0, len(in)), DeliveryFee: deliveryFee}

	taxOn, snapshot, err := sbTaxSnapshot(ctx, q, shopID)
	if err != nil {
		return p, err
	}
	p.TaxSnapshot = snapshot

	for _, it := range in {
		l := sbLine{sbLineIn: it, Custom: true}
		if l.Qty100 <= 0 {
			l.Qty100 = 100
		}

		var (
			id, name, brand, unit string
			price                 int64
			taxPct                int64
			inStock, enabled      bool
		)
		sel := `SELECT id, name, brand, unit, ` + sbCents("price") + `, ` +
			sbCents("tax_percent") + `, in_stock, enabled
			  FROM shopbook_product WHERE shop_id=$1 AND `
		var row pgx.Row
		if it.ProductID != "" {
			row = q.QueryRow(ctx, sel+`id=$2`, shopID, it.ProductID)
		} else {
			// Fallback for clients that predate product ids. Exact match only —
			// a fuzzy match that picks the wrong row misprices the order.
			row = q.QueryRow(ctx, sel+`enabled AND lower(name)=lower($2)
			   AND lower(brand)=lower($3) AND lower(unit)=lower($4) LIMIT 1`,
				shopID, strings.TrimSpace(it.Name), strings.TrimSpace(it.Brand), strings.TrimSpace(it.Unit))
		}
		switch err := row.Scan(&id, &name, &brand, &unit, &price, &taxPct, &inStock, &enabled); {
		case err == nil && enabled:
			l.Custom = false
			l.ProductID, l.Name, l.Brand, l.Unit = id, name, brand, unit
			l.Price, l.TaxPct100 = money(price), taxPct
		case err != nil && !db.NoRows(err):
			return p, err
		default:
			// Unknown, disabled, or free-typed → a quote. Price stays 0 and the
			// line arrives at the owner as 'pending' for review.
			l.ProductID, l.Price, l.TaxPct100 = "", 0, 0
		}

		if it.ClientPrice != nil && !l.Custom && *it.ClientPrice != l.Price {
			l.Changed, l.WasPrice = true, *it.ClientPrice
		}
		l.Subtotal = l.Price.mulQty(l.Qty100)
		p.Subtotal += l.Subtotal
		p.Lines = append(p.Lines, l)
	}

	// Coupon — resolved server-side against this shop's active coupons.
	if couponCode != "" {
		p.Discount, p.Coupon = sbCouponDiscount(ctx, q, shopID, couponCode, p.Subtotal)
	}

	// Discount is apportioned across lines so each line's tax is charged on
	// what that line actually costs. Tax-then-discount would over-collect.
	weights := make([]money, len(p.Lines))
	for i, l := range p.Lines {
		weights[i] = l.Subtotal
	}
	shares := sbAllocate(p.Discount, weights)
	for i := range p.Lines {
		l := &p.Lines[i]
		l.Discount = shares[i]
		if taxOn {
			l.Tax = (l.Subtotal - l.Discount).pctOf(l.TaxPct100)
		}
		l.Total = l.Subtotal - l.Discount + l.Tax
		p.TaxTotal += l.Tax
	}

	p.Total = p.Subtotal - p.Discount + p.TaxTotal + p.DeliveryFee
	if p.Total < 0 {
		p.Total = 0
	}
	for i := range p.Lines {
		if p.Lines[i].Changed {
			p.Changes = append(p.Changes, p.Lines[i])
		}
	}
	return p, nil
}

// sbCouponDiscount validates a coupon code against the shop and returns the
// discount it earns on this subtotal (0 and "" when it doesn't apply).
func sbCouponDiscount(ctx context.Context, q sbQ, shopID, code string, subtotal money) (money, string) {
	var kind string
	var value, minOrder int64
	err := q.QueryRow(ctx,
		`SELECT kind, `+sbCents("value")+`, `+sbCents("min_order")+`
		   FROM shopbook_coupon
		  WHERE shop_id=$1 AND UPPER(code)=UPPER($2) AND active=TRUE`,
		shopID, code).Scan(&kind, &value, &minOrder)
	if err != nil || subtotal < money(minOrder) {
		return 0, ""
	}
	d := money(value)
	if kind == "percent" {
		// `value` is a percentage stored as NUMERIC(10,2) → hundredths.
		d = subtotal.pctOf(value)
	}
	if d > subtotal {
		d = subtotal
	}
	return d, strings.ToUpper(code)
}

// sbTaxSnapshot freezes the tax rules in force for this shop right now.
//
// Tax is charged ONLY when the shop filled in a tax detail — every tax field
// is optional in every country, and a shop that never registered must not have
// tax invented for it. The snapshot rides on the order so a later admin edit
// to shopbook_country cannot restate history.
func sbTaxSnapshot(ctx context.Context, q sbQ, shopID string) (bool, map[string]any, error) {
	var country, currency string
	var cfgRaw []byte
	err := q.QueryRow(ctx,
		`SELECT country, currency, tax_config FROM shopbook_shop WHERE id=$1`, shopID).
		Scan(&country, &currency, &cfgRaw)
	if err != nil {
		return false, map[string]any{}, err
	}
	cfg := map[string]any{}
	_ = json.Unmarshal(cfgRaw, &cfg)

	snap := map[string]any{
		"country": country, "currency": currency,
		"registration": cfg, "configured": false, "version": 1,
	}
	if !sbTaxConfigured(cfg) {
		return false, snap, nil
	}
	snap["configured"] = true
	if cc, ok := sbLoadCountry(ctx, country); ok {
		snap["taxType"] = cc.TaxType
		snap["taxSplit"] = cc.TaxSplit
	}
	return true, snap, nil
}

// sbRepriceOrder re-derives an order's money after its effective lines change
// — an item marked unavailable, or an alternative accepted — and writes the
// new snapshot back to the order and its lines.
//
// It re-prices from the SNAPSHOTTED line prices, never from the live catalog:
// once an order is placed, a shelf-price change must not move the bill under
// the customer. The tax decision is likewise read from the order's frozen
// tax_snapshot, so an owner registering for tax mid-order cannot retro-tax it.
func sbRepriceOrder(ctx context.Context, q sbQ, orderID string) error {
	var shopID, coupon string
	var deliveryFee, billDiscount int64
	var taxOn, roundOffOn bool
	if err := q.QueryRow(ctx,
		`SELECT o.shop_id, o.coupon_code, `+sbCents("o.delivery_fee")+`,
		        `+sbCents("o.bill_discount")+`,
		        COALESCE((o.tax_snapshot->>'configured')::bool, FALSE),
		        s.round_off_enabled
		   FROM shopbook_order o JOIN shopbook_shop s ON s.id = o.shop_id
		  WHERE o.id=$1`, orderID).
		Scan(&shopID, &coupon, &deliveryFee, &billDiscount, &taxOn, &roundOffOn); err != nil {
		return err
	}

	type row struct {
		id       string
		price    money
		qty100   int64
		taxPct   int64
		usable   bool
		subtotal money
	}
	// The billed quantity is what the shop actually weighed out
	// (fulfilled_qty), falling back to what was ordered. `qty` is never
	// touched: "I asked for 1 kg" is half of every dispute about a bill.
	rows, err := q.Query(ctx,
		`SELECT id, `+sbCents("price")+`, `+sbCents("COALESCE(fulfilled_qty, qty)")+`,
		        `+sbCents("tax_percent")+`,
		        availability <> 'unavailable' AND NOT removed
		   FROM shopbook_order_item WHERE order_id=$1 ORDER BY id`, orderID)
	if err != nil {
		return err
	}
	lines := []row{}
	var subtotal money
	for rows.Next() {
		var l row
		var price, qty int64
		if err := rows.Scan(&l.id, &price, &qty, &l.taxPct, &l.usable); err != nil {
			rows.Close()
			return err
		}
		l.price, l.qty100 = money(price), qty
		if l.usable {
			l.subtotal = l.price.mulQty(l.qty100)
			subtotal += l.subtotal
		}
		lines = append(lines, l)
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return err
	}

	// Coupon (the customer's) and bill discount (the counter's) are separate
	// concessions that both reduce the same bill; together they can never
	// exceed it.
	discount := money(billDiscount)
	if coupon != "" {
		c, _ := sbCouponDiscount(ctx, q, shopID, coupon, subtotal)
		discount += c
	}
	if discount > subtotal {
		discount = subtotal
	}
	weights := make([]money, len(lines))
	for i, l := range lines {
		weights[i] = l.subtotal
	}
	shares := sbAllocate(discount, weights)

	var taxTotal money
	for i, l := range lines {
		lineDisc, lineTax := shares[i], money(0)
		if !l.usable {
			lineDisc = 0
		} else if taxOn {
			lineTax = (l.subtotal - lineDisc).pctOf(l.taxPct)
		}
		taxTotal += lineTax
		if _, err := q.Exec(ctx,
			`UPDATE shopbook_order_item
			    SET line_discount=`+sbAmt("$2")+`, line_tax=`+sbAmt("$3")+`, line_total=`+sbAmt("$4")+`
			  WHERE id=$1`,
			l.id, int64(lineDisc), int64(lineTax), int64(l.subtotal-lineDisc+lineTax)); err != nil {
			return err
		}
	}

	total := subtotal - discount + taxTotal + money(deliveryFee)
	if total < 0 {
		total = 0
	}
	roundOff := money(0)
	if roundOffOn {
		roundOff = sbRoundOff(total)
		total += roundOff
	}
	_, err = q.Exec(ctx,
		`UPDATE shopbook_order
		    SET subtotal=`+sbAmt("$2")+`, discount=`+sbAmt("$3")+`, tax_total=`+sbAmt("$4")+`,
		        round_off=`+sbAmt("$5")+`, total=`+sbAmt("$6")+`, updated_at=NOW()
		  WHERE id=$1`,
		orderID, int64(subtotal), int64(discount), int64(taxTotal),
		int64(roundOff), int64(total))
	return err
}

// sbRoundOff returns the adjustment that takes a total to the nearest whole
// currency unit — the "₹0.40 round off" line on an Indian bill. Half rounds
// up, so the shop never loses the half-unit; it is a line item on the invoice
// precisely so the customer can see it happened.
func sbRoundOff(total money) money {
	rem := int64(total) % 100
	if rem == 0 {
		return 0
	}
	if rem >= 50 {
		return money(100 - rem)
	}
	return money(-rem)
}

// ── idempotency ───────────────────────────────────────────────────

// sbIdemKey reads the caller's idempotency key from the standard header or the
// body field, and bounds it — it becomes a unique-index value.
func sbIdemKey(header, body string) string {
	k := strings.TrimSpace(header)
	if k == "" {
		k = strings.TrimSpace(body)
	}
	if len(k) > 100 {
		k = k[:100]
	}
	return k
}
