// utils/shopbook.ts — pure, dependency-free helpers for the SHOP BOOK mini-app.
// Kept out of the screen so the logic is testable and the screen stays thin.

export type ShopStatus = 'open' | 'busy' | 'closed' | 'holiday' | 'vacation';
export type OrderStatus =
  | 'pending' | 'accepted' | 'preparing' | 'packing' | 'ready'
  | 'collected' | 'completed' | 'rejected' | 'cancelled' | 'not_collected';
export type ItemAvailability =
  | 'pending' | 'available' | 'unavailable' | 'alternative';

// Legacy compat: pre-upgrade orders (and cached responses) used 'new'.
export function normalizeOrderStatus(s: string): OrderStatus {
  return (s === 'new' ? 'pending' : s) as OrderStatus;
}

// ── money ─────────────────────────────────────────────────────────
// Currency-aware (symbol comes from the shop's country config). formatINR
// remains for call sites that predate the tax engine.
export function formatMoney(n: number, symbol = '₹'): string {
  const v = Math.round((Number(n) || 0) * 100) / 100;
  return symbol + v.toLocaleString('en-IN', { maximumFractionDigits: 2 });
}

/**
 * Is this string a number at all?
 *
 * The other half of `num()` in app/shop-book.tsx, which answers "what number is
 * this?" and — because `Number('')` is a perfectly finite 0 — cannot tell a
 * BLANK box from a typed "₹285". Both arrive as a believable zero, and a zero
 * passes a `< 0` guard, so an item could be sold for ₹0 and a ₹0 invoice
 * printed. Blank is the caller's business (several fields legitimately mean 0
 * when blank); GARBAGE never is.
 *
 * Strict on purpose, and rejection is the right answer rather than parsing:
 *  - Number() accepts things no keyboard means: Number('0x10') is 16 and
 *    Number('1e3') is 1000. A quantity of "0x10" used to mean sixteen.
 *  - These are keyboardType="numeric" fields, so ₹ arrives by paste or a
 *    locale keyboard — a rare path not worth a locale decision.
 *
 * Thousands grouping IS accepted, by the same rule utils/financeFormat.ts has
 * always used (2026-09-17). This screen ships in India, where "1,200" and
 * "1,00,000" are what a shopkeeper actually types; refusing them outright made
 * a correctly-typed lakh look like garbage. See ungroup() below for why "12,5"
 * is still refused.
 *
 * The house style for strict parsing already exists here: minsOfDay below
 * returns null on anything unexpected. num() predates that lesson.
 *
 * A leading '-' is allowed: the stock screen deliberately accepts negative
 * corrections. Every other call site already rejects negatives with its own
 * guard.
 */
export function isNum(s: string): boolean {
  const t = ungroup((s ?? '').trim());
  return t != null && /^-?\d*\.?\d+$/.test(t);
}

/**
 * Strip thousands grouping, or null when the commas are not grouping.
 *
 * THE COMMA IS THE WHOLE PROBLEM, and utils/financeFormat.ts already solved it
 * — this is that rule, so the two screens cannot disagree about what a typed
 * "1,00,000" is worth.
 *
 * A thousands separator is always followed by exactly three digits: in Western
 * (1,200) and Indian (1,00,000) grouping alike the LAST group is three. One or
 * two digits after the final comma is the decimal comma much of the world
 * types, and a bare strip would turn "12,5" into 125 — a ₹12.50 item billed at
 * ₹125, a TEN TIMES error with a plausible number at the end of it. So it is
 * refused rather than multiplied.
 */
/**
 * The submit gate for a money field where BLANK legitimately means zero/none.
 *
 * Seven money writes in app/shop-book.tsx called num() with no gate at all
 * (2026-09-17), and every one of them had the same shape: blank is a real
 * answer — no tax, no cost price, no minimum order, no credit ceiling — while
 * garbage is not, yet num() renders both as an identical, believable 0. That 0
 * then survives every `< 0` range check downstream, because 0 is not negative.
 *
 * Blank is the caller's business; GARBAGE never is. This says which is which.
 */
