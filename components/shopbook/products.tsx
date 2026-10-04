// components/shopbook/products.tsx — Shop Book: products, coupons, suppliers, purchases, stock and bulk add.
// Split out of app/shop-book.tsx on 2026-10-04 and edited since (fixes are
// logged per round). Palette and styles come from ./theme.

import { useCallback, useMemo, useRef, useState } from 'react';
import { KeyboardSafe } from '../ui';
import { View, Text, TextInput, TouchableOpacity, ScrollView, FlatList, Alert, ActivityIndicator, RefreshControl } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { categoryLabel } from '../../constants/shopCategories';
import { formatMoney, clientKey, couponLabel, parseBulkProducts, skippedBulkLines, UNIT_PRESETS, isNum, isBlankOrNonNegative, num } from '../../utils/shopbook';
import * as SB from '../../services/shopBookService';
import { LoadingState, ErrorState } from '../finance/ui';
import { t } from '../../lib/shopbookI18n';
import { C, s } from './theme';
import { loadErrText, Row, SubHeader, Chip, StatCard, Field, ToggleRow, Empty } from './shared';
import { useShopLoad } from './useShopLoad';

// Purchases needs the catalog too (the "add an item" chips), so both are read
// in one load and fail or succeed together, as before.
const fetchPurchasesAndProducts = () => Promise.all([SB.purchases(), SB.ownerProducts()]);

export function OwnerCoupons({ currency, onBack }: { currency?: string; onBack: () => void }) {
  const [coupons, setCoupons] = useState<SB.Coupon[]>([]);
  const [code, setCode] = useState('');
  const [kind, setKind] = useState<'percent' | 'flat'>('percent');
  const [value, setValue] = useState('');
  const [minOrder, setMinOrder] = useState('');
  const [busy, setBusy] = useState(false);

  const { loading, err, load } = useShopLoad(SB.ownerCoupons, setCoupons);

  const cur = currency || '₹';
  const add = async () => {
    if (!code.trim() || num(value) <= 0) { Alert.alert('Enter code and value'); return; }
    // Garbage in the value box is num()'s 0 and already refused above; this is
    // the other end. 150% off is not a discount, it is paying the customer.
    if (!isNum(value) || (kind === 'percent' && num(value) > 100)) {
      Alert.alert('Check the discount', kind === 'percent'
        ? 'A percentage discount must be between 1 and 100.'
        : `"${value.trim()}" is not a plain number. Use digits only — 1200 or 1,200 both work.`);
      return;
    }
    // `value` is caught by the `<= 0` above; minOrder has no range guard to
    // fall into (2026-09-17). num() turns an unparseable "₹1,2" into 0, and a
    // 0 minimum is not a rejection — it is a coupon that applies to EVERY
    // order, including the ₹20 ones it was written to exclude. Blank still
    // means no minimum.
    if (!isBlankOrNonNegative(minOrder)) {
      Alert.alert('Check the minimum order',
        `"${minOrder}" is not a plain number. Use digits only — 1200 or 1,200 both work — or leave it empty for no minimum.`);
      return;
    }
    setBusy(true);
    try {
      await SB.saveCoupon({ code: code.trim(), kind, value: num(value), minOrder: num(minOrder), active: true });
      setCode(''); setValue(''); setMinOrder(''); load();
    } catch (e: any) { Alert.alert('Error', e?.message ?? 'Try again'); }
    finally { setBusy(false); }
  };

  const remove = async (id?: string) => {
    if (!id) return;
    try { await SB.deleteCoupon(id); load(); }
    catch (e: any) { Alert.alert('Could not delete the coupon', e?.message ?? 'Try again'); }
  };

  return (
    <>
      <SubHeader title="Offers & Coupons" onBack={onBack} />
      <ScrollView contentContainerStyle={s.body} keyboardShouldPersistTaps="handled"
        refreshControl={<RefreshControl refreshing={loading} onRefresh={load} tintColor={C.green} />}>
        <View style={s.panel}>
          <Text style={s.panelTitle}>New coupon</Text>
          <TextInput style={s.input} placeholder="Code (e.g. SAVE10)" placeholderTextColor={C.sub}
            accessibilityLabel="Coupon code" autoCapitalize="characters" value={code} onChangeText={setCode} />
          <View style={{ flexDirection: 'row', gap: 8, marginBottom: 8 }} accessibilityRole="radiogroup" accessibilityLabel="Discount type">
            <TouchableOpacity style={[s.statusBtn, kind === 'percent' && s.statusBtnActive]} onPress={() => setKind('percent')}
              accessibilityRole="radio" accessibilityState={{ checked: kind === 'percent' }}>
              <Text style={[s.statusBtnText, kind === 'percent' && { color: C.onFill }]}>% Percent</Text>
            </TouchableOpacity>
            <TouchableOpacity style={[s.statusBtn, kind === 'flat' && s.statusBtnActive]} onPress={() => setKind('flat')}
              accessibilityRole="radio" accessibilityState={{ checked: kind === 'flat' }}>
              <Text style={[s.statusBtnText, kind === 'flat' && { color: C.onFill }]}>{cur} Flat</Text>
            </TouchableOpacity>
          </View>
          <View style={{ flexDirection: 'row', gap: 8 }}>
            <TextInput style={[s.input, { flex: 1 }]} placeholder={kind === 'percent' ? 'Percent off' : `${cur} off`}
              accessibilityLabel={kind === 'percent' ? 'Percent off' : `Amount off, in ${cur}`}
              placeholderTextColor={C.sub} keyboardType="numeric" value={value} onChangeText={setValue} />
            <TextInput style={[s.input, { flex: 1 }]} placeholder={`Min order ${cur}`} placeholderTextColor={C.sub}
              accessibilityLabel={`Minimum order, in ${cur}`}
              keyboardType="numeric" value={minOrder} onChangeText={setMinOrder} />
          </View>
          <TouchableOpacity style={[s.primaryBtn, busy && { opacity: 0.6 }]} disabled={busy} onPress={add}
            accessibilityRole="button" accessibilityState={{ disabled: busy }}>
            <Text style={s.primaryBtnText}>Add Coupon</Text>
          </TouchableOpacity>
        </View>

        <Text style={s.sectionLabel}>Active coupons</Text>
        {loading && <LoadingState />}
        {!!err && !loading && <ErrorState title="Couldn’t load your coupons" sub={err} onRetry={load} />}
        {!loading && !err && coupons.length === 0 && <Empty icon="pricetag-outline" text="No coupons yet." />}
        {coupons.map((c2) => (
          <View key={c2.id} style={s.card}>
            <View style={s.couponCode}><Text style={s.couponCodeText}>{c2.code}</Text></View>
            <View style={{ flex: 1 }}>
              <Text style={s.cardTitle}>{couponLabel(c2, cur)}</Text>
              <Text style={s.cardSub}>{c2.active ? 'Active' : 'Inactive'}</Text>
            </View>
            <TouchableOpacity accessibilityRole="button" accessibilityLabel={`Delete the coupon ${c2.code}`} onPress={() => Alert.alert('Delete coupon?', `Delete coupon ${c2.code}? Customers can no longer use it. This cannot be undone.`, [{ text: 'Cancel', style: 'cancel' }, { text: 'Delete', style: 'destructive', onPress: () => remove(c2.id) }])} hitSlop={8} style={{ padding: 4 }}>
              <Ionicons name="trash-outline" size={20} color={C.danger} />
            </TouchableOpacity>
          </View>
        ))}
      </ScrollView>
    </>
  );
}

