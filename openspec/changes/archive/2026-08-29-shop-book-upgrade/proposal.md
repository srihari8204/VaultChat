## Why

Local shops still run on paper ledgers and phone-call orders, while customers have no way to discover nearby shops, compare prices, or track what they owe. Shop Book upgrades the platform into a global local-commerce product: a free customer app for discovering shops, placing pickup orders, and keeping a digital purchase ledger, plus a subscription-based shop-owner app that replaces the paper khata with product, order, billing, and payment management. A Country Tax Engine (India GST, US Sales Tax, UK VAT, Australia GST, Canada GST/HST/PST, Singapore GST) makes the same app work worldwide without hardcoding any one country's tax rules.

## What Changes

- New **Customer app** journey: mobile + OTP registration (name and location only — no lengthy signup), nearby-shop discovery by GPS, text-based catalog browsing/search, cart with brand/quantity/notes, pickup order placement and live status tracking, price comparison across nearby shops, digital purchase ledger, and a customer dashboard. Always free.
- New **Shop-owner app** journey: shop registration (shop name, owner, OTP, country, category, address, one-time GPS capture, shop-front photo), product management with per-category starter catalogs (14 launch categories, extensible without app changes), order review with availability marking (`Available` / `Alternative` / `Unavailable`), the full order pipeline (Pending → Accepted → Preparing → Packing → Ready → Collected → Completed, plus Rejected/Cancelled), customer khata ledger, invoices, reports, and staff-facing notifications.
- New **Country Tax Engine**: selecting a country loads currency, tax type, invoice layout, address/phone/date/time formats, country-specific optional tax fields (e.g., GSTIN/HSN for India, EIN for US, VAT number for UK, ABN for Australia, BN/GST-HST for Canada, UEN for Singapore) and optional business documents. All tax fields remain optional.
- New **order alternatives flow**: owner suggests an alternative brand/product for out-of-stock items; customer accepts, rejects, or removes the item before the order proceeds.
- New **cancellation/rejection rules**: customer may cancel before acceptance, owner before packing; rejection requires a reason (Out of Stock, Shop Closed, Quantity Not Available, Outside Business Hours, Technical Issue, Other) with immediate customer notification.
- New **subscription plans** for shop owners: Free (1 shop, 200 customers, catalog, orders, ledger, basic reports) and Pro (unlimited customers/products, inventory, advanced reports, staff accounts, cloud backup, analytics, priority support). Customers never require a subscription.
- New **Admin portal**: shop approval and verification-document review, country/tax-engine configuration, category management, subscription management, platform reports, support requests, promotions.
- New **notifications** for both roles (order lifecycle, alternatives, payments, low stock, daily summary, pending reminders) and **reports** for owners (daily/weekly/monthly/yearly sales, pending payments, tax reports, best sellers, top customers).
- **Multi-language support** (English, Hindi, Telugu, Tamil, Gujarati, Kannada at launch; extensible).
- Version 1 is intentionally **text-only catalogs** (no product images) and **pickup-only** (no delivery, no online payments) — those are roadmap phases 2/3.

## Capabilities

