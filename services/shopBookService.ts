// services/shopBookService.ts — thin typed wrapper over lib/api.ts for the
// SHOP BOOK backend (vaultchat-backend-go/internal/routes/shopbook.go).
// JWT attach + refresh are handled by api(); this file is just endpoint shapes.

import * as FileSystem from 'expo-file-system/legacy';
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

// ── P1-A: purchases ───────────────────────────────────────────────
export interface PurchaseSummary {
  id: string; supplierName: string; invoiceNumber: string; purchasedOn: string;
  subtotal: number; taxTotal: number; total: number; note: string; itemCount: number;
}
export interface PurchaseItemInput {
  productId?: string; name: string; unit?: string;
  qty: number; costPrice: number; taxPercent?: number;
}
export interface PurchaseDetail extends Omit<PurchaseSummary, 'itemCount'> {
  items: (PurchaseItemInput & { lineTax: number; lineTotal: number })[];
}
export function purchases() {
  return api<{ purchases: PurchaseSummary[]; totalSpend: number }>(`/shopbook/my-shop/purchases`);
}
export function purchaseDetails(id: string) {
  return api<PurchaseDetail>(`/shopbook/my-shop/purchases/${id}`);
}
export function createPurchase(p: {
  supplierId?: string; supplierName?: string; invoiceNumber?: string;
  purchasedOn?: string; note?: string; idempotencyKey?: string;
  items: PurchaseItemInput[];
}) {
  return api<{ id: string; subtotal: number; taxTotal: number; total: number; duplicate?: boolean }>(
    `/shopbook/my-shop/purchases`, { method: 'POST', json: p });
}

// ── P1-B: returns and credit notes ────────────────────────────────
export type ReturnStatus = 'requested' | 'approved' | 'rejected' | 'completed';
export interface ShopReturn {
  id: string; orderId: string; status: ReturnStatus; reason: string;
  decisionNote: string; settlement: 'refund' | 'credit';
  refundTotal: number; requestedAt: string;
  customerName: string; shopName: string; currency: string;
  creditNoteId: string;
}
export function requestReturn(orderId: string, reason: string,
  items: { orderItemId: string; qty: number }[], idempotencyKey?: string) {
  return api<{ id: string; status: ReturnStatus; refundTotal: number }>(
    `/shopbook/orders/${orderId}/return`,
    { method: 'POST', json: { reason, items, idempotencyKey } });
}
export function myReturns() {
  return api<{ returns: ShopReturn[] }>(`/shopbook/returns`).then((r) => r.returns);
}
export function shopReturns(status?: string) {
  const qs = status && status !== 'all' ? `?status=${status}` : '';
  return api<{ returns: ShopReturn[] }>(`/shopbook/my-shop/returns${qs}`).then((r) => r.returns);
}
// `note` is required when refusing — the server enforces it, and a refusal
// with no reason is the most complained-about outcome of any returns process.
export function decideReturn(id: string, approve: boolean,
  opts: { note?: string; settlement?: 'refund' | 'credit'; restock?: boolean } = {}) {
  return api<{ ok: boolean; status: string; creditNoteId?: string; refundTotal?: number }>(
    `/shopbook/my-shop/returns/${id}/decide`, { method: 'POST', json: { approve, ...opts } });
}

export interface CreditNote {
  id: string; kind: 'credit' | 'debit'; number: number; noteNo: string;
  reason: string; currency: string; customerName: string;
  subtotal: number; taxTotal: number; total: number;
  items: { name: string; unit: string; qty: number; price: number; tax: number; total: number }[];
  business: { name?: string; address?: string; phone?: string; tax?: Record<string, string> };
  createdAt: string;
}
export function creditNote(id: string) {
  return api<CreditNote>(`/shopbook/credit-notes/${id}`);
}

// ── P1-F: shop audit trail ────────────────────────────────────────
export interface AuditEntry {
  id: number; actor: string; role: string; action: string;
  entity: string; entityId: string;
  before: Record<string, any>; after: Record<string, any>;
  reason: string; at: string;
}
export function auditLog(entity?: string) {
  const qs = entity ? `?entity=${encodeURIComponent(entity)}` : '';
  return api<{ entries: AuditEntry[] }>(`/shopbook/my-shop/audit${qs}`).then((r) => r.entries);
}

