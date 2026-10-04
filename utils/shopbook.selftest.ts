// utils/shopbook.selftest.ts — run: npx tsx utils/shopbook.selftest.ts
//
// Guards the SHOP BOOK upgrade's client-side contracts (openspec:
// shop-book-upgrade): the order pipeline the UI navigates by, the
// actor-scoped cancellation windows the buttons obey, the rejection reason
// codes that must match the Go backend's table, legacy 'new' status compat,
// currency-aware money, and holiday/vacation open-state.

import {
  ORDER_STEPS, orderProgress, nextOrderStatus, orderStatusLabel,
  normalizeOrderStatus, canCustomerCancel, canOwnerCancel, REJECT_REASONS, REJECT_NOTE_MAX, rejectPayload,
  couponLabel,
  formatMoney, shopOpenState, cartTotal, isNum, isBlankOrNum, isBlankOrNonNegative, num,
  canCustomerCollect, notCollectedGate, NOT_COLLECTED_AFTER_HOURS,
  isStalePrice, PRICE_STALE_DAYS, dateLocale, orderStamp,
  cartFor, withShopCart, type CartsByShop, type CartItem,
  type OrderStatus, type TimelineEvent,
} from './shopbook';
// financeFormat is where the comma rule came from. Assert the two screens
// agree rather than trusting that a copied rule stayed copied.
import { num as financeNum } from './financeFormat';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

// Shop Book's screens moved out of app/shop-book.tsx into components/shopbook/
// (2026-10-04 split). Read the route shell plus every moved file, from the repo
// root (or one level below it, as before); null when neither is reachable.
function shopBookSource(): string | null {
  for (const root of [process.cwd(), join(process.cwd(), '..'), join(__dirname, '..')]) {
    try {
      const dir = join(root, 'components', 'shopbook');
      return [join(root, 'app', 'shop-book.tsx'),
        ...readdirSync(dir).filter((f) => /\.tsx?$/.test(f)).sort().map((f) => join(dir, f))]
        .map((p) => readFileSync(p, 'utf8')).join('\n');
    } catch { /* try the next root */ }
  }
  return null;
}

let failures = 0;
function check(name: string, actual: unknown, expected: unknown) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failures++;
  console.log(`  ${ok ? '✓' : '✗'} ${name}${ok ? '' : `  (got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)})`}`);
}

console.log('shopbook.selftest');

// ── pipeline shape (must mirror sbOwnerNext in shopbook.go) ────────
check('happy path steps', ORDER_STEPS,
  ['pending', 'accepted', 'preparing', 'packing', 'ready', 'collected', 'completed']);
check('pending has no auto-next (accept/reject is a decision)', nextOrderStatus('pending'), null);
check('accepted → preparing', nextOrderStatus('accepted'), 'preparing');
check('preparing → packing', nextOrderStatus('preparing'), 'packing');
check('packing → ready', nextOrderStatus('packing'), 'ready');
check('ready has no owner-next — collection is the customer\'s call', nextOrderStatus('ready'), null);
check('collected is terminal for the owner button', nextOrderStatus('collected'), null);
check('rejected is terminal', nextOrderStatus('rejected'), null);

// ── collection handoff (spec: order-management / uncollected orders) ─
check('customer may confirm collection when ready', canCustomerCollect('ready'), true);
check('customer may not confirm collection before ready',
  (['pending', 'accepted', 'preparing', 'packing', 'completed'] as OrderStatus[]).map(canCustomerCollect),
  [false, false, false, false, false]);

const NOW = new Date('2026-08-10T12:00:00Z');
const readyAt = (hoursAgo: number): TimelineEvent[] => [
  { status: 'ready', note: '', at: new Date(NOW.getTime() - hoursAgo * 3_600_000).toISOString() },
];
check('not-collected is blocked before the 24h window',
  notCollectedGate('ready', readyAt(2), NOW), { allowed: false, hoursLeft: 22 });
check('not-collected opens exactly at 24h',
  notCollectedGate('ready', readyAt(NOT_COLLECTED_AFTER_HOURS), NOW), { allowed: true, hoursLeft: 0 });
