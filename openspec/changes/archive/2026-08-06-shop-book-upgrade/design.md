## Context

See `proposal.md` — Why. **Implementation survey (2026-08-04) found Shop Book already exists as a working mini-app in this repo** — this change is an *upgrade*, not a greenfield build:

- Postgres schema: `vaultchat-backend/migrations/061–063_shopbook*.sql` (shop, product, order, order_item, ledger, favorites, ratings, coupons, suppliers, free/pro plan flag).
- API: `vaultchat-backend-go/internal/routes/shopbook.go` (~1,600 lines; Go-only, no Node parity) — nearby shops (haversine), catalog, orders with per-item availability review + customer alternative decisions, khata ledger, dashboard, reports (Pro), reminders, Expo push via `sbNotify`.
- Client: `app/shop-book.tsx` single screen with Customer/Owner modes, `services/shopBookService.ts`, `utils/shopbook.ts`, `constants/shopCategories.ts`.

What the upgrade must add: the full order pipeline (pending/accepted/collected/rejected + cancellation windows + reasons + timeline), the Country Tax Engine, invoicing, shop approval + verified badge, server-managed starter catalogs, Free-plan limit enforcement, notification inbox, report tiers, an admin surface, and localization. Constraints that shape the approach:

- V1 is text-only catalogs, pickup-first, no online payments, no maps SDK (distance + lists, not map tiles).
- The same binary serves both roles and all countries — country and category behavior must be data, not code.
- Admin changes (countries, tax fields, categories, starter catalogs) must take effect without an app release.
- Existing shops and orders must keep working — migrations grandfather current rows (e.g. existing shops stay approved; `new` orders map to `pending`).

## Goals / Non-Goals

**Goals:**
- One mobile app with role-based entry: a user can be a customer, an owner, or both, behind one OTP identity.
- A Country Tax Engine and category system that are pure server-side configuration, versioned so issued invoices stay stable.
- An order pipeline with an explicit availability-review step and auditable status transitions.
- Ledger and invoicing as append-only records both parties can trust.
- Free/Pro plan enforcement server-side (not just UI gating).

**Non-Goals:**
- Product images, barcodes/QR, delivery, online payments, ratings, loyalty, WhatsApp/voice ordering (Phase 2 roadmap).
- AI forecasting, multi-shop/franchise, warehouse, supplier portal, POS hardware (Phase 3 roadmap).
- Migrating or altering any existing VaultChat messaging/calling capability — Shop Book is additive.

## Decisions

**D1 — Keep the existing one-screen, two-mode mini-app shell.**
`app/shop-book.tsx` already implements Customer/Owner modes with in-screen tab bars behind one OTP identity. The upgrade extends this screen rather than splitting into route groups — smallest reviewable diff, no navigation rework. A later split into route groups stays cheap because logic lives in `services/` + `utils/`, not in the screen.

**D2 — Postgres stays the system of record; all logic in the existing Go routes.**
The mini-app is already Postgres + Go (`shopbook.go`), with every query scoped by caller id. The upgrade adds migration `064` and extends the same route file(s). The Go backend owns everything atomic or trusted: order state transitions, ledger math, invoice numbering, plan-limit checks. (The original greenfield design proposed Firestore; discarded — migrating a working Postgres implementation would be pure churn.)

**D3 — Haversine + bounding-box discovery, no map SDK (unchanged).**
The existing nearby-shops query (bounding box on indexed lat/lng, haversine distance, server-side sort) is adequate at current scale; geohashing is premature. The UI stays list-based — no react-native-maps, no prebuild change.

**D4 — Country Tax Engine as DB-seeded, admin-editable config rows.**
New tables `shopbook_country` (currency symbol/code, tax type, field definitions JSONB, document checklist JSONB, format hints) and `shopbook_category` + starter items, seeded by migration for the six launch countries and fourteen categories, served by `GET /shopbook/countries` and `GET /shopbook/starter-catalog`, editable via admin routes — no per-country code paths, no app release for changes. The shop row stores its chosen `country`, `currency`, and a `tax_config` JSONB of the optional field values. Every invoice stores the resolved values it was generated with (immutable snapshot), so admin edits never mutate issued invoices.

