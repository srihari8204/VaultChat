// utils/shopbookInvoice.selftest.ts — run: npx tsx utils/shopbookInvoice.selftest.ts
//
// Guards the ONE thing consolidating the two invoice generators was for:
// the printed document may not omit what the screen shows. The old
// InvoiceView.sharePdf dropped paid/due, the rate column and the unit column,
// so a customer's PDF disagreed with the shop's screen. §1-§4 below fail if
// that regresses.
//
// Everything here is a pure string/shape assertion — no network, no DOM.

import {
  fromInvoice, fromOrder, invoiceHtml, taxIdentifiers, esc,
  type InvoiceDoc,
} from './shopbookInvoice';
import type * as SB from '../services/shopBookService';

let failures = 0;
function check(name: string, actual: unknown, expected: unknown) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failures++;
  console.log(`  ${ok ? '✓' : '✗'} ${name}${ok ? '' : `  (got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)})`}`);
}
function ok(name: string, cond: boolean) { check(name, cond, true); }

console.log('shopbookInvoice.selftest');

const INV: SB.Invoice = {
  kind: 'tax', status: 'issued',
  buyer: { businessName: 'Acme Traders', taxNumber: '29ZZZZZ0000Z1Z5', address: '4 Mill Rd' },
  roundOff: -0.4, paymentStatus: 'partially_paid', paid: 500, due: 249.6,
  id: 'i1', orderId: 'o1', number: 42, invoiceNo: 'INV-0042',
  country: 'IN', taxType: 'gst', currency: '₹',
  subtotal: 700, discount: 50, taxTotal: 100, total: 749.6,
  business: { name: "Ravi's Store", address: '12 MG Rd', phone: '9876543210',
              tax: { gstin: '29ABCDE1234F1Z5', pan: '', msme: true } },
  customerName: 'Priya',
  items: [{ name: 'Rice', brand: 'India Gate', unit: '5 kg', qty: 2, price: 350, taxPercent: 5 }],
  taxBreakdown: [{ label: 'CGST 2.5%', amount: 50 }, { label: 'SGST 2.5%', amount: 50 }],
  createdAt: '2026-09-01T10:00:00.000Z',
};

// ── 1. the regression this module exists to prevent ───────────────
const taxDoc = fromInvoice(INV);
const taxHtml = invoiceHtml(taxDoc);

check('paid survives into the doc', taxDoc.paid, 500);
check('due survives into the doc', taxDoc.due, 249.6);
ok('PDF prints Paid — the old sharePdf did not', taxHtml.includes('Paid'));
ok('PDF prints Amount due — the old sharePdf did not', taxHtml.includes('Amount due'));
ok('PDF prints the due figure', taxHtml.includes('249.6'));
ok('PDF has a Rate column — the old sharePdf did not', taxHtml.includes('>Rate<'));
ok('PDF prints the unit — the old sharePdf dropped it', taxHtml.includes('5 kg'));
ok('PDF prints round off', taxHtml.includes('Round off'));
ok('every tax breakdown line is printed',
  INV.taxBreakdown.every((t) => taxHtml.includes(t.label)));

// ── 2. statutory identity ─────────────────────────────────────────
check('tax invoice titled', taxDoc.title, 'Tax Invoice');
check('retail invoice titled', fromInvoice({ ...INV, kind: 'retail' }).title, 'Invoice');
// The buyer's own tax number is what makes the document reclaimable; it has no
// meaning on a retail bill and must not appear there.
check('retail drops the buyer block', fromInvoice({ ...INV, kind: 'retail' }).buyer, undefined);
ok('tax invoice prints the buyer tax number', taxHtml.includes('29ZZZZZ0000Z1Z5'));

// A blank statutory field on a bill reads as an error, and `true` is a
// "configured but unnumbered" flag, not an identifier. Neither may print.
check('blank + boolean tax ids are dropped',
  taxIdentifiers({ gstin: '29ABCDE1234F1Z5', pan: '', msme: true }),
  [{ key: 'GSTIN', value: '29ABCDE1234F1Z5' }]);
ok('the real tax id prints', taxHtml.includes('29ABCDE1234F1Z5'));

// ── 3. the order/receipt path ─────────────────────────────────────
const ORDER = {
  id: 'abcdef1234', shopId: 's1', status: 'collected', total: 200,
  subtotal: 190, taxTotal: 10, roundOff: 0, note: 'Leave at the gate',
  createdAt: '2026-09-01T10:00:00.000Z',
  items: [
    { id: '1', name: 'Milk', brand: '', unit: '1 L', qty: 2, price: 50, taxPercent: 0,
      note: '', availability: 'available', altName: '', altPrice: 0, productId: 'p1',
      lineTax: 0, lineTotal: 100, requestedQty: 3 },
    { id: '2', name: 'Bread', brand: 'Modern', unit: '', qty: 1, price: 40, taxPercent: 0,
      note: '', availability: 'unavailable', altName: '', altPrice: 0, productId: 'p2',
      lineTax: 0, lineTotal: 0 },
  ],
  couponCode: 'SAVE10', discount: 10, delivery: true, deliveryFee: 20,
  address: '', rated: false, currency: '₹', timeline: [],
  cancelReason: '', cancelledBy: '', rejectReason: '', notCollectedReason: '',
  hasInvoice: false, buyerTax: {},
  shop: { name: 'Corner Shop', address: '1 Lane', phone: '900', country: 'IN',
          ownerName: 'Ravi', taxConfig: {} },
} as unknown as SB.OrderDetail;