check('not-collected stays open after 24h',
  notCollectedGate('ready', readyAt(50), NOW), { allowed: true, hoursLeft: 0 });
check('not-collected never offered off the ready state',
  notCollectedGate('packing', readyAt(50), NOW), { allowed: false, hoursLeft: 0 });
check('no ready event (pre-timeline order) defers to the server',
  notCollectedGate('ready', [], NOW), { allowed: true, hoursLeft: 0 });
check('the latest ready event wins over an earlier one',
  notCollectedGate('ready', [...readyAt(90), ...readyAt(1)], NOW), { allowed: false, hoursLeft: 23 });

// ── progress ──────────────────────────────────────────────────────
check('progress at pending', orderProgress('pending'), 0);
check('progress at completed', orderProgress('completed'), 1);
check('cancelled shows no progress', orderProgress('cancelled'), 0);
check('rejected shows no progress', orderProgress('rejected'), 0);
check('not_collected shows no progress', orderProgress('not_collected'), 0);

// ── legacy compat: pre-064 orders used status 'new' ───────────────
check("'new' normalizes to pending", normalizeOrderStatus('new'), 'pending');
check('modern statuses pass through', normalizeOrderStatus('packing'), 'packing');

// ── cancellation windows (spec: order-management / cancellation) ──
check('customer may cancel while pending', canCustomerCancel('pending'), true);
const afterAccept: OrderStatus[] = ['accepted', 'preparing', 'packing', 'ready', 'collected', 'completed'];
check('customer may not cancel after acceptance',
  afterAccept.map(canCustomerCancel), afterAccept.map(() => false));
check('owner may cancel before packing',
  (['pending', 'accepted', 'preparing'] as OrderStatus[]).map(canOwnerCancel), [true, true, true]);
check('owner may not cancel once packing starts',
  (['packing', 'ready', 'collected', 'completed'] as OrderStatus[]).map(canOwnerCancel),
  [false, false, false, false]);

// ── rejection codes: must equal the backend's sbRejectReasons keys ─
check('the six rejection reason codes', REJECT_REASONS.map((r) => r.code),
  ['out_of_stock', 'shop_closed', 'quantity', 'outside_hours', 'technical', 'other']);

// ── every status renders a label (switch exhaustiveness guard) ────
const ALL: OrderStatus[] = [...ORDER_STEPS, 'rejected', 'cancelled', 'not_collected'];
check('all statuses have labels', ALL.every((st) => !!orderStatusLabel(st)), true);

// ── currency-aware money (tax engine currency symbol) ─────────────
check('default symbol', formatMoney(1250), '₹1,250');
check('country symbol', formatMoney(12.5, '$'), '$12.5');
check('rounding to 2dp', formatMoney(10.005, '£'), '£10.01');

// ── holiday / vacation shop statuses close the shop ───────────────
const base = { openTime: '09:00', closeTime: '21:00' };
const noon = new Date(2026, 7, 3, 12, 0); // Monday
check('holiday status closes', shopOpenState({ ...base, status: 'holiday' }, noon).isOpen, false);
check('vacation status closes', shopOpenState({ ...base, status: 'vacation' }, noon).isOpen, false);
check('open status stays open', shopOpenState({ ...base, status: 'open' }, noon).isOpen, true);

// ── cart with unit/taxPercent extras still totals by price*qty ────
check('cart total ignores tax fields', cartTotal([
  { key: 'a', name: 'Atta', brand: '', qty: 2, price: 285, note: '', unit: '5kg', taxPercent: 5 },
  { key: 'b', name: 'Salt', brand: '', qty: 1, price: 20, note: '' },
]), 590);

// ── stale prices (comparison freshness policy) ────────────────────
const STALE_NOW = new Date(2026, 7, 30, 12, 0);
const daysAgo = (d: number) => new Date(STALE_NOW.getTime() - d * 86400_000).toISOString();
check('window is 14 days', PRICE_STALE_DAYS, 14);
check('fresh price', isStalePrice(daysAgo(1), STALE_NOW), false);
check('exactly at the boundary is not yet stale', isStalePrice(daysAgo(14), STALE_NOW), false);
check('a day past the boundary is stale', isStalePrice(daysAgo(15), STALE_NOW), true);
check('missing timestamp is not a staleness claim', isStalePrice(undefined, STALE_NOW), false);
check('unparseable timestamp is not a staleness claim', isStalePrice('not a date', STALE_NOW), false);

