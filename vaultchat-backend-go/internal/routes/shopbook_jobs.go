// shopbook_jobs.go — SHOP BOOK scheduled notifications (openspec:
// shop-book-upgrade): owner daily summaries and weekly pending-payment
// reminders. Lives in routes (not internal/jobs) to reuse sbNotify's
// inbox-persist + Expo push path.
//
// Env knobs:
//
//	SHOPBOOK_JOBS=off              disable both jobs
//	SHOPBOOK_SUMMARY_HOUR_UTC=15   hour (UTC) the daily tick fires
package routes

import (
	"context"
	"fmt"
	"log"
	"os"
	"strconv"
	"time"

	"github.com/jackc/pgx/v5"

	"vaultchat/backend-go/internal/db"
	"vaultchat/backend-go/internal/jobs"
	"vaultchat/backend-go/internal/redisx"
)

// StartShopBookJobs launches the hourly ticker. Each firing is idempotent —
// "already sent" is derived from the notification inbox itself, so restarts
// and multi-hour downtime never double-send.
func StartShopBookJobs(ctx context.Context) {
	if os.Getenv("SHOPBOOK_JOBS") == "off" {
		log.Println("[shopbook-jobs] disabled via SHOPBOOK_JOBS=off")
		return
	}
	go func() {
		t := time.NewTicker(time.Hour)
		defer t.Stop()
		for {
			select {
			case <-ctx.Done():
				return
			case <-t.C:
				jobs.RunLocked(ctx, "shopbook-jobs", sbJobsTick)
			}
		}
	}()
	log.Println("[shopbook-jobs] hourly tick started")
}

func sbSummaryHourUTC() int {
	if v, err := strconv.Atoi(os.Getenv("SHOPBOOK_SUMMARY_HOUR_UTC")); err == nil && v >= 0 && v <= 23 {
		return v
	}
	return 15
}

func sbJobsTick(ctx context.Context) {
	if time.Now().UTC().Hour() != sbSummaryHourUTC() {
		return
	}

	// ONE replica runs this tick, not all of them.
	//
	// The dedupe below is SELECT-then-INSERT with no unique index behind it,
	// which is idempotent across a RESTART and not across two processes. That
	// distinction does not matter today — there is one replica — and stops
	// being academic the moment there are two, because `--scale go-api=2`
	// starts both containers in the same second, so both hourly tickers fire
	// within milliseconds of each other. Every hour. That is the steady state,
	// not a rare interleave.
	//
	// The cost of losing that race is not a stray row: sbNotify emits a socket
	// event, writes an inbox row AND sends an Expo push, so it is a duplicate
	// notification to every shop owner and every customer carrying a balance.
	//
	// Same SETNX pattern as the realtime janitor and the chat-viewer sweep. The
	// TTL is under the hour so a replica that dies mid-tick cannot wedge the
	// job until someone notices, and over the work so a slow run cannot be
	// lapped by the next tick.
	if c := redisx.Client; c != nil {
		ok, err := c.SetNX(ctx, "vc:sbjobs:lock", time.Now().UTC().Format(time.RFC3339), 55*time.Minute).Result()
		if err == nil && !ok {
			return // another replica has this hour
		}
		// err != nil ⇒ Redis is unreachable. Fall through and run: a missed
		// daily summary is worse than a duplicated one, and with Redis down
		// there is almost certainly only one replica serving anyway.
	}
	sbSendDailySummaries(ctx)
	sbSendWeeklyReminders(ctx)
	sbSweepUncollectedOrders(ctx)
}

// Orders the customer never picked up and the owner never wrote off would sit
// in 'ready' forever, poisoning the dashboard and reports (design D5a). After
// sbSweepUncollected they become 'not_collected' — terminal, and with no
// ledger entry or invoice, because nothing was actually handed over.
func sbSweepUncollectedOrders(ctx context.Context) {
	rows, err := db.Pool.Query(ctx, `
		UPDATE shopbook_order o
		   SET status='not_collected', not_collected_reason='expired', updated_at=NOW()
		 WHERE o.status='ready'
		   AND COALESCE((SELECT MAX(at) FROM shopbook_order_event e
		                  WHERE e.order_id=o.id AND e.status='ready'), o.updated_at)
		       < NOW() - $1::interval
		RETURNING o.id, o.customer_user_id,
		          (SELECT owner_user_id FROM shopbook_shop WHERE id=o.shop_id)`,
		fmt.Sprintf("%d hours", int(sbSweepUncollected.Hours())))
	if err != nil {
		log.Printf("[shopbook-jobs] uncollected sweep failed: %v", err)
		return
	}
	defer rows.Close()
	type row struct{ orderID, custID, ownerID string }
	all := []row{}
	for rows.Next() {
		var x row
		if rows.Scan(&x.orderID, &x.custID, &x.ownerID) == nil {
			all = append(all, x)
		}
	}
	rows.Close()
	for _, x := range all {
		_, _ = db.Pool.Exec(ctx,
			`INSERT INTO shopbook_order_event (order_id, status, note)
			 VALUES ($1,'not_collected','expired')`, x.orderID)
		// Nobody came for these goods, so they go back on the shelf. Without
		// this the reservation outlives the order and the shop slowly loses
		// sellable stock to orders that ended weeks ago.
		if x.ownerID != "" {
			if err := db.WithUser(ctx, x.ownerID, func(tx pgx.Tx) error {
				var shopID string
				if err := tx.QueryRow(ctx,
					`SELECT shop_id FROM shopbook_order WHERE id=$1`, x.orderID).Scan(&shopID); err != nil {
					return err
				}
				return sbReleaseOrder(ctx, tx, shopID, x.orderID, x.ownerID, "expired uncollected")
			}); err != nil {
				log.Printf("[shopbook-jobs] stock release failed (order=%s): %v", x.orderID, err)
			}
		}
		body := "An order was never collected and has been closed."
		if x.custID != "" {
			sbNotify(ctx, x.custID, "Order not collected", body,
				map[string]any{"event": "order_status", "orderId": x.orderID, "status": "not_collected", "side": "customer"})
		}
		if x.ownerID != "" {
			sbNotify(ctx, x.ownerID, "Order not collected", body,
				map[string]any{"event": "order_status", "orderId": x.orderID, "status": "not_collected", "side": "owner"})
		}
	}
	if len(all) > 0 {
		log.Printf("[shopbook-jobs] swept %d uncollected order(s)", len(all))
	}
}

