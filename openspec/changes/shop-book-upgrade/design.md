## Context

See `proposal.md` — Why. The repo today is an Expo Router React Native app (`app/`) with Firebase (phone-OTP auth, Firestore rules/indexes in repo), a Node backend (`vaultchat-backend/`), a Go backend (`vaultchat-backend-go/`), Notifee + FCM push, and a minimal static `admin/` page. Shop Book adds three product surfaces — customer app, shop-owner app, admin portal — on top of this stack. Constraints that shape the design:

- V1 is text-only catalogs, pickup-only, no online payments, no maps SDK (distance + lists, not map tiles).
- The same binary must serve both roles (customer and shop owner) and all countries — country and category behavior must be data, not code.
- Admin changes (countries, tax fields, categories, starter catalogs, plans) must take effect without an app release.

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

**D1 — One app, role-scoped route groups (vs. two separate apps).**
Add Expo Router groups `app/(shopbook-customer)/` and `app/(shopbook-owner)/` plus a shared `(shopbook-onboarding)` flow; role membership on the user profile decides the landing surface, with an in-app switcher for users who are both. One binary halves store-release overhead and lets an owner also shop as a customer with the same identity. Alternative — separate customer/owner apps — was rejected for v1: double the build/release/QA cost before product-market fit; the router groups keep a later split cheap.

**D2 — Firestore as the system of record; Go backend for transactional and geo logic.**
Shops, products, orders, ledger entries, invoices, notifications, and configs live in Firestore (real-time listeners give order tracking and owner dashboards for free, matching the app's existing Firebase usage). The Go backend owns operations that must be atomic or trusted: order state transitions, ledger balance updates, invoice numbering, plan-limit checks, and nearby-shop queries. Alternative — everything client-side against Firestore with security rules — rejected: sequential invoice numbers, balance math, and 200-customer enforcement cannot be safely done from clients.

**D3 — Geohash-based discovery, no map SDK.**
Store each shop's one-time GPS capture as lat/lng + geohash; nearby queries use geohash prefix ranges filtered by true distance server-side. The UI is list-based (distance text, not map tiles), so no react-native-maps dependency, no extra native module, no prebuild change. Alternative — map-first UI — deferred to the roadmap alongside delivery tracking.

**D4 — Country Tax Engine as versioned config documents.**
A `countries/{code}` config document carries currency, tax type, field definitions (id, label, optional, applies-to), document checklist, and format strings; a `categories/{id}` document carries the starter catalog. Clients render tax settings and invoice layouts from these definitions — no per-country code paths. Every invoice stores a snapshot reference `{countryCode, configVersion}` and the resolved values it was generated with, so admin edits never mutate issued invoices. Alternative — hardcoded per-country modules — rejected; it is exactly what the proposal forbids.

**D5 — Orders as a state machine with server-validated transitions.**
Allowed transitions (Pending→Accepted→Preparing→Packing→Ready→Collected→Completed; Pending→Rejected; Pending/Accepted/Preparing→Cancelled with actor rules: customer only from Pending, owner only before Packing) are enforced in the Go backend, which appends a timestamped event to the order's timeline and fans out notifications. The availability-review and alternatives exchange is modeled as per-item sub-state (available / alternative-proposed / alternative-accepted / removed / unavailable) resolved before the order may advance to Preparing. Client-side enforcement alone was rejected — cancellation windows and ledger side effects need one authority.

**D6 — Ledger as append-only entries, balances derived.**
Ledger truth is an append-only entry stream (purchase, payment, adjustment) per shop-customer pair; running balances are maintained transactionally by the backend and recomputable from the stream. Both parties read the same documents, which guarantees the "shared khata" property. Invoices are immutable documents keyed by the shop-scoped sequence from D5's completion event.

**D7 — Plan enforcement server-side; store billing for Pro.**
The Free plan's limits (1 shop, 200 unique ledger customers) are checked in the backend at relationship-creation time, not in the UI. Pro is sold via Play/App Store subscriptions (policy requirement for in-app digital services), with the backend verifying store receipts and stamping the shop's plan. Admin can also grant plan overrides (support, promotions).

**D8 — Reuse existing platform plumbing.**
Phone-OTP auth (existing Firebase phone auth flow), Notifee/FCM push, Sentry, and EAS build profiles are reused as-is. The `admin/` static page is replaced by a proper admin web portal deployed separately, backed by the same Go backend with role-based admin claims and an audit-log collection (append-only).

**D9 — i18n via a standard runtime (i18next or equivalent) with remote-loadable bundles.**
Six launch languages ship in the binary; the loader accepts server-delivered bundle updates so translation fixes and new languages don't require a release. Formatting (currency, date, phone, address) comes from the tax-engine config (D4), not from the UI language — shop-country formats always win on invoices.

## Risks / Trade-offs

- [Two roles in one binary bloats navigation and onboarding] → Strict route-group isolation, shared code only via `lib/shopbook/`; revisit a split once owner-side complexity grows (D1 keeps it cheap).
- [Firestore geo queries are approximate at geohash boundaries] → Query neighboring geohash cells and post-filter by true distance in the Go backend; cache per-area shop lists briefly.
- [Price-comparison matching across shops is fuzzy for free-text catalogs] → Match on normalized product name + unit at launch and show last-updated time so stale/mismatched entries are self-evident; category-scoped canonical product names can improve matching later without an app change.
- [Config-driven invoices risk producing legally odd layouts in some countries] → Per-country invoice templates reviewed at config time; invoices always carry the config snapshot (D4) so a bad template can be fixed forward without corrupting history.
- [Store-billing cut on Pro subscriptions reduces margin] → Accepted for v1; alternative billing per store policy can be evaluated per market later.
- [200-customer limit checks add a backend hop to first-contact flows] → Limit check only fires on first ledger relationship per customer, not per order; cached plan state on the shop document.
- [Existing VaultChat surfaces and Shop Book share one Firebase project — rule complexity grows] → Namespace all Shop Book collections under a `sb_` prefix (or subtree) with dedicated rules and indexes; no shared documents with chat features.

## Migration Plan

1. Ship backend first: collections, rules, indexes, Go endpoints, and the six country configs + fourteen category configs seeded (admin-editable thereafter).
2. Ship the admin portal early (approval + config management) so real shops can be onboarded during beta.
3. Ship the mobile surfaces behind a feature flag; enable per market (start with India).
4. No data migration is required — all Shop Book collections are new; existing app features are untouched. Rollback = disable the feature flag; backend collections are inert while hidden.

## Open Questions

- Reminder cadence and threshold for pending-payment notifications (product tuning; default: weekly, any nonzero balance).
- Pro pricing per country (₹499/month shown for India; other markets need pricing before their launch — does not affect specs or task breakdown).
- Whether "Busy" status should pause new orders or only warn (default: warn only).