export function OwnerSuppliers({ onBack }: { onBack: () => void }) {
  const [suppliers, setSuppliers] = useState<SB.Supplier[]>([]);
  const [name, setName] = useState('');
  const [phone, setPhone] = useState('');
  const [items, setItems] = useState('');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);

  const { loading, err, load } = useShopLoad(SB.suppliers, setSuppliers);

  const add = async () => {
    if (!name.trim()) { Alert.alert('Enter supplier name'); return; }
    setBusy(true);
    try {
      await SB.saveSupplier({ name: name.trim(), phone: phone.trim(), items: items.trim(), note: note.trim() });
      setName(''); setPhone(''); setItems(''); setNote(''); load();
    } catch (e: any) { Alert.alert('Error', e?.message ?? 'Try again'); }
    finally { setBusy(false); }
  };

  const remove = async (id?: string) => {
    if (!id) return;
    try { await SB.deleteSupplier(id); load(); }
    catch (e: any) { Alert.alert('Could not delete the supplier', e?.message ?? 'Try again'); }
  };

  return (
    <>
      <SubHeader title="Suppliers" onBack={onBack} />
      <ScrollView contentContainerStyle={s.body} keyboardShouldPersistTaps="handled"
        refreshControl={<RefreshControl refreshing={loading} onRefresh={load} tintColor={C.green} />}>
        <View style={s.panel}>
          <Text style={s.panelTitle}>New supplier</Text>
          <TextInput style={s.input} placeholder="Supplier / vendor name" placeholderTextColor={C.sub}
            accessibilityLabel="Supplier name" value={name} onChangeText={setName} />
          <TextInput style={s.input} placeholder="Phone" placeholderTextColor={C.sub}
            accessibilityLabel="Supplier phone" keyboardType="phone-pad" value={phone} onChangeText={setPhone} />
          <TextInput style={s.input} placeholder="Items supplied (e.g. Atta, Rice, Oil)" placeholderTextColor={C.sub}
            accessibilityLabel="Items supplied" value={items} onChangeText={setItems} />
          <TextInput style={s.input} placeholder="Note (optional)" placeholderTextColor={C.sub}
            accessibilityLabel="Note, optional" value={note} onChangeText={setNote} />
          <TouchableOpacity style={[s.primaryBtn, busy && { opacity: 0.6 }]} disabled={busy} onPress={add}
            accessibilityRole="button" accessibilityState={{ disabled: busy }}>
            <Text style={s.primaryBtnText}>Add Supplier</Text>
          </TouchableOpacity>
        </View>

        <Text style={s.sectionLabel}>My suppliers</Text>
        {loading && <LoadingState />}
        {!!err && !loading && <ErrorState title="Couldn’t load your suppliers" sub={err} onRetry={load} />}
        {!loading && !err && suppliers.length === 0 && <Empty icon="cube-outline" text="No suppliers yet." />}
        {suppliers.map((sup) => (
          <View key={sup.id} style={s.card}>
            <View style={s.shopIcon}><Ionicons name="cube" size={20} color={C.green} /></View>
            <View style={{ flex: 1 }}>
              <Text numberOfLines={1} style={s.cardTitle}>{sup.name}</Text>
              {!!sup.phone && <Text style={s.cardSub}>📞 {sup.phone}</Text>}
              {!!sup.items && <Text style={s.cardSub}>{sup.items}</Text>}
            </View>
            <TouchableOpacity accessibilityRole="button" accessibilityLabel={`Delete the supplier ${sup.name}`} onPress={() => Alert.alert('Delete supplier?', `Delete ${sup.name}? Deliveries already recorded against them stay, but the supplier is gone. This cannot be undone.`, [{ text: 'Cancel', style: 'cancel' }, { text: 'Delete', style: 'destructive', onPress: () => remove(sup.id) }])} hitSlop={8} style={{ padding: 4 }}>
              <Ionicons name="trash-outline" size={20} color={C.danger} />
            </TouchableOpacity>
          </View>
        ))}
      </ScrollView>
    </>
  );
}

