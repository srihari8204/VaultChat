// components/shopbook/khataDetail.tsx — Shop Book: one customer's khata (entries, payments,
// statement) and the draft product line shared with the counter sale in ./ledger.
// Moved out of components/shopbook/ledger.tsx unchanged (round 7 split).
// Palette and styles come from ./theme.

import { useCallback, useRef, useState } from 'react';
import { View, Text, TextInput, TouchableOpacity, FlatList, Alert, RefreshControl } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import * as Print from 'expo-print';
import { formatMoney, clientKey, normalizeUnit, isNum, isBlankOrNum, num } from '../../utils/shopbook';
import * as SB from '../../services/shopBookService';
import { ErrorState } from '../finance/ui';
import { C, s } from './theme';
import { previewDoc, SubHeader, Chip, StatCard, LedgerRow, Empty } from './shared';
import { useShopLoad } from './useShopLoad';

/** One product row being typed into a counter sale or a khata entry. Held as
 *  strings: a half-typed "12." is not a number yet. */
export interface DraftLine { key: string; name: string; qty: string; price: string; unit: string }

export const newDraftLine = (): DraftLine => ({ key: clientKey(), name: '', qty: '1', price: '', unit: '' });

export function KhataDetail({ customer, currency, onBack }: { customer: SB.CustomerPending; currency?: string; onBack: () => void }) {
  const money = (n: number) => formatMoney(n, currency || '₹');
  const [ledger, setLedger] = useState<SB.Ledger | null>(null);
  const [amount, setAmount] = useState('');
  const [remark, setRemark] = useState('');
  const [busy, setBusy] = useState(false);
  const [method, setMethod] = useState<SB.PaymentMethod>('cash');
  // Held as strings: a half-typed "12." is not a number yet, and coercing on
  // every keystroke fights the keyboard.
  const [items, setItems] = useState<DraftLine[]>([]);
  const setItem = (key: string, patch: Partial<DraftLine>) =>
    setItems((prev) => prev.map((it) => (it.key === key ? { ...it, ...patch } : it)));
  const itemsTotal = items.reduce((n, it) => n + num(it.qty) * num(it.price), 0);

  const fetchLedger = useCallback(
    () => SB.ownerCustomerLedger(customer.customerId, !!customer.isKhata),
    [customer.customerId, customer.isKhata]);
  const { loading, err, load } = useShopLoad(fetchLedger, setLedger);

  // A key per entry the owner is composing: a retry of THIS payment resolves
  // to the row already written, but the next payment gets its own key.
  const entryKey = useRef(clientKey());

  const add = async (type: 'purchase' | 'payment', confirmOverLimit = false) => {
    const lines = type === 'purchase' ? items : [];
    // A blank row is someone who tapped "add product" and changed their mind —
    // drop it rather than making them hunt for the × to submit.
    const filled = lines.filter((it) => it.name.trim() || it.price.trim());
    // isNum, not just a range check (2026-09-17). num() coerces anything
    // unparseable to 0, and `< 0` can never catch a 0 — so "₹285" passed this
    // guard and the item SOLD FOR ₹0, with a ₹0 invoice printed and shared. A
    // `qty` of "0x10" meant sixteen, because Number() accepts hex. ("1,200" was
    // the same bug until thousands grouping was made to parse, same date.)
    const bad = filled.find((it) => !it.name.trim() || !isNum(it.qty) || !isNum(it.price)
                                 || num(it.qty) <= 0 || num(it.price) < 0);
    if (bad) {
      Alert.alert(
        'Check the products',
        !isNum(bad.price) && bad.price.trim()
          ? `"${bad.price}" is not a plain number — use digits only, 1200 or 1,200.`
          : 'Every product needs a name, a quantity above 0 and a price.',
      );
      return;
    }
    // Name the real problem (2026-09-17). A typed "₹500" is num()'s 0, and the
    // `amt <= 0` branch below then said "Enter an amount" about a box holding
    // 500 — so the owner retyped it and was refused identically. Blank still
    // falls through to "Enter an amount", which is the honest message for a
    // blank box.
    if (!filled.length && amount.trim() && !isNum(amount)) {
      Alert.alert('Check the amount',
        `"${amount.trim()}" is not a plain number. Use digits only — 1200 or 1,200 both work.`);
      return;
    }
    const amt = filled.length ? itemsTotal : num(amount);
    if (amt <= 0) { Alert.alert(filled.length ? `Product prices add up to ${money(0)}` : 'Enter an amount'); return; }
    setBusy(true);
    try {
      if (type === 'payment' && customer.isKhata) {
          // A walk-in has no account, and /payments validates the payer against
          // shopbook_customer / shopbook_order, neither of which a walk-in can
          // appear in. The ledger endpoint already accepts khataCustomerId with
          // type 'payment', so the balance is recorded there. Method/reference
          // metadata for walk-ins is a separate change; the remark carries it
          // rather than the detail being silently dropped.
          await SB.addLedgerEntry(
            customer.customerId, 'payment', amt,
            [method, remark.trim()].filter(Boolean).join(' - '),
            entryKey.current, undefined, false, true,
          );
        } else if (type === 'payment') {
        // Money received is a payment RECORD — method and reference included,
        // and it posts its own khata entry server-side (P0-E). Partial is
        // normal: whatever is left simply stays pending.
        await SB.recordPayment({
          customerId: customer.customerId, amount: amt, method,
          reference: remark.trim(), idempotencyKey: entryKey.current,
        });
      } else {
        await SB.addLedgerEntry(customer.customerId, type, amt, remark.trim(),
          entryKey.current,
          filled.length
            ? filled.map((it) => ({
                name: it.name.trim(), brand: '', unit: normalizeUnit(it.unit),
                qty: num(it.qty), price: num(it.price), taxPercent: 0,
              }))
            : undefined,
          confirmOverLimit, !!customer.isKhata);
      }
      entryKey.current = clientKey();
      setAmount(''); setRemark(''); setItems([]); load();
    } catch (e: any) {
      // Over the credit limit is a question, not a failure. Keep the same
      // idempotency key on the retry so confirming cannot double-post.
      const breach = SB.creditBreachFrom(e);
      if (breach) {
        Alert.alert(
          'Over credit limit',
          `${customer.customerName || 'This customer'} owes ${money(breach.pending)}. `
          + `This entry takes them to ${money(breach.afterEntry)}, past their `
          + `${money(breach.limit)} limit.`,
          [{ text: 'Cancel', style: 'cancel' },
           { text: 'Add anyway', style: 'destructive', onPress: () => add(type, true) }],
        );
        return;
      }
      Alert.alert('Error', e?.message ?? 'Try again');
    }
    finally { setBusy(false); }
  };

  // Issue the document, fetch the server-rendered HTML, hand it to the printer.
  // Issuing is idempotent server-side (partial unique index on ledger_id), so
  // sharing the same entry twice reuses one numbered document rather than
  // burning a second invoice number.
  const shareDoc = async (entry: SB.LedgerEntry) => {
    const isPay = entry.type === 'payment';
    setBusy(true);
    try {
      const { id } = isPay
        ? await SB.issueKhataReceipt(entry.id)
        : await SB.issueKhataInvoice(entry.id);
      const html = await SB.invoiceHtml(id);
      const { uri } = await Print.printToFileAsync({ html });
      previewDoc(uri, `${isPay ? 'receipt' : 'bill'}-${id}.pdf`);
    } catch (e: any) {
      Alert.alert(isPay ? 'Could not create the receipt' : 'Could not create the bill',
        e?.message ?? 'Try again');
    } finally { setBusy(false); }
  };

  // ── credit ceiling ──────────────────────────────────────────────
  //
  // Migration 112 added the column, sbCreditCheck has read it since, and the
  // over-limit prompt above has always been able to fire — but nothing in the
  // app could ever WRITE a limit, so every ceiling in production was the
  // schema default of 0, which means unconstrained. The gate was documented as
  // enforced and was in fact inert.
  //
  // Two tables, one meaning: a walk-in's ceiling lives on
  // shopbook_khata_customer because shopbook_customer.customer_user_id is a
  // users FK a walk-in can never satisfy.
  const [limitOpen, setLimitOpen] = useState(false);
  const [limitText, setLimitText] = useState(
    customer.creditLimit != null && customer.creditLimit > 0 ? String(customer.creditLimit) : '');
  const [limit, setLimit] = useState<number | undefined>(customer.creditLimit);

  const saveLimit = async () => {
    // isNum FIRST, because 0 is not a rejection here — it is "no ceiling"
    // (2026-09-17). num() coerces an unparseable "₹1,2" to 0, so the owner
    // typing a limit would have REMOVED the limit, and sbCreditCheck would
    // wave through every entry after it. The `< 0` guard below cannot see that,
    // because 0 is not negative. Blank still means no limit.
    if (!isBlankOrNum(limitText)) {
      Alert.alert('Check the limit',
        `"${limitText}" is not a plain number. Use digits only — 1200 or 1,200 both work — or leave it empty for no limit.`);
      return;
    }
    const v = num(limitText);
    if (v < 0) { Alert.alert('Enter 0 or more', 'Use 0 for no limit.'); return; }
    setBusy(true);
    try {
      if (customer.isKhata) await SB.setKhataCreditLimit(customer.customerId, v);
      else await SB.setCreditLimit(customer.customerId, v);
      setLimit(v); setLimitOpen(false);
      Alert.alert('Credit limit saved',
        v > 0 ? `${customer.customerName || 'This customer'} can owe up to ${money(v)}.`
              : 'No ceiling — entries will never be questioned.');
    } catch (e: any) { Alert.alert('Could not save', e?.message ?? 'Try again'); }
    finally { setBusy(false); }
  };

  const remind = async () => {
    setBusy(true);
    try {
      const res = await SB.sendReminder(customer.customerId);
      Alert.alert(res.sent ? 'Reminder sent' : 'Nothing to remind',
        res.sent ? 'A payment reminder was pushed to the customer.' : 'This customer has no pending balance.');
    } catch (e: any) { Alert.alert('Error', e?.message ?? 'Try again'); }
    finally { setBusy(false); }
  };

  const renderEntry = ({ item: e }: { item: SB.LedgerEntry }) => (
          <LedgerRow entry={e} currency={currency} onShare={busy ? undefined : () => shareDoc(e)} />
  );

  return (
    <>
      <SubHeader title={customer.customerName || 'Customer'} onBack={onBack} />
      {/* The khata history is the scroller — a regular customer accumulates
          years of lines — so the whole add-entry form rides above it as the
          header. An element, not a component function, or every input in that
          form remounts and the keyboard drops mid-word. */}
      <FlatList
        data={ledger?.entries ?? []}
        keyExtractor={(e) => e.id}
        renderItem={renderEntry}
        contentContainerStyle={s.body}
        keyboardShouldPersistTaps="handled"
        refreshControl={<RefreshControl refreshing={loading} onRefresh={load} tintColor={C.green} />}
        ListHeaderComponent={(
        <>
        {!!err && !loading && !ledger && <ErrorState title="Couldn’t load this khata" sub={err} onRetry={load} />}
        {ledger && (
          <View style={{ flexDirection: 'row', gap: 10 }}>
            <StatCard label="Pending" value={money(ledger.pending)} tone="danger" />
            <StatCard label="Paid" value={money(ledger.totalPaid)} tone="green" />
          </View>
        )}
        {(ledger?.pending ?? 0) > 0 && (
          <TouchableOpacity style={[s.outlineBtn, busy && { opacity: 0.6 }]} disabled={busy} onPress={remind}
            accessibilityRole="button" accessibilityState={{ disabled: busy }}>
            <Ionicons name="notifications-outline" size={18} color={C.green} />
            <Text style={s.outlineBtnText}>Send payment reminder</Text>
          </TouchableOpacity>
        )}

        {/* The ceiling this customer is held to. Shown before it can be
            changed: an owner setting a limit blind is how a regular gets
            refused at the counter. An older backend does not send the field at
            all, and that reads as unknown rather than as zero. */}
        {!limitOpen ? (
          <TouchableOpacity style={[s.outlineBtn, busy && { opacity: 0.6 }]} disabled={busy}
            accessibilityRole="button" accessibilityState={{ disabled: busy }}
            onPress={() => setLimitOpen(true)}>
            <Ionicons name="speedometer-outline" size={18} color={C.green} />
            <Text style={s.outlineBtnText}>
              {limit == null ? '  Credit limit'
                : limit > 0 ? `  Credit limit ${money(limit)}` : '  Credit limit — none set'}
            </Text>
          </TouchableOpacity>
        ) : (
          <View style={s.panel}>
            <Text style={s.panelTitle}>Credit limit</Text>
            <TextInput style={s.input} placeholder="0" placeholderTextColor={C.sub}
              accessibilityLabel={`Credit limit in ${currency || '₹'}, 0 for no limit`}
              keyboardType="numeric" value={limitText} onChangeText={setLimitText} autoFocus />
            <Text style={s.hint}>
              The most this customer may owe at once. 0 means no limit. Going
              past it does not block the entry — you are asked to confirm,
              because you know the customer and the app does not.
            </Text>
            <View style={{ flexDirection: 'row', gap: 8, marginTop: 8 }}>
              <TouchableOpacity style={[s.primaryBtn, { flex: 1 }, busy && { opacity: 0.6 }]}
                accessibilityRole="button" accessibilityState={{ disabled: busy }}
                disabled={busy} onPress={saveLimit}>
                <Text style={s.primaryBtnText}>Save limit</Text>
              </TouchableOpacity>
              <TouchableOpacity style={[s.outlineBtn, { flex: 1 }]} disabled={busy} accessibilityRole="button"
                onPress={() => { setLimitOpen(false); setLimitText(limit && limit > 0 ? String(limit) : ''); }}>
                <Text style={s.outlineBtnText}>Cancel</Text>
              </TouchableOpacity>
            </View>
          </View>
        )}
        <View style={s.panel}>
          <Text style={s.panelTitle}>Add entry</Text>

          {/* Products given on credit. Optional — a shopkeeper in a hurry still
              just types a number. When lines ARE given the amount stops being
              typeable: the server derives it from them, so an editable field
              here would show a total the saved entry disagrees with. */}
          {items.map((it, i) => (
            <View key={it.key} style={{ flexDirection: 'row', gap: 6, marginBottom: 8 }}>
              <TextInput style={[s.input, { flex: 3, marginBottom: 0 }]} placeholder="Product"
                accessibilityLabel={`Product ${i + 1}`}
                placeholderTextColor={C.sub} value={it.name}
                onChangeText={(v) => setItem(it.key, { name: v })} />
              <TextInput style={[s.input, { flex: 1, marginBottom: 0 }]} placeholder="Qty"
                accessibilityLabel={`Quantity of product ${i + 1}`}
                placeholderTextColor={C.sub} keyboardType="numeric" value={it.qty}
                onChangeText={(v) => setItem(it.key, { qty: v })} />
              {/* What ONE of the thing is: soap in pieces, rice in kg. The
                  column has always existed on shopbook_ledger_item and the
                  invoice already renders it; the form simply never asked, so
                  every khata line in production stored an empty unit. */}
              <TextInput style={[s.input, { flex: 1.2, marginBottom: 0 }]} placeholder="Unit"
                accessibilityLabel={`Unit of product ${i + 1}`}
                placeholderTextColor={C.sub} value={it.unit}
                onChangeText={(v) => setItem(it.key, { unit: v })} />
              <TextInput style={[s.input, { flex: 1.4, marginBottom: 0 }]} placeholder={`${currency || '₹'} each`}
                accessibilityLabel={`Price each of product ${i + 1}, in ${currency || '₹'}`}
                placeholderTextColor={C.sub} keyboardType="numeric" value={it.price}
                onChangeText={(v) => setItem(it.key, { price: v })} />
              <TouchableOpacity accessibilityRole="button" accessibilityLabel={`Remove product row ${i + 1}`}
                onPress={() => setItems(items.filter((x) => x.key !== it.key))}
                hitSlop={8} style={{ justifyContent: 'center' }}>
                <Ionicons name="close-circle" size={22} color={C.danger} />
              </TouchableOpacity>
            </View>
          ))}
          <TouchableOpacity style={{ flexDirection: 'row', alignItems: 'center', gap: 6, marginBottom: 10 }}
            accessibilityRole="button"
            onPress={() => setItems([...items, newDraftLine()])}>
            <Ionicons name="add-circle-outline" size={18} color={C.green} />
            <Text style={{ color: C.green, fontWeight: '700', fontSize: 13 }}>
              {items.length ? 'Add another product' : 'Add products & cost (optional)'}
            </Text>
          </TouchableOpacity>

          {items.length > 0 ? (
            <View style={[s.input, { justifyContent: 'center' }]}>
              <Text style={{ color: C.text, fontWeight: '700' }}>
                Total {money(itemsTotal)}
                <Text style={{ color: C.sub, fontWeight: '400' }}> · from {items.length} item{items.length > 1 ? 's' : ''}</Text>
              </Text>
            </View>
          ) : (
            <TextInput style={s.input} placeholder={`Amount (${currency || '₹'})`} placeholderTextColor={C.sub}
              accessibilityLabel={`Amount in ${currency || '₹'}`}
              keyboardType="numeric" value={amount} onChangeText={setAmount} />
          )}
          <TextInput style={s.input} placeholder="Reference / remark (UPI ref, cheque no…)"
            accessibilityLabel="Reference or remark"
            placeholderTextColor={C.sub} value={remark} onChangeText={setRemark} />
          {/* How the money arrived. Recorded on the payment, not guessed from
              the remark — reconciliation later depends on it. */}
          <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginBottom: 8 }}>
            {(['cash', 'upi', 'bank', 'card', 'other'] as SB.PaymentMethod[]).map((m) => (
              <Chip key={m} label={m.toUpperCase()} icon="cash-outline"
                active={method === m} onPress={() => setMethod(m)} />
            ))}
          </View>
          <View style={{ flexDirection: 'row', gap: 8 }}>
            <TouchableOpacity style={[s.primaryBtn, { flex: 1 }, busy && { opacity: 0.6 }]} disabled={busy} onPress={() => add('purchase')}
              accessibilityRole="button" accessibilityLabel="Add purchase" accessibilityState={{ disabled: busy }}>
              <Text style={s.primaryBtnText}>+ Purchase</Text>
            </TouchableOpacity>
            {/* Products describe goods going out, so they only belong on a
                purchase. Disabled rather than silently dropped — the amount
                field is hidden while lines exist, so a tap here would
                otherwise fail with a confusing "enter an amount". */}
            <TouchableOpacity style={[s.outlineBtn, { flex: 1 }, (busy || items.length > 0) && { opacity: 0.5 }]}
              accessibilityRole="button" accessibilityLabel="Add payment" accessibilityState={{ disabled: busy || items.length > 0 }}
              disabled={busy || items.length > 0} onPress={() => add('payment')}>
              <Text style={s.outlineBtnText}>+ Payment</Text>
            </TouchableOpacity>
          </View>
        </View>
        <Text style={s.sectionLabel}>History</Text>
        {ledger?.entries.length === 0 && <Empty icon="book-outline" text="No transactions yet." />}
        </>
        )}
      />
    </>
  );
}
