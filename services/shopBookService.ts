// services/shopBookService.ts — thin typed wrapper over lib/api.ts for the
// SHOP BOOK backend (vaultchat-backend-go/internal/routes/shopbook.go).
// JWT attach + refresh are handled by api(); this file is just endpoint shapes.

import { api } from '../lib/api';
import type { ItemAvailability, OrderStatus, ShopStatus } from '../utils/shopbook';

// ── shared shapes ─────────────────────────────────────────────────
export interface Shop {
  id: string;
  name: string;
  category: string;
  address: string;
  lat: number | null;
  lng: number | null;
  phone: string;
  openTime: string;
  closeTime: string;
  weeklyHoliday: string;
  status: ShopStatus;
  pickup: boolean;
  prepMins: number;
  distanceKm?: number;
  // Phase 2
  delivery: boolean;
  deliveryFee: number;
  rating: number;       // 0–5, avg
  ratingCount: number;
  // Phase 2b
  plan: 'free' | 'pro';
  lunchStart: string;   // HH:MM, '' = none
  lunchEnd: string;
  // Upgrade (openspec: shop-book-upgrade)
  approved: boolean;
  verified: boolean;
  country: string;               // ISO-3166 alpha-2, e.g. 'IN'
  currency: string;              // display symbol from the country config
  taxConfig: Record<string, string | boolean>;
}

export interface Product {
  id: string;
  name: string;
  brand: string;
  category: string;
  unit: string;
  price: number;
  inStock: boolean;    // for a tracked product this is derived: available > 0
  enabled: boolean;
  taxPercent: number;
  updatedAt: string;   // price freshness (shown in comparison)
  // P0-B inventory. Present only on the OWNER's catalog and only when the
  // product is tracked — on-hand and cost are the shop's business, so the
  // customer endpoint never sends them.
  trackStock: boolean;
  available?: number;
  onHand?: number;
  reserved?: number;
  reorderLevel?: number;
  costPrice?: number;
}

// ── P0-C: live billing ────────────────────────────────────────────
// Every field here is computed by the server. The client renders the bill it
// is given and never adds anything up itself — that is the whole design.
export interface BillLine {
  id: string; name: string; brand: string; unit: string;
  requestedQty: number;    // what the customer asked for — never overwritten
  fulfilledQty: number;    // what the shop actually packed
  weighed: boolean;        // true once the shop set an actual quantity
  price: number; taxPercent: number;
  discount: number; tax: number; total: number;
  availability: ItemAvailability; removed: boolean; custom: boolean;
}
export interface Bill {
  orderId: string; status: OrderStatus; currency: string;
  lines: BillLine[];
  subtotal: number; discount: number; billDiscount: number;
  taxTotal: number; roundOff: number; deliveryFee: number; total: number;
  buyerTax: { businessName?: string; taxNumber?: string; address?: string };
  editable: boolean;
}
export function getBill(orderId: string) {
  return api<Bill>(`/shopbook/my-shop/orders/${orderId}/bill`);
}
export interface BillUpdate {
  lines?: { id: string; fulfilledQty?: number | null; removed?: boolean }[];
  add?: { productId?: string; name: string; brand?: string; unit?: string; qty: number; price?: number; note?: string };
  billDiscount?: number;
}
// Returns the recomputed bill — always render the response, never local state.
export function updateBill(orderId: string, patch: BillUpdate) {
  return api<Bill>(`/shopbook/my-shop/orders/${orderId}/bill`, { method: 'POST', json: patch });
}

// The customer declares the business they're buying for. A tax number turns
// the document into a reclaimable tax invoice; omitting it keeps it a retail
// bill. Must be set before the invoice is issued.
export function setBuyerTax(orderId: string, buyer: { businessName?: string; taxNumber?: string; address?: string }) {
  return api<{ ok: boolean; invoiceKind: 'retail' | 'tax' }>(
    `/shopbook/orders/${orderId}/buyer-tax`, { method: 'POST', json: buyer });
}

