// components/shopbook/invoices.tsx — Shop Book, moved out of app/shop-book.tsx
// unchanged. Palette and styles come from ./theme; see app/shop-book.tsx.

import { useCallback, useEffect, useState } from 'react';
import { KeyboardSafe } from '../ui';
import { View, Text, TextInput, TouchableOpacity, ScrollView, Alert, ActivityIndicator, Modal } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import * as Print from 'expo-print';
import { formatMoney, dateLocale, isBlankOrNonNegative, num } from '../../utils/shopbook';
import * as SB from '../../services/shopBookService';
// ONE canonical document. Screen and PDF read the same model, so the two can
// no longer disagree the way buildBillHtml and InvoiceView's inline template did.
import { invoiceHtml, fromInvoice, taxIdentifiers } from '../../utils/shopbookInvoice';
import { LoadingState, ErrorState } from '../finance/ui';
import { t } from '../../lib/shopbookI18n';
import { C, s } from './theme';
import { previewDoc, Row, SubHeader, Field } from './shared';

// Live bill (P0-C). The owner weighs out what they packed and the total moves.
//
// Every number on this screen came from the server's last response. The client
// holds no arithmetic at all: it posts the change, and re-renders whatever
// comes back. That is why a customer can never be charged a total this screen
// invented.
export function BillScreen({ orderId, onBack }: { orderId: string; onBack: () => void }) {
  const [bill, setBill] = useState<SB.Bill | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [qtyDraft, setQtyDraft] = useState<Record<string, string>>({});
  const [discount, setDiscount] = useState('');
  const [addOpen, setAddOpen] = useState(false);
  const [addName, setAddName] = useState('');
  const [addQty, setAddQty] = useState('1');
  const [addPrice, setAddPrice] = useState('');

  const [loadErr, setLoadErr] = useState('');
  const load = useCallback(async () => {
    setLoading(true); setLoadErr('');
    try {
      const b = await SB.getBill(orderId);
      setBill(b);
      setDiscount(b.billDiscount > 0 ? String(b.billDiscount) : '');
    } catch (e: any) { setLoadErr(e?.message ?? 'Could not load the bill'); }
    finally { setLoading(false); }
  }, [orderId]);
  useEffect(() => { load(); }, [load]);

  // One helper for every edit: post it, take the server's bill as the truth.
  const patch = async (p: SB.BillUpdate) => {
    setBusy(true);
    try { setBill(await SB.updateBill(orderId, p)); }
    catch (e: any) { Alert.alert('Could not update the bill', e?.message ?? 'Try again'); }
    finally { setBusy(false); }
  };

  const money = (n: number) => formatMoney(n, bill?.currency ?? '₹');

  if (loading || !bill) {
    // A failed load used to fall into the spinner forever: show it, and retry.
    return (
      <>
        <SubHeader title="Bill" onBack={onBack} />
        {loading || !loadErr
          ? <LoadingState />
          : <ErrorState title="Could not load the bill" sub={loadErr} onRetry={load} />}
      </>
    );
  }

  return (
    <>
      <SubHeader title="Bill" onBack={onBack} />
      <Modal visible={addOpen} transparent animationType="fade" onRequestClose={() => setAddOpen(false)}>
        {/* KeyboardSafe + scroller (2026-09-18): the tallest card on this
            screen — 3 inputs and 2 buttons — and the one that overflows a
            320dp phone at font scale 1.5 once the keyboard is up. */}
        <KeyboardSafe keyboardOnly style={s.modalWrap}>
          <ScrollView style={{ flex: 1 }} contentContainerStyle={s.modalScroll} keyboardShouldPersistTaps="handled">
          <View style={s.modalCard}>
            <Text style={s.modalTitle}>Add an item</Text>
            <TextInput style={s.input} placeholder="Item name" placeholderTextColor={C.sub}
              accessibilityLabel="Item name" value={addName} onChangeText={setAddName} autoFocus />
            <TextInput style={s.input} placeholder="Quantity" placeholderTextColor={C.sub}
              accessibilityLabel="Quantity" keyboardType="numeric" value={addQty} onChangeText={setAddQty} />
            <TextInput style={s.input} placeholder={`Price (${bill.currency}) — catalog items price themselves`}
              accessibilityLabel={`Price in ${bill.currency}. Catalog items price themselves`}
              placeholderTextColor={C.sub} keyboardType="numeric" value={addPrice} onChangeText={setAddPrice} />
            <TouchableOpacity style={s.primaryBtn} accessibilityRole="button" accessibilityLabel="Add the item to the bill" onPress={() => {
              const name = addName.trim();
              if (!name) { Alert.alert('Name the item', 'Enter what you are adding to the bill.'); return; }
              // isNum, not just num (2026-09-17). An unparseable price becomes
              // 0 and this line goes onto the customer's bill FREE; an
              // unparseable qty falls through `|| 1` and bills one of whatever
              // they meant. Blank is still fine — blank qty means 1 and a blank
              // price is the "catalog items price themselves" case.
              const badAdd = [addQty, addPrice].find((v) => !isBlankOrNonNegative(v));
              if (badAdd != null) {
                Alert.alert('Check the quantity and price',
                  `"${badAdd.trim()}" is not a plain number. Use digits only — 1200 or 1,200 both work, and neither can be negative.`);
                return;
              }
              // isBlankOrNonNegative passes a typed "0" — it is non-negative,
              // not positive, whatever its old name suggested. `|| 1` then
              // turned that 0 into ONE of the item and billed it (2026-09-17).
              // Blank is the "how many? one" default and stays; a deliberately
              // typed 0 is the one place on this screen where zero is genuinely
              // wrong, because a zero-quantity line is not a line.
              if (addQty.trim() && num(addQty) === 0) {
                Alert.alert('Check the quantity', 'A quantity of 0 does not go on a bill. Leave it empty for one.');
                return;
              }
              setAddOpen(false);
              void patch({ add: { name, qty: num(addQty) || 1, price: num(addPrice) } });
              setAddName(''); setAddQty('1'); setAddPrice('');
            }}>
              <Text style={s.primaryBtnText}>Add</Text>
            </TouchableOpacity>
            <TouchableOpacity style={s.dangerBtn} onPress={() => setAddOpen(false)} accessibilityRole="button">
              <Text style={s.dangerBtnText}>Cancel</Text>
            </TouchableOpacity>
          </View>
          </ScrollView>
        </KeyboardSafe>
      </Modal>

      <ScrollView contentContainerStyle={s.body} keyboardShouldPersistTaps="handled">
        {!bill.editable && (
          <Text style={[s.hint, { color: C.danger }]}>
            This bill is final — the order has moved past packing.
          </Text>
        )}
        {bill.lines.filter((l) => l.availability !== 'unavailable').map((l) => (
          <View key={l.id} style={[s.card, l.removed && { opacity: 0.45 }]}>
            <View style={{ flex: 1 }}>
              <Text style={s.cardTitle}>{l.name}{l.brand ? ` (${l.brand})` : ''}</Text>
              <Text style={s.cardSub}>
                Ordered {l.requestedQty}{l.unit ? ` ${l.unit}` : ''} · {money(l.price)}
                {l.taxPercent > 0 ? ` · ${l.taxPercent}% tax` : ''}
              </Text>
              {bill.editable && !l.removed && (
                <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, marginTop: 6 }}>
                  <Text style={s.cardSub}>Packed</Text>
                  <TextInput
                    style={[s.input, { width: 90, marginBottom: 0, paddingVertical: 6 }]}
                    keyboardType="numeric"
                    accessibilityLabel={`Packed quantity of ${l.name}`}
                    placeholder={String(l.requestedQty)} placeholderTextColor={C.sub}
                    value={qtyDraft[l.id] ?? (l.weighed ? String(l.fulfilledQty) : '')}
                    onChangeText={(v) => setQtyDraft({ ...qtyDraft, [l.id]: v })}
                    onBlur={() => {
                      const raw = qtyDraft[l.id];
                      if (raw == null) return;
                      // Empty clears back to "as requested" rather than zero —
                      // a blank box must never silently mean "packed nothing".
                      // Neither may GARBAGE (2026-09-17): num() coerces it to 0,
                      // which is a real packed quantity, so the line billed as
                      // none-supplied and the customer paid for an empty bag.
                      // The draft is left in place so the typo can be corrected
                      // rather than thrown away.
                      //
                      // NON-NEGATIVE, not merely numeric: isBlankOrNum allows a
                      // leading minus for the stock screen's corrections, so
                      // "-3" passed here and sent fulfilledQty: -3 to the
                      // CUSTOMER'S BILL, where a negative packed quantity is a
                      // negative line total. Nothing is packed in negative.
                      if (!isBlankOrNonNegative(raw)) {
                        Alert.alert('Check the packed quantity',
                          `"${raw.trim()}" is not a packed quantity. Use digits only — 1200 or 1,200 both work — or clear the box to pack the full ordered quantity. It cannot be negative.`);
                        return;
                      }
                      void patch({ lines: [{ id: l.id, fulfilledQty: raw.trim() === '' ? null : num(raw) }] });
                      const { [l.id]: _done, ...rest } = qtyDraft;
                      setQtyDraft(rest);
                    }}
                  />
                  <TouchableOpacity accessibilityRole="button" accessibilityLabel={`Remove ${l.name} from the bill`} hitSlop={12}
                    onPress={() => patch({ lines: [{ id: l.id, removed: true }] })}>
                    <Ionicons name="trash-outline" size={18} color={C.danger} />
                  </TouchableOpacity>
                </View>
              )}
              {l.removed && bill.editable && (
                <TouchableOpacity onPress={() => patch({ lines: [{ id: l.id, removed: false }] })} hitSlop={12}
                  accessibilityRole="button" accessibilityLabel={`Put ${l.name} back on the bill`}>
                  <Text style={[s.cardSub, { color: C.green }]}>Put back</Text>
                </TouchableOpacity>
              )}
            </View>
            <Text style={s.price}>{money(l.total)}</Text>
          </View>
        ))}

        {bill.editable && (
          <>
            <TouchableOpacity style={s.outlineBtn} onPress={() => setAddOpen(true)} accessibilityRole="button">
              <Ionicons name="add" size={18} color={C.green} />
              <Text style={s.outlineBtnText}>Add an item</Text>
            </TouchableOpacity>
            <View style={{ flexDirection: 'row', gap: 8, alignItems: 'flex-end' }}>
              <View style={{ flex: 1 }}>
                <Field label={`Discount (${bill.currency})`} value={discount} onChange={setDiscount}
                  placeholder="0" keyboardType="numeric" />
              </View>
              <TouchableOpacity style={[s.outlineBtn, { marginTop: 0, paddingHorizontal: 18 }]}
                accessibilityRole="button" accessibilityLabel="Apply discount"
                onPress={() => {
                  // The EIGHTH ungated money write, and the only one pointed at
                  // the live customer bill with no range check at all
                  // (2026-09-17). A discount is money OFF, so a typed "-200"
                  // put the bill UP by ₹200 — an unauthorised SURCHARGE — while
                  // an unparseable "₹200" or "2,5" became num()'s believable 0,
                  // so the discount the owner just promised out loud silently
                  // did not apply and nothing said so. Blank still means no
                  // discount, which is why the non-negative gate is the right
                  // one rather than a bare isNum.
                  if (!isBlankOrNonNegative(discount)) {
                    Alert.alert('Check the discount',
                      `"${discount.trim()}" is not a discount. Use digits only — 1200 or 1,200 both work — or leave it empty for no discount. A discount cannot be negative.`);
                    return;
                  }
                  void patch({ billDiscount: num(discount) });
                }}>
                <Text style={s.outlineBtnText}>Apply</Text>
              </TouchableOpacity>
            </View>
          </>
        )}

        <View style={s.panel}>
          <Row label="Item subtotal" value={money(bill.subtotal)} />
          {bill.discount > 0 && <Row label="Discount" value={`− ${money(bill.discount)}`} tone={C.green} />}
          {bill.taxTotal > 0 && <Row label="Tax" value={money(bill.taxTotal)} />}
          {bill.deliveryFee > 0 && <Row label="Delivery" value={money(bill.deliveryFee)} />}
          {bill.roundOff !== 0 && (
            <Row label="Round off" value={`${bill.roundOff > 0 ? '+' : '−'} ${money(Math.abs(bill.roundOff))}`} />
          )}
          <View style={{ height: 1, backgroundColor: C.border, marginVertical: 6 }} />
          <Row label="Total" value={money(bill.total)} bold />
        </View>
        {busy && <ActivityIndicator color={C.green} accessibilityLabel="Updating the bill" />}
        <Text style={s.hint}>
          Totals are calculated by the server from the quantities you record here.
        </Text>
      </ScrollView>
    </>
  );
}

