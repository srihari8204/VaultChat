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
  label: string; // "Open now" | "Closing soon" | "Opens at 08:00" | "Closed"
  tone: 'open' | 'soon' | 'closed';
}

export function shopOpenState(
  open: string,
  close: string,
  status: ShopStatus,
  nowMins?: number,
): OpenState {
  if (status === 'closed') return { isOpen: false, label: 'Closed', tone: 'closed' };
  const now = nowMins ?? (() => { const d = new Date(); return d.getHours() * 60 + d.getMinutes(); })();
  const o = minsOfDay(open), c = minsOfDay(close);
  if (o == null || c == null) {
    return status === 'busy'
      ? { isOpen: true, label: 'Busy', tone: 'soon' }
      : { isOpen: true, label: 'Open now', tone: 'open' };
  }
  // Handle shops that close after midnight (close < open).
  const within = c >= o ? (now >= o && now < c) : (now >= o || now < c);
  if (!within) return { isOpen: false, label: `Opens at ${open}`, tone: 'closed' };
  const minsToClose = (c - now + 1440) % 1440;
  if (minsToClose <= 30) return { isOpen: true, label: `Closing in ${minsToClose} min`, tone: 'soon' };
  if (status === 'busy') return { isOpen: true, label: 'Busy', tone: 'soon' };
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

export default {};
