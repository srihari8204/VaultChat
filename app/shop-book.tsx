// app/shop-book.tsx — SHOP BOOK mini-app.
//
// One screen, two modes (Customer / Shop Owner), each with its own bottom-tab
// set — modelled on interest-calculator.tsx. Text-only catalog (no product
// images in MVP). Talks to the Go backend via services/shopBookService.ts.
//
//   Customer : Find shops → shop details → catalog / type-any-product → cart →
//              place order → track; plus Orders list and per-shop Ledger.
//   Owner    : Dashboard, Orders (mark availability / advance status),
//              Products (add/edit/stock), Khata (per-customer ledger), Settings.

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  View, Text, TextInput, TouchableOpacity, ScrollView, StyleSheet,
  Alert, ActivityIndicator, RefreshControl, Switch, Platform, KeyboardAvoidingView, Share,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { Stack, useRouter } from 'expo-router';
import * as Location from 'expo-location';
import { getCurrentUserAsync } from './(constants)/authService';
import { SHOP_CATEGORIES, categoryIcon, categoryLabel } from '../constants/shopCategories';
import {
  formatINR, formatDistance, shopOpenState, orderStatusLabel, orderProgress,
  nextOrderStatus, cartTotal, clientKey, ORDER_STEPS,
  couponDiscount, couponLabel, starText, loyaltyTier,
  type CartItem, type OrderStatus, type ItemAvailability,
} from '../utils/shopbook';
import * as SB from '../services/shopBookService';
import { listShopLists, saveShopList, deleteShopList, type ShopList } from '../db/shopLists';

// ── palette (green + navy, from the SHOP BOOK poster) ──────────────
const C = {
  green: '#0B7A3B', greenDark: '#075E54', greenSoft: '#DCFCE7',
  navy: '#1E3A5F', bg: '#F3F4F6', card: '#FFFFFF', border: '#E5E7EB',
  line: '#EEF0F3', text: '#111827', sub: '#6B7280', danger: '#DC2626',
  amber: '#D97706', blue: '#1D4ED8',
};

type Mode = 'customer' | 'owner';
type CustTab = 'shops' | 'orders' | 'profile';
type OwnerTab = 'dashboard' | 'orders' | 'products' | 'khata';

const num = (s: string) => { const n = Number(s); return Number.isFinite(n) ? n : 0; };

export default function ShopBookScreen() {
  const router = useRouter();
  const [mode, setMode] = useState<Mode>('customer');
  const [me, setMe] = useState<{ id: string; name: string } | null>(null);

  useEffect(() => { (async () => {
    const u = await getCurrentUserAsync().catch(() => null);
    setMe({ id: u?.id ?? 'local', name: u?.name ?? u?.email ?? 'You' });
  })(); }, []);

  return (
    <View style={s.screen}>
      <Stack.Screen options={{ headerShown: false }} />
      {/* Header + mode toggle */}
      <View style={s.header}>
        <TouchableOpacity onPress={() => router.back()} hitSlop={10} style={s.hBtn}>
          <Ionicons name="arrow-back" size={22} color="#fff" />
        </TouchableOpacity>
        <View style={{ flex: 1 }}>
          <Text style={s.headerTitle}>🛍️ Shop Book</Text>
          <Text style={s.headerSub}>Find shops • Order • Digital Khata</Text>
        </View>
      </View>
      <View style={s.modeRow}>
        {(['customer', 'owner'] as Mode[]).map((m) => (
          <TouchableOpacity key={m} onPress={() => setMode(m)}
            style={[s.modeBtn, mode === m && s.modeBtnActive]}>
            <Ionicons name={m === 'customer' ? 'person' : 'storefront'} size={15}
              color={mode === m ? '#fff' : C.green} />
            <Text style={[s.modeText, mode === m && s.modeTextActive]}>
              {m === 'customer' ? 'Customer' : 'Shop Owner'}
            </Text>
          </TouchableOpacity>
        ))}
      </View>

      {mode === 'customer'
        ? <CustomerApp me={me} />
        : <OwnerApp me={me} />}
    </View>
  );
}

// ════════════════════════════════════════════════════════════════
//  CUSTOMER
// ════════════════════════════════════════════════════════════════
function CustomerApp({ me }: { me: { id: string; name: string } | null }) {
  const [tab, setTab] = useState<CustTab>('shops');
  // drill-down within the Shops tab
  const [selShop, setSelShop] = useState<SB.Shop | null>(null);
  const [cart, setCart] = useState<CartItem[]>([]);
  const [trackId, setTrackId] = useState<string | null>(null);
  const [ledgerShop, setLedgerShop] = useState<SB.Shop | null>(null);
  // Phase 2 — favorites shared across screens
  const [favIds, setFavIds] = useState<Set<string>>(new Set());

  const loadFavs = useCallback(async () => {
    try { const list = await SB.favorites(); setFavIds(new Set(list.map((sh) => sh.id))); } catch {}
  }, []);
  useEffect(() => { loadFavs(); }, [loadFavs]);

  const toggleFav = useCallback(async (shopId: string) => {
    // optimistic
    setFavIds((prev) => { const n = new Set(prev); n.has(shopId) ? n.delete(shopId) : n.add(shopId); return n; });
    try { await SB.toggleFavorite(shopId); } catch { loadFavs(); }
  }, [loadFavs]);

  const openTrack = (id: string) => { setTrackId(id); };

  return (
    <>
      <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
        {tab === 'shops' && !selShop && !ledgerShop && (
          <FindShops onOpen={(sh) => { setSelShop(sh); }} favIds={favIds} onToggleFav={toggleFav} />
        )}
        {tab === 'shops' && selShop && !ledgerShop && (
          <ShopFlow
            shop={selShop} cart={cart} setCart={setCart}
            onBack={() => setSelShop(null)}
            onPlaced={(id) => { setSelShop(null); setCart([]); setTab('orders'); openTrack(id); }}
            onLedger={() => setLedgerShop(selShop)}
            isFav={favIds.has(selShop.id)} onToggleFav={() => toggleFav(selShop.id)}
          />
        )}
        {tab === 'shops' && ledgerShop && (
          <CustomerLedgerView shop={ledgerShop} onBack={() => setLedgerShop(null)} />
        )}

        {tab === 'orders' && (
          trackId
            ? <OrderTrack orderId={trackId} onBack={() => setTrackId(null)} />
            : <MyOrders onOpen={openTrack} />
        )}

        {tab === 'profile' && <CustomerProfile me={me} />}
      </KeyboardAvoidingView>

      <TabBar
        tabs={[
          { id: 'shops', label: 'Shops', icon: 'storefront' },
          { id: 'orders', label: 'Orders', icon: 'receipt' },
          { id: 'profile', label: 'Profile', icon: 'person-circle' },
        ]}
        active={tab}
        onChange={(t) => { setTab(t as CustTab); setSelShop(null); setLedgerShop(null); setTrackId(null); }}
      />
    </>
  );
}

function FindShops({ onOpen, favIds, onToggleFav }: {
  onOpen: (s: SB.Shop) => void; favIds: Set<string>; onToggleFav: (id: string) => void;
}) {
  const [loading, setLoading] = useState(true);
  const [shops, setShops] = useState<SB.Shop[]>([]);
  const [favShops, setFavShops] = useState<SB.Shop[]>([]);
  const [cat, setCat] = useState('all');
  const [q, setQ] = useState('');
  const [coords, setCoords] = useState<{ lat: number; lng: number } | null>(null);
  const [err, setErr] = useState<string | null>(null);

  const load = useCallback(async (category: string, c?: { lat: number; lng: number } | null) => {
    setLoading(true); setErr(null);
    try {
      const list = await SB.nearbyShops(c?.lat, c?.lng, category);
      setShops(list);
    } catch (e: any) { setErr(e?.message ?? 'Could not load shops'); }
    finally { setLoading(false); }
  }, []);

  useEffect(() => { (async () => {
    let c: { lat: number; lng: number } | null = null;
    try {
      const { status } = await Location.requestForegroundPermissionsAsync();
      if (status === 'granted') {
        const pos = await Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.Balanced });
        c = { lat: pos.coords.latitude, lng: pos.coords.longitude };
        setCoords(c);
      }
    } catch {}
    load('all', c);
    try { setFavShops(await SB.favorites()); } catch {}
  })(); }, [load]);

  const filtered = useMemo(
    () => shops.filter((sh) => !q.trim() || sh.name.toLowerCase().includes(q.trim().toLowerCase())),
    [shops, q],
  );

  return (
    <ScrollView contentContainerStyle={s.body}
      refreshControl={<RefreshControl refreshing={loading} onRefresh={() => load(cat, coords)} tintColor={C.green} />}>
      <View style={s.searchRow}>
        <Ionicons name="search" size={18} color={C.sub} />
        <TextInput style={s.searchInput} placeholder="Search shops nearby" placeholderTextColor={C.sub}
          value={q} onChangeText={setQ} />
      </View>
      {!coords && !loading && (
        <Text style={s.hint}>📍 Location off — showing recent shops. Enable location for distance.</Text>
      )}

      {/* favorites strip */}
      {favShops.length > 0 && !q.trim() && (
        <>
          <Text style={s.sectionLabel}>⭐ Favorites</Text>
          <ScrollView horizontal showsHorizontalScrollIndicator={false} style={{ marginBottom: 4 }}>
            {favShops.map((sh) => (
              <TouchableOpacity key={sh.id} style={s.favCard} onPress={() => onOpen(sh)}>
                <Text style={{ fontSize: 22 }}>{categoryIcon(sh.category)}</Text>
                <Text style={s.favName} numberOfLines={1}>{sh.name}</Text>
                {sh.ratingCount > 0 && <Text style={s.favRating}>{starText(sh.rating)} {sh.rating}</Text>}
              </TouchableOpacity>
            ))}
          </ScrollView>
        </>
      )}

      {/* category chips */}
      <ScrollView horizontal showsHorizontalScrollIndicator={false} style={{ marginVertical: 6 }}>
        <Chip label="All" icon="🏬" active={cat === 'all'} onPress={() => { setCat('all'); load('all', coords); }} />
        {SHOP_CATEGORIES.map((c2) => (
          <Chip key={c2.id} label={c2.label} icon={c2.icon} active={cat === c2.id}
            onPress={() => { setCat(c2.id); load(c2.id, coords); }} />
        ))}
      </ScrollView>

      {loading && <ActivityIndicator color={C.green} style={{ marginTop: 24 }} />}
      {err && <Text style={s.error}>{err}</Text>}
      {!loading && !err && filtered.length === 0 && (
        <Empty icon="storefront-outline" text="No shops found nearby yet." />
      )}

      {filtered.map((sh) => (
        <ShopCard key={sh.id} shop={sh} onOpen={() => onOpen(sh)}
          isFav={favIds.has(sh.id)} onToggleFav={() => onToggleFav(sh.id)} />
      ))}
    </ScrollView>
  );
}

