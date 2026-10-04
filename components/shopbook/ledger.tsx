// components/shopbook/ledger.tsx — Shop Book, moved out of app/shop-book.tsx
// unchanged. Palette and styles come from ./theme; see app/shop-book.tsx.

import { useCallback, useEffect, useRef, useState } from 'react';
import { View, Text, TextInput, TouchableOpacity, FlatList, Alert, RefreshControl } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import * as Print from 'expo-print';
import * as Sharing from 'expo-sharing';
import { formatMoney, clientKey, normalizeUnit, isNum, isBlankOrNum, num } from '../../utils/shopbook';
import * as SB from '../../services/shopBookService';
import { LoadingState, ErrorState } from '../finance/ui';
import { C, s } from './theme';
import { previewDoc, loadErrText, SubHeader, Chip, StatCard, TxnRow, LedgerRow, Empty, Banner } from './shared';

export function CustomerLedgerView({ shop, onBack }: { shop: SB.Shop; onBack: () => void }) {
  const money = (n: number) => formatMoney(n, shop.currency || '₹');
  const [loading, setLoading] = useState(true);
  const [ledger, setLedger] = useState<SB.Ledger | null>(null);
  const [err, setErr] = useState('');
  const load = useCallback(async () => {
    setLoading(true); setErr('');
    try { setLedger(await SB.customerLedger(shop.id)); } catch (e: any) { setErr(loadErrText(e)); } finally { setLoading(false); }
  }, [shop.id]);
  useEffect(() => { load(); }, [load]);

  const renderEntry = ({ item: e }: { item: SB.LedgerEntry }) => <LedgerRow entry={e} currency={shop.currency} />;

  return (
    <>
      <SubHeader title={`Ledger · ${shop.name}`} onBack={onBack} />
      {/* A ledger only ever grows — years of a shop's purchases end up here —
          so the transactions are the scroller and the totals ride above them. */}
      <FlatList
        data={ledger?.entries ?? []}
        keyExtractor={(e) => e.id}
        renderItem={renderEntry}
        ListHeaderComponent={(
          <>
            {loading && <LoadingState />}
            {!!err && !loading && <ErrorState title="Couldn’t load the ledger" sub={err} onRetry={load} />}
            {ledger && (
              <>
                <View style={{ flexDirection: 'row', gap: 10 }}>
                  <StatCard label="Total Pending" value={money(ledger.pending)} tone="danger" />
                  <StatCard label="Total Paid" value={money(ledger.totalPaid)} tone="green" />
                </View>
                <Text style={s.sectionLabel}>Transactions</Text>
                {ledger.entries.length === 0 && <Empty icon="book-outline" text="No transactions yet." />}
              </>
            )}
          </>
        )}
        contentContainerStyle={s.body}
      />
    </>
  );
}

