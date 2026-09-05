// utils/shopbookInvoice.ts — the ONE canonical Shop Book document.
//
// There used to be two HTML generators: buildBillHtml (the pickup receipt) and
// an inline template inside InvoiceView.sharePdf (the statutory tax invoice).
// They disagreed, and the statutory one was the poorer of the two — no rate
// column, no unit column, the tax identifiers flattened to a grey line, and
// crucially NO paid/due, which the on-screen invoice displayed. The PDF a
// customer kept therefore contradicted the screen the shop had just shown them.
//
// Both callers now build an InvoiceDoc and render it through invoiceHtml(), so
// screen and PDF cannot drift again. Presentation may differ per target; the
// DATA is one model.
//
// PURE — no react-native import, no DOM — so every rule here is Node-tested in
// shopbookInvoice.selftest.ts. (An embedded self-check that reaches for `fs`
// breaks assembleRelease; source-scanning belongs in *.selftest.ts.)
//
// Nothing here computes money. Every figure is passed in already finalized by
// the server — the adapters below only move fields into a common shape.

import { formatMoney, dateLocale } from './shopbook';
import type * as SB from '../services/shopBookService';

export interface InvoiceDocLine {
  name: string;
  brand?: string;
  unit?: string;
  qty: number;
  rate: number;
  amount: number;
  /** Struck through on the document: asked for, not supplied. */
  struck?: boolean;
  /** Why it was struck, e.g. "not available". */
  struckNote?: string;
  /** What the customer asked for, when the shop weighed out something else. */
  requestedQty?: number;
}

export interface InvoiceDoc {
  /** "Tax Invoice" / "Invoice" / "Receipt" — drives the printed heading. */
  title: string;
  docNo: string;
  /** ISO timestamp. */
  date: string;
  /** BCP-47 tag from the shop's country; undefined = device default. */
  locale?: string;
  currency: string;
  cancelled: boolean;
  /** Order status chip. Absent on a pure invoice. */
  statusLabel?: string;
  business: {
    name: string;
    address?: string;
    phone?: string;
    ownerName?: string;
    /** Whatever the shop actually configured: gstin / vat / ein / abn … */
    tax: Record<string, string>;
  };
  customerName?: string;
  /** Present only on a tax invoice — the document a business can reclaim against. */
  buyer?: SB.InvoiceBuyer;
  lines: InvoiceDocLine[];
  subtotal: number;
  discount: number;
  couponCode?: string;
  taxLines: { label: string; amount: number }[];
  deliveryFee: number;
  roundOff: number;
  total: number;
  /** Omitted when the document has no payment record (a pickup receipt). */
  paid?: number;
  due?: number;
  note?: string;
  /** Closing line under the totals. */
  footer?: string;
}

/** Tax identifiers the shop actually filled in. A blank statutory field on a
 *  retail bill reads as an error, so empties never reach the document. */
export function taxIdentifiers(tax: Record<string, string | boolean> | undefined | null):
  { key: string; value: string }[] {
  return Object.entries(tax ?? {})
    .filter(([, v]) => v !== true && String(v ?? '').trim() !== '')
    .map(([k, v]) => ({ key: k.toUpperCase(), value: String(v) }));
}

// ── adapters ──────────────────────────────────────────────────────

/** The statutory document. `kind` decides whether it claims to be a tax invoice. */
export function fromInvoice(inv: SB.Invoice): InvoiceDoc {
  return {
    title: inv.kind === 'tax' ? 'Tax Invoice' : 'Invoice',
    docNo: inv.invoiceNo,
    date: inv.createdAt,
    locale: dateLocale(inv.country),
    currency: inv.currency || '₹',
    cancelled: inv.status === 'cancelled',
    business: {
      name: inv.business?.name ?? '',
      address: inv.business?.address,
      phone: inv.business?.phone,
      // Invoice.business.tax is Record<string, string | boolean>; the boolean
      // `true` is a "configured but unnumbered" flag and is not an identifier.
      tax: Object.fromEntries(taxIdentifiers(inv.business?.tax).map((t) => [t.key, t.value])),
    },
    customerName: inv.customerName,
    // Only a tax invoice carries the buyer's own details.
    buyer: inv.kind === 'tax' ? inv.buyer : undefined,
    lines: (inv.items ?? []).map((it) => ({
      name: it.name,
      brand: it.brand || undefined,
      unit: it.unit || undefined,
      qty: it.qty,
      rate: it.price,
      amount: it.price * it.qty,
    })),
    subtotal: inv.subtotal,
    discount: inv.discount,
    taxLines: inv.taxBreakdown ?? [],
    deliveryFee: 0,          // not a field on Invoice; the server folds it in
    roundOff: inv.roundOff,
    total: inv.total,
    paid: inv.paid,
    due: inv.due,
    footer: 'Thank you for shopping with us!',
  };
}