function ShopCard({ shop, onOpen, isFav, onToggleFav }: {
  shop: SB.Shop; onOpen: () => void; isFav: boolean; onToggleFav: () => void;
}) {
  const st = shopOpenState(shop.openTime, shop.closeTime, shop.status);
  return (
    <TouchableOpacity style={s.card} onPress={onOpen} activeOpacity={0.8}>
      <View style={s.shopIcon}><Text style={{ fontSize: 22 }}>{categoryIcon(shop.category)}</Text></View>
      <View style={{ flex: 1 }}>
        <Text style={s.cardTitle}>{shop.name}</Text>
        <Text style={s.cardSub}>
          {categoryLabel(shop.category)}{shop.distanceKm != null ? ` · ${formatDistance(shop.distanceKm)}` : ''}
          {shop.ratingCount > 0 ? `  ·  ⭐ ${shop.rating} (${shop.ratingCount})` : ''}
        </Text>
        <View style={{ flexDirection: 'row', gap: 6, marginTop: 6, alignItems: 'center' }}>
          <View style={[s.badge, { marginTop: 0 }, st.tone === 'open' ? s.badgeOpen : st.tone === 'soon' ? s.badgeSoon : s.badgeClosed]}>
            <Text style={[s.badgeText, st.tone === 'closed' && { color: C.danger }]}>{st.label}</Text>
          </View>
          {shop.delivery && <View style={s.deliveryBadge}><Text style={s.deliveryBadgeText}>🛵 Delivery</Text></View>}
        </View>
      </View>
      <TouchableOpacity onPress={onToggleFav} hitSlop={10} style={{ padding: 4 }}>
        <Ionicons name={isFav ? 'heart' : 'heart-outline'} size={22} color={isFav ? C.danger : C.sub} />
      </TouchableOpacity>
    </TouchableOpacity>
  );
}

// Shop details → catalog → cart, all in one drill-down.
function ShopFlow({ shop, cart, setCart, onBack, onPlaced, onLedger, isFav, onToggleFav }: {
  shop: SB.Shop; cart: CartItem[]; setCart: (c: CartItem[]) => void;
  onBack: () => void; onPlaced: (orderId: string) => void; onLedger: () => void;
  isFav: boolean; onToggleFav: () => void;
}) {
  const [view, setView] = useState<'details' | 'catalog' | 'cart'>('details');
  const [coupons, setCoupons] = useState<SB.Coupon[]>([]);
  const [ratings, setRatings] = useState<SB.Rating[]>([]);
  const st = shopOpenState(shop.openTime, shop.closeTime, shop.status);

  useEffect(() => { (async () => {
    try { setCoupons(await SB.shopCoupons(shop.id)); } catch {}
    try { setRatings(await SB.shopRatings(shop.id)); } catch {}
  })(); }, [shop.id]);

  return (
    <>
      <SubHeader title={shop.name}
        onBack={() => (view === 'details' ? onBack() : setView('details'))}
        right={cart.length > 0 ? { icon: 'cart', badge: cart.length, onPress: () => setView('cart') } : undefined}
      />
      {view === 'details' && (
        <ScrollView contentContainerStyle={s.body}>
          <View style={s.card}>
            <View style={s.shopIcon}><Text style={{ fontSize: 26 }}>{categoryIcon(shop.category)}</Text></View>
            <View style={{ flex: 1 }}>
              <Text style={s.cardTitle}>{shop.name}</Text>
              <Text style={s.cardSub}>
                {categoryLabel(shop.category)}{shop.distanceKm != null ? ` · ${formatDistance(shop.distanceKm)}` : ''}
                {shop.ratingCount > 0 ? `  ·  ⭐ ${shop.rating} (${shop.ratingCount})` : ''}
              </Text>
              <View style={{ flexDirection: 'row', gap: 6, marginTop: 6 }}>
                <View style={[s.badge, { marginTop: 0 }, st.tone === 'open' ? s.badgeOpen : st.tone === 'soon' ? s.badgeSoon : s.badgeClosed]}>
                  <Text style={[s.badgeText, st.tone === 'closed' && { color: C.danger }]}>{st.label}</Text>
                </View>
                {shop.delivery && <View style={s.deliveryBadge}><Text style={s.deliveryBadgeText}>🛵 Delivery {shop.deliveryFee > 0 ? formatINR(shop.deliveryFee) : 'Free'}</Text></View>}
              </View>
            </View>
            <TouchableOpacity onPress={onToggleFav} hitSlop={10} style={{ padding: 4 }}>
              <Ionicons name={isFav ? 'heart' : 'heart-outline'} size={24} color={isFav ? C.danger : C.sub} />
            </TouchableOpacity>
          </View>

          {/* Offers */}
          {coupons.length > 0 && (
            <>
              <Text style={s.sectionLabel}>🏷️ Offers</Text>
              {coupons.map((c2) => (
                <View key={c2.code} style={s.offerCard}>
                  <View style={s.couponCode}><Text style={s.couponCodeText}>{c2.code}</Text></View>
                  <Text style={s.offerText}>{couponLabel(c2)}</Text>
                </View>
              ))}
            </>
          )}

          <InfoRow icon="time-outline" label="Timings" value={`${shop.openTime} – ${shop.closeTime}`} />
          {!!shop.address && <InfoRow icon="location-outline" label="Address" value={shop.address} />}
          {!!shop.phone && <InfoRow icon="call-outline" label="Phone" value={shop.phone} />}
          <InfoRow icon="bag-check-outline" label="Pickup" value={shop.pickup ? 'Available' : 'No pickup'} />
          <InfoRow icon="hourglass-outline" label="Prep time" value={`~${shop.prepMins} min`} />

          <TouchableOpacity style={s.primaryBtn} onPress={() => setView('catalog')}>
            <Ionicons name="list" size={18} color="#fff" />
            <Text style={s.primaryBtnText}>View Catalog</Text>
          </TouchableOpacity>
          <TouchableOpacity style={s.outlineBtn} onPress={onLedger}>
            <Ionicons name="book-outline" size={18} color={C.green} />
            <Text style={s.outlineBtnText}>My Ledger with this shop</Text>
          </TouchableOpacity>

          {/* Reviews */}
          {ratings.length > 0 && (
            <>
              <Text style={s.sectionLabel}>Reviews</Text>
              {ratings.slice(0, 5).map((rt, i) => (
                <View key={i} style={s.card}>
                  <View style={{ flex: 1 }}>
                    <Text style={s.stars}>{starText(rt.stars)}</Text>
                    {!!rt.review && <Text style={s.cardSub}>{rt.review}</Text>}
                    <Text style={s.reviewName}>— {rt.customerName || 'Customer'}</Text>
                  </View>
                </View>
              ))}
            </>
          )}
        </ScrollView>
      )}
      {view === 'catalog' && (
        <Catalog shop={shop} cart={cart} setCart={setCart} onCart={() => setView('cart')} />
      )}
      {view === 'cart' && (
        <CartView shop={shop} cart={cart} setCart={setCart} onPlaced={onPlaced} coupons={coupons} />
      )}
    </>
  );
}

function Catalog({ shop, cart, setCart, onCart }: {
  shop: SB.Shop; cart: CartItem[]; setCart: (c: CartItem[]) => void; onCart: () => void;
}) {
  const [loading, setLoading] = useState(true);
  const [products, setProducts] = useState<SB.Product[]>([]);
  const [q, setQ] = useState('');
  // "Type any product" form
  const [tName, setTName] = useState('');
  const [tBrand, setTBrand] = useState('');
  const [tQty, setTQty] = useState('1');
  const [tNote, setTNote] = useState('');

  useEffect(() => { (async () => {
    try { setProducts(await SB.shopProducts(shop.id)); }
    catch {} finally { setLoading(false); }
  })(); }, [shop.id]);

  const add = (name: string, brand: string, qty: number, price: number, note: string) => {
    setCart([...cart, { key: clientKey(), name, brand, qty, price, note }]);
  };

  const filtered = products.filter(
    (p) => !q.trim() || p.name.toLowerCase().includes(q.trim().toLowerCase()) || p.brand.toLowerCase().includes(q.trim().toLowerCase()),
  );

  return (
    <ScrollView contentContainerStyle={s.body} keyboardShouldPersistTaps="handled">
      <View style={s.searchRow}>
        <Ionicons name="search" size={18} color={C.sub} />
        <TextInput style={s.searchInput} placeholder="Search products" placeholderTextColor={C.sub}
          value={q} onChangeText={setQ} />
      </View>

      {/* Type any product */}
      <View style={s.panel}>
        <Text style={s.panelTitle}>✍️ Type any product</Text>
        <TextInput style={s.input} placeholder="Product name (e.g. Maggi)" placeholderTextColor={C.sub}
          value={tName} onChangeText={setTName} />
        <View style={{ flexDirection: 'row', gap: 8 }}>
          <TextInput style={[s.input, { flex: 1 }]} placeholder="Brand (optional)" placeholderTextColor={C.sub}
            value={tBrand} onChangeText={setTBrand} />
          <TextInput style={[s.input, { width: 80 }]} placeholder="Qty" placeholderTextColor={C.sub}
            keyboardType="numeric" value={tQty} onChangeText={setTQty} />
        </View>
        <TextInput style={s.input} placeholder="Note (e.g. small pack)" placeholderTextColor={C.sub}
          value={tNote} onChangeText={setTNote} />
        <TouchableOpacity style={s.primaryBtn} onPress={() => {
          if (!tName.trim()) return;
          add(tName.trim(), tBrand.trim(), Math.max(1, num(tQty)), 0, tNote.trim());
          setTName(''); setTBrand(''); setTQty('1'); setTNote('');
        }}>
          <Ionicons name="add" size={18} color="#fff" />
          <Text style={s.primaryBtnText}>Add to Order</Text>
        </TouchableOpacity>
      </View>

      <Text style={s.sectionLabel}>Catalog</Text>
      {loading && <ActivityIndicator color={C.green} style={{ marginTop: 16 }} />}
      {!loading && filtered.length === 0 && <Empty icon="pricetags-outline" text="No listed products. Use “Type any product” above." />}
      {filtered.map((p) => (
        <View key={p.id} style={s.card}>
          <View style={{ flex: 1 }}>
            <Text style={s.cardTitle}>{p.name}{p.unit ? ` · ${p.unit}` : ''}</Text>
            <Text style={s.cardSub}>{[p.brand, p.category].filter(Boolean).join(' · ')}</Text>
            <Text style={s.price}>{formatINR(p.price)}{!p.inStock ? '  ·  Out of stock' : ''}</Text>
          </View>
          <TouchableOpacity style={[s.addBtn, !p.inStock && { opacity: 0.4 }]} disabled={!p.inStock}
            onPress={() => add(p.name, p.brand, 1, p.price, '')}>
            <Text style={s.addBtnText}>Add</Text>
          </TouchableOpacity>
        </View>
      ))}

      {cart.length > 0 && (
        <TouchableOpacity style={s.stickyCart} onPress={onCart}>
          <Text style={s.stickyCartText}>View Cart ({cart.length})</Text>
          <Text style={s.stickyCartText}>{formatINR(cartTotal(cart))}</Text>
        </TouchableOpacity>
      )}
    </ScrollView>
  );
}