// ── dates follow the country, device locale otherwise ─────────────
check('india', dateLocale('IN'), 'en-IN');
check('lowercase country still resolves', dateLocale('sg'), 'en-SG');
check('unknown country falls back to the device', dateLocale('ZZ'), undefined);
check('no country falls back to the device', dateLocale(), undefined);

// ── order list stamp (same-day time vs older date) ────────────────
// The branch is the whole point: a list where every row reads the same thing
// cannot be scanned, so today's orders must differ in shape from older ones.
{
  const now = new Date(2026, 8, 4, 15, 0, 0);            // 4 Sep 2026, 15:00
  const sameDay = new Date(2026, 8, 4, 9, 41, 0).toISOString();
  const yesterday = new Date(2026, 8, 3, 9, 41, 0).toISOString();
  const lastYear = new Date(2025, 8, 4, 9, 41, 0).toISOString();

  const a = orderStamp(sameDay, now);
  const b = orderStamp(yesterday, now);
  const c = orderStamp(lastYear, now);

  check('today shows a time, not a date', /\d/.test(a) && a !== b, true);
  check('yesterday is not shown as a time', b !== a, true);
  // Same day-of-month and month, different YEAR — the bug a
  // getDate()+getMonth()-only comparison would introduce.
  check('same day and month a year ago is not "today"', c !== a, true);
  check('an unparseable date yields nothing, never "Invalid Date"',
    orderStamp('not-a-date', now), '');
  check('an empty string yields nothing', orderStamp('', now), '');
}

if (failures) {
  console.error(`\n${failures} check(s) failed`);
  process.exit(1);
}

// ── isNum: the blank-vs-garbage distinction num() cannot make ──────
// Each rejection below is a real bug that shipped: "₹285" is the ₹0 invoice,
// "12,5" is the 10x trap a lenient parser would reintroduce, and Number()
// quietly accepting hex and exponents meant a quantity of "0x10" was sixteen.
check('isNum blank',              isNum(''), false);
check('isNum whitespace',         isNum('   '), false);
check('isNum integer',            isNum('285'), true);
check('isNum decimal',            isNum('2.5'), true);
check('isNum leading dot',        isNum('.5'), true);
check('isNum negative allowed',   isNum('-3'), true);
check('isNum rupee symbol',       isNum('₹285'), false);
check('isNum decimal comma',      isNum('12,5'), false);
check('isNum trailing unit',      isNum('20 mins'), false);
check('isNum hex',                isNum('0x10'), false);
check('isNum exponent',           isNum('1e3'), false);
check('isNum half-typed dot',     isNum('12.'), false);

// ── thousands grouping (2026-09-17) ───────────────────────────────
//
// THE ASYMMETRY IS THE WHOLE POINT, and it is the rule utils/financeFormat.ts
// has always used. This app ships in India: "1,200" and "1,00,000" are what a
// shopkeeper types off a price tag, and refusing them outright made a
// correctly-entered lakh look like garbage and priced the line at nothing.
//
// But a thousands separator is ALWAYS followed by exactly three digits, in
// Western and Indian grouping alike — so one or two digits after the FINAL
// comma is the decimal comma much of the world types, and a bare strip would
// bill a ₹12.50 item at ₹125. Ten times, silently, with a plausible number at
// the end of it. Accepted above the line, refused below it; never confused.
check('isNum western grouping',   isNum('1,200'), true);
check('isNum lakh grouping',      isNum('1,00,000'), true);
check('isNum crore grouping',     isNum('1,00,00,000'), true);
check('isNum grouping + paise',   isNum('1,200.50'), true);
check('isNum negative grouped',   isNum('-1,200'), true);
check('isNum two-digit group',    isNum('12,50'), false);
check('isNum trailing comma',     isNum('1,'), false);
check('isNum lone comma',         isNum(','), false);
check('isNum grouped rupee',      isNum('₹1,200'), false);

