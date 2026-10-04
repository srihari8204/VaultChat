// components/shopbook/orders.tsx — Shop Book: customer and owner order screens and the return request
// (one order's owner view is in ./orderDetail, the owner's returns list in ./returns).
// Split out of app/shop-book.tsx on 2026-10-04 and edited since (fixes are
// logged per round). Palette and styles come from ./theme.

import { useCallback, useEffect, useRef, useState } from 'react';
import { View, Text, TextInput, TouchableOpacity, ScrollView, FlatList, Alert, ActivityIndicator, RefreshControl, Share, Linking } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import * as Print from 'expo-print';
import { formatMoney, orderStatusLabel, orderProgress, clientKey, ORDER_STEPS, canCustomerCancel, REJECT_REASONS, canCustomerCollect, isTerminalFailure, dateLocale, orderStamp, isBlankOrNonNegative, num } from '../../utils/shopbook';
import * as SB from '../../services/shopBookService';
// ONE canonical document. Screen and PDF read the same model, so the two can
// no longer disagree the way buildBillHtml and InvoiceView's inline template did.
import { invoiceHtml, fromOrder } from '../../utils/shopbookInvoice';
import { LoadingState, ErrorState } from '../finance/ui';
import { t } from '../../lib/shopbookI18n';
import { C, s } from './theme';
import { previewDoc, Row, onShopBookEvent, ReasonModal, SubHeader, Field, StatusPill, AvailabilityTag, TxnRow, Empty } from './shared';
import { InvoiceView } from './invoices';
import { useShopLoad } from './useShopLoad';
import { OwnerOrderDetail } from './orderDetail';
import { userErrorText } from '../../lib/userErrorText';

export function MyOrders({ onOpen }: { onOpen: (id: string) => void }) {
  const [orders, setOrders] = useState<SB.OrderSummary[]>([]);
  const { loading, err, load } = useShopLoad(SB.myOrders, setOrders);

  // An order history only grows, so the list itself is the scroller and the
  // label + loading/empty states ride above it as the header.
  const renderOrder = useCallback(({ item: o }: { item: SB.OrderSummary }) => (
        <TxnRow
          icon="receipt-outline"
          title={o.shopName || 'Shop'}
          // The date was already fetched on OrderSummary and never shown. An
          // order list you cannot scan by date is not a list, it is a pile.
          sub={`${o.id.slice(0, 8).toUpperCase()} · ${orderStamp(o.createdAt)}`}
          amount={formatMoney(o.total, o.currency || '₹')}
          onPress={() => onOpen(o.id)}
          right={<Ionicons name="chevron-forward" size={20} color={C.sub} />}
        >
          <StatusPill status={o.status} />
        </TxnRow>
  ), [onOpen]);

  return (
    <FlatList
      data={orders}
      keyExtractor={(o) => o.id}
      renderItem={renderOrder}
      ListHeaderComponent={(
        <>
          <Text style={s.sectionLabel}>My Orders</Text>
          {loading && <LoadingState />}
          {!!err && !loading && <ErrorState title="Couldn’t load your orders" sub={err} onRetry={load} />}
          {!loading && !err && orders.length === 0 && <Empty icon="receipt-outline" text="No orders yet." />}
        </>
      )}
      contentContainerStyle={s.body}
      refreshControl={<RefreshControl refreshing={loading} onRefresh={load} tintColor={C.green} />}
    />
  );
}