function CartView({ shop, cart, setCart, onPlaced, coupons }: {
  shop: SB.Shop; cart: CartItem[]; setCart: (c: CartItem[]) => void;
  onPlaced: (id: string) => void; coupons: SB.Coupon[];
}) {
  const [note, setNote] = useState('');
  const [placing, setPlacing] = useState(false);
  const [couponInput, setCouponInput] = useState('');
  const [applied, setApplied] = useState<SB.Coupon | null>(null);
  const [couponMsg, setCouponMsg] = useState('');
  const [delivery, setDelivery] = useState(false);
  const [address, setAddress] = useState('');

  const setQty = (key: string, d: number) =>
    setCart(cart.map((it) => it.key === key ? { ...it, qty: Math.max(1, it.qty + d) } : it));
  const remove = (key: string) => setCart(cart.filter((it) => it.key !== key));

  const subtotal = cartTotal(cart);
  const discount = couponDiscount(subtotal, applied);
  const deliveryFee = delivery && shop.delivery ? shop.deliveryFee : 0;
  const total = Math.max(0, subtotal - discount) + deliveryFee;

  const applyCoupon = () => {
    const code = couponInput.trim().toUpperCase();
    const found = coupons.find((c2) => c2.code.toUpperCase() === code);
    if (!found) { setCouponMsg('Invalid code'); setApplied(null); return; }
    if (subtotal < found.minOrder) { setCouponMsg(`Min order ${formatINR(found.minOrder)}`); setApplied(null); return; }
    setApplied(found); setCouponMsg(`Applied · ${couponLabel(found)}`);
  };

  const place = async () => {
    if (cart.length === 0) return;
    setPlacing(true);
    try {
      const res = await SB.placeOrder(
        shop.id,
        cart.map((it) => ({ name: it.name, brand: it.brand, qty: it.qty, price: it.price, note: it.note })),
        note.trim(),
        { couponCode: applied?.code, delivery: delivery && shop.delivery, address: address.trim() },
      );
      onPlaced(res.id);
    } catch (e: any) {
      Alert.alert('Could not place order', e?.message ?? 'Try again.');
    } finally { setPlacing(false); }
  };

  return (
    <ScrollView contentContainerStyle={s.body} keyboardShouldPersistTaps="handled">
      <Text style={s.sectionLabel}>Review order · {shop.name}</Text>
      {cart.map((it) => (
        <View key={it.key} style={s.card}>
          <View style={{ flex: 1 }}>
            <Text style={s.cardTitle}>{it.name}{it.brand ? ` (${it.brand})` : ''}</Text>
            {!!it.note && <Text style={s.cardSub}>📝 {it.note}</Text>}
            <Text style={s.price}>{it.price > 0 ? formatINR(it.price) : 'Price on confirm'}</Text>
          </View>
          <View style={s.qtyRow}>
            <TouchableOpacity style={s.qtyBtn} onPress={() => setQty(it.key, -1)}><Text style={s.qtyBtnText}>−</Text></TouchableOpacity>
            <Text style={s.qtyText}>{it.qty}</Text>
            <TouchableOpacity style={s.qtyBtn} onPress={() => setQty(it.key, 1)}><Text style={s.qtyBtnText}>+</Text></TouchableOpacity>
            <TouchableOpacity onPress={() => remove(it.key)} style={{ marginLeft: 8 }}>
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
              autoCapitalize="characters" value={couponInput} onChangeText={setCouponInput} />
            <TouchableOpacity style={[s.outlineBtn, { marginTop: 0, paddingHorizontal: 18 }]} onPress={applyCoupon}>
              <Text style={s.outlineBtnText}>Apply</Text>
            </TouchableOpacity>
          </View>
          {!!couponMsg && <Text style={[s.hint, { color: applied ? C.green : C.danger }]}>{couponMsg}</Text>}

          {/* Delivery */}
          {shop.delivery && (
            <>
              <ToggleRow label={`Home delivery ${shop.deliveryFee > 0 ? `(${formatINR(shop.deliveryFee)})` : '(Free)'}`} value={delivery} onChange={setDelivery} />
              {delivery && (
                <TextInput style={s.input} placeholder="Delivery address" placeholderTextColor={C.sub}
                  value={address} onChangeText={setAddress} />
              )}
            </>
          )}

          <TextInput style={s.input} placeholder="Order note (e.g. deliver before 8 PM)" placeholderTextColor={C.sub}
            value={note} onChangeText={setNote} />

          {/* Totals */}
          <View style={s.panel}>
            <Row label="Subtotal" value={formatINR(subtotal)} />
            {discount > 0 && <Row label={`Discount (${applied?.code})`} value={`− ${formatINR(discount)}`} tone={C.green} />}
            {deliveryFee > 0 && <Row label="Delivery" value={formatINR(deliveryFee)} />}
            <View style={{ height: 1, backgroundColor: C.border, marginVertical: 6 }} />
            <Row label="Total" value={formatINR(total)} bold />
          </View>

          <TouchableOpacity style={[s.primaryBtn, placing && { opacity: 0.6 }]} disabled={placing} onPress={place}>
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

function Row({ label, value, tone, bold }: { label: string; value: string; tone?: string; bold?: boolean }) {
  return (
    <View style={{ flexDirection: 'row', justifyContent: 'space-between', paddingVertical: 3 }}>
      <Text style={[{ color: C.sub, fontSize: 14 }, bold && { color: C.text, fontWeight: '800', fontSize: 16 }]}>{label}</Text>
      <Text style={[{ color: tone ?? C.text, fontSize: 14, fontWeight: '600' }, bold && { fontWeight: '800', fontSize: 16 }]}>{value}</Text>
    </View>
  );
}

function MyOrders({ onOpen }: { onOpen: (id: string) => void }) {
  const [loading, setLoading] = useState(true);
  const [orders, setOrders] = useState<SB.OrderSummary[]>([]);
  const load = useCallback(async () => {
    setLoading(true);
    try { setOrders(await SB.myOrders()); } catch {} finally { setLoading(false); }
  }, []);
  useEffect(() => { load(); }, [load]);

  return (
    <ScrollView contentContainerStyle={s.body}
      refreshControl={<RefreshControl refreshing={loading} onRefresh={load} tintColor={C.green} />}>
      <Text style={s.sectionLabel}>My Orders</Text>
      {loading && <ActivityIndicator color={C.green} style={{ marginTop: 16 }} />}
      {!loading && orders.length === 0 && <Empty icon="receipt-outline" text="No orders yet." />}
      {orders.map((o) => (
        <TouchableOpacity key={o.id} style={s.card} onPress={() => onOpen(o.id)}>
          <View style={{ flex: 1 }}>
            <Text style={s.cardTitle}>{o.shopName}</Text>
            <Text style={s.cardSub}>{o.id.slice(0, 8).toUpperCase()} · {formatINR(o.total)}</Text>
            <StatusPill status={o.status} />
          </View>
          <Ionicons name="chevron-forward" size={20} color={C.sub} />
        </TouchableOpacity>
      ))}
    </ScrollView>
  );
}

function OrderTrack({ orderId, onBack }: { orderId: string; onBack: () => void }) {
  const [loading, setLoading] = useState(true);
  const [order, setOrder] = useState<SB.OrderDetail | null>(null);
  const [stars, setStars] = useState(0);
  const [review, setReview] = useState('');
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try { setOrder(await SB.orderDetails(orderId)); } catch {} finally { setLoading(false); }
  }, [orderId]);
  useEffect(() => { load(); }, [load]);

  const decide = async (itemId: string, accept: boolean) => {
    try { await SB.decideAlternative(orderId, itemId, accept); load(); }
    catch (e: any) { Alert.alert('Error', e?.message ?? 'Try again'); }
  };

  const submitRating = async () => {
    if (stars < 1) { Alert.alert('Tap a star to rate'); return; }
    setBusy(true);
    try { await SB.rateOrder(orderId, stars, review.trim()); load(); }
    catch (e: any) { Alert.alert('Error', e?.message ?? 'Try again'); }
    finally { setBusy(false); }
  };

  const repeat = async () => {
    if (!order) return;
    setBusy(true);
    try {
      await SB.placeOrder(order.shopId,
        order.items.map((it) => ({ name: it.name, brand: it.brand, qty: it.qty, price: it.price, note: it.note })),
        'Repeat order');
      Alert.alert('Order placed', 'Your repeat order was sent to the shop.');
    } catch (e: any) { Alert.alert('Error', e?.message ?? 'Try again'); }
    finally { setBusy(false); }
  };

  const share = async () => {
    if (!order) return;
    const lines = order.items.map((it) => `• ${it.name}${it.brand ? ` (${it.brand})` : ''} × ${it.qty}`);
    await Share.share({
      message: `🛍️ Shop Book order ${order.id.slice(0, 8).toUpperCase()}\n${lines.join('\n')}\nTotal: ${formatINR(order.total)}`,
    }).catch(() => {});
  };

  return (
    <>
      <SubHeader title="Track Order" onBack={onBack}
        right={order ? { icon: 'share-social-outline', onPress: share } : undefined} />
      <ScrollView contentContainerStyle={s.body}
        refreshControl={<RefreshControl refreshing={loading} onRefresh={load} tintColor={C.green} />}>
        {loading && !order && <ActivityIndicator color={C.green} style={{ marginTop: 24 }} />}
        {order && (
          <>
            <StatusPill status={order.status} big />
            {/* progress steps */}
            <View style={s.stepper}>
              {ORDER_STEPS.map((step, i) => {
                const done = orderProgress(order.status) >= i / (ORDER_STEPS.length - 1);
                return (
                  <View key={step} style={{ alignItems: 'center', flex: 1 }}>
                    <View style={[s.stepDot, done && s.stepDotDone]}>
                      {done && <Ionicons name="checkmark" size={12} color="#fff" />}
                    </View>
                    <Text style={s.stepLabel}>{orderStatusLabel(step)}</Text>
                  </View>
                );
              })}
            </View>

            <Text style={s.sectionLabel}>Items</Text>
            {order.items.map((it) => (
              <View key={it.id} style={s.card}>
                <View style={{ flex: 1 }}>
                  <Text style={s.cardTitle}>{it.name}{it.brand ? ` (${it.brand})` : ''} × {it.qty}</Text>
                  {!!it.note && <Text style={s.cardSub}>📝 {it.note}</Text>}
                  <AvailabilityTag a={it.availability} altName={it.altName} />
                  {it.availability === 'alternative' && (
                    <View style={{ flexDirection: 'row', gap: 8, marginTop: 8 }}>
                      <TouchableOpacity style={s.smallGreen} onPress={() => decide(it.id, true)}>
                        <Text style={s.smallGreenText}>Accept {it.altName}</Text>
                      </TouchableOpacity>
                      <TouchableOpacity style={s.smallOutline} onPress={() => decide(it.id, false)}>
                        <Text style={s.smallOutlineText}>Reject</Text>
                      </TouchableOpacity>
                    </View>
                  )}
                </View>
                <Text style={s.price}>{it.price > 0 ? formatINR(it.price * it.qty) : '—'}</Text>
              </View>
            ))}

            <View style={s.panel}>
              {order.discount > 0 && <Row label={`Discount (${order.couponCode})`} value={`− ${formatINR(order.discount)}`} tone={C.green} />}
              {order.delivery && <Row label="Delivery" value={formatINR(order.deliveryFee)} />}
              <Row label="Total" value={formatINR(order.total)} bold />
            </View>

            {/* Repeat + Share */}
            <View style={{ flexDirection: 'row', gap: 8 }}>
              <TouchableOpacity style={[s.outlineBtn, { flex: 1 }]} disabled={busy} onPress={repeat}>
                <Ionicons name="repeat" size={18} color={C.green} />
                <Text style={s.outlineBtnText}>Repeat order</Text>
              </TouchableOpacity>
              <TouchableOpacity style={[s.outlineBtn, { flex: 1 }]} onPress={share}>
                <Ionicons name="share-social-outline" size={18} color={C.green} />
                <Text style={s.outlineBtnText}>Share</Text>
              </TouchableOpacity>
            </View>

            {/* Rating */}
            {order.status === 'completed' && (
              order.rated ? (
                <View style={[s.panel, { alignItems: 'center' }]}>
                  <Text style={{ color: C.green, fontWeight: '700' }}>✓ Thanks for rating this order</Text>
                </View>
              ) : (
                <View style={s.panel}>
                  <Text style={s.panelTitle}>Rate this order</Text>
                  <View style={{ flexDirection: 'row', gap: 6, marginVertical: 8 }}>
                    {[1, 2, 3, 4, 5].map((n) => (
                      <TouchableOpacity key={n} onPress={() => setStars(n)}>
                        <Ionicons name={n <= stars ? 'star' : 'star-outline'} size={30} color={C.amber} />
                      </TouchableOpacity>
                    ))}
                  </View>
                  <TextInput style={s.input} placeholder="Write a review (optional)" placeholderTextColor={C.sub}
                    value={review} onChangeText={setReview} />
                  <TouchableOpacity style={[s.primaryBtn, busy && { opacity: 0.6 }]} disabled={busy} onPress={submitRating}>
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

function CustomerLedgerView({ shop, onBack }: { shop: SB.Shop; onBack: () => void }) {
  const [loading, setLoading] = useState(true);
  const [ledger, setLedger] = useState<SB.Ledger | null>(null);
  useEffect(() => { (async () => {
    try { setLedger(await SB.customerLedger(shop.id)); } catch {} finally { setLoading(false); }
  })(); }, [shop.id]);

  return (
    <>
      <SubHeader title={`Ledger · ${shop.name}`} onBack={onBack} />
      <ScrollView contentContainerStyle={s.body}>
        {loading && <ActivityIndicator color={C.green} style={{ marginTop: 24 }} />}
        {ledger && (
          <>
            <View style={{ flexDirection: 'row', gap: 10 }}>
              <StatCard label="Total Pending" value={formatINR(ledger.pending)} tone="danger" />
              <StatCard label="Total Paid" value={formatINR(ledger.totalPaid)} tone="green" />
            </View>
            <Text style={s.sectionLabel}>Transactions</Text>
            {ledger.entries.length === 0 && <Empty icon="book-outline" text="No transactions yet." />}
            {ledger.entries.map((e) => (
              <LedgerRow key={e.id} entry={e} />
            ))}
          </>
        )}
      </ScrollView>
    </>
  );
}

function CustomerProfile({ me }: { me: { id: string; name: string } | null }) {
  const [loyalty, setLoyalty] = useState<SB.Loyalty | null>(null);
  const [lists, setLists] = useState<ShopList[]>([]);
  const [newName, setNewName] = useState('');
  const [newItems, setNewItems] = useState('');
  const [adding, setAdding] = useState(false);

  const loadLists = useCallback(async () => {
    if (!me) return;
    try { setLists(await listShopLists(me.id)); } catch {}
  }, [me]);

  useEffect(() => { (async () => {
    try { setLoyalty(await SB.loyalty()); } catch {}
    loadLists();
  })(); }, [loadLists]);

  const addList = async () => {
    if (!me || !newName.trim()) return;
    await saveShopList({ user_id: me.id, name: newName.trim(), items: newItems.trim() });
    setNewName(''); setNewItems(''); setAdding(false); loadLists();
  };

  const removeList = async (id: string) => { await deleteShopList(id); loadLists(); };

  const shareList = async (l: ShopList) => {
    await Share.share({ message: `🛒 ${l.name}\n${l.items}` }).catch(() => {});
  };

  return (
    <ScrollView contentContainerStyle={s.body} keyboardShouldPersistTaps="handled">
      <View style={s.card}>
        <View style={s.shopIcon}><Ionicons name="person" size={22} color={C.green} /></View>
        <View style={{ flex: 1 }}>
          <Text style={s.cardTitle}>{me?.name ?? 'You'}</Text>
          <Text style={s.cardSub}>Customer · Always free</Text>
        </View>
      </View>

      {/* Loyalty */}
      <View style={s.loyaltyCard}>
        <View style={{ flex: 1 }}>
          <Text style={s.loyaltyPoints}>{loyalty?.points ?? 0} pts</Text>
          <Text style={s.loyaltyTier}>{loyaltyTier(loyalty?.points ?? 0)} member</Text>
        </View>
        <View style={{ alignItems: 'flex-end' }}>
          <Text style={s.loyaltySub}>{loyalty?.completedOrders ?? 0} orders</Text>
          <Text style={s.loyaltySub}>Spent {formatINR(loyalty?.totalSpent ?? 0)}</Text>
        </View>
      </View>
      <Text style={s.hint}>Earn 1 point for every ₹100 spent on completed orders.</Text>

      {/* Shopping lists */}
      <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginTop: 10 }}>
        <Text style={s.sectionLabel}>🛒 Shopping Lists</Text>
        <TouchableOpacity onPress={() => setAdding((v) => !v)}>
          <Ionicons name={adding ? 'close' : 'add-circle'} size={26} color={C.green} />
        </TouchableOpacity>
      </View>
      {adding && (
        <View style={s.panel}>
          <TextInput style={s.input} placeholder="List name (e.g. Monthly groceries)" placeholderTextColor={C.sub}
            value={newName} onChangeText={setNewName} />
          <TextInput style={[s.input, { height: 90, textAlignVertical: 'top' }]} multiline
            placeholder={'Items, one per line:\nAtta 5kg\nSugar 1kg\nOil 1L'} placeholderTextColor={C.sub}
            value={newItems} onChangeText={setNewItems} />
          <TouchableOpacity style={s.primaryBtn} onPress={addList}><Text style={s.primaryBtnText}>Save List</Text></TouchableOpacity>
        </View>
      )}
      {lists.length === 0 && !adding && <Empty icon="list-outline" text="No saved lists yet." />}
      {lists.map((l) => (
        <View key={l.id} style={s.card}>
          <View style={{ flex: 1 }}>
            <Text style={s.cardTitle}>{l.name}</Text>
            <Text style={s.cardSub} numberOfLines={2}>{l.items.split('\n').filter(Boolean).join(' · ') || 'Empty'}</Text>
          </View>
          <TouchableOpacity onPress={() => shareList(l)} hitSlop={8} style={{ padding: 4 }}>
            <Ionicons name="share-social-outline" size={20} color={C.green} />
          </TouchableOpacity>
          <TouchableOpacity onPress={() => removeList(l.id)} hitSlop={8} style={{ padding: 4 }}>
            <Ionicons name="trash-outline" size={20} color={C.danger} />
          </TouchableOpacity>
        </View>
      ))}
    </ScrollView>
  );
}

// ════════════════════════════════════════════════════════════════
//  SHOP OWNER
// ════════════════════════════════════════════════════════════════
function OwnerApp({ me }: { me: { id: string; name: string } | null }) {
  const [tab, setTab] = useState<OwnerTab>('dashboard');
  const [loading, setLoading] = useState(true);
  const [shop, setShop] = useState<SB.Shop | null>(null);
  const [settings, setSettings] = useState(false);
  const [sub, setSub] = useState<'coupons' | 'suppliers' | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try { setShop(await SB.myShop()); } catch {} finally { setLoading(false); }
  }, []);
  useEffect(() => { load(); }, [load]);

  if (loading) return <ActivityIndicator color={C.green} style={{ marginTop: 40 }} />;

  // No shop yet → force settings/create.
  if (!shop || settings) {
    return (
      <ShopSettings shop={shop} me={me}
        onSaved={(sh) => { setShop(sh); setSettings(false); }}
        onCancel={shop ? () => setSettings(false) : undefined}
      />
    );
  }

  if (sub === 'coupons') return <OwnerCoupons onBack={() => setSub(null)} />;
  if (sub === 'suppliers') return <OwnerSuppliers onBack={() => setSub(null)} />;

  return (
    <>
      <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
        {tab === 'dashboard' && (
          <OwnerDashboard shop={shop} onSettings={() => setSettings(true)}
            onCoupons={() => setSub('coupons')} onSuppliers={() => setSub('suppliers')} />
        )}
        {tab === 'orders' && <OwnerOrders />}
        {tab === 'products' && <OwnerProducts />}
        {tab === 'khata' && <OwnerKhata />}
      </KeyboardAvoidingView>
      <TabBar
        tabs={[
          { id: 'dashboard', label: 'Home', icon: 'grid' },
          { id: 'orders', label: 'Orders', icon: 'receipt' },
          { id: 'products', label: 'Products', icon: 'pricetags' },
          { id: 'khata', label: 'Khata', icon: 'book' },
        ]}
        active={tab}
        onChange={(t) => setTab(t as OwnerTab)}
      />
    </>
  );
}

function OwnerDashboard({ shop, onSettings, onCoupons, onSuppliers }: {
  shop: SB.Shop; onSettings: () => void; onCoupons: () => void; onSuppliers: () => void;
}) {
  const [loading, setLoading] = useState(true);
  const [d, setD] = useState<SB.Dashboard | null>(null);
  const load = useCallback(async () => {
    setLoading(true);
    try { setD(await SB.dashboard()); } catch {} finally { setLoading(false); }
  }, []);
  useEffect(() => { load(); }, [load]);
  const st = shopOpenState(shop.openTime, shop.closeTime, shop.status);

  return (
    <ScrollView contentContainerStyle={s.body}
      refreshControl={<RefreshControl refreshing={loading} onRefresh={load} tintColor={C.green} />}>
      <TouchableOpacity style={s.card} onPress={onSettings}>
        <View style={s.shopIcon}><Text style={{ fontSize: 22 }}>{categoryIcon(shop.category)}</Text></View>
        <View style={{ flex: 1 }}>
          <Text style={s.cardTitle}>{shop.name}</Text>
          <Text style={s.cardSub}>
            {shop.ratingCount > 0 ? `⭐ ${shop.rating} (${shop.ratingCount})` : 'No ratings yet'}
            {shop.delivery ? '  ·  🛵 Delivery on' : ''}
          </Text>
          <View style={[s.badge, st.tone === 'open' ? s.badgeOpen : st.tone === 'soon' ? s.badgeSoon : s.badgeClosed]}>
            <Text style={[s.badgeText, st.tone === 'closed' && { color: C.danger }]}>{st.label}</Text>
          </View>
        </View>
        <Ionicons name="settings-outline" size={20} color={C.sub} />
      </TouchableOpacity>

      <View style={s.statGrid}>
        <StatCard label="Today's Orders" value={String(d?.todayOrders ?? 0)} tone="navy" />
        <StatCard label="Today's Sales" value={formatINR(d?.todaySales ?? 0)} tone="green" />
        <StatCard label="Pending Orders" value={String(d?.pendingOrders ?? 0)} tone="amber" />
        <StatCard label="Total Pending" value={formatINR(d?.totalPending ?? 0)} tone="danger" />
      </View>
      {(d?.lowStock ?? 0) > 0 && (
        <View style={[s.panel, { borderColor: C.amber }]}>
          <Text style={{ color: C.amber, fontWeight: '700' }}>⚠️ {d?.lowStock} product(s) out of stock</Text>
        </View>
      )}

      {/* Phase 2 quick links */}
      <View style={{ flexDirection: 'row', gap: 10, marginTop: 4 }}>
        <TouchableOpacity style={s.linkCard} onPress={onCoupons}>
          <Text style={{ fontSize: 24 }}>🏷️</Text>
          <Text style={s.linkCardText}>Offers & Coupons</Text>
        </TouchableOpacity>
        <TouchableOpacity style={s.linkCard} onPress={onSuppliers}>
          <Text style={{ fontSize: 24 }}>🚚</Text>
          <Text style={s.linkCardText}>Suppliers</Text>
        </TouchableOpacity>
      </View>
    </ScrollView>
  );
}

function OwnerCoupons({ onBack }: { onBack: () => void }) {
  const [loading, setLoading] = useState(true);
  const [coupons, setCoupons] = useState<SB.Coupon[]>([]);
  const [code, setCode] = useState('');
  const [kind, setKind] = useState<'percent' | 'flat'>('percent');
  const [value, setValue] = useState('');
  const [minOrder, setMinOrder] = useState('');
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try { setCoupons(await SB.ownerCoupons()); } catch {} finally { setLoading(false); }
  }, []);
  useEffect(() => { load(); }, [load]);

  const add = async () => {
    if (!code.trim() || num(value) <= 0) { Alert.alert('Enter code and value'); return; }
    setBusy(true);
    try {
      await SB.saveCoupon({ code: code.trim(), kind, value: num(value), minOrder: num(minOrder), active: true });
      setCode(''); setValue(''); setMinOrder(''); load();
    } catch (e: any) { Alert.alert('Error', e?.message ?? 'Try again'); }
    finally { setBusy(false); }
  };

  const remove = async (id?: string) => { if (!id) return; await SB.deleteCoupon(id); load(); };

  return (
    <>
      <SubHeader title="Offers & Coupons" onBack={onBack} />
      <ScrollView contentContainerStyle={s.body} keyboardShouldPersistTaps="handled"
        refreshControl={<RefreshControl refreshing={loading} onRefresh={load} tintColor={C.green} />}>
        <View style={s.panel}>
          <Text style={s.panelTitle}>New coupon</Text>
          <TextInput style={s.input} placeholder="Code (e.g. SAVE10)" placeholderTextColor={C.sub}
            autoCapitalize="characters" value={code} onChangeText={setCode} />
          <View style={{ flexDirection: 'row', gap: 8, marginBottom: 8 }}>
            <TouchableOpacity style={[s.statusBtn, kind === 'percent' && s.statusBtnActive]} onPress={() => setKind('percent')}>
              <Text style={[s.statusBtnText, kind === 'percent' && { color: '#fff' }]}>% Percent</Text>
            </TouchableOpacity>
            <TouchableOpacity style={[s.statusBtn, kind === 'flat' && s.statusBtnActive]} onPress={() => setKind('flat')}>
              <Text style={[s.statusBtnText, kind === 'flat' && { color: '#fff' }]}>₹ Flat</Text>
            </TouchableOpacity>
          </View>
          <View style={{ flexDirection: 'row', gap: 8 }}>
            <TextInput style={[s.input, { flex: 1 }]} placeholder={kind === 'percent' ? 'Percent off' : 'Rupees off'}
              placeholderTextColor={C.sub} keyboardType="numeric" value={value} onChangeText={setValue} />
            <TextInput style={[s.input, { flex: 1 }]} placeholder="Min order ₹" placeholderTextColor={C.sub}
              keyboardType="numeric" value={minOrder} onChangeText={setMinOrder} />
          </View>
          <TouchableOpacity style={[s.primaryBtn, busy && { opacity: 0.6 }]} disabled={busy} onPress={add}>
            <Text style={s.primaryBtnText}>Add Coupon</Text>
          </TouchableOpacity>
        </View>

        <Text style={s.sectionLabel}>Active coupons</Text>
        {loading && <ActivityIndicator color={C.green} />}
        {!loading && coupons.length === 0 && <Empty icon="pricetag-outline" text="No coupons yet." />}
        {coupons.map((c2) => (
          <View key={c2.id} style={s.card}>
            <View style={s.couponCode}><Text style={s.couponCodeText}>{c2.code}</Text></View>
            <View style={{ flex: 1 }}>
              <Text style={s.cardTitle}>{couponLabel(c2)}</Text>
              <Text style={s.cardSub}>{c2.active ? 'Active' : 'Inactive'}</Text>
            </View>
            <TouchableOpacity onPress={() => remove(c2.id)} hitSlop={8} style={{ padding: 4 }}>
              <Ionicons name="trash-outline" size={20} color={C.danger} />
            </TouchableOpacity>
          </View>
        ))}
      </ScrollView>
    </>
  );
}

function OwnerSuppliers({ onBack }: { onBack: () => void }) {
  const [loading, setLoading] = useState(true);
  const [suppliers, setSuppliers] = useState<SB.Supplier[]>([]);
  const [name, setName] = useState('');
  const [phone, setPhone] = useState('');
  const [items, setItems] = useState('');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try { setSuppliers(await SB.suppliers()); } catch {} finally { setLoading(false); }
  }, []);
  useEffect(() => { load(); }, [load]);

  const add = async () => {
    if (!name.trim()) { Alert.alert('Enter supplier name'); return; }
    setBusy(true);
    try {
      await SB.saveSupplier({ name: name.trim(), phone: phone.trim(), items: items.trim(), note: note.trim() });
      setName(''); setPhone(''); setItems(''); setNote(''); load();
    } catch (e: any) { Alert.alert('Error', e?.message ?? 'Try again'); }
    finally { setBusy(false); }
  };

  const remove = async (id?: string) => { if (!id) return; await SB.deleteSupplier(id); load(); };

  return (
    <>
      <SubHeader title="Suppliers" onBack={onBack} />
      <ScrollView contentContainerStyle={s.body} keyboardShouldPersistTaps="handled"
        refreshControl={<RefreshControl refreshing={loading} onRefresh={load} tintColor={C.green} />}>
        <View style={s.panel}>
          <Text style={s.panelTitle}>New supplier</Text>
          <TextInput style={s.input} placeholder="Supplier / vendor name" placeholderTextColor={C.sub}
            value={name} onChangeText={setName} />
          <TextInput style={s.input} placeholder="Phone" placeholderTextColor={C.sub}
            keyboardType="phone-pad" value={phone} onChangeText={setPhone} />
          <TextInput style={s.input} placeholder="Items supplied (e.g. Atta, Rice, Oil)" placeholderTextColor={C.sub}
            value={items} onChangeText={setItems} />
          <TextInput style={s.input} placeholder="Note (optional)" placeholderTextColor={C.sub}
            value={note} onChangeText={setNote} />
          <TouchableOpacity style={[s.primaryBtn, busy && { opacity: 0.6 }]} disabled={busy} onPress={add}>
            <Text style={s.primaryBtnText}>Add Supplier</Text>
          </TouchableOpacity>
        </View>

        <Text style={s.sectionLabel}>My suppliers</Text>
        {loading && <ActivityIndicator color={C.green} />}
        {!loading && suppliers.length === 0 && <Empty icon="cube-outline" text="No suppliers yet." />}
        {suppliers.map((sup) => (
          <View key={sup.id} style={s.card}>
            <View style={s.shopIcon}><Ionicons name="cube" size={20} color={C.green} /></View>
            <View style={{ flex: 1 }}>
              <Text style={s.cardTitle}>{sup.name}</Text>
              {!!sup.phone && <Text style={s.cardSub}>📞 {sup.phone}</Text>}
              {!!sup.items && <Text style={s.cardSub}>{sup.items}</Text>}
            </View>
            <TouchableOpacity onPress={() => remove(sup.id)} hitSlop={8} style={{ padding: 4 }}>
              <Ionicons name="trash-outline" size={20} color={C.danger} />
            </TouchableOpacity>
          </View>
        ))}
      </ScrollView>
    </>
  );
}

const OWNER_ORDER_TABS: { id: string; label: string }[] = [
  { id: 'new', label: 'New' }, { id: 'preparing', label: 'Preparing' },
  { id: 'packing', label: 'Packing' }, { id: 'ready', label: 'Ready' },
  { id: 'completed', label: 'Completed' },
];

function OwnerOrders() {
  const [filter, setFilter] = useState('new');
  const [loading, setLoading] = useState(true);
  const [orders, setOrders] = useState<SB.OrderSummary[]>([]);
  const [open, setOpen] = useState<string | null>(null);

  const load = useCallback(async (f: string) => {
    setLoading(true);
    try { setOrders(await SB.ownerOrders(f)); } catch {} finally { setLoading(false); }
  }, []);
  useEffect(() => { load(filter); }, [filter, load]);

  if (open) return <OwnerOrderDetail orderId={open} onBack={() => { setOpen(null); load(filter); }} />;

  return (
    <>
      <ScrollView horizontal showsHorizontalScrollIndicator={false} style={s.filterBar} contentContainerStyle={{ paddingHorizontal: 12 }}>
        {OWNER_ORDER_TABS.map((t) => (
          <TouchableOpacity key={t.id} style={[s.filterChip, filter === t.id && s.filterChipActive]} onPress={() => setFilter(t.id)}>
            <Text style={[s.filterChipText, filter === t.id && s.filterChipTextActive]}>{t.label}</Text>
          </TouchableOpacity>
        ))}
      </ScrollView>
      <ScrollView contentContainerStyle={s.body}
        refreshControl={<RefreshControl refreshing={loading} onRefresh={() => load(filter)} tintColor={C.green} />}>
        {loading && <ActivityIndicator color={C.green} style={{ marginTop: 16 }} />}
        {!loading && orders.length === 0 && <Empty icon="receipt-outline" text={`No ${filter} orders.`} />}
        {orders.map((o) => (
          <TouchableOpacity key={o.id} style={s.card} onPress={() => setOpen(o.id)}>
            <View style={{ flex: 1 }}>
              <Text style={s.cardTitle}>{o.customerName || 'Customer'}</Text>
              <Text style={s.cardSub}>{o.id.slice(0, 8).toUpperCase()} · {formatINR(o.total)}</Text>
              <StatusPill status={o.status} />
            </View>
            <Ionicons name="chevron-forward" size={20} color={C.sub} />
          </TouchableOpacity>
        ))}
      </ScrollView>
    </>
  );
}

function OwnerOrderDetail({ orderId, onBack }: { orderId: string; onBack: () => void }) {
  const [loading, setLoading] = useState(true);
  const [order, setOrder] = useState<SB.OrderDetail | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try { setOrder(await SB.orderDetails(orderId)); } catch {} finally { setLoading(false); }
  }, [orderId]);
  useEffect(() => { load(); }, [load]);

  const setAvail = async (itemId: string, a: ItemAvailability, altName = '') => {
    try { await SB.setItemAvailability(orderId, itemId, a, altName); load(); }
    catch (e: any) { Alert.alert('Error', e?.message ?? 'Try again'); }
  };

  const suggestAlt = (itemId: string) => {
    Alert.prompt?.('Suggest alternative', 'Enter alternative product name', (text) => {
      if (text?.trim()) setAvail(itemId, 'alternative', text.trim());
    });
    // Android has no Alert.prompt — fall back to marking unavailable.
    if (Platform.OS === 'android') {
      Alert.alert('Alternative', 'Type-in alternatives use the item’s note flow on Android — marking as unavailable for now.',
        [{ text: 'OK', onPress: () => setAvail(itemId, 'unavailable') }]);
    }
  };

  const advance = async () => {
    if (!order) return;
    const next = nextOrderStatus(order.status);
    if (!next) return;
    setBusy(true);
    try { await SB.setOrderStatus(orderId, next); load(); }
    catch (e: any) { Alert.alert('Error', e?.message ?? 'Try again'); }
    finally { setBusy(false); }
  };

  const cancel = async () => {
    setBusy(true);
    try { await SB.setOrderStatus(orderId, 'cancelled'); load(); }
    catch {} finally { setBusy(false); }
  };

  const next = order ? nextOrderStatus(order.status) : null;

  return (
    <>
      <SubHeader title="Order" onBack={onBack} />
      <ScrollView contentContainerStyle={s.body}
        refreshControl={<RefreshControl refreshing={loading} onRefresh={load} tintColor={C.green} />}>
        {order && (
          <>
            <StatusPill status={order.status} big />
            {!!order.note && <Text style={s.hint}>📝 {order.note}</Text>}
            <Text style={s.sectionLabel}>Items — mark availability</Text>
            {order.items.map((it) => (
              <View key={it.id} style={s.card}>
                <View style={{ flex: 1 }}>
                  <Text style={s.cardTitle}>{it.name}{it.brand ? ` (${it.brand})` : ''} × {it.qty}</Text>
                  {!!it.note && <Text style={s.cardSub}>📝 {it.note}</Text>}
                  <AvailabilityTag a={it.availability} altName={it.altName} />
                  <View style={{ flexDirection: 'row', gap: 6, marginTop: 8, flexWrap: 'wrap' }}>
                    <TouchableOpacity style={s.smallGreen} onPress={() => setAvail(it.id, 'available')}>
                      <Text style={s.smallGreenText}>Available</Text>
                    </TouchableOpacity>
                    <TouchableOpacity style={s.smallOutline} onPress={() => setAvail(it.id, 'unavailable')}>
                      <Text style={s.smallOutlineText}>Not available</Text>
                    </TouchableOpacity>
                    <TouchableOpacity style={s.smallOutline} onPress={() => suggestAlt(it.id)}>
                      <Text style={s.smallOutlineText}>Suggest alt</Text>
                    </TouchableOpacity>
                  </View>
                </View>
              </View>
            ))}
            <View style={s.totalRow}>
              <Text style={s.totalLabel}>Total</Text>
              <Text style={s.totalValue}>{formatINR(order.total)}</Text>
            </View>

            {order.status !== 'completed' && order.status !== 'cancelled' && (
              <>
                {next && (
                  <TouchableOpacity style={[s.primaryBtn, busy && { opacity: 0.6 }]} disabled={busy} onPress={advance}>
                    <Ionicons name="arrow-forward-circle" size={18} color="#fff" />
                    <Text style={s.primaryBtnText}>Mark as {orderStatusLabel(next)}</Text>
                  </TouchableOpacity>
                )}
                <TouchableOpacity style={s.dangerBtn} disabled={busy} onPress={cancel}>
                  <Text style={s.dangerBtnText}>Reject / Cancel</Text>
                </TouchableOpacity>
              </>
            )}
          </>
        )}
      </ScrollView>
    </>
  );
}

