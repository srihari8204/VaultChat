// components/shopbook/checkout.tsx — Shop Book, moved out of app/shop-book.tsx
// unchanged. Palette and styles come from ./theme; see app/shop-book.tsx.

import { useRef, useState } from 'react';
import { View, Text, TextInput, TouchableOpacity, ScrollView, Alert, ActivityIndicator } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { formatMoney, cartTotal, clientKey, couponDiscount, couponLabel, type CartItem } from '../../utils/shopbook';
import * as SB from '../../services/shopBookService';
import { C, s } from './theme';
import { Row, Empty } from './shared';

export function CartView({ shop, cart, setCart, onPlaced, coupons }: {
  shop: SB.Shop; cart: CartItem[]; setCart: (c: CartItem[]) => void;
  onPlaced: (id: string) => void; coupons: SB.Coupon[];
}) {
  const money = (n: number) => formatMoney(n, shop.currency || '₹');
  const [note, setNote] = useState('');
  const [placing, setPlacing] = useState(false);
  const [couponInput, setCouponInput] = useState('');
  const [applied, setApplied] = useState<SB.Coupon | null>(null);
  const [couponMsg, setCouponMsg] = useState('');

  const setQty = (key: string, d: number) =>
    setCart(cart.map((it) => it.key === key ? { ...it, qty: Math.max(1, it.qty + d) } : it));
  const remove = (key: string) => setCart(cart.filter((it) => it.key !== key));

  const subtotal = cartTotal(cart);
  const discount = couponDiscount(subtotal, applied);
  const total = Math.max(0, subtotal - discount);

  const applyCoupon = () => {
    const code = couponInput.trim().toUpperCase();
    const found = coupons.find((c2) => c2.code.toUpperCase() === code);
    if (!found) { setCouponMsg('Invalid code'); setApplied(null); return; }
    if (subtotal < found.minOrder) { setCouponMsg(`Min order ${money(found.minOrder)}`); setApplied(null); return; }
    setApplied(found); setCouponMsg(`Applied · ${couponLabel(found, shop.currency || '₹')}`);
  };

  // One key for this cart, reused by every retry — including the retry the
  // customer triggers by confirming a price change — so a flaky connection
  // cannot turn one order into two.
  const idemKey = useRef(clientKey()).current;

  const place = async (confirmPricing = false) => {
    if (cart.length === 0) return;
    setPlacing(true);
    try {
      const res = await SB.placeOrder(
        shop.id,
        cart.map((it) => ({
          productId: it.productId,
          name: it.name, brand: it.brand, qty: it.qty, price: it.price, note: it.note,
          unit: it.unit, taxPercent: it.taxPercent,
        })),
        note.trim(),
        { couponCode: applied?.code, idempotencyKey: idemKey, confirmPricing },
      );
      onPlaced(res.id);
    } catch (e: any) {
      // The shop's prices moved since this cart was built. Show the customer
      // exactly what changed and let them decide — never re-price silently.
      const pc = SB.priceChangesFrom(e);
      if (pc) {
        const lines = pc.changes
          .map((c) => `${c.name}${c.brand ? ` (${c.brand})` : ''}: ${formatMoney(c.oldPrice, shop.currency)} → ${formatMoney(c.newPrice, shop.currency)}`)
          .join('\n');
        Alert.alert(
          'Price changed at the shop',
          `${lines}\n\nNew total: ${formatMoney(pc.total, shop.currency)}`,
          [
            { text: 'Back to cart', style: 'cancel' },
            { text: 'Order at new price', onPress: () => { void place(true); } },
          ],
        );
        return;
      }
      Alert.alert('Could not place order', e?.message ?? 'Try again.');
    } finally { setPlacing(false); }
  };

  return (
    <ScrollView contentContainerStyle={s.body} keyboardShouldPersistTaps="handled">
      <Text style={s.sectionLabel}>Review order · {shop.name}</Text>
      {cart.map((it) => (
        <View key={it.key} style={s.card}>
          <View style={{ flex: 1 }}>
            <Text style={s.cardTitle}>{it.name}{it.brand ? ` (${it.brand})` : ''}{it.unit ? ` · ${it.unit}` : ''}</Text>
            {!!it.note && <Text style={s.cardSub}>📝 {it.note}</Text>}
            <Text style={s.price}>{it.price > 0 ? money(it.price) : 'Price on confirm'}</Text>
          </View>
          <View style={s.qtyRow}>
            <TouchableOpacity hitSlop={7} style={s.qtyBtn} onPress={() => setQty(it.key, -1)}
              accessibilityRole="button" accessibilityLabel={`One less ${it.name}`}
              accessibilityState={{ disabled: it.qty <= 1 }}><Text style={s.qtyBtnText}>−</Text></TouchableOpacity>
            <Text style={s.qtyText} accessibilityLabel={`Quantity ${it.qty}`}>{it.qty}</Text>
            <TouchableOpacity hitSlop={7} style={s.qtyBtn} onPress={() => setQty(it.key, 1)}
              accessibilityRole="button" accessibilityLabel={`One more ${it.name}`}><Text style={s.qtyBtnText}>+</Text></TouchableOpacity>
            <TouchableOpacity accessibilityRole="button" accessibilityLabel={`Remove ${it.name} from the cart`} onPress={() => remove(it.key)}
              hitSlop={12} style={{ marginLeft: 8 }}>
              <Ionicons name="trash-outline" size={18} color={C.danger} />
            </TouchableOpacity>
          </View>
        </View>
      ))}
      {cart.length === 0 && <Empty icon="cart-outline" text="Cart is empty." />}

      {cart.length > 0 && (
        <>
          {/* Coupon */}
          <View style={{ flexDirection: 'row', gap: 8, marginTop: 4 }}>
            <TextInput style={[s.input, { flex: 1, marginBottom: 0 }]} placeholder="Coupon code" placeholderTextColor={C.sub}
              accessibilityLabel="Coupon code" autoCapitalize="characters" value={couponInput} onChangeText={setCouponInput} />
            <TouchableOpacity style={[s.outlineBtn, { marginTop: 0, paddingHorizontal: 18 }]} onPress={applyCoupon}
              accessibilityRole="button" accessibilityLabel="Apply coupon">
              <Text style={s.outlineBtnText}>Apply</Text>
            </TouchableOpacity>
          </View>
          {!!couponMsg && <Text style={[s.hint, { color: applied ? C.green : C.danger }]} accessibilityLiveRegion="polite">{couponMsg}</Text>}

          <TextInput style={s.input} placeholder="Order note (e.g. pack before 8 PM)" placeholderTextColor={C.sub}
            accessibilityLabel="Order note" value={note} onChangeText={setNote} />

          {/* Totals */}
          <View style={s.panel}>
            <Row label="Subtotal" value={money(subtotal)} />
            {discount > 0 && <Row label={`Discount (${applied?.code})`} value={`− ${money(discount)}`} tone={C.green} />}
            <View style={{ height: 1, backgroundColor: C.border, marginVertical: 6 }} />
            <Row label="Total" value={money(total)} bold />
          </View>

          <TouchableOpacity style={[s.primaryBtn, placing && { opacity: 0.6 }]} disabled={placing}
            accessibilityRole="button" accessibilityLabel="Place order" accessibilityState={{ disabled: placing, busy: placing }}
            onPress={() => { void place(); }}>
            {placing ? <ActivityIndicator color="#fff" /> : <>
              <Ionicons name="checkmark-circle" size={18} color="#fff" />
              <Text style={s.primaryBtnText}>Place Order</Text>
            </>}
          </TouchableOpacity>
        </>
      )}
    </ScrollView>
  );
}
