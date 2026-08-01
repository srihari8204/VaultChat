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
}

export interface Product {
  id: string;
  name: string;
  brand: string;
  category: string;
  unit: string;
  price: number;
  inStock: boolean;
  enabled: boolean;
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
}

export interface OrderItem {
  id: string;
  name: string;
  brand: string;
  qty: number;
  price: number;
  note: string;
  availability: ItemAvailability;
  altName: string;
}

export interface OrderDetail {
  id: string;
  shopId: string;
  status: OrderStatus;
  total: number;
  note: string;
  createdAt: string;
  items: OrderItem[];
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
  name: string; brand: string; qty: number; price: number; note: string;
}
export function placeOrder(shopId: string, items: PlaceOrderItem[], note: string) {
  return api<{ id: string; status: OrderStatus }>(`/shopbook/orders`, {
    method: 'POST', json: { shopId, items, note },
  });
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
  orderId: string, itemId: string, availability: ItemAvailability, altName = '',
) {
  return api<{ ok: boolean }>(`/shopbook/my-shop/orders/${orderId}/item/${itemId}`, {
    method: 'POST', json: { availability, altName },
  });
}

export function setOrderStatus(orderId: string, status: OrderStatus) {
  return api<{ ok: boolean; status: OrderStatus }>(`/shopbook/my-shop/orders/${orderId}/status`, {
    method: 'POST', json: { status },
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

export function addLedgerEntry(
  customerId: string, type: 'purchase' | 'payment', amount: number, remark = '',
) {
  return api<{ id: string }>(`/shopbook/my-shop/ledger`, {
    method: 'POST', json: { customerId, type, amount, remark },
  });
}

export default {};