const rec = fromOrder(ORDER, 'Collected');
const recHtml = invoiceHtml(rec);

check('receipt titled', rec.title, 'Receipt');
// A pickup receipt has no payment record. "Paid ₹0" on a collected order is a
// lie; an absent row is not.
check('receipt has no paid', rec.paid, undefined);
check('receipt has no due', rec.due, undefined);
ok('receipt omits the Amount due row', !recHtml.includes('Amount due'));
check('server subtotal is used, not a re-sum', rec.subtotal, 190);
check('coupon code carried', rec.couponCode, 'SAVE10');
check('delivery fee carried', rec.deliveryFee, 20);
ok('coupon code prints beside the discount', recHtml.includes('SAVE10'));
ok('shop with no tax id says so', recHtml.includes('Not a tax invoice'));
ok('status chip prints', recHtml.includes('Collected'));

// An unavailable line stays on the document, struck — a receipt that silently
// drops what was asked for cannot be reconciled against the order.
check('unavailable line is struck', rec.lines[1].struck, true);
check('struck line says why', rec.lines[1].struckNote, 'not available');
ok('struck class reaches the html', recHtml.includes('class="struck"'));
// Weighed-out quantity: shown only when it differs from what was requested.
check('differing requested qty is kept', rec.lines[0].requestedQty, 3);
check('matching requested qty is not repeated',
  fromOrder({ ...ORDER, items: [{ ...(ORDER.items[0] as any), requestedQty: 2 }] } as any).lines[0].requestedQty,
  undefined);

// ── 4. cancelled ──────────────────────────────────────────────────
ok('cancelled invoice is stamped',
  invoiceHtml(fromInvoice({ ...INV, status: 'cancelled' })).includes('CANCELLED'));
ok('issued invoice is not stamped', !taxHtml.includes('CANCELLED'));

// ── 5. escaping ───────────────────────────────────────────────────
// One apostrophe in a shop name used to be enough to break the markup.
check('escapes the lot', esc(`&<>"'`), '&amp;&lt;&gt;&quot;&#39;');
ok('shop name is escaped in situ', taxHtml.includes('Ravi&#39;s Store'));
ok('no raw apostrophe leaks from the shop name', !taxHtml.includes("Ravi's Store"));
const xss = invoiceHtml(fromInvoice({
  ...INV, customerName: '<script>alert(1)</script>',
}));
ok('customer name cannot inject a tag', !xss.includes('<script>alert'));

// ── 6. print determinism ──────────────────────────────────────────
// A multi-page bill that splits a row or loses its column heads is unreadable,
// and a totals block orphaned onto page 2 is worse than no page break at all.
ok('table head repeats across pages', taxHtml.includes('display:table-header-group'));
ok('rows never split', taxHtml.includes('break-inside:avoid'));
ok('page size is declared', taxHtml.includes('@page'));
ok('narrow-width rule exists', taxHtml.includes('@media (max-width:360px)'));
// Column gutters. With zero horizontal padding the heads render as
// "QTYRATEAMOUNT" and a row reads "2₹350" — found on a real device, invisible
// to a markup-only assertion, so pin the rule that fixes it.
ok('table cells have a horizontal gutter', /td\{padding:9px 8px/.test(taxHtml));
ok('outer edges stay flush', taxHtml.includes('th:first-child,td:first-child{padding-left:0}'));
// Money must align down the column or a list of amounts looks ragged.
ok('tabular figures', taxHtml.includes('tabular-nums'));

// ── 7. zero-noise totals ──────────────────────────────────────────
// A row of zeroes reads as a fault in the bill.
const plain = invoiceHtml({
  title: 'Invoice', docNo: 'X', date: '2026-09-01T00:00:00.000Z', currency: '₹',
  cancelled: false, business: { name: 'S', tax: {} }, lines: [],
  subtotal: 0, discount: 0, taxLines: [], deliveryFee: 0, roundOff: 0, total: 0,
} as InvoiceDoc);
ok('no zero discount row', !plain.includes('Discount'));
ok('no zero delivery row', !plain.includes('Delivery'));
ok('no zero round-off row', !plain.includes('Round off'));
ok('total always prints', plain.includes('Total'));

console.log(failures === 0 ? '\nAll invoice checks passed.' : `\n${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