function OwnerProducts() {
  const [loading, setLoading] = useState(true);
  const [products, setProducts] = useState<SB.Product[]>([]);
  const [edit, setEdit] = useState<SB.Product | 'new' | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try { setProducts(await SB.ownerProducts()); } catch {} finally { setLoading(false); }
  }, []);
  useEffect(() => { load(); }, [load]);

  if (edit) return <ProductEditor product={edit === 'new' ? null : edit} onDone={() => { setEdit(null); load(); }} />;

  return (
    <ScrollView contentContainerStyle={s.body}
      refreshControl={<RefreshControl refreshing={loading} onRefresh={load} tintColor={C.green} />}>
      <TouchableOpacity style={s.primaryBtn} onPress={() => setEdit('new')}>
        <Ionicons name="add" size={18} color="#fff" />
        <Text style={s.primaryBtnText}>Add Product</Text>
      </TouchableOpacity>
      {loading && <ActivityIndicator color={C.green} style={{ marginTop: 16 }} />}
      {!loading && products.length === 0 && <Empty icon="pricetags-outline" text="No products yet." />}
      {products.map((p) => (
        <TouchableOpacity key={p.id} style={s.card} onPress={() => setEdit(p)}>
          <View style={{ flex: 1 }}>
            <Text style={[s.cardTitle, !p.enabled && { color: C.sub }]}>{p.name}{p.unit ? ` · ${p.unit}` : ''}</Text>
            <Text style={s.cardSub}>{[p.brand, p.category].filter(Boolean).join(' · ')}</Text>
            <Text style={s.price}>{formatINR(p.price)} · {p.inStock ? 'In stock' : 'Out of stock'}{!p.enabled ? ' · Disabled' : ''}</Text>
          </View>
          <Ionicons name="create-outline" size={20} color={C.sub} />
        </TouchableOpacity>
      ))}
    </ScrollView>
  );
}

