// shopbook_khata.go — the shop's own address book of walk-in customers.
//
// # WHAT THIS CLOSES
//
// Migration 111 gave shopbook_ledger a second kind of party — khata_customer_id
// — and sbAddLedgerEntry has accepted it since. But nothing could ever CREATE
// one of those rows, so no client could obtain a khataCustomerId and the whole
// walk-in path was correct and unreachable at the same time.
//
// A walk-in is a customer with no VaultChat account: the neighbour who buys on
// credit and will never install the app. The row belongs to the SHOP, not to
// the platform — it is the shopkeeper's address book, not a user account, and
// nothing here creates or touches a `users` row.
//
// SCOPE, DELIBERATELY SMALL: create only. No update, no delete. A walk-in with
// ledger history must not be silently editable or removable — migration 111's
// ON DELETE RESTRICT says the same thing at the database level — and neither
// operation is needed to make the ledger path reachable, which is the whole
// point of this file.
package routes

import (
	"math"
	"net/http"
	"strings"

	"vaultchat/backend-go/internal/db"
	"vaultchat/backend-go/internal/httpx"

	"github.com/jackc/pgx/v5"
)

func RegisterShopBookKhata(mux *http.ServeMux) {
	mux.HandleFunc("POST /shopbook/my-shop/khata-customers", httpx.RequireAuth(sbCreateKhataCustomer))
	mux.HandleFunc("POST /shopbook/my-shop/khata-customers/{id}/credit-limit", httpx.RequireAuth(sbSetKhataCreditLimit))
}

// sbSetKhataCreditLimit is sbSetCreditLimit for a walk-in: same verb, same body,
// same rule that 0 means "no ceiling". It writes a DIFFERENT table only because
// shopbook_customer.customer_user_id is a users FK a walk-in can never satisfy.
//
// UPDATE, not upsert. The row must already exist — a limit is set ON a khata,
// and creating one as a side effect of setting a limit would let a typo'd id
// invent a nameless customer. `AND shop_id` is the authorization: another
// shop's khata simply matches nothing and answers 404.
func sbSetKhataCreditLimit(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	user := httpx.UserFrom(r)
	shopID, ok := ownerShopID(ctx, w, user.ID)
	if !ok {
		return
	}
	khataID := r.PathValue("id")
	var b struct {
		CreditLimit float64 `json:"creditLimit"`
		Note        string  `json:"note"`
	}
	if err := httpx.Body(r, &b); err != nil || b.CreditLimit < 0 {
		httpx.Err(w, http.StatusBadRequest, "creditLimit must be ≥ 0")
		return
	}
	cents := int64(math.Round(b.CreditLimit * 100))
	tag, err := db.Pool.Exec(ctx,
		`UPDATE shopbook_khata_customer
		    SET credit_limit=`+sbAmt("$1")+`, updated_at=NOW()
		  WHERE id=$2 AND shop_id=$3`,
		cents, khataID, shopID)
	if err != nil {
		httpx.Err(w, http.StatusInternalServerError, "db error")
		return
	}
	if tag.RowsAffected() == 0 {
		httpx.Err(w, http.StatusNotFound, "That walk-in customer is not in your shop")
		return
	}
	// A credit ceiling is a money control. Who changed it, and to what, is
	// exactly the kind of thing 095 said was happening silently.
	_ = db.WithUser(ctx, user.ID, func(tx pgx.Tx) error {
		sbAudit(ctx, tx, sbAuditEntry{
			ShopID: shopID, Actor: user.ID,
			Action: "khata_customer.credit_limit", Entity: "khata_customer", EntityID: khataID,
			After:  map[string]any{"creditLimit": b.CreditLimit},
			Reason: b.Note, IP: sbClientIP(r),
		})
		return nil
	})
	httpx.JSON(w, 200, map[string]any{"ok": true, "creditLimit": b.CreditLimit})
}