export function OwnerKhata({ currency }: { currency?: string }) {
  const money = (n: number) => formatMoney(n, currency || '₹');
  const [loading, setLoading] = useState(true);
  const [customers, setCustomers] = useState<SB.CustomerPending[]>([]);
  const [sel, setSel] = useState<SB.CustomerPending | null>(null);
  // Adding a walk-in: someone with no crazzychat account who buys on credit.
  const [adding, setAdding] = useState(false);
  const [counter, setCounter] = useState(false);
  const [newName, setNewName] = useState('');
  const [newMobile, setNewMobile] = useState('');
  const [saving, setSaving] = useState(false);

  const [err, setErr] = useState('');
  const load = useCallback(async () => {
    setLoading(true); setErr('');
    try { setCustomers(await SB.ownerLedgerSummary()); } catch (e: any) { setErr(loadErrText(e)); } finally { setLoading(false); }
  }, []);
  useEffect(() => { load(); }, [load]);

  if (sel) return <KhataDetail customer={sel} currency={currency} onBack={() => { setSel(null); load(); }} />;

  const saveCustomer = async () => {
    const name = newName.trim();
    if (!name) { Alert.alert('Name needed', 'Enter the customer name.'); return; }
    const mobile = newMobile.replace(/[^0-9+]/g, '');
    setSaving(true);
    try {
      const r = await SB.createKhataCustomer({ name, mobile });
      // ONE HOUSEHOLD, ONE KHATA. The server dedups on (shop, mobile), so a
      // wife or son buying on the family number lands on the SAME khata. Say so
      // plainly: an owner who thinks they created a second customer would go
      // looking for a duplicate that does not exist.
      if (r.duplicate) {
        Alert.alert('Existing khata', `${mobile} already has a khata at this shop. Opening it — new items will be added to the same account.`);
      }
      setAdding(false); setNewName(''); setNewMobile('');
      const list = await SB.ownerLedgerSummary();
      setCustomers(list);
      const found = list.find((c) => c.customerId === r.id);
      if (found) setSel(found);
    } catch (e: any) {
      Alert.alert('Could not save', e?.message ?? 'Try again');
    } finally { setSaving(false); }
  };

  const owed = customers.filter((c) => c.pending > 0);
  const owedTotal = owed.reduce((n, c) => n + c.pending, 0);
  // Sorted so stale[0] is the longest-quiet customer, which is the one named.
  const stale = owed.filter((c) => (c.staleDays ?? 0) > 30)
    .sort((a, b) => (b.staleDays ?? 0) - (a.staleDays ?? 0));

  // The customer list is the scroller: a shop's khata only ever gains names.
  // Everything above it becomes the header, kept as an element so the
  // add-customer inputs are reconciled in place instead of remounting.
  const header = (
    <>
      <Text style={s.sectionLabel}>Customer Khata</Text>

      {/* Walk-ins: the customer standing at the counter who has no crazzychat
          account. Without this the khata only ever listed people who already
          had one, so a shop could not start a tab for anybody new. */}
      {counter && <CounterSale currency={currency} onDone={() => setCounter(false)} />}
      {!adding && !counter ? (
        <View style={{ flexDirection: 'row', gap: 8 }}>
          <TouchableOpacity style={[s.outlineBtn, { flex: 1 }]} onPress={() => setAdding(true)} accessibilityRole="button" accessibilityLabel="Add customer">
            <Ionicons name="person-add-outline" size={16} color={C.green} />
            <Text style={s.outlineBtnText}>  Add customer</Text>
          </TouchableOpacity>
          {/* Cash sales belong beside the khata, not inside it: same counter,
              same moment, opposite meaning — one is owed, the other is not. */}
          <TouchableOpacity style={[s.outlineBtn, { flex: 1 }]} onPress={() => setCounter(true)} accessibilityRole="button" accessibilityLabel="Counter sale">
            <Ionicons name="cash-outline" size={16} color={C.green} />
            <Text style={s.outlineBtnText}>  Counter sale</Text>
          </TouchableOpacity>
        </View>
      ) : adding ? (
        <View style={s.panel}>
          <TextInput style={s.input} placeholder="Customer name" placeholderTextColor={C.sub}
            accessibilityLabel="Customer name" value={newName} onChangeText={setNewName} autoFocus />
          <TextInput style={s.input} placeholder="Mobile number (optional)" placeholderTextColor={C.sub}
            accessibilityLabel="Mobile number, optional" value={newMobile} onChangeText={setNewMobile} keyboardType="phone-pad" />
          <Text style={s.hint}>
            Family members who buy on the same mobile share one khata, so a wife
            or son taking goods adds to the same account instead of opening a new
            one. Leave the number blank to keep two same-name customers apart.
          </Text>
          <View style={{ flexDirection: 'row', gap: 8, marginTop: 8 }}>
            <TouchableOpacity style={[s.primaryBtn, { flex: 1 }, saving && { opacity: 0.6 }]}
              accessibilityRole="button" accessibilityLabel="Save customer" accessibilityState={{ disabled: saving, busy: saving }}
              disabled={saving} onPress={saveCustomer}>
              <Text style={s.primaryBtnText}>{saving ? 'Saving...' : 'Save customer'}</Text>
            </TouchableOpacity>
            <TouchableOpacity style={[s.outlineBtn, { flex: 1 }]} disabled={saving} accessibilityRole="button"
              onPress={() => { setAdding(false); setNewName(''); setNewMobile(''); }}>
              <Text style={s.outlineBtnText}>Cancel</Text>
            </TouchableOpacity>
          </View>
        </View>
      ) : null}
      {loading && <LoadingState />}
      {!!err && !loading && <ErrorState title="Couldn’t load the khata book" sub={err} onRetry={load} />}
      {!loading && !err && customers.length === 0 && <Empty icon="people-outline" text="No customer ledgers yet." />}

      {/* What the owner cannot see from a list sorted by amount: who has gone
          quiet. A ₹400 debt untouched for four months is a worse sign than a
          ₹4,000 one paid down last week. */}
      {owed.length > 0 && (
        <Banner
          tone="warn" icon="wallet-outline"
          text={`${owed.length} customer${owed.length > 1 ? 's owe' : ' owes'} you ${money(owedTotal)}`}
          sub={stale.length > 0
            ? `${stale.length} ${stale.length > 1 ? 'have' : 'has'} not paid in over 30 days — longest ${stale[0].staleDays} days.`
            : undefined}
        />
      )}

    </>
  );

  const renderCustomer = ({ item: c }: { item: SB.CustomerPending }) => (
        <TxnRow
          icon="person"
          iconTone={c.pending > 0 ? 'warn' : 'good'}
          title={c.customerName || 'Customer'}
          sub={c.mobile || undefined}
          // The balance moves to the money column, where it aligns with every
          // other figure on the screen instead of sitting inline under the name.
          amount={c.pending > 0 ? money(c.pending) : 'Settled'}
          amountTone={c.pending > 0 ? 'bad' : 'good'}
          amountNote={c.pending > 0 ? 'Pending' : undefined}
          onPress={() => setSel(c)}
          right={<Ionicons name="chevron-forward" size={20} color={C.sub} />}
        >
          {c.pending > 0 && (c.staleDays ?? 0) > 30 && (
            <Text style={s.staleWarn}>
              {c.lastPaymentAt ? `No payment in ${c.staleDays} days` : `Never paid — ${c.staleDays} days`}
            </Text>
          )}
        </TxnRow>
  );

  return (
    <FlatList
      data={customers}
      keyExtractor={(c) => c.customerId}
      renderItem={renderCustomer}
      ListHeaderComponent={header}
      contentContainerStyle={s.body}
      refreshControl={<RefreshControl refreshing={loading} onRefresh={load} tintColor={C.green} />}
    />
  );
}

