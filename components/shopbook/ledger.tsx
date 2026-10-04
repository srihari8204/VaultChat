// components/shopbook/ledger.tsx — Shop Book: khata (customer ledgers), counter sales
// (one customer's khata and its entries are in ./khataDetail).
// Split out of app/shop-book.tsx on 2026-10-04 and edited since (fixes are
// logged per round). Palette and styles come from ./theme.

import { useCallback, useState } from 'react';
import { View, Text, TextInput, TouchableOpacity, FlatList, Alert, RefreshControl } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import * as Print from 'expo-print';
import { formatMoney, normalizeUnit, isNum, num } from '../../utils/shopbook';
import * as SB from '../../services/shopBookService';
import { LoadingState, ErrorState } from '../finance/ui';
import { C, s } from './theme';
import { previewDoc, SubHeader, StatCard, TxnRow, LedgerRow, Empty, Banner } from './shared';
import { useShopLoad } from './useShopLoad';
import { KhataDetail, newDraftLine, type DraftLine } from './khataDetail';
import { userErrorText } from '../../lib/userErrorText';

export function CustomerLedgerView({ shop, onBack }: { shop: SB.Shop; onBack: () => void }) {
  const money = (n: number) => formatMoney(n, shop.currency || '₹');
  const [ledger, setLedger] = useState<SB.Ledger | null>(null);
  const fetchLedger = useCallback(() => SB.customerLedger(shop.id), [shop.id]);
  const { loading, err, load } = useShopLoad(fetchLedger, setLedger);

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
  const [customers, setCustomers] = useState<SB.CustomerPending[]>([]);
  const [sel, setSel] = useState<SB.CustomerPending | null>(null);
  // Adding a walk-in: someone with no crazzychat account who buys on credit.
  const [adding, setAdding] = useState(false);
  const [counter, setCounter] = useState(false);
  const [newName, setNewName] = useState('');
  const [newMobile, setNewMobile] = useState('');
  const [saving, setSaving] = useState(false);

  const { loading, err, load } = useShopLoad(SB.ownerLedgerSummary, setCustomers);

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
    } catch (e) {
      Alert.alert('Could not save', userErrorText(e, 'Try again'));
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
      // The bill is the point of the sale, so show it here rather than making
      // the owner hunt for the document afterwards — in the in-app viewer like
      // every other Shop Book document, which keeps Share and Open-with. (It
      // went straight to the share sheet, and on a device with no share target
      // it went nowhere.) A failed print must not read as a failed sale: the
      // document is already numbered and stored.
      onDone();
      try {
        const html = await SB.invoiceHtml(id);
        const { uri } = await Print.printToFileAsync({ html });
        previewDoc(uri, `bill-${id}.pdf`);
      } catch {
        Alert.alert('Sale recorded', 'The bill could not be shown, but the sale is saved.');
      }
    } catch (e) {
      Alert.alert('Could not record the sale', userErrorText(e, 'Try again'));
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