// ── P0-E: payments ────────────────────────────────────────────────
export type PaymentMethod = 'cash' | 'bank' | 'upi' | 'card' | 'other';
export interface Payment {
  id: string; customerId: string; customerName: string; orderId: string;
  amount: number; method: PaymentMethod; status: string;
  reference: string; note: string; currency: string; shopName: string; createdAt: string;
}
export interface RecordedPayment {
  id: string; amount: number; method: PaymentMethod; duplicate?: boolean;
  invoiceId?: string; paymentStatus?: string; paid?: number; due?: number;
}
export function recordPayment(p: {
  customerId: string; orderId?: string; amount: number;
  method: PaymentMethod; reference?: string; note?: string; idempotencyKey?: string;
}) {
  return api<RecordedPayment>(`/shopbook/my-shop/payments`, { method: 'POST', json: p });
}
export function shopPayments(customerId?: string) {
  const qs = customerId ? `?customerId=${encodeURIComponent(customerId)}` : '';
  return api<{ payments: Payment[] }>(`/shopbook/my-shop/payments${qs}`).then((r) => r.payments);
}
export function myPayments() {
  return api<{ payments: Payment[] }>(`/shopbook/payments`).then((r) => r.payments);
}
export function setCreditLimit(customerId: string, creditLimit: number, note = '') {
  return api<{ ok: boolean; creditLimit: number }>(
    `/shopbook/my-shop/customers/${customerId}/credit-limit`,
    { method: 'POST', json: { creditLimit, note } });
}

// ── P0-B: inventory ───────────────────────────────────────────────
export interface StockRow {
  productId: string; name: string; brand: string; unit: string;
  costPrice: number; price: number;
  onHand: number; reserved: number; available: number; reorderLevel: number;
  low: boolean;
}
export function stockList() {
  return api<{ stock: StockRow[]; lowCount: number }>(`/shopbook/my-shop/stock`);
}

export type StockMoveKind = 'opening' | 'purchase' | 'damage' | 'adjustment' | 'return';

// `reason` is required by the server — stock never changes silently.
export function adjustStock(productId: string, kind: StockMoveKind, qty: number, reason: string) {
  return api<{ ok: boolean; onHand: number; available: number }>(
    `/shopbook/my-shop/stock/adjust`,
    { method: 'POST', json: { productId, kind, qty, reason } },
  );
}

export interface StockMovement {
  id: number; productId: string; name: string; kind: string;
  onHandDelta: number; reservedDelta: number;
  unit: string; reason: string; actor: string;
  refEntity: string; refId: string; at: string;
}
export function stockMovements(productId?: string) {
  const qs = productId ? `?productId=${encodeURIComponent(productId)}` : '';
  return api<{ movements: StockMovement[] }>(`/shopbook/my-shop/stock/movements${qs}`)
    .then((r) => r.movements);
}

// A 409 from setOrderStatus('accepted') when the shelf can't cover the order.
export interface Shortfall {
  productId: string; name: string; unit: string; wanted: number; available: number;
}
export function shortfallsFrom(err: any): Shortfall[] | null {
  const b = err?.body;
  if (err?.status !== 409 || b?.code !== 'insufficient_stock') return null;
  return (b.shortfalls ?? []) as Shortfall[];
}

// ── Country Tax Engine ────────────────────────────────────────────
export interface CountryTaxField { id: string; label: string; type?: 'bool' }
export interface CountryConfig {
  code: string;
  name: string;
  currencySymbol: string;
  currencyCode: string;
  taxType: string;               // GST | VAT | Sales Tax | GST/HST/PST
  taxSplit: string[];            // e.g. ['CGST','SGST']
  taxFields: CountryTaxField[];  // all optional, always
  documents: string[];
  dateFormat: string;
}

export function countries() {
  return api<{ countries: CountryConfig[] }>(`/shopbook/countries`).then((r) => r.countries);
}

export interface StarterItem { name: string; unit: string }
export function starterCatalog(category: string) {
  return api<{ items: StarterItem[] }>(
    `/shopbook/starter-catalog?category=${encodeURIComponent(category)}`,
  ).then((r) => r.items);
}