/** The pickup receipt. No payment record exists, so paid/due stay undefined
 *  rather than being rendered as zero — "Paid ₹0" on a collected order is a
 *  lie, an absent row is not. */
export function fromOrder(order: SB.OrderDetail, statusLabel?: string): InvoiceDoc {
  const shop = order.shop ?? {
    name: '', address: '', phone: '', country: '', ownerName: '',
    taxConfig: {} as Record<string, string>,
  };
  const lines: InvoiceDocLine[] = (order.items ?? []).map((it) => {
    const gone = it.availability === 'unavailable' || it.removed === true;
    return {
      name: it.name,
      brand: it.brand || undefined,
      unit: it.unit || undefined,
      qty: it.qty,
      rate: it.price,
      amount: it.price * it.qty,
      struck: gone,
      struckNote: gone ? (it.removed ? 'removed at billing' : 'not available') : undefined,
      // Shown only when it differs — a weighed-out quantity the customer should
      // be able to reconcile against what they asked for.
      requestedQty: it.requestedQty != null && it.requestedQty !== it.qty ? it.requestedQty : undefined,
    };
  });
  const taxIds = taxIdentifiers(shop.taxConfig);
  return {
    title: 'Receipt',
    docNo: order.id.slice(0, 8).toUpperCase(),
    date: order.createdAt,
    locale: dateLocale(shop.country),
    currency: order.currency || '₹',
    cancelled: order.status === 'cancelled',
    statusLabel,
    business: {
      name: shop.name,
      address: shop.address,
      phone: shop.phone,
      ownerName: shop.ownerName,
      tax: Object.fromEntries(taxIds.map((t) => [t.key, t.value])),
    },
    buyer: order.buyerTax?.taxNumber ? order.buyerTax : undefined,
    lines,
    // Server-finalized. Only fall back to summing the lines when the order
    // predates the P0-A breakdown, where subtotal is absent rather than zero.
    subtotal: order.subtotal ?? lines.reduce((s, l) => s + l.amount, 0),
    discount: order.discount ?? 0,
    couponCode: order.couponCode || undefined,
    taxLines: order.taxTotal > 0 ? [{ label: 'Tax', amount: order.taxTotal }] : [],
    deliveryFee: order.delivery ? (order.deliveryFee ?? 0) : 0,
    roundOff: order.roundOff ?? 0,
    total: order.total,
    note: order.note || undefined,
    footer: taxIds.length ? undefined : 'Not a tax invoice.',
  };
}

// ── render ────────────────────────────────────────────────────────

/** HTML-escape. Shop names carry apostrophes and ampersands; one unescaped
 *  quote breaks the whole document. */
export const esc = (s: unknown): string =>
  String(s ?? '').replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c] as string));

const fmtDate = (iso: string, locale?: string): string => {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleDateString(locale);
};

/**
 * The printable document. Deliberately NOT glass: this is the one surface in
 * Shop Book that gets printed, and translucency over an ink-free page is just
 * grey text. Solid, high contrast, one accent rule.
 *
 * Fluid down to a thermal-roll width and up to A4 — a single column that never
 * needs horizontal scroll, with the table header repeating across page breaks
 * and totals kept whole.
 */