export function OrderTrack({ orderId, onBack }: { orderId: string; onBack: () => void }) {
  const [order, setOrder] = useState<SB.OrderDetail | null>(null);
  const [stars, setStars] = useState(0);
  const [review, setReview] = useState('');
  const [busy, setBusy] = useState(false);
  const [cancelAsk, setCancelAsk] = useState(false);
  const [invoice, setInvoice] = useState(false);
  const [returning, setReturning] = useState(false);
  // ── buying for a business ───────────────────────────────────────
  //
  // A buyer who gives a tax number is making a business purchase and can
  // reclaim the tax — but only against a compliant tax invoice. The backend has
  // issued both shapes since the addendum landed, and the endpoint has been
  // live on production, with nothing in the app able to call it: the whole
  // reclaimable-invoice feature was unreachable.
  //
  // It has to be asked BEFORE the invoice is issued, because the invoice is
  // immutable afterwards — a template toggle at print time would leave a retail
  // customer looking at blank statutory fields.
  const [taxOpen, setTaxOpen] = useState(false);
  const [bizName, setBizName] = useState('');
  const [taxNo, setTaxNo] = useState('');
  const [bizAddr, setBizAddr] = useState('');

  const fetchOrder = useCallback(() => SB.orderDetails(orderId), [orderId]);
  const { loading, err, load } = useShopLoad(fetchOrder, setOrder);

  // Realtime (P1-E): the shop moves the order and this screen follows, without
  // the customer pulling to refresh while standing in the shop.
  //
  // The socket event is only a HINT that something changed — we re-fetch the
  // authoritative state rather than trusting the payload. That is also why the
  // screen is correct after a cold start, when no event was ever received.
  useEffect(() => {
    let alive = true;
    const stop = onShopBookEvent((ev) => {
      if (!alive) return;
      if (ev?.data?.orderId && ev.data.orderId !== orderId) return;
      load();
    });
    return () => { alive = false; stop(); };
  }, [orderId, load]);

  const openTaxForm = () => {
    setBizName(order?.buyerTax?.businessName ?? '');
    setTaxNo(order?.buyerTax?.taxNumber ?? '');
    setBizAddr(order?.buyerTax?.address ?? '');
    setTaxOpen(true);
  };

  const saveBuyerTax = async () => {
    setBusy(true);
    try {
      const r = await SB.setBuyerTax(orderId, {
        businessName: bizName.trim(), taxNumber: taxNo.trim(), address: bizAddr.trim(),
      });
      setTaxOpen(false);
      Alert.alert(r.invoiceKind === 'tax' ? 'Tax invoice' : 'Retail bill',
        r.invoiceKind === 'tax'
          ? 'This order will be billed as a tax invoice you can claim against.'
          : 'This order will be billed as a plain retail bill.');
      load();
    } catch (e) { Alert.alert('Could not save', userErrorText(e, 'Try again')); }
    finally { setBusy(false); }
  };

  // Guarded like every other write here: a second tap while the first is in
  // flight must not answer the same alternative twice.
  const decide = async (itemId: string, accept: boolean) => {
    if (busy) return;
    setBusy(true);
    try { await SB.decideAlternative(orderId, itemId, accept); load(); }
    catch (e) { Alert.alert('Error', userErrorText(e, 'Try again')); }
    finally { setBusy(false); }
  };

  const cancelOrder = async (reason: string) => {
    setBusy(true);
    try { await SB.cancelOrder(orderId, reason); load(); }
    catch (e) { Alert.alert('Error', userErrorText(e, 'Try again')); }
    finally { setBusy(false); }
  };

  // Only the customer can confirm collection (spec: order-management / D5a).
  const confirmCollected = async () => {
    setBusy(true);
    try { await SB.collectOrder(orderId); load(); }
    catch (e) { Alert.alert('Error', userErrorText(e, 'Try again')); }
    finally { setBusy(false); }
  };

  const submitRating = async () => {
    if (stars < 1) { Alert.alert('Tap a star to rate'); return; }
    setBusy(true);
    try { await SB.rateOrder(orderId, stars, review.trim()); load(); }
    catch (e) { Alert.alert('Error', userErrorText(e, 'Try again')); }
    finally { setBusy(false); }
  };

  // One key per repeat attempt, reused by its retries — including the one a
  // price change asks for — and replaced only once that order exists. Same
  // rule as the cart's idemKey: a flaky connection cannot place it twice.
  const repeatKey = useRef(clientKey());
  const repeat = async (confirmPricing = false) => {
    if (!order || busy) return;
    setBusy(true);
    try {
      await SB.placeOrder(order.shopId,
        order.items.map((it) => ({
          // Catalog lines carry their product so the server prices them from
          // today's catalog, exactly as a fresh cart would. A free-typed line
          // has none and stays a request for the shop to quote.
          productId: !it.custom && it.productId ? it.productId : undefined,
          name: it.name, brand: it.brand, qty: it.qty, price: it.price, note: it.note,
          unit: it.unit, taxPercent: it.taxPercent,
        })),
        'Repeat order',
        { idempotencyKey: repeatKey.current, confirmPricing });
      repeatKey.current = clientKey();
      Alert.alert('Order placed', 'Your repeat order was sent to the shop.');
    } catch (e) {
      // Prices moved since the original order: show what changed and let the
      // customer decide, as the cart does — never re-price silently.
      const pc = SB.priceChangesFrom(e);
      if (pc) {
        const cur = order.currency || '₹';
        const lines = pc.changes
          .map((c) => `${c.name}${c.brand ? ` (${c.brand})` : ''}: ${formatMoney(c.oldPrice, cur)} → ${formatMoney(c.newPrice, cur)}`)
          .join('\n');
        Alert.alert('Prices have changed', `${lines}\n\nNew total: ${formatMoney(pc.total, cur)}`, [
          { text: 'Don’t order', style: 'cancel' },
          { text: 'Order at new price', onPress: () => { void repeat(true); } },
        ]);
        return;
      }
      Alert.alert('Error', userErrorText(e, 'Try again'));
    }
    finally { setBusy(false); }
  };

  const share = async () => {
    if (!order) return;
    const lines = order.items.map((it) =>
      `• ${it.name}${it.brand ? ` (${it.brand})` : ''}${it.unit ? ` · ${it.unit}` : ''} × ${it.qty}`);
    await Share.share({
      message: `🛍️ Shop Book order ${order.id.slice(0, 8).toUpperCase()}\n${lines.join('\n')}\nTotal: ${formatMoney(order.total, order.currency || '₹')}`,
    }).catch(() => {});
  };

  const bill = async () => {
    if (!order) return;
    const html = invoiceHtml(fromOrder(order, orderStatusLabel(order.status)));
    try {
      const { uri } = await Print.printToFileAsync({ html });
      previewDoc(uri, `receipt-${order.id}.pdf`);
    } catch (e) { Alert.alert('Error', userErrorText(e, 'Could not create the bill')); }
  };

  if (invoice) return <InvoiceView orderId={orderId} onBack={() => setInvoice(false)} />;
  if (returning && order) {
    return <ReturnRequest order={order} onDone={() => { setReturning(false); load(); }} />;
  }

  const money = (n: number) => formatMoney(n, order?.currency || '₹');
  const failed = order && isTerminalFailure(order.status);
  return (
    <>
      <SubHeader title={t('orders.track')} onBack={onBack}
        right={order ? { icon: 'share-social-outline', label: 'Share this order', onPress: share } : undefined} />
      <ReasonModal visible={cancelAsk} title={t('orders.cancelReason')}
        onSubmit={(reason) => cancelOrder(reason)} onClose={() => setCancelAsk(false)} />
      <ScrollView contentContainerStyle={s.body}
        refreshControl={<RefreshControl refreshing={loading} onRefresh={load} tintColor={C.green} />}>
        {loading && !order && <LoadingState />}
        {!loading && !order && !!err && <ErrorState title="Couldn’t load this order" sub={err} onRetry={load} />}
        {order && (
          <>
            <StatusPill status={order.status} big />
            {/* cancelled/rejected: reason banner instead of progress steps */}
            {failed ? (
              <View style={[s.panel, { borderColor: C.danger }]}>
                <Text style={{ color: C.danger, fontWeight: '700' }}>
                  {order.status === 'rejected'
                    ? `${t('orders.rejectedByShop')}${order.rejectReason ? ` — ${REJECT_REASONS.find((r) => r.code === order.rejectReason)?.label ?? order.rejectReason}` : ''}${order.rejectNote ? `: ${order.rejectNote}` : ''}`
                    : order.status === 'not_collected'
                      ? (order.notCollectedReason === 'expired'
                          ? 'This order was not collected in time and has been closed.'
                          : `The shop closed this order as not collected${order.notCollectedReason ? ` — ${order.notCollectedReason}` : ''}.`)
                      : `${order.cancelledBy === 'customer' ? t('orders.cancelledByYou') : t('orders.cancelledByShop')}${order.cancelReason ? ` — ${order.cancelReason}` : ''}`}
                </Text>
              </View>
            ) : (
              <View style={s.stepper}>
                {ORDER_STEPS.map((step, i) => {
                  const done = orderProgress(order.status) >= i / (ORDER_STEPS.length - 1);
                  return (
                    <View key={step} style={{ alignItems: 'center', flex: 1 }}>
                      <View style={[s.stepDot, done && s.stepDotDone]}>
                        {done && <Ionicons name="checkmark" size={12} color={C.onFill} />}
                      </View>
                      <Text style={s.stepLabel}>{orderStatusLabel(step)}</Text>
                    </View>
                  );
                })}
              </View>
            )}

            {/* timestamped timeline (spec: order-management / tracking) */}
            {order.timeline.length > 0 && (
              <View style={s.panel}>
                {order.timeline.map((ev, i) => (
                  <View key={`${ev.status}-${i}`} style={{ flexDirection: 'row', alignItems: 'center', gap: 8, marginVertical: 3 }}>
                    <View style={[s.pillDot, { backgroundColor: C.green }]} />
                    <Text style={[s.cardSub, { flex: 1 }]}>
                      {orderStatusLabel(ev.status)}{ev.note ? ` · ${ev.note}` : ''}
                    </Text>
                    <Text style={[s.cardSub, { fontSize: 11 }]}>
                      {new Date(ev.at).toLocaleTimeString(dateLocale(), { hour: '2-digit', minute: '2-digit' })}
                    </Text>
                  </View>
                ))}
              </View>
            )}

            {/* who the order is with — previously the tracking screen never said */}
            {!!order.shop?.name && (
              <View style={s.panel}>
                <Text numberOfLines={1} style={s.panelTitle}>{order.shop.name}</Text>
                {!!order.shop.ownerName && <Text style={s.cardSub}>{order.shop.ownerName}</Text>}
                {!!order.shop.address && <Text style={s.cardSub}>📍 {order.shop.address}</Text>}
                {!!order.shop.phone && (
                  <TouchableOpacity onPress={() => Linking.openURL(`tel:${order.shop.phone}`)}
                    accessibilityRole="link" accessibilityLabel={`Call the shop, ${order.shop.phone}`}>
                    <Text style={[s.cardSub, { color: C.green }]}>☎ {order.shop.phone}</Text>
                  </TouchableOpacity>
                )}
                {Object.entries(order.shop.taxConfig ?? {})
                  .filter(([, v]) => String(v ?? '').trim() !== '')
                  .map(([k, v]) => (
                    <Text key={k} style={s.cardSub}>{k.toUpperCase()}: {String(v)}</Text>
                  ))}
              </View>
            )}

            <Text style={s.sectionLabel}>Items</Text>
            {order.items.map((it) => (
              <View key={it.id} style={s.card}>
                <View style={{ flex: 1 }}>
                  <Text style={s.cardTitle}>{it.name}{it.brand ? ` (${it.brand})` : ''}{it.unit ? ` · ${it.unit}` : ''} × {it.qty}</Text>
                  {!!it.note && <Text style={s.cardSub}>📝 {it.note}</Text>}
                  <AvailabilityTag a={it.availability} altName={it.altName} />
                  {it.availability === 'alternative' && (
                    <View style={{ flexDirection: 'row', gap: 8, marginTop: 8 }}>
                      <TouchableOpacity style={[s.smallGreen, busy && { opacity: 0.6 }]} disabled={busy} onPress={() => decide(it.id, true)}
                        accessibilityRole="button" accessibilityState={{ disabled: busy }}>
                        <Text style={s.smallGreenText}>
                          {t('orders.acceptAlt')} {it.altName}{it.altPrice > 0 ? ` (${money(it.altPrice)})` : ''}
                        </Text>
                      </TouchableOpacity>
                      <TouchableOpacity style={[s.smallOutline, busy && { opacity: 0.6 }]} disabled={busy} onPress={() => decide(it.id, false)}
                        accessibilityRole="button" accessibilityState={{ disabled: busy }}>
                        <Text style={s.smallOutlineText}>{t('orders.rejectAlt')}</Text>
                      </TouchableOpacity>
                    </View>
                  )}
                </View>
                <Text style={s.price}>{it.price > 0 ? money(it.price * it.qty) : '—'}</Text>
              </View>
            ))}

            <View style={s.panel}>
              {order.discount > 0 && <Row label={`Discount (${order.couponCode})`} value={`− ${money(order.discount)}`} tone={C.green} />}
              <Row label={t('common.total')} value={money(order.total)} bold />
            </View>

            {/* collection is the customer's assertion, not the shop's (D5a) */}
            {canCustomerCollect(order.status) && (
              <TouchableOpacity style={[s.primaryBtn, busy && { opacity: 0.6 }]} disabled={busy}
                accessibilityRole="button" accessibilityState={{ disabled: busy }}
                onPress={confirmCollected}>
                <Ionicons name="bag-check" size={18} color={C.onFill} />
                <Text style={s.primaryBtnText}>{t('orders.collected')}</Text>
              </TouchableOpacity>
            )}

            {/* customer may cancel only while the order is still pending */}
            {canCustomerCancel(order.status) && (
              <TouchableOpacity style={s.dangerBtn} disabled={busy} onPress={() => setCancelAsk(true)}
                accessibilityRole="button" accessibilityState={{ disabled: busy }}>
                <Text style={s.dangerBtnText}>{t('orders.cancel')}</Text>
              </TouchableOpacity>
            )}

            {/* Buying for a business? Offered only while the invoice can still
                change — after it is issued the document is frozen and the
                answer is "ask the shop for a revised bill". */}
            {!order.hasInvoice && !['cancelled', 'rejected', 'not_collected'].includes(order.status) && (
              taxOpen ? (
                <View style={s.panel}>
                  <Text style={s.panelTitle}>Buying for a business?</Text>
                  <TextInput style={s.input} placeholder="Business name" placeholderTextColor={C.sub}
                    accessibilityLabel="Business name" value={bizName} onChangeText={setBizName} />
                  <TextInput style={s.input} placeholder="Tax number (GSTIN / VAT / EIN)"
                    accessibilityLabel="Tax number"
                    placeholderTextColor={C.sub} value={taxNo} onChangeText={setTaxNo}
                    autoCapitalize="characters" />
                  <TextInput style={s.input} placeholder="Business address" placeholderTextColor={C.sub}
                    accessibilityLabel="Business address" value={bizAddr} onChangeText={setBizAddr} />
                  <Text style={s.hint}>
                    With a tax number this becomes a tax invoice you can claim the
                    tax back against. Leave it blank for a normal bill. It has to
                    be set before the shop issues the invoice.
                  </Text>
                  <View style={{ flexDirection: 'row', gap: 8, marginTop: 8 }}>
                    <TouchableOpacity style={[s.primaryBtn, { flex: 1 }, busy && { opacity: 0.6 }]}
                      accessibilityRole="button" accessibilityLabel="Save tax details" accessibilityState={{ disabled: busy }}
                      disabled={busy} onPress={saveBuyerTax}>
                      <Text style={s.primaryBtnText}>Save</Text>
                    </TouchableOpacity>
                    <TouchableOpacity style={[s.outlineBtn, { flex: 1 }]} disabled={busy} accessibilityRole="button"
                      onPress={() => setTaxOpen(false)}>
                      <Text style={s.outlineBtnText}>Cancel</Text>
                    </TouchableOpacity>
                  </View>
                </View>
              ) : (
                <TouchableOpacity style={s.outlineBtn} onPress={openTaxForm} accessibilityRole="button">
                  <Ionicons name="business-outline" size={18} color={C.green} />
                  <Text style={s.outlineBtnText}>
                    {order.buyerTax?.taxNumber
                      ? `  Tax invoice for ${order.buyerTax.businessName || order.buyerTax.taxNumber}`
                      : '  Buying for a business? Add tax details'}
                  </Text>
                </TouchableOpacity>
              )
            )}

            {/* Repeat + Share + Invoice */}
            <View style={{ flexDirection: 'row', gap: 8 }}>
              <TouchableOpacity style={[s.outlineBtn, { flex: 1 }, busy && { opacity: 0.6 }]} disabled={busy} onPress={() => { void repeat(); }}
                accessibilityRole="button" accessibilityState={{ disabled: busy, busy }}>
                <Ionicons name="repeat" size={18} color={C.green} />
                <Text style={s.outlineBtnText}>Repeat order</Text>
              </TouchableOpacity>
              <TouchableOpacity style={[s.outlineBtn, { flex: 1 }]} onPress={order.hasInvoice ? () => setInvoice(true) : bill}
                accessibilityRole="button">
                <Ionicons name="receipt-outline" size={18} color={C.green} />
                <Text style={s.outlineBtnText}>{order.hasInvoice ? t('orders.invoice') : 'Bill / Receipt'}</Text>
              </TouchableOpacity>
            </View>

            {/* Returns (P1-B). Only on a completed order, and only inside the
                window — offering it later would be an invitation to a refusal. */}
            {order.status === 'completed' && (
              <TouchableOpacity style={s.outlineBtn} onPress={() => setReturning(true)} accessibilityRole="button">
                <Ionicons name="arrow-undo-outline" size={18} color={C.green} />
                <Text style={s.outlineBtnText}>Return an item</Text>
              </TouchableOpacity>
            )}

            {/* Rating */}
            {order.status === 'completed' && (
              order.rated ? (
                <View style={[s.panel, { alignItems: 'center' }]}>
                  <Text style={{ color: C.green, fontWeight: '700' }}>✓ Thanks for rating this order</Text>
                </View>
              ) : (
                <View style={s.panel}>
                  <Text style={s.panelTitle}>Rate this order</Text>
                  <View style={{ flexDirection: 'row', gap: 6, marginVertical: 8 }} accessibilityRole="radiogroup" accessibilityLabel="Rating">
                    {[1, 2, 3, 4, 5].map((n) => (
                      <TouchableOpacity accessibilityRole="radio" accessibilityState={{ checked: stars === n }}
                        accessibilityLabel={`Rate ${n} out of 5`} key={n} onPress={() => setStars(n)} hitSlop={7}>
                        <Ionicons name={n <= stars ? 'star' : 'star-outline'} size={30} color={C.amber} />
                      </TouchableOpacity>
                    ))}
                  </View>
                  <TextInput style={s.input} placeholder="Write a review (optional)" placeholderTextColor={C.sub}
                    accessibilityLabel="Review, optional" value={review} onChangeText={setReview} />
                  <TouchableOpacity style={[s.primaryBtn, busy && { opacity: 0.6 }]} disabled={busy} onPress={submitRating}
                    accessibilityRole="button" accessibilityState={{ disabled: busy }}>
                    <Text style={s.primaryBtnText}>Submit Rating</Text>
                  </TouchableOpacity>
                </View>
              )
            )}
          </>
        )}
      </ScrollView>
    </>
  );
}

