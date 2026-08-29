// utils/shopbook.selftest.ts — run: npx tsx utils/shopbook.selftest.ts
//
// Guards the SHOP BOOK upgrade's client-side contracts (openspec:
// shop-book-upgrade): the order pipeline the UI navigates by, the
// actor-scoped cancellation windows the buttons obey, the rejection reason
// codes that must match the Go backend's table, legacy 'new' status compat,
// currency-aware money, and holiday/vacation open-state.

import {
  ORDER_STEPS, orderProgress, nextOrderStatus, orderStatusLabel,
  normalizeOrderStatus, canCustomerCancel, canOwnerCancel, REJECT_REASONS,
  formatMoney, shopOpenState, cartTotal,
  canCustomerCollect, notCollectedGate, NOT_COLLECTED_AFTER_HOURS,
  isStalePrice, PRICE_STALE_DAYS, dateLocale,
  type OrderStatus, type TimelineEvent,
} from './shopbook';

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

if (failures) {
  console.error(`\n${failures} check(s) failed`);
  process.exit(1);
}
console.log('\nall checks passed');