/** One product row being typed into a counter sale or a khata entry. Held as
 *  strings: a half-typed "12." is not a number yet. */
export interface DraftLine { key: string; name: string; qty: string; price: string; unit: string }

export const newDraftLine = (): DraftLine => ({ key: clientKey(), name: '', qty: '1', price: '', unit: '' });

// ── counter sale ──────────────────────────────────────────────
//
// The cash customer at the counter: goods handed over, money taken, nothing
// owed. Shipped server-side 2026-08-18 as one of migration 110's four document
// sources and never had a screen, so the only way a shop could paper a cash
// sale was to open a khata for someone who owes nothing — which then pollutes
// the pending list and the reminder job.
//
// Deliberately NOT a ledger entry: no identity is created and no balance
// exists. The name and phone go on the DOCUMENT only, because that is all a
// stranger's details are for.
export function CounterSale({ currency, onDone }: { currency?: string; onDone: () => void }) {
  const money = (n: number) => formatMoney(n, currency || '₹');
  const [name, setName] = useState('');
  const [phone, setPhone] = useState('');
  // Rows carry a client key: keyed by index, removing a middle row handed its
  // neighbour's half-typed inputs to the wrong React instance.
  const [items, setItems] = useState<DraftLine[]>(() => [newDraftLine()]);
  const [busy, setBusy] = useState(false);
  const setItem = (key: string, patch: Partial<DraftLine>) =>
    setItems((prev) => prev.map((it) => (it.key === key ? { ...it, ...patch } : it)));
  const total = items.reduce((n, it) => n + num(it.qty) * num(it.price), 0);

  const sell = async () => {
    const filled = items.filter((it) => it.name.trim() || it.price.trim());
    if (!filled.length) { Alert.alert('Nothing to sell', 'Add at least one product.'); return; }
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
    setBusy(true);
    try {
      const { id } = await SB.counterSale(name.trim(), phone.trim(), filled.map((it) => ({
        name: it.name.trim(), brand: '', unit: normalizeUnit(it.unit),
        qty: num(it.qty), price: num(it.price), taxPercent: 0,
      })));
      // The bill is the point of the sale, so print it here rather than making
      // the owner hunt for the document afterwards. A failed share must not
      // read as a failed sale — the document is already numbered and stored.
      try {
        const html = await SB.invoiceHtml(id);
        const { uri } = await Print.printToFileAsync({ html });
        if (await Sharing.isAvailableAsync()) {
          await Sharing.shareAsync(uri, { mimeType: 'application/pdf', dialogTitle: 'Bill' });
        }
      } catch {
        Alert.alert('Sale recorded', 'The bill could not be shared, but the sale is saved.');
      }
      // ponytail: this one still goes straight to the share sheet rather than
      // previewDoc(). onDone() closes the panel on the next line, so pushing a
      // viewer here would race that navigation. Move it over when this flow is
      // next opened — the bill stays re-openable from the khata list meanwhile.
      onDone();
    } catch (e: any) {
      Alert.alert('Could not record the sale', e?.message ?? 'Try again');
    } finally { setBusy(false); }
  };

  return (
    <View style={s.panel}>
      <Text style={s.panelTitle}>Counter sale</Text>
      <Text style={s.hint}>
        Cash over the counter. Nothing is owed afterwards, so this creates no
        customer and no khata — just the bill.
      </Text>
      <TextInput style={s.input} placeholder="Customer name (optional)" placeholderTextColor={C.sub}
        accessibilityLabel="Customer name, optional" value={name} onChangeText={setName} />
      <TextInput style={s.input} placeholder="Phone (optional)" placeholderTextColor={C.sub}
        accessibilityLabel="Phone, optional" value={phone} onChangeText={setPhone} keyboardType="phone-pad" />
      {items.map((it, i) => (
        <View key={it.key} style={{ flexDirection: 'row', gap: 6, marginBottom: 8 }}>
          <TextInput style={[s.input, { flex: 3, marginBottom: 0 }]} placeholder="Product"
            accessibilityLabel={`Product ${i + 1}`}
            placeholderTextColor={C.sub} value={it.name} onChangeText={(v) => setItem(it.key, { name: v })} />
          <TextInput style={[s.input, { flex: 1, marginBottom: 0 }]} placeholder="Qty"
            accessibilityLabel={`Quantity of product ${i + 1}`}
            placeholderTextColor={C.sub} keyboardType="numeric" value={it.qty}
            onChangeText={(v) => setItem(it.key, { qty: v })} />
          <TextInput style={[s.input, { flex: 1.2, marginBottom: 0 }]} placeholder="Unit"
            accessibilityLabel={`Unit of product ${i + 1}`}
            placeholderTextColor={C.sub} value={it.unit} onChangeText={(v) => setItem(it.key, { unit: v })} />
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
        <Text style={{ color: C.green, fontWeight: '700', fontSize: 13 }}>Add another product</Text>
      </TouchableOpacity>
      <Text style={s.price}>Total {money(total)}</Text>
      <View style={{ flexDirection: 'row', gap: 8, marginTop: 8 }}>
        <TouchableOpacity style={[s.primaryBtn, { flex: 1 }, busy && { opacity: 0.6 }]}
          accessibilityRole="button" accessibilityState={{ disabled: busy, busy }}
          disabled={busy} onPress={sell}>
          <Text style={s.primaryBtnText}>{busy ? 'Saving...' : 'Sell & print bill'}</Text>
        </TouchableOpacity>
        <TouchableOpacity style={[s.outlineBtn, { flex: 1 }]} disabled={busy} onPress={onDone} accessibilityRole="button">
          <Text style={s.outlineBtnText}>Cancel</Text>
        </TouchableOpacity>
      </View>
    </View>
  );
}

export function KhataDetail({ customer, currency, onBack }: { customer: SB.CustomerPending; currency?: string; onBack: () => void }) {
  const money = (n: number) => formatMoney(n, currency || '₹');
  const [loading, setLoading] = useState(true);
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

  const [err, setErr] = useState('');
  const load = useCallback(async () => {
    setLoading(true); setErr('');
    try { setLedger(await SB.ownerCustomerLedger(customer.customerId, !!customer.isKhata)); }
    catch (e: any) { setErr(loadErrText(e)); } finally { setLoading(false); }
  }, [customer.customerId, customer.isKhata]);
  useEffect(() => { load(); }, [load]);

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