// Country-rule-driven invoice (spec: invoicing). Tax lines appear only when
// the shop configured tax details — the backend snapshot decides, not the UI.
export function InvoiceView({ orderId, onBack }: { orderId: string; onBack: () => void }) {
  const [inv, setInv] = useState<SB.Invoice | null>(null);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState('');
  const load = useCallback(async () => {
    setLoading(true); setErr('');
    try { setInv(await SB.orderInvoice(orderId)); }
    catch (e: any) { setErr(e?.message ?? 'Not available yet'); }
    finally { setLoading(false); }
  }, [orderId]);
  useEffect(() => { load(); }, [load]);

  const sharePdf = async () => {
    if (!inv) return;
    try {
      const { uri } = await Print.printToFileAsync({ html: invoiceHtml(fromInvoice(inv)) });
      previewDoc(uri, `${String(inv.invoiceNo).replace(/[/\\:*?"<>|]/g, '-')}.pdf`);
    } catch (e: any) { Alert.alert('Error', e?.message ?? 'Could not create the invoice PDF'); }
  };

  const money = (n: number) => formatMoney(n, inv?.currency ?? '₹');
  return (
    <>
      <SubHeader title={t('orders.invoice')} onBack={onBack}
        right={inv ? { icon: 'share-social-outline', label: 'Share the invoice PDF', onPress: sharePdf } : undefined} />
      <ScrollView contentContainerStyle={s.body}>
        {loading && <LoadingState />}
        {!!err && !loading && <ErrorState title="Couldn’t load the invoice" sub={err} onRetry={load} />}
        {inv && (
          <>
            <View style={s.panel}>
              <Text style={[s.cardSub, { textTransform: 'uppercase', letterSpacing: 1 }]}>
                {inv.kind === 'tax' ? 'Tax Invoice' : 'Invoice'}
              </Text>
              <Text numberOfLines={1} style={s.panelTitle}>{inv.business.name}</Text>
              {!!inv.business.address && <Text style={s.cardSub}>{inv.business.address}</Text>}
              {/* Only the tax identifiers the shop actually filled in — a
                  blank statutory field on a retail bill reads as an error.
                  Same helper the PDF uses, so the two cannot filter differently. */}
              {taxIdentifiers(inv.business.tax).map(({ key, value }) => (
                <Text key={key} style={s.cardSub}>{key}: {value}</Text>
              ))}
              <Text style={s.cardSub}>
                {inv.invoiceNo} · {new Date(inv.createdAt).toLocaleDateString(dateLocale(inv.country))}
              </Text>
              {!!inv.customerName && <Text style={s.cardSub}>Billed to: {inv.customerName}</Text>}
              {/* A business buyer's own details — present only on a tax invoice,
                  which is the document they can reclaim against. */}
              {!!inv.buyer?.businessName && <Text style={s.cardSub}>{inv.buyer.businessName}</Text>}
              {!!inv.buyer?.taxNumber && <Text style={s.cardSub}>Buyer tax no: {inv.buyer.taxNumber}</Text>}
              {!!inv.buyer?.address && <Text style={s.cardSub}>{inv.buyer.address}</Text>}
              {inv.status === 'cancelled' && (
                <Text style={[s.cardSub, { color: C.danger, fontWeight: '700' }]}>CANCELLED</Text>
              )}
            </View>
            {inv.items.map((it, i) => (
              <View key={`${it.name}-${i}`} style={s.card}>
                <View style={{ flex: 1 }}>
                  <Text style={s.cardTitle}>{it.name}{it.brand ? ` (${it.brand})` : ''} × {it.qty}</Text>
                  {!!it.unit && <Text style={s.cardSub}>{it.unit}</Text>}
                </View>
                <Text style={s.price}>{money(it.price * it.qty)}</Text>
              </View>
            ))}
            <View style={s.panel}>
              <Row label="Item subtotal" value={money(inv.subtotal)} />
              {inv.discount > 0 && <Row label="Discount" value={`− ${money(inv.discount)}`} tone={C.green} />}
              {inv.taxBreakdown.map((b) => <Row key={b.label} label={b.label} value={money(b.amount)} />)}
              {inv.roundOff !== 0 && (
                <Row label="Round off" value={`${inv.roundOff > 0 ? '+' : '−'} ${money(Math.abs(inv.roundOff))}`} />
              )}
              <View style={{ height: 1, backgroundColor: C.border, marginVertical: 6 }} />
              <Row label={t('common.total')} value={money(inv.total)} bold />
            </View>

            {/* What is actually still owed. Derived from the payments, so it
                cannot claim money that never arrived. */}
            <View style={[s.panel, inv.due > 0 && { borderColor: C.danger }]}>
              <Row label="Paid" value={money(inv.paid)} tone={C.green} />
              {inv.due > 0 && <Row label="Amount due" value={money(inv.due)} tone={C.danger} bold />}
              {inv.due <= 0 && inv.paid > 0 && (
                <Text style={[s.hint, { color: C.green, marginTop: 4 }]}>✓ Paid in full</Text>
              )}
            </View>
            <TouchableOpacity style={s.primaryBtn} onPress={sharePdf} accessibilityRole="button" accessibilityLabel="Invoice PDF">
              <Ionicons name="download-outline" size={18} color="#fff" />
              <Text style={s.primaryBtnText}>PDF</Text>
            </TouchableOpacity>
          </>
        )}
      </ScrollView>
    </>
  );
}
