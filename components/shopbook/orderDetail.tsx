// components/shopbook/orderDetail.tsx — Shop Book: the owner's view of one order
// (status moves, availability, suggest-an-alternative, reject, the live bill).
// Moved out of components/shopbook/orders.tsx on 2026-10-04 (round 5) to keep
// that file a reviewable size; no behaviour changed in the move.

import { useCallback, useState } from 'react';
import { KeyboardSafe } from '../ui';
import { View, Text, TextInput, TouchableOpacity, ScrollView, Alert, ActivityIndicator, RefreshControl, Modal } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { formatMoney, orderStatusLabel, nextOrderStatus, canOwnerCancel, REJECT_REASONS, REJECT_NOTE_MAX, rejectPayload, notCollectedGate, isTerminalFailure, type OrderStatus, type ItemAvailability, isBlankOrNonNegative, num } from '../../utils/shopbook';
import * as SB from '../../services/shopBookService';
import { LoadingState, ErrorState } from '../finance/ui';
import { t } from '../../lib/shopbookI18n';
import { C, s } from './theme';
import { ReasonModal, SubHeader, StatusPill, AvailabilityTag } from './shared';
import { BillScreen } from './invoices';
import { useShopLoad } from './useShopLoad';
import { userErrorText } from '../../lib/userErrorText';