// Daily summary per shop owner: today's orders, sales, pending khata total
// and out-of-stock count (spec: notifications / Daily summary). The inbox
// row (event='daily_summary') doubles as the sent-today marker.
func sbSendDailySummaries(ctx context.Context) {
	rows, err := db.Pool.Query(ctx, `
		SELECT s.id, s.owner_user_id, s.currency,
		       COALESCE(o.cnt,0), COALESCE(o.sales,0), COALESCE(p.pending,0), COALESCE(st.low,0)
		  FROM shopbook_shop s
		  LEFT JOIN LATERAL (
			SELECT COUNT(*) AS cnt, SUM(total) AS sales FROM shopbook_order
			 WHERE shop_id=s.id AND created_at::date = NOW()::date) o ON TRUE
		  LEFT JOIN LATERAL (
			SELECT SUM(CASE WHEN type='purchase' THEN amount ELSE -amount END) AS pending
			  FROM shopbook_ledger WHERE shop_id=s.id) p ON TRUE
		  LEFT JOIN LATERAL (
			SELECT COUNT(*) AS low FROM shopbook_product p
			  LEFT JOIN shopbook_stock k ON k.product_id = p.id
			 WHERE p.shop_id=s.id AND p.enabled
			   AND CASE WHEN p.track_stock
			            THEN k.reorder_level > 0 AND k.available <= k.reorder_level
			            ELSE NOT p.in_stock END) st ON TRUE
		 WHERE s.approved
		   AND NOT EXISTS (
			SELECT 1 FROM shopbook_notification n
			 WHERE n.user_id=s.owner_user_id AND n.event='daily_summary'
			   AND n.created_at::date = NOW()::date)`)
	if err != nil {
		log.Printf("[shopbook-jobs] summary query failed: %v", err)
		return
	}
	defer rows.Close()
	type row struct {
		shopID, ownerID, currency string
		cnt, low                  int
		sales, pending            float64
	}
	all := []row{}
	for rows.Next() {
		var x row
		if rows.Scan(&x.shopID, &x.ownerID, &x.currency, &x.cnt, &x.sales, &x.pending, &x.low) == nil {
			all = append(all, x)
		}
	}
	rows.Close()
	for _, x := range all {
		if x.cnt == 0 && x.pending <= 0 && x.low == 0 {
			continue // nothing worth a ping today
		}
		body := fmt.Sprintf("%d order(s) · %s%.0f sales · %s%.0f pending",
			x.cnt, x.currency, x.sales, x.currency, x.pending)
		if x.low > 0 {
			body += fmt.Sprintf(" · %d out of stock", x.low)
		}
		sbNotify(ctx, x.ownerID, "Today at your shop 📊", body,
			map[string]any{"event": "daily_summary", "shopId": x.shopID})
	}
}

// Weekly pending-payment reminders (spec: notifications / Pending reminder;
// design open-question default: weekly, any nonzero balance). The inbox row
// (event='reminder') is the per-customer-per-shop cooldown marker — manual
// owner reminders count too, so customers are never double-pinged.
func sbSendWeeklyReminders(ctx context.Context) {
	rows, err := db.Pool.Query(ctx, `
		SELECT l.shop_id, s.name, s.currency, l.customer_user_id,
		       SUM(CASE WHEN l.type='purchase' THEN l.amount ELSE -l.amount END) AS pending
		  FROM shopbook_ledger l JOIN shopbook_shop s ON s.id=l.shop_id
		 GROUP BY l.shop_id, s.name, s.currency, l.customer_user_id
		HAVING SUM(CASE WHEN l.type='purchase' THEN l.amount ELSE -l.amount END) > 0`)
	if err != nil {
		log.Printf("[shopbook-jobs] reminder query failed: %v", err)
		return
	}
	defer rows.Close()
	type row struct {
		shopID, shopName, currency, custID string
		pending                            float64
	}
	all := []row{}
	for rows.Next() {
		var x row
		if rows.Scan(&x.shopID, &x.shopName, &x.currency, &x.custID, &x.pending) == nil {
			all = append(all, x)
		}
	}
	rows.Close()
	for _, x := range all {
		var recent bool
		if db.Pool.QueryRow(ctx, `
			SELECT EXISTS(SELECT 1 FROM shopbook_notification
			 WHERE user_id=$1 AND event='reminder' AND data->>'shopId'=$2
			   AND created_at > NOW() - INTERVAL '7 days')`,
			x.custID, x.shopID).Scan(&recent) != nil || recent {
			continue
		}
		sbNotify(ctx, x.custID, "Payment reminder 🔔",
			fmt.Sprintf("%s%.0f pending at %s", x.currency, x.pending, x.shopName),
			map[string]any{"event": "reminder", "shopId": x.shopID})
	}
}