export function OwnerProducts({ shop }: { shop: SB.Shop }) {
  const [products, setProducts] = useState<SB.Product[]>([]);
  const [edit, setEdit] = useState<SB.Product | 'new' | 'bulk' | 'stock' | null>(null);
  const [seeding, setSeeding] = useState(false);

  const { loading, err, load } = useShopLoad(SB.ownerProducts, setProducts);

  // One-tap category starter catalog (server-managed; spec: product-catalog).
  // Items land with price 0 + disabled — the owner prices and activates them.
  const seedStarter = async () => {
    // The de-duplication below compares against the loaded catalog; with no
    // catalog loaded every starter item would be added a second time.
    if (err) { Alert.alert(t('owner.starterCatalog'), 'Your catalog could not be loaded. Try again first.'); return; }
    setSeeding(true);
    try {
      const items = await SB.starterCatalog(shop.category);
      const have = new Set(products.map((p) => p.name.toLowerCase()));
      const fresh = items.filter((it) => !have.has(it.name.toLowerCase()));
      if (fresh.length === 0) { Alert.alert(t('owner.starterCatalog'), 'Your catalog already has these items.'); return; }
      await SB.bulkAddProducts(fresh.map((it) => ({ name: it.name, unit: it.unit, price: 0 })));
      Alert.alert(t('owner.starterCatalog'), t('owner.starterLoaded'));
      load();
    } catch (e: any) { Alert.alert('Error', e?.message ?? 'Try again'); }
    finally { setSeeding(false); }
  };

  // A catalog grows without limit, so it is the scroller and the buttons above
  // it become the list header. Declared before the early returns below so the
  // hook order does not change with which editor is open.
  const renderProduct = useCallback(({ item: p }: { item: SB.Product }) => (
        <TouchableOpacity style={s.card} onPress={() => setEdit(p)} accessibilityRole="button"
          accessibilityLabel={`Edit ${p.name}, ${formatMoney(p.price, shop.currency)}, ${p.inStock ? 'in stock' : 'out of stock'}${!p.enabled ? ', disabled' : ''}`}>
          <View style={{ flex: 1 }}>
            <Text style={[s.cardTitle, !p.enabled && { color: C.sub }]}>{p.name}{p.unit ? ` · ${p.unit}` : ''}</Text>
            <Text style={s.cardSub}>{[p.brand, p.category].filter(Boolean).join(' · ')}</Text>
            <Text style={s.price}>{formatMoney(p.price, shop.currency)} · {p.inStock ? 'In stock' : 'Out of stock'}{!p.enabled ? ' · Disabled' : ''}</Text>
          </View>
          <Ionicons name="create-outline" size={20} color={C.sub} />
        </TouchableOpacity>
  ), [shop.currency]);

  if (edit === 'bulk') return <BulkAdd currency={shop.currency} onDone={() => { setEdit(null); load(); }} />;
  if (edit === 'stock') return <StockScreen currency={shop.currency} onBack={() => { setEdit(null); load(); }} />;
  if (edit) return <ProductEditor product={edit === 'new' ? null : edit} currency={shop.currency} onDone={() => { setEdit(null); load(); }} />;

  const header = (
    <>
      <View style={{ flexDirection: 'row', gap: 8 }}>
        <TouchableOpacity style={[s.primaryBtn, { flex: 1, marginTop: 0 }]} onPress={() => setEdit('new')} accessibilityRole="button">
          <Ionicons name="add" size={18} color={C.onFill} />
          <Text style={s.primaryBtnText}>Add Product</Text>
        </TouchableOpacity>
        <TouchableOpacity style={[s.outlineBtn, { flex: 1, marginTop: 0 }]} onPress={() => setEdit('bulk')} accessibilityRole="button">
          <Ionicons name="documents-outline" size={18} color={C.green} />
          <Text style={s.outlineBtnText}>Bulk add</Text>
        </TouchableOpacity>
      </View>
      <TouchableOpacity style={[s.outlineBtn, seeding && { opacity: 0.6 }]} disabled={seeding} onPress={seedStarter}
        accessibilityRole="button" accessibilityState={{ disabled: seeding, busy: seeding }}>
        {seeding ? <ActivityIndicator color={C.green} /> : <Ionicons name="sparkles-outline" size={18} color={C.green} />}
        <Text style={s.outlineBtnText}>{t('owner.starterCatalog')} · {categoryLabel(shop.category)}</Text>
      </TouchableOpacity>
      {products.some((p) => p.trackStock) && (
        <TouchableOpacity style={s.outlineBtn} onPress={() => setEdit('stock')} accessibilityRole="button">
          <Ionicons name="cube-outline" size={18} color={C.green} />
          <Text style={s.outlineBtnText}>Stock</Text>
        </TouchableOpacity>
      )}
      {loading && <LoadingState />}
      {!!err && !loading && <ErrorState title="Couldn’t load your products" sub={err} onRetry={load} />}
      {!loading && !err && products.length === 0 && <Empty icon="pricetags-outline" text="No products yet." />}
    </>
  );

  return (
    <FlatList
      data={products}
      keyExtractor={(p) => p.id}
      renderItem={renderProduct}
      ListHeaderComponent={header}
      contentContainerStyle={s.body}
      refreshControl={<RefreshControl refreshing={loading} onRefresh={load} tintColor={C.green} />}
    />
  );
}