function ProductEditor({ product, onDone }: { product: SB.Product | null; onDone: () => void }) {
  const [name, setName] = useState(product?.name ?? '');
  const [brand, setBrand] = useState(product?.brand ?? '');
  const [category, setCategory] = useState(product?.category ?? '');
  const [unit, setUnit] = useState(product?.unit ?? '');
  const [price, setPrice] = useState(product ? String(product.price) : '');
  const [inStock, setInStock] = useState(product?.inStock ?? true);
  const [enabled, setEnabled] = useState(product?.enabled ?? true);
  const [busy, setBusy] = useState(false);

  const save = async () => {
    if (!name.trim()) { Alert.alert('Name required'); return; }
    setBusy(true);
    try {
      await SB.saveProduct({
        id: product?.id, name: name.trim(), brand: brand.trim(), category: category.trim(),
        unit: unit.trim(), price: num(price), inStock, enabled,
      });
      onDone();
    } catch (e: any) { Alert.alert('Error', e?.message ?? 'Try again'); }
    finally { setBusy(false); }
  };

  const del = async () => {
    if (!product) return;
    setBusy(true);
    try { await SB.deleteProduct(product.id); onDone(); }
    catch (e: any) { Alert.alert('Error', e?.message ?? 'Try again'); }
    finally { setBusy(false); }
  };

  return (
    <>
      <SubHeader title={product ? 'Edit Product' : 'Add Product'} onBack={onDone} />
      <ScrollView contentContainerStyle={s.body} keyboardShouldPersistTaps="handled">
        <Field label="Product name" value={name} onChange={setName} placeholder="Aashirvaad Atta" />
        <Field label="Brand (optional)" value={brand} onChange={setBrand} placeholder="Aashirvaad" />
        <Field label="Category" value={category} onChange={setCategory} placeholder="Groceries" />
        <Field label="Unit" value={unit} onChange={setUnit} placeholder="5kg" />
        <Field label="Price (₹)" value={price} onChange={setPrice} placeholder="285" keyboardType="numeric" />
        <ToggleRow label="In stock" value={inStock} onChange={setInStock} />
        <ToggleRow label="Enabled (visible to customers)" value={enabled} onChange={setEnabled} />
        <TouchableOpacity style={[s.primaryBtn, busy && { opacity: 0.6 }]} disabled={busy} onPress={save}>
          <Text style={s.primaryBtnText}>{product ? 'Save Changes' : 'Add Product'}</Text>
        </TouchableOpacity>
        {product && (
          <TouchableOpacity style={s.dangerBtn} disabled={busy} onPress={del}>
            <Text style={s.dangerBtnText}>Delete Product</Text>
          </TouchableOpacity>
        )}
      </ScrollView>
    </>
  );
}