// ── P1-D: verification and documents ──────────────────────────────
export type VerifyState = 'unverified' | 'pending_review' | 'verified' | 'suspended' | 'rejected';
export interface ShopDocument {
  id: string; kind: string; filename: string; mime: string;
  sizeBytes: number; status: 'pending' | 'accepted' | 'rejected';
  reviewNote: string; uploadedAt: string;
}
export function shopDocuments() {
  return api<{
    documents: ShopDocument[]; accepted: string[];
    verifyState: VerifyState; verifyNote: string;
  }>(`/shopbook/my-shop/documents`);
}
// Two steps on purpose: the file goes straight from the device to storage, so
// it never passes through the API and never sits in a request body.
export function presignDocument(kind: string, mime: string, size: number) {
  return api<{ uploadUrl: string; objectKey: string; expiresIn: number }>(
    `/shopbook/my-shop/documents/presign`, { method: 'POST', json: { kind, mime, size } });
}
export function saveDocument(d: {
  kind: string; objectKey: string; filename?: string; mime?: string; size?: number;
}) {
  return api<{ id: string; status: string }>(`/shopbook/my-shop/documents`, { method: 'POST', json: d });
}
// What the server accepts (shopbook_verify.go sbDocMimes / sbDocMaxBytes).
export const DOC_MIMES = ['image/jpeg', 'image/png', 'image/webp', 'application/pdf'];
export const DOC_MAX_BYTES = 10 * 1024 * 1024;

/** presign → PUT the file straight to storage → record it. The file never
 *  passes through the API. */
export async function uploadDocument(kind: string, file: { uri: string; name?: string; mimeType?: string; size?: number }) {
  const mime = file.mimeType ?? '';
  const size = file.size ?? 0;
  const { uploadUrl, objectKey } = await presignDocument(kind, mime, size);
  const put = await FileSystem.uploadAsync(uploadUrl, file.uri, {
    httpMethod: 'PUT',
    uploadType: FileSystem.FileSystemUploadType.BINARY_CONTENT,
    headers: { 'Content-Type': mime },
  });
  if (put.status < 200 || put.status >= 300) throw new Error(`The upload did not complete (${put.status}). Try again.`);
  return saveDocument({ kind, objectKey, filename: file.name, mime, size });
}
export function deleteDocument(id: string) {
  return api<{ ok: boolean }>(`/shopbook/my-shop/documents/${id}`, { method: 'DELETE' });
}
// A short-lived link, re-checked every time. Never cache the URL.
export function documentUrl(id: string) {
  return api<{ url: string; expiresIn: number }>(`/shopbook/my-shop/documents/${id}/url`);
}
export function submitVerification() {
  return api<{ ok: boolean; verifyState: VerifyState }>(
    `/shopbook/my-shop/submit-verification`, { method: 'POST', json: {} });
}
// Returns the list of what's still missing on a 400, so the UI can say which.
export function missingForVerification(err: any): string[] | null {
  return err?.status === 400 && err?.body?.code === 'incomplete' ? (err.body.missing ?? []) : null;
}

