## 1. Schema & Config Engine (backend)

- [ ] 1.1 Migration `064_shopbook_upgrade.sql` (idempotent): extend order statuses (`new`→`pending`, add `accepted`/`collected`/`rejected`), cancel/reject reason columns, `shopbook_order_event` timeline table, shop `approved`/`verified`/`country`/`currency`/`tax_config`/`invoice_seq` (+ `holiday`/`vacation` statuses), product `tax_percent`/`updated_at`, order-item `tax_percent`/`unit`, `shopbook_invoice`, `shopbook_notification`, `shopbook_country`, `shopbook_category` (+ starter items), `shopbook_admin_log`; seed six countries and fourteen category starter catalogs; grandfather existing shops as approved
- [ ] 1.2 Go: `GET /shopbook/countries` (tax engine configs) and `GET /shopbook/starter-catalog?category=` served from the new tables
- [ ] 1.3 Go: shop upsert accepts `country` + `tax_config`, stamps `currency` from the country config, new shops start unapproved; nearby/search/details expose `approved`, `verified`, holiday/vacation status

## 2. Order Pipeline (backend)

- [ ] 2.1 Go: server-validated transitions (pending→accepted→preparing→packing→ready→collected→completed) with timeline events; require item review resolved before accept; legacy `new` mapped to `pending`
- [ ] 2.2 Go: customer cancel endpoint (pending only, reason required) and owner cancel (before packing, reason required); owner reject from pending with the six reason codes; notifications both ways
- [ ] 2.3 Go: on collected — ledger purchase, sequential invoice generation with country/tax snapshot, auto-advance to completed
- [ ] 2.4 Go: Free-plan 200-unique-customer enforcement at first ledger/order relationship; one-shop rule already enforced by schema

## 3. Discovery, Comparison, Reports, Notifications (backend)

- [ ] 3.1 Go: price comparison returns stock status, last-updated, and shop timing fields; supports lowest-price/nearest sort orders (open-now computed client-side)
- [ ] 3.2 Go: reports restructure — basic (daily/weekly/monthly sales, pending payments) on Free; advanced (yearly, tax report from snapshots, best sellers, top customers, product performance) Pro-gated
- [ ] 3.3 Go: notification inbox (`GET /shopbook/notifications`, mark-read) — `sbNotify` persists rows; customer cross-shop pending summary endpoint
- [ ] 3.4 Go jobs: owner daily summary and weekly pending-payment reminders (env-gated)

## 4. Client — Types, Services, Config

- [ ] 4.1 `utils/shopbook.ts`: new statuses + labels/progress, cancellation-window helpers, `formatMoney(currency)`, holiday/vacation open-state
- [ ] 4.2 `services/shopBookService.ts`: countries, starter catalog, cancel/reject, invoices, notifications, pending summary, new report shapes
- [ ] 4.3 Compat mapping for legacy `new` status in cached/old responses

## 5. Client — UI (`app/shop-book.tsx`)

- [ ] 5.1 Owner order flow: review→accept/reject (reason codes), progress to collected, cancel with reason; customer tracking timeline with new statuses + cancel (pending only, reason)
- [ ] 5.2 Owner settings: country picker + dynamic tax fields from the engine, holiday/vacation status controls
- [ ] 5.3 Invoice view (country layout, tax breakdown only when configured) + share; invoice history in ledgers
- [ ] 5.4 Notification center (list, unread badge, mark-all-read)
- [ ] 5.5 Starter-catalog one-tap seeding in product management; report screens for the new basic/advanced split; currency-aware money everywhere
- [ ] 5.6 Customer dashboard: cross-shop pending summary

## 6. Admin & Localization

- [ ] 6.1 Go: `/api/admin/shopbook/*` routes behind `adminAuth` — pending shops, approve/reject with verified badge, stats, country config editing, category/starter editing; every mutation logged to `shopbook_admin_log`
- [ ] 6.2 `admin/shopbook.html`: self-contained admin page (approvals, stats, country + category editors)
- [ ] 6.3 `lib/shopbookI18n.ts`: six-language catalogs (en/hi/te/ta/gu/kn), device-locale default, persisted override; wire tabs, headers, statuses, and key actions in `app/shop-book.tsx`

## 7. Verification & Artifact Sync

- [ ] 7.1 `go vet`/`go build` clean; selftest for new `utils/shopbook.ts` helpers alongside existing selftest pattern
- [ ] 7.2 `npm run typecheck` clean
- [ ] 7.3 OpenSpec artifacts kept in sync with what shipped (design/specs deltas noted)