export function ProductEditor({ product, currency, onDone }: {
  product: SB.Product | null; currency?: string; onDone: () => void;
}) {
  const [name, setName] = useState(product?.name ?? '');
  const [brand, setBrand] = useState(product?.brand ?? '');
  const [category, setCategory] = useState(product?.category ?? '');
  const [unit, setUnit] = useState(product?.unit ?? '');
  const [price, setPrice] = useState(product ? String(product.price) : '');
  const [taxPercent, setTaxPercent] = useState(product && product.taxPercent > 0 ? String(product.taxPercent) : '');
  const [inStock, setInStock] = useState(product?.inStock ?? true);
  const [enabled, setEnabled] = useState(product?.enabled ?? true);
  // P0-B: counted stock is opt-in per product and Pro-gated server-side.
  const [trackStock, setTrackStock] = useState(product?.trackStock ?? false);
  const [costPrice, setCostPrice] = useState(product?.costPrice ? String(product.costPrice) : '');
  const [reorderLevel, setReorderLevel] = useState(product?.reorderLevel ? String(product.reorderLevel) : '');
  const [busy, setBusy] = useState(false);

  const save = async () => {
    if (!name.trim()) { Alert.alert('Name required'); return; }
    // isNum, not just num (2026-09-17). Nothing here has a range guard to fall
    // into, and num() coerces anything unparseable to 0 — so a pasted "₹285"
    // saved the CATALOG price as 0, and the server re-prices every future order
    // from productId. One bad paste makes the item free forever, on orders
    // nobody has placed yet. Blank still means 0 (a tax-free product leaves tax
    // blank, an untracked one leaves cost and reorder blank); garbage never does.
    //
    // WHAT THIS GATE DOES NOT DO: catch a price of 0 (2026-09-17). The helper
    // is non-negative, not positive — a typed "0" passes, exactly as a blank
    // price already did before any of this. That is left alone deliberately:
    // blank price is an accepted flow here (only the name is required, so a
    // catalog can be typed names-first and priced later), and rejecting 0 while
    // blank still saves 0 would be theatre. Pricing a product at literally zero
    // stays the owner's call; the paste that turns ₹285 into 0 is what is
    // refused.
    const bad = ([['Price', price], ['Tax %', taxPercent],
                  ['Cost price', costPrice], ['Reorder level', reorderLevel]] as const)
      .find(([, v]) => !isBlankOrNonNegative(v));
    if (bad) {
      Alert.alert('Check the numbers',
        `${bad[0]}: "${bad[1]}" is not a plain number. Use digits only — 1200 or 1,200 both work.`);
      return;
    }
    // A tax rate is a percentage of the price. Over 100 is a typo (an extra
    // zero), and it would be printed on every invoice for this product.
    if (num(taxPercent) > 100) {
      Alert.alert('Check the tax rate', 'Tax % must be between 0 and 100.');
      return;
    }
    setBusy(true);
    try {
      await SB.saveProduct({
        id: product?.id, name: name.trim(), brand: brand.trim(), category: category.trim(),
        unit: unit.trim(), price: num(price), taxPercent: num(taxPercent), inStock, enabled,
        trackStock, costPrice: num(costPrice), reorderLevel: num(reorderLevel),
      });
      onDone();
    } catch (e: any) { Alert.alert('Error', e?.message ?? 'Try again'); }
    finally { setBusy(false); }
  };

  const del = () => {
    if (!product) return;
    Alert.alert('Delete product?', `${product.name} will be removed from your catalog.`, [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Delete', style: 'destructive', onPress: async () => {
        setBusy(true);
        try { await SB.deleteProduct(product.id); onDone(); }
        catch (e: any) { Alert.alert('Error', e?.message ?? 'Try again'); }
        finally { setBusy(false); }
      } },
    ]);
  };

  return (
    <>
      <SubHeader title={product ? 'Edit Product' : 'Add Product'} onBack={onDone} />
      <ScrollView contentContainerStyle={s.body} keyboardShouldPersistTaps="handled">
        <Field label="Product name" value={name} onChange={setName} placeholder="Aashirvaad Atta" />
        <Field label="Brand (optional)" value={brand} onChange={setBrand} placeholder="Aashirvaad" />
        <Field label="Category" value={category} onChange={setCategory} placeholder="Groceries" />
        {/* Same vocabulary the customer's order line and the khata line offer,
            so one shop cannot end up with kg / Kg / KG as three units. The
            Field below still accepts anything, including a pack like "5kg". */}
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6, marginBottom: 6 }}>
          {UNIT_PRESETS.map((u) => (
            <Chip key={u} label={u} icon="" active={unit === u}
              onPress={() => setUnit(unit === u ? '' : u)} />
          ))}
        </View>
        <Field label="Unit" value={unit} onChange={setUnit} placeholder="5kg" />
        <Field label={`Price (${currency || '₹'})`} value={price} onChange={setPrice} placeholder="285" keyboardType="numeric" />
        <Field label="Tax % (optional)" value={taxPercent} onChange={setTaxPercent} placeholder="5" keyboardType="numeric" />
        <Field label={`Cost price (${currency || '₹'}, optional)`} value={costPrice} onChange={setCostPrice}
          placeholder="240" keyboardType="numeric" />
        <ToggleRow label="Count stock for this product" value={trackStock} onChange={setTrackStock} />
        {trackStock ? (
          <>
            <Text style={s.hint}>
              Stock is counted, reserved when you accept an order, and consumed when the
              customer collects. Record what you have on the Stock tab.
            </Text>
            <Field label="Reorder level (alert below this)" value={reorderLevel} onChange={setReorderLevel}
              placeholder="5" keyboardType="numeric" />
          </>
        ) : (
          <ToggleRow label="In stock" value={inStock} onChange={setInStock} />
        )}
        <ToggleRow label="Enabled (visible to customers)" value={enabled} onChange={setEnabled} />
        <TouchableOpacity style={[s.primaryBtn, busy && { opacity: 0.6 }]} disabled={busy} onPress={save}
          accessibilityRole="button" accessibilityState={{ disabled: busy }}>
          <Text style={s.primaryBtnText}>{product ? 'Save Changes' : 'Add Product'}</Text>
        </TouchableOpacity>
        {product && (
          <TouchableOpacity style={s.dangerBtn} disabled={busy} onPress={del} accessibilityRole="button">
            <Text style={s.dangerBtnText}>Delete Product</Text>
          </TouchableOpacity>
        )}
      </ScrollView>
    </>
  );
}