export function isBlankOrNum(s: string): boolean {
  const t = (s ?? '').trim();
  return t === '' || isNum(t);
}
/**
 * As isBlankOrNum, but also refuses a NEGATIVE value.
 *
 * isNum accepts a leading minus on purpose - the stock screen takes negative
 * corrections - so the garbage gates alone still let a negative through on
 * fields where one is meaningless: a catalog price, an alternative price, a
 * coupon minimum, a line on a customer bill, a bill discount. A negative price
 * is not a typo the server rejects; it is a discount nobody authorised, and on
 * the catalog it re-prices every future order of that product. On a bill
 * DISCOUNT a negative is worse still - it is a surcharge (2026-09-17).
 *
 * NON-NEGATIVE, NOT POSITIVE, and named that way since 2026-09-17: a typed "0"
 * passes. It used to be called isBlankOrPositive, and three comments then
 * claimed the gates it guards catch a typed zero - they never did, and a name
 * that lies is how that belief spread. Where zero is genuinely wrong the caller
 * says so itself; see the ad-hoc bill line in app/shop-book.tsx.
 */
export function isBlankOrNonNegative(s: string): boolean {
  const t = (s ?? '').trim();
  if (t === '') return true;
  return isNum(t) && num(t) >= 0;
}


function ungroup(t: string): string | null {
  if (t.includes(',') && !/^[0-9]{3}([.][0-9]+)?$/.test(t.slice(t.lastIndexOf(',') + 1))) return null;
  return t.replace(/,/g, '');
}

/**
 * Parse a money / quantity field, falling back to 0.
 *
 * app/shop-book.tsx had this as a bare Number(s), which accepts forms a price
 * field never means: Number('0x10') is 16 and Number('1e3') is 1000, so a
 * typo produced a WRONG NUMBER rather than a rejection.
 *
 * Grouping now parses (2026-09-17, ungroup() above): "1,200" is 1200 and
 * "1,00,000" is one lakh. It used to fall through to 0, so a shopkeeper typing
 * the separator every Indian price tag carries silently priced the line at
 * nothing. "12,5" is still 0 — a decimal comma is not grouping.
 *
 * Returns 0, not NaN, where financeFormat's twin returns NaN: every caller
 * here assumes a number. That is exactly why the 0 is dangerous, and why the
 * money call sites gate on isNum FIRST rather than trusting this.
 *
 * Deliberately looser than isNum in ONE way: a trailing point is kept, because
 * this also runs on half-typed input while a running total is on screen, and
 * flicking the total to 0 on the keystroke between '12' and '12.5' would be
 * its own bug. isNum stays the strict gate on submit.
 */
export function num(s: string): number {
  const t = ungroup(String(s ?? '').trim());
  if (t == null) return 0;
  if (t === '' || t === '-' || t === '.' || t === '-.') return 0;
  if (!/^-?[0-9]*[.]?[0-9]*$/.test(t)) return 0;
  const n = Number(t);
  return Number.isFinite(n) ? n : 0;
}

