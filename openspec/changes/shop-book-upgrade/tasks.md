## 1. Backend Foundation & Data Model

- [ ] 1.1 Define Firestore collections (namespaced `sb_`): shops, products, orders, ledger entries, invoices, notifications, users' shopbook profile, countries, categories, plans — with security rules and indexes
- [ ] 1.2 Seed the six launch country configs (India, US, UK, Australia, Canada, Singapore) as versioned documents: currency, tax type, optional tax fields, optional documents, formats, invoice layout
- [ ] 1.3 Seed the fourteen shop-category configs with starter catalogs
- [ ] 1.4 Implement Go backend order state machine: transition validation (incl. actor-scoped cancellation windows), timestamped timeline events, per-item availability sub-states
- [ ] 1.5 Implement transactional ledger service: append-only entries (purchase/payment/adjustment), derived balances, shop-scoped sequential invoice numbering
- [ ] 1.6 Implement geohash-based nearby-shop query endpoint (neighbor-cell expansion + true-distance filter)
- [ ] 1.7 Implement plan-limit checks (1 shop, 200 unique ledger customers on Free) at relationship-creation time

## 2. Onboarding & Accounts

- [ ] 2.1 Build shared Shop Book onboarding flow reusing the existing phone-OTP auth: role selection (customer / shop owner), customer signup (name + location permission)
- [ ] 2.2 Build shop-owner registration: required fields, one-time GPS capture, shop-front photo upload, optional fields; created in pending-approval state
- [ ] 2.3 Wire country selection to the tax engine: load and render country config (tax fields, documents, formats) in shop settings
- [ ] 2.4 Build shop profile editing (timings, weekly holiday, payment methods, photos) and shop status control (Open/Busy/Closing Soon/Closed/Holiday/Vacation, with automatic Closing Soon)
- [ ] 2.5 Build customer dashboard: current orders, order/purchase history, pending amounts, payment history, favorites, shopping lists, saved brands

## 3. Catalog & Discovery

- [ ] 3.1 Build owner product management: CRUD with all product fields, stock status, starter-catalog activation (price + activate), CSV import
- [ ] 3.2 Build customer shop-discovery home: nearby list with distance, status, closing time, pickup availability, prep time; category filter; manual-area fallback
- [ ] 3.3 Build customer shop catalog view and product search; product detail with quantity, optional brand, notes
- [ ] 3.4 Build manual (free-text) product entry flow with optional brand and notes
- [ ] 3.5 Build price comparison: same-product listing across nearby shops with price, stock, last-updated; sorting by lowest price / nearest / open now

## 4. Ordering

- [ ] 4.1 Build cart (product, qty, brand, unit, price, notes, total; unpriced custom items) and order placement
- [ ] 4.2 Build owner new-order review screen: per-item Available / Alternative (suggest substitute + price) / Unavailable, accept/reject order
- [ ] 4.3 Build customer alternatives response flow: accept / reject / remove item, then continue order with updated total
- [ ] 4.4 Build owner order-progress controls (Preparing → Packing → Ready → Collected) and customer order-tracking timeline
- [ ] 4.5 Implement cancellation UX both sides (with required reason and window enforcement) and rejection flow with the six reason codes
- [ ] 4.6 On completion: trigger ledger entry + invoice generation + status notifications end-to-end

## 5. Ledger & Invoicing

- [ ] 5.1 Build owner ledger (khata): per-customer balances, payment recording (full/partial), pending-collections overview
- [ ] 5.2 Build customer ledger view: per-shop purchases, paid, pending, transaction history — same data both sides
- [ ] 5.3 Implement config-driven invoice rendering: country layout, tax breakdown only when configured, config-version snapshot on issue; shareable format
- [ ] 5.4 Build invoice history for both roles with view/share

## 6. Notifications

- [ ] 6.1 Implement backend notification fan-out on order events, payments, low stock, and scheduled jobs (daily summary, pending reminders — default weekly on nonzero balance)
- [ ] 6.2 Build in-app notification center (read/unread, mark-all-read) and wire FCM/Notifee push for both roles

## 7. Reports & Subscriptions

- [ ] 7.1 Build sales reports (daily/weekly/monthly/yearly) with totals, order count, AOV, and chart
- [ ] 7.2 Build insight reports: pending payments, tax report (per country config), best sellers, top customers, product performance
- [ ] 7.3 Gate report depth by plan (Free: basic; Pro: advanced) with upgrade preview screens
- [ ] 7.4 Implement Pro subscription purchase via store billing, receipt verification, plan stamping, lapse-to-Free behavior, and admin plan overrides

## 8. Admin Portal

- [ ] 8.1 Build admin web portal shell with role-based admin auth and append-only audit logging on every action
- [ ] 8.2 Build shop approval queue: registration review, document verification, approve (with verified badge) / reject with reason
- [ ] 8.3 Build country/tax-engine management UI (add/edit countries, fields, formats, documents; versioned publish)
- [ ] 8.4 Build category and starter-catalog management UI
- [ ] 8.5 Build subscription-plan management, platform reports, support-request queue, and promotions management

## 9. Localization & Release

- [ ] 9.1 Integrate i18n runtime with the six launch languages, device-locale default, in-app switcher, English fallback, remote bundle updates
- [ ] 9.2 Apply country-config formatting (currency, date, time, phone, address) across customer, owner, and invoice surfaces
- [ ] 9.3 Add store-compliance items: location-permission declarations, subscription disclosures; update EAS profiles
- [ ] 9.4 Feature-flag the Shop Book surfaces, run end-to-end order lifecycle QA (place → alternatives → collect → ledger → invoice → notifications), and enable for the India pilot