// Purchases (P1-A). Stock arriving with a price on it — the other half of a
// sale, and the only thing that makes margin computable.
export function PurchasesScreen({ currency, onBack }: { currency?: string; onBack: () => void }) {
  const [rows, setRows] = useState<SB.PurchaseSummary[]>([]);
  const [spend, setSpend] = useState(0);
  const [adding, setAdding] = useState(false);
  const [supplier, setSupplier] = useState('');
  const [invNo, setInvNo] = useState('');
  // Each draft line carries a client key so removing one from the middle never
  // re-keys the rest (it was keyed by index). The key is not sent.
  const [items, setItems] = useState<(SB.PurchaseItemInput & { key: string })[]>([]);
  const [products, setProducts] = useState<SB.Product[]>([]);
  const [pick, setPick] = useState<SB.Product | null>(null);
  const [qty, setQty] = useState('');
  const [cost, setCost] = useState('');
  const [busy, setBusy] = useState(false);
  const key = useRef(clientKey());

  const { loading, err, load } = useShopLoad(fetchPurchasesAndProducts, ([r, list]) => {
    setRows(r.purchases); setSpend(r.totalSpend); setProducts(list);
  });

  const money = (n: number) => formatMoney(n, currency);

  // Purchase history is append-only, so the rows are the scroller. Declared
  // ahead of the "record a purchase" early return to keep the hook order fixed.
  const renderPurchase = useCallback(({ item: p }: { item: SB.PurchaseSummary }) => (
          <View style={s.card}>
            <View style={{ flex: 1 }}>
              <Text style={s.cardTitle}>{p.supplierName || 'Supplier'}</Text>
              <Text style={s.cardSub}>
                {p.purchasedOn}{p.invoiceNumber ? ` · ${p.invoiceNumber}` : ''} · {p.itemCount} item(s)
              </Text>
            </View>
            <Text style={s.price}>{formatMoney(p.total, currency)}</Text>
          </View>
  ), [currency]);

  const addLine = () => {
    if (!pick || num(qty) <= 0) { Alert.alert('Pick a product and a quantity'); return; }
    // Same gates as every other money write (2026-09-17 class): num() turns
    // "12,5" or "₹200" into a believable 0, which here would record stock
    // that cost nothing and inflate every margin computed from it.
    if (!isNum(qty)) {
      Alert.alert('Check the quantity', `"${qty.trim()}" is not a plain number. Use digits only — 1200 or 1,200 both work.`);
      return;
    }
    if (!isBlankOrNonNegative(cost)) {
      Alert.alert('Check the cost',
        `"${cost.trim()}" is not a cost. Use digits only — 1200 or 1,200 both work — and it cannot be negative.`);
      return;
    }
    setItems([...items, {
      key: clientKey(),
      productId: pick.id, name: pick.name, unit: pick.unit,
      qty: num(qty), costPrice: num(cost), taxPercent: pick.taxPercent,
    }]);
    setPick(null); setQty(''); setCost('');
  };

  const save = async () => {
    if (items.length === 0) { Alert.alert('Add at least one item'); return; }
    setBusy(true);
    try {
      await SB.createPurchase({
        supplierName: supplier.trim(), invoiceNumber: invNo.trim(),
        items: items.map(({ key: _key, ...it }) => it), idempotencyKey: key.current,
      });
      key.current = clientKey();
      setAdding(false); setSupplier(''); setInvNo(''); setItems([]);
      load();
    } catch (e: any) {
      // The server refuses the same supplier invoice twice — that double-count
      // is the classic mistake when moving off paper.
      Alert.alert(e?.body?.code === 'duplicate_supplier_invoice'
        ? 'Already recorded' : 'Could not save', e?.message ?? 'Try again');
    } finally { setBusy(false); }
  };

  if (adding) {
    const draftTotal = items.reduce((s, it) => s + it.qty * it.costPrice, 0);
    return (
      <>
        <SubHeader title="Record a purchase" onBack={() => setAdding(false)} />
        <ScrollView contentContainerStyle={s.body} keyboardShouldPersistTaps="handled">
          <Field label="Supplier" value={supplier} onChange={setSupplier} placeholder="Metro Wholesale" />
          <Field label="Their invoice number" value={invNo} onChange={setInvNo} placeholder="MW-8891" />
          <Text style={s.hint}>
            The invoice number stops the same delivery being entered twice.
          </Text>

          <Text style={s.sectionLabel}>Items</Text>
          {items.map((it) => (
            <View key={it.key} style={s.card}>
              <View style={{ flex: 1 }}>
                <Text style={s.cardTitle}>{it.name}{it.unit ? ` · ${it.unit}` : ''}</Text>
                <Text style={s.cardSub}>{it.qty} × {money(it.costPrice)}</Text>
              </View>
              <TouchableOpacity accessibilityRole="button" accessibilityLabel={`Remove ${it.name} from this delivery`}
                hitSlop={12} onPress={() => setItems(items.filter((x) => x.key !== it.key))}>
                <Ionicons name="trash-outline" size={18} color={C.danger} />
              </TouchableOpacity>
            </View>
          ))}

          <View style={s.panel}>
            <Text style={s.panelTitle}>Add an item</Text>
            <ScrollView horizontal showsHorizontalScrollIndicator={false} style={{ marginBottom: 8 }}>
              <View style={{ flexDirection: 'row', gap: 8 }}>
                {products.map((p) => (
                  <Chip key={p.id} label={p.name} icon="cube-outline"
                    active={pick?.id === p.id} onPress={() => setPick(p)} />
                ))}
              </View>
            </ScrollView>
            <View style={{ flexDirection: 'row', gap: 8 }}>
              <View style={{ flex: 1 }}>
                <Field label="Quantity" value={qty} onChange={setQty} placeholder="10" keyboardType="numeric" />
              </View>
              <View style={{ flex: 1 }}>
                <Field label={`Cost each (${currency || '₹'})`} value={cost} onChange={setCost}
                  placeholder="200" keyboardType="numeric" />
              </View>
            </View>
            <TouchableOpacity style={s.outlineBtn} onPress={addLine} accessibilityRole="button">
              <Ionicons name="add" size={18} color={C.green} />
              <Text style={s.outlineBtnText}>Add to purchase</Text>
            </TouchableOpacity>
          </View>

          {items.length > 0 && (
            <View style={s.panel}>
              <Row label="Goods total (before tax)" value={money(draftTotal)} bold />
              <Text style={s.hint}>{`Tax is added by the server from each product's rate.`}</Text>
            </View>
          )}
          <TouchableOpacity style={[s.primaryBtn, busy && { opacity: 0.6 }]} disabled={busy} onPress={save}
            accessibilityRole="button" accessibilityLabel="Save purchase" accessibilityState={{ disabled: busy, busy }}>
            {busy ? <ActivityIndicator color={C.onFill} /> : <Text style={s.primaryBtnText}>Save purchase</Text>}
          </TouchableOpacity>
        </ScrollView>
      </>
    );
  }

  return (
    <>
      <SubHeader title="Purchases" onBack={onBack} />
      <FlatList
        data={rows}
        keyExtractor={(p) => p.id}
        renderItem={renderPurchase}
        ListHeaderComponent={(
          <>
            <TouchableOpacity style={[s.primaryBtn, { marginTop: 0 }]} onPress={() => setAdding(true)} accessibilityRole="button">
              <Ionicons name="add" size={18} color={C.onFill} />
              <Text style={s.primaryBtnText}>Record a purchase</Text>
            </TouchableOpacity>
            {rows.length > 0 && (
              <View style={s.panel}>
                <Row label="Total spend" value={money(spend)} bold />
              </View>
            )}
            {loading && <LoadingState />}
            {!!err && !loading && <ErrorState title="Couldn’t load purchases" sub={err} onRetry={load} />}
            {!loading && !err && rows.length === 0 && (
              <Empty icon="cart-outline" text="No purchases yet. Recording what stock costs is what makes profit reporting possible." />
            )}
          </>
        )}
        contentContainerStyle={s.body}
        refreshControl={<RefreshControl refreshing={loading} onRefresh={load} tintColor={C.green} />}
      />
    </>
  );
}