**D5 — Extend the existing order flow into the full server-validated state machine.**
Migration renames `new`→`pending` and adds `accepted`, `collected`, `rejected`; a new `shopbook_order_event` table records every timestamped transition (the customer-visible timeline). Allowed transitions and actor rules are enforced in Go: customer cancels only from Pending; owner cancels before Packing; owner rejects from Pending with one of the six reason codes; cancellation reason required. Marking Collected posts the ledger purchase, generates the invoice, and auto-advances to Completed (both events on the timeline). The existing per-item availability review (pending/available/unavailable/alternative + customer decision) is kept and must be resolved before Accept.

**D6 — Ledger as append-only entries, balances derived (unchanged).**
The existing `shopbook_ledger` already is an append-only purchase/payment stream with derived pending balances, read identically by both parties. The upgrade only links completed orders to invoices and adds the customer's cross-shop pending summary endpoint.

**D7 — Plan limits enforced server-side; Pro upgrade stays a manual flag for now.**
The Free plan's limits (one shop — already a unique index; 200 unique ledger customers) are checked in Go at relationship-creation time, not in the UI. The repo's existing decision (migration 063: "manual upgrade — no payment gateway") is kept for this change; store-billing receipt verification is deliberate follow-up work before any paid launch, and the admin surface can flip plans for support cases.

**D8 — Admin surface via the existing `x-admin-key` pattern.**
Shopbook admin routes (`/api/admin/shopbook/*`) reuse `adminAuth` (constant-time key compare + rate limit) from `routes/admin.go`: pending-shop approval with verified badge, country/tax editing, category/starter-catalog editing, platform stats. UI is a self-contained `admin/shopbook.html` page in the style of the existing console. A full role-based multi-admin portal with audit logs is follow-up; every admin mutation is still recorded to a `shopbook_admin_log` table now so the audit trail starts on day one.

**D9 — Dependency-free in-repo i18n module.**
A small `lib/shopbookI18n.ts` (typed keys, six language catalogs, device-locale default, persisted override) rather than i18next — matching the repo's dependency-light philosophy and keeping the surface scoped to Shop Book strings. Currency/date formatting comes from the shop's country config (D4), not the UI language — shop-country formats always win on invoices.

## Risks / Trade-offs

- [Status rename `new`→`pending` breaks stale clients] → Old app versions post statuses the new CHECK still accepts (`preparing`…`completed`); the Go layer also maps a legacy `new` write to `pending`, and the client maps cached `new` reads.
- [Approval gate would hide every existing live shop] → Migration grandfathers current rows (`approved=TRUE`); only shops created after the migration start unapproved.
- [Price-comparison matching across shops is fuzzy for free-text catalogs] → Match on normalized product name at launch and show last-updated time so stale/mismatched entries are self-evident; category-scoped canonical names can improve matching later without an app change.
- [Config-driven invoices risk producing legally odd layouts in some countries] → Invoices always carry the resolved snapshot (D4) so a bad config can be fixed forward without corrupting history; per-country review before enabling a market.
- [Manual Pro flag means no real payment enforcement] → Accepted, matches the repo's existing decision; server-side limit checks land now so store billing can slot in without schema change.
- [200-customer limit checks add a backend hop to first-contact flows] → Limit check only fires on first ledger relationship per customer, not per order.
- [One 2,300-line screen keeps growing] → New UI kept in extracted components within the file where practical; logic goes to `utils/shopbook.ts` (testable) and `services/shopBookService.ts`, mirroring the existing pattern.

## Migration Plan

1. Migration `064` (idempotent, additive + data backfill) ships first; it is safe with the old Go binary running.
2. Deploy the Go backend (new endpoints + state machine + seeded configs).
3. Ship the admin page so real shops can be approved during beta.
4. Ship the client update (new flows tolerate old backend responses during rollout).
5. Rollback = redeploy previous Go binary; migration is backward-compatible (old code ignores new columns/tables; `pending` was never written by old code but its CHECK is dropped and recreated to include it).

## Open Questions

- Auto pending-payment reminder cadence (default implemented: weekly, any nonzero balance, per-shop opt-out later).
- Pro pricing per country (manual flag for now — pricing needed before any paid market launch).
- Whether "Busy" status should pause new orders or only warn (default implemented: warn only).