export const OWNER_ORDER_TABS: { id: string; label: string }[] = [
  { id: 'pending', label: 'New' }, { id: 'accepted', label: 'Accepted' },
  { id: 'preparing', label: 'Preparing' }, { id: 'packing', label: 'Packing' },
  { id: 'ready', label: 'Ready' }, { id: 'completed', label: 'Completed' },
  { id: 'all', label: 'All' },
];

export function OwnerOrders() {
  const [filter, setFilter] = useState('pending');
  const [orders, setOrders] = useState<SB.OrderSummary[]>([]);
  const [open, setOpen] = useState<string | null>(null);

  // Reloads when the tab changes; a late answer for the previous tab is
  // dropped by useShopLoad rather than shown under this one.
  const fetchOrders = useCallback(() => SB.ownerOrders(filter), [filter]);
  const { loading, err, load } = useShopLoad(fetchOrders, setOrders);

  // A new order should appear on the owner's list the moment it is placed —
  // they may be standing at the counter with the app already open (P1-E).
  useEffect(() => {
    const stop = onShopBookEvent(() => { void load(); });
    return stop;
  }, [load]);

  // A busy shop's order list is unbounded, so it is the scroller rather than a
  // block of rows inside one. Declared above the early return below so the hook
  // order never depends on whether an order is open.
  const renderOrder = useCallback(({ item: o }: { item: SB.OrderSummary }) => (
          <TxnRow
            icon="receipt-outline"
            title={o.customerName || 'Customer'}
            sub={`${o.id.slice(0, 8).toUpperCase()} · ${orderStamp(o.createdAt)}`}
            // Was formatINR — a hardcoded ₹ on the OWNER's own list, while the
            // customer's list beside it already honoured o.currency. A shop
            // configured in any other currency was shown rupees for its own
            // takings.
            amount={formatMoney(o.total, o.currency || '₹')}
            onPress={() => setOpen(o.id)}
            right={<Ionicons name="chevron-forward" size={20} color={C.sub} />}
          >
            <StatusPill status={o.status} />
          </TxnRow>
  ), []);

  if (open) return <OwnerOrderDetail orderId={open} onBack={() => { setOpen(null); load(); }} />;

  return (
    <>
      <ScrollView horizontal showsHorizontalScrollIndicator={false} style={s.filterBar} contentContainerStyle={{ paddingHorizontal: 12 }}
        accessibilityRole="tablist">
        {OWNER_ORDER_TABS.map((t) => (
          <TouchableOpacity key={t.id} style={[s.filterChip, filter === t.id && s.filterChipActive]} onPress={() => setFilter(t.id)}
            accessibilityRole="tab" accessibilityState={{ selected: filter === t.id }}>
            <Text style={[s.filterChipText, filter === t.id && s.filterChipTextActive]}>{t.label}</Text>
          </TouchableOpacity>
        ))}
      </ScrollView>
      <FlatList
        data={orders}
        keyExtractor={(o) => o.id}
        renderItem={renderOrder}
        ListHeaderComponent={(
          <>
            {loading && <LoadingState />}
            {!!err && !loading && <ErrorState title="Couldn’t load orders" sub={err} onRetry={load} />}
            {!loading && !err && orders.length === 0 && <Empty icon="receipt-outline" text={`No ${filter} orders.`} />}
          </>
        )}
        contentContainerStyle={s.body}
        refreshControl={<RefreshControl refreshing={loading} onRefresh={load} tintColor={C.green} />}
      />
    </>
  );
}