// Stock (P0-B). Deliberately one screen: the position, and the one action that
// changes it. Every change needs a reason, because the movement ledger is only
// worth keeping if it answers "where did 8 kg go?".
export function StockScreen({ currency, onBack }: { currency?: string; onBack: () => void }) {
  const [rows, setRows] = useState<SB.StockRow[]>([]);
  const [lowCount, setLowCount] = useState(0);
  const [sel, setSel] = useState<SB.StockRow | null>(null);
  const [kind, setKind] = useState<SB.StockMoveKind>('purchase');
  const [qty, setQty] = useState('');
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [history, setHistory] = useState<SB.StockMovement[]>([]);
  // "No movements yet" is a claim about the ledger; a failed read is not it.
  const [historyErr, setHistoryErr] = useState('');

  const { loading, err, load } = useShopLoad(SB.stockList, (r) => { setRows(r.stock); setLowCount(r.lowCount); });

  // The item whose history is wanted NOW. Opening A then B quickly could let
  // A's slower answer land under B's heading; a reply for any other item is
  // dropped.
  const historyFor = useRef<string | null>(null);
  const loadHistory = async (productId: string) => {
    historyFor.current = productId;
    setHistoryErr('');
    try {
      const list = await SB.stockMovements(productId);
      if (historyFor.current === productId) setHistory(list);
    } catch (e: any) { if (historyFor.current === productId) setHistoryErr(loadErrText(e)); }
  };
  const openItem = async (row: SB.StockRow) => {
    setSel(row); setQty(''); setReason(''); setKind('purchase'); setHistory([]);
    await loadHistory(row.productId);
  };

  const submit = async () => {
    if (!sel) return;
    // Three different problems, three different messages (2026-09-17). This
    // screen had NO isNum gate at all: num() coerced "12,5" to 0 and the single
    // `q === 0` branch then told the owner to "Enter a quantity" about a box
    // with digits already in it, so retyping the same thing got the same
    // refusal forever. Negatives stay legal — this is the one screen that means
    // them, and a correction of -3 is the whole point of the Correction kind.
    if (!qty.trim()) { Alert.alert('Enter a quantity'); return; }
    if (!isNum(qty)) {
      Alert.alert('Check the quantity',
        `"${qty.trim()}" is not a plain number. Use digits only — 1200 or 1,200 both work, and -3 is a valid correction.`);
      return;
    }
    const q = num(qty);
    if (q === 0) { Alert.alert('Enter a quantity', 'A movement of 0 would not change the stock.'); return; }
    if (!reason.trim()) { Alert.alert('Reason required', 'Stock never changes silently.'); return; }
    setBusy(true);
    try {
      await SB.adjustStock(sel.productId, kind, q, reason.trim());
      setSel(null); load();
    } catch (e: any) { Alert.alert('Could not record', e?.message ?? 'Try again'); }
    finally { setBusy(false); }
  };

  const KINDS: { k: SB.StockMoveKind; label: string }[] = [
    { k: 'purchase', label: 'Stock in' },
    { k: 'opening', label: 'Opening' },
    { k: 'damage', label: 'Damaged' },
    { k: 'return', label: 'Returned' },
    { k: 'adjustment', label: 'Correction' },
  ];

  const renderMovement = ({ item: m }: { item: SB.StockMovement }) => {
    const d = m.onHandDelta || m.reservedDelta;
    return (
              <View style={s.card}>
                <View style={{ flex: 1 }}>
                  <Text style={s.cardTitle}>{m.kind.replace(/_/g, ' ')}</Text>
                  <Text style={s.cardSub}>
                    {[m.reason, m.actor].filter(Boolean).join(' · ')}
                  </Text>
                </View>
                <Text style={[s.price, { color: d < 0 ? C.danger : C.green }]}>
                  {d > 0 ? '+' : ''}{d}{m.reservedDelta && !m.onHandDelta ? ' held' : ''}
                </Text>
              </View>
    );
  };

  const renderStockRow = ({ item: row }: { item: SB.StockRow }) => (
          <TouchableOpacity style={s.card} onPress={() => openItem(row)} accessibilityRole="button"
            accessibilityLabel={`${row.name}, ${row.available} available${row.reserved > 0 ? `, ${row.reserved} reserved` : ''}${row.low ? ', low stock' : ''}`}>
            <View style={{ flex: 1 }}>
              <Text style={s.cardTitle}>{row.name}{row.unit ? ` · ${row.unit}` : ''}</Text>
              <Text style={s.cardSub}>
                {row.available} available{row.reserved > 0 ? ` · ${row.reserved} reserved` : ''}
                {row.costPrice > 0 ? ` · cost ${formatMoney(row.costPrice, currency)}` : ''}
              </Text>
            </View>
            {row.low && <Text style={[s.price, { color: C.danger }]}>LOW</Text>}
            <Ionicons name="chevron-forward" size={18} color={C.sub} />
          </TouchableOpacity>
  );

  if (sel) {
    return (
      <>
        <SubHeader title={sel.name} onBack={() => { historyFor.current = null; setSel(null); }} />
        <FlatList
          // Movements are append-only, so the history is the scroller and the
          // position + record form ride above it. An element, not a component
          // function, or the quantity box remounts as it is typed into.
          data={history}
          keyExtractor={(m) => String(m.id)}
          renderItem={renderMovement}
          contentContainerStyle={s.body}
          keyboardShouldPersistTaps="handled"
          ListHeaderComponent={(
          <>
          <View style={{ flexDirection: 'row', gap: 10 }}>
            <StatCard label="On hand" value={String(sel.onHand)} tone="navy" />
            <StatCard label="Reserved" value={String(sel.reserved)} tone="amber" />
            <StatCard label="Available" value={String(sel.available)} tone={sel.low ? 'danger' : 'green'} />
          </View>
          <View style={s.panel}>
            <Text style={s.panelTitle}>Record a movement</Text>
            <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginBottom: 8 }}>
              {KINDS.map((k) => (
                <Chip key={k.k} label={k.label} icon="cube-outline"
                  active={kind === k.k} onPress={() => setKind(k.k)} />
              ))}
            </View>
            <Field label={`Quantity (${sel.unit || 'units'})`} value={qty} onChange={setQty}
              placeholder={kind === 'adjustment' ? '-2 or 5' : '10'} keyboardType="numeric" />
            <Field label="Reason" value={reason} onChange={setReason}
              placeholder={kind === 'damage' ? 'Dropped a crate' : 'Supplier delivery'} />
            <TouchableOpacity style={[s.primaryBtn, busy && { opacity: 0.6 }]} disabled={busy} onPress={submit}
              accessibilityRole="button" accessibilityLabel="Record the movement" accessibilityState={{ disabled: busy, busy }}>
              {busy ? <ActivityIndicator color={C.onFill} /> : <Text style={s.primaryBtnText}>Record</Text>}
            </TouchableOpacity>
          </View>
          <Text style={s.sectionLabel}>History</Text>
          {!!historyErr && <ErrorState title="Couldn’t load the history" sub={historyErr} onRetry={() => loadHistory(sel.productId)} />}
          {!historyErr && history.length === 0 && <Empty icon="time-outline" text="No movements yet." />}
          </>
          )}
        />
      </>
    );
  }

  return (
    <>
      <SubHeader title="Stock" onBack={onBack} />
      <FlatList
        data={rows}
        keyExtractor={(row) => row.productId}
        renderItem={renderStockRow}
        ListHeaderComponent={(
          <>
            {lowCount > 0 && (
              <Text style={[s.hint, { color: C.danger }]}>
                ⚠️ {lowCount} product(s) at or below their reorder level.
              </Text>
            )}
            {loading && <LoadingState />}
            {!!err && !loading && <ErrorState title="Couldn’t load stock" sub={err} onRetry={load} />}
            {!loading && !err && rows.length === 0 && (
              <Empty icon="cube-outline" text="No counted products. Turn on “Count stock” on a product to start." />
            )}
          </>
        )}
        contentContainerStyle={s.body}
        refreshControl={<RefreshControl refreshing={loading} onRefresh={load} tintColor={C.green} />}
      />
    </>
  );
}

