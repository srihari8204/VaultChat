// utils/shopbook.ts — pure, dependency-free helpers for the SHOP BOOK mini-app.
// Kept out of the screen so the logic is testable and the screen stays thin.

export type ShopStatus = 'open' | 'busy' | 'closed';
export type OrderStatus =
  | 'new' | 'preparing' | 'packing' | 'ready' | 'completed' | 'cancelled';
export type ItemAvailability =
  | 'pending' | 'available' | 'unavailable' | 'alternative';

// ── money ─────────────────────────────────────────────────────────
export function formatINR(n: number): string {
  const v = Math.round((Number(n) || 0) * 100) / 100;
  return '₹' + v.toLocaleString('en-IN', { maximumFractionDigits: 2 });
}

// ── distance ──────────────────────────────────────────────────────
export function formatDistance(km?: number | null): string {
  if (km == null || !Number.isFinite(km)) return '';
  if (km < 1) return `${Math.round(km * 1000)} m`;
  return `${km.toFixed(1)} km`;
}

// ── open / closed ─────────────────────────────────────────────────
// Times are "HH:MM" 24h strings. `nowMins` defaults to the current local time.
export function minsOfDay(hhmm: string): number | null {
  const m = /^(\d{1,2}):(\d{2})$/.exec(hhmm?.trim() ?? '');
  if (!m) return null;
  const h = +m[1], mm = +m[2];
  if (h > 23 || mm > 59) return null;
  return h * 60 + mm;
}

export interface OpenState {
  isOpen: boolean;
  // "Open now" | "Closing in 20 min" | "Lunch break" | "Opens at 08:00"
  // | "Opens tomorrow" | "On holiday" | "Closed"
  label: string;
  tone: 'open' | 'soon' | 'closed';
}

const DAYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];

export interface ShopTimings {
  openTime: string;
  closeTime: string;
  status: ShopStatus;
  weeklyHoliday?: string;   // e.g. 'sun'
  lunchStart?: string;      // HH:MM, '' = none
  lunchEnd?: string;
}

// Now accepts a shop-like object so lunch-break + weekly-holiday are honoured.
// `now` is injectable for tests.
export function shopOpenState(s: ShopTimings, now?: Date): OpenState {
  if (s.status === 'closed') return { isOpen: false, label: 'Closed', tone: 'closed' };
  const d = now ?? new Date();
  const nowMins = d.getHours() * 60 + d.getMinutes();
  const today = DAYS[d.getDay()];

  // Weekly holiday → closed today; if it opens tomorrow, say so.
  if (s.weeklyHoliday && s.weeklyHoliday.toLowerCase() === today) {
    return { isOpen: false, label: 'On holiday', tone: 'closed' };
  }

  const o = minsOfDay(s.openTime), c = minsOfDay(s.closeTime);
  if (o == null || c == null) {
    return s.status === 'busy'
      ? { isOpen: true, label: 'Busy', tone: 'soon' }
      : { isOpen: true, label: 'Open now', tone: 'open' };
  }

  // Lunch break window (if set) — shop is temporarily closed.
  const ls = s.lunchStart ? minsOfDay(s.lunchStart) : null;
  const le = s.lunchEnd ? minsOfDay(s.lunchEnd) : null;
  if (ls != null && le != null && nowMins >= ls && nowMins < le) {
    return { isOpen: false, label: `Lunch break · back ${s.lunchEnd}`, tone: 'soon' };
  }

  // Handle shops that close after midnight (close < open).
  const within = c >= o ? (nowMins >= o && nowMins < c) : (nowMins >= o || nowMins < c);
  if (!within) {
    // Before opening today → "Opens at"; after closing → "Opens tomorrow".
    if (nowMins < o) return { isOpen: false, label: `Opens at ${s.openTime}`, tone: 'closed' };
    return { isOpen: false, label: 'Opens tomorrow', tone: 'closed' };
  }
  const minsToClose = (c - nowMins + 1440) % 1440;
  if (minsToClose <= 30) return { isOpen: true, label: `Closing in ${minsToClose} min`, tone: 'soon' };
  if (s.status === 'busy') return { isOpen: true, label: 'Busy', tone: 'soon' };
  return { isOpen: true, label: 'Open now', tone: 'open' };
}

// ── order status → customer-facing label / progress ───────────────
export const ORDER_STEPS: OrderStatus[] = ['new', 'preparing', 'packing', 'ready', 'completed'];

export function orderStatusLabel(s: OrderStatus): string {
  switch (s) {
    case 'new':        return 'Order placed';
    case 'preparing':  return 'Preparing';
    case 'packing':    return 'Packing';
    case 'ready':      return 'Ready to collect';
    case 'completed':  return 'Completed';
    case 'cancelled':  return 'Cancelled';
  }
}

// Progress 0..1 along the happy path (cancelled = 0).
export function orderProgress(s: OrderStatus): number {
  if (s === 'cancelled') return 0;
  const i = ORDER_STEPS.indexOf(s);
  return i < 0 ? 0 : i / (ORDER_STEPS.length - 1);
}

// The next status an owner can advance an order to (null at a terminal state).
export function nextOrderStatus(s: OrderStatus): OrderStatus | null {
  switch (s) {
    case 'new':       return 'preparing';
    case 'preparing': return 'packing';
    case 'packing':   return 'ready';
    case 'ready':     return 'completed';
    default:          return null;
  }
}

// ── cart ──────────────────────────────────────────────────────────
export interface CartItem {
  key: string;   // client id
  name: string;
  brand: string;
  qty: number;
  price: number;
  note: string;
}

export function cartTotal(items: CartItem[]): number {
  return items.reduce((sum, it) => sum + (it.price || 0) * (it.qty || 0), 0);
}

export function clientKey(): string {
  return `${Date.now().toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`;
}

// ── Phase 2 ───────────────────────────────────────────────────────
export interface CouponLike { kind: 'percent' | 'flat'; value: number; minOrder: number }

// Client-side preview of a coupon's discount (server re-validates on place).
export function couponDiscount(subtotal: number, coupon?: CouponLike | null): number {
  if (!coupon || subtotal < coupon.minOrder) return 0;
  const d = coupon.kind === 'percent' ? (subtotal * coupon.value) / 100 : coupon.value;
  return Math.round(Math.min(d, subtotal) * 100) / 100;
}

export function couponLabel(c: CouponLike & { code?: string }): string {
  const off = c.kind === 'percent' ? `${c.value}% off` : `${formatINR(c.value)} off`;
  const min = c.minOrder > 0 ? ` over ${formatINR(c.minOrder)}` : '';
  return `${off}${min}`;
}

// ★★★★☆ for a 0–5 rating.
export function starText(rating: number): string {
  const full = Math.round(rating);
  return '★★★★★'.slice(0, full) + '☆☆☆☆☆'.slice(0, 5 - full);
}

export function loyaltyTier(points: number): string {
  if (points >= 500) return 'Gold';
  if (points >= 150) return 'Silver';
  return 'Bronze';
}

export default {};