check('grouped thousands parse',     num('1,200'), 1200);
check('a lakh parses',               num('1,00,000'), 100000);
check('a crore parses',              num('1,00,00,000'), 10000000);
check('grouping keeps the paise',    num('1,200.50'), 1200.5);
check('negative grouped correction', num('-1,200'), -1200);
// The ten-times trap: these must be 0, never 125 / 1250.
check('the decimal comma is refused, not multiplied by ten', num('12,5'), 0);
check('a two-digit group is refused too', num('12,50'), 0);
check('a trailing comma is not a number', num('1,'), 0);
check('a lone comma is not a number', num(','), 0);
// The two screens must not disagree about what a typed lakh is worth.
check('shopbook agrees with financeFormat on a lakh',
  num('1,00,000'), financeNum('1,00,000'));
check('shopbook agrees with financeFormat on western grouping',
  num('1,200'), financeNum('1,200'));
check('financeFormat refuses the same decimal comma (as NaN, its own contract)',
  Number.isNaN(financeNum('12,5')), true);

// ── isBlankOrNum: the shape all seven ungated money writes shared ──
//
// Blank is a real answer in every one of them — no tax, no cost price, no
// minimum order, no credit ceiling, pack the full ordered quantity — while
// garbage is not. num() renders BOTH as an identical, believable 0, and that 0
// then survives every `< 0` range check downstream, because 0 is not negative.
check('blank is a real answer',         isBlankOrNum(''), true);
check('whitespace is still blank',      isBlankOrNum('   '), true);
check('a plain number passes',          isBlankOrNum('285'), true);
check('a typed lakh passes',            isBlankOrNum('1,00,000'), true);
check('a negative correction passes',   isBlankOrNum('-3'), true);
check('the decimal comma is garbage',   isBlankOrNum('12,5'), false);
check('a pasted rupee sign is garbage', isBlankOrNum('₹285'), false);
check('hex is garbage',                 isBlankOrNum('0x10'), false);
check('an exponent is garbage',         isBlankOrNum('1e3'), false);
check('Infinity is garbage',            isBlankOrNum('Infinity'), false);
check('letters are garbage',            isBlankOrNum('abc'), false);
// The distinction that is the entire reason this exists.
check('num() cannot tell blank from garbage — both are 0',
  [num(''), num('₹285')], [0, 0]);
check('isBlankOrNum can',
  [isBlankOrNum(''), isBlankOrNum('₹285')], [true, false]);

// ── the seven gates actually being AT the seven call sites ────────
//
// isBlankOrNum being correct is worth nothing if a money write does not call
// it, and that is precisely the bug that shipped: the helper's twin (isNum)
// already existed and these seven writes simply did not use it. A unit test of
// the predicate cannot see that, and app/shop-book.tsx is a 4500-line React
// screen with no seam to import. So this reads the source and asserts each
// gate is still there — delete one and this file exits non-zero (2026-09-17).
//
// ponytail: source scan, not a render test. If this screen ever grows a
// testable seam (or RNTL lands in the project), assert on behaviour instead.
{
  const screen = shopBookSource();

  check('app/shop-book.tsx is readable from the repo root', screen != null, true);

  // Each entry: the money write, and the Alert that now stands in front of it.
  // The copy names the offending value, because "invalid input" on a numeric
  // keyboard tells a shopkeeper nothing about which box to look at.
  //
  // The parentheses say what each gate CATCHES, which is garbage (and, where
  // the helper is the non-negative one, a negative). They used to say "0 = ..."
  // as though a typed zero were rejected; it is not, and never was —
  // isBlankOrNonNegative passes "0" by definition. The 0 in each case is what
  // num() SILENTLY COERCES the garbage to, which is the reason the gate has to
  // stand in front of it (2026-09-17).
  const GATES: [string, string][] = [
    ['catalog price/tax/cost/reorder (garbage → 0 re-prices every future order)',
      "Alert.alert('Check the numbers',"],
    ['packed quantity on the live bill (garbage → 0 bills an empty bag; -3 too)',
      "Alert.alert('Check the packed quantity',"],
    ['ad-hoc item added to a bill (garbage price → 0 sends the line out free)',
      "Alert.alert('Check the quantity and price',"],
    ['alternative product price (garbage → 0 offers the substitute free)',
      "Alert.alert('Check the price',"],
    ['coupon minimum order (garbage → 0 applies it to EVERY order)',
      "Alert.alert('Check the minimum order',"],
    ['credit limit (garbage → 0, and 0 means NO LIMIT — the dangerous coercion)',
      "Alert.alert('Check the limit',"],
    ['return quantity (garbage → 0 was silently filtered out of the return)',
      "Alert.alert('Check the quantity',"],
    ['bill discount (the eighth: -200 was a SURCHARGE, garbage → no discount)',
      "Alert.alert('Check the discount',"],
  ];
  for (const [what, needle] of GATES) {
    check(`gated: ${what}`, (screen ?? '').includes(needle), true);
  }
  // The two pre-existing gates whose pattern the seven copy must not regress.
  check('the 2026-09-17 counter-sale / ledger gates are still in place',
    ((screen ?? '').match(/isNum\(it\.qty\) \|\| !isNum\(it\.price\)/g) ?? []).length, 2);
}