export interface OrderSummary {
  id: string;
  shopId?: string;
  shopName?: string;
  customerId?: string;
  customerName?: string;
  status: OrderStatus;
  total: number;
  createdAt: string;
  currency?: string;
}

export interface OrderItem {
  id: string;
  name: string;
  brand: string;
  unit: string;
  qty: number;
  price: number;
  taxPercent: number;
  note: string;
  availability: ItemAvailability;
  altName: string;
  altPrice: number;
  // P0-A: server-computed line money. `custom` = free-typed request the owner
  // still has to quote, so its price is 0 until they do.
  productId: string;
  custom: boolean;
  lineDiscount: number;
  lineTax: number;
  lineTotal: number;
}

export interface TimelineEvent { status: OrderStatus; note: string; at: string }

export interface OrderDetail {
  id: string;
  shopId: string;
  status: OrderStatus;
  total: number;
  // P0-A: the finalized breakdown the invoice and the khata both read.
  subtotal: number;
  taxTotal: number;
  roundOff: number;
  note: string;
  createdAt: string;
  items: OrderItem[];
  // Phase 2
  couponCode: string;
  discount: number;
  delivery: boolean;
  deliveryFee: number;
  address: string;
  rated: boolean;
  // Upgrade
  currency: string;
  timeline: TimelineEvent[];
  cancelReason: string;
  cancelledBy: '' | 'customer' | 'owner';
  rejectReason: string;
  notCollectedReason: string;   // '' unless the order expired or was written off
  hasInvoice: boolean;
  // Who issued the bill — shop identity travels with the order.
  shop: {
    name: string;
    address: string;
    phone: string;
    country: string;
    ownerName: string;
    taxConfig: Record<string, string>;   // e.g. { gstin: '29ABCDE1234F1Z5' }
  };
}

// ── invoices ──────────────────────────────────────────────────────
export interface InvoiceLine {
  name: string; brand: string; unit: string; qty: number; price: number; taxPercent: number;
}
export interface InvoiceBuyer { businessName?: string; taxNumber?: string; address?: string }

export interface Invoice {
  // 'tax' carries both parties' tax numbers and is reclaimable by a business
  // buyer; 'retail' is a plain bill with no statutory fields left blank.
  kind: 'retail' | 'tax';
  status: 'draft' | 'issued' | 'cancelled' | 'credited';
  buyer: InvoiceBuyer;
  roundOff: number;
  // Derived from the payments themselves, so it can never claim money that
  // isn't there.
  paymentStatus: 'unpaid' | 'partially_paid' | 'paid';
  paid: number;
  due: number;
  id: string;
  orderId: string;
  number: number;
  invoiceNo: string;      // e.g. INV-0042
  country: string;
  taxType: string;        // '' when the shop has no tax configured
  currency: string;
  subtotal: number;
  discount: number;
  taxTotal: number;
  total: number;
  business: { name: string; address: string; phone: string; tax: Record<string, string | boolean> };
  customerName: string;
  items: InvoiceLine[];
  taxBreakdown: { label: string; amount: number }[];
  createdAt: string;
}

export function orderInvoice(orderId: string) {
  return api<Invoice>(`/shopbook/orders/${orderId}/invoice`);
}

// ── notification inbox ────────────────────────────────────────────
export interface Notification {
  id: string;
  title: string;
  body: string;
  event: string;
  data: Record<string, unknown>;
  read: boolean;
  createdAt: string;
}

export function notifications() {
  return api<{ notifications: Notification[]; unread: number }>(`/shopbook/notifications`);
}

export function markNotificationsRead(ids?: string[]) {
  return api<{ ok: boolean }>(`/shopbook/notifications/read`, {
    method: 'POST', json: ids?.length ? { ids } : { all: true },
  });
}

// ── customer: cross-shop pending summary ──────────────────────────
export interface LedgerSummary {
  shopId: string; shopName: string; currency: string; pending: number; totalPurchase: number;
}
export function myLedgers() {
  return api<{ ledgers: LedgerSummary[]; totalPending: number }>(`/shopbook/my-ledgers`);
}