function OwnerKhata() {
  const [loading, setLoading] = useState(true);
  const [customers, setCustomers] = useState<SB.CustomerPending[]>([]);
  const [sel, setSel] = useState<SB.CustomerPending | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try { setCustomers(await SB.ownerLedgerSummary()); } catch {} finally { setLoading(false); }
  }, []);
  useEffect(() => { load(); }, [load]);

  if (sel) return <KhataDetail customer={sel} onBack={() => { setSel(null); load(); }} />;

  return (
    <ScrollView contentContainerStyle={s.body}
      refreshControl={<RefreshControl refreshing={loading} onRefresh={load} tintColor={C.green} />}>
      <Text style={s.sectionLabel}>Customer Khata</Text>
      {loading && <ActivityIndicator color={C.green} style={{ marginTop: 16 }} />}
      {!loading && customers.length === 0 && <Empty icon="people-outline" text="No customer ledgers yet." />}
      {customers.map((c) => (
        <TouchableOpacity key={c.customerId} style={s.card} onPress={() => setSel(c)}>
          <View style={s.shopIcon}><Ionicons name="person" size={20} color={C.green} /></View>
          <View style={{ flex: 1 }}>
            <Text style={s.cardTitle}>{c.customerName || 'Customer'}</Text>
            <Text style={[s.price, { color: c.pending > 0 ? C.danger : C.green }]}>
              {c.pending > 0 ? `Pending ${formatINR(c.pending)}` : 'Settled'}
            </Text>
          </View>
          <Ionicons name="chevron-forward" size={20} color={C.sub} />
        </TouchableOpacity>
      ))}
    </ScrollView>
  );
}

function KhataDetail({ customer, onBack }: { customer: SB.CustomerPending; onBack: () => void }) {
  const [loading, setLoading] = useState(true);
  const [ledger, setLedger] = useState<SB.Ledger | null>(null);
  const [amount, setAmount] = useState('');
  const [remark, setRemark] = useState('');
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try { setLedger(await SB.ownerCustomerLedger(customer.customerId)); } catch {} finally { setLoading(false); }
  }, [customer.customerId]);
  useEffect(() => { load(); }, [load]);

  const add = async (type: 'purchase' | 'payment') => {
    const amt = num(amount);
    if (amt <= 0) { Alert.alert('Enter an amount'); return; }
    setBusy(true);
    try {
      await SB.addLedgerEntry(customer.customerId, type, amt, remark.trim());
      setAmount(''); setRemark(''); load();
    } catch (e: any) { Alert.alert('Error', e?.message ?? 'Try again'); }
    finally { setBusy(false); }
  };

  return (
    <>
      <SubHeader title={customer.customerName || 'Customer'} onBack={onBack} />
      <ScrollView contentContainerStyle={s.body} keyboardShouldPersistTaps="handled"
        refreshControl={<RefreshControl refreshing={loading} onRefresh={load} tintColor={C.green} />}>
        {ledger && (
          <View style={{ flexDirection: 'row', gap: 10 }}>
            <StatCard label="Pending" value={formatINR(ledger.pending)} tone="danger" />
            <StatCard label="Paid" value={formatINR(ledger.totalPaid)} tone="green" />
          </View>
        )}
        <View style={s.panel}>
          <Text style={s.panelTitle}>Add entry</Text>
          <TextInput style={s.input} placeholder="Amount (₹)" placeholderTextColor={C.sub}
            keyboardType="numeric" value={amount} onChangeText={setAmount} />
          <TextInput style={s.input} placeholder="Remark (optional)" placeholderTextColor={C.sub}
            value={remark} onChangeText={setRemark} />
          <View style={{ flexDirection: 'row', gap: 8 }}>
            <TouchableOpacity style={[s.primaryBtn, { flex: 1 }, busy && { opacity: 0.6 }]} disabled={busy} onPress={() => add('purchase')}>
              <Text style={s.primaryBtnText}>+ Purchase</Text>
            </TouchableOpacity>
            <TouchableOpacity style={[s.outlineBtn, { flex: 1 }]} disabled={busy} onPress={() => add('payment')}>
              <Text style={s.outlineBtnText}>+ Payment</Text>
            </TouchableOpacity>
          </View>
        </View>
        <Text style={s.sectionLabel}>History</Text>
        {ledger?.entries.length === 0 && <Empty icon="book-outline" text="No transactions yet." />}
        {ledger?.entries.map((e) => <LedgerRow key={e.id} entry={e} />)}
      </ScrollView>
    </>
  );
}