export function formatINR(n: number): string {
  return formatMoney(n, '₹');
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
  if (s.status === 'holiday') return { isOpen: false, label: 'On holiday', tone: 'closed' };
  if (s.status === 'vacation') return { isOpen: false, label: 'On vacation', tone: 'closed' };
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
export const ORDER_STEPS: OrderStatus[] = [
  'pending', 'accepted', 'preparing', 'packing', 'ready', 'collected', 'completed',
];

export function orderStatusLabel(s: OrderStatus): string {
  switch (s) {
    case 'pending':    return 'Order placed';
    case 'accepted':   return 'Accepted';
    case 'preparing':  return 'Preparing';
    case 'packing':    return 'Packing';
    case 'ready':      return 'Ready to collect';
    case 'collected':  return 'Collected';
    case 'completed':  return 'Completed';
    case 'rejected':      return 'Rejected';
    case 'cancelled':     return 'Cancelled';
    case 'not_collected': return 'Not collected';
  }
}

export function isTerminalFailure(s: OrderStatus): boolean {
  return s === 'cancelled' || s === 'rejected' || s === 'not_collected';
}

// Progress 0..1 along the happy path (terminal failures = 0).
export function orderProgress(s: OrderStatus): number {
  if (isTerminalFailure(s)) return 0;
  const i = ORDER_STEPS.indexOf(s);
  return i < 0 ? 0 : i / (ORDER_STEPS.length - 1);
}

// The next status an owner can advance an order to (null when the next move
// is a decision — accept/reject from pending — or the state is terminal).
// 'ready' stops here on purpose: collection is the customer's call (D5a).
export function nextOrderStatus(s: OrderStatus): OrderStatus | null {
  switch (s) {
    case 'accepted':  return 'preparing';
    case 'preparing': return 'packing';
    case 'packing':   return 'ready';
    default:          return null;
  }
}

// ── collection handoff (spec: order-management / uncollected orders) ──
export function canCustomerCollect(s: OrderStatus): boolean {
  return s === 'ready';
}

export const NOT_COLLECTED_AFTER_HOURS = 24;

// When the owner may write a ready order off as Not Collected. Dated from the
// last 'ready' timeline event; `hoursLeft` drives the disabled-button copy.
export function notCollectedGate(
  status: OrderStatus, timeline: TimelineEvent[], now = new Date(),
): { allowed: boolean; hoursLeft: number } {
  if (status !== 'ready') return { allowed: false, hoursLeft: 0 };
  const ready = timeline.filter((e) => e.status === 'ready').pop();
  const at = ready ? new Date(ready.at).getTime() : NaN;
  if (!Number.isFinite(at)) return { allowed: true, hoursLeft: 0 }; // no timeline → let the server decide
  const waited = (now.getTime() - at) / 3_600_000;
  return waited >= NOT_COLLECTED_AFTER_HOURS
    ? { allowed: true, hoursLeft: 0 }
    : { allowed: false, hoursLeft: Math.ceil(NOT_COLLECTED_AFTER_HOURS - waited) };
}

// ── cancellation windows (spec: order-management / cancellation) ──
export function canCustomerCancel(s: OrderStatus): boolean {
  return s === 'pending';
}

export function canOwnerCancel(s: OrderStatus): boolean {
  return s === 'pending' || s === 'accepted' || s === 'preparing';
}

// The six rejection reason codes (must match the backend's table).
export const REJECT_REASONS: { code: string; label: string }[] = [
  { code: 'out_of_stock',  label: 'Out of Stock' },
  { code: 'shop_closed',   label: 'Shop Closed' },
  { code: 'quantity',      label: 'Quantity Not Available' },
  { code: 'outside_hours', label: 'Outside Business Hours' },
  { code: 'technical',     label: 'Technical Issue' },
  { code: 'other',         label: 'Other' },
];

// The owner's own words behind a rejection. The server accepts a note ONLY
// with reason 'other' (400 note_not_allowed otherwise) and at most 200
// characters (400 note_too_long), so the payload is shaped here, once.
export const REJECT_NOTE_MAX = 200;
export function rejectPayload(code: string | undefined, text: string): { reason: string; note: string } {
  const reason = code || 'other';
  return { reason, note: reason === 'other' ? (text ?? '').trim().slice(0, REJECT_NOTE_MAX) : '' };
}

// ── order timeline ────────────────────────────────────────────────
export interface TimelineEvent { status: OrderStatus; note: string; at: string }

// ── cart ──────────────────────────────────────────────────────────
export interface CartItem {
  key: string;   // client id
  productId?: string;   // catalog row, when the line came from the catalog.
                        // The server re-prices from this; a line without one is
                        // a free-typed request the owner quotes during review.
  name: string;
  brand: string;
  qty: number;
  price: number;
  note: string;
  unit?: string;        // from the catalog product, when known
  taxPercent?: number;  // snapshotted onto the order line for invoicing
}

export function cartTotal(items: CartItem[]): number {
  return items.reduce((sum, it) => sum + (it.price || 0) * (it.qty || 0), 0);
}

/** Carts keyed by shop id. One shared cart let items picked at shop A be
 *  posted to shop B; each shop now keeps its own. */
export type CartsByShop = Readonly<Record<string, CartItem[]>>;

export function cartFor(carts: CartsByShop, shopId: string): CartItem[] {
  return carts[shopId] ?? [];
}

/** Replace one shop's cart; an empty cart drops the key. Never touches other shops. */
export function withShopCart(carts: CartsByShop, shopId: string, items: CartItem[]): CartsByShop {
  const next = { ...carts };
  if (items.length === 0) delete next[shopId]; else next[shopId] = items;
  return next;
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

// `symbol` is the SHOP's currency. It defaulted to a hard-coded ₹ (formatINR),
// which labelled every non-Indian shop's coupon in rupees.
export function couponLabel(c: CouponLike & { code?: string }, symbol = '₹'): string {
  const off = c.kind === 'percent' ? `${c.value}% off` : `${formatMoney(c.value, symbol)} off`;
  const min = c.minOrder > 0 ? ` over ${formatMoney(c.minOrder, symbol)}` : '';
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

// ── bulk catalog paste ────────────────────────────────────────────
export interface ParsedProduct { name: string; brand: string; unit: string; price: number }

// Parse a pasted product list. One product per line. Accepts either:
//   "Aashirvaad Atta 5kg 285"                (name … trailing price)
//   "Aashirvaad Atta, Aashirvaad, 5kg, 285"  (name, brand, unit, price — commas)
//   "Tata Salt, 20"                          (name, price)
export function parseBulkProducts(text: string): ParsedProduct[] {
  const out: ParsedProduct[] = [];
  for (const raw of text.split('\n')) {
    const p = parseBulkLine(raw.trim());
    if (p) out.push(p);
  }
  return out;
}

/** The non-blank pasted lines that parseBulkProducts drops (no product name
 *  could be read from them), trimmed, so the screen can say which. */
export function skippedBulkLines(text: string): string[] {
  return text.split('\n').map((l) => l.trim()).filter((l) => l && !parseBulkLine(l));
}

function parseBulkLine(line: string): ParsedProduct | null {
  if (!line) return null;
  let name = '', brand = '', unit = '', price = 0;
  if (line.includes(',')) {
    const p = line.split(',').map((x) => x.trim());
    name = p[0] ?? '';
    const last = Number((p[p.length - 1] ?? '').replace(/[₹,\s]/g, ''));
    if (p.length >= 2 && Number.isFinite(last)) {
      price = last;
      if (p.length >= 3) brand = p[1];
      if (p.length >= 4) unit = p[2];
    } else {
      brand = p[1] ?? '';
      unit = p[2] ?? '';
    }
  } else {
    const m = line.match(/^(.*?)[\s₹]+(\d+(?:\.\d+)?)\s*$/);
    if (m) { name = m[1].trim(); price = Number(m[2]); }
    else { name = line; }
  }
  return name ? { name, brand, unit, price: Number.isFinite(price) ? price : 0 } : null;
}

// ── units ──────────────────────────────────────────────────────────
// One vocabulary for the product form, the customer's order line and the khata
// line, so the same shop does not end up with "kg", "Kg", "KG" and "kgs" as
// four different things. Production already drifted that way: 1kg, 250g, 100g,
// 500g, 1L and 1pc all exist as free text.
//
// THE MEANING OF A UNIT HERE IS A PACK, NOT A MEASURE.
//
// `unit` labels what ONE of something is, and `qty` counts those. So 2 x "1kg"
// is two one-kilo packs, and loose weight is expressed as qty 2.5 of unit "kg".
// This is what the existing 63 order lines already mean, which is why it stays
// that way — reinterpreting them as measures would silently change what every
// historical invoice claims was sold.

/** Offered as chips. Free text is still allowed for anything not listed. */
export const UNIT_PRESETS = [
  'pc', 'kg', 'g', 'L', 'ml', 'packet', 'dozen', 'box', 'bag', 'bottle',
] as const;

/**
 * Tidy a typed unit without changing what the owner meant.
 *
 * Case-folds ONLY when the result matches a preset, so "KG" becomes "kg" but a
 * deliberate "5Kg Bag" is left exactly as written. Nothing is rejected: a shop
 * selling something we never thought of must still be able to write it down.
 */
export function normalizeUnit(raw: string): string {
  const u = (raw ?? '').trim();
  if (!u) return '';
  const hit = UNIT_PRESETS.find((p) => p.toLowerCase() === u.toLowerCase());
  return hit ?? u;
}

/** "2 x 1kg" / "3 pc" / "2" — what a human reads on a line. */
export function formatQtyUnit(qty: number, unit?: string): string {
  const q = Number.isFinite(qty) ? qty : 0;
  const u = (unit ?? '').trim();
  return u ? `${q} x ${u}` : String(q);
}

// ── stale prices in comparison ────────────────────────────────────
//
// A comparison list is the reason a customer opens this app instead of phoning
// the shop, so the prices in it have to be honest about their own age. Two
// wrong answers were available and both were rejected: hiding an old price
// makes a shop that stocks the item look like one that doesn't, and showing it
// unmarked walks the customer to a price that expired a fortnight ago.
//
// 14 days rather than 7 because staple prices in a kirana shop genuinely do
// not move weekly, and a marker that lands on half the catalog is a marker
// customers learn to ignore.
export const PRICE_STALE_DAYS = 14;

/** True when a listed price is older than the freshness window. */
export function isStalePrice(updatedAt?: string | null, now: Date = new Date()): boolean {
  if (!updatedAt) return false; // unknown age is not a claim of staleness
  const t = new Date(updatedAt).getTime();
  if (!Number.isFinite(t)) return false;
  return now.getTime() - t > PRICE_STALE_DAYS * 86400_000;
}

// ── dates follow the country, not the author ──────────────────────
//
// Every date in this screen used to be formatted 'en-IN' regardless of where
// the shop trades, which quietly contradicts the localization spec: formats
// come from the country config. A document (an invoice) follows ITS country;
// everything else follows the device, which is what the reader actually set.
const COUNTRY_LOCALE: Record<string, string> = {
  IN: 'en-IN', US: 'en-US', GB: 'en-GB', AU: 'en-AU', CA: 'en-CA', SG: 'en-SG',
};

/** Locale for `toLocale*String`. `undefined` = the device's own locale. */
export function dateLocale(country?: string): string | undefined {
  return COUNTRY_LOCALE[(country ?? '').toUpperCase()];
}

/**
 * Short stamp for an order list row: today's orders show a time, older ones a
 * date. A list where every row reads "9:41 am" is exactly as unscannable as one
 * where every row reads the same date — which is what a fixed format gives you
 * on the days that matter most.
 *
 * `now` is injectable so the same-day boundary is testable without waiting for
 * midnight.
 */
export function orderStamp(iso: string, now: Date = new Date()): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const sameDay = d.getFullYear() === now.getFullYear()
    && d.getMonth() === now.getMonth()
    && d.getDate() === now.getDate();
  return sameDay
    ? d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
    : d.toLocaleDateString(dateLocale(), { day: 'numeric', month: 'short' });
}

// ── notification → screen ────────────────────────────────────────
//
// Where tapping an inbox row goes. The server's notification `data` carries
// identifiers only (see sbNotify in vaultchat-backend-go routes/shopbook.go),
// and the same order can be the reader's purchase or their shop's sale, so the
// event decides which side's screen opens:
//   new_order, alternative_decision, order_cancelled → the owner's order
//   alternative                                      → the customer's order
//   return_requested                                 → the owner's returns list
//   order_status → the side the server addressed it to. The server sends it
//     to the customer on every move and to the owner only for completed
//     (the customer collected) / not_collected, so:
//       data.side 'owner' | 'customer' (when the server tags it) → that side;
//       any other status → the customer (only customers receive those);
//       completed / not_collected untagged → the side that is open.
// A return decision opens the customer's order once the server includes its
// orderId; today it does not, so that row (like payments, reminders and shop
// news) has no screen to open and is not offered as a link.
export type NotificationTarget =
  | { kind: 'order'; side: 'customer' | 'owner'; orderId: string }
  | { kind: 'returns' };

const OWNER_ORDER_EVENTS = new Set(['new_order', 'alternative_decision', 'order_cancelled']);
const CUSTOMER_ORDER_EVENTS = new Set(['alternative', 'return_approved', 'return_rejected']);
// The only order_status values the server also sends to the shop owner.
const OWNER_ORDER_STATUSES = new Set(['completed', 'not_collected']);

export function notificationTarget(
  n: { event?: string; data?: Record<string, unknown> | null },
  mode: 'customer' | 'owner',
): NotificationTarget | null {
  const data = n.data ?? {};
  const event = n.event || (typeof data.event === 'string' ? data.event : '');
  if (event === 'return_requested') return { kind: 'returns' };
  const raw = data.orderId;
  const orderId = typeof raw === 'string' || typeof raw === 'number' ? String(raw).trim() : '';
  if (!orderId) return null;
  if (OWNER_ORDER_EVENTS.has(event)) return { kind: 'order', side: 'owner', orderId };
  if (CUSTOMER_ORDER_EVENTS.has(event)) return { kind: 'order', side: 'customer', orderId };
  if (event === 'order_status') {
    if (data.side === 'owner' || data.side === 'customer') return { kind: 'order', side: data.side, orderId };
    if (!OWNER_ORDER_STATUSES.has(String(data.status ?? ''))) return { kind: 'order', side: 'customer', orderId };
    // ponytail: today's server sends the same completed / not_collected row to
    // both sides untagged, so only the open side is left to go on. Replace once
    // the server adds `side` to order_status data (sbNotify calls in
    // vaultchat-backend-go routes/shopbook.go and shopbook_jobs.go).
    return { kind: 'order', side: mode, orderId };
  }
  return null;
}

export default {};