### New Capabilities
- `customer-accounts`: customer registration (mobile + OTP + name + location permission), profile, and the customer dashboard (current orders, history, pending amount, favorites, shopping lists, saved brands).
- `shop-accounts`: shop-owner registration and verification, shop profile (timings, weekly holiday, payment methods, photos, verified badge), and shop status (Open / Busy / Closing Soon / Closed / Holiday / Vacation).
- `country-tax-engine`: per-country configuration — currency, tax type, formats, optional tax fields, and optional business documents — loaded automatically on country selection; admin-manageable without app releases.
- `shop-discovery`: GPS-based nearby-shop listing with distance, category, open/closed state, closing time, pickup availability, and estimated preparation time.
- `product-catalog`: product CRUD (name, brand, category, unit, price, discount, tax, stock status, description, availability), per-category starter catalogs, and customer product search including manual free-text product entry with optional brand preference.
- `order-management`: cart, order placement, the availability-review and alternatives flow, the full status pipeline, cancellation and rejection rules, and order timeline tracking.
- `price-comparison`: same-product price listing across nearby shops with stock availability and last-updated time, sortable by lowest price, nearest, or open now.
- `digital-ledger`: automatic per-customer khata — purchase amount, paid amount, pending amount, transaction history, invoice history — visible to both customer and owner.
- `invoicing`: country-rule-driven invoice generation (business details, invoice number, customer, products, tax breakdown only when configured, payment status).
- `notifications`: customer and owner notification catalogs across the order, payment, and stock lifecycle.
- `reports-analytics`: owner sales/tax/product/customer reports scoped by plan tier.
- `subscription-plans`: Free and Pro tiers for shop owners, limit enforcement (shops, customers), and plan upgrade flow; customer app permanently free.
- `admin-portal`: shop approval, document review, country/tax-engine and category management, subscription management, platform reports, support, promotions.
- `localization`: multi-language UI with per-country default formats (date, time, phone, address) sourced from the tax engine.

