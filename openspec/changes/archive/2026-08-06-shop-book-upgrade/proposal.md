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