// ── Phase 2 shapes ────────────────────────────────────────────────
export interface Coupon {
  id?: string;
  code: string;
  kind: 'percent' | 'flat';
  value: number;
  minOrder: number;
  active?: boolean;
}

export interface Rating {
  stars: number;
  review: string;
  customerName: string;
  createdAt: string;
}

export interface Loyalty {
  points: number;
  completedOrders: number;
  totalSpent: number;
}

export interface Supplier {
  id?: string;
  name: string;
  phone: string;
  items: string;
  note: string;
}

export interface LedgerEntry {
  id: string;
  type: 'purchase' | 'payment';
  amount: number;
  remark: string;
  createdAt: string;
}

export interface Ledger {
  entries: LedgerEntry[];
  totalPurchase: number;
  totalPaid: number;
  pending: number;
}

export interface Dashboard {
  todayOrders: number;
  todaySales: number;
  pendingOrders: number;
  lowStock: number;
  totalPending: number;
}

export interface CustomerPending {
  customerId: string;
  customerName: string;
  pending: number;
}

// ── customer ──────────────────────────────────────────────────────
export function nearbyShops(lat?: number, lng?: number, category?: string) {
  const q = new URLSearchParams();
  if (lat != null && lng != null) { q.set('lat', String(lat)); q.set('lng', String(lng)); }
  if (category && category !== 'all') q.set('category', category);
  const qs = q.toString();
  return api<{ shops: Shop[] }>(`/shopbook/shops${qs ? '?' + qs : ''}`).then((r) => r.shops);
}

export function shopDetails(id: string) {
  return api<Shop>(`/shopbook/shops/${id}`);
}

export function shopProducts(id: string) {
  return api<{ products: Product[] }>(`/shopbook/shops/${id}/products`).then((r) => r.products);
}

export interface PlaceOrderItem {
  productId?: string;   // catalog row the line came from — the server prices from this
  name: string; brand: string; qty: number; price: number; note: string;
  unit?: string; taxPercent?: number;
}
export interface PlaceOrderOpts {
  couponCode?: string; delivery?: boolean; address?: string;
  // Same key on a retry ⇒ the same order. Generate once per attempt, reuse it
  // for every retry of that attempt.
  idempotencyKey?: string;
  // Set only after the customer has SEEN the new prices and agreed.
  confirmPricing?: boolean;
}
export interface PlacedOrder {
  id: string; status: OrderStatus;
  subtotal: number; discount: number; taxTotal: number; deliveryFee: number; total: number;
  duplicate?: boolean;
}

// A 409 from placeOrder when the shop's prices moved since the cart rendered.
// The customer must be shown these before the order is created.
export interface PriceChange {
  name: string; brand: string; unit: string; oldPrice: number; newPrice: number;
}
export function priceChangesFrom(err: any): { changes: PriceChange[]; total: number } | null {
  const b = err?.body;
  if (err?.status !== 409 || b?.code !== 'price_changed') return null;
  return { changes: (b.changes ?? []) as PriceChange[], total: Number(b.total) || 0 };
}

export function placeOrder(shopId: string, items: PlaceOrderItem[], note: string, opts: PlaceOrderOpts = {}) {
  return api<PlacedOrder>(
    `/shopbook/orders`,
    { method: 'POST', json: { shopId, items, note, ...opts } },
  );
}

// ── Phase 2: favorites ────────────────────────────────────────────
export function favorites() {
  return api<{ shops: Shop[] }>(`/shopbook/favorites`).then((r) => r.shops);
}
export function toggleFavorite(shopId: string) {
  return api<{ favorite: boolean }>(`/shopbook/favorites`, { method: 'POST', json: { shopId } });
}

// ── Phase 2: coupons / offers ─────────────────────────────────────
export function shopCoupons(shopId: string) {
  return api<{ coupons: Coupon[] }>(`/shopbook/shops/${shopId}/coupons`).then((r) => r.coupons);
}
export function ownerCoupons() {
  return api<{ coupons: Coupon[] }>(`/shopbook/my-shop/coupons`).then((r) => r.coupons);
}
export function saveCoupon(c: Coupon) {
  return api<{ id: string }>(`/shopbook/my-shop/coupons`, { method: 'POST', json: c });
}
export function deleteCoupon(id: string) {
  return api<{ ok: boolean }>(`/shopbook/my-shop/coupons/${id}`, { method: 'DELETE' });
}