export function invoiceHtml(doc: InvoiceDoc): string {
  const cur = doc.currency || '₹';
  const m = (n: number) => esc(formatMoney(n, cur));

  const taxIdLines = Object.entries(doc.business.tax ?? {})
    .map(([k, v]) => `<div>${esc(k)}: <b>${esc(v)}</b></div>`).join('');

  const rows = doc.lines.map((l) => {
    const meta = [
      l.brand ? `(${esc(l.brand)})` : '',
      l.unit ? `· ${esc(l.unit)}` : '',
      l.struckNote ? `— ${esc(l.struckNote)}` : '',
      l.requestedQty != null ? `· asked for ${esc(l.requestedQty)}` : '',
    ].filter(Boolean).join(' ');
    return `<tr${l.struck ? ' class="struck"' : ''}>
      <td>${esc(l.name)}${meta ? ` <span class="muted">${meta}</span>` : ''}</td>
      <td class="num">${esc(l.qty)}</td>
      <td class="num">${l.rate > 0 ? m(l.rate) : '—'}</td>
      <td class="num">${l.rate > 0 ? m(l.amount) : '—'}</td>
    </tr>`;
  }).join('');

  // Every total that is actually non-zero. A row of zeroes reads as an error.
  const totals = [
    `<tr><td class="lbl">Subtotal</td><td class="num">${m(doc.subtotal)}</td></tr>`,
    doc.discount > 0
      ? `<tr><td class="lbl">Discount${doc.couponCode ? ` (${esc(doc.couponCode)})` : ''}</td>
           <td class="num pos">− ${m(doc.discount)}</td></tr>` : '',
    doc.taxLines.map((t) =>
      `<tr><td class="lbl">${esc(t.label)}</td><td class="num">${m(t.amount)}</td></tr>`).join(''),
    doc.deliveryFee > 0
      ? `<tr><td class="lbl">Delivery</td><td class="num">${m(doc.deliveryFee)}</td></tr>` : '',
    doc.roundOff !== 0
      ? `<tr><td class="lbl">Round off</td><td class="num">${doc.roundOff > 0 ? '+' : '−'} ${m(Math.abs(doc.roundOff))}</td></tr>` : '',
    `<tr class="grand"><td>Total</td><td class="num">${m(doc.total)}</td></tr>`,
    // Payment. Present only when the document actually has a payment record.
    doc.paid != null
      ? `<tr class="pay"><td class="lbl">Paid</td><td class="num pos">${m(doc.paid)}</td></tr>` : '',
    doc.due != null && doc.due > 0
      ? `<tr class="pay"><td class="lbl due">Amount due</td><td class="num due">${m(doc.due)}</td></tr>` : '',
  ].join('');

  const paidInFull = doc.due != null && doc.due <= 0 && (doc.paid ?? 0) > 0;

  return `<!doctype html><html><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(doc.title)} ${esc(doc.docNo)}</title>
<style>
  *{box-sizing:border-box}
  :root{--ink:#111827;--mut:#4B5563;--faint:#9CA3AF;--rule:#E5E7EB;--accent:#0B7A3B;--due:#B42318}
  html{-webkit-text-size-adjust:100%}
  body{font-family:-apple-system,'Segoe UI',Roboto,'Helvetica Neue',sans-serif;
       color:var(--ink);margin:0;padding:24px 20px;font-size:14px;line-height:1.5;
       background:#fff;max-width:190mm;margin-inline:auto}
  /* Money aligns down a column or the column looks ragged. */
  .num{text-align:right;font-variant-numeric:tabular-nums;white-space:nowrap}
  .muted{color:var(--mut);font-weight:400}
  .pos{color:var(--accent)}
  .due{color:var(--due);font-weight:700}
  .head{display:flex;justify-content:space-between;align-items:flex-start;gap:20px;
        flex-wrap:wrap;border-bottom:2px solid var(--accent);padding-bottom:14px}
  .biz{flex:1 1 220px;min-width:0}
  .shop{font-size:20px;font-weight:700;color:var(--accent);margin:0 0 4px;
        overflow-wrap:anywhere}
  .ids{margin-top:6px;font-size:12px;color:var(--mut)}
  .meta{flex:0 1 auto;text-align:right;font-size:12px;color:var(--mut);line-height:1.7}
  .title{font-size:11px;font-weight:700;letter-spacing:.8px;text-transform:uppercase;
         color:var(--accent)}
  .tag{display:inline-block;padding:3px 10px;border-radius:999px;font-size:11px;
       font-weight:700;background:#E8F5EE;color:var(--accent);letter-spacing:.3px}
  .bill{margin-top:16px;font-size:13px;color:var(--mut)}
  .bill b{color:var(--ink)}
  .cancel{margin-top:14px;border:2px solid var(--due);color:var(--due);font-weight:700;
          letter-spacing:2px;text-align:center;padding:6px;border-radius:6px}
  table{width:100%;border-collapse:collapse;margin-top:20px}
  th{text-align:left;font-size:11px;text-transform:uppercase;letter-spacing:.6px;
     color:var(--mut);border-bottom:1px solid #D1D5DB;padding:0 8px 8px}
  td{padding:9px 8px;border-bottom:1px solid #F3F4F6;vertical-align:top}
  /* Columns need a gutter or they collide: with zero horizontal padding the
     heads render as "QTYRATEAMOUNT" and a row reads "2₹350". Found on a real
     device — the static checks could not see it, because they assert on the
     markup and this is a rendered-width failure. The outer edges stay flush so
     the table still aligns with the rest of the document. */
  th:first-child,td:first-child{padding-left:0}
  th:last-child,td:last-child{padding-right:0}
  th.num{text-align:right}
  .struck td{color:var(--faint);text-decoration:line-through}
  .struck td .muted{text-decoration:none}
  .totals{margin-left:auto;margin-top:14px;width:min(62%,300px)}
  .totals td{border:none;padding:5px 0}
  .totals .lbl{color:var(--mut)}
  .grand td{border-top:2px solid var(--ink);padding-top:11px;font-size:17px;font-weight:700}
  .pay td{padding-top:8px}
  .foot{margin-top:28px;padding-top:14px;border-top:1px solid #F3F4F6;
        font-size:11px;color:var(--mut);line-height:1.7}
  /* Narrow roll / small phone: the rate column is the one that can go, because
     qty x amount still lets a customer check the arithmetic. */
  @media (max-width:360px){
    body{padding:16px 12px;font-size:13px}
    .meta{text-align:left}
    th:nth-child(3),td:nth-child(3){display:none}
    .totals{width:100%}
  }
  @media print{
    body{padding:0;max-width:none}
    /* Repeat the header on every page and never split a line or the totals. */
    thead{display:table-header-group}
    tr{break-inside:avoid;page-break-inside:avoid}
    .totals,.foot{break-inside:avoid;page-break-inside:avoid}
    .head{break-after:avoid}
  }
  @page{size:A4;margin:14mm}
</style></head>
<body>
  <div class="head">
    <div class="biz">
      <p class="shop">${esc(doc.business.name) || 'Shop Book'}</p>
      ${doc.business.ownerName ? `<div class="muted">${esc(doc.business.ownerName)}</div>` : ''}
      ${doc.business.address ? `<div class="muted">${esc(doc.business.address)}</div>` : ''}
      ${doc.business.phone ? `<div class="muted">☎ ${esc(doc.business.phone)}</div>` : ''}
      ${taxIdLines ? `<div class="ids">${taxIdLines}</div>` : ''}
    </div>
    <div class="meta">
      <div class="title">${esc(doc.title)}</div>
      ${doc.statusLabel ? `<div style="margin-top:6px"><span class="tag">${esc(doc.statusLabel)}</span></div>` : ''}
      <div style="margin-top:8px"><b>${esc(doc.docNo)}</b></div>
      <div>${esc(fmtDate(doc.date, doc.locale))}</div>
    </div>
  </div>

  ${doc.cancelled ? '<div class="cancel">CANCELLED</div>' : ''}

  ${doc.customerName || doc.buyer ? `<div class="bill">
    ${doc.customerName ? `Billed to: <b>${esc(doc.customerName)}</b>` : ''}
    ${doc.buyer?.businessName ? `<div>${esc(doc.buyer.businessName)}</div>` : ''}
    ${doc.buyer?.taxNumber ? `<div>Buyer tax no: <b>${esc(doc.buyer.taxNumber)}</b></div>` : ''}
    ${doc.buyer?.address ? `<div>${esc(doc.buyer.address)}</div>` : ''}
  </div>` : ''}

  <table>
    <thead><tr>
      <th>Item</th><th class="num">Qty</th><th class="num">Rate</th><th class="num">Amount</th>
    </tr></thead>
    <tbody>${rows}</tbody>
  </table>

  <table class="totals">${totals}</table>
  ${paidInFull ? '<p class="num pos" style="margin:6px 0 0"><b>✓ Paid in full</b></p>' : ''}

  ${doc.note ? `<div class="foot">Note: ${esc(doc.note)}</div>` : ''}
  ${doc.footer ? `<div class="foot">${esc(doc.footer)}</div>` : ''}
  <div class="foot">Generated by Shop Book</div>
</body></html>`;
}

export default {};