function ShopSettings({ shop, me, onSaved, onCancel }: {
  shop: SB.Shop | null; me: { id: string; name: string } | null;
  onSaved: (s: SB.Shop) => void; onCancel?: () => void;
}) {
  const [name, setName] = useState(shop?.name ?? '');
  const [category, setCategory] = useState(shop?.category ?? 'grocery');
  const [address, setAddress] = useState(shop?.address ?? '');
  const [phone, setPhone] = useState(shop?.phone ?? '');
  const [openTime, setOpenTime] = useState(shop?.openTime ?? '09:00');
  const [closeTime, setCloseTime] = useState(shop?.closeTime ?? '21:00');
  const [status, setStatus] = useState(shop?.status ?? 'open');
  const [pickup, setPickup] = useState(shop?.pickup ?? true);
  const [prep, setPrep] = useState(shop ? String(shop.prepMins) : '20');
  const [delivery, setDelivery] = useState(shop?.delivery ?? false);
  const [deliveryFee, setDeliveryFee] = useState(shop ? String(shop.deliveryFee) : '0');
  const [coords, setCoords] = useState<{ lat: number; lng: number } | null>(
    shop?.lat != null && shop?.lng != null ? { lat: shop.lat, lng: shop.lng } : null);
  const [busy, setBusy] = useState(false);

  const useLocation = async () => {
    try {
      const { status: perm } = await Location.requestForegroundPermissionsAsync();
      if (perm !== 'granted') { Alert.alert('Location permission needed'); return; }
      const pos = await Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.Balanced });
      setCoords({ lat: pos.coords.latitude, lng: pos.coords.longitude });
      Alert.alert('Location set', 'Your shop location was captured.');
    } catch { Alert.alert('Could not get location'); }
  };

  const save = async () => {
    if (!name.trim()) { Alert.alert('Shop name required'); return; }
    setBusy(true);
    try {
      await SB.saveShop({
        name: name.trim(), category, address: address.trim(), phone: phone.trim(),
        openTime: openTime.trim(), closeTime: closeTime.trim(), status,
        pickup, prepMins: num(prep), delivery, deliveryFee: num(deliveryFee),
        lat: coords?.lat ?? null, lng: coords?.lng ?? null,
      });
      const fresh = await SB.myShop();
      if (fresh) onSaved(fresh);
    } catch (e: any) { Alert.alert('Error', e?.message ?? 'Try again'); }
    finally { setBusy(false); }
  };

  return (
    <>
      <SubHeader title={shop ? 'Shop Settings' : 'Create Your Shop'} onBack={onCancel} />
      <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
        <ScrollView contentContainerStyle={s.body} keyboardShouldPersistTaps="handled">
          {!shop && <Text style={s.hint}>Set up your shop once — customers nearby can then find you and order.</Text>}
          <Field label="Shop name" value={name} onChange={setName} placeholder="Sri Lakshmi Kirana" />
          <Text style={s.fieldLabel}>Category</Text>
          <ScrollView horizontal showsHorizontalScrollIndicator={false} style={{ marginBottom: 8 }}>
            {SHOP_CATEGORIES.map((c2) => (
              <Chip key={c2.id} label={c2.label} icon={c2.icon} active={category === c2.id} onPress={() => setCategory(c2.id)} />
            ))}
          </ScrollView>
          <Field label="Address" value={address} onChange={setAddress} placeholder="#10, Main Road" />
          <Field label="Phone" value={phone} onChange={setPhone} placeholder="98765 43210" keyboardType="phone-pad" />
          <View style={{ flexDirection: 'row', gap: 8 }}>
            <View style={{ flex: 1 }}><Field label="Opens" value={openTime} onChange={setOpenTime} placeholder="09:00" /></View>
            <View style={{ flex: 1 }}><Field label="Closes" value={closeTime} onChange={setCloseTime} placeholder="21:00" /></View>
          </View>
          <Field label="Prep time (mins)" value={prep} onChange={setPrep} placeholder="20" keyboardType="numeric" />
          <ToggleRow label="Pickup available" value={pickup} onChange={setPickup} />
          <ToggleRow label="Home delivery" value={delivery} onChange={setDelivery} />
          {delivery && <Field label="Delivery fee (₹, 0 = free)" value={deliveryFee} onChange={setDeliveryFee} placeholder="0" keyboardType="numeric" />}

          <Text style={s.fieldLabel}>Shop status</Text>
          <View style={{ flexDirection: 'row', gap: 8, marginBottom: 8 }}>
            {(['open', 'busy', 'closed'] as const).map((st) => (
              <TouchableOpacity key={st} style={[s.statusBtn, status === st && s.statusBtnActive]} onPress={() => setStatus(st)}>
                <Text style={[s.statusBtnText, status === st && { color: '#fff' }]}>
                  {st === 'open' ? '🟢 Open' : st === 'busy' ? '🟡 Busy' : '🔴 Closed'}
                </Text>
              </TouchableOpacity>
            ))}
          </View>

          <TouchableOpacity style={s.outlineBtn} onPress={useLocation}>
            <Ionicons name="location" size={18} color={C.green} />
            <Text style={s.outlineBtnText}>{coords ? 'Location captured ✓ — update' : 'Use current location'}</Text>
          </TouchableOpacity>
          <TouchableOpacity style={[s.primaryBtn, busy && { opacity: 0.6 }]} disabled={busy} onPress={save}>
            {busy ? <ActivityIndicator color="#fff" /> : <Text style={s.primaryBtnText}>{shop ? 'Save Settings' : 'Create Shop'}</Text>}
          </TouchableOpacity>
        </ScrollView>
      </KeyboardAvoidingView>
    </>
  );
}

// ════════════════════════════════════════════════════════════════
//  shared bits
// ════════════════════════════════════════════════════════════════
function TabBar({ tabs, active, onChange }: {
  tabs: { id: string; label: string; icon: keyof typeof Ionicons.glyphMap }[];
  active: string; onChange: (id: string) => void;
}) {
  return (
    <View style={s.tabBar}>
      {tabs.map((t) => (
        <TouchableOpacity key={t.id} style={s.tab} onPress={() => onChange(t.id)}>
          <Ionicons name={t.icon} size={22} color={active === t.id ? C.green : C.sub} />
          <Text style={[s.tabLabel, active === t.id && { color: C.green, fontWeight: '700' }]}>{t.label}</Text>
        </TouchableOpacity>
      ))}
    </View>
  );
}

function SubHeader({ title, onBack, right }: {
  title: string; onBack?: () => void;
  right?: { icon: keyof typeof Ionicons.glyphMap; badge?: number; onPress: () => void };
}) {
  return (
    <View style={s.subHeader}>
      {onBack ? (
        <TouchableOpacity onPress={onBack} hitSlop={10} style={s.hBtn}>
          <Ionicons name="arrow-back" size={22} color={C.text} />
        </TouchableOpacity>
      ) : <View style={{ width: 38 }} />}
      <Text style={s.subHeaderTitle} numberOfLines={1}>{title}</Text>
      {right ? (
        <TouchableOpacity onPress={right.onPress} hitSlop={10} style={s.hBtn}>
          <Ionicons name={right.icon} size={22} color={C.text} />
          {!!right.badge && <View style={s.cartBadge}><Text style={s.cartBadgeText}>{right.badge}</Text></View>}
        </TouchableOpacity>
      ) : <View style={{ width: 38 }} />}
    </View>
  );
}

function Chip({ label, icon, active, onPress }: { label: string; icon: string; active: boolean; onPress: () => void }) {
  return (
    <TouchableOpacity style={[s.chip, active && s.chipActive]} onPress={onPress}>
      <Text style={{ fontSize: 13 }}>{icon}</Text>
      <Text style={[s.chipText, active && { color: '#fff' }]}>{label}</Text>
    </TouchableOpacity>
  );
}

function StatCard({ label, value, tone }: { label: string; value: string; tone: 'green' | 'navy' | 'amber' | 'danger' }) {
  const color = tone === 'green' ? C.green : tone === 'navy' ? C.navy : tone === 'amber' ? C.amber : C.danger;
  return (
    <View style={[s.statCard, { flex: 1 }]}>
      <Text style={[s.statValue, { color }]}>{value}</Text>
      <Text style={s.statLabel}>{label}</Text>
    </View>
  );
}

function InfoRow({ icon, label, value }: { icon: keyof typeof Ionicons.glyphMap; label: string; value: string }) {
  return (
    <View style={s.infoRow}>
      <Ionicons name={icon} size={18} color={C.sub} />
      <Text style={s.infoLabel}>{label}</Text>
      <Text style={s.infoValue} numberOfLines={2}>{value}</Text>
    </View>
  );
}

function Field({ label, value, onChange, placeholder, keyboardType }: {
  label: string; value: string; onChange: (t: string) => void; placeholder?: string;
  keyboardType?: 'default' | 'numeric' | 'phone-pad';
}) {
  return (
    <>
      <Text style={s.fieldLabel}>{label}</Text>
      <TextInput style={s.input} value={value} onChangeText={onChange} placeholder={placeholder}
        placeholderTextColor={C.sub} keyboardType={keyboardType ?? 'default'} />
    </>
  );
}

function ToggleRow({ label, value, onChange }: { label: string; value: boolean; onChange: (v: boolean) => void }) {
  return (
    <View style={s.toggleRow}>
      <Text style={s.toggleLabel}>{label}</Text>
      <Switch value={value} onValueChange={onChange} trackColor={{ true: C.green }} />
    </View>
  );
}

function StatusPill({ status, big }: { status: OrderStatus; big?: boolean }) {
  const done = status === 'completed', cancelled = status === 'cancelled';
  const color = cancelled ? C.danger : done ? C.green : C.blue;
  return (
    <View style={[s.pill, { backgroundColor: color + '20' }, big && { alignSelf: 'flex-start', marginBottom: 12 }]}>
      <View style={[s.pillDot, { backgroundColor: color }]} />
      <Text style={[s.pillText, { color }, big && { fontSize: 15 }]}>{orderStatusLabel(status)}</Text>
    </View>
  );
}

function AvailabilityTag({ a, altName }: { a: ItemAvailability; altName: string }) {
  if (a === 'pending') return <Text style={[s.availTag, { color: C.sub }]}>⏳ Awaiting shop</Text>;
  if (a === 'available') return <Text style={[s.availTag, { color: C.green }]}>✓ Available</Text>;
  if (a === 'unavailable') return <Text style={[s.availTag, { color: C.danger }]}>✕ Not available</Text>;
  return <Text style={[s.availTag, { color: C.amber }]}>🔁 Alternative: {altName}</Text>;
}

function LedgerRow({ entry }: { entry: SB.LedgerEntry }) {
  const isPay = entry.type === 'payment';
  return (
    <View style={s.card}>
      <View style={{ flex: 1 }}>
        <Text style={s.cardTitle}>{isPay ? 'Payment received' : 'Purchase'}</Text>
        <Text style={s.cardSub}>{new Date(entry.createdAt).toLocaleDateString('en-IN')}{entry.remark ? ` · ${entry.remark}` : ''}</Text>
      </View>
      <Text style={[s.price, { color: isPay ? C.green : C.danger }]}>
        {isPay ? '−' : '+'}{formatINR(entry.amount)}
      </Text>
    </View>
  );
}

function Empty({ icon, text }: { icon: keyof typeof Ionicons.glyphMap; text: string }) {
  return (
    <View style={s.empty}>
      <Ionicons name={icon} size={40} color={C.border} />
      <Text style={s.emptyText}>{text}</Text>
    </View>
  );
}