// num(): the parse that actually reaches the database.
//
// isNum guards SUBMIT; num is what converts. They disagree on purpose in one
// place - a trailing point - because num also runs on half-typed input.
check('plain integers parse', num('12'), 12);
check('decimals parse', num('12.5'), 12.5);
check('a trailing point is kept mid-typing', num('12.'), 12);
check('hex is NOT 16', num('0x10'), 0);
check('exponent is NOT 1000', num('1e3'), 0);
check('blank is zero', num(''), 0);
check('whitespace is zero', num('   '), 0);
check('a lone minus is zero', num('-'), 0);
check('negatives still parse for stock corrections', num('-3'), -3);
check('surrounding spaces are trimmed', num(' 42 '), 42);
check('letters are zero', num('abc'), 0);
check('Infinity is not a price', num('Infinity'), 0);
check('num never returns NaN', Number.isFinite(num('nonsense')), true);

// A negative price is not a typo the server rejects - it is an unauthorised
// discount, and on the catalog it re-prices every future order of that item.
// isNum allows a leading minus on purpose (stock corrections), so the money
// fields need their own predicate.
check('a negative price is refused', isBlankOrNonNegative('-3'), false);
check('a negative grouped price is refused', isBlankOrNonNegative('-1,200'), false);
check('blank is still allowed', isBlankOrNonNegative(''), true);
check('zero is still allowed', isBlankOrNonNegative('0'), true);
check('a grouped price is still allowed', isBlankOrNonNegative('1,200'), true);
check('garbage is still refused', isBlankOrNonNegative('abc'), false);
check('the stock screen keeps negatives', isNum('-3'), true);
// The name is the contract: NON-NEGATIVE. It was called isBlankOrPositive and
// the comments around three of its call sites grew to claim it catches a typed
// zero. It does not, and a name that lies is how that spread (2026-09-17).
check('the helper is named for what it actually accepts',
  [isBlankOrNonNegative('0'), isBlankOrNonNegative('-0.01')], [true, false]);