export interface LocationRequest {
  id: string; status: 'pending' | 'approved' | 'rejected'; reviewNote: string;
  address: string; reason: string; lat: number; lng: number;
  distanceKm: number; requestedAt: string;
}
export function requestLocationChange(lat: number, lng: number, address: string, reason: string) {
  return api<{ id: string; status: string; distanceKm: number }>(
    `/shopbook/my-shop/location-request`, { method: 'POST', json: { lat, lng, address, reason } });
}
export function myLocationRequest() {
  return api<{ request: LocationRequest | null }>(`/shopbook/my-shop/location-request`)
    .then((r) => r.request);
}
// A verified shop's pin is fixed; moving it more than ~300m needs review.
export function locationLocked(err: any): boolean {
  return err?.status === 409 && err?.body?.code === 'location_locked';
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
  // P0-C: dropped at the counter during billing. Kept on the order rather than
  // deleted, so the record still shows what was asked for.
  removed?: boolean;
  // What the customer originally asked for. `qty` is what they were billed —
  // the quantity actually packed, where the shop weighed it out.
  requestedQty?: number;
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
  // The owner's free text behind a rejection coded 'other'. Absent until the
  // server stores and returns it, and then shown beside the reason.
  rejectNote?: string;
  notCollectedReason: string;   // '' unless the order expired or was written off
  hasInvoice: boolean;
  /**
   * The business this order is being bought FOR. A tax number here makes the
   * document a reclaimable tax invoice; empty leaves it a retail bill. Frozen
   * once the invoice is issued, which is why it is shown back to the customer
   * rather than accepted and forgotten.
   */
  buyerTax: InvoiceBuyer;
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

export interface LedgerItem {
  name: string;
  brand: string;
  unit: string;
  qty: number;
  price: number;
  taxPercent: number;
}

export interface LedgerEntry {
  id: string;
  type: 'purchase' | 'payment';
  amount: number;
  remark: string;
  createdAt: string;
  /** Lines behind a credit entry. Always [] for a payment. */
  items: LedgerItem[];
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
  todayCustomers: number;
  pendingOrders: number;
  lowStock: number;
  totalPending: number;
  todayPurchases: number;
  purchaseSpend: number;
  // Margin is only present when at least one sale had a cost basis — the
  // server would rather omit profit than invent it. `marginCoverage` says how
  // much of the day's revenue the figure actually accounts for.
  costOfGoods?: number;
  grossProfit?: number;
  marginCoverage?: { revenueWithCost: number; revenueTotal: number };
}

export interface CustomerPending {
  customerId: string;
  customerName: string;
  pending: number;
  /**
   * True when this party is a WALK-IN (shopbook_khata_customer), not a
   * crazzychat account. The two live in different columns of shopbook_ledger and
   * `shopbook_ledger_party_ck` rejects a row that sets both, so every write has
   * to know which one it is dealing with.
   */
  isKhata?: boolean;
  /** Walk-ins only. The number the khata is keyed on; '' when none was given. */
  mobile?: string;
  /** ISO time of their most recent payment; null if they have never paid. */
  lastPaymentAt: string | null;
  /**
   * Days since that payment — or since their first entry if they have never
   * paid. Deliberately NOT invoice aging: it does not allocate payments
   * against individual purchases. "No payment in 45 days", nothing more.
   */
  staleDays: number;
  /**
   * The party's credit ceiling; 0 means no ceiling. Optional because a client
   * may be talking to a backend that predates the field — an unknown limit is
   * shown as unknown rather than guessed at as 0, which would read as
   * "no ceiling" when the truth might be the opposite.
   */
  creditLimit?: number;
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

// P2: cursor paging. Pass the previous page's `nextCursor`; an empty
// nextCursor means the end, so no extra request is needed to discover it.
export interface Paged<T> { orders: T[]; nextCursor: string }
export function myOrdersPage(cursor?: string, limit = 50) {
  const q = new URLSearchParams();
  if (cursor) q.set('cursor', cursor);
  q.set('limit', String(limit));
  return api<Paged<OrderSummary>>(`/shopbook/orders?${q}`);
}
export function ownerOrdersPage(status?: string, cursor?: string, limit = 50) {
  const q = new URLSearchParams();
  if (status && status !== 'all') q.set('status', status);
  if (cursor) q.set('cursor', cursor);
  q.set('limit', String(limit));
  return api<Paged<OrderSummary>>(`/shopbook/my-shop/orders?${q}`);
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

/**
 * The owner's shop plus what the account screens need beside it, from the one
 * /my-shop read.
 *
 * `entitledPlan` and `proRequestedAt` are written into the server contract but
 * not served yet (handoff in the round-4 Shop Book log). Until they are, both
 * come back undefined — "unknown", never Free or "not requested" — and the
 * caller falls back: the plan from entitledPlan() below, the request time from
 * the request itself.
 */
export function myShopAccount() {
  return api<{ shop: Shop | null; entitledPlan?: 'free' | 'pro'; proRequestedAt?: string | null }>(`/shopbook/my-shop`)
    .then((r) => ({
      shop: r.shop,
      entitledPlan: r.entitledPlan === 'pro' || r.entitledPlan === 'free' ? r.entitledPlan : undefined,
      proRequestedAt: typeof r.proRequestedAt === 'string' ? r.proRequestedAt : undefined,
    }));
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
// (free text); the backend validates transitions and windows. `note` is the
// owner's own words for a rejection coded 'other' — sent only then, and
// harmless to a server that does not read it yet (it then simply drops it).
export function setOrderStatus(orderId: string, status: OrderStatus, reason = '', note = '') {
  return api<{ ok: boolean; status: OrderStatus }>(`/shopbook/my-shop/orders/${orderId}/status`, {
    method: 'POST', json: note ? { status, reason, note } : { status, reason },
  });
}

export function dashboard() {
  return api<Dashboard>(`/shopbook/my-shop/dashboard`);
}

export function ownerLedgerSummary() {
  return api<{ customers: CustomerPending[] }>(`/shopbook/my-shop/ledger`).then((r) => r.customers);
}

export function ownerCustomerLedger(customerId: string, isKhata = false) {
  // A walk-in's history is in khata_customer_id, so it needs its own parameter.
  // Passing a khata id as customerId would return an EMPTY ledger rather than an
  // error — the screen would show a customer who owes nothing.
  const q = isKhata ? 'khataCustomerId' : 'customerId';
  return api<Ledger>(`/shopbook/my-shop/ledger?${q}=${encodeURIComponent(customerId)}`);
}

// `idempotencyKey` makes a retried payment resolve to the one already
// recorded instead of crediting the customer twice. Generate it once per
// entry the owner is trying to save, and reuse it across retries.
/**
 * `items` is optional. When supplied the SERVER derives the amount from the
 * lines and ignores whatever `amount` says — so a caller passing both cannot
 * produce an entry whose lines disagree with its total.
 */
export function addLedgerEntry(
  customerId: string, type: 'purchase' | 'payment', amount: number, remark = '',
  idempotencyKey?: string, items?: LedgerItem[], confirmOverLimit = false,
  isKhata = false,
) {
  // Exactly one party column, enforced server-side by shopbook_ledger_party_ck.
  // Sending both would be rejected; sending the wrong one writes debt against
  // the wrong person, so the caller passes the discriminator it read from the
  // summary rather than this guessing from the id's shape.
  const party = isKhata ? { khataCustomerId: customerId } : { customerId };
  return api<{ id: string; duplicate?: boolean }>(`/shopbook/my-shop/ledger`, {
    method: 'POST',
    json: { ...party, type, amount, remark, idempotencyKey, items, confirmOverLimit },
  });
}

// ── walk-in khata customers (migrations 111/112) ──────────────────
// A customer with no crazzychat account: the person who walks in, takes goods on
// credit and is known to the shop by a name and a phone number.

export interface KhataCustomer {
  id: string;
  /** True when this mobile already had a khata and the existing one was returned. */
  duplicate?: boolean;
}

/**
 * Create a walk-in khata customer, or return the existing one for this mobile.
 *
 * ONE HOUSEHOLD, ONE KHATA. The server deduplicates on (shop, mobile), so when
 * a wife, a son or anyone else from the same family buys on the same number
 * they land on the SAME khata rather than opening a second one that has to be
 * reconciled by hand later. `duplicate: true` says that happened.
 *
 * A blank mobile is deliberately NOT deduplicated — the unique index is partial
 * (WHERE mobile <> '') so a shop can still keep several name-only customers
 * apart. Two different people called "Ramesh" with no number are two khatas.
 */
export function createKhataCustomer(p: {
  name: string; mobile?: string; altMobile?: string; address?: string; notes?: string;
}) {
  return api<KhataCustomer>(`/shopbook/my-shop/khata-customers`, {
    method: 'POST',
    json: {
      name: p.name.trim(),
      mobile: (p.mobile ?? '').trim(),
      altMobile: (p.altMobile ?? '').trim(),
      address: (p.address ?? '').trim(),
      notes: (p.notes ?? '').trim(),
    },
  });
}

/** Set a walk-in's credit ceiling. 0 means no ceiling (migration 112 default). */
export function setKhataCreditLimit(khataCustomerId: string, creditLimit: number) {
  return api<{ ok: boolean }>(
    `/shopbook/my-shop/khata-customers/${khataCustomerId}/credit-limit`,
    { method: 'POST', json: { creditLimit } });
}

// ── documents (migration 110) ─────────────────────────────────────
// Four sources, one immutable numbered document, one server-rendered layout.
// The phone never lays out a line or adds up a column.

/** Paper for goods given on credit. Idempotent: returns duplicate:true if already issued. */
export function issueKhataInvoice(ledgerId: string) {
  return api<{ id: string; duplicate?: boolean }>(
    `/shopbook/my-shop/ledger/${ledgerId}/invoice`, { method: 'POST' });
}

/** Paper for money received against a khata. */
export function issueKhataReceipt(ledgerId: string) {
  return api<{ id: string; duplicate?: boolean }>(
    `/shopbook/my-shop/ledger/${ledgerId}/receipt`, { method: 'POST' });
}

/** Cash sale to someone who is not a crazzychat user. Writes no ledger entry —
 *  nothing is owed, so it must not appear as a debt. */
export function counterSale(name: string, phone: string, items: LedgerItem[]) {
  return api<{ id: string; total: number }>(`/shopbook/my-shop/counter-sale`, {
    method: 'POST', json: { name, phone, items },
  });
}

/** The rendered document as HTML. api() returns raw text when the body is not
 *  JSON, so this needs no special transport. Feed it to Print/WebView. */
export function invoiceHtml(invoiceId: string) {
  return api<string>(`/shopbook/invoices/${invoiceId}/render`);
}

// A 409 from addLedgerEntry when the purchase would push the customer past the
// credit limit their shop set. A WARNING, not a refusal — resend with
// confirmOverLimit to proceed. The owner knows the customer; the app does not.
export interface CreditBreach { pending: number; limit: number; afterEntry: number }
export function creditBreachFrom(err: any): CreditBreach | null {
  const b = err?.body;
  if (err?.status !== 409 || b?.code !== 'over_credit_limit') return null;
  return { pending: b.pending ?? 0, limit: b.limit ?? 0, afterEntry: b.afterEntry ?? 0 };
}

// ── Phase 2b: payment reminders, plan, reports ────────────────────
export function sendReminder(customerId: string) {
  return api<{ ok: boolean; sent: boolean; pending?: number }>(`/shopbook/my-shop/ledger/remind`, {
    method: 'POST', json: { customerId },
  });
}

// Cancel down to Free only. The server refuses 'pro' (403): Pro comes from a
// paid entitlement that an admin or a verified purchase writes, never from the
// owner's own request.
export function setPlan(plan: 'free') {
  return api<{ ok: boolean; plan: string }>(`/shopbook/my-shop/plan`, { method: 'POST', json: { plan } });
}
// Ask for Pro. This GRANTS NOTHING: the team switches the entitlement on once
// the subscription is paid. Idempotent server-side — asking again keeps (and
// returns) the first request time, so a double tap is not two requests.
export function requestPro() {
  return api<{ ok: boolean; requestedAt: string }>(`/shopbook/my-shop/plan/request-pro`, { method: 'POST' });
}
// True when the server has no such route yet (404/405), as opposed to a real
// refusal or a network failure — the Request Pro endpoint is written but not
// deployed, and "Could not send" would read as a fault the owner can retry.
export function notAvailableYet(err: any): boolean {
  return (err?.status === 404 || err?.status === 405) && !err?.body?.error;
}

// The plan the shop is ENTITLED to — what every server gate checks. Shop.plan
// is only a display column and can drift (an expired entitlement does not
// rewrite it). /reports is the one owner endpoint that returns the entitled
// plan TODAY, so this reads it from the basic report.
// ponytail: computes the whole basic report to read one field. Only the
// fallback for a server whose /my-shop does not yet return `entitledPlan`
// (myShopAccount); remove once that field is deployed.
export function entitledPlan() {
  return reports('basic').then((r) => r.plan);
}
// True when the server refused because the feature needs Pro.
export function needsUpgrade(err: any): boolean {
  return err?.status === 403 && !!err?.body?.upgrade;
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