### Modified Capabilities
<!-- No existing openspec/specs/* capabilities are modified; Shop Book is a new product surface. Reuse of the existing stack (Expo app shell, OTP auth, push notifications, backend) is at the implementation layer. -->

## Impact

- **Client**: new Expo Router route groups for the customer app, shop-owner app, and shared onboarding; reuses the existing React Native + Expo shell, phone-OTP auth flow, and Notifee/FCM push pipeline. New screens are text-first (no image pipeline needed in v1).
- **Backend**: new domain services and schema for shops, products, orders, ledger entries, invoices, subscriptions, and country tax configs (Firestore collections and/or the Go backend, consistent with the existing split); geo-queries for nearby-shop discovery; server-driven country/tax/category config so admin changes need no app release.
- **Admin**: extends the existing `admin/` surface into the Shop Book admin portal (approvals, tax engine, categories, subscriptions, reports, support).
- **Dependencies**: geolocation/geo-query support (e.g., geohashing) for discovery and price comparison; i18n library for localization; no map SDK, no payment gateway, and no image storage required in v1.
- **Compliance/stores**: location-permission declarations for shop discovery; subscription billing for the owner app must follow store billing policies in shipped markets.

---

## Addendum — 2026-08-10

Scope changes and risks identified after the original 26/26 completion. Recorded
here rather than silently absorbed, because three of them are launch blockers
that the chat product does not share.

### A. Order pipeline: collection is the CUSTOMER's to assert

```
OWNER: Pending → Accepted → Preparing → Packing → Ready
USER:  Ready → Collected → Completed
```

An owner cannot truthfully assert that a customer collected goods. Moving the
final two transitions to the customer prevents fake completion and is what makes
the khata trustworthy — the ledger only closes when the person who owes money
says the goods are in their hands.

**This introduces a stuck-order state that MUST be designed, not discovered.** A
customer who collects and never reopens the app leaves the order at `Ready`
forever, polluting the owner's dashboard, reports and pending-payment totals.
Required: either auto-complete after N days at `Ready`, or an owner-side
"not collected" action resolving to a DISTINCT terminal state — never
`Completed`, which would re-introduce exactly the fake completion this change
exists to prevent.

### B. Claimable tax invoices (input tax credit)

A buyer who supplies a tax number (GSTIN in India, and the equivalent elsewhere)
is making a business purchase and can reclaim the tax — but only against a
compliant tax invoice. The same sale to a walk-in customer needs no such
document.

One sale, therefore two invoice shapes, chosen by whether the buyer gave a tax
number:

| Buyer provides tax no. | Document | Must carry |
|---|---|---|
| yes | tax invoice | both parties' tax numbers, per-item HSN/SAC, tax split by rate |
| no | retail invoice | totals only; no tax number, no reclaim |

Both must look correct and complete — a retail customer should never see a
half-filled tax invoice with blank statutory fields, which is what a single
template produces. Extends `invoicing` and `country-tax-engine`; the buyer tax
number joins the existing optional-field set and stays optional throughout.

### C. Shop Book inherits VaultChat's infrastructure but NOT its threat model

The single most important line in this addendum. Chat is end-to-end encrypted,
so a database compromise yields ciphertext. Shop Book's khata, invoices and
order history are **plaintext money records**. Four deferrals that are cheap for
chat are expensive here:

1. **RLS is inert and this is now a blocker, not hardening.** The DB role is
   `rolsuper=t rolbypassrls=t`, so every policy is bypassed. One missing
   `WHERE customer_id = …` exposes every customer's debts to every other
   customer, and every shop's turnover to its competitors. `digital-ledger` is
   precisely where such a bug lives. See the RLS remediation order in
   `docs/RLS_ENFORCEMENT.md` — enabling it breaks chat creation if the policies
   are not written first.
2. **Push is a launch blocker.** A pickup order the shop never sees is worse
   than having no app: the customer walks to the shop expecting a packed order.
   FCM is unconfigured. NOTE the live trap — `android/app/google-services.json`
   is project `vaultchatprod01` while the Firebase console shown was
   `vaultchat-ce9e3`; a service account from the wrong project fails silently.
3. **Backups become statutory, not just durable.** Tax invoices carry retention
   requirements (commonly 5–7 years) in most launch countries. Every dump
   currently sits on the same disk as the database it came from.
4. **Shop owners are inherently multi-device** — phone in hand, tablet at the
   counter — and Pro sells staff accounts outright. `identity_keys`,
   `signed_prekeys` and `one_time_prekeys` are keyed by `user_id` with NO
   `device_id`, so the last device to publish wins. Confirm early whether Shop
   Book accounts share that key layer; if they do, "counter tablet" and "staff
   accounts" collide with a single-device model.

### D. Price comparison — decide the policy before building

It is the reason a customer opens this app instead of phoning the shop, and the
reason an owner may leave the platform after being undercut by a rupee. Two
decisions are needed BEFORE implementation, not after the first complaint:
whether owners may opt out, and how stale prices are presented. Surfacing
`last-updated` is the right instinct; showing a two-week-old price as current is
how shops are lost.

### E. Capabilities with no screen in the design system

Five named capabilities had no corresponding screen, plus the states every
GPS-driven app hits constantly:

- **alternatives flow** — the differentiator, and the hardest interaction here:
  a partially-modified cart the customer must approve per item, mid-pipeline
- **rejection reason picker** — six defined reasons, required before commit
- **price comparison** — price / distance / stock / last-updated, three sorts
- **country + tax onboarding** — country selection and its optional tax fields
- **shop status** — SIX states (Open / Busy / Closing Soon / Closed / Holiday /
  Vacation), so the badge needs six variants
- **empty and offline states** — "no shops within range" is a routine screen in
  a discovery app, not an edge case

### F. Two design-system constraints that conflict with the spec as written

- **Fixed row heights vs Indic scripts.** Rows are specified at 64/60/56 px with
  1.4× line height. Devanagari, Telugu, Tamil and Kannada need roughly 1.5–1.6×
  for ascenders and matras, so names will clip or descenders collide. Use
  `min-height`, and test the tightest screen in **Telugu** — typically the
  tallest of the six launch languages.
- **Caption contrast.** `#6B7280` on `#F9FAFB` is ≈4.4:1, under the 4.5:1 WCAG AA
  floor for small text. Darken to `#4B5563` or raise captions to 14px.

Also: the order step indicator should render the owner-controlled and
customer-controlled segments distinctly. A uniform progress bar hides the
handoff that makes the flow trustworthy, which is the entire point of change A.