// ── the source-scanned half of the 2026-09-17 adversarial pass ──────
//
// These are the gaps a review found AFTER the first seven gates landed: writes
// that were still ungated, and gates calling the wrong predicate so a negative
// walked through a check that looked like it was there.
{
  const screen = shopBookSource() ?? '';

  // A discount of -200 raised the bill by ₹200. The bare write is the bug.
  check('the bill discount is no longer written straight from num()',
    /patch\(\{ billDiscount: num\(discount\) \}\)\s*\}/.test(screen), false);

  // isBlankOrNum accepts '-1' — the return filter then dropped the line, which
  // is the exact short credit note the gate was added to prevent.
  check('the return quantity gate refuses negatives',
    screen.includes('!isBlankOrNonNegative(qty[l.id]'), true);
  // fulfilledQty: -3 on a customer's bill is a negative line total.
  check('the packed quantity gate refuses negatives',
    /if \(!isBlankOrNonNegative\(raw\)\) \{/.test(screen), true);
  // isBlankOrNonNegative passes '0'; `|| 1` then billed one of it.
  check('a typed zero quantity is no longer billed as one',
    /Math\.max\(0, num\(addQty\)\) \|\| 1/.test(screen), false);

  // Rejections that named the wrong problem: a box with digits in it was told
  // it was empty, and a bad cart quantity said nothing at all.
  check('the stock screen tells a garbage quantity from an empty box',
    /if \(!qty\.trim\(\)\) \{ Alert\.alert\('Enter a quantity'\); return; \}\s*\n\s*if \(!isNum\(qty\)\) \{/.test(screen), true);
  check('a khata payment of "₹500" is not called an empty amount',
    screen.includes("Alert.alert('Check the amount',"), true);
  check('a garbage cart quantity is refused out loud, not silently',
    /if \(raw\.trim\(\)\) \{\s*Alert\.alert\('Check the quantity',/.test(screen), true);
}

// ── rejection note (reason 'other' only, ≤ REJECT_NOTE_MAX) ────────
check('an "other" rejection carries the owner\'s words',
  rejectPayload('other', '  Supplier strike  '), { reason: 'other', note: 'Supplier strike' });
check('a coded rejection sends no note (server: note_not_allowed)',
  rejectPayload('out_of_stock', 'ignored'), { reason: 'out_of_stock', note: '' });
check('no code reads as other', rejectPayload(undefined, 'x').reason, 'other');
check('the note is clipped to the server maximum (note_too_long)',
  rejectPayload('other', 'a'.repeat(REJECT_NOTE_MAX + 50)).note.length, REJECT_NOTE_MAX);

// ── coupon labels speak the shop's currency ───────────────────────
check('a flat coupon is labelled in the shop currency',
  couponLabel({ kind: 'flat', value: 50, minOrder: 500 }, '$'), '$50 off over $500');
check('a percent coupon still reads as a percent', couponLabel({ kind: 'percent', value: 10, minOrder: 0 }, '$'), '10% off');
check('callers that pass no symbol keep the old ₹ label',
  couponLabel({ kind: 'flat', value: 20, minOrder: 0 }), '₹20 off');

// ── carts are per shop (cross-shop cart bug) ─────────────────────
{
  const line = (key: string, name: string): CartItem => ({ key, name, brand: '', qty: 1, price: 10, note: '' });
  let carts: CartsByShop = {};
  carts = withShopCart(carts, 'A', [line('a1', 'Atta')]);
  check('an unseen shop starts with an empty cart', cartFor(carts, 'B'), []);
  carts = withShopCart(carts, 'B', [line('b1', 'Milk')]);
  check('shop A keeps only its own lines', cartFor(carts, 'A').map((l) => l.name), ['Atta']);
  check('shop B keeps only its own lines', cartFor(carts, 'B').map((l) => l.name), ['Milk']);
  const before = carts;
  carts = withShopCart(carts, 'A', []);
  check('placing at A empties A', cartFor(carts, 'A'), []);
  check('… and drops its key', Object.keys(carts), ['B']);
  check('… and leaves B untouched', cartFor(carts, 'B').map((l) => l.name), ['Milk']);
  check('the previous state is not mutated', cartFor(before, 'A').map((l) => l.name), ['Atta']);
  // the screen must read the cart through the shop id, never one shared array
  const screen = shopBookSource() ?? '';
  check('the screen keys its cart by the open shop', /cart=\{cartFor\(carts, selShop\.id\)\}/.test(screen), true);
  check('no single shared cart state is left', /useState<CartItem\[\]>\(\[\]\)/.test(screen), false);
}

// This line used to print unconditionally, with no process.exit - so a failed
// check printed a tick-less line and the suite still exited 0. Every money
// assertion in this file was unenforceable until 2026-09-17.
console.log(failures === 0 ? String.fromCharCode(10) + 'all checks passed' : String.fromCharCode(10) + failures + ' CHECK(S) FAILED');
process.exit(failures === 0 ? 0 : 1);