export function BulkAdd({ currency, onDone }: { currency?: string; onDone: () => void }) {
  const money = (n: number) => formatMoney(n, currency || '₹');
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const parsed = useMemo(() => parseBulkProducts(text), [text]);
  // Lines that do not become a product are skipped on save, and lines with no
  // price would go in at 0. Both are said before the owner taps Add, not after.
  const skipped = useMemo(() => skippedBulkLines(text), [text]);
  const unpriced = parsed.filter((p) => p.price <= 0).length;

  const save = async () => {
    if (parsed.length === 0) { Alert.alert('Nothing to add', 'Paste one product per line.'); return; }
    setBusy(true);
    try {
      const res = await SB.bulkAddProducts(parsed.map((p) => ({ name: p.name, brand: p.brand, unit: p.unit, price: p.price })));
      Alert.alert('Added', `${res.added} product(s) added to your catalog.`);
      onDone();
    } catch (e: any) { Alert.alert('Error', e?.message ?? 'Try again'); }
    finally { setBusy(false); }
  };

  return (
    <>
      <SubHeader title="Bulk add products" onBack={onDone} />
      <KeyboardSafe style={{ flex: 1 }} >
        <ScrollView contentContainerStyle={s.body} keyboardShouldPersistTaps="handled">
          <Text style={s.hint}>
            Paste one product per line. Formats accepted:{'\n'}
            • Aashirvaad Atta 5kg 285{'\n'}
            • Tata Salt, Tata, 1kg, 20{'\n'}
            • Fortune Oil, 145
          </Text>
          <TextInput style={[s.input, { height: 200, textAlignVertical: 'top' }]} multiline
            accessibilityLabel="Products, one per line"
            placeholder={'Aashirvaad Atta 5kg 285\nFortune Oil 1L 145\nTata Salt 1kg 20'}
            placeholderTextColor={C.sub} value={text} onChangeText={setText} />
          {parsed.length > 0 && (
            <>
              <Text style={s.sectionLabel}>Preview · {parsed.length} product(s)</Text>
              {/* A read-only preview re-derived from the text on every keystroke;
                  the line number is its identity, so it is part of the key. */}
              {parsed.slice(0, 8).map((p, i) => (
                <View key={`${i}-${p.name}-${p.unit}`} style={s.card}>
                  <View style={{ flex: 1 }}>
                    <Text style={s.cardTitle}>{p.name}{p.unit ? ` · ${p.unit}` : ''}{p.brand ? ` (${p.brand})` : ''}</Text>
                  </View>
                  <Text style={s.price}>{money(p.price)}</Text>
                </View>
              ))}
              {parsed.length > 8 && <Text style={s.hint}>…and {parsed.length - 8} more</Text>}
            </>
          )}
          {skipped.length > 0 && (
            <Text style={[s.hint, { color: C.danger }]} accessibilityLiveRegion="polite">
              {skipped.length} line{skipped.length === 1 ? '' : 's'} could not be read and will be skipped: {skipped.slice(0, 3).map((l) => `“${l}”`).join(', ')}{skipped.length > 3 ? '…' : ''}
            </Text>
          )}
          {unpriced > 0 && (
            <Text style={[s.hint, { color: C.amber }]}>
              {unpriced} product{unpriced === 1 ? ' has' : 's have'} no price and will be added at {money(0)}. Add the price at the end of the line, or set it later.
            </Text>
          )}
          <TouchableOpacity style={[s.primaryBtn, busy && { opacity: 0.6 }]} disabled={busy} onPress={save}
            accessibilityRole="button" accessibilityLabel={`Add ${parsed.length || ''} product(s)`} accessibilityState={{ disabled: busy, busy }}>
            {busy ? <ActivityIndicator color={C.onFill} /> : <Text style={s.primaryBtnText}>Add {parsed.length || ''} product(s)</Text>}
          </TouchableOpacity>
        </ScrollView>
      </KeyboardSafe>
    </>
  );
}