// The customer's side of a return (P1-B): pick lines and quantities, say why.
// The refund figure comes back from the server, priced from the ORIGINAL line —
// a price rise since the sale must not change what is owed back.
export function ReturnRequest({ order, onDone }: { order: SB.OrderDetail; onDone: () => void }) {
  const [qty, setQty] = useState<Record<string, string>>({});
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const key = useRef(clientKey());
  const money = (n: number) => formatMoney(n, order.currency);

  const lines = order.items.filter((i) => i.availability !== 'unavailable' && !i.removed);

  const submit = async () => {
    // isNum before the filter (2026-09-17). num() turns an unparseable qty into
    // 0, and `qty > 0` then drops that line silently — the customer submitted a
    // return that quietly left out the very item they were returning, and found
    // out when the credit note arrived short.
    //
    // NON-NEGATIVE, not merely numeric: isBlankOrNum accepts a leading minus
    // (the stock screen needs it), so "-1" passed this gate and then hit the
    // very `qty > 0` filter above — reproducing, verbatim, the short credit
    // note this comment claims to have fixed. You cannot return minus one of
    // something. Blank still means "not returning this line".
    const badLine = lines.find((l) => !isBlankOrNonNegative(qty[l.id] ?? ''));
    if (badLine) {
      Alert.alert('Check the quantity',
        `"${(qty[badLine.id] ?? '').trim()}" is not a quantity for ${badLine.name}. Use digits only — 1200 or 1,200 both work — and it cannot be negative.`);
      return;
    }
    const items = lines
      .map((l) => ({ orderItemId: l.id, qty: num(qty[l.id] ?? '') }))
      .filter((x) => x.qty > 0);
    if (items.length === 0) { Alert.alert('Choose what you are returning'); return; }
    if (!reason.trim()) { Alert.alert('Tell the shop why', 'A reason is required.'); return; }
    setBusy(true);
    try {
      const r = await SB.requestReturn(order.id, reason.trim(), items, key.current);
      key.current = clientKey();
      Alert.alert('Return requested',
        `The shop will review it. If approved, ${money(r.refundTotal)} will be credited to your account.`);
      onDone();
    } catch (e) {
      Alert.alert(e?.body?.code === 'return_window_closed' ? 'Too late to return' : 'Could not request',
        userErrorText(e, 'Try again'));
    } finally { setBusy(false); }
  };

  return (
    <>
      <SubHeader title="Return an item" onBack={onDone} />
      <ScrollView contentContainerStyle={s.body} keyboardShouldPersistTaps="handled">
        <Text style={s.hint}>
          Enter how much of each item is coming back. You can return part of a line.
        </Text>
        {lines.map((l) => {
          const billed = l.qty;
          return (
            <View key={l.id} style={s.card}>
              <View style={{ flex: 1 }}>
                <Text style={s.cardTitle}>{l.name}{l.brand ? ` (${l.brand})` : ''}</Text>
                <Text style={s.cardSub}>
                  You were billed {billed}{l.unit ? ` ${l.unit}` : ''} · {money(l.price)} each
                </Text>
              </View>
              <TextInput
                style={[s.input, { width: 80, marginBottom: 0, paddingVertical: 6, textAlign: 'center' }]}
                accessibilityLabel={`Quantity of ${l.name} to return`}
                keyboardType="numeric" placeholder="0" placeholderTextColor={C.sub}
                value={qty[l.id] ?? ''} onChangeText={(v) => setQty({ ...qty, [l.id]: v })} />
            </View>
          );
        })}
        <Field label="Why are you returning it?" value={reason} onChange={setReason}
          placeholder="e.g. Bag was torn" />
        <TouchableOpacity style={[s.primaryBtn, busy && { opacity: 0.6 }]} disabled={busy} onPress={submit}
          accessibilityRole="button" accessibilityLabel="Request return" accessibilityState={{ disabled: busy, busy }}>
          {busy ? <ActivityIndicator color={C.onFill} />
                : <Text style={s.primaryBtnText}>Request return</Text>}
        </TouchableOpacity>
        <Text style={s.hint}>
          The shop reviews every return. Your original bill is never changed — an approved
          return produces a separate credit note.
        </Text>
      </ScrollView>
    </>
  );
}