export function OwnerOrderDetail({ orderId, onBack }: { orderId: string; onBack: () => void }) {
  const [order, setOrder] = useState<SB.OrderDetail | null>(null);
  const [busy, setBusy] = useState(false);
  const [rejectAsk, setRejectAsk] = useState(false);
  const [cancelAsk, setCancelAsk] = useState(false);
  const [notCollectAsk, setNotCollectAsk] = useState(false);
  const [billing, setBilling] = useState(false);
  const [altFor, setAltFor] = useState<string | null>(null);
  const [altName, setAltName] = useState('');
  const [altPrice, setAltPrice] = useState('');
  const fetchOrder = useCallback(() => SB.orderDetails(orderId), [orderId]);
  const { loading, err, load } = useShopLoad(fetchOrder, setOrder);

  // Busy-guarded: two quick taps (available, then unavailable) must not race
  // each other to the server and leave the line in whichever landed last.
  // Resolves true only once the server took it, so a caller holding typed
  // input (the alternative modal) knows whether it is safe to clear.
  const setAvail = async (itemId: string, a: ItemAvailability, name = '', price = 0): Promise<boolean> => {
    if (busy) return false;
    setBusy(true);
    try { await SB.setItemAvailability(orderId, itemId, a, name, price); load(); return true; }
    catch (e) { Alert.alert('Error', userErrorText(e, 'Try again')); return false; }
    finally { setBusy(false); }
  };

  const submitAlt = async () => {
    if (!altFor || !altName.trim()) { Alert.alert(t('owner.suggestAlt'), 'Enter the alternative product'); return; }
    // isNum, not just num (2026-09-17). This price is what the customer is
    // asked to approve, and num() turns anything unparseable into 0 — the
    // substitute was offered FREE and, once approved, sold at nothing. Blank
    // still means 0, which is how the owner offers a straight swap.
    if (!isBlankOrNonNegative(altPrice)) {
      Alert.alert('Check the price',
        `"${altPrice}" is not a plain number. Use digits only — 1200 or 1,200 both work.`);
      return;
    }
    // The modal stays open until the server has the alternative: closing it
    // first threw away what the owner typed whenever the save failed.
    if (await setAvail(altFor, 'alternative', altName.trim(), num(altPrice))) {
      setAltFor(null); setAltName(''); setAltPrice('');
    }
  };

  const setStatus = async (status: OrderStatus, reason = '', note = '') => {
    setBusy(true);
    try { await SB.setOrderStatus(orderId, status, reason, note); load(); }
    catch (e) {
      // Accepting reserves stock. If the shelf can't cover it the order is
      // untouched — name the items so the owner's next move (an alternative,
      // or rejecting as out of stock) is obvious.
      const short = SB.shortfallsFrom(e);
      if (short?.length) {
        Alert.alert(
          'Not enough stock',
          short.map((x) => `${x.name}: you have ${x.available} ${x.unit}, the order wants ${x.wanted}`).join('\n')
            + '\n\nSuggest an alternative, mark the item unavailable, or reject the order.',
        );
        return;
      }
      Alert.alert('Error', userErrorText(e, 'Try again'));
    }
    finally { setBusy(false); }
  };

  const money = (n: number) => formatMoney(n, order?.currency || '₹');
  const next = order ? nextOrderStatus(order.status) : null;
  const reviewed = order ? order.items.every((it) => it.availability !== 'pending' && it.availability !== 'alternative') : false;
  const terminal = order && ['completed', 'cancelled', 'rejected', 'not_collected'].includes(order.status);
  // Ready orders wait for the customer; after 24h the owner can write one off.
  const uncollected = order
    ? notCollectedGate(order.status, order.timeline)
    : { allowed: false, hoursLeft: 0 };

  // Billing sits between packing and Ready: weigh out, price, then hand over.
  if (billing) return <BillScreen orderId={orderId} onBack={() => { setBilling(false); load(); }} />;

  return (
    <>
      <SubHeader title={t('owner.newOrder')} onBack={onBack} />
      {/* maxLength: the server keeps at most 200 characters of the note
          (400 note_too_long past that), so the box stops where it would. */}
      <ReasonModal visible={rejectAsk} title={t('owner.rejectReason')} codes={REJECT_REASONS} maxLength={REJECT_NOTE_MAX}
        // The server takes one of the reason CODES; "other" also carries the
        // owner's words as `note`, so they reach the customer instead of being
        // dropped here. An older server ignores the extra field.
        onSubmit={(text, code) => { const r = rejectPayload(code, text); setStatus('rejected', r.reason, r.note); }}
        onClose={() => setRejectAsk(false)} />
      <ReasonModal visible={cancelAsk} title={t('orders.cancelReason')}
        onSubmit={(reason) => setStatus('cancelled', reason)} onClose={() => setCancelAsk(false)} />
      <ReasonModal visible={notCollectAsk} title="Why was it not collected?"
        onSubmit={(reason) => setStatus('not_collected', reason)} onClose={() => setNotCollectAsk(false)} />
      {/* alternative suggestion: name + price, cross-platform */}
      <Modal visible={altFor != null} transparent animationType="fade" onRequestClose={() => setAltFor(null)}>
        {/* KeyboardSafe + scroller (2026-09-18): a React Native <Modal> is its
            own Android window and never receives the activity's adjustResize,
            so this centred card had no keyboard avoidance at all and the
            autoFocus'd field sat under the keyboard on a short screen. */}
        <KeyboardSafe keyboardOnly style={s.modalWrap}>
          <ScrollView style={{ flex: 1 }} contentContainerStyle={s.modalScroll} keyboardShouldPersistTaps="handled">
          <View style={s.modalCard}>
            <Text style={s.modalTitle} accessibilityRole="header">{t('owner.suggestAlt')}</Text>
            <TextInput style={s.input} placeholder={t('owner.altName')} placeholderTextColor={C.sub}
              accessibilityLabel={t('owner.altName')} value={altName} onChangeText={setAltName} autoFocus />
            <TextInput style={s.input} placeholder={t('owner.altPrice')} placeholderTextColor={C.sub}
              accessibilityLabel={t('owner.altPrice')} value={altPrice} onChangeText={setAltPrice} keyboardType="numeric" />
            <TouchableOpacity style={[s.primaryBtn, busy && { opacity: 0.6 }]} disabled={busy} onPress={() => { void submitAlt(); }}
              accessibilityRole="button" accessibilityState={{ disabled: busy, busy }}>
              {busy ? <ActivityIndicator color={C.onFill} /> : <Text style={s.primaryBtnText}>{t('common.save')}</Text>}
            </TouchableOpacity>
            <TouchableOpacity style={s.dangerBtn} onPress={() => setAltFor(null)} accessibilityRole="button">
              <Text style={s.dangerBtnText}>{t('common.cancel')}</Text>
            </TouchableOpacity>
          </View>
          </ScrollView>
        </KeyboardSafe>
      </Modal>
      <ScrollView contentContainerStyle={s.body}
        refreshControl={<RefreshControl refreshing={loading} onRefresh={load} tintColor={C.green} />}>
        {loading && !order && <LoadingState />}
        {!loading && !order && !!err && <ErrorState title="Couldn’t load this order" sub={err} onRetry={load} />}
        {order && (
          <>
            <StatusPill status={order.status} big />
            {!!order.note && <Text style={s.hint}>📝 {order.note}</Text>}
            {isTerminalFailure(order.status) && (
              <View style={[s.panel, { borderColor: C.danger }]}>
                <Text style={{ color: C.danger, fontWeight: '700' }}>
                  {order.status === 'rejected'
                    ? `${REJECT_REASONS.find((r) => r.code === order.rejectReason)?.label ?? order.rejectReason}${order.rejectNote ? `: ${order.rejectNote}` : ''}`
                    : order.status === 'not_collected'
                      ? `Not collected: ${order.notCollectedReason === 'expired' ? 'closed automatically after 7 days' : order.notCollectedReason}`
                      : `${order.cancelledBy === 'customer' ? 'Customer cancelled' : 'Cancelled'}: ${order.cancelReason}`}
                </Text>
              </View>
            )}
            <Text style={s.sectionLabel}>Items — mark availability</Text>
            {order.items.map((it) => (
              <View key={it.id} style={s.card}>
                <View style={{ flex: 1 }}>
                  <Text style={s.cardTitle}>{it.name}{it.brand ? ` (${it.brand})` : ''}{it.unit ? ` · ${it.unit}` : ''} × {it.qty}</Text>
                  {!!it.note && <Text style={s.cardSub}>📝 {it.note}</Text>}
                  <AvailabilityTag a={it.availability} altName={it.altName} />
                  {order.status === 'pending' && (
                    <View style={{ flexDirection: 'row', gap: 6, marginTop: 8, flexWrap: 'wrap' }}>
                      <TouchableOpacity style={[s.smallGreen, busy && { opacity: 0.6 }]} disabled={busy} onPress={() => setAvail(it.id, 'available')}
                        accessibilityRole="button" accessibilityLabel={`${t('owner.markAvailable')}: ${it.name}`}
                        accessibilityState={{ disabled: busy, selected: it.availability === 'available' }}>
                        <Text style={s.smallGreenText}>{t('owner.markAvailable')}</Text>
                      </TouchableOpacity>
                      <TouchableOpacity style={[s.smallOutline, busy && { opacity: 0.6 }]} disabled={busy} onPress={() => setAvail(it.id, 'unavailable')}
                        accessibilityRole="button" accessibilityLabel={`${t('owner.markUnavailable')}: ${it.name}`}
                        accessibilityState={{ disabled: busy, selected: it.availability === 'unavailable' }}>
                        <Text style={s.smallOutlineText}>{t('owner.markUnavailable')}</Text>
                      </TouchableOpacity>
                      <TouchableOpacity style={[s.smallOutline, busy && { opacity: 0.6 }]} disabled={busy}
                        accessibilityRole="button" accessibilityLabel={`${t('owner.suggestAlt')}: ${it.name}`}
                        onPress={() => { setAltFor(it.id); setAltName(''); setAltPrice(''); }}>
                        <Text style={s.smallOutlineText}>{t('owner.suggestAlt')}</Text>
                      </TouchableOpacity>
                    </View>
                  )}
                </View>
                <Text style={s.price}>{it.price > 0 ? money(it.price * it.qty) : '—'}</Text>
              </View>
            ))}
            <View style={s.totalRow}>
              <Text style={s.totalLabel}>{t('common.total')}</Text>
              <Text style={s.totalValue}>{money(order.total)}</Text>
            </View>

            {!terminal && (
              <>
                {order.status === 'pending' && (
                  <>
                    {!reviewed && <Text style={s.hint}>⏳ {t('owner.reviewFirst')}</Text>}
                    <View style={{ flexDirection: 'row', gap: 8 }}>
                      <TouchableOpacity
                        style={[s.primaryBtn, { flex: 2 }, (busy || !reviewed) && { opacity: 0.6 }]}
                        accessibilityRole="button" accessibilityState={{ disabled: busy || !reviewed }}
                        disabled={busy || !reviewed} onPress={() => setStatus('accepted')}>
                        <Ionicons name="checkmark-circle" size={18} color={C.onFill} />
                        <Text style={s.primaryBtnText}>{t('owner.accept')}</Text>
                      </TouchableOpacity>
                      <TouchableOpacity style={[s.dangerBtn, { flex: 1, marginTop: 12 }]} disabled={busy} onPress={() => setRejectAsk(true)}
                        accessibilityRole="button" accessibilityState={{ disabled: busy }}>
                        <Text style={s.dangerBtnText}>{t('owner.reject')}</Text>
                      </TouchableOpacity>
                    </View>
                  </>
                )}
                {/* Weigh out and price before the customer is told it's Ready
                    — after that the total is what they were quoted (P0-C). */}
                {['accepted', 'preparing', 'packing'].includes(order.status) && (
                  <TouchableOpacity style={s.outlineBtn} onPress={() => setBilling(true)} accessibilityRole="button">
                    <Ionicons name="calculator-outline" size={18} color={C.green} />
                    <Text style={s.outlineBtnText}>Bill · {money(order.total)}</Text>
                  </TouchableOpacity>
                )}
                {order.status !== 'pending' && next && (
                  <TouchableOpacity style={[s.primaryBtn, busy && { opacity: 0.6 }]} disabled={busy} onPress={() => setStatus(next)}
                    accessibilityRole="button" accessibilityState={{ disabled: busy }}>
                    <Ionicons name="arrow-forward-circle" size={18} color={C.onFill} />
                    <Text style={s.primaryBtnText}>{`Mark as ${orderStatusLabel(next)}`}</Text>
                  </TouchableOpacity>
                )}
                {/* Ready → Collected is the customer's to make; the shop can
                    only write the order off once it has waited 24h (D5a). */}
                {order.status === 'ready' && (
                  <>
                    <Text style={s.hint}>⏳ Waiting for the customer to confirm pickup.</Text>
                    <TouchableOpacity
                      style={[s.dangerBtn, (busy || !uncollected.allowed) && { opacity: 0.6 }]}
                      accessibilityRole="button" accessibilityState={{ disabled: busy || !uncollected.allowed }}
                      disabled={busy || !uncollected.allowed} onPress={() => setNotCollectAsk(true)}>
                      <Text style={s.dangerBtnText}>
                        {uncollected.allowed
                          ? 'Not collected'
                          : `Not collected · available in ${uncollected.hoursLeft}h`}
                      </Text>
                    </TouchableOpacity>
                  </>
                )}
                {canOwnerCancel(order.status) && order.status !== 'pending' && (
                  <TouchableOpacity style={s.dangerBtn} disabled={busy} onPress={() => setCancelAsk(true)}
                    accessibilityRole="button" accessibilityState={{ disabled: busy }}>
                    <Text style={s.dangerBtnText}>{t('orders.cancel')}</Text>
                  </TouchableOpacity>
                )}
              </>
            )}
          </>
        )}
      </ScrollView>
    </>
  );
}