// sbCreateKhataCustomer adds a walk-in customer to the authenticated owner's shop.
//
// AUTHORIZATION IS STRUCTURAL. shop_id comes from ownerShopID — resolved from
// the authenticated user's owner_user_id — and is never read from the request.
// There is therefore no shop id for a caller to tamper with, and no cross-shop
// write to defend against separately.
func sbCreateKhataCustomer(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	user := httpx.UserFrom(r)
	shopID, ok := ownerShopID(ctx, w, user.ID)
	if !ok {
		return
	}

	var b struct {
		Name      string `json:"name"`
		Mobile    string `json:"mobile"`
		AltMobile string `json:"altMobile"`
		Address   string `json:"address"`
		Notes     string `json:"notes"`
	}
	if err := httpx.Body(r, &b); err != nil {
		httpx.Err(w, http.StatusBadRequest, "name required")
		return
	}
	// TrimSpace and nothing else — the same normalisation sbSaveSupplier and
	// sbCounterSale apply to their name/phone fields. Stripping or reformatting
	// digits here would make the shop's own book disagree with what they typed,
	// and would not match the phone strings already stored elsewhere.
	name := strings.TrimSpace(b.Name)
	mobile := strings.TrimSpace(b.Mobile)
	if name == "" {
		// Mirrors the CHECK migration 111 already carries
		// (length(btrim(name)) > 0), so the two cannot drift apart.
		httpx.Err(w, http.StatusBadRequest, "name required")
		return
	}

	// ONE KHATA PER PHONE PER SHOP, and the partial unique index
	// idx_shopbook_khata_customer_mobile is what enforces it — not this check.
	// Asking first only turns the common case into a plain 200 instead of an
	// insert that has to fail before we can answer; the race is still handled
	// below, because two requests can both pass this lookup.
	//
	// Empty mobile is deliberately NOT deduplicated: the index is partial
	// (WHERE mobile <> '') precisely so a shop can keep several name-only
	// khatas for people they know by sight.
	if mobile != "" {
		var existing string
		err := db.Pool.QueryRow(ctx,
			`SELECT id FROM shopbook_khata_customer WHERE shop_id=$1 AND mobile=$2`,
			shopID, mobile).Scan(&existing)
		if err == nil {
			httpx.JSON(w, 200, map[string]any{"id": existing, "duplicate": true})
			return
		}
		if !db.NoRows(err) {
			httpx.Err(w, http.StatusInternalServerError, "db error")
			return
		}
	}

	var id string
	err := db.WithUser(ctx, user.ID, func(tx pgx.Tx) error {
		if e := tx.QueryRow(ctx,
			`INSERT INTO shopbook_khata_customer (shop_id, name, mobile, alt_mobile, address, notes)
			 VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`,
			shopID, name, mobile,
			strings.TrimSpace(b.AltMobile), strings.TrimSpace(b.Address), strings.TrimSpace(b.Notes),
		).Scan(&id); e != nil {
			return e
		}
		// Creating a customer is a shop-book event like any other. Recorded with
		// the same append-only mechanism the ledger uses, so "where did this
		// khata come from" has an answer the shop cannot edit.
		sbAudit(ctx, tx, sbAuditEntry{
			ShopID: shopID, Actor: user.ID,
			Action: "khata_customer.create", Entity: "khata_customer", EntityID: id,
			After: map[string]any{"name": name, "hasMobile": mobile != ""},
			IP:    sbClientIP(r),
		})
		return nil
	})
	if err != nil {
		// THE RACE THE LOOKUP ABOVE CANNOT COVER: two requests for the same new
		// mobile both find nothing, both insert, and the index refuses the
		// second. That second caller wanted this customer to exist, and it now
		// does — so return it rather than a 500 the client would retry.
		if sbIsUniqueViolation(err, "idx_shopbook_khata_customer_mobile") && mobile != "" {
			var existing string
			if db.Pool.QueryRow(ctx,
				`SELECT id FROM shopbook_khata_customer WHERE shop_id=$1 AND mobile=$2`,
				shopID, mobile).Scan(&existing) == nil {
				httpx.JSON(w, 200, map[string]any{"id": existing, "duplicate": true})
				return
			}
		}
		httpx.Err(w, http.StatusInternalServerError, "db error")
		return
	}

	httpx.JSON(w, 201, map[string]any{"id": id, "name": name, "mobile": mobile})
}