// ── Phase 2: ratings ──────────────────────────────────────────────
export function shopRatings(shopId: string) {
  return api<{ ratings: Rating[] }>(`/shopbook/shops/${shopId}/ratings`).then((r) => r.ratings);
}
export function rateOrder(orderId: string, stars: number, review = '') {
  return api<{ ok: boolean }>(`/shopbook/orders/${orderId}/rate`, {
    method: 'POST', json: { stars, review },
  });
}

// ── Phase 2: loyalty ──────────────────────────────────────────────
export function loyalty() {
  return api<Loyalty>(`/shopbook/loyalty`);
}

// ── Phase 2: suppliers ────────────────────────────────────────────
export function suppliers() {
  return api<{ suppliers: Supplier[] }>(`/shopbook/my-shop/suppliers`).then((r) => r.suppliers);
}
export function saveSupplier(sup: Supplier) {
  return api<{ id: string }>(`/shopbook/my-shop/suppliers`, { method: 'POST', json: sup });
}
export function deleteSupplier(id: string) {
  return api<{ ok: boolean }>(`/shopbook/my-shop/suppliers/${id}`, { method: 'DELETE' });
}

export function myOrders() {
  return api<{ orders: OrderSummary[] }>(`/shopbook/orders`).then((r) => r.orders);
}

export function orderDetails(id: string) {
  return api<OrderDetail>(`/shopbook/orders/${id}`);
}

export function decideAlternative(orderId: string, itemId: string, accept: boolean) {
  return api<{ ok: boolean; availability: ItemAvailability }>(
    `/shopbook/orders/${orderId}/item/${itemId}/decision`,
    { method: 'POST', json: { accept } },
  );
}

// Customer cancels their own order — allowed only while it is still pending.
export function cancelOrder(orderId: string, reason: string) {
  return api<{ ok: boolean; status: OrderStatus }>(`/shopbook/orders/${orderId}/cancel`, {
    method: 'POST', json: { reason },
  });
}

// Only the customer can confirm collection; the server settles the khata,
// issues the invoice and returns the order already 'completed'.
export function collectOrder(orderId: string) {
  return api<{ ok: boolean; status: OrderStatus }>(`/shopbook/orders/${orderId}/collected`, {
    method: 'POST',
  });
}

export function customerLedger(shopId: string) {
  return api<Ledger>(`/shopbook/ledger/${shopId}`);
}

// ── shop owner ────────────────────────────────────────────────────
export function myShop() {
  return api<{ shop: Shop | null }>(`/shopbook/my-shop`).then((r) => r.shop);
}

export type ShopInput = Partial<Omit<Shop, 'id' | 'distanceKm'>> & { name: string };
export function saveShop(input: ShopInput) {
  return api<{ id: string }>(`/shopbook/my-shop`, { method: 'POST', json: input });
}

export function ownerProducts() {
  return api<{ products: Product[] }>(`/shopbook/my-shop/products`).then((r) => r.products);
}

export type ProductInput = Partial<Omit<Product, 'id'>> & { id?: string; name: string };
export function saveProduct(input: ProductInput) {
  return api<{ id: string }>(`/shopbook/my-shop/products`, { method: 'POST', json: input });
}

export function deleteProduct(id: string) {
  return api<{ ok: boolean }>(`/shopbook/my-shop/products/${id}`, { method: 'DELETE' });
}

export function ownerOrders(status?: string) {
  const qs = status && status !== 'all' ? `?status=${status}` : '';
  return api<{ orders: OrderSummary[] }>(`/shopbook/my-shop/orders${qs}`).then((r) => r.orders);
}

export function setItemAvailability(
  orderId: string, itemId: string, availability: ItemAvailability, altName = '', altPrice = 0,
) {
  return api<{ ok: boolean }>(`/shopbook/my-shop/orders/${orderId}/item/${itemId}`, {
    method: 'POST', json: { availability, altName, altPrice },
  });
}