// ── styles ─────────────────────────────────────────────────────────
const s = StyleSheet.create({
  screen: { flex: 1, backgroundColor: C.bg },
  header: {
    flexDirection: 'row', alignItems: 'center', backgroundColor: C.green,
    paddingTop: 48, paddingBottom: 14, paddingHorizontal: 14, gap: 6,
  },
  hBtn: { width: 38, height: 38, borderRadius: 19, justifyContent: 'center', alignItems: 'center' },
  headerTitle: { color: '#fff', fontSize: 20, fontWeight: '800' },
  headerSub: { color: '#DCFCE7', fontSize: 12, marginTop: 1 },
  modeRow: { flexDirection: 'row', backgroundColor: C.greenDark, padding: 6, gap: 6 },
  modeBtn: {
    flex: 1, flexDirection: 'row', justifyContent: 'center', alignItems: 'center', gap: 6,
    paddingVertical: 9, borderRadius: 10, backgroundColor: '#fff',
  },
  modeBtnActive: { backgroundColor: C.navy },
  modeText: { color: C.green, fontWeight: '700', fontSize: 13 },
  modeTextActive: { color: '#fff' },

  subHeader: {
    flexDirection: 'row', alignItems: 'center', backgroundColor: C.card,
    paddingTop: 12, paddingBottom: 12, paddingHorizontal: 8,
    borderBottomWidth: 1, borderBottomColor: C.border,
  },
  subHeaderTitle: { flex: 1, textAlign: 'center', fontSize: 16, fontWeight: '700', color: C.text },
  cartBadge: {
    position: 'absolute', top: 2, right: 2, backgroundColor: C.danger,
    borderRadius: 9, minWidth: 18, height: 18, justifyContent: 'center', alignItems: 'center', paddingHorizontal: 4,
  },
  cartBadgeText: { color: '#fff', fontSize: 10, fontWeight: '800' },

  body: { padding: 14, paddingBottom: 32 },

  searchRow: {
    flexDirection: 'row', alignItems: 'center', gap: 8, backgroundColor: C.card,
    borderRadius: 12, paddingHorizontal: 12, borderWidth: 1, borderColor: C.border, marginBottom: 4,
  },
  searchInput: { flex: 1, paddingVertical: 11, color: C.text, fontSize: 14 },
  hint: { color: C.sub, fontSize: 12.5, marginVertical: 8, lineHeight: 18 },
  error: { color: C.danger, textAlign: 'center', marginTop: 16 },

  chip: {
    flexDirection: 'row', alignItems: 'center', gap: 5, backgroundColor: C.card,
    borderRadius: 20, paddingHorizontal: 12, paddingVertical: 7, marginRight: 8,
    borderWidth: 1, borderColor: C.border,
  },
  chipActive: { backgroundColor: C.green, borderColor: C.green },
  chipText: { color: C.text, fontSize: 12.5, fontWeight: '600' },

  card: {
    flexDirection: 'row', alignItems: 'center', gap: 12, backgroundColor: C.card,
    borderRadius: 14, padding: 14, marginBottom: 10, borderWidth: 1, borderColor: C.border,
  },
  shopIcon: {
    width: 46, height: 46, borderRadius: 12, backgroundColor: C.greenSoft,
    justifyContent: 'center', alignItems: 'center',
  },
  cardTitle: { color: C.text, fontSize: 15, fontWeight: '700' },
  cardSub: { color: C.sub, fontSize: 12.5, marginTop: 2 },
  price: { color: C.text, fontSize: 13.5, fontWeight: '700', marginTop: 4 },

  badge: { alignSelf: 'flex-start', borderRadius: 6, paddingHorizontal: 8, paddingVertical: 2, marginTop: 6 },
  badgeOpen: { backgroundColor: C.greenSoft },
  badgeSoon: { backgroundColor: '#FEF3C7' },
  badgeClosed: { backgroundColor: '#FEE2E2' },
  badgeText: { fontSize: 11, fontWeight: '700', color: C.green },

  addBtn: { backgroundColor: C.green, borderRadius: 10, paddingHorizontal: 16, paddingVertical: 9 },
  addBtnText: { color: '#fff', fontWeight: '700', fontSize: 13 },

  panel: { backgroundColor: C.card, borderRadius: 14, padding: 14, borderWidth: 1, borderColor: C.border, marginVertical: 8, gap: 8 },
  panelTitle: { color: C.text, fontSize: 14, fontWeight: '700' },
  sectionLabel: { color: C.text, fontSize: 15, fontWeight: '800', marginTop: 14, marginBottom: 8 },

  input: {
    backgroundColor: C.card, borderRadius: 10, borderWidth: 1, borderColor: C.border,
    paddingHorizontal: 12, paddingVertical: 11, color: C.text, fontSize: 14, marginBottom: 8,
  },
  fieldLabel: { color: C.sub, fontSize: 12.5, fontWeight: '600', marginBottom: 4 },

  primaryBtn: {
    flexDirection: 'row', justifyContent: 'center', alignItems: 'center', gap: 8,
    backgroundColor: C.green, borderRadius: 12, paddingVertical: 14, marginTop: 8,
  },
  primaryBtnText: { color: '#fff', fontWeight: '800', fontSize: 15 },
  outlineBtn: {
    flexDirection: 'row', justifyContent: 'center', alignItems: 'center', gap: 8,
    borderRadius: 12, paddingVertical: 13, marginTop: 8, borderWidth: 1.5, borderColor: C.green,
  },
  outlineBtnText: { color: C.green, fontWeight: '700', fontSize: 14 },
  dangerBtn: { alignItems: 'center', paddingVertical: 13, marginTop: 8 },
  dangerBtnText: { color: C.danger, fontWeight: '700', fontSize: 14 },

  smallGreen: { backgroundColor: C.green, borderRadius: 8, paddingHorizontal: 12, paddingVertical: 7 },
  smallGreenText: { color: '#fff', fontWeight: '700', fontSize: 12 },
  smallOutline: { borderRadius: 8, paddingHorizontal: 12, paddingVertical: 7, borderWidth: 1, borderColor: C.border },
  smallOutlineText: { color: C.text, fontWeight: '600', fontSize: 12 },

  stickyCart: {
    flexDirection: 'row', justifyContent: 'space-between', backgroundColor: C.navy,
    borderRadius: 12, paddingVertical: 14, paddingHorizontal: 18, marginTop: 12,
  },
  stickyCartText: { color: '#fff', fontWeight: '800', fontSize: 15 },

  qtyRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  qtyBtn: { width: 30, height: 30, borderRadius: 8, backgroundColor: C.greenSoft, justifyContent: 'center', alignItems: 'center' },
  qtyBtnText: { color: C.green, fontSize: 18, fontWeight: '800' },
  qtyText: { minWidth: 22, textAlign: 'center', fontSize: 15, fontWeight: '700', color: C.text },

  totalRow: {
    flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center',
    backgroundColor: C.card, borderRadius: 12, padding: 14, marginTop: 8, borderWidth: 1, borderColor: C.border,
  },
  totalLabel: { color: C.sub, fontSize: 14, fontWeight: '600' },
  totalValue: { color: C.text, fontSize: 18, fontWeight: '800' },

  statGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: 10, marginTop: 4 },
  statCard: {
    minWidth: '46%', backgroundColor: C.card, borderRadius: 14, padding: 14,
    borderWidth: 1, borderColor: C.border,
  },
  statValue: { fontSize: 20, fontWeight: '800' },
  statLabel: { color: C.sub, fontSize: 12, marginTop: 2 },

  infoRow: {
    flexDirection: 'row', alignItems: 'center', gap: 10, backgroundColor: C.card,
    borderRadius: 10, padding: 12, marginBottom: 8, borderWidth: 1, borderColor: C.border,
  },
  infoLabel: { color: C.sub, fontSize: 13, width: 74 },
  infoValue: { flex: 1, color: C.text, fontSize: 13.5, fontWeight: '600' },

  toggleRow: {
    flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center',
    backgroundColor: C.card, borderRadius: 10, padding: 12, marginBottom: 8, borderWidth: 1, borderColor: C.border,
  },
  toggleLabel: { color: C.text, fontSize: 14, flex: 1 },

  statusBtn: { flex: 1, alignItems: 'center', paddingVertical: 10, borderRadius: 10, borderWidth: 1, borderColor: C.border, backgroundColor: C.card },
  statusBtnActive: { backgroundColor: C.green, borderColor: C.green },
  statusBtnText: { fontSize: 12.5, fontWeight: '700', color: C.text },

  filterBar: { backgroundColor: C.card, borderBottomWidth: 1, borderBottomColor: C.border, maxHeight: 50 },
  filterChip: { paddingHorizontal: 14, paddingVertical: 8, marginVertical: 7, marginRight: 8, borderRadius: 18, backgroundColor: C.bg },
  filterChipActive: { backgroundColor: C.green },
  filterChipText: { color: C.sub, fontWeight: '700', fontSize: 13 },
  filterChipTextActive: { color: '#fff' },

  stepper: { flexDirection: 'row', marginVertical: 10 },
  stepDot: { width: 24, height: 24, borderRadius: 12, borderWidth: 2, borderColor: C.border, backgroundColor: C.card, justifyContent: 'center', alignItems: 'center' },
  stepDotDone: { backgroundColor: C.green, borderColor: C.green },
  stepLabel: { fontSize: 9.5, color: C.sub, marginTop: 4, textAlign: 'center' },

  pill: { flexDirection: 'row', alignItems: 'center', gap: 6, alignSelf: 'flex-start', borderRadius: 8, paddingHorizontal: 8, paddingVertical: 4, marginTop: 6 },
  pillDot: { width: 7, height: 7, borderRadius: 4 },
  pillText: { fontSize: 12, fontWeight: '700' },
  availTag: { fontSize: 12.5, fontWeight: '600', marginTop: 4 },

  empty: { alignItems: 'center', paddingVertical: 40, gap: 10 },
  emptyText: { color: C.sub, fontSize: 13.5 },

  tabBar: {
    flexDirection: 'row', backgroundColor: C.card, borderTopWidth: 1, borderTopColor: C.border,
    paddingBottom: 20, paddingTop: 8,
  },
  tab: { flex: 1, alignItems: 'center', gap: 2 },
  tabLabel: { fontSize: 11, color: C.sub },

  // ── Phase 2 ────────────────────────────────────────
  favCard: {
    width: 120, backgroundColor: C.card, borderRadius: 12, padding: 12, marginRight: 10,
    borderWidth: 1, borderColor: C.border, alignItems: 'center', gap: 4,
  },
  favName: { color: C.text, fontSize: 12.5, fontWeight: '700', textAlign: 'center' },
  favRating: { color: C.amber, fontSize: 11 },

  deliveryBadge: { backgroundColor: '#E0F2FE', borderRadius: 6, paddingHorizontal: 8, paddingVertical: 2 },
  deliveryBadgeText: { color: C.blue, fontSize: 11, fontWeight: '700' },

  offerCard: {
    flexDirection: 'row', alignItems: 'center', gap: 12, backgroundColor: C.greenSoft,
    borderRadius: 12, padding: 12, marginBottom: 8, borderWidth: 1, borderColor: '#BBF7D0',
  },
  offerText: { color: C.green, fontSize: 13.5, fontWeight: '700' },
  couponCode: {
    backgroundColor: C.green, borderRadius: 8, paddingHorizontal: 10, paddingVertical: 6,
    borderStyle: 'dashed', borderWidth: 1, borderColor: '#166534',
  },
  couponCodeText: { color: '#fff', fontSize: 12.5, fontWeight: '800', letterSpacing: 1 },

  stars: { color: C.amber, fontSize: 15, letterSpacing: 2 },
  reviewName: { color: C.sub, fontSize: 12, marginTop: 4, fontStyle: 'italic' },

  loyaltyCard: {
    flexDirection: 'row', alignItems: 'center', backgroundColor: C.navy, borderRadius: 16,
    padding: 18, marginTop: 10,
  },
  loyaltyPoints: { color: '#fff', fontSize: 28, fontWeight: '800' },
  loyaltyTier: { color: '#93C5FD', fontSize: 13, fontWeight: '700', marginTop: 2 },
  loyaltySub: { color: '#CBD5E1', fontSize: 12, marginTop: 2 },

  linkCard: {
    flex: 1, backgroundColor: C.card, borderRadius: 14, padding: 16, alignItems: 'center',
    gap: 6, borderWidth: 1, borderColor: C.border,
  },
  linkCardText: { color: C.text, fontSize: 13, fontWeight: '700', textAlign: 'center' },
});