// `reason` is required for 'rejected' (one of the six codes) and 'cancelled'
// (free text); the backend validates transitions and windows.
export function setOrderStatus(orderId: string, status: OrderStatus, reason = '') {
  return api<{ ok: boolean; status: OrderStatus }>(`/shopbook/my-shop/orders/${orderId}/status`, {
    method: 'POST', json: { status, reason },
  });
}

export function dashboard() {
  return api<Dashboard>(`/shopbook/my-shop/dashboard`);
}

export function ownerLedgerSummary() {
  return api<{ customers: CustomerPending[] }>(`/shopbook/my-shop/ledger`).then((r) => r.customers);
}

export function ownerCustomerLedger(customerId: string) {
  return api<Ledger>(`/shopbook/my-shop/ledger?customerId=${customerId}`);
}

// `idempotencyKey` makes a retried payment resolve to the one already
// recorded instead of crediting the customer twice. Generate it once per
// entry the owner is trying to save, and reuse it across retries.
export function addLedgerEntry(
  customerId: string, type: 'purchase' | 'payment', amount: number, remark = '',
  idempotencyKey?: string,
) {
  return api<{ id: string; duplicate?: boolean }>(`/shopbook/my-shop/ledger`, {
    method: 'POST', json: { customerId, type, amount, remark, idempotencyKey },
  });
}

// ── Phase 2b: payment reminders, plan, reports ────────────────────
export function sendReminder(customerId: string) {
  return api<{ ok: boolean; sent: boolean; pending?: number }>(`/shopbook/my-shop/ledger/remind`, {
    method: 'POST', json: { customerId },
  });
}

export function setPlan(plan: 'free' | 'pro') {
  return api<{ ok: boolean; plan: string }>(`/shopbook/my-shop/plan`, { method: 'POST', json: { plan } });
}

export interface ReportDay { date: string; orders: number; sales: number }
export interface TopProduct { name: string; qty: number; revenue?: number }
export interface TopCustomer { customerId: string; customerName: string; orders: number; spent: number }
export interface TaxMonth { month: string; taxableSales: number; taxCollected: number }
export interface Reports {
  plan: 'free' | 'pro';
  // basic (every plan)
  days: ReportDay[];
  weeks: ReportDay[];
  months: ReportDay[];
  pendingTotal: number;
  pendingCustomers: number;
  // advanced (Pro)
  years?: ReportDay[];
  taxReport?: TaxMonth[];
  topProducts?: TopProduct[];
  topCustomers?: TopCustomer[];
  productPerformance?: TopProduct[];
}
export function reports(scope: 'basic' | 'advanced' = 'basic') {
  return api<Reports>(`/shopbook/my-shop/reports?scope=${scope}`);
}

// ── Phase 2c: cross-shop product search + bulk add ────────────────
export interface ProductHit {
  shopId: string;
  shopName: string;
  category: string;
  rating: number;
  ratingCount: number;
  distanceKm?: number;
  productName: string;
  productBrand: string;
  price: number;
  unit: string;
  // Upgrade: stock, freshness + enough timing data for open-now sorting
  inStock: boolean;
  updatedAt: string;
  currency: string;
  shopStatus: ShopStatus;
  openTime: string;
  closeTime: string;
  weeklyHoliday: string;
  lunchStart: string;
  lunchEnd: string;
}
export function searchProducts(
  q: string, lat?: number, lng?: number, sort: 'price' | 'nearest' = 'price',
) {
  const p = new URLSearchParams({ q, sort });
  if (lat != null && lng != null) { p.set('lat', String(lat)); p.set('lng', String(lng)); }
  return api<{ results: ProductHit[] }>(`/shopbook/search-products?${p.toString()}`).then((r) => r.results);
}

export interface BulkProduct { name: string; brand?: string; category?: string; unit?: string; price?: number }
export function bulkAddProducts(items: BulkProduct[]) {
  return api<{ added: number }>(`/shopbook/my-shop/products/bulk`, { method: 'POST', json: { items } });
}

export default {};
